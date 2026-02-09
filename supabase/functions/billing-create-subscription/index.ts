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
 *
 * NO REGRESSION:
 * - Accepts legacy UI payloads (plan_key alias)
 * - Defaults source to "internal" if not provided
 * - Auth validation uses explicit token (supabase-js v2 correct pattern)
 */

type ReqBody = {
  entity_id: string;

  // canonical
  plan?: string; // enum-backed in DB
  source?: string; // internal | contract | manual (enum-backed)

  // tolerated aliases (NO REGRESSION)
  plan_key?: string;
  planKey?: string;

  trial_days?: number | null;
  is_internal?: boolean | null;

  is_test?: boolean; // lane (authoritative if provided)
  reason: string; // REQUIRED
};

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
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
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
    if (!authHeader?.toLowerCase().startsWith("bearer ")) {
      return json(401, { ok: false, error: "UNAUTHORIZED" });
    }

    const token = authHeader.slice(7).trim();
    if (!token) return json(401, { ok: false, error: "UNAUTHORIZED" });

    // IMPORTANT: service_role client for DB writes, but validate operator via token explicitly
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { fetch },
    });

    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser(token);

    if (userErr || !user) {
      return json(401, { ok: false, error: "INVALID_SESSION" });
    }

    // ---------- parse + validate ----------
    const body = (await req.json().catch(() => null)) as ReqBody | null;
    if (!body) {
      return json(400, { ok: false, error: "INVALID_JSON" });
    }

    const entity_id = body.entity_id;

    // NO REGRESSION: accept plan_key/planKey alias
    const plan = (body.plan ?? body.plan_key ?? body.planKey ?? "").toString().trim();

    // NO REGRESSION: default source if missing
    const source = (body.source ?? "internal").toString().trim();

    const trial_days = body.trial_days ?? null;
    const is_internal = body.is_internal ?? null;
    const is_test = Boolean(body.is_test);
    const reason = (body.reason ?? "").toString().trim();

    if (!entity_id || !plan || !source || !reason) {
      return json(400, {
        ok: false,
        error: "MISSING_REQUIRED_FIELDS",
        required: ["entity_id", "plan (or plan_key)", "source (defaults internal)", "reason"],
      });
    }

    const laneIsTest = Boolean(is_test);

    // ---------- verify entity exists ----------
    const { data: entity, error: entErr } = await supabase
      .from("entities")
      .select("id")
      .eq("id", entity_id)
      .maybeSingle();

    if (entErr || !entity) {
      return json(404, { ok: false, error: "ENTITY_NOT_FOUND" });
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
          activeSubs.map((s: any) => s.id)
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
          tolerated_payload_aliases: {
            plan_key: body.plan_key ?? null,
            planKey: body.planKey ?? null,
          },
        },
      })
      .select()
      .single();

    if (insErr) throw insErr;

    // ---------- audit log (best-effort) ----------
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
      .then(() => null)
      .catch(() => {
        /* best-effort */
      });

    return json(200, {
      ok: true,
      subscription_id: inserted.id,
      entity_id,
      status: inserted.status,
      plan: inserted.plan_key,
      source: inserted.source,
      is_test: laneIsTest,
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
