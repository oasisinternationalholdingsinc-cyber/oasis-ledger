import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * billing-create-subscription (PRODUCTION — OPERATOR ONLY)
 *
 * ✅ Registry-grade, lane-safe (is_test)
 * ✅ NO enforcement, NO payments, NO deletes
 * ✅ UNIQUE(entity_id) safe: "Create" re-activates (UPDATE) if row exists
 *
 * NO REGRESSION CONTRACT:
 * - Accepts legacy UI payloads:
 *   - plan / code / plan_key / planKey
 * - Defaults source to "internal" if missing
 * - Operator auth: validate Bearer JWT (anon) then write with service_role
 * - Resolves billing_plans by `code`
 */

type ReqBody = {
  entity_id: string;

  // plan selection (tolerated)
  code?: string;      // preferred
  plan?: string;      // alias
  plan_key?: string;  // alias
  planKey?: string;   // alias

  // optional
  source?: string;            // internal | contract | manual (enum-backed)
  trial_days?: number | null; // optional
  is_internal?: boolean | null;

  // lane safety
  is_test?: boolean;

  // optional customer binding
  customer_id?: string | null;

  // required audit reason
  reason: string;

  // tolerated
  trigger?: string;
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
  const v = (b.code ?? b.plan ?? b.plan_key ?? b.planKey ?? "") as string;
  return String(v || "").trim();
}

function safeObj(v: any) {
  return v && typeof v === "object" ? v : {};
}

function addDaysUtc(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") {
    return json(405, { ok: false, error: "METHOD_NOT_ALLOWED" });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_ROLE_KEY =
      Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return json(500, { ok: false, error: "MISSING_ENV" });
    }

    // ---------- auth: operator required ----------
    const authHeader =
      req.headers.get("authorization") || req.headers.get("Authorization");
    if (!authHeader?.toLowerCase().startsWith("bearer ")) {
      return json(401, { ok: false, error: "UNAUTHORIZED" });
    }
    const token = authHeader.slice(7).trim();
    if (!token) return json(401, { ok: false, error: "UNAUTHORIZED" });

    // service role for DB writes
    const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { global: { fetch } });

    // validate operator using explicit JWT
    const { data: userRes, error: userErr } = await svc.auth.getUser(token);
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
    const laneIsTest = Boolean(body.is_test);
    const customer_id = (body.customer_id ?? null) ? String(body.customer_id).trim() : null;

    const trial_days = body.trial_days ?? null;
    const is_internal = body.is_internal ?? null;

    if (!entity_id || !planCode || !reason) {
      return json(400, {
        ok: false,
        error: "MISSING_REQUIRED_FIELDS",
        required: ["entity_id", "code (or plan/plan_key/planKey)", "reason"],
      });
    }

    // ---------- verify entity exists ----------
    const { data: ent, error: entErr } = await svc
      .from("entities")
      .select("id")
      .eq("id", entity_id)
      .maybeSingle();

    if (entErr || !ent) return json(404, { ok: false, error: "ENTITY_NOT_FOUND" });

    // ---------- resolve plan by billing_plans.code ----------
    const { data: planRow, error: planErr } = await svc
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

    // ---------- compute trial ----------
    let trialEndsAt: string | null = null;
    let nextStatus: "active" | "trialing" = "active";
    if (trial_days && trial_days > 0) {
      trialEndsAt = addDaysUtc(trial_days);
      nextStatus = "trialing";
    }

    const nowIso = new Date().toISOString();

    // ---------- load existing subscription (UNIQUE(entity_id)) ----------
    const { data: existing, error: exErr } = await svc
      .from("billing_subscriptions")
      .select("id, entity_id, is_test, status, plan_id, plan_key, metadata")
      .eq("entity_id", entity_id)
      .maybeSingle();

    if (exErr) throw exErr;

    // ---------- lane mismatch guard ----------
    if (existing && Boolean(existing.is_test) !== laneIsTest) {
      return json(409, {
        ok: false,
        error: "LANE_MISMATCH",
        message:
          "A subscription already exists for this entity in the opposite lane. UNIQUE(entity_id) prevents separate SANDBOX/RoT rows.",
        existing: { id: existing.id, is_test: Boolean(existing.is_test), status: existing.status },
        requested: { is_test: laneIsTest },
      });
    }

    // ---------- build metadata history ----------
    const prevMeta = safeObj(existing?.metadata);
    const history = Array.isArray(prevMeta.history) ? prevMeta.history : [];

    const historyEntry = {
      at: nowIso,
      by: user.id,
      by_email: user.email ?? null,
      action: existing ? "REACTIVATE_OR_UPDATE" : "CREATE",
      reason,
      trigger: body.trigger ?? null,
      from: existing
        ? {
            status: existing.status ?? null,
            plan_id: existing.plan_id ?? null,
            plan_key: existing.plan_key ?? null,
          }
        : null,
      to: {
        status: nextStatus,
        plan_id: planRow.id,
        plan_key: planRow.code,
        source,
        trial_days: trial_days ?? null,
        trial_ends_at: trialEndsAt,
        customer_id,
      },
    };

    const nextMeta = {
      ...prevMeta,
      last_change: historyEntry,
      history: [historyEntry, ...history].slice(0, 50),
      resolved_plan: { id: planRow.id, code: planRow.code, name: planRow.name ?? null },
    };

    // ---------- write (UPDATE if exists, else INSERT) ----------
    if (existing?.id) {
      const updatePayload: Record<string, any> = {
        plan_id: planRow.id,
        plan_key: planRow.code, // tolerated column exists in your schema
        status: nextStatus,
        source,
        is_internal: Boolean(is_internal),
        is_test: laneIsTest,
        trial_ends_at: trialEndsAt,
        started_at: nowIso,
        ended_at: null,
        cancel_at: null,
        updated_at: nowIso,
        metadata: nextMeta,
      };

      // optional customer link (only if provided)
      if (customer_id) updatePayload.customer_id = customer_id;

      const { data: updated, error: updErr } = await svc
        .from("billing_subscriptions")
        .update(updatePayload)
        .eq("id", existing.id)
        .select("*")
        .single();

      if (updErr) throw updErr;

      // audit (best-effort)
      try {
        await svc.from("actions_log").insert({
          actor_uid: user.id,
          action: "BILLING_CREATE_SUBSCRIPTION",
          target_table: "billing_subscriptions",
          target_id: updated.id,
          details_json: {
            mode: "update",
            entity_id,
            is_test: laneIsTest,
            plan_id: planRow.id,
            plan_code: planRow.code,
            status: nextStatus,
            source,
            reason,
          },
        });
      } catch {
        // best-effort
      }

      return json(200, {
        ok: true,
        mode: "updated",
        subscription_id: updated.id,
        entity_id,
        status: updated.status,
        plan_id: updated.plan_id,
        plan_code: planRow.code,
        source: updated.source ?? source,
        is_test: laneIsTest,
      });
    }

    // INSERT path (first ever row for entity_id)
    const insertPayload: Record<string, any> = {
      entity_id,
      plan_id: planRow.id,
      plan_key: planRow.code,
      status: nextStatus,
      source,
      is_internal: Boolean(is_internal),
      is_test: laneIsTest,
      trial_ends_at: trialEndsAt,
      started_at: nowIso,
      created_by: user.id,
      updated_at: nowIso,
      metadata: nextMeta,
    };

    if (customer_id) insertPayload.customer_id = customer_id;

    const { data: inserted, error: insErr } = await svc
      .from("billing_subscriptions")
      .insert(insertPayload)
      .select("*")
      .single();

    if (insErr) throw insErr;

    // audit (best-effort)
    try {
      await svc.from("actions_log").insert({
        actor_uid: user.id,
        action: "BILLING_CREATE_SUBSCRIPTION",
        target_table: "billing_subscriptions",
        target_id: inserted.id,
        details_json: {
          mode: "insert",
          entity_id,
          is_test: laneIsTest,
          plan_id: planRow.id,
          plan_code: planRow.code,
          status: nextStatus,
          source,
          reason,
        },
      });
    } catch {
      // best-effort
    }

    return json(200, {
      ok: true,
      mode: "inserted",
      subscription_id: inserted.id,
      entity_id,
      status: inserted.status,
      plan_id: inserted.plan_id,
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
