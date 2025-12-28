import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error("Missing Supabase env");

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

const MINUTE_BOOK_BUCKET = Deno.env.get("MINUTE_BOOK_BUCKET") ?? "minute_book";

// Where your signed PDFs currently live (per your storage.objects screenshot)
const SIGNED_PDF_BUCKET = Deno.env.get("SIGNED_PDF_BUCKET") ?? MINUTE_BOOK_BUCKET;

// This is the edge function we call after we download + base64 the signed PDF.
const ARCHIVE_SAVE_FN = Deno.env.get("ARCHIVE_SAVE_FN") ?? "archive-save-document";

const corsHeaders: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function asString(x: unknown) {
  return typeof x === "string" ? x.trim() : "";
}

type ReqBody = {
  record_id?: string; // governance_ledger.id
  envelope_id?: string; // optional shortcut
  domain_key?: string;
  section_name?: string;
};

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // deno-safe base64
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Find the best candidate for the SIGNED pdf path.
 * Priority:
 *  1) storage.objects match: bucket=SIGNED_PDF_BUCKET and name ILIKE '%/<record_id>-signed.pdf' (most recent)
 *  2) if we have envelope.storage_path, try swapping ".pdf" -> "-signed.pdf"
 *  3) if we have envelope.supporting_document_path, try swapping ".pdf" -> "-signed.pdf"
 */
async function resolveSignedPdfPath(args: {
  record_id: string;
  envelope_storage_path?: string | null;
  envelope_supporting_path?: string | null;
}): Promise<{ bucket: string; path: string; source: string } | null> {
  const { record_id, envelope_storage_path, envelope_supporting_path } = args;

  // 1) Canonical: query storage.objects for *-signed.pdf
  {
    const { data, error } = await supabase
      .from("storage.objects")
      .select("bucket_id, name, created_at")
      .eq("bucket_id", SIGNED_PDF_BUCKET)
      .ilike("name", `%/${record_id}-signed.pdf`)
      .order("created_at", { ascending: false })
      .limit(1);

    if (!error && data && data.length > 0) {
      return { bucket: data[0].bucket_id as string, path: data[0].name as string, source: "storage.objects" };
    }
  }

  const trySwap = (p?: string | null) => {
    const s = asString(p);
    if (!s) return "";
    if (s.endsWith("-signed.pdf")) return s;
    if (s.toLowerCase().endsWith(".pdf")) return s.replace(/\.pdf$/i, "-signed.pdf");
    return "";
  };

  // 2) Fallback: derive from envelope.storage_path
  {
    const swapped = trySwap(envelope_storage_path);
    if (swapped) return { bucket: SIGNED_PDF_BUCKET, path: swapped, source: "envelope.storage_path->swap" };
  }

  // 3) Fallback: derive from envelope.supporting_document_path
  {
    const swapped = trySwap(envelope_supporting_path);
    if (swapped) return { bucket: SIGNED_PDF_BUCKET, path: swapped, source: "envelope.supporting_document_path->swap" };
  }

  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "POST required" }, 405);

  let body: ReqBody;
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const record_id = asString(body.record_id);
  const envelope_id_hint = asString(body.envelope_id);
  const domain_key = asString(body.domain_key);
  const section_name = asString(body.section_name);

  if (!record_id) return json({ ok: false, error: "record_id is required" }, 400);

  // 1) Load ledger (THIS is the lane source of truth)
  const { data: ledger, error: ledErr } = await supabase
    .from("governance_ledger")
    .select("id, title, entity_id, is_test")
    .eq("id", record_id)
    .maybeSingle();

  if (ledErr) return json({ ok: false, error: "Failed to load governance_ledger", details: ledErr.message }, 500);
  if (!ledger) return json({ ok: false, error: "record_id not found in governance_ledger" }, 404);

  const lane_is_test = (ledger.is_test ?? false) === true;

  // 2) Find envelope (do NOT require envelope.is_test; completed envelopes are immutable and can be mismatched)
  let envelope:
    | {
        id: string;
        status: string | null;
        is_test: boolean | null;
        storage_path: string | null;
        supporting_document_path: string | null;
        completed_at: string | null;
      }
    | null = null;

  if (envelope_id_hint) {
    const { data, error } = await supabase
      .from("signature_envelopes")
      .select("id, status, is_test, storage_path, supporting_document_path, completed_at")
      .eq("id", envelope_id_hint)
      .maybeSingle();
    if (error) return json({ ok: false, error: "Failed to load signature_envelopes by envelope_id", details: error.message }, 500);
    envelope = data ?? null;
  } else {
    const { data, error } = await supabase
      .from("signature_envelopes")
      .select("id, status, is_test, storage_path, supporting_document_path, completed_at")
      .eq("record_id", record_id)
      .order("completed_at", { ascending: false })
      .limit(1);

    if (error) return json({ ok: false, error: "Failed to load signature_envelopes by record_id", details: error.message }, 500);
    envelope = data?.[0] ?? null;
  }

  if (!envelope) return json({ ok: false, error: "No signature_envelope found for this record" }, 404);
  if ((envelope.status ?? "").toLowerCase() !== "completed") {
    return json(
      {
        ok: false,
        error: "Envelope is not completed",
        envelope_id: envelope.id,
        envelope_status: envelope.status,
      },
      400,
    );
  }

  // 3) Resolve signed PDF storage location
  const resolved = await resolveSignedPdfPath({
    record_id,
    envelope_storage_path: envelope.storage_path,
    envelope_supporting_path: envelope.supporting_document_path,
  });

  if (!resolved) {
    return json(
      {
        ok: false,
        error: "Failed to locate signed PDF in storage",
        record_id,
        signed_bucket_expected: SIGNED_PDF_BUCKET,
        hint: `Expected a file ending with "/${record_id}-signed.pdf"`,
        envelope_id: envelope.id,
        envelope_storage_path: envelope.storage_path,
        envelope_supporting_document_path: envelope.supporting_document_path,
      },
      500,
    );
  }

  // 4) Download signed PDF bytes
  const { data: fileBlob, error: dlErr } = await supabase.storage
    .from(resolved.bucket)
    .download(resolved.path);

  if (dlErr || !fileBlob) {
    return json(
      {
        ok: false,
        error: "Failed to download signed PDF",
        record_id,
        bucket: resolved.bucket,
        path: resolved.path,
        source: resolved.source,
        details: dlErr?.message ?? "no data",
      },
      500,
    );
  }

  const pdf_base64 = await blobToBase64(fileBlob);

  // 5) Call archive-save-document (service_role -> OK)
  const archiveUrl = `${SUPABASE_URL}/functions/v1/${ARCHIVE_SAVE_FN}`;

  const saveRes = await fetch(archiveUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      apikey: SERVICE_ROLE_KEY,
    },
    body: JSON.stringify({
      source_record_id: record_id,
      pdf_base64,
      envelope_id: envelope.id,
      is_test: lane_is_test,
      domain_key: domain_key || undefined,
      section_name: section_name || undefined,
      // bucket for archive target is controlled inside archive-save-document; you can override there if needed
    }),
  });

  const saveJson = await saveRes.json().catch(() => null);

  if (!saveRes.ok) {
    return json(
      {
        ok: false,
        error: "archive-save-document failed",
        status: saveRes.status,
        record_id,
        lane_is_test,
        signed_pdf_bucket: resolved.bucket,
        signed_pdf_path: resolved.path,
        archive_save_fn: ARCHIVE_SAVE_FN,
        details: saveJson ?? null,
      },
      500,
    );
  }

  return json({
    ok: true,
    record_id,
    ledger_is_test: lane_is_test,
    envelope_id: envelope.id,
    envelope_is_test: envelope.is_test, // informational only (may be mismatched; we do NOT rely on it)
    signed_pdf_bucket: resolved.bucket,
    signed_pdf_path: resolved.path,
    signed_pdf_source: resolved.source,
    archived: saveJson,
  });
});
