// supabase/functions/resolve-verified-record/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization,apikey,content-type,x-client-info",
  "Access-Control-Expose-Headers": "content-type,x-sb-request-id",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

async function safeJson(req: Request) {
  try {
    // only attempt for non-GET
    if (req.method === "GET") return {};
    const ct = req.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) return {};
    return await req.json();
  } catch {
    return {};
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const url = new URL(req.url);
    const q = url.searchParams;

    const body: any = await safeJson(req);

    // Canonical + legacy aliases, query OR body
    const hash =
      body.hash ??
      q.get("hash") ??
      null;

    const verified_document_id =
      body.verified_document_id ??
      body.p_verified_document_id ??
      q.get("verified_document_id") ??
      q.get("p_verified_document_id") ??
      null;

    const ledger_id =
      body.ledger_id ??
      body.p_ledger_id ??
      q.get("ledger_id") ??
      q.get("p_ledger_id") ??
      null;

    const envelope_id =
      body.envelope_id ??
      body.p_envelope_id ??
      body.record_id ?? // legacy UI alias
      q.get("envelope_id") ??
      q.get("p_envelope_id") ??
      q.get("record_id") ?? // legacy UI alias
      null;

    if (!hash && !verified_document_id && !ledger_id && !envelope_id) {
      return json(
        {
          ok: false,
          error:
            "Provide one of: ledger_id, verified_document_id, envelope_id, or hash",
          hint:
            "Send it as query (?envelope_id=...) or JSON body ({ envelope_id: ... }).",
        },
        400,
      );
    }

    const { data, error } = await supabase.rpc("resolve_verified_record", {
      p_hash: hash,
      p_verified_document_id: verified_document_id,
      p_ledger_id: ledger_id,
      p_envelope_id: envelope_id,
    });

    if (error) return json({ ok: false, error: error.message, details: error }, 500);
    if (!data) return json({ ok: false, error: "Record not found" }, 404);

    return json(data, data.ok ? 200 : 404);
  } catch (e) {
    console.error("resolve-verified-record error:", e);
    return json({ ok: false, error: "Unexpected server error" }, 500);
  }
});
