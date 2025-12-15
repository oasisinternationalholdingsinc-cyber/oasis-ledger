// supabase/functions/get-signing-context/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
}
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: {
    fetch
  }
});
// Always send CORS headers
function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey"
    }
  });
}
serve(async (req)=>{
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey"
      }
    });
  }
  if (req.method !== "POST") {
    return json({
      error: "Use POST"
    }, 405);
  }
  let body;
  try {
    body = await req.json();
  } catch  {
    return json({
      error: "Invalid JSON body"
    }, 400);
  }
  const { party_id, envelope_id } = body;
  if (!party_id || !envelope_id) {
    return json({
      error: "party_id and envelope_id are required"
    }, 400);
  }
  try {
    // 1) Envelope (include supporting_document_path)
    const { data: envelope, error: envErr } = await supabase.from("signature_envelopes").select("id, title, status, entity_id, record_id, metadata, supporting_document_path").eq("id", envelope_id).single();
    if (envErr || !envelope) {
      console.error("Envelope fetch error", envErr);
      return json({
        error: "Envelope not found",
        details: envErr
      }, 404);
    }
    // 2) Party
    const { data: party, error: partyErr } = await supabase.from("signature_parties").select("id, signatory_id, email, display_name, role, status, signing_order").eq("id", party_id).eq("envelope_id", envelope_id).single();
    if (partyErr || !party) {
      console.error("Party fetch error", partyErr);
      return json({
        error: "Signature party not found",
        details: partyErr
      }, 404);
    }
    // 3) Entity
    const { data: entity, error: entErr } = await supabase.from("entities").select("id, slug, name").eq("id", envelope.entity_id).single();
    if (entErr || !entity) {
      console.error("Entity fetch error", entErr);
      return json({
        error: "Entity not found",
        details: entErr
      }, 404);
    }
    // 4) Governance record – IMPORTANT: include body, not description
    const { data: recordRaw, error: recErr } = await supabase.from("governance_ledger").select("id, title, body").eq("id", envelope.record_id).single();
    if (recErr || !recordRaw) {
      console.error("Record fetch error", recErr);
      return json({
        error: "Governance record not found",
        details: recErr
      }, 404);
    }
    // Only expose the fields the signer page actually needs (and nothing else)
    const record = {
      id: recordRaw.id,
      title: recordRaw.title,
      body: recordRaw.body
    };
    // 5) Resolution (optional)
    const { data: resolution, error: resErr } = await supabase.from("resolutions").select("id, title, body, body_json, status").eq("signature_envelope_id", envelope_id).maybeSingle();
    if (resErr) console.error("Resolution fetch error", resErr);
    // 6) Latest AI summary (optional)
    const { data: summary, error: sumErr } = await supabase.from("ai_summaries").select("id, summary, generated_at").eq("record_id", record.id).order("generated_at", {
      ascending: false
    }).limit(1).maybeSingle();
    if (sumErr) console.error("Summary fetch error", sumErr);
    // 7) Governance document (optional)
    const { data: document, error: docErr } = await supabase.from("governance_documents").select("id, storage_path, file_name, doc_type, mime_type, created_at").or(`envelope_id.eq.${envelope_id},record_id.eq.${record.id}`).order("created_at", {
      ascending: false
    }).limit(1).maybeSingle();
    if (docErr) console.error("Document fetch error", docErr);
    // 8) Build signed PDF URL from private minute_book bucket
    const BUCKET = "minute_book";
    let objectPath = null;
    if (envelope.supporting_document_path) {
      // e.g. "OIH/AnnualReturns/OIH-AnnualReturn-2025-signed.pdf"
      objectPath = envelope.supporting_document_path;
    } else if (document?.storage_path) {
      let p = document.storage_path;
      if (p.startsWith("minute_book/")) {
        p = p.replace(/^minute_book\//, "");
      }
      objectPath = p;
    }
    let pdf_url = null;
    let docForClient = document ?? null;
    let signedError = null;
    if (objectPath) {
      const { data: signed, error: signedErr } = await supabase.storage.from(BUCKET).createSignedUrl(objectPath, 60 * 60 * 24); // 24h
      if (signedErr) {
        console.error("Error creating signed URL in get-signing-context:", signedErr.message);
        signedError = signedErr.message ?? String(signedErr);
      } else if (signed?.signedUrl) {
        pdf_url = signed.signedUrl;
        docForClient = {
          ...document ?? {},
          bucket: BUCKET,
          object_path: objectPath,
          pdf_url
        };
      }
    }
    return json({
      envelope,
      party,
      entity,
      record,
      resolution,
      summary,
      document: docForClient,
      pdf_url,
      debug: {
        bucket: BUCKET,
        object_path: objectPath,
        signed_error: signedError
      }
    });
  } catch (e) {
    console.error("Unexpected error in get-signing-context", e);
    return json({
      error: "Unexpected server error",
      details: String(e)
    }, 500);
  }
});
