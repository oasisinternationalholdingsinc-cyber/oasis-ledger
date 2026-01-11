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

/**
 * Admissions → Provision Portal Access (Invite)
 * - Accepts flexible payload keys (no regressions)
 * - If applicant_email missing, resolves from onboarding_applications by application_id
 * - Idempotent: "already registered" treated as OK (no hard failure)
 * - Redirect target: portal set-password with app_id
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

    // ✅ Accept many possible shapes (UI / RPC / client variations)
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

    // ✅ If email not provided, resolve from onboarding_applications
    if (!applicantEmail) {
      const { data, error } = await supabase
        .from("onboarding_applications")
        .select("applicant_email")
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

      if (!applicantEmail) {
        return json(400, {
          ok: false,
          error: "MISSING_APPLICANT_EMAIL",
          hint: "Provide applicant_email in payload OR ensure onboarding_applications.applicant_email is set.",
          application_id: applicationId,
        });
      }
    }

    const redirectTo = `${PORTAL_SET_PASSWORD_URL}?app_id=${encodeURIComponent(applicationId)}`;

    const { data: inviteData, error: inviteErr } = await supabase.auth.admin.inviteUserByEmail(
      applicantEmail,
      { redirectTo }
    );

    // ✅ Idempotency: treat "already registered" as success (do not break console UX)
    if (inviteErr) {
      const msg = inviteErr.message || "INVITE_FAILED";
      const lower = msg.toLowerCase();

      if (lower.includes("already registered") || lower.includes("already exists")) {
        return json(200, {
          ok: true,
          invited: false,
          already_registered: true,
          application_id: applicationId,
          applicant_email: applicantEmail,
          redirectTo,
        });
      }

      return json(400, {
        ok: false,
        error: "INVITE_FAILED",
        detail: msg,
        application_id: applicationId,
        applicant_email: applicantEmail,
      });
    }

    return json(200, {
      ok: true,
      invited: true,
      application_id: applicationId,
      applicant_email: applicantEmail,
      redirectTo,
      user_id: inviteData?.user?.id ?? null,
    });
  } catch (e) {
    return json(500, {
      ok: false,
      error: "UNHANDLED",
      detail: e instanceof Error ? e.message : String(e),
    });
  }
});
