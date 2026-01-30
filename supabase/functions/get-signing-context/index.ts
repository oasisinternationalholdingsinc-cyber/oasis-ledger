// supabase/functions/get-signing-context/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

// Optional: allow overriding which bucket the envelope PDF lives in.
// Default matches your current implementation.
const SIGNING_BUCKET = Deno.env.get("SIGNING_BUCKET") ?? "minute_book";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, apikey, x-client-info",
  };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

function safeStr(v: unknown) {
  return String(v ?? "").trim();
}

// -----------------------------------------------------------------------------
// Types (best-effort, keep response shape unchanged)
// -----------------------------------------------------------------------------
type EnvelopeRow = {
  id: string;
  title?: string | null;
  status?: string | null;
  entity_id?: string | null;
  record_id?: string | null;
  metadata?: any;
  supporting_document_path?: string | null;
  // optional future-proof:
  supporting_document_bucket?: string | null;
};

type PartyRow = {
  id: string;
  signatory_id?: string | null;
  email?: string | null;
  display_name?: string | null;
  role?: string | null;
  status?: string | null;
  signing_order?: number | null;
  party_token?: string | null;
};

type EntityRow = { id: string; slug?: string | null; name?: string | null };

type LedgerRow = {
  id: string;
  title?: string | null;
  body?: string | null;
  entity_id?: string | null;
};

// -----------------------------------------------------------------------------
// Best-effort selects (NO REGRESSION: tolerate missing optional columns)
// -----------------------------------------------------------------------------
async function fetchEnvelope(envelope_id: string): Promise<EnvelopeRow | null> {
  // Try with optional columns first
  const withOptional =
    "id, title, status, entity_id, record_id, metadata, supporting_document_path, supporting_document_bucket";
  const coreOnly = "id, title, status, entity_id, record_id, metadata, supporting_document_path";

  let r = await supabase
    .from("signature_envelopes")
    .select(withOptional)
    .eq("id", envelope_id)
    .maybeSingle();

  if (r.error) {
    r = await supabase
      .from("signature_envelopes")
      .select(coreOnly)
      .eq("id", envelope_id)
      .maybeSingle();
  }

  if (r.error) return null;
  return (r.data ?? null) as EnvelopeRow | null;
}

async function fetchParty(
  envelope_id: string,
  party_id: string,
): Promise<PartyRow | null> {
  // Try including party_token; fallback if column doesn't exist.
  const withToken =
    "id, signatory_id, email, display_name, role, status, signing_order, party_token";
  const coreOnly =
    "id, signatory_id, email, display_name, role, status, signing_order";

  let r = await supabase
    .from("signature_parties")
    .select(withToken)
    .eq("id", party_id)
    .eq("envelope_id", envelope_id)
    .maybeSingle();

  if (r.error) {
    r = await supabase
      .from("signature_parties")
      .select(coreOnly)
      .eq("id", party_id)
      .eq("envelope_id", envelope_id)
      .maybeSingle();
  }

  if (r.error) return null;
  return (r.data ?? null) as PartyRow | null;
}

async function fetchLedger(record_id: string): Promise<LedgerRow | null> {
  const r = await supabase
    .from("governance_ledger")
    .select("id, title, body, entity_id")
    .eq("id", record_id)
    .maybeSingle();
  if (r.error) return null;
  return (r.data ?? null) as LedgerRow | null;
}

async function fetchEntity(entity_id: string): Promise<EntityRow | null> {
  const r = await supabase
    .from("entities")
    .select("id, slug, name")
    .eq("id", entity_id)
    .maybeSingle();
  if (r.error) return null;
  return (r.data ?? null) as EntityRow | null;
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------
serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders() });
  }

  if (req.method !== "POST") {
    return json({ error: "Use POST" }, 405);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  // ✅ NO REGRESSION + NEW CAPABILITY MODEL:
  // - Legacy callers may send `token`
  // - New sign.html sends `party_token`
  const { party_id, envelope_id, party_token, token } = body ?? {};
  const providedToken = party_token ?? token;

  if (!party_id || !envelope_id) {
    return json({ error: "party_id and envelope_id are required" }, 400);
  }

  try {
    // -------------------------------------------------------------------------
    // 1) Envelope
    // -------------------------------------------------------------------------
    const envelope = await fetchEnvelope(String(envelope_id));
    if (!envelope) {
      return json({ error: "Envelope not found" }, 404);
    }

    // -------------------------------------------------------------------------
    // 2) Party (best-effort include party_token)
    // -------------------------------------------------------------------------
    const party = await fetchParty(String(envelope_id), String(party_id));
    if (!party) {
      return json({ error: "Signature party not found" }, 404);
    }

    // -------------------------------------------------------------------------
    // 3) Capability token enforcement (NO REGRESSION)
    // Rule:
    // - party_token IS NULL/undefined → legacy signer → ALLOW
    // - party_token EXISTS           → token REQUIRED and must match
    // -------------------------------------------------------------------------
    if (party.party_token) {
      const expected = String(party.party_token);
      const provided = String(providedToken ?? "");

      if (!provided) {
        return json({ error: "SIGNING_TOKEN_REQUIRED" }, 401);
      }
      if (provided !== expected) {
        return json({ error: "SIGNING_TOKEN_INVALID" }, 403);
      }
    }

    // -------------------------------------------------------------------------
    // 4) Governance record (body required)
    // -------------------------------------------------------------------------
    const recordId = envelope.record_id ? String(envelope.record_id) : "";
    if (!recordId) {
      return json({ error: "Governance record not found" }, 404);
    }

    const recordRaw = await fetchLedger(recordId);
    if (!recordRaw) {
      return json({ error: "Governance record not found" }, 404);
    }

    const record = {
      id: recordRaw.id,
      title: recordRaw.title,
      body: recordRaw.body,
    };

    // -------------------------------------------------------------------------
    // 5) Entity (prefer envelope.entity_id; fallback to record.entity_id)
    // -------------------------------------------------------------------------
    const entityId =
      envelope.entity_id ? String(envelope.entity_id) : (recordRaw.entity_id ? String(recordRaw.entity_id) : "");

    if (!entityId) {
      return json({ error: "Entity not found" }, 404);
    }

    const entity = await fetchEntity(entityId);
    if (!entity) {
      return json({ error: "Entity not found" }, 404);
    }

    // -------------------------------------------------------------------------
    // 6) Resolution (optional)
    // -------------------------------------------------------------------------
    const { data: resolution } = await supabase
      .from("resolutions")
      .select("id, title, body, body_json, status")
      .eq("signature_envelope_id", String(envelope_id))
      .maybeSingle();

    // -------------------------------------------------------------------------
    // 7) Latest AI summary (optional)
    // -------------------------------------------------------------------------
    const { data: summary } = await supabase
      .from("ai_summaries")
      .select("id, summary, generated_at")
      .eq("record_id", record.id)
      .order("generated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // -------------------------------------------------------------------------
    // 8) Governance document + signed PDF URL (best-effort)
    // -------------------------------------------------------------------------
    let objectPath: string | null = (envelope.supporting_document_path ?? null) || null;
    let pdf_url: string | null = null;

    if (objectPath) {
      const bucket =
        (safeStr((envelope as any).supporting_document_bucket) || "") ||
        SIGNING_BUCKET;

      const signed = await supabase.storage
        .from(bucket)
        .createSignedUrl(objectPath, 60 * 60 * 24);

      pdf_url = signed.data?.signedUrl ?? null;
    }

    // -------------------------------------------------------------------------
    // Final response (UNCHANGED SHAPE)
    // -------------------------------------------------------------------------
    return json({
      envelope,
      party: {
        id: party.id,
        email: party.email,
        display_name: party.display_name,
        role: party.role,
        status: party.status,
        signing_order: party.signing_order,
      },
      entity,
      record,
      resolution,
      summary,
      pdf_url,
    });
  } catch (e) {
    console.error("get-signing-context error", e);
    return json({ error: "Unexpected server error" }, 500);
  }
});
