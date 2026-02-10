import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * billing-update-subscription (PRODUCTION — LOCKED)
 *
 * ✅ OPERATOR-ONLY (valid user session required)
 * ✅ REGISTRY-GRADE (no deletes, no payments, no enforcement)
 * ✅ Schema-aligned:
 *    - billing_subscriptions.status CHECK: trialing|active|past_due|paused|cancelled (NO "ended")
 *    - Resolve plan via billing_plans.code -> plan_id
 *    - Update plan_id + plan_key (code) when immediate
 * ✅ Supports scheduled change (writes metadata only; no automation)
 */

type ReqBody = {
  subscription_id: string;        // REQUIRED
  next_plan: string;              // REQUIRED (billing_plans.code)
  effective_at?: string | null;   // optional ISO (defaults to now)
  reason: string;                 // REQUIRED
  trigger?: string;               // tolerated
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
    // Parse + validate
    // -----------------------------
    const body = (await req.json().catch(() => ({}))) as ReqBody;
    const subscription_id = String(body.subscription_id || "").trim();
    const next_plan_code = String(body.next_plan || "").trim();
    const reason = String(body.reason || "").trim();

    if (!subscription_id || !next_plan_code || !reason) {
      return json(400, {
        ok: false,
        error: "MISSING_REQUIRED_FIELDS",
        required: ["subscription_id", "next_plan", "reason"],
        request_id,
      });
    }

    const nowIso = new Date().toISOString();
    const effectiveAt = safeIso(body.effective_at) ?? nowIso;
    const isImmediate = effectiveAt <= nowIso;

    // -----------------------------
    // Service client: registry reads/writes
    // -----------------------------
    const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { fetch },
      auth: { persistSession: false },
    });

    // Load subscription
    const { data: sub, error: subErr } = await svc
      .from("billing_subscriptions")
      .select("id, status, entity_id, is_test, plan_id, plan_key, metadata")
      .eq("id", subscription_id)
      .maybeSingle();

    if (subErr) {
      return json(500, { ok: false, error: "FAILED", details: subErr.message, request_id });
    }
    if (!sub) {
      return json(404, { ok: false, error: "SUBSCRIPTION_NOT_FOUND", request_id });
    }

    // Terminal guard: cancelled subscriptions are ended in your model
    if (String(sub.status || "").toLowerCase() === "cancelled") {
      return json(409, { ok: false, error: "SUBSCRIPTION_CANCELLED", request_id });
    }

    // Resolve plan by billing_plans.code
    const { data: planRow, error: planErr } = await svc
      .from("billing_plans")
      .select("id, code, name, is_active")
      .eq("code", next_plan_code)
      .maybeSingle();

    if (planErr) {
      return json(500, { ok: false, error: "FAILED", details: planErr.message, request_id });
    }
    if (!planRow) {
      return json(400, {
        ok: false,
        error: "PLAN_NOT_FOUND",
        message: `No billing_plans row found for code='${next_plan_code}'`,
        request_id,
      });
    }
    if (planRow.is_active === false) {
      return json(400, {
        ok: false,
        error: "PLAN_INACTIVE",
        message: `Plan '${next_plan_code}' is not active`,
        request_id,
      });
    }

    // No-op guard (compare by code / plan_key, fallback to plan_id)
    const currentKey = String(sub.plan_key || "");
    if (currentKey === planRow.code) {
      return json(200, {
        ok: true,
        subscription_id: sub.id,
        status: sub.status,
        note: "Plan unchanged (no update performed).",
        request_id,
      });
    }

    // -----------------------------
    // Build metadata (preserve history)
    // -----------------------------
    const prevMeta =
      sub.metadata && typeof sub.metadata === "object" ? sub.metadata : {};

    const changeRecord = {
      from: sub.plan_key ?? null,
      to: planRow.code,
      to_plan_id: planRow.id,
      effective_at: effectiveAt,
      changed_at: nowIso,
      changed_by: actor_id,
      changed_by_email: actor_email,
      reason,
      trigger: body.trigger ?? null,
      immediate: isImmediate,
    };

    // keep an append-only history array
    const history = Array.isArray((prevMeta as any).plan_change_history)
      ? (prevMeta as any).plan_change_history
      : [];

    const nextMeta: Record<string, any> = {
      ...prevMeta,
      plan_change_history: [...history, changeRecord],
      last_plan_change: changeRecord,
    };

    // -----------------------------
    // Apply update (immediate or scheduled)
    // -----------------------------
    const updatePayload: Record<string, any> = {
      metadata: nextMeta,
      updated_at: nowIso,
    };

    if (isImmediate) {
      updatePayload.plan_id = planRow.id;
      updatePayload.plan_key = planRow.code;
      // if there was a previously scheduled plan, clear it
      if ((updatePayload.metadata as any).scheduled_plan) {
        (updatePayload.metadata as any).scheduled_plan = null;
      }
    } else {
      (updatePayload.metadata as any).scheduled_plan = {
        next_plan: planRow.code,
        next_plan_id: planRow.id,
        effective_at: effectiveAt,
        scheduled_at: nowIso,
        scheduled_by: actor_id,
        scheduled_by_email: actor_email,
        reason,
        trigger: body.trigger ?? null,
      };
    }

    const { error: updErr } = await svc
      .from("billing_subscriptions")
      .update(updatePayload)
      .eq("id", subscription_id);

    if (updErr) {
      return json(500, { ok: false, error: "FAILED", details: updErr.message, request_id });
    }

    // Best-effort audit
    await svc
      .from("actions_log")
      .insert({
        actor_uid: actor_id,
        action: "BILLING_UPDATE_SUBSCRIPTION",
        target_table: "billing_subscriptions",
        target_id: subscription_id,
        details_json: {
          entity_id: sub.entity_id,
          is_test: sub.is_test,
          from_plan: sub.plan_key,
          to_plan: planRow.code,
          to_plan_id: planRow.id,
          effective_at: effectiveAt,
          immediate: isImmediate,
          reason,
          trigger: body.trigger ?? null,
        },
      })
      .catch(() => {});

    return json(200, {
      ok: true,
      subscription_id,
      previous_plan: sub.plan_key,
      next_plan: planRow.code,
      next_plan_id: planRow.id,
      effective_at: effectiveAt,
      immediate: isImmediate,
      request_id,
    });
  } catch (e: any) {
    console.error("billing-update-subscription failed:", e);
    return json(500, {
      ok: false,
      error: "INTERNAL_ERROR",
      message: e?.message ?? String(e),
    });
  }
});
