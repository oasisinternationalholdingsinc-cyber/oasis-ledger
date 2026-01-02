import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  envelope_id: string; // signature_envelopes.id
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
  "Access-Control-Max-Age": "86400",
};

const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const SEAL_RPC = "seal_governance_record_for_archive";

function requireUUID(v: unknown, field: string) {
  if (typeof v !== "string" || !/^[0-9a-fA-F-]{36}$/.test(v)) {
    throw new Error(`Invalid ${field}`);
  }
  return v;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  try {
    const body = (await req.json()) as ReqBody;
    const envelope_id = requireUUID(body.envelope_id, "envelope_id");

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { fetch },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // 1) Load envelope → get the ledger record id
    const { data: envRow, error: envErr } = await supabase
      .from("signature_envelopes")
      .select("id, record_id, status")
      .eq("id", envelope_id)
      .maybeSingle();

    if (envErr) return json({ ok: false, error: envErr.message, details: envErr }, 500);
    if (!envRow) return json({ ok: false, error: "Envelope not found" }, 404);
    if (!envRow.record_id) return json({ ok: false, error: "Envelope missing record_id" }, 400);

    const status = String(envRow.status ?? "").toLowerCase();
    if (status !== "completed") {
      return json(
        { ok: false, error: `Envelope not completed (status=${envRow.status ?? "null"})` },
        409,
      );
    }

    // 2) Seal via canonical RPC (does ALL idempotent writes)
    const { data, error } = await supabase.rpc(SEAL_RPC, { p_ledger_id: envRow.record_id });

    if (error) {
      return json({ ok: false, error: error.message, details: error }, 500);
    }

    const row = Array.isArray(data) ? data[0] : data;
    return json({ ok: true, envelope_id, record_id: envRow.record_id, result: row });
  } catch (e) {
    return json({ ok: false, error: e?.message ?? String(e) }, 400);
  }
});
