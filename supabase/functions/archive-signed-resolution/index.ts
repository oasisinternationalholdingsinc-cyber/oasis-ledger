// supabase/functions/archive-signed-resolution/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json, serviceClient, getEnv } from "../_shared/archive.ts";

type ReqBody = {
  envelope_id: string; // signature_envelopes.id
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const sb = serviceClient();
    const body = (await req.json().catch(() => ({}))) as Partial<ReqBody>;
    if (!body.envelope_id) return json({ ok: false, error: "Missing envelope_id" }, 400);

    const { data: env, error: envErr } = await sb
      .from("signature_envelopes")
      .select("id, record_id, status")
      .eq("id", body.envelope_id)
      .single();

    if (envErr || !env?.record_id) {
      return json({ ok: false, error: "Envelope not found", details: envErr }, 404);
    }
    if (String(env.status).toLowerCase() !== "completed") {
      return json({ ok: false, error: "Envelope not completed", status: env.status }, 400);
    }

    // Call archive-save-document function (same project)
    const url = `${getEnv("SUPABASE_URL")}/functions/v1/archive-save-document`;

    // IMPORTANT: forward the Authorization header (user JWT) so archive-save-document can resolve actor id
    const auth = req.headers.get("authorization") ?? "";

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(auth ? { authorization: auth } : {}),
        // apikey not required for internal, but harmless if present in your client calls
        ...(req.headers.get("apikey") ? { apikey: req.headers.get("apikey")! } : {}),
      },
      body: JSON.stringify({ record_id: env.record_id, envelope_id: env.id }),
    });

    const payload = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      return json({
        ok: false,
        step: "archive-signed-resolution",
        envelope_id: env.id,
        ledger_id: env.record_id,
        error: "invoke_archive_save_document: non-2xx",
        archive_save_document: { status: resp.status, body: payload },
      }, 500);
    }

    return json({
      ok: true,
      step: "archive-signed-resolution",
      envelope_id: env.id,
      ledger_id: env.record_id,
      archive: payload,
    });
  } catch (e) {
    return json({ ok: false, error: String(e?.message ?? e), stack: String(e?.stack ?? "") }, 500);
  }
});
