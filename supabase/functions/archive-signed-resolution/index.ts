import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { sbAdmin } from "../_shared/archive.ts";

type ReqBody = { envelope_id: string; is_test?: boolean };

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
    if (!body?.envelope_id) return json({ ok: false, error: "envelope_id required" }, 400);

    const supabase = sbAdmin();

    // Pull envelope + ledger_id (adjust select names if your columns differ)
    const { data: env, error: envErr } = await supabase
      .from("signature_envelopes")
      .select("id, status, record_id")
      .eq("id", body.envelope_id)
      .single();

    if (envErr) {
      return json({ ok: false, step: "load_envelope", error: envErr.message, details: envErr }, 500);
    }

    if (!env?.record_id) {
      return json({ ok: false, step: "load_envelope", error: "envelope.record_id is null" }, 500);
    }

    if (String(env.status).toLowerCase() !== "completed") {
      return json({ ok: false, step: "envelope_status", error: `Envelope not completed: ${env.status}` }, 400);
    }

    // ✅ Delegate to archive-save-document (single source of truth)
    const { data: saved, error: saveErr } = await supabase.functions.invoke(
      "archive-save-document",
      { body: { record_id: env.record_id, is_test: body.is_test } },
    );

    if (saveErr) {
      return json({
        ok: false,
        step: "archive-signed-resolution",
        error: `invoke_archive_save_document: ${saveErr.message ?? "Edge Function returned a non-2xx status code"}`,
        details: saveErr,
      }, 500);
    }

    return json({ ok: true, step: "archive-signed-resolution", envelope_id: env.id, record_id: env.record_id, result: saved });
  } catch (e) {
    return json({ ok: false, step: "archive-signed-resolution", error: String(e?.message ?? e) }, 500);
  }
});
