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

/** Resolve an existing Auth user id by email (service role). */
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

/**
 * Admissions → Provision Portal Access (Invite / Recovery)
 *
 * ✅ GUARANTEE: every click issues a FRESH link/token and sends it.
 * ✅ If user doesn't exist -> invite
 * ✅ If user exists -> recovery (fresh token)
 * ✅ Returns action_link for operator "Copy link" fallback.
 *
 * 🔒 IMPORTANT: DOES NOT call admissions_complete_provisioning.
 * Provisioning completion belongs to Set-Password flow (session-bound).
 */
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
      return json(400, {
        ok: false,
        error: "MISSING_APPLICATION_ID",
        hint: "Send application_id (or app_id / applicationId / p_application_id).",
      });
    }

    // Resolve email from application row if missing
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
          hint: "Provide applicant_email in payload OR ensure onboarding_applications.applicant_email is set.",
          application_id: applicationId,
        });
      }
    } else {
      // still try to fetch status (nice-to-have)
      const { data } = await supabase
        .from("onboarding_applications")
        .select("status")
        .eq("id", applicationId)
        .maybeSingle();
      applicationStatus = pickString(data?.status ?? null);
    }

    const email = applicantEmail.toLowerCase();
    const redirectTo = `${PORTAL_SET_PASSWORD_URL}?app_id=${encodeURIComponent(applicationId)}`;

    // Detect whether user already exists
    const existingUserId = await resolveUserIdByEmail(supabase, email);

    if (!existingUserId) {
      // 1) INVITE (fresh token) + action link fallback
      const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
        type: "invite",
        email,
        options: { redirectTo },
      });
      if (linkErr) throw linkErr;

      const { data: inviteData, error: inviteErr } = await supabase.auth.admin.inviteUserByEmail(email, {
        redirectTo,
      });
      if (inviteErr) {
        return json(400, {
          ok: false,
          error: "INVITE_FAILED",
          detail: inviteErr.message,
          application_id: applicationId,
          applicant_email: email,
        });
      }

      return json(200, {
        ok: true,
        mode: "invite",
        invited: true,
        email_sent: true,
        application_id: applicationId,
        application_status: applicationStatus,
        applicant_email: email,
        user_id: inviteData?.user?.id ?? null,
        redirectTo,
        action_link: linkData?.properties?.action_link ?? null,
      });
    }

    // 2) USER EXISTS → send RECOVERY (fresh token) + action link fallback
    const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
      type: "recovery",
      email,
      options: { redirectTo },
    });
    if (linkErr) throw linkErr;

    const { error: resetErr } = await supabase.auth.admin.resetPasswordForEmail(email, { redirectTo });
    if (resetErr) {
      return json(400, {
        ok: false,
        error: "RECOVERY_SEND_FAILED",
        detail: resetErr.message,
        application_id: applicationId,
        applicant_email: email,
        user_id: existingUserId,
      });
    }

    return json(200, {
      ok: true,
      mode: "recovery",
      already_registered: true,
      invited: false,
      email_sent: true,
      application_id: applicationId,
      application_status: applicationStatus,
      applicant_email: email,
      user_id: existingUserId,
      redirectTo,
      action_link: linkData?.properties?.action_link ?? null,
    });
  } catch (e) {
    return json(500, {
      ok: false,
      error: "UNHANDLED",
      detail: e instanceof Error ? e.message : String(e),
    });
  }
});
