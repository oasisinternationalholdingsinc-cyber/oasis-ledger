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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "METHOD_NOT_ALLOWED" });

  try {
    const SUPABASE_URL = mustEnv("SUPABASE_URL");
    const SERVICE_ROLE_KEY = mustEnv("SUPABASE_SERVICE_ROLE_KEY");

    // Your public portal URLs (must match Supabase Auth settings)
    const PORTAL_SET_PASSWORD_URL =
      Deno.env.get("PORTAL_SET_PASSWORD_URL") ?? "https://portal.oasisintlholdings.com/auth/set-password";

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const body = await req.json().catch(() => ({}));
    const application_id = String(body?.application_id ?? "");
    const applicant_email = String(body?.applicant_email ?? "");

    if (!application_id) return json(400, { ok: false, error: "MISSING_APPLICATION_ID" });
    if (!applicant_email) return json(400, { ok: false, error: "MISSING_APPLICANT_EMAIL" });

    // Redirect target (app_id appended)
    const redirectTo = `${PORTAL_SET_PASSWORD_URL}?app_id=${encodeURIComponent(application_id)}`;

    // Send invite
    const { data, error } = await supabase.auth.admin.inviteUserByEmail(applicant_email, { redirectTo });

    if (error) {
      return json(400, { ok: false, error: "INVITE_FAILED", detail: error.message });
    }

    // Optional: you can log into onboarding_events here if you want.
    // Keep it minimal to avoid regressions.

    return json(200, {
      ok: true,
      invited: true,
      application_id,
      applicant_email,
      redirectTo,
      user_id: data?.user?.id ?? null,
    });
  } catch (e) {
    return json(500, {
      ok: false,
      error: "UNHANDLED",
      detail: e instanceof Error ? e.message : String(e),
    });
  }
});
