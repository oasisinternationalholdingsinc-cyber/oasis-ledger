import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { makeServiceClient } from "../_shared/archive.ts";

type ReqBody = { envelope_id: string };

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

  try {
    const body = (await req.json()) as ReqBody;
    const envelope_id = body?.envelope_id;
    if (!envelope_id) return json({ ok: false, error: "Missing envelope_id" }, 400);

    const supabase = makeServiceClient();

    // 1) Load envelope
    const { data: env, error: envErr } = await supabase
      .from("signature_envelopes")
      .select("id, status, source_record_id, record_id, completed_at")
      .eq("id", envelope_id)
      .single();

    if (envErr) throw new Error(`Load signature_envelopes failed: ${envErr.message}`);

    const status = String(env.status ?? "");
    if (status !== "completed") {
      return json(
        { ok: false, error: "Envelope not completed", envelope_id, status },
        400,
      );
    }

    const record_id = (env.source_record_id ?? env.record_id) as string | null;
    if (!record_id) {
      throw new Error("Envelope missing source_record_id/record_id");
    }

    // 2) Call archive-save-document (same deployment, service_role)
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey =
      Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const resp = await fetch(`${url}/functions/v1/archive-save-document`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
      },
      body: JSON.stringify({ record_id }),
    });

    const out = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(
        `archive-save-document failed (${resp.status}): ${JSON.stringify(out)}`,
      );
    }

    return json({
      ok: true,
      envelope_id,
      record_id,
      archived: out,
    });
  } catch (e) {
    return json(
      { ok: false, error: "archive-signed-resolution failed", details: { message: String(e) } },
      500,
    );
  }
});
