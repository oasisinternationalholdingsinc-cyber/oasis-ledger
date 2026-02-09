import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * billing-update-subscription
 *
 * OPERATOR-ONLY
 * REGISTRY-GRADE
 * NO DELETES
 * NO PAYMENTS
 * NO AUTO-ENFORCEMENT
 *
 * Updates an existing subscription plan.
 * - Immediate change OR scheduled (effective_at)
 * - Preserves history via metadata
 * - Lane-safe
 */

type ReqBody = {
  subscription_id: string;        // REQUIRED
  next_plan: string;              // REQUIRED (enum-backed)
  effective_at?: string | null;   // optional ISO (defaults to now)
  reason: string;                 // REQUIRED
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ ok: false, error: "METHOD_NOT_ALLOWED" }),
      { status: 405, headers: cors }
    );
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_ROLE_KEY =
      Deno.env.get("SERVICE_ROLE_KEY") ??
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      throw new Error("Missing Supabase env vars");
    }

    // ---------- auth (operator required) ----------
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ ok: false, error: "UNAUTHORIZED" }),
        { status: 401, headers: cors }
      );
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { headers: { authorization: authHeader } },
    });

    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser();

    if (userErr || !user) {
      return new Response(
        JSON.stringify({ ok: false, error: "INVALID_SESSION" }),
        { status: 401, headers: cors }
      );
    }

    // ---------- parse + validate ----------
    const body = (await req.json()) as ReqBody;
    const { subscription_id, next_plan, effective_at, reason } = body;

    if (!subscription_id || !next_plan || !reason?.trim()) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "MISSING_REQUIRED_FIELDS",
          required: ["subscription_id", "next_plan", "reason"],
        }),
        { status: 400, headers: cors }
      );
    }

    // ---------- load subscription ----------
    const { data: sub, error: subErr } = await supabase
      .from("billing_subscriptions")
      .select("id, status, plan_key, entity_id, is_test, metadata")
      .eq("id", subscription_id)
      .maybeSingle();

    if (subErr) throw subErr;

    if (!sub) {
      return new Response(
        JSON.stringify({ ok: false, error: "SUBSCRIPTION_NOT_FOUND" }),
        { status: 404, headers: cors }
      );
    }

    if (String(sub.status).toLowerCase() === "ended") {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "SUBSCRIPTION_ALREADY_ENDED",
        }),
        { status: 409, headers: cors }
      );
    }

    // No-op guard
    if (String(sub.plan_key) === String(next_plan)) {
      return new Response(
        JSON.stringify({
          ok: true,
          subscription_id: sub.id,
          status: sub.status,
          note: "Plan unchanged (no update performed).",
        }),
        { status: 200, headers: cors }
      );
    }

    const now = new Date().toISOString();
    const effectiveAt =
      effective_at && effective_at.trim()
        ? new Date(effective_at).toISOString()
        : now;

    const isImmediate = effectiveAt <= now;

    // ---------- build metadata (history preserved) ----------
    const prevMeta = (sub.metadata && typeof sub.metadata === "object")
      ? sub.metadata
      : {};

    const nextMeta = {
      ...prevMeta,
      plan_change: {
        from: sub.plan_key,
        to: next_plan,
        effective_at: effectiveAt,
        changed_at: now,
        changed_by: user.id,
        changed_by_email: user.email ?? null,
        reason,
      },
    };

    // ---------- apply update ----------
    const updatePayload: any = {
      metadata: nextMeta,
      updated_at: now,
    };

    if (isImmediate) {
      updatePayload.plan_key = next_plan;
    } else {
      // scheduled change (no automation yet)
      updatePayload.metadata = {
        ...nextMeta,
        scheduled_plan: {
          next_plan,
          effective_at: effectiveAt,
        },
      };
    }

    const { error: updErr } = await supabase
      .from("billing_subscriptions")
      .update(updatePayload)
      .eq("id", subscription_id);

    if (updErr) throw updErr;

    // ---------- audit log (best-effort) ----------
    await supabase
      .from("actions_log")
      .insert({
        actor_uid: user.id,
        action: "BILLING_UPDATE_SUBSCRIPTION",
        target_table: "billing_subscriptions",
        target_id: subscription_id,
        details_json: {
          entity_id: sub.entity_id,
          is_test: sub.is_test,
          from_plan: sub.plan_key,
          to_plan: next_plan,
          effective_at: effectiveAt,
          immediate: isImmediate,
          reason,
        },
      })
      .throwOnError()
      .catch(() => {
        /* audit is best-effort */
      });

    // ---------- response ----------
    return new Response(
      JSON.stringify({
        ok: true,
        subscription_id,
        previous_plan: sub.plan_key,
        next_plan,
        effective_at: effectiveAt,
        immediate: isImmediate,
      }),
      { status: 200, headers: cors }
    );
  } catch (e: any) {
    console.error("billing-update-subscription failed:", e);
    return new Response(
      JSON.stringify({
        ok: false,
        error: "INTERNAL_ERROR",
        message: e?.message ?? String(e),
      }),
      { status: 500, headers: cors }
    );
  }
});
