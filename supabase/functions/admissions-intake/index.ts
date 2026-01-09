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

function clean(s: unknown) {
  return typeof s === "string" ? s.trim() : "";
}

function cleanEmail(s: unknown) {
  const v = clean(s);
  return v ? v.toLowerCase() : "";
}

// Canonical Admissions Authority (HOLDINGS)
const HOLDINGS_ENTITY_ID = "7db05f98-dd93-4fa1-a81b-67c159253327";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "METHOD_NOT_ALLOWED" });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return json(500, { ok: false, error: "MISSING_ENV", message: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing" });
    }

    // Service-role client (bypasses RLS safely)
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const body = await req.json().catch(() => ({}));
    const payload = (body && typeof body === "object" && "payload" in body) ? (body as any).payload : body;

    // REQUIRED CORE (do not change contract)
    const organization_legal_name = clean(payload?.organization_legal_name);
    const applicant_email = cleanEmail(payload?.applicant_email);
    const intent = clean(payload?.intent);

    if (!organization_legal_name) return json(400, { ok: false, error: "VALIDATION", message: "Legal name is required." });
    if (!applicant_email) return json(400, { ok: false, error: "VALIDATION", message: "Contact email is required." });
    if (!intent) return json(400, { ok: false, error: "VALIDATION", message: "Request is required." });

    // Optional (never blocks)
    const applicant_name = clean(payload?.applicant_name) || organization_legal_name || applicant_email;
    const applicant_phone = clean(payload?.applicant_phone);

    const organization_trade_name = clean(payload?.organization_trade_name) || null;
    const website = clean(payload?.website) || null;
    const incorporation_number = clean(payload?.incorporation_number) || null;
    const jurisdiction_country = clean(payload?.jurisdiction_country) || null;
    const jurisdiction_region = clean(payload?.jurisdiction_region) || null;

    const expected_start_date = clean(payload?.expected_start_date) || null;
    const requested_services = Array.isArray(payload?.requested_services) && payload.requested_services.length
      ? payload.requested_services
      : null;

    // Metadata is safe/auditable (pass-through)
    const metadata = (payload?.metadata && typeof payload.metadata === "object") ? payload.metadata : {};

    // Enforce canonical authority entity (do NOT accept caller override)
    const row = {
      entity_id: HOLDINGS_ENTITY_ID,

      applicant_type: "organization",
      applicant_name,
      applicant_email,
      applicant_phone: applicant_phone || null,

      organization_legal_name,
      organization_trade_name,
      website,
      incorporation_number,
      jurisdiction_country,
      jurisdiction_region,

      intent,

      requested_services,
      expected_start_date,

      status: "submitted",
      submitted_at: new Date().toISOString(),

      metadata,
    };

    const { data, error } = await admin
      .from("onboarding_applications")
      .insert(row)
      .select("id")
      .single();

    if (error) {
      return json(400, {
        ok: false,
        error: error.code ?? "INSERT_FAILED",
        message: error.message ?? "Unable to submit.",
        details: error.details ?? null,
        hint: error.hint ?? null,
      });
    }

    return json(200, {
      ok: true,
      application_id: data?.id ?? null,
      message: "Request received. You will be contacted after review.",
    });
  } catch (e) {
    return json(500, { ok: false, error: "UNHANDLED", message: String((e as any)?.message ?? e) });
  }
});
