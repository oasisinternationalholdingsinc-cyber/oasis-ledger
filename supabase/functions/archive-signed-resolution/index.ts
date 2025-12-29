import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error("Missing Supabase env");

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { global: { fetch } });

const MINUTE_BOOK_BUCKET = Deno.env.get("MINUTE_BOOK_BUCKET") ?? "minute_book";
const SIGNED_PDF_BUCKET = Deno.env.get("SIGNED_PDF_BUCKET") ?? MINUTE_BOOK_BUCKET;

const DEFAULT_DOMAIN_KEY =
  Deno.env.get("DEFAULT_MINUTE_BOOK_DOMAIN_KEY") ?? "governance";
const DEFAULT_SECTION_NAME =
  Deno.env.get("DEFAULT_MINUTE_BOOK_SECTION_NAME") ?? "Governance";

const corsHeaders: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const arr = Array.from(new Uint8Array(digest));
  return arr.map((b) => b.toString(16).padStart(2, "0")).join("");
}

type ReqBody = {
  envelope_id?: string;
  record_id?: string;
  is_test?: boolean; // ignored; governance_ledger is truth
  domain_key?: string;
  section_name?: string;
  signed_bucket?: string;
};

async function findSignedObjectPath(
  recordId: string,
  bucket: string,
): Promise<string | null> {
  // Find newest *<recordId>*-signed.pdf anywhere under bucket (case-insensitive)
  const { data, error } = await supabase
    .from("storage.objects")
    .select("name, created_at")
    .eq("bucket_id", bucket)
    .ilike("name", `%${recordId}%-signed.pdf%`)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    console.warn("storage.objects search error:", error.message);
    return null;
  }
  return data?.[0]?.name ?? null;
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

  const envelope_id = asString(body.envelope_id);
  const record_id_in = asString(body.record_id);

  if (!envelope_id && !record_id_in) {
    return json({ ok: false, error: "Provide envelope_id (preferred) or record_id" }, 400);
  }

  // 1) Load envelope to resolve record_id and candidate storage path
  let record_id = record_id_in;
  let envelope_storage_path = "";
  let envelope_status = "";

  if (envelope_id) {
    const { data: env, error: envErr } = await supabase
      .from("signature_envelopes")
      .select("id, record_id, status, storage_path, supporting_document_path")
      .eq("id", envelope_id)
      .maybeSingle();

    if (envErr) {
      return json(
        { ok: false, error: "Failed to load signature_envelopes", details: envErr.message },
        500,
      );
    }
    if (!env) return json({ ok: false, error: "Envelope not found", envelope_id }, 404);

    record_id = record_id || (env.record_id as string);
    envelope_status = asString(env.status);
    envelope_storage_path = asString(env.storage_path) || asString(env.supporting_document_path);
  }

  if (!record_id) return json({ ok: false, error: "Could not resolve record_id" }, 400);

  // 2) Load governance record (truth source for lane + entity)
  const { data: ledger, error: ledErr } = await supabase
    .from("governance_ledger")
    .select("id, title, entity_id, is_test")
    .eq("id", record_id)
    .maybeSingle();

  if (ledErr) {
    return json({ ok: false, error: "Failed to load governance_ledger", details: ledErr.message }, 500);
  }
  if (!ledger) return json({ ok: false, error: "record_id not found in governance_ledger", record_id }, 404);

  const lane_is_test = (ledger.is_test ?? false) === true;
  const title = asString(ledger.title) || "Signed Resolution";
  const entity_id = asString(ledger.entity_id);
  if (!entity_id) return json({ ok: false, error: "governance_ledger.entity_id missing", record_id }, 400);

  // 3) Resolve entity_key from entities.slug (must match your entity_key_enum)
  const { data: ent, error: entErr } = await supabase
    .from("entities")
    .select("slug")
    .eq("id", entity_id)
    .maybeSingle();

  if (entErr) return json({ ok: false, error: "Failed to resolve entity slug", details: entErr.message }, 500);
  const entity_key = asString(ent?.slug);
  if (!entity_key) return json({ ok: false, error: "Could not resolve entity_key from entities.slug", entity_id }, 400);

  // 4) If verified_documents already exists, return it (idempotent)
  //    (We do NOT mutate completed envelopes; registry is the source of truth.)
  {
    const { data: existing, error: exErr } = await supabase
      .from("verified_documents")
      .select("id, source_table, source_record_id, envelope_id, file_hash, storage_bucket, storage_path, verification_level, created_at")
      .or(`envelope_id.eq.${envelope_id || "00000000-0000-0000-0000-000000000000"},source_record_id.eq.${record_id}`)
      .order("created_at", { ascending: false })
      .limit(1);

    if (!exErr && existing?.length) {
      return json({
        ok: true,
        already_verified: true,
        record_id,
        envelope_id: envelope_id || null,
        lane_is_test,
        verified_document: existing[0],
      });
    }
  }

  // 5) Resolve signed pdf path WITHOUT changing envelope row
  const signed_bucket = asString(body.signed_bucket) || SIGNED_PDF_BUCKET;

  let signed_path = "";
  if (envelope_storage_path) {
    if (envelope_storage_path.toLowerCase().endsWith(".pdf")) {
      signed_path = envelope_storage_path.replace(/\.pdf$/i, "-signed.pdf");
    } else {
      signed_path = envelope_storage_path;
    }
  }

  // Verify candidate exists
  if (signed_path) {
    const { data: obj } = await supabase
      .from("storage.objects")
      .select("name")
      .eq("bucket_id", signed_bucket)
      .eq("name", signed_path)
      .maybeSingle();

    if (!obj?.name) signed_path = "";
  }

  // Fallback: search storage.objects
  if (!signed_path) {
    const found = await findSignedObjectPath(record_id, signed_bucket);
    if (!found) {
      return json(
        {
          ok: false,
          error: "Failed to locate signed PDF in storage",
          record_id,
          envelope_id: envelope_id || null,
          hint: `Expected bucket "${signed_bucket}" to contain *${record_id}*-signed.pdf`,
        },
        404,
      );
    }
    signed_path = found;
  }

  // 6) Download signed PDF bytes
  const { data: signedBlob, error: dlErr } = await supabase.storage
    .from(signed_bucket)
    .download(signed_path);

  if (dlErr || !signedBlob) {
    return json(
      {
        ok: false,
        error: "Failed to download signed PDF",
        details: dlErr?.message ?? "{}",
        signed_bucket,
        signed_path,
      },
      500,
    );
  }

  const signedBytes = new Uint8Array(await signedBlob.arrayBuffer());
  const pdf_base64 = base64FromBytes(signedBytes);
  const file_hash = await sha256Hex(signedBytes);

  // 7) Call archive-save-document (Minute Book write + pointers)
  const domain_key = asString(body.domain_key) || DEFAULT_DOMAIN_KEY;
  const section_name = asString(body.section_name) || DEFAULT_SECTION_NAME;

  const { data: saveRes, error: saveErr } = await supabase.functions.invoke("archive-save-document", {
    body: {
      source_record_id: record_id,
      pdf_base64,
      title,
      entity_id,
      entity_key,
      is_test: lane_is_test,
      envelope_id: envelope_id || null,
      domain_key,
      section_name,
      bucket: MINUTE_BOOK_BUCKET,
    },
  });

  if (saveErr) {
    return json(
      {
        ok: false,
        error: "archive-save-document failed",
        details: saveErr.message,
        record_id,
        envelope_id: envelope_id || null,
      },
      500,
    );
  }

  // 8) Insert verified_documents as the source confirmable by Verify
  //    We store the SIGNED PDF pointer (not the unsigned envelope draft).
  //    Use best-known fields from saveRes if present, else fall back to signed_bucket/path.
  const final_storage_bucket = (saveRes?.storage_bucket ?? signed_bucket) as string;
  const final_storage_path = (saveRes?.storage_path ?? signed_path) as string;

  const insertPayload: Record<string, unknown> = {
    source_table: "governance_ledger",
    source_record_id: record_id,
    envelope_id: envelope_id || null,
    file_hash,
    storage_bucket: final_storage_bucket,
    storage_path: final_storage_path,
    verification_level: "certified",
    created_at: new Date().toISOString(),
  };

  // If your verified_documents has extra NOT NULL columns (some builds do),
  // we opportunistically pass through common ones when present.
  if (saveRes?.verification_level) insertPayload.verification_level = saveRes.verification_level;

  // Try insert; if unique constraint exists, fallback select latest
  let verifiedRow: any = null;
  {
    const { data: ins, error: insErr } = await supabase
      .from("verified_documents")
      .insert(insertPayload)
      .select("id, source_table, source_record_id, envelope_id, file_hash, storage_bucket, storage_path, verification_level, created_at")
      .maybeSingle();

    if (insErr) {
      console.warn("verified_documents insert failed, falling back to select:", insErr.message);
      const { data: existing, error: exErr } = await supabase
        .from("verified_documents")
        .select("id, source_table, source_record_id, envelope_id, file_hash, storage_bucket, storage_path, verification_level, created_at")
        .or(`envelope_id.eq.${envelope_id || "00000000-0000-0000-0000-000000000000"},source_record_id.eq.${record_id}`)
        .order("created_at", { ascending: false })
        .limit(1);

      if (exErr || !existing?.length) {
        return json(
          {
            ok: false,
            error: "Archive succeeded but registry insert/select failed",
            details: insErr.message,
            record_id,
            envelope_id: envelope_id || null,
            archive_save_result: saveRes ?? null,
          },
          500,
        );
      }
      verifiedRow = existing[0];
    } else {
      verifiedRow = ins;
    }
  }

  return json({
    ok: true,
    record_id,
    envelope_id: envelope_id || null,
    envelope_status: envelope_status || null,
    lane_is_test,
    signed_bucket,
    signed_path,
    file_hash,
    minute_book_bucket: MINUTE_BOOK_BUCKET,
    archive_save_result: saveRes ?? null,
    verified_document: verifiedRow,
  });
});
