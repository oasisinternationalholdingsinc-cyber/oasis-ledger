import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  record_id: string; // governance_ledger.id
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
    if (!body?.record_id || !isUuid(body.record_id)) {
      return json({ ok: false, error: "Missing/invalid record_id" }, 400);
    }

    // Single source of truth: your SQL function does EVERYTHING idempotently.
    const { data, error } = await supabase.rpc(SEAL_RPC, { p_ledger_id: body.record_id });

    if (error) {
      return json(
        {
          ok: false,
          error: "seal_governance_record_for_archive failed",
          details: { message: error.message, code: error.code, hint: error.hint },
        },
        500,
      );
    }

    // data is typically an array of 1 row (RETURNS TABLE + RETURN NEXT)
    const row = Array.isArray(data) ? data[0] : data;

    return json({
      ok: true,
      record_id: body.record_id,
      result: row ?? data,
    });
  } catch (e) {
    return json(
      {
        ok: false,
        error: "archive-save-document crashed",
        details: { message: e?.message ?? String(e) },
      },
      500,
    );
  }
});
