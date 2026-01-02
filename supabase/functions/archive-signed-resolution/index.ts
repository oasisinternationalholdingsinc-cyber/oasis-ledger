import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  envelope_id: string; // signature_envelopes.id
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
};

const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const SEAL_RPC = "seal_governance_record_for_archive";

function isUuid(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

serve(async (req) => {
  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { fetch },
      auth: { persistSession: false },
    });

    const body = (await req.json().catch(() => null)) as ReqBody | null;
    if (!body?.envelope_id || !isUuid(body.envelope_id)) {
      return json({ ok: false, error: "Missing/invalid envelope_id" }, 400);
    }

    // Minimal envelope read: we only need (status, record_id).
    // IMPORTANT: in your schema, signature_envelopes.record_id = governance_ledger.id
    const { data: env, error: envErr } = await supabase
      .from("signature_envelopes")
      .select("id,status,record_id,completed_at,is_test")
      .eq("id", body.envelope_id)
      .maybeSingle();

    if (envErr) {
      return json(
        { ok: false, error: "Failed to read signature_envelopes", details: { message: envErr.message, code: envErr.code } },
        500,
      );
    }

    if (!env) return json({ ok: false, error: "Envelope not found" }, 404);

    if (!env.record_id || !isUuid(env.record_id)) {
      return json({ ok: false, error: "Envelope missing record_id (ledger id)" }, 500);
    }

    if (String(env.status).toLowerCase() !== "completed") {
      return json(
        {
          ok: false,
          error: "Envelope is not completed",
          envelope: { id: env.id, status: env.status, completed_at: env.completed_at ?? null },
        },
        400,
      );
    }

    // Single source of truth: SQL function handles lane-safe is_test from governance_ledger.
    const { data, error } = await supabase.rpc(SEAL_RPC, { p_ledger_id: env.record_id });

    if (error) {
      return json(
        {
          ok: false,
          error: "seal_governance_record_for_archive failed",
          details: { message: error.message, code: error.code, hint: error.hint },
          envelope: { id: env.id, record_id: env.record_id, is_test: env.is_test ?? null },
        },
        500,
      );
    }

    const row = Array.isArray(data) ? data[0] : data;

    return json({
      ok: true,
      envelope_id: env.id,
      record_id: env.record_id,
      // helpful debug signal (doesn't affect logic)
      envelope_is_test: env.is_test ?? null,
      result: row ?? data,
    });
  } catch (e) {
    return json(
      { ok: false, error: "archive-signed-resolution crashed", details: { message: e?.message ?? String(e) } },
      500,
    );
  }
});
