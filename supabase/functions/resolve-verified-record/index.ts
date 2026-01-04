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
  "Access-Control-Allow-Methods": "GET,OPTIONS",
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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const url = new URL(req.url);

    // Canonical params
    const hash = url.searchParams.get("hash");
    const verified_document_id =
      url.searchParams.get("verified_document_id") ??
      url.searchParams.get("p_verified_document_id");
    const ledger_id =
      url.searchParams.get("ledger_id") ?? url.searchParams.get("p_ledger_id");

    // IMPORTANT: verify.html is sending envelope_id, and sometimes record_id as legacy alias
    const envelope_id =
      url.searchParams.get("envelope_id") ??
      url.searchParams.get("p_envelope_id") ??
      url.searchParams.get("record_id"); // legacy UI param seen in your DevTools

    if (!hash && !verified_document_id && !ledger_id && !envelope_id) {
      return json(
        {
          ok: false,
          error:
            "Provide one of: ledger_id, verified_document_id, envelope_id, or hash",
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

    // data is already your JSON payload from SQL: {"ok":true,"ledger":...,"verified":...}
    return json(data, data.ok ? 200 : 404);
  } catch (e) {
    console.error("resolve-verified-record error:", e);
    return json({ ok: false, error: "Unexpected server error" }, 500);
  }
});
