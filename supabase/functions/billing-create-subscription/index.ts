import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * billing-create-subscription
 *
 * OPERATOR-ONLY
 * REGISTRY-GRADE
 * NO ENFORCEMENT
 * NO PAYMENTS
 * NO DELETES
 *
 * HARD GUARANTEES (NO REGRESSION):
 * - Accepts legacy UI payloads (plan | plan_key | planKey)
 * - Resolves REQUIRED plan_id from billing_plans (never NULL)
 * - Defaults source="internal" if missing
 * - Explicit JWT validation (supabase-js v2 correct pattern)
 * - Lane-safe via is_test
 * - Idempotent end-of-active-subscription per entity+lane
 */

type ReqBody = {
  entity_id: string;

  // canonical / tolerated
  plan?: string;
  plan_key?: string;
  planKey?: string;

  source?: string; // internal | contract | manual
  trial_days?: number | null;
  is_internal?: boolean | null;
  is_test?: boolean;

  reason: string;
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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST")
    return json(405, { ok: false, error: "METHOD_NOT_ALLOWED" });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_ROLE_KEY =
      Deno.env.get("SERVICE_ROLE_KEY") ??
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return json(500, { ok: false, error: "MISSING_ENV" });
    }

    // ---------- AUTH (CANONICAL, NO REGRESSION) ----------
    const authHeader =
      req.headers.get("authorization") ||
      req.headers.get("Authorization");

    if (!authHeader?.toLowerCase().startsWith("bearer ")) {
      return json(401, { ok: false, error: "UNAUTHORIZED" });
    }

    const token = authHeader.slice(7).trim();
    if (!token) return json(401, { ok: false, error: "UNAUTHORIZED" });

    const supabase = createClient(
      SUPABASE_URL,
      SERVICE_ROLE_KEY,
      { global: { fetch } }
    );

    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser(token);

    if (userErr || !user) {
      return json(401, { ok: false, error: "INVALID_SESSION" });
    }

    // ---------- PARSE ----------
    const body = (await req.json().catch(() => null)) as ReqBody | null;
    if (!body) return json(400, { ok: false, error: "INVALID_JSON" });

    const entity_id = body.entity_id?.trim();
    const planKey = (
      body.plan ??
      body.plan_key ??
      body.planKey ??
      ""
    ).toString().trim();

    const source = (body.source ?? "internal").toString().trim();
    const trial_days = body.trial_days ?? null;
    const is_internal = Boolean(body.is_internal);
    const laneIsTest = Boolean(body.is_test);
    const reason = (body.reason ?? "").toString().trim();

    if (!entity_id || !planKey || !reason) {
      return json(400, {
        ok: false,
        error: "MISSING_REQUIRED_FIELDS",
        required: ["entity_id", "plan|plan_key", "reason"],
      });
    }

    // ---------- ENTITY VALIDATION ----------
    const { data: entity } = await supabase
      .from("entities")
      .select("id")
      .eq("id", entity_id)
      .maybeSingle();

    if (!entity) {
      return json(404, { ok: false, error: "ENTITY_NOT_FOUND" });
    }

    // ---------- PLAN RESOLUTION (CRITICAL FIX) ----------
    const { data: planRow } = await supabase
      .from("billing_plans")
      .select("id, key")
      .eq("key", planKey)
      .maybeSingle();

    if (!planRow?.id) {
      return json(400, {
        ok: false,
        error: "PLAN_NOT_FOUND",
        message: `No billing_plans row found for key='${planKey}'`,
      });
    }

    const plan_id = planRow.id;

    // ---------- END EXISTING ACTIVE SUBS (ENTITY + LANE) ----------
    const { data: activeSubs } = await supabase
      .from("billing_subscriptions")
      .select("id")
      .eq("entity_id", entity_id)
      .eq("is_test", laneIsTest)
      .eq("status", "active");

    if (activeSubs?.length) {
      const now = new Date().toISOString();
      await supabase
        .from("billing_subscriptions")
        .update({
          status: "ended",
          ended_at: now,
          updated_at: now,
        })
        .in(
          "id",
          activeSubs.map((s) => s.id)
        );
    }

    // ---------- TRIAL ----------
    let trialEndsAt: string | null = null;
    if (trial_days && trial_days > 0) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + trial_days);
      trialEndsAt = d.toISOString();
    }

    // ---------- INSERT (PLAN_ID GUARANTEED) ----------
    const now = new Date().toISOString();

    const { data: inserted, error: insErr } = await supabase
      .from("billing_subscriptions")
      .insert({
        entity_id,
        status: "active",
        plan_id,            // 🔒 REQUIRED — NEVER NULL
        plan_key: planKey,  // 🔁 tolerated legacy
        source,
        is_internal,
        is_test: laneIsTest,
        trial_ends_at: trialEndsAt,
        started_at: now,
        created_by: user.id,
        metadata: {
          created_reason: reason,
          created_by_email: user.email ?? null,
          tolerated_payload_aliases: {
            plan_key: body.plan_key ?? null,
            planKey: body.planKey ?? null,
          },
        },
      })
      .select()
      .single();

    if (insErr) throw insErr;

    // ---------- AUDIT (BEST-EFFORT) ----------
    await supabase
      .from("actions_log")
      .insert({
        actor_uid: user.id,
        action: "BILLING_CREATE_SUBSCRIPTION",
        target_table: "billing_subscriptions",
        target_id: inserted.id,
        details_json: {
          entity_id,
          plan_key: planKey,
          plan_id,
          source,
          is_internal,
          is_test: laneIsTest,
          trial_days,
          reason,
        },
      })
      .catch(() => {});

    return json(200, {
      ok: true,
      subscription_id: inserted.id,
      entity_id,
      plan_key: planKey,
      plan_id,
      source,
      is_test: laneIsTest,
      status: inserted.status,
    });
  } catch (e: any) {
    console.error("billing-create-subscription failed:", e);
    return json(500, {
      ok: false,
      error: "INTERNAL_ERROR",
      message: e?.message ?? String(e),
    });
  }
});
