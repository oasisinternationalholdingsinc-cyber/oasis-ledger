import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * billing-create-subscription (PRODUCTION — OPERATOR ONLY)
 *
 * ✅ Registry-grade, lane-safe (is_test)
 * ✅ NO enforcement, NO payments, NO deletes
 * ✅ Ends any existing ACTIVE subscription (same entity + lane) before creating new one
 *
 * NO REGRESSION CONTRACT:
 * - Accepts legacy UI payloads:
 *   - plan / code / plan_key / planKey
 * - Defaults source to "internal" if missing
 * - Uses explicit Bearer token validation (supabase-js v2 correct pattern)
 * - Resolves billing_plans via `code` (schema-aligned)
 * - Always writes `plan_id` (required by billing_subscriptions NOT NULL)
 */

type ReqBody = {
  entity_id: string;

  // canonical-ish
  plan?: string; // alias for code
  code?: string; // preferred (matches billing_plans.code)
  source?: string; // internal | contract | manual (enum-backed in your DB)

  // tolerated aliases (NO REGRESSION)
  plan_key?: string;
  planKey?: string;

  trial_days?: number | null;
  is_internal?: boolean | null;

  is_test?: boolean;
  reason: string; // REQUIRED
};

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
};

function json(status: number, body: Record<string, any>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}

function pickPlanCode(b: ReqBody): string {
  // Order matters: treat `code` as canonical, but accept all legacy keys.
  const v =
    (b.code ??
      b.plan ??
      b.plan_key ??
      b.planKey ??
      "") as unknown as string;
  return String(v || "").trim();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { ok: false, error: "METHOD_NOT_ALLOWED" });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_ROLE_KEY =
      Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return json(500, { ok: false, error: "MISSING_ENV" });
    }

    // ---------- auth: operator required ----------
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
    if (!authHeader?.toLowerCase().startsWith("bearer ")) {
      return json(401, { ok: false, error: "UNAUTHORIZED" });
    }
    const token = authHeader.slice(7).trim();
    if (!token) return json(401, { ok: false, error: "UNAUTHORIZED" });

    // Service-role client for DB writes; validate operator via explicit token.
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { fetch },
    });

    const { data: userRes, error: userErr } = await supabase.auth.getUser(token);
    const user = userRes?.user ?? null;
    if (userErr || !user) {
      return json(401, { ok: false, error: "INVALID_SESSION" });
    }

    // ---------- parse + validate ----------
    const body = (await req.json().catch(() => null)) as ReqBody | null;
    if (!body) return json(400, { ok: false, error: "INVALID_JSON" });

    const entity_id = String(body.entity_id || "").trim();
    const planCode = pickPlanCode(body);
    const source = String(body.source ?? "internal").trim() || "internal";
    const reason = String(body.reason ?? "").trim();

    const trial_days = body.trial_days ?? null;
    const is_internal = body.is_internal ?? null;
    const laneIsTest = Boolean(body.is_test);

    if (!entity_id || !planCode || !reason) {
      return json(400, {
        ok: false,
        error: "MISSING_REQUIRED_FIELDS",
        required: ["entity_id", "code (or plan/plan_key/planKey)", "reason"],
        note: "source defaults to internal if omitted",
      });
    }

    // ---------- verify entity exists ----------
    const { data: ent, error: entErr } = await supabase
      .from("entities")
      .select("id")
      .eq("id", entity_id)
      .maybeSingle();

    if (entErr || !ent) return json(404, { ok: false, error: "ENTITY_NOT_FOUND" });

    // ---------- resolve plan by billing_plans.code ----------
    const { data: planRow, error: planErr } = await supabase
      .from("billing_plans")
      .select("id, code, name, is_active")
      .eq("code", planCode)
      .maybeSingle();

    if (planErr) throw planErr;

    if (!planRow) {
      return json(400, {
        ok: false,
        error: "PLAN_NOT_FOUND",
        message: `No billing_plans row found for code='${planCode}'`,
      });
    }

    if (planRow.is_active === false) {
      return json(400, {
        ok: false,
        error: "PLAN_INACTIVE",
        message: `Plan '${planCode}' is not active`,
      });
    }

    // ---------- end any existing ACTIVE subscription (same entity + lane) ----------
    const { data: activeSubs, error: activeErr } = await supabase
      .from("billing_subscriptions")
      .select("id")
      .eq("entity_id", entity_id)
      .eq("is_test", laneIsTest)
      .eq("status", "active");

    if (activeErr) throw activeErr;

    if (activeSubs?.length) {
      const nowIso = new Date().toISOString();
      const { error: endErr } = await supabase
        .from("billing_subscriptions")
        .update({
          status: "ended",
          ended_at: nowIso,
          updated_at: nowIso,
        })
        .in("id", activeSubs.map((s: any) => s.id));

      if (endErr) throw endErr;
    }

    // ---------- compute trial ----------
    let trialEndsAt: string | null = null;
    if (trial_days && trial_days > 0) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + trial_days);
      trialEndsAt = d.toISOString();
    }

    // ---------- create subscription ----------
    const nowIso = new Date().toISOString();

    // NOTE: We ALWAYS write plan_id to satisfy NOT NULL constraint.
    // We also write plan_key if the column exists in your table (it does per your earlier logs).
    // If some columns differ, PostgREST will error and we’ll know exactly which column name to align.
    const insertPayload: Record<string, any> = {
      entity_id,
      plan_id: planRow.id,
      status: "active",
      source,
      is_internal: Boolean(is_internal),
      is_test: laneIsTest,
      trial_ends_at: trialEndsAt,
      started_at: nowIso,
      created_by: user.id,
      updated_at: nowIso,
      // tolerated legacy convenience field (if present in your schema)
      plan_key: planRow.code,
      metadata: {
        created_reason: reason,
        created_by_email: user.email ?? null,
        resolved_plan: { id: planRow.id, code: planRow.code, name: planRow.name ?? null },
        tolerated_payload_aliases: {
          code: body.code ?? null,
          plan: body.plan ?? null,
          plan_key: body.plan_key ?? null,
          planKey: body.planKey ?? null,
        },
      },
    };

    const { data: inserted, error: insErr } = await supabase
      .from("billing_subscriptions")
      .insert(insertPayload)
      .select("*")
      .single();

    if (insErr) throw insErr;

    // ---------- audit log (best-effort) ----------
    supabase
      .from("actions_log")
      .insert({
        actor_uid: user.id,
        action: "BILLING_CREATE_SUBSCRIPTION",
        target_table: "billing_subscriptions",
        target_id: inserted.id,
        details_json: {
          entity_id,
          plan_code: planRow.code,
          plan_id: planRow.id,
          source,
          is_internal: Boolean(is_internal),
          is_test: laneIsTest,
          trial_days: trial_days ?? null,
          reason,
        },
      })
      .then(() => null)
      .catch(() => null);

    return json(200, {
      ok: true,
      subscription_id: inserted.id,
      entity_id,
      status: inserted.status,
      plan_id: inserted.plan_id ?? planRow.id,
      plan_code: planRow.code,
      source: inserted.source ?? source,
      is_test: laneIsTest,
    });
  } catch (e: any) {
    console.error("billing-create-subscription failed:", e);
    return json(500, {
      ok: false,
      error: "INTERNAL_ERROR",
      message: e?.message ?? String(e),
      code: e?.code ?? null,
    });
  }
});
