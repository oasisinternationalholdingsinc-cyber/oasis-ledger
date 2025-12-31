import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { sealAndRepairArchive } from "../_shared/archive.ts";

type ReqBody = { envelope_id: string; is_test?: boolean };

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
};

const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x, null, 2), { status, headers: { ...cors, "Content-Type": "application/json" } });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE_KEY =
      Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { global: { fetch } });

    const body = (await req.json()) as ReqBody;
    if (!body?.envelope_id) return json({ ok: false, error: "Missing envelope_id" }, 400);

    // 1) Validate envelope completed + resolve record_id
    const { data: env, error: envErr } = await supabase
      .from("signature_envelopes")
      .select("id,status,record_id")
      .eq("id", body.envelope_id)
      .single();

    if (envErr) return json({ ok: false, error: "Envelope not found", details: envErr.message }, 404);

    if (env.status !== "completed") {
      return json({ ok: false, error: "Envelope not completed", status: env.status }, 409);
    }

    const record_id = env.record_id;
    if (!record_id) return json({ ok: false, error: "Envelope missing record_id" }, 500);

    // 2) NO HTTP CALL. Use same canonical archive path.
    const out = await sealAndRepairArchive({
      supabase,
      record_id,
      is_test: body.is_test,
    });

    if (!out.ok) return json(out, 500);
    return json({ ok: true, envelope_id: body.envelope_id, ...out }, 200);
  } catch (e) {
    return json({ ok: false, error: "Unhandled error", details: String(e) }, 500);
  }
});
