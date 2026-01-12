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

  // listUsers is paginated; we scan a few pages safely (enterprise but simple).
  // If you ever have huge user counts, we can tighten this later.
  let page = 1;
  const perPage = 200;

  for (let i = 0; i < 10; i++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;

    const users = data?.users ?? [];
    const hit = users.find((u) => (u.email ?? "").toLowerCase() === target);
    if (hit?.id) return hit.id;

    if (users.length < perPage) break; // no more pages
    page += 1;
  }

  return null;
}

/**
 * Admissions → Provision Portal Access (Invite)
 * - Accepts flexible payload keys (no regressions)
 * - If applicant_email missing, resolves from onboarding_applications by application_id
 * - Idempotent: "already registered" treated as OK
 * - ✅ Enterprise: ALWAYS completes provisioning (membership + linkage) via admissions_complete_provisioning
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

    const email = applicantEmail.toLowerCase();
    const redirectTo = `${PORTAL_SET_PASSWORD_URL}?app_id=${encodeURIComponent(applicationId)}`;

    // 1) Invite (or detect already-registered)
    const { data: inviteData, error: inviteErr } = await supabase.auth.admin.inviteUserByEmail(email, {
      redirectTo,
    });

    // 2) Determine user_id reliably
    let userId: string | null = inviteData?.user?.id ?? null;

    if (inviteErr) {
      const msg = inviteErr.message || "INVITE_FAILED";
      const lower = msg.toLowerCase();

      // ✅ Idempotency: treat "already registered" as success…
      // ✅ …BUT enterprise requires we still complete provisioning.
      if (lower.includes("already registered") || lower.includes("already exists")) {
        userId = await resolveUserIdByEmail(supabase, email);
        if (!userId) {
          return json(500, {
            ok: false,
            error: "USER_RESOLUTION_FAILED",
            detail: "User exists but could not be resolved by email.",
            application_id: applicationId,
            applicant_email: email,
          });
        }

        const { data: rpcData, error: rpcErr } = await supabase.rpc("admissions_complete_provisioning", {
          p_application_id: applicationId,
          p_user_id: userId,
        });

        if (rpcErr) {
          return json(500, {
            ok: false,
            error: "COMPLETE_PROVISIONING_FAILED",
            detail: rpcErr.message,
            application_id: applicationId,
            applicant_email: email,
            user_id: userId,
          });
        }

        return json(200, {
          ok: true,
          invited: false,
          already_registered: true,
          provisioned: true,
          mode: "existing_user",
          application_id: applicationId,
          applicant_email: email,
          redirectTo,
          user_id: userId,
          result: rpcData ?? null,
        });
      }

      return json(400, {
        ok: false,
        error: "INVITE_FAILED",
        detail: msg,
        application_id: applicationId,
        applicant_email: email,
      });
    }

    // If invite succeeded but user_id missing (rare), resolve it.
    if (!userId) {
      userId = await resolveUserIdByEmail(supabase, email);
    }
    if (!userId) {
      return json(500, {
        ok: false,
        error: "USER_RESOLUTION_FAILED",
        detail: "Invite succeeded but user_id could not be resolved.",
        application_id: applicationId,
        applicant_email: email,
      });
    }

    // 3) Always complete provisioning (creates membership + bindings idempotently)
    const { data: rpcData, error: rpcErr } = await supabase.rpc("admissions_complete_provisioning", {
      p_application_id: applicationId,
      p_user_id: userId,
    });

    if (rpcErr) {
      return json(500, {
        ok: false,
        error: "COMPLETE_PROVISIONING_FAILED",
        detail: rpcErr.message,
        application_id: applicationId,
        applicant_email: email,
        user_id: userId,
      });
    }

    return json(200, {
      ok: true,
      invited: true,
      provisioned: true,
      mode: "invited_user",
      application_id: applicationId,
      applicant_email: email,
      redirectTo,
      user_id: userId,
      result: rpcData ?? null,
    });
  } catch (e) {
    return json(500, {
      ok: false,
      error: "UNHANDLED",
      detail: e instanceof Error ? e.message : String(e),
    });
  }
});
