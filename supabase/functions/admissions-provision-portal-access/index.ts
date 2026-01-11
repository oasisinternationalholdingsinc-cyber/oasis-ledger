// supabase/functions/admissions-provision-portal-access/index.ts
/// <reference lib="deno.ns" />

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PORTAL_CALLBACK_URL = "https://portal.oasisintlholdings.com/auth/callback";
const PORTAL_RESET_URL = "https://portal.oasisintlholdings.com/auth/set-password";

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

/** Append app_id to a base URL (safe if URL already has query params). */
function withAppId(base: string, appId: string) {
  const u = new URL(base);
  u.searchParams.set("app_id", appId);
  return u.toString();
}

/**
 * Fallback: generate a tokenized Supabase action_link (INVITE/RECOVERY).
 * This does NOT replace your existing email send; it gives you a guaranteed working link
 * in the function response + task metadata in case templates/clients strip params.
 */
async function tryGenerateActionLink(args: {
  admin: ReturnType<typeof createClient>;
  type: "invite" | "recovery";
  email: string;
  redirectTo: string;
}): Promise<string | null> {
  try {
    const { data, error } = await args.admin.auth.admin.generateLink({
      type: args.type,
      email: args.email,
      options: { redirectTo: args.redirectTo },
    });
    if (error) return null;
    return (data as any)?.properties?.action_link ?? null;
  } catch {
    return null;
  }
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
    if (!supabaseUrl || !serviceRole) {
      return json(500, { ok: false, error: "MISSING_ENV" });
    }

    const admin = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false },
    });

    // Require an authenticated caller (operator). Prevent anonymous execution.
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) {
      return json(401, { ok: false, error: "MISSING_AUTH" });
    }

    // (Optional) validate session (keeps it operator-only even though we write via service role)
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    if (anonKey) {
      const operatorClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false },
      });
      const { data: who, error: whoErr } = await operatorClient.auth.getUser();
      if (whoErr || !who?.user?.id) {
        return json(401, { ok: false, error: "INVALID_SESSION" });
      }
    }

    const payload = await req.json().catch(() => ({}));
    const application_id = String(payload?.application_id || payload?.app_id || "").trim();
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

    const email = String(app.applicant_email || "").trim().toLowerCase();
    if (!email) return json(400, { ok: false, error: "MISSING_APPLICANT_EMAIL" });

    // ✅ IMPORTANT: always carry app_id to portal
    const inviteRedirect = withAppId(PORTAL_CALLBACK_URL, application_id);
    const resetRedirect = withAppId(PORTAL_RESET_URL, application_id);

    // 2) Send invite; if user exists, send reset
    let mode: "INVITE" | "RESET" = "INVITE";
    let invitedUserId: string | null = null;

    // Fallback link (tokenized) in case email templates/clients strip auth params
    let action_link: string | null = null;

    const { data: inviteRes, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo: inviteRedirect,
    });

    if (inviteErr) {
      const msg = String(inviteErr.message || inviteErr);

      if (isAlreadyExistsError(msg)) {
        mode = "RESET";
        const { error: resetErr } = await admin.auth.resetPasswordForEmail(email, {
          redirectTo: resetRedirect,
        });

        if (resetErr) {
          return json(500, { ok: false, error: "RESET_FAILED", details: resetErr.message });
        }

        // Tokenized fallback link for recovery
        action_link = await tryGenerateActionLink({
          admin,
          type: "recovery",
          email,
          redirectTo: resetRedirect,
        });
      } else {
        return json(500, { ok: false, error: "INVITE_FAILED", details: msg });
      }
    } else {
      invitedUserId = inviteRes?.user?.id || null;

      // Tokenized fallback link for invite
      action_link = await tryGenerateActionLink({
        admin,
        type: "invite",
        email,
        redirectTo: inviteRedirect,
      });
    }

    // 3) Update provisioning task (ALLOW RE-RUNS)
    // Align task_key to your UI: "provision_portal_access"
    const now = new Date().toISOString();

    const { data: taskRow } = await admin
      .from("onboarding_provisioning_tasks")
      .select("id, attempts")
      .eq("application_id", application_id)
      .eq("task_key", "provision_portal_access")
      .maybeSingle();

    const attempts = (taskRow?.attempts ?? 0) + 1;

    await admin
      .from("onboarding_provisioning_tasks")
      .upsert(
        {
          application_id,
          task_key: "provision_portal_access",
          status: "pending", // keep pending while you test "RUN INVITE"
          attempts,
          last_attempt_at: now,
          result: {
            mode,
            invited_user_id: invitedUserId,
            email,
            redirect: mode === "INVITE" ? inviteRedirect : resetRedirect,
            // ✅ fallback tokenized link (if present)
            action_link,
          },
        },
        { onConflict: "application_id,task_key" },
      );

    // 4) Add an onboarding event (every run)
    await admin.from("onboarding_events").insert({
      application_id,
      event_type: "PROVISION_PORTAL_ACCESS",
      message:
        mode === "INVITE"
          ? `Invite email sent to ${email}`
          : `Password reset email sent to ${email}`,
      metadata: {
        mode,
        invited_user_id: invitedUserId,
        attempts,
        redirect: mode === "INVITE" ? inviteRedirect : resetRedirect,
        action_link,
      },
    });

    return json(200, {
      ok: true,
      application_id,
      email,
      mode,
      invited_user_id: invitedUserId,
      attempts,
      redirect: mode === "INVITE" ? inviteRedirect : resetRedirect,
      // ✅ if your email client/template strips params, use this link directly
      action_link,
    });
  } catch (e) {
    return json(500, {
      ok: false,
      error: "UNHANDLED",
      details: String((e as any)?.message ?? e),
    });
  }
});
