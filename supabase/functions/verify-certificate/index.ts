// supabase/functions/verify-certificate/index.ts
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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
    },
  });
}

serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
      },
    });
  }

  try {
    const url = new URL(req.url);
    const envelope_id = url.searchParams.get("envelope_id");

    if (!envelope_id) {
      return json(
        { ok: false, valid: false, error: "Missing envelope_id" },
        400,
      );
    }

    // 1) Load envelope
    const { data: envelope, error: envErr } = await supabase
      .from("signature_envelopes")
      .select("*")
      .eq("id", envelope_id)
      .single();

    if (envErr || !envelope) {
      return json(
        {
          ok: false,
          valid: false,
          error: "Envelope not found",
          details: envErr,
        },
        404,
      );
    }

    // 2) Load parties
    const { data: parties, error: partiesErr } = await supabase
      .from("signature_parties")
      .select("*")
      .eq("envelope_id", envelope_id);

    if (partiesErr) {
      // non-fatal – we can still return envelope/record
      console.error("signature_parties error:", partiesErr);
    }

    // 3) Load record + entity (best effort)
    const { data: record } = await supabase
      .from("governance_ledger")
      .select("*")
      .eq("id", envelope.record_id)
      .single();

    const { data: entity } = await supabase
      .from("entities")
      .select("*")
      .eq("id", envelope.entity_id)
      .single();

    // 4) Determine validity
    const status = envelope.status ?? null;
    const isCompleted = status === "completed";

    // 5) Derive certificate + signed document path from metadata
    const meta = envelope.metadata ?? {};
    const certMeta = meta.certificate ?? null;

    const signedDocumentPath =
      meta.signed_document_path ??
      certMeta?.signed_document_path ??
      envelope.storage_path ??
      null;

    const pdfHash =
      certMeta?.pdf_hash ??
      envelope.storage_hash ??
      null;

    const hashMatch = null;
    const expectedHash = pdfHash;
    const computedHash = null;

    const certificate = certMeta ?? {
      certificate_version: 1,
      certificate_id: envelope_id,
      envelope_id,
      record_id: envelope.record_id ?? null,
      entity_id: envelope.entity_id ?? null,
      entity_name: entity?.name ?? null,
      record_title: record?.title ?? envelope.title ?? null,
      signer: {
        name: parties?.[0]?.display_name ?? null,
        email: parties?.[0]?.email ?? null,
        role: parties?.[0]?.role ?? "signer",
      },
      signed_at: envelope.completed_at ?? null,
      envelope_status: status,
      verify_url:
        meta.verify_url ??
        `https://sign.oasisintlholdings.com/verify.html?envelope_id=${envelope_id}`,
      pdf_hash: pdfHash,
      bucket: "minute_book",
      signed_document_path: signedDocumentPath,
    };

    // Mark validity
    let valid = isCompleted && !!signedDocumentPath;
    let reason: string | null = null;

    if (!signedDocumentPath) {
      valid = false;
      reason =
        "No signed document is attached yet. The envelope may be pending ingestion or certificate generation.";
    }

    return json({
      ok: true,
      valid,
      status,
      reason,
      envelope_id,
      envelope,
      entity,
      record,
      parties: parties ?? [],
      certificate,
      signed_document_path: signedDocumentPath,
      hash_match: hashMatch,
      expected_hash: expectedHash,
      computed_hash: computedHash,
    });
  } catch (e) {
    console.error("verify-certificate error:", e);
    return json(
      {
        ok: false,
        valid: false,
        error: "Unexpected server error",
        details: String(e),
      },
      500,
    );
  }
});
