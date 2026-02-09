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
 * Creates a new billing_subscriptions row for an entity.
 * Cleanly ends any existing active subscription for that entity + lane.
 */

type ReqBody = {
  entity_id: string;

  plan: string; // enum-backed in DB
  source: string; // internal | contract | manual (enum-backed)

  trial_days?: number | null;
  is_internal?: boolean | null;

  is_test?: boolean; // lane (authoritative if provided)
  reason: string; // REQUIRED
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
    return new Response(JSON.stringify({ ok: false, error: "METHOD_NOT_ALLOWED" }), {
      status: 405,
      headers: cors,
    });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_ROLE_KEY =
      Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      throw new Error("Missing Supabase env vars");
    }

    // ---------- auth: operator required ----------
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ ok: false, error: "UNAUTHORIZED" }), {
        status: 401,
        headers: cors,
      });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { headers: { authorization: authHeader } },
    });

    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser();

    if (userErr || !user) {
      return new Response(JSON.stringify({ ok: false, error: "INVALID_SESSION" }), {
        status: 401,
        headers: cors,
      });
    }

    // ---------- parse + validate ----------
    const body = (await req.json()) as ReqBody;

    const {
      entity_id,
      plan,
      source,
      trial_days,
      is_internal,
      is_test,
      reason,
    } = body;

    if (!entity_id || !plan || !source || !reason?.trim()) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "MISSING_REQUIRED_FIELDS",
          required: ["entity_id", "plan", "source", "reason"],
        }),
        { status: 400, headers: cors }
      );
    }

    const laneIsTest = Boolean(is_test);

    // ---------- verify entity exists ----------
    const { data: entity, error: entErr } = await supabase
      .from("entities")
      .select("id")
      .eq("id", entity_id)
      .maybeSingle();

    if (entErr || !entity) {
      return new Response(
        JSON.stringify({ ok: false, error: "ENTITY_NOT_FOUND" }),
        { status: 404, headers: cors }
      );
    }

    // ---------- end any existing ACTIVE subscription (same entity + lane) ----------
    const { data: activeSubs, error: activeErr } = await supabase
      .from("billing_subscriptions")
      .select("id")
      .eq("entity_id", entity_id)
      .eq("is_test", laneIsTest)
      .eq("status", "active");

    if (activeErr) throw activeErr;

    if (activeSubs && activeSubs.length > 0) {
      const now = new Date().toISOString();

      const { error: endErr } = await supabase
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
    const now = new Date().toISOString();

    const { data: inserted, error: insErr } = await supabase
      .from("billing_subscriptions")
      .insert({
        entity_id,
        status: "active",
        plan_key: plan,
        source,
        is_internal: Boolean(is_internal),
        is_test: laneIsTest,
        trial_ends_at: trialEndsAt,
        started_at: now,
        created_by: user.id,
        metadata: {
          created_reason: reason,
          created_by_email: user.email ?? null,
        },
      })
      .select()
      .single();

    if (insErr) throw insErr;

    // ---------- audit log (optional table, tolerated if missing) ----------
    await supabase
      .from("actions_log")
      .insert({
        actor_uid: user.id,
        action: "BILLING_CREATE_SUBSCRIPTION",
        target_table: "billing_subscriptions",
        target_id: inserted.id,
        details_json: {
          entity_id,
          plan,
          source,
          is_internal: Boolean(is_internal),
          is_test: laneIsTest,
          trial_days: trial_days ?? null,
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
        subscription_id: inserted.id,
        entity_id,
        status: inserted.status,
        plan: inserted.plan_key,
        is_test: laneIsTest,
      }),
      { status: 200, headers: cors }
    );
  } catch (e: any) {
    console.error("billing-create-subscription failed:", e);
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
