import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  envelope_id: string; // signature_envelopes.id
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { global: { fetch } });

  try {
    const body = (await req.json().catch(() => ({}))) as Partial<ReqBody>;
    const envelope_id = (body.envelope_id ?? "").trim();
    if (!envelope_id) return json({ ok: false, error: "Missing envelope_id" }, 400);

    // 1) Load envelope and validate it is completed
    const { data: env, error: envErr } = await supabase
      .from("signature_envelopes")
      .select("id, record_id, status, is_test")
      .eq("id", envelope_id)
      .single();

    if (envErr || !env) return json({ ok: false, error: "Envelope not found", details: envErr }, 404);

    if (env.status !== "completed") {
      return json(
        { ok: false, error: "Envelope not completed", envelope_id, status: env.status },
        400,
      );
    }

    const record_id = String(env.record_id);

    // 2) Delegate to archive-save-document (idempotent)
    // Instead of HTTP-calling another function, we just repeat the core action:
    // call seal rpc + repair pointers by calling the save-function endpoint is optional.
    // Simpler: call the RPC-based save function as a separate edge call from the client.
    //
    // Here we DO the minimal enterprise delegation by invoking archive-save-document via HTTP:
    const url = `${SUPABASE_URL}/functions/v1/archive-save-document`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // service role is allowed to call internal function endpoints
        authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        apikey: SERVICE_ROLE_KEY,
      },
      body: JSON.stringify({ record_id }),
    });

    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      return json({ ok: false, error: "archive-save-document failed", details: payload }, 500);
    }

    return json({
      ok: true,
      envelope_id,
      record_id,
      delegated: true,
      result: payload,
    });
  } catch (e) {
    return json({ ok: false, error: "archive-signed-resolution failed", details: { message: String(e) } }, 500);
  }
});
