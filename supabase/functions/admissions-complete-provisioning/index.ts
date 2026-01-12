/// <reference lib="deno.ns" />

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isUuidLike(x: string) {
  const s = (x || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "METHOD_NOT_ALLOWED" });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";

    if (!SUPABASE_URL) return json(500, { ok: false, error: "MISSING_ENV:SUPABASE_URL" });
    if (!SERVICE_ROLE_KEY) return json(500, { ok: false, error: "MISSING_ENV:SUPABASE_SERVICE_ROLE_KEY" });
    if (!ANON_KEY) return json(500, { ok: false, error: "MISSING_ENV:SUPABASE_ANON_KEY" });

    // Require authenticated caller
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) {
      return json(401, { ok: false, error: "MISSING_AUTH" });
    }

    // Validate caller session (user becomes p_user_id)
    const caller = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });

    const { data: callerRes, error: callerErr } = await caller.auth.getUser();
    if (callerErr || !callerRes?.user?.id) return json(401, { ok: false, error: "INVALID_SESSION" });

    const user_id = callerRes.user.id;
    const caller_email = (callerRes.user.email || "").trim().toLowerCase();

    const body = await req.json().catch(() => ({}));

    // Accept app_id variants (defensive)
    let app_id = String(body?.app_id || body?.application_id || body?.p_application_id || "").trim();

    // ✅ Admin client MUST be explicit: apikey + Authorization = service_role
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
      global: {
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        },
      },
    });

    // 🔎 DIAGNOSTIC: prove service_role can read the table
    // If this returns 0 rows, your SERVICE_ROLE_KEY secret is wrong in Edge Function env.
    const diag = await admin.from("onboarding_applications").select("id").limit(1);
    if (diag.error) {
      return json(500, {
        ok: false,
        error: "SERVICE_ROLE_READ_FAILED",
        details: diag.error.message,
      });
    }

    // If missing app_id, resolve by caller email
    if (!app_id) {
      if (!caller_email) return json(400, { ok: false, error: "MISSING_APP_ID" });

      const { data: resolved, error: resErr } = await admin
        .from("onboarding_applications")
        .select("id")
        .eq("applicant_email", caller_email)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (resErr) return json(500, { ok: false, error: "APP_RESOLVE_FAILED", details: resErr.message });
      if (!resolved?.id) return json(404, { ok: false, error: "APP_NOT_FOUND_FOR_EMAIL", applicant_email: caller_email });

      app_id = resolved.id as string;
    }

    if (!isUuidLike(app_id)) return json(400, { ok: false, error: "BAD_APP_ID_FORMAT", app_id });

    // Load application (idempotency + state gate)
    const { data: app, error: appErr } = await admin
      .from("onboarding_applications")
      .select("id, status, provisioned_at, entity_id, entity_slug, applicant_email")
      .eq("id", app_id)
      .maybeSingle();

    if (appErr) return json(500, { ok: false, error: "APP_LOOKUP_FAILED", details: appErr.message });

    if (!app) {
      // Add extra debug: show that the id exists check failed
      return json(404, { ok: false, error: "APP_NOT_FOUND", app_id });
    }

    // Safety: ensure session email matches applicant_email
    const appEmail = (app.applicant_email || "").trim().toLowerCase();
    if (appEmail && caller_email && appEmail !== caller_email) {
      return json(403, { ok: false, error: "EMAIL_MISMATCH", applicant_email: appEmail, session_email: caller_email });
    }

    // Idempotency: already provisioned
    if (app.provisioned_at) {
      return json(200, {
        ok: true,
        already: true,
        app_id,
        status: app.status,
        provisioned_at: app.provisioned_at,
        entity_id: app.entity_id,
        entity_slug: app.entity_slug,
        user_id,
      });
    }

    // Gate: must be APPROVED or PROVISIONING (enum values are uppercase)
    const st = String(app.status || "").toUpperCase();
    if (st !== "PROVISIONING" && st !== "APPROVED") {
      return json(409, { ok: false, error: "BAD_STATE", status: app.status });
    }

    // Execute canonical provisioning RPC
    const { data: rpcData, error: rpcErr } = await admin.rpc("admissions_complete_provisioning", {
      p_application_id: app_id,
      p_user_id: user_id,
    });

    if (rpcErr) return json(500, { ok: false, error: "PROVISIONING_RPC_FAILED", details: rpcErr.message });

    return json(200, { ok: true, app_id, user_id, result: rpcData ?? null });
  } catch (e) {
    return json(500, { ok: false, error: "UNHANDLED", details: String((e as any)?.message ?? e) });
  }
});
