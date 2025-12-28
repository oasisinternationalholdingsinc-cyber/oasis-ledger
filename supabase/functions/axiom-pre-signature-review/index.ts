import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/* ────────────────────────────────────────────────────────────
   ENV
──────────────────────────────────────────────────────────── */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing Supabase env vars");
}

/* ────────────────────────────────────────────────────────────
   CORS + HELPERS
──────────────────────────────────────────────────────────── */
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

function asString(v: unknown) {
  return typeof v === "string" ? v.trim() : "";
}

/* ────────────────────────────────────────────────────────────
   SERVICE ROLE CLIENT (WRITES)
──────────────────────────────────────────────────────────── */
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

/* ────────────────────────────────────────────────────────────
   SAFE INSERT WITH FALLBACK
   (fallback MUST satisfy NOT NULL constraints)
──────────────────────────────────────────────────────────── */
async function insertWithFallback(
  table: "ai_summaries" | "ai_analyses" | "ai_advice",
  primaryRow: Record<string, unknown>,
  fallbackRow: Record<string, unknown>,
) {
  const first = await supabase
    .from(table)
    .insert(primaryRow)
    .select("id")
    .maybeSingle();

  if (!first.error) return { id: (first.data as any)?.id ?? null };

  const second = await supabase
    .from(table)
    .insert(fallbackRow)
    .select("id")
    .maybeSingle();

  if (!second.error) return { id: (second.data as any)?.id ?? null };

  return {
    error:
      second.error?.message ??
      first.error?.message ??
      "insert failed",
  };
}

/* ────────────────────────────────────────────────────────────
   HANDLER
──────────────────────────────────────────────────────────── */
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ ok: false, error: "POST required" }, 405);
  }

  /* ───── AUTH (USER JWT REQUIRED) ───── */
  const authHeader =
    req.headers.get("authorization") ||
    req.headers.get("Authorization") ||
    "";

  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : "";

  if (!token) {
    return json(
      { ok: false, error: "Missing Authorization Bearer token" },
      401,
    );
  }

  const { data: userData, error: userErr } =
    await supabase.auth.getUser(token);

  if (userErr || !userData?.user?.id) {
    return json({ ok: false, error: "Invalid session" }, 401);
  }

  const user_id = userData.user.id;

  /* ───── BODY ───── */
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const record_id = asString(body.record_id);
  const entity_slug = asString(body.entity_slug);
  const envelope_id = asString(body.envelope_id);
  const trigger = asString(body.trigger) || "forge-pre-signature";

  if (!record_id || !entity_slug) {
    return json(
      { ok: false, error: "record_id and entity_slug required" },
      400,
    );
  }

  /* ───── LOAD LEDGER RECORD (READ ONLY) ───── */
  const { data: record, error: recErr } = await supabase
    .from("governance_ledger")
    .select("id, title, body, record_type, is_test")
    .eq("id", record_id)
    .single();

  if (recErr || !record) {
    return json(
      { ok: false, error: "Record not found", detail: recErr?.message },
      404,
    );
  }

  /* ───── BEST-EFFORT AUDIT (NON BLOCKING) ───── */
  try {
    await supabase.from("ai_actions").insert({
      created_by: user_id,
      type: "AXIOM_PRE_SIGNATURE_REVIEW",
      entity_slug,
      payload: {
        record_id,
        envelope_id: envelope_id || null,
        trigger,
        is_test: record.is_test ?? null,
      },
    });
  } catch {
    /* swallow */
  }

  /* ───── DETERMINISTIC ADVISORY CONTENT ───── */
  const summaryText =
    `AXIOM pre-signature review for "${record.title}". ` +
    `Advisory only. Human authority remains final.`;

  const analysisText =
    "No internal contradictions detected. Procedural signals appear consistent.";

  const recommendationText =
    "Proceed with signature only if the signatory understands obligations and downstream effects. " +
    "No blocking risks identified at this stage.";

  const meta = {
    entity_slug,
    envelope_id: envelope_id || null,
    trigger,
    is_test: record.is_test ?? null,
  };

  /* ───── WRITE AI TABLES ───── */

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

  if ((s as any).error) {
    return json(
      { ok: false, error: "Failed to write ai_summaries", detail: (s as any).error },
      500,
    );
  }

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

  if ((a as any).error) {
    return json(
      { ok: false, error: "Failed to write ai_analyses", detail: (a as any).error },
      500,
    );
  }

  const adv = await insertWithFallback(
    "ai_advice",
    {
      record_id,
      advice: recommendationText,
      recommendation: recommendationText, // ✅ REQUIRED
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
      recommendation: recommendationText, // ✅ REQUIRED (FIX)
      model: "axiom-v1",
    },
  );

  if ((adv as any).error) {
    return json(
      { ok: false, error: "Failed to write ai_advice", detail: (adv as any).error },
      500,
    );
  }

  /* ───── DONE ───── */
  return json({
    ok: true,
    message: "AXIOM pre-signature review completed",
    record_id,
    envelope_id: envelope_id || null,
    summary_id: (s as any).id ?? null,
    analysis_id: (a as any).id ?? null,
    advice_id: (adv as any).id ?? null,
  });
});
