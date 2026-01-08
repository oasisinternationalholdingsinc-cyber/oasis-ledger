// supabase/functions/admissions-provision-portal-access/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function corsHeaders(origin: string | null) {
  // keep permissive for now; you can tighten to your console domain later
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(origin) });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Authenticated caller (operator) token — for audit/event attribution if you want later
    const authHeader = req.headers.get("Authorization") ?? "";

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const supabaseAuthed = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const body = await req.json().catch(() => ({}));
    const application_id = body?.application_id as string | undefined;
    const task_key = (body?.task_key as string | undefined) ?? "provision_portal_access";

    if (!application_id) {
      return new Response(JSON.stringify({ ok: false, error: "Missing application_id" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    // Who is calling (must be logged in)
    const { data: me, error: meErr } = await supabaseAuthed.auth.getUser();
    if (meErr || !me?.user?.id) {
      return new Response(JSON.stringify({ ok: false, error: "Not authenticated" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    // Load application
    const { data: app, error: appErr } = await supabaseAdmin
      .from("onboarding_applications")
      .select("id, applicant_email, organization_legal_name, status")
      .eq("id", application_id)
      .maybeSingle();

    if (appErr || !app) {
      return new Response(JSON.stringify({ ok: false, error: "Application not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    if (!app.applicant_email) {
      return new Response(JSON.stringify({ ok: false, error: "Application missing applicant_email" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    // Find the task row (latest for that app + task_key)
    const { data: taskRow, error: taskErr } = await supabaseAdmin
      .from("onboarding_provisioning_tasks")
      .select("id, status, attempts")
      .eq("application_id", application_id)
      .eq("task_key", task_key)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (taskErr || !taskRow?.id) {
      return new Response(JSON.stringify({ ok: false, error: `Task not found: ${task_key}` }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    // Attempt counter
    const nextAttempts = (taskRow.attempts ?? 0) + 1;

    // Send invite
    const inviteRes = await supabaseAdmin.auth.admin.inviteUserByEmail(app.applicant_email, {
      data: {
        onboarding_application_id: application_id,
        organization_legal_name: app.organization_legal_name ?? null,
      },
      // IMPORTANT: set this to your portal URL route that handles invite acceptance
      // e.g. https://portal.oasisintlholdings.com/auth/callback
      redirectTo: "https://portal.oasisintlholdings.com/auth/callback",
    });

    if (inviteRes.error) {
      await supabaseAdmin
        .from("onboarding_provisioning_tasks")
        .update({
          status: "FAILED",
          attempts: nextAttempts,
          last_error: inviteRes.error.message,
          updated_at: new Date().toISOString(),
        })
        .eq("id", taskRow.id);

      return new Response(JSON.stringify({ ok: false, error: inviteRes.error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    // Mark task SENT and record result payload (audit)
    await supabaseAdmin
      .from("onboarding_provisioning_tasks")
      .update({
        status: "SENT",
        attempts: nextAttempts,
        last_error: null,
        result: {
          kind: "auth_invite_sent",
          email: app.applicant_email,
          invited_user_id: inviteRes.data?.user?.id ?? null,
          sent_at: new Date().toISOString(),
        },
        updated_at: new Date().toISOString(),
      })
      .eq("id", taskRow.id);

    // Log event (uses your existing RPC)
    await supabaseAdmin.rpc("admissions_log_event", {
      p_application_id: application_id,
      p_type: "PORTAL_INVITE_SENT",
      p_message: `Auth invite sent to ${app.applicant_email}`,
      p_metadata: {
        task_key,
        email: app.applicant_email,
        invited_user_id: inviteRes.data?.user?.id ?? null,
        operator_id: me.user.id,
      },
    });

    return new Response(
      JSON.stringify({
        ok: true,
        application_id,
        task_key,
        email: app.applicant_email,
        invited_user_id: inviteRes.data?.user?.id ?? null,
      }),
      { headers: { "Content-Type": "application/json", ...corsHeaders(origin) } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e?.message ?? e) }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  }
});
