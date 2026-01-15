/// <reference lib="deno.ns" />

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * admissions-provision-portal-access (FINAL — PRISTINE — NO REGRESSIONS)
 *
 * GUARANTEES:
 * ✅ Every click issues a FRESH link/token
 * ✅ New user → INVITE (email + action_link fallback)
 * ✅ Existing user → RECOVERY (email + action_link fallback)
 * ✅ If Supabase throttles recovery email, returns OK + cooldown + action_link
 * ✅ NEVER completes provisioning here (that happens in Set-Password flow once)
 *
 * NEW (NO-REGRESSION ADD):
 * ✅ Sets onboarding_applications.primary_contact_user_id (idempotent; only when NULL)
 *
 * CONTRACT:
 * - Accepts: application_id/app_id/applicationId/p_application_id/...
 * - Accepts: applicant_email/email/applicantEmail/p_applicant_email/...
 * - If email missing, resolves from onboarding_applications by application_id
 */

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

function mustEnv(name: string) {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`MISSING_ENV:${name}`);
  return v;
}

function pickString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length ? s : null;
}

async function resolveUserIdByEmail(
  supabase: ReturnType<typeof createClient>,
  email: string
): Promise<string | null> {
  const target = email.toLowerCase();
  let page = 1;
  const perPage = 200;

  for (let i = 0; i < 10; i++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;

    const users = data?.users ?? [];
    const hit = users.find((u) => (u.email ?? "").toLowerCase() === target);
    if (hit?.id) return hit.id;

    if (users.length < perPage) break;
    page += 1;
  }

  return null;
}

function parseRetryAfterSeconds(message: string): number {
  const m = message.match(/after\s+(\d+)\s+seconds/i);
  if (!m) return 60;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

/**
 * ✅ Idempotent bind:
 * Only sets primary_contact_user_id if it's currently NULL.
 * Never overwrites an existing binding (no regressions / no surprises).
 */
async function bindPrimaryContact(
  supabase: ReturnType<typeof createClient>,
  applicationId: string,
  userId: string
): Promise<{ bound: boolean; error?: string }> {
  try {
    // Gate by current state to avoid overwriting anything
    const { data: cur, error: curErr } = await supabase
      .from("onboarding_applications")
      .select("primary_contact_user_id")
      .eq("id", applicationId)
      .maybeSingle();

    if (curErr) return { bound: false, error: curErr.message };

    if (cur?.primary_contact_user_id) {
      return { bound: false }; // already bound; do nothing
    }

    const { error: upErr } = await supabase
      .from("onboarding_applications")
      .update({ primary_contact_user_id: userId })
      .eq("id", applicationId)
      .is("primary_contact_user_id", null);

    if (upErr) return { bound: false, error: upErr.message };

    return { bound: true };
  } catch (e) {
    return { bound: false, error: e instanceof Error ? e.message : String(e) };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "METHOD_NOT_ALLOWED" });

  try {
    const SUPABASE_URL = mustEnv("SUPABASE_URL");
    const SERVICE_ROLE_KEY = mustEnv("SUPABASE_SERVICE_ROLE_KEY");

    const PORTAL_SET_PASSWORD_URL =
      Deno.env.get("PORTAL_SET_PASSWORD_URL") ??
      "https://portal.oasisintlholdings.com/auth/set-password";

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    const applicationId =
      pickString(body.application_id) ??
      pickString(body.app_id) ??
      pickString(body.applicationId) ??
      pickString(body.p_application_id) ??
      pickString(body.pApplicationId) ??
      null;

    let applicantEmail =
      pickString(body.applicant_email) ??
      pickString(body.email) ??
      pickString(body.applicantEmail) ??
      pickString(body.p_applicant_email) ??
      pickString(body.pApplicantEmail) ??
      null;

    if (!applicationId) {
      return json(400, { ok: false, error: "MISSING_APPLICATION_ID" });
    }

    // Resolve email (and status as a nice-to-have) from onboarding_applications
    let applicationStatus: string | null = null;

    if (!applicantEmail) {
      const { data, error } = await supabase
        .from("onboarding_applications")
        .select("applicant_email,status")
        .eq("id", applicationId)
        .maybeSingle();

      if (error) {
        return json(400, {
          ok: false,
          error: "EMAIL_RESOLUTION_FAILED",
          detail: error.message,
          application_id: applicationId,
        });
      }

      applicantEmail = pickString(data?.applicant_email ?? null);
      applicationStatus = pickString(data?.status ?? null);

      if (!applicantEmail) {
        return json(400, {
          ok: false,
          error: "MISSING_APPLICANT_EMAIL",
          application_id: applicationId,
        });
      }
    } else {
      const { data } = await supabase
        .from("onboarding_applications")
        .select("status")
        .eq("id", applicationId)
        .maybeSingle();
      applicationStatus = pickString(data?.status ?? null);
    }

    const email = applicantEmail.toLowerCase();
    const redirectTo = `${PORTAL_SET_PASSWORD_URL}?app_id=${encodeURIComponent(applicationId)}`;

    // Determine whether Auth user exists
    const existingUserId = await resolveUserIdByEmail(supabase, email);

    // ---------------------------------------------------------------------
    // NEW USER → INVITE (fresh token)
    // ---------------------------------------------------------------------
    if (!existingUserId) {
      const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
        type: "invite",
        email,
        options: { redirectTo },
      });
      if (linkErr) throw linkErr;

      const { data: inviteData, error: inviteErr } = await supabase.auth.admin.inviteUserByEmail(
        email,
        { redirectTo }
      );

      if (inviteErr) {
        return json(400, {
          ok: false,
          error: "INVITE_FAILED",
          detail: inviteErr.message,
          application_id: applicationId,
          applicant_email: email,
        });
      }

      // ✅ Bind primary_contact_user_id (idempotent)
      let invitedUserId = inviteData?.user?.id ?? null;
      if (!invitedUserId) {
        // fallback (rare): resolve again by email
        invitedUserId = await resolveUserIdByEmail(supabase, email);
      }

      const bind =
        invitedUserId ? await bindPrimaryContact(supabase, applicationId, invitedUserId) : { bound: false, error: "USER_ID_NOT_RESOLVED" };

      return json(200, {
        ok: true,
        mode: "invite",
        invited: true,
        already_registered: false,
        email_sent: true,
        application_id: applicationId,
        application_status: applicationStatus,
        applicant_email: email,
        user_id: invitedUserId,
        redirectTo,
        action_link: linkData?.properties?.action_link ?? null,

        // NEW (non-breaking add)
        primary_contact_bound: Boolean(bind.bound),
        primary_contact_bind_error: bind.error ?? null,
      });
    }

    // ---------------------------------------------------------------------
    // EXISTING USER → RECOVERY (fresh token)
    // ---------------------------------------------------------------------
    const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
      type: "recovery",
      email,
      options: { redirectTo },
    });
    if (linkErr) throw linkErr;

    // ✅ Correct v2 API (NOT auth.admin)
    const { error: resetErr } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });

    // ✅ Bind primary_contact_user_id (idempotent) even if recovery email is rate-limited
    const bind = await bindPrimaryContact(supabase, applicationId, existingUserId);

    if (resetErr) {
      const msg = resetErr.message || "RECOVERY_SEND_FAILED";
      const lower = msg.toLowerCase();

      // ✅ Supabase throttle → treat as OK + cooldown + action_link fallback
      if (lower.includes("for security purposes") && lower.includes("only request this after")) {
        const retryAfter = parseRetryAfterSeconds(msg);

        return json(200, {
          ok: true,
          mode: "recovery",
          invited: false,
          already_registered: true,
          email_sent: false,
          rate_limited: true,
          retry_after_seconds: retryAfter,
          application_id: applicationId,
          application_status: applicationStatus,
          applicant_email: email,
          user_id: existingUserId,
          redirectTo,
          action_link: linkData?.properties?.action_link ?? null,
          note:
            "Recovery email throttled by Supabase. Wait for cooldown then retry, or use action_link as an operator fallback.",

          // NEW (non-breaking add)
          primary_contact_bound: Boolean(bind.bound),
          primary_contact_bind_error: bind.error ?? null,
        });
      }

      return json(400, {
        ok: false,
        error: "RECOVERY_SEND_FAILED",
        detail: msg,
        application_id: applicationId,
        applicant_email: email,
        user_id: existingUserId,

        // NEW (non-breaking add)
        primary_contact_bound: Boolean(bind.bound),
        primary_contact_bind_error: bind.error ?? null,
      });
    }

    return json(200, {
      ok: true,
      mode: "recovery",
      invited: false,
      already_registered: true,
      email_sent: true,
      rate_limited: false,
      application_id: applicationId,
      application_status: applicationStatus,
      applicant_email: email,
      user_id: existingUserId,
      redirectTo,
      action_link: linkData?.properties?.action_link ?? null,

      // NEW (non-breaking add)
      primary_contact_bound: Boolean(bind.bound),
      primary_contact_bind_error: bind.error ?? null,
    });
  } catch (e) {
    return json(500, {
      ok: false,
      error: "UNHANDLED",
      detail: e instanceof Error ? e.message : String(e),
    });
  }
});
