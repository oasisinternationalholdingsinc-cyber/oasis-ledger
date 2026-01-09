// supabase/functions/admissions-complete-provisioning/index.ts
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "METHOD_NOT_ALLOWED" });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return json(500, { ok: false, error: "MISSING_ENV" });
    }

    // Require an authenticated caller (the invited user, after accepting invite / reset).
    const authHeader = req.headers.get("authorization") || "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) {
      return json(401, { ok: false, error: "MISSING_AUTH" });
    }
    if (!ANON_KEY) {
      return json(500, { ok: false, error: "MISSING_ANON_KEY" });
    }

    // Validate caller session (this user becomes p_user_id)
    const caller = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });

    const { data: callerRes, error: callerErr } = await caller.auth.getUser();
    if (callerErr || !callerRes?.user?.id) {
      return json(401, { ok: false, error: "INVALID_SESSION" });
    }
    const user_id = callerRes.user.id;

    const body = await req.json().catch(() => ({}));
    const app_id = String(body?.app_id || body?.application_id || "").trim();
    if (!app_id) return json(400, { ok: false, error: "MISSING_APP_ID" });

    // Service role client for DB operations
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // Load application (idempotency + state gate)
    const { data: app, error: appErr } = await admin
      .from("onboarding_applications")
      .select("id, status, provisioned_at, entity_id, entity_slug, applicant_email")
      .eq("id", app_id)
      .maybeSingle();

    if (appErr) return json(500, { ok: false, error: "APP_LOOKUP_FAILED", details: appErr.message });
    if (!app) return json(404, { ok: false, error: "APP_NOT_FOUND" });

    // Idempotency guard: already provisioned
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

    // Gate: must be approved/provisioning (match your workflow)
    const st = String(app.status || "").toLowerCase();
    if (st !== "provisioning" && st !== "approved" && st !== "provisioned") {
      return json(409, { ok: false, error: "BAD_STATE", status: app.status });
    }

    // Execute canonical provisioning function (DB handles dedupe/idempotency)
    const { data: rpcData, error: rpcErr } = await admin.rpc("admissions_complete_provisioning", {
      p_application_id: app_id,
      p_user_id: user_id,
    });

    if (rpcErr) {
      return json(500, { ok: false, error: "PROVISIONING_RPC_FAILED", details: rpcErr.message });
    }

    return json(200, {
      ok: true,
      app_id,
      user_id,
      result: rpcData ?? null,
    });
  } catch (e) {
    return json(500, { ok: false, error: "UNHANDLED", details: String((e as any)?.message ?? e) });
  }
});
