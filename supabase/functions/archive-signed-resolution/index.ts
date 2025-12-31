// supabase/functions/archive-signed-resolution/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { archiveGovernanceRecord, getServiceClient } from "../_shared/archive.ts";

type ReqBody = {
  envelope_id: string;     // signature_envelopes.id
  is_test?: boolean;
  actor_user_id?: string;  // optional fallback for uploaded_by/owner_id
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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST required" }, 405);

  try {
    const body = (await req.json()) as ReqBody;

    if (!body?.envelope_id) {
      return json({ ok: false, error: "envelope_id is required" }, 400);
    }

    const supabase = getServiceClient();

    // Load envelope; MUST have record_id (ledger id) and be completed.
    const { data: env, error: envErr } = await supabase
      .from("signature_envelopes")
      .select("id, record_id, status")
      .eq("id", body.envelope_id)
      .maybeSingle();

    if (envErr) {
      return json({ ok: false, step: "load_envelope", error: envErr }, 500);
    }
    if (!env?.record_id) {
      return json(
        { ok: false, step: "load_envelope", error: "signature_envelopes.record_id missing" },
        400,
      );
    }
    if (String(env.status).toLowerCase() !== "completed") {
      return json(
        { ok: false, step: "validate_envelope", error: "envelope not completed", status: env.status },
        400,
      );
    }

    const out = await archiveGovernanceRecord(supabase, {
      ledgerId: env.record_id as string,
      envelopeId: body.envelope_id,
      isTest: body.is_test,
      actorUserId: body.actor_user_id ?? null,
    });

    if (!out.ok) {
      return json(
        {
          ok: false,
          step: "archive-signed-resolution",
          ledger_id: env.record_id,
          envelope_id: body.envelope_id,
          error: "archive_failed",
          details: out.details ?? out,
        },
        500,
      );
    }

    return json(out, 200);
  } catch (e) {
    return json({ ok: false, step: "archive-signed-resolution", error: String(e) }, 500);
  }
});
