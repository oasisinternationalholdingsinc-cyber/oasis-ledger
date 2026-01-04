// supabase/functions/resolve-verified-record/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
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
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function pickString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length ? s : null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const url = new URL(req.url);

    // Accept BOTH:
    // - GET with query params
    // - POST with JSON body
    let body: any = null;
    if (req.method === "POST") {
      const ct = req.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        try {
          body = await req.json();
        } catch {
          body = null;
        }
      }
    }

    // Read from body first (POST), fallback to query (GET)
    const p_hash = pickString(body?.hash) ?? url.searchParams.get("hash");
    const p_verified_document_id =
      pickString(body?.verified_document_id) ??
      url.searchParams.get("verified_document_id");
    const p_ledger_id =
      pickString(body?.ledger_id) ??
      pickString(body?.record_id) ??
      url.searchParams.get("ledger_id") ??
      url.searchParams.get("record_id");
    const p_envelope_id =
      pickString(body?.envelope_id) ?? url.searchParams.get("envelope_id");

    // IMPORTANT: allow envelope_id too (your SQL supports it)
    if (!p_hash && !p_verified_document_id && !p_ledger_id && !p_envelope_id) {
      return json(
        {
          ok: false,
          error:
            "Provide one of: ledger_id, verified_document_id, envelope_id, or hash",
        },
        400,
      );
    }

    // Call canonical SQL (matches your function signature)
    const { data, error } = await supabase.rpc("resolve_verified_record", {
      p_hash: p_hash ?? null,
      p_verified_document_id: p_verified_document_id ?? null,
      p_ledger_id: p_ledger_id ?? null,
      p_envelope_id: p_envelope_id ?? null,
    });

    if (error) {
      return json({ ok: false, error: error.message, details: error }, 500);
    }
    if (!data) {
      return json({ ok: false, error: "Record not found" }, 404);
    }

    // Return the SQL payload shape directly (ok/ledger/verified/…)
    // plus a stable top-level "valid" for the public pages
    return json({ valid: data?.ok === true, ...data }, 200);
  } catch (e) {
    console.error("resolve-verified-record error:", e);
    return json({ ok: false, error: "Unexpected server error" }, 500);
  }
});
