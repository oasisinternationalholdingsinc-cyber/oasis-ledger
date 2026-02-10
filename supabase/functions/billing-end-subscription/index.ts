// supabase/functions/billing-end-subscription/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * billing-end-subscription (PRODUCTION — LOCKED)
 *
 * ✅ OPERATOR-ONLY (requires valid user session)
 * ✅ REGISTRY-GRADE
 * ✅ NO DELETES
 * ✅ NO PAYMENTS
 * ✅ NO AUTO-REPLACEMENT
 * ✅ Idempotent (if already cancelled / ended_at present, returns ok)
 *
 * Canonical terminal state:
 *   - status = 'cancelled' (per billing_subscriptions_status_check)
 *   - ended_at set (terminal timestamp)
 */

type ReqBody = {
  subscription_id: string; // REQUIRED
  ended_at?: string | null; // optional ISO (defaults to now)
  reason: string; // REQUIRED
  trigger?: string; // tolerated
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

  const request_id =
    req.headers.get("x-sb-request-id") ?? req.headers.get("x-request-id") ?? null;

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
    // Auth: operator required (validate session using ANON)
    // -----------------------------
    const bearer = pickBearer(req);
    if (!bearer) {
      return json(401, { ok: false, error: "UNAUTHORIZED", request_id });
    }

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
    const body = (await req.json().catch(() => ({}))) as Partial<ReqBody>;
    const subscription_id = String(body.subscription_id ?? "").trim();
    const reason = String(body.reason ?? "").trim();

    if (!subscription_id || !reason) {
      return json(400, {
        ok: false,
        error: "MISSING_REQUIRED_FIELDS",
        required: ["subscription_id", "reason"],
        request_id,
      });
    }

    const endedAt = safeIso(body.ended_at ?? null) ?? new Date().toISOString();
    const now = new Date().toISOString();

    // -----------------------------
    // Service client: registry writes
    // -----------------------------
    const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { fetch },
      auth: { persistSession: false },
    });

    // Load subscription (include metadata so we merge, not overwrite)
    const { data: sub, error: subErr } = await svc
      .from("billing_subscriptions")
      .select("id, status, entity_id, is_test, ended_at, metadata")
      .eq("id", subscription_id)
      .maybeSingle();

    if (subErr) {
      return json(500, {
        ok: false,
        error: "FAILED",
        details: subErr.message,
        request_id,
      });
    }

    if (!sub) {
      return json(404, {
        ok: false,
        error: "SUBSCRIPTION_NOT_FOUND",
        request_id,
      });
    }

    const curStatus = String(sub.status ?? "").toLowerCase();
    const alreadyEnded = curStatus === "cancelled" || !!sub.ended_at;

    // -----------------------------
    // Idempotent: already ended
    // -----------------------------
    if (alreadyEnded) {
      return json(200, {
        ok: true,
        subscription_id: sub.id,
        status: "cancelled",
        ended_at: sub.ended_at ?? endedAt,
        note: "Subscription already ended/cancelled (no action taken).",
        request_id,
      });
    }

    // Preserve existing metadata
    const mergedMeta = {
      ...(sub.metadata ?? {}),
      ended_reason: reason,
      ended_at: endedAt,
      ended_by: actor_id,
      ended_by_email: actor_email,
      trigger: body.trigger ?? null,
    };

    // -----------------------------
    // Update subscription
    // -----------------------------
    const { error: updErr } = await svc
      .from("billing_subscriptions")
      .update({
        status: "cancelled", // ✅ CONSTRAINT-SAFE TERMINAL STATUS
        ended_at: endedAt,
        updated_at: now,
        metadata: mergedMeta,
      })
      .eq("id", subscription_id);

    if (updErr) {
      return json(500, {
        ok: false,
        error: "FAILED",
        details: updErr.message,
        request_id,
      });
    }

    // -----------------------------
    // Best-effort audit
    // -----------------------------
    await svc
      .from("actions_log")
      .insert({
        actor_uid: actor_id,
        action: "BILLING_END_SUBSCRIPTION",
        target_table: "billing_subscriptions",
        target_id: subscription_id,
        details_json: {
          entity_id: sub.entity_id,
          is_test: sub.is_test,
          ended_at: endedAt,
          reason,
          trigger: body.trigger ?? null,
          previous_status: sub.status ?? null,
          new_status: "cancelled",
        },
      })
      .throwOnError()
      .catch(() => {});

    return json(200, {
      ok: true,
      subscription_id,
      status: "cancelled",
      ended_at: endedAt,
      request_id,
    });
  } catch (e: any) {
    return json(500, {
      ok: false,
      error: "INTERNAL_ERROR",
      message: e?.message ?? String(e),
      request_id: null,
    });
  }
});
