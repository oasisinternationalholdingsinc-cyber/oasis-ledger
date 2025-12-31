// supabase/functions/archive-signed-resolution/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

import { cors, json, makeServiceClient } from "../_shared/archive.ts";

type ReqBody = {
  envelope_id: string; // signature_envelopes.id
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const body = (await req.json()) as ReqBody;
    if (!body?.envelope_id) return json({ ok: false, error: "missing envelope_id" }, 400);

    const supabase = makeServiceClient();

    // Load envelope; schema reality: envelope points to ledger via record_id (NOT source_record_id)
    const { data: env, error: envErr } = await supabase
      .from("signature_envelopes")
      .select("id, record_id, status")
      .eq("id", body.envelope_id)
      .single();

    if (envErr || !env) return json({ ok: false, step: "load_signature_envelope", error: envErr?.message ?? "not found" }, 404);

    if (String(env.status).toLowerCase() !== "completed") {
      return json({ ok: false, step: "validate_envelope_status", error: "Envelope not completed", status: env.status }, 400);
    }

    // Delegate to archive-save-document (single canonical path)
    const { data, error } = await supabase.functions.invoke("archive-save-document", {
      body: {
        record_id: env.record_id,
        envelope_id: env.id,
      },
    });

    if (error) {
      return json({
        ok: false,
        step: "archive-signed-resolution",
        ledger_id: env.record_id,
        envelope_id: env.id,
        error: "invoke_archive_save_document: non-2xx",
        archive_save_document: error,
      }, 500);
    }

    return json({
      ok: true,
      step: "archive-signed-resolution",
      ledger_id: env.record_id,
      envelope_id: env.id,
      result: data,
    });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
