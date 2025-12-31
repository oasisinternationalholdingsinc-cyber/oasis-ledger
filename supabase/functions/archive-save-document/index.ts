import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { sbAdmin, loadArchiveContext } from "../_shared/archive.ts";

type ReqBody = { record_id: string; is_test?: boolean };

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
    if (!body?.record_id) return json({ ok: false, error: "record_id required" }, 400);

    const supabase = sbAdmin();

    // ✅ No governance_ledger.entity_key anywhere
    const ctx = await loadArchiveContext(supabase, body.record_id, body.is_test);

    // ✅ Call the canonical SQL sealer (service_role context)
    const { data: sealed, error: sealErr } = await supabase.rpc(
      "seal_governance_record_for_archive",
      { p_ledger_id: ctx.ledger_id },
    );

    if (sealErr) {
      return json({
        ok: false,
        step: "seal_governance_record_for_archive",
        error: sealErr.message,
        details: sealErr,
      }, 500);
    }

    // NOTE: Your SQL sealer already upserts verified_documents + locks ledger.
    // archive-save-document remains your "repair + minute book pointer" function.
    // If you already have the idempotent minute book repair logic, keep it below.
    // (I’m keeping this minimal so we don’t regress your working schema.)

    return json({ ok: true, step: "archive-save-document", ctx, sealed });
  } catch (e) {
    return json(
      { ok: false, step: "archive-save-document", error: String(e?.message ?? e) },
      500,
    );
  }
});
