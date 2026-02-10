// supabase/functions/billing-create-subscription/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * billing-create-subscription (PRODUCTION — LOCKED)
 *
 * ✅ OPERATOR-ONLY (valid user session required)
 * ✅ REGISTRY-GRADE (no deletes, no payments, no enforcement)
 * ✅ Lane-safe via is_test (blocks lane conflict because billing_subscriptions is UNIQUE(entity_id))
 * ✅ Reactivates by UPDATE (no INSERT) to avoid billing_subscriptions_entity_id_key violations
 *
 * Status constraint:
 *   trialing | active | past_due | paused | cancelled
 * (NO "ended")
 */

type ReqBody = {
  entity_id: string;

  // Optional: link to customer (provider-scoped customer)
  customer_id?: string | null;

  // Plan resolution (billing_plans.code)
  code?: string;
  plan?: string; // alias
  plan_key?: string; // alias
  planKey?: string; // alias

  // Subscription source (enum-backed in DB)
  source?: string; // e.g. "internal" | "manual" | "contract" (as defined in your DB)

  trial_days?: number | null; // if >0 => status trialing + trial_ends_at set
  reason: string; // REQUIRED (audited)

  is_test?: boolean; // lane
  trigger?: string;  // tolerated
};

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, Authorization, apikey, content-type, x-client-info",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...cors, "content-type": "application/json; charset=utf-8" },
  });
}

function pickBearer(req: Request) {
  const h =
    req.headers.get("authorization") ||
    req.headers.get("Authorization") ||
    "";
  return h.startsWith("Bearer ") ? h : "";
}

function pickPlanCode(b: ReqBody): string {
  const v = b.code ?? b.plan ?? b.plan_key ?? b.planKey ?? "";
  return String(v || "").trim();
}

function safeIso(input?: string | null) {
  if (!input?.trim()) return null;
  const d = new Date(input);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const request_id = req.headers.get("x-sb-request-id") || null;

  if (req.method !== "POST") {
    return json(405, { ok: false, error: "METHOD_NOT_ALLOWED", request_id });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const ANON_KEY =
      Deno.env.get("SUPABASE_ANON_KEY") ??
      Deno.env.get("SUPABASE_ANON_KEY_PUBLIC");
    const SERVICE_ROLE_KEY =
      Deno.env.get("SERVICE_ROLE_KEY") ??
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
      return json(500, { ok: false, error: "MISSING_ENV", request_id });
    }

    // -----------------------------
    // Auth: operator required (validate with ANON)
    // -----------------------------
    const bearer = pickBearer(req);
    if (!bearer) return json(401, { ok: false, error: "UNAUTHORIZED", request_id });

    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: bearer } },
      auth: { persistSession: false },
    });

    const { data: userRes, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userRes?.user?.id) {
      return json(401, { ok: false, error: "INVALID_SESSION", request_id });
    }
    const actor_id = userRes.user.id;
    const actor_email = userRes.user.email ?? null;

    // -----------------------------
    // Parse + validate input
    // -----------------------------
    const body = (await req.json().catch(() => ({}))) as ReqBody;
    const entity_id = String(body.entity_id || "").trim();
    const customer_id = body.customer_id ? String(body.customer_id).trim() : null;

    const planCode = pickPlanCode(body);
    const source = String(body.source ?? "internal").trim() || "internal";
    const reason = String(body.reason ?? "").trim();
    const laneIsTest = Boolean(body.is_test);

    const trial_days = body.trial_days ?? null;

    if (!entity_id || !planCode || !reason) {
      return json(400, {
        ok: false,
        error: "MISSING_REQUIRED_FIELDS",
        required: ["entity_id", "code (or plan/plan_key/planKey)", "reason"],
        request_id,
      });
    }

    // -----------------------------
    // Service client: registry reads/writes
    // -----------------------------
    const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { fetch },
      auth: { persistSession: false },
    });

    // Verify entity exists
    const { data: ent, error: entErr } = await svc
      .from("entities")
      .select("id")
      .eq("id", entity_id)
      .maybeSingle();

    if (entErr) {
      return json(500, { ok: false, error: "FAILED", details: entErr.message, request_id });
    }
    if (!ent) {
      return json(404, { ok: false, error: "ENTITY_NOT_FOUND", request_id });
    }

    // Resolve plan by billing_plans.code
    const { data: planRow, error: planErr } = await svc
      .from("billing_plans")
      .select("id, code, name, is_active")
      .eq("code", planCode)
      .maybeSingle();

    if (planErr) {
      return json(500, { ok: false, error: "FAILED", details: planErr.message, request_id });
    }
    if (!planRow) {
      return json(400, {
        ok: false,
        error: "PLAN_NOT_FOUND",
        message: `No billing_plans row found for code='${planCode}'`,
        request_id,
      });
    }
    if (planRow.is_active === false) {
      return json(400, {
        ok: false,
        error: "PLAN_INACTIVE",
        message: `Plan '${planCode}' is not active`,
        request_id,
      });
    }

    // Compute trial
    const nowIso = new Date().toISOString();
    let trialEndsAt: string | null = null;
    let nextStatus: "active" | "trialing" = "active";

    if (trial_days && trial_days > 0) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + trial_days);
      trialEndsAt = d.toISOString();
      nextStatus = "trialing";
    }

    // -----------------------------
    // Reactivate by UPDATE (UNIQUE(entity_id))
    // -----------------------------
    const { data: existing, error: exErr } = await svc
      .from("billing_subscriptions")
      .select("id, entity_id, is_test, status, metadata")
      .eq("entity_id", entity_id)
      .maybeSingle();

    if (exErr) {
      return json(500, { ok: false, error: "FAILED", details: exErr.message, request_id });
    }

    if (!existing) {
      // If you *want* to allow first-ever creation, do it here.
      // (But your current schema + flows already created one for this entity, so this is rare.)
      const insertPayload: Record<string, any> = {
        entity_id,
        customer_id,
        is_test: laneIsTest,
        status: nextStatus,
        source,
        plan_id: planRow.id,
        plan_key: planRow.code,
        started_at: nowIso,
        ended_at: null,
        trial_ends_at: trialEndsAt,
        created_by: actor_id,
        updated_at: nowIso,
        metadata: {
          created_reason: reason,
          created_by_email: actor_email,
          trigger: body.trigger ?? null,
          resolved_plan: { id: planRow.id, code: planRow.code, name: planRow.name ?? null },
        },
      };

      const { data: inserted, error: insErr } = await svc
        .from("billing_subscriptions")
        .insert(insertPayload)
        .select("*")
        .single();

      if (insErr) {
        return json(500, { ok: false, error: "FAILED", details: insErr.message, request_id });
      }

      // Best-effort audit
      await svc.from("actions_log").insert({
        actor_uid: actor_id,
        action: "BILLING_CREATE_SUBSCRIPTION",
        target_table: "billing_subscriptions",
        target_id: inserted.id,
        details_json: { entity_id, customer_id, is_test: laneIsTest, plan_code: planRow.code, plan_id: planRow.id, status: nextStatus, source, reason },
      }).catch(() => {});

      return json(200, {
        ok: true,
        subscription_id: inserted.id,
        entity_id,
        customer_id,
        status: inserted.status,
        plan_id: inserted.plan_id,
        plan_code: planRow.code,
        source: inserted.source ?? source,
        is_test: inserted.is_test ?? laneIsTest,
        request_id,
      });
    }

    // Lane conflict guard (prevents SANDBOX↔RoT contamination with UNIQUE(entity_id))
    if (Boolean(existing.is_test) !== laneIsTest) {
      return json(409, {
        ok: false,
        error: "LANE_CONFLICT",
        message:
          "A subscription already exists for this entity in the opposite lane, and billing_subscriptions is UNIQUE(entity_id). Switch lane or migrate schema to UNIQUE(entity_id,is_test) if you truly need dual-lane subscriptions.",
        existing: { subscription_id: existing.id, is_test: Boolean(existing.is_test), status: existing.status },
        requested: { is_test: laneIsTest },
        request_id,
      });
    }

    // Merge metadata (preserve history)
    const mergedMeta = {
      ...(existing.metadata ?? {}),
      last_reactivated_at: nowIso,
      last_reactivated_by: actor_id,
      last_reactivated_by_email: actor_email,
      last_reactivated_reason: reason,
      trigger: body.trigger ?? null,
      resolved_plan: { id: planRow.id, code: planRow.code, name: planRow.name ?? null },
    };

    const { error: updErr } = await svc
      .from("billing_subscriptions")
      .update({
        customer_id,                 // optional relink
        status: nextStatus,          // active | trialing
        source,
        plan_id: planRow.id,
        plan_key: planRow.code,
        started_at: nowIso,          // reset lifecycle start
        ended_at: null,              // re-activate => clear terminal timestamp
        trial_ends_at: trialEndsAt,  // may be null
        updated_at: nowIso,
        metadata: mergedMeta,
      })
      .eq("id", existing.id);

    if (updErr) {
      return json(500, { ok: false, error: "FAILED", details: updErr.message, request_id });
    }

    // Best-effort audit
    await svc.from("actions_log").insert({
      actor_uid: actor_id,
      action: "BILLING_CREATE_SUBSCRIPTION",
      target_table: "billing_subscriptions",
      target_id: existing.id,
      details_json: {
        entity_id,
        customer_id,
        is_test: laneIsTest,
        plan_code: planRow.code,
        plan_id: planRow.id,
        status: nextStatus,
        source,
        reason,
        reactivated: true,
      },
    }).catch(() => {});

    return json(200, {
      ok: true,
      subscription_id: existing.id,
      entity_id,
      customer_id,
      status: nextStatus,
      plan_id: planRow.id,
      plan_code: planRow.code,
      source,
      is_test: laneIsTest,
      request_id,
      note: "Reactivated existing subscription row (UNIQUE(entity_id) schema).",
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
