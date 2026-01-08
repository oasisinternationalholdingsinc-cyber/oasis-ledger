/// <reference lib="deno.ns" />
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
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

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return json(500, { ok: false, error: "MISSING_ENV" });
    }

    // Require an authenticated caller (operator). We don't use their identity for writes,
    // but we *do* require auth so this can't be invoked anonymously.
    const authHeader = req.headers.get("authorization") || "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) {
      return json(401, { ok: false, error: "MISSING_AUTH" });
    }

    const operatorClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });

    const { data: operatorUserRes, error: operatorErr } = await operatorClient.auth.getUser();
    if (operatorErr || !operatorUserRes?.user?.id) {
      return json(401, { ok: false, error: "INVALID_SESSION" });
    }

    const body = await req.json().catch(() => ({}));
    const app_id = String(body?.app_id || "").trim();
    if (!app_id) return json(400, { ok: false, error: "MISSING_APP_ID" });

    // Service role client for DB + auth lookup
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // Load application
    const { data: app, error: appErr } = await admin
      .from("onboarding_applications")
      .select(
        "id, status, provisioned_at, applicant_email, organization_legal_name, entity_id, entity_slug"
      )
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
      });
    }

    // Gate: must be in provisioning or approved (match your workflow)
    const status = String(app.status || "").toLowerCase();
    if (status !== "provisioning" && status !== "approved") {
      return json(409, { ok: false, error: "BAD_STATE", status: app.status });
    }

    const email = String(app.applicant_email || "").trim().toLowerCase();
    if (!email) return json(409, { ok: false, error: "MISSING_APPLICANT_EMAIL" });

    // Resolve invited user by email
    // NOTE: auth schema is accessible with service role in SQL via auth.users
    const { data: userRow, error: userErr } = await admin
      .from("auth_users_view")
      .select("id, email") // we'll create this view below if you don't already have one
      .eq("email", email)
      .maybeSingle();

    if (userErr) {
      return json(500, { ok: false, error: "AUTH_LOOKUP_FAILED", details: userErr.message });
    }

    if (!userRow?.id) {
      // User hasn't set password / accepted invite yet
      return json(409, {
        ok: false,
        error: "USER_NOT_READY",
        message: "No auth user found for applicant_email. Invite may not be completed yet.",
        applicant_email: email,
      });
    }

    const user_id = userRow.id as string;

    // Execute canonical provisioning function (no duplicates, idempotent inside DB)
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
    return json(500, { ok: false, error: "UNHANDLED", details: String(e?.message || e) });
  }
});
