// supabase/functions/billing-end-subscription/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * billing-end-subscription (PRODUCTION — LOCKED)
 *
 * ✅ OPERATOR-ONLY (valid user session required)
 * ✅ REGISTRY-GRADE
 * ✅ NO DELETES
 * ✅ NO PAYMENTS
 * ✅ NO AUTO-REPLACEMENT
 * ✅ Lane-safe via is_test (read-only; we do not mutate lane here)
 * ✅ Idempotent: if already cancelled, returns ok (no-op)
 *
 * IMPORTANT (NO REGRESSION):
 * billing_subscriptions.status is CHECK constrained to:
 * ['trialing','active','past_due','paused','cancelled'] — NOT 'ended'.
 * So "End Subscription" => status='cancelled' + ended_at (+ cancel_at).
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

function json(status: number, body: unknown, req: Request) {
  const request_id =
    req.headers.get("x-sb-request-id") ||
    req.headers.get("x-sb-requestid") ||
    null;

  return new Response(
    JSON.stringify({ ...(body as any), request_id }, null, 2),
    {
      status,
      headers: { ...cors, "content-type": "application/json; charset=utf-8" },
    },
  );
}

function pickBearer(req: Request) {
  const h =
    req.headers.get("authorization") ||
    req.headers.get("Authorization") ||
    "";
  // Allow any casing of "Bearer"
  return /^bearer\s+/i.test(h) ? `Bearer ${h.split(/\s+/).slice(1).join(" ")}` : "";
}

function safeIso(input?: string | null) {
  if (!input?.trim()) return null;
  const d = new Date(input);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") {
    return json(405, { ok: false, error: "METHOD_NOT_ALLOWED" }, req);
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
      return json(500, { ok: false, error: "MISSING_ENV" }, req);
    }

    // -----------------------------
    // Auth: operator required (ANON validate session)
    // -----------------------------
    const bearer = pickBearer(req);
    if (!bearer) {
      return json(401, { ok: false, error: "UNAUTHORIZED" }, req);
    }

    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: bearer } }, // proper casing
      auth: { persistSession: false },
    });

    const { data: userRes, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userRes?.user?.id) {
      return json(401, { ok: false, error: "INVALID_SESSION" }, req);
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
      return json(
        400,
        {
          ok: false,
          error: "MISSING_REQUIRED_FIELDS",
          required: ["subscription_id", "reason"],
        },
        req,
      );
    }

    const endedAt = safeIso(body.ended_at) ?? new Date().toISOString();
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
      .select("id, status, entity_id, is_test, metadata")
      .eq("id", subscription_id)
      .maybeSingle();

    if (subErr) {
      return json(
        500,
        { ok: false, error: "FAILED", details: subErr.message },
        req,
      );
    }

    if (!sub) {
      return json(404, { ok: false, error: "SUBSCRIPTION_NOT_FOUND" }, req);
    }

    const statusLower = String(sub.status ?? "").toLowerCase();

    // Idempotent: already cancelled
    if (statusLower === "cancelled") {
      return json(
        200,
        {
          ok: true,
          subscription_id: sub.id,
          status: "cancelled",
          note: "Subscription already cancelled (no action taken).",
        },
        req,
      );
    }

    // Guard: only allow cancelling from allowed states (registry-grade)
    const allowedFrom = new Set(["trialing", "active", "past_due", "paused"]);
    if (!allowedFrom.has(statusLower)) {
      return json(
        409,
        {
          ok: false,
          error: "INVALID_STATE",
          message: `Cannot cancel from status '${sub.status}'.`,
          allowed_from: Array.from(allowedFrom),
        },
        req,
      );
    }

    // Merge metadata (preserve history)
    const mergedMeta = {
      ...(sub.metadata ?? {}),
      cancel_reason: reason,
      cancelled_at: endedAt,
      cancelled_by: actor_id,
      cancelled_by_email: actor_email,
      trigger: body.trigger ?? null,
    };

    // Update subscription (NO 'ended' status — must be 'cancelled')
    const { error: updErr } = await svc
      .from("billing_subscriptions")
      .update({
        status: "cancelled",
        // keep both columns (schema has both ended_at + cancel_at)
        ended_at: endedAt,
        cancel_at: endedAt,
        updated_at: now,
        metadata: mergedMeta,
      })
      .eq("id", subscription_id);

    if (updErr) {
      return json(
        500,
        { ok: false, error: "FAILED", details: updErr.message },
        req,
      );
    }

    // -----------------------------
    // Best-effort audit (v2-safe; NEVER break the main action)
    // -----------------------------
    try {
      const { error: logErr } = await svc.from("actions_log").insert({
        actor_uid: actor_id,
        action: "BILLING_END_SUBSCRIPTION",
        target_table: "billing_subscriptions",
        target_id: subscription_id,
        details_json: {
          entity_id: sub.entity_id,
          is_test: sub.is_test,
          status_from: sub.status,
          status_to: "cancelled",
          ended_at: endedAt,
          reason,
          trigger: body.trigger ?? null,
        },
      });
      if (logErr) console.warn("audit insert failed:", logErr.message);
    } catch (e) {
      console.warn("audit insert threw:", e);
    }

    return json(
      200,
      {
        ok: true,
        subscription_id,
        status: "cancelled",
        ended_at: endedAt,
      },
      req,
    );
  } catch (e: any) {
    return json(
      500,
      { ok: false, error: "INTERNAL_ERROR", message: e?.message ?? String(e) },
      req,
    );
  }
});
