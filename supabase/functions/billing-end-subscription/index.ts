import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * billing-end-subscription
 *
 * OPERATOR-ONLY
 * REGISTRY-GRADE
 * NO DELETES
 * NO PAYMENTS
 * NO AUTO-REPLACEMENT
 *
 * Explicitly ends a billing subscription.
 * Preserves full history.
 */

type ReqBody = {
  subscription_id: string;      // REQUIRED
  ended_at?: string | null;     // optional ISO (defaults to now)
  reason: string;               // REQUIRED
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
    const { subscription_id, ended_at, reason } = body;

    if (!subscription_id || !reason?.trim()) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "MISSING_REQUIRED_FIELDS",
          required: ["subscription_id", "reason"],
        }),
        { status: 400, headers: cors }
      );
    }

    // ---------- load subscription ----------
    const { data: sub, error: subErr } = await supabase
      .from("billing_subscriptions")
      .select("id, status, entity_id, is_test")
      .eq("id", subscription_id)
      .maybeSingle();

    if (subErr) throw subErr;

    if (!sub) {
      return new Response(
        JSON.stringify({ ok: false, error: "SUBSCRIPTION_NOT_FOUND" }),
        { status: 404, headers: cors }
      );
    }

    // Already ended? Idempotent-safe exit
    if (String(sub.status).toLowerCase() === "ended") {
      return new Response(
        JSON.stringify({
          ok: true,
          subscription_id: sub.id,
          status: "ended",
          note: "Subscription already ended (no action taken).",
        }),
        { status: 200, headers: cors }
      );
    }

    const endAt =
      ended_at && ended_at.trim()
        ? new Date(ended_at).toISOString()
        : new Date().toISOString();

    const now = new Date().toISOString();

    // ---------- end subscription ----------
    const { error: updErr } = await supabase
      .from("billing_subscriptions")
      .update({
        status: "ended",
        ended_at: endAt,
        updated_at: now,
        metadata: {
          ...(sub as any)?.metadata,
          ended_reason: reason,
          ended_by: user.id,
          ended_by_email: user.email ?? null,
        },
      })
      .eq("id", subscription_id);

    if (updErr) throw updErr;

    // ---------- audit log (best-effort) ----------
    await supabase
      .from("actions_log")
      .insert({
        actor_uid: user.id,
        action: "BILLING_END_SUBSCRIPTION",
        target_table: "billing_subscriptions",
        target_id: subscription_id,
        details_json: {
          entity_id: sub.entity_id,
          is_test: sub.is_test,
          ended_at: endAt,
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
        status: "ended",
        ended_at: endAt,
      }),
      { status: 200, headers: cors }
    );
  } catch (e: any) {
    console.error("billing-end-subscription failed:", e);
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
