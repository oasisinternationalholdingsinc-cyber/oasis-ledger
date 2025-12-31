// supabase/functions/archive-signed-resolution/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { cors, json, readJson, getServiceClient } from "../_shared/archive.ts";

type ReqBody = {
  envelope_id: string; // signature_envelopes.id
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  try {
    const body = await readJson<ReqBody>(req);
    const envelopeId = body.envelope_id?.trim();
    if (!envelopeId) return json({ ok: false, error: "Missing envelope_id" }, 400);

    const sb = getServiceClient();

    // 1) Load envelope + resolve governance record_id
    const { data: env, error: envErr } = await sb
      .from("signature_envelopes")
      .select("id, record_id, status, completed_at")
      .eq("id", envelopeId)
      .maybeSingle();

    if (envErr) throw new Error(`load_envelope: ${envErr.message}`);
    if (!env) return json({ ok: false, error: `Envelope not found: ${envelopeId}` }, 404);

    if (env.status !== "completed") {
      return json(
        {
          ok: false,
          error: "Envelope not completed",
          envelope_id: envelopeId,
          status: env.status,
          completed_at: env.completed_at,
        },
        400,
      );
    }

    const recordId = env.record_id as string;
    if (!recordId) return json({ ok: false, error: "Envelope missing record_id" }, 500);

    // 2) Delegate ALL archive logic to archive-save-document (single source of truth)
    const { data: result, error: invokeErr } = await sb.functions.invoke("archive-save-document", {
      body: { record_id: recordId },
    });

    if (invokeErr) {
      throw new Error(`invoke_archive_save_document: ${invokeErr.message}`);
    }

    return json({
      ok: true,
      step: "archived_via_archive_save_document",
      envelope_id: envelopeId,
      record_id: recordId,
      result,
    });
  } catch (e) {
    return json(
      {
        ok: false,
        step: "archive-signed-resolution",
        error: (e as Error).message ?? String(e),
      },
      500,
    );
  }
});
