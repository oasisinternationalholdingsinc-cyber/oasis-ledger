/// <reference lib="deno.ns" />

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PORTAL_CALLBACK_URL = "https://portal.oasisintlholdings.com/auth/callback";

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

function withAppId(base: string, appId: string) {
  const u = new URL(base);
  u.searchParams.set("app_id", appId);
  return u.toString();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false },
    });

    // 🔒 Require operator auth
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json(401, { ok: false, error: "MISSING_AUTH" });
    }

    const operator = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });

    const { data: who } = await operator.auth.getUser();
    if (!who?.user?.id) {
      return json(401, { ok: false, error: "INVALID_SESSION" });
    }

    const { application_id } = await req.json();
    if (!application_id) {
      return json(400, { ok: false, error: "MISSING_APPLICATION_ID" });
    }

    // Load application
    const { data: app } = await admin
      .from("onboarding_applications")
      .select("id, applicant_email")
      .eq("id", application_id)
      .single();

    const email = app.applicant_email.toLowerCase();
    const redirectTo = withAppId(PORTAL_CALLBACK_URL, application_id);

    // 🔥 THIS IS THE FIX: generate tokenized link ourselves
    const { data, error } = await admin.auth.admin.generateLink({
      type: "invite",
      email,
      options: { redirectTo },
    });

    if (error || !data?.properties?.action_link) {
      return json(500, { ok: false, error: "LINK_GENERATION_FAILED" });
    }

    const action_link = data.properties.action_link;

    // Persist for audit + retry
    await admin.from("onboarding_provisioning_tasks").upsert(
      {
        application_id,
        task_key: "provision_portal_access",
        status: "pending",
        result: {
          email,
          action_link,
          redirectTo,
        },
      },
      { onConflict: "application_id,task_key" }
    );

    await admin.from("onboarding_events").insert({
      application_id,
      event_type: "PROVISION_PORTAL_ACCESS",
      message: `Portal access link generated for ${email}`,
      metadata: { action_link },
    });

    // ✅ RETURN THE ONLY LINK THAT MATTERS
    return json(200, {
      ok: true,
      email,
      action_link,
    });
  } catch (e) {
    return json(500, {
      ok: false,
      error: "UNHANDLED",
      details: String(e),
    });
  }
});
