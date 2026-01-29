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

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
    },
  });
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------
serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
      },
    });
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

  // 🔐 token is OPTIONAL for legacy rows
  const { party_id, envelope_id, token } = body ?? {};

  if (!party_id || !envelope_id) {
    return json(
      { error: "party_id and envelope_id are required" },
      400,
    );
  }

  try {
    // -------------------------------------------------------------------------
    // 1) Envelope
    // -------------------------------------------------------------------------
    const { data: envelope, error: envErr } = await supabase
      .from("signature_envelopes")
      .select(
        "id, title, status, entity_id, record_id, metadata, supporting_document_path",
      )
      .eq("id", envelope_id)
      .single();

    if (envErr || !envelope) {
      return json({ error: "Envelope not found" }, 404);
    }

    // -------------------------------------------------------------------------
    // 2) Party (include party_token for capability enforcement)
    // -------------------------------------------------------------------------
    const { data: party, error: partyErr } = await supabase
      .from("signature_parties")
      .select(
        "id, signatory_id, email, display_name, role, status, signing_order, party_token",
      )
      .eq("id", party_id)
      .eq("envelope_id", envelope_id)
      .single();

    if (partyErr || !party) {
      return json({ error: "Signature party not found" }, 404);
    }

    // -------------------------------------------------------------------------
    // 3) Capability token enforcement (NO REGRESSION)
    // Rule:
    // - party_token IS NULL  → legacy signer → ALLOW
    // - party_token EXISTS   → token REQUIRED and must match
    // -------------------------------------------------------------------------
    if (party.party_token) {
      const expected = String(party.party_token);
      const provided = String(token ?? "");

      if (!provided) {
        return json(
          { error: "SIGNING_TOKEN_REQUIRED" },
          401,
        );
      }

      if (provided !== expected) {
        return json(
          { error: "SIGNING_TOKEN_INVALID" },
          403,
        );
      }
    }

    // -------------------------------------------------------------------------
    // 4) Entity
    // -------------------------------------------------------------------------
    const { data: entity, error: entErr } = await supabase
      .from("entities")
      .select("id, slug, name")
      .eq("id", envelope.entity_id)
      .single();

    if (entErr || !entity) {
      return json({ error: "Entity not found" }, 404);
    }

    // -------------------------------------------------------------------------
    // 5) Governance record (body required)
    // -------------------------------------------------------------------------
    const { data: recordRaw, error: recErr } = await supabase
      .from("governance_ledger")
      .select("id, title, body")
      .eq("id", envelope.record_id)
      .single();

    if (recErr || !recordRaw) {
      return json({ error: "Governance record not found" }, 404);
    }

    const record = {
      id: recordRaw.id,
      title: recordRaw.title,
      body: recordRaw.body,
    };

    // -------------------------------------------------------------------------
    // 6) Resolution (optional)
    // -------------------------------------------------------------------------
    const { data: resolution } = await supabase
      .from("resolutions")
      .select("id, title, body, body_json, status")
      .eq("signature_envelope_id", envelope_id)
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
    // 8) Governance document + signed PDF URL
    // -------------------------------------------------------------------------
    const BUCKET = "minute_book";
    let objectPath: string | null = envelope.supporting_document_path ?? null;
    let pdf_url: string | null = null;

    if (objectPath) {
      const { data: signed } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(objectPath, 60 * 60 * 24);

      pdf_url = signed?.signedUrl ?? null;
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
