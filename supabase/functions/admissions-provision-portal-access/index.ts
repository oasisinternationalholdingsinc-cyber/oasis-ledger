/// <reference lib="deno.ns" />

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PORTAL_CALLBACK_URL = "https://portal.oasisintlholdings.com/auth/callback";
const PORTAL_RESET_URL = "https://portal.oasisintlholdings.com/auth/set-password";

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

function isAlreadyExistsError(msg: string) {
  const m = (msg || "").toLowerCase();
  return (
    m.includes("already registered") ||
    m.includes("already exists") ||
    m.includes("user already exists") ||
    m.includes("registered") ||
    m.includes("exists")
  );
}

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  if (req.method !== "POST") {
    return json(405, { ok: false, error: "METHOD_NOT_ALLOWED" });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false },
    });

    // Keep auth header pass-through if you want auditing later
    const authHeader = req.headers.get("Authorization") || "";

    const payload = await req.json().catch(() => ({}));
    const application_id = payload?.application_id as string | undefined;

    if (!application_id) {
      return json(400, { ok: false, error: "MISSING_APPLICATION_ID" });
    }

    // 1) Load application
    const { data: app, error: appErr } = await admin
      .from("onboarding_applications")
      .select("id, applicant_email, organization_legal_name, status")
      .eq("id", application_id)
      .maybeSingle();

    if (appErr) return json(500, { ok: false, error: "APP_LOAD_FAILED", details: appErr.message });
    if (!app) return json(404, { ok: false, error: "APP_NOT_FOUND" });

    const email = (app.applicant_email || "").trim().toLowerCase();
    if (!email) return json(400, { ok: false, error: "MISSING_APPLICANT_EMAIL" });

    // 2) Always attempt to send an email you can test.
    //    - If user is new: send invite -> lands on Portal /auth/callback
    //    - If user exists: send password reset -> lands on Portal /auth/set-password
    let mode: "INVITE" | "RESET" = "INVITE";
    let invitedUserId: string | null = null;

    const { data: inviteRes, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo: PORTAL_CALLBACK_URL,
    });

    if (inviteErr) {
      const msg = String(inviteErr.message || inviteErr);

      if (isAlreadyExistsError(msg)) {
        mode = "RESET";
        const { error: resetErr } = await admin.auth.resetPasswordForEmail(email, {
          redirectTo: PORTAL_RESET_URL,
        });

        if (resetErr) {
          return json(500, { ok: false, error: "RESET_FAILED", details: resetErr.message });
        }
      } else {
        return json(500, { ok: false, error: "INVITE_FAILED", details: msg });
      }
    } else {
      invitedUserId = inviteRes?.user?.id || null;
    }

    // 3) Update provisioning task (ALLOW RE-RUNS: never gate on current status)
    //    - increments attempts every time
    //    - keeps status PENDING so you can keep hitting "RUN INVITE"
    //    - records last result
    const now = new Date().toISOString();

    // Read existing attempts (safe even if row doesn't exist)
    const { data: taskRow } = await admin
      .from("onboarding_provisioning_tasks")
      .select("id, attempts")
      .eq("application_id", application_id)
      .eq("task_key", "portal_access")
      .maybeSingle();

    const attempts = (taskRow?.attempts ?? 0) + 1;

    await admin
      .from("onboarding_provisioning_tasks")
      .upsert(
        {
          application_id,
          task_key: "portal_access",
          status: "pending", // keep pending while you're testing
          attempts,
          last_attempt_at: now,
          result: { mode, invited_user_id: invitedUserId, email, redirect: mode === "INVITE" ? PORTAL_CALLBACK_URL : PORTAL_RESET_URL },
        },
        { onConflict: "application_id,task_key" }
      );

    // 4) Add an onboarding event (every run)
    await admin.from("onboarding_events").insert({
      application_id,
      event_type: "PROVISION_PORTAL_ACCESS",
      message:
        mode === "INVITE"
          ? `Invite email sent to ${email}`
          : `Password reset email sent to ${email}`,
      metadata: { mode, invited_user_id: invitedUserId, attempts, redirect: mode === "INVITE" ? PORTAL_CALLBACK_URL : PORTAL_RESET_URL },
    });

    return json(200, {
      ok: true,
      application_id,
      email,
      mode,
      invited_user_id: invitedUserId,
      attempts,
      redirect: mode === "INVITE" ? PORTAL_CALLBACK_URL : PORTAL_RESET_URL,
    });
  } catch (e) {
    return json(500, { ok: false, error: "UNHANDLED", details: String((e as any)?.message ?? e) });
  }
});
