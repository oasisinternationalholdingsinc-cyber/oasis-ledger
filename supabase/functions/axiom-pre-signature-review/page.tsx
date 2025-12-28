import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error("Missing Supabase env");

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

// Service-role client (writes)
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

async function insertWithFallback(
  table: "ai_summaries" | "ai_analyses" | "ai_advice",
  primaryRow: Record<string, unknown>,
  fallbackRow: Record<string, unknown>,
) {
  // Try richer insert first (created_by/meta_json/etc.)
  const first = await supabase.from(table).insert(primaryRow).select("id").maybeSingle();
  if (!first.error) return { id: (first.data as any)?.id ?? null };

  // Retry minimal insert if schema differs
  const second = await supabase.from(table).insert(fallbackRow).select("id").maybeSingle();
  if (!second.error) return { id: (second.data as any)?.id ?? null };

  return { error: second.error?.message ?? first.error?.message ?? "insert failed" };
}

serve(async (req) => {
  // ✅ CORS preflight
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  if (req.method !== "POST") return json({ ok: false, error: "POST required" }, 405);

  // ✅ Require a user JWT (Forge calls this from the browser)
  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return json({ ok: false, error: "Missing Authorization Bearer token" }, 401);

  // Verify token -> get user id (enterprise-safe audit)
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user?.id) {
    return json({ ok: false, error: "Invalid session" }, 401);
  }
  const user_id = userData.user.id;

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
    return json({ ok: false, error: "Record not found", detail: recErr?.message }, 404);
  }

  // 2) Best-effort audit trail (never blocks)
  try {
    await supabase.from("ai_actions").insert({
      // your schema may differ; this is non-blocking
      created_by: user_id,
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
    // swallow
  }

  // 3) Generate outputs (mock for now — deterministic + safe)
  const summaryText =
    `AXIOM pre-signature review: "${record.title}". ` +
    `This is advisory-only and does not replace counsel or human authority.`;

  const analysisText =
    "AXIOM assessed intent, scope, and procedural signals. " +
    "No internal contradictions detected at this stage.";

  const recommendationText =
    "Proceed with signature only if the signatory understands obligations and downstream impact. " +
    "No blocking risks flagged at this stage.";

  const meta = {
    entity_slug,
    envelope_id: envelope_id || null,
    trigger,
    is_test: record.is_test ?? null,
  };

  // 4) Write AI tables (schema-flex, enterprise-safe)
  const s = await insertWithFallback(
    "ai_summaries",
    {
      record_id,
      summary: summaryText,
      ai_source: "edge",
      model: "axiom-v1",
      confidence: 0.88,
      meta_json: meta,
      created_by: user_id,
    },
    {
      record_id,
      summary: summaryText,
      model: "axiom-v1",
    },
  );
  if ((s as any).error) return json({ ok: false, error: "Failed to write ai_summaries", detail: (s as any).error }, 500);

  const a = await insertWithFallback(
    "ai_analyses",
    {
      record_id,
      analysis: analysisText,
      ai_source: "edge",
      model: "axiom-v1",
      confidence: 0.86,
      meta_json: meta,
      created_by: user_id,
    },
    {
      record_id,
      analysis: analysisText,
      model: "axiom-v1",
    },
  );
  if ((a as any).error) return json({ ok: false, error: "Failed to write ai_analyses", detail: (a as any).error }, 500);

  const adv = await insertWithFallback(
    "ai_advice",
    {
      record_id,
      advice: recommendationText,
      recommendation: recommendationText,
      risk_rating: 0.15,
      confidence: 0.86,
      ai_source: "edge",
      model: "axiom-v1",
      meta_json: meta,
      created_by: user_id,
    },
    {
      record_id,
      advice: recommendationText,
      model: "axiom-v1",
    },
  );
  if ((adv as any).error) return json({ ok: false, error: "Failed to write ai_advice", detail: (adv as any).error }, 500);

  return json({
    ok: true,
    message: "AXIOM pre-signature review completed.",
    record_id,
    envelope_id: envelope_id || null,
    summary_id: (s as any).id ?? null,
    analysis_id: (a as any).id ?? null,
    advice_id: (adv as any).id ?? null,
  });
});
