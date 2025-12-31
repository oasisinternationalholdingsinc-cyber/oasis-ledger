// supabase/functions/archive-save-document/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { archiveGovernanceRecord, getServiceClient } from "../_shared/archive.ts";

type ReqBody = {
  ledger_id: string;           // governance_ledger.id
  envelope_id?: string;        // signature_envelopes.id (optional)
  is_test?: boolean;           // optional lane flag
  actor_user_id?: string;      // optional fallback for uploaded_by/owner_id (from client session)
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

    if (!body?.ledger_id) {
      return json({ ok: false, error: "ledger_id is required" }, 400);
    }

    const supabase = getServiceClient();

    const out = await archiveGovernanceRecord(supabase, {
      ledgerId: body.ledger_id,
      envelopeId: body.envelope_id ?? null,
      isTest: body.is_test,
      actorUserId: body.actor_user_id ?? null,
    });

    if (!out.ok) {
      return json(
        {
          ok: false,
          step: "archive-save-document",
          ledger_id: body.ledger_id,
          envelope_id: body.envelope_id ?? null,
          error: "archive_failed",
          details: out.details ?? out,
        },
        500,
      );
    }

    return json(out, 200);
  } catch (e) {
    return json({ ok: false, step: "archive-save-document", error: String(e) }, 500);
  }
});
