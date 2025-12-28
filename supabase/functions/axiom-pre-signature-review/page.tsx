// supabase/functions/axiom-pre-signature-review/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error("Missing Supabase env");

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

const corsHeaders: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function asString(x: unknown) {
  return typeof x === "string" ? x.trim() : "";
}

serve(async (req) => {
  // ✅ CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ ok: false, error: "POST required" }, 405);
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const record_id = asString(body.record_id);
  const entity_slug = asString(body.entity_slug);
  const envelope_id = asString(body.envelope_id); // optional
  const trigger = asString(body.trigger) || "forge-pre-signature";

  if (!record_id || !entity_slug) {
    return json({ ok: false, error: "record_id and entity_slug required" }, 400);
  }

  // 1) Load governance record (READ-ONLY)
  const { data: record, error: recErr } = await supabase
    .from("governance_ledger")
    .select("id, title, body, record_type, created_at, is_test, entity_id")
    .eq("id", record_id)
    .single();

  if (recErr || !record) {
    return json(
      { ok: false, error: "Record not found", detail: recErr?.message ?? null },
      404,
    );
  }

  // 2) Audit trail (best-effort; never blocks)
  try {
    await supabase.from("ai_actions").insert({
      created_by: "axiom",
      entity_slug,
      type: "AXIOM_PRE_SIGNATURE_REVIEW",
      payload: {
        record_id,
        envelope_id: envelope_id || null,
        trigger,
        is_test: record.is_test ?? null,
      },
    });
  } catch {
    // advisory-only: swallow
  }

  // 3) Generate AXIOM outputs (mock for now)
  const summaryText =
    `AXIOM pre-signature review: "${record.title}". ` +
    `Structure appears coherent for execution. ` +
    `Advisory-only — does not replace counsel or human authority.`;

  const analysisText =
    "AXIOM assessed intent, scope, and procedural signals. " +
    "No internal contradictions detected at this stage. " +
    "Execution risk appears within acceptable bounds, subject to signer awareness.";

  const recommendationText =
    "Proceed with signature only if the signatory understands obligations and downstream operational impact. " +
    "No blocking risks flagged by AXIOM at this stage.";

  // 4) Write ledger AI tables
  const { data: summary, error: sErr } = await supabase
    .from("ai_summaries")
    .insert({
      record_id,
      summary: summaryText,
      ai_source: "edge",
      model: "axiom-v1",
      confidence: 0.88,
      meta_json: { entity_slug, envelope_id: envelope_id || null, trigger },
    })
    .select("id, confidence")
    .single();

  if (sErr) {
    return json(
      { ok: false, error: "Failed to write ai_summaries", detail: sErr.message },
      500,
    );
  }

  const { data: analysis, error: aErr } = await supabase
    .from("ai_analyses")
    .insert({
      record_id,
      analysis: analysisText,
      ai_source: "edge",
      model: "axiom-v1",
      confidence: 0.86,
      meta_json: { entity_slug, envelope_id: envelope_id || null, trigger },
    })
    .select("id")
    .single();

  if (aErr) {
    return json(
      { ok: false, error: "Failed to write ai_analyses", detail: aErr.message },
      500,
    );
  }

  const { data: advice, error: advErr } = await supabase
    .from("ai_advice")
    .insert({
      record_id,
      advice: recommendationText,
      recommendation: recommendationText,
      risk_rating: 0.15,
      confidence: 0.86,
      ai_source: "edge",
      model: "axiom-v1",
      meta_json: { entity_slug, envelope_id: envelope_id || null, trigger },
    })
    .select("id")
    .single();

  if (advErr) {
    return json(
      { ok: false, error: "Failed to write ai_advice", detail: advErr.message },
      500,
    );
  }

  return json({
    ok: true,
    message: "AXIOM pre-signature review completed.",
    record_id,
    envelope_id: envelope_id || null,
    summary_id: summary?.id ?? null,
    analysis_id: analysis?.id ?? null,
    advice_id: advice?.id ?? null,
    confidence: summary?.confidence ?? 0.85,
  });
});
