import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json, getServiceClient, invokeEdgeFunction } from "../_shared/archive.ts";

type ReqBody = {
  envelope_id: string; // signature_envelopes.id
  is_test?: boolean;   // optional override; otherwise uses envelope.is_test
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  try {
    const { envelope_id, is_test }: ReqBody = await req.json();
    if (!envelope_id) return json({ ok: false, error: "Missing envelope_id" }, 400);

    const supabase = getServiceClient();

    // ✅ schema-correct: signature_envelopes.record_id is the ledger id
    const { data: env, error: envErr } = await supabase
      .from("signature_envelopes")
      .select("id, record_id, status, completed_at, is_test")
      .eq("id", envelope_id)
      .maybeSingle();

    if (envErr) {
      return json({ ok: false, step: "load_signature_envelopes", error: envErr.message, details: envErr }, 500);
    }
    if (!env) return json({ ok: false, step: "load_signature_envelopes", error: "Envelope not found" }, 404);

    if (env.status !== "completed") {
      return json(
        { ok: false, step: "validate_envelope_completed", error: "Envelope not completed", envelope: env },
        400,
      );
    }
    if (!env.record_id) {
      return json(
        { ok: false, step: "validate_envelope_record_id", error: "Envelope missing record_id (ledger id)" },
        500,
      );
    }

    const ledger_id = env.record_id as string;
    const lane = typeof is_test === "boolean" ? is_test : !!env.is_test;

    // ✅ delegate to the canonical sealer surface (service_role -> service_role)
    const downstream = await invokeEdgeFunction("archive-save-document", {
      record_id: ledger_id,
      is_test: lane,
    });

    if (!downstream.ok) {
      return json(
        {
          ok: false,
          step: "archive-signed-resolution",
          ledger_id,
          envelope_id,
          error: "invoke_archive_save_document: non-2xx",
          archive_save_document: { status: downstream.status, body: downstream.json ?? downstream.text },
        },
        500,
      );
    }

    return json(
      {
        ok: true,
        step: "archive-signed-resolution",
        ledger_id,
        envelope_id,
        is_test: lane,
        archive_save_document: downstream.json ?? downstream.text,
      },
      200,
    );
  } catch (e) {
    return json(
      { ok: false, step: "archive-signed-resolution", error: e instanceof Error ? e.message : String(e) },
      500,
    );
  }
});
