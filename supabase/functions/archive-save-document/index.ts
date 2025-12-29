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
// Signed PDFs are currently landing in minute_book in your screenshots
const SIGNED_PDF_BUCKET = Deno.env.get("SIGNED_PDF_BUCKET") ?? MINUTE_BOOK_BUCKET;

const DEFAULT_DOMAIN_KEY = Deno.env.get("DEFAULT_MINUTE_BOOK_DOMAIN_KEY") ?? "governance";
const DEFAULT_SECTION_NAME = Deno.env.get("DEFAULT_MINUTE_BOOK_SECTION_NAME") ?? "Governance";

// Optional: if you have an RPC that seals into verified_documents registry
const SEAL_RPC_NAME = Deno.env.get("SEAL_RPC_NAME") ?? "seal_governance_record_for_archive";

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

type ReqBody = {
  envelope_id?: string;
  record_id?: string;
  is_test?: boolean;

  domain_key?: string;
  section_name?: string;

  signed_bucket?: string; // optional override
};

async function findSignedObjectPath(recordId: string, preferredBucket: string) {
  const pat = `%${recordId}%-signed.pdf%`;

  // 1) Preferred bucket first
  {
    const { data, error } = await supabase
      .schema("storage")
      .from("objects")
      .select("bucket_id, name, created_at")
      .eq("bucket_id", preferredBucket)
      .ilike("name", pat)
      .order("created_at", { ascending: false })
      .limit(1);

    if (error) {
      return { found: null as null | { bucket: string; path: string }, error: error.message };
    }
    const row = data?.[0];
    if (row?.bucket_id && row?.name) {
      return { found: { bucket: row.bucket_id as string, path: row.name as string }, error: null as string | null };
    }
  }

  // 2) Fallback: ANY bucket
  {
    const { data, error } = await supabase
      .schema("storage")
      .from("objects")
      .select("bucket_id, name, created_at")
      .ilike("name", pat)
      .order("created_at", { ascending: false })
      .limit(1);

    if (error) {
      return { found: null as null | { bucket: string; path: string }, error: error.message };
    }
    const row = data?.[0];
    if (row?.bucket_id && row?.name) {
      return { found: { bucket: row.bucket_id as string, path: row.name as string }, error: null as string | null };
    }
  }

  return { found: null as null | { bucket: string; path: string }, error: null as string | null };
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

  // 1) Load envelope -> record_id + envelope paths
  let record_id = record_id_in;
  let envelope_storage_path = "";
  let envelope_supporting_path = "";
  let envelope_status = "";

  if (envelope_id) {
    const { data: env, error: envErr } = await supabase
      .from("signature_envelopes")
      .select("id, record_id, status, storage_path, supporting_document_path")
      .eq("id", envelope_id)
      .maybeSingle();

    if (envErr) return json({ ok: false, error: "Failed to load signature_envelopes", details: envErr.message }, 500);
    if (!env) return json({ ok: false, error: "Envelope not found", envelope_id }, 404);

    record_id = record_id || (env.record_id as string);
    envelope_status = asString(env.status);
    envelope_storage_path = asString(env.storage_path);
    envelope_supporting_path = asString(env.supporting_document_path);
  }

  if (!record_id) return json({ ok: false, error: "Could not resolve record_id" }, 400);

  // 2) Load governance_ledger (truth source)
  const { data: ledger, error: ledErr } = await supabase
    .from("governance_ledger")
    .select("id, title, entity_id, is_test")
    .eq("id", record_id)
    .maybeSingle();

  if (ledErr) return json({ ok: false, error: "Failed to load governance_ledger", details: ledErr.message }, 500);
  if (!ledger) return json({ ok: false, error: "record_id not found in governance_ledger", record_id }, 404);

  const lane_is_test = (ledger.is_test ?? false) === true;
  const title = asString(ledger.title) || "Signed Resolution";
  const entity_id = asString(ledger.entity_id);
  if (!entity_id) return json({ ok: false, error: "governance_ledger.entity_id missing", record_id }, 400);

  // 3) Resolve entity_key (slug)
  const { data: ent, error: entErr } = await supabase
    .from("entities")
    .select("slug")
    .eq("id", entity_id)
    .maybeSingle();

  if (entErr) return json({ ok: false, error: "Failed to resolve entity slug", details: entErr.message }, 500);
  const entity_key = asString(ent?.slug);
  if (!entity_key) return json({ ok: false, error: "Could not resolve entity_key from entities.slug", entity_id }, 400);

  // 4) Determine signed pdf bucket
  const preferredSignedBucket = asString(body.signed_bucket) || SIGNED_PDF_BUCKET;

  // 5) Try derive signed path from envelope paths
  const deriveSigned = (p: string) => (p.toLowerCase().endsWith(".pdf") ? p.replace(/\.pdf$/i, "-signed.pdf") : "");
  let signed_path = deriveSigned(envelope_supporting_path) || deriveSigned(envelope_storage_path);

  // Validate derived path exists (in preferred bucket)
  if (signed_path) {
    const { data: obj } = await supabase
      .schema("storage")
      .from("objects")
      .select("name")
      .eq("bucket_id", preferredSignedBucket)
      .eq("name", signed_path)
      .maybeSingle();

    if (!obj?.name) signed_path = "";
  }

  // 6) Search storage schema (preferred bucket, then ANY)
  let foundBucket = preferredSignedBucket;

  if (!signed_path) {
    const { found, error: searchErr } = await findSignedObjectPath(record_id, preferredSignedBucket);
    if (!found) {
      return json(
        {
          ok: false,
          error: "Failed to locate signed PDF in storage",
          record_id,
          envelope_id: envelope_id || null,
          searched_pattern: `*${record_id}*-signed.pdf`,
          preferred_bucket: preferredSignedBucket,
          search_error: searchErr,
          envelope_supporting_path,
          envelope_storage_path,
          hint:
            `Your SQL proves it exists in storage.objects. If this still fails, it means your function is searching a different project/bucket ` +
            `or the storage schema call is blocked/misconfigured. Use supabase.schema("storage").from("objects") exactly as above.`,
        },
        404,
      );
    }

    foundBucket = found.bucket;
    signed_path = found.path;
  }

  // 7) Download signed PDF bytes
  const { data: signedBlob, error: dlErr } = await supabase.storage
    .from(foundBucket)
    .download(signed_path);

  if (dlErr || !signedBlob) {
    return json(
      {
        ok: false,
        error: "Failed to download signed PDF",
        details: dlErr?.message ?? "{}",
        signed_bucket: foundBucket,
        signed_path,
      },
      500,
    );
  }

  const signedBytes = new Uint8Array(await signedBlob.arrayBuffer());
  const pdf_base64 = base64FromBytes(signedBytes);

  // 8) Call archive-save-document
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

  // 9) Best-effort seal into verified registry
  let seal_result: unknown = null;
  {
    const { data: sealData, error: sealErr } = await supabase.rpc(SEAL_RPC_NAME as any, {
      record_id,
    } as any);

    if (sealErr) {
      // non-blocking
      console.warn("seal rpc failed (non-blocking):", sealErr.message);
    } else {
      seal_result = sealData;
    }
  }

  return json({
    ok: true,
    record_id,
    envelope_id: envelope_id || null,
    envelope_status: envelope_status || null,
    lane_is_test,
    signed_bucket: foundBucket,
    signed_path,
    minute_book_bucket: MINUTE_BOOK_BUCKET,
    archive_save_result: saveRes ?? null,
    seal_result,
  });
});
