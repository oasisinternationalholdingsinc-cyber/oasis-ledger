import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { global: { fetch } });

// Where the FINAL archived/registry PDF should live (Minute Book bucket)
const ARCHIVE_BUCKET = Deno.env.get("MINUTE_BOOK_BUCKET") ?? "minute_book";

// domain_key must exist in governance_domains.key
const DEFAULT_DOMAIN_KEY =
  (Deno.env.get("DEFAULT_MINUTE_BOOK_DOMAIN_KEY") ?? "governance").trim();

const DEFAULT_SECTION_NAME =
  (Deno.env.get("DEFAULT_MINUTE_BOOK_SECTION_NAME") ?? "Resolutions").trim();

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

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const arr = Array.from(new Uint8Array(digest));
  return arr.map((b) => b.toString(16).padStart(2, "0")).join("");
}

type ReqBody = {
  source_record_id?: string;     // governance_ledger.id
  pdf_base64?: string;

  // lane is derived; this is informational + helps views
  is_test?: boolean;

  // REQUIRED for minute_book_entries (NOT NULL)
  domain_key?: string;
  section_name?: string;

  title?: string;
  entity_id?: string;
  envelope_id?: string;

  // traceability only
  signed_bucket?: string;
  signed_storage_path?: string;
};

type Resp = {
  ok: boolean;
  minute_book_entry_id?: string;
  already_archived?: boolean;
  storage_path?: string;
  sha256?: string;
  error?: string;
  details?: unknown;
};

async function ensureValidDomainKey(domain_key: string): Promise<string> {
  const key = domain_key.trim() || DEFAULT_DOMAIN_KEY;

  const { data, error } = await supabase
    .from("governance_domains")
    .select("key")
    .eq("key", key)
    .eq("active", true)
    .maybeSingle();

  if (error) {
    // If the lookup fails, fallback to DEFAULT_DOMAIN_KEY (never return null)
    console.warn("archive-save-document: governance_domains lookup error, falling back", error);
    return DEFAULT_DOMAIN_KEY;
  }

  return data?.key ?? DEFAULT_DOMAIN_KEY;
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  try {
    const body = (await req.json().catch(() => ({}))) as ReqBody;

    const source_record_id = body.source_record_id?.trim();
    const pdf_base64 = body.pdf_base64?.trim();

    if (!source_record_id) return json({ ok: false, error: "Missing source_record_id" }, 400);
    if (!pdf_base64) return json({ ok: false, error: "Missing pdf_base64" }, 400);

    // Load ledger for entity + lane truth (do not mutate it)
    const { data: ledger, error: ledErr } = await supabase
      .from("governance_ledger")
      .select("id, title, entity_id, is_test")
      .eq("id", source_record_id)
      .maybeSingle();

    if (ledErr) {
      console.error("archive-save-document: ledger lookup error", ledErr);
      return json({ ok: false, error: "Failed to load governance_ledger record." }, 500);
    }
    if (!ledger) return json({ ok: false, error: "governance_ledger record not found." }, 404);

    const entity_id = (body.entity_id ?? ledger.entity_id) as string;
    const title = (body.title ?? ledger.title ?? "Resolution").toString();

    // entity_key (slug) for CI-Archive paths
    const { data: ent, error: entErr } = await supabase
      .from("entities")
      .select("slug")
      .eq("id", entity_id)
      .maybeSingle();

    if (entErr || !ent?.slug) {
      console.error("archive-save-document: entity lookup error", entErr);
      return json({ ok: false, error: "Failed to resolve entity slug." }, 500);
    }

    const entity_key = ent.slug as string;

    // domain_key MUST NOT be null
    const domain_key = await ensureValidDomainKey(body.domain_key ?? DEFAULT_DOMAIN_KEY);
    const section_name = (body.section_name?.trim() || DEFAULT_SECTION_NAME).trim();

    // decode + hash
    const pdfBytes = b64ToBytes(pdf_base64);
    const hash = await sha256Hex(pdfBytes);

    // deterministic archive path (lane separation can be in path if you want)
    // NOTE: since minute_book_entries has no is_test, lane is derived from source_record_id joins.
    const storage_path = `${entity_key}/resolutions/${source_record_id}-${hash.slice(0, 16)}.pdf`;

    // Idempotency: if minute_book entry exists for this ledger record, return it
    const { data: existing, error: exErr } = await supabase
      .from("minute_book_entries")
      .select("id, storage_path")
      .eq("entity_key", entity_key)
      .eq("source_record_id", source_record_id)
      .maybeSingle();

    if (exErr) {
      // don’t fail hard, just log
      console.warn("archive-save-document: existing lookup warning", exErr);
    }

    if (existing?.id) {
      return json({
        ok: true,
        minute_book_entry_id: existing.id,
        already_archived: true,
        storage_path: existing.storage_path ?? null,
        sha256: hash,
      } satisfies Resp);
    }

    // Upload PDF to storage
    const { error: upErr } = await supabase.storage.from(ARCHIVE_BUCKET).upload(
      storage_path,
      pdfBytes,
      {
        contentType: "application/pdf",
        upsert: true,
      },
    );

    if (upErr) {
      console.error("archive-save-document: storage upload error", upErr);
      return json({ ok: false, error: "Failed to upload PDF to storage.", details: upErr }, 500);
    }

    // Insert minute_book_entries (domain_key is NOT NULL)
    // NOTE: adjust column names here ONLY if your schema differs.
    const { data: mbe, error: mbeErr } = await supabase
      .from("minute_book_entries")
      .insert({
        entity_key,
        domain_key,
        section_name,
        title,
        entry_type: "resolution",
        source_record_id,
        storage_path,
        sha256: hash,
      })
      .select("id")
      .maybeSingle();

    if (mbeErr || !mbe?.id) {
      console.error("archive-save-document: minute_book_entries insert error", mbeErr);
      return json(
        {
          ok: false,
          error: "Failed to insert minute book entry",
          details: mbeErr ?? null,
        } satisfies Resp,
        400,
      );
    }

    const minute_book_entry_id = mbe.id as string;

    // Insert supporting_documents primary doc (CI-Archive Minute Book depends on this)
    const { error: sdErr } = await supabase.from("supporting_documents").insert({
      entity_key,
      entry_id: minute_book_entry_id,
      storage_path,
      file_name: storage_path.split("/").pop(),
      mime_type: "application/pdf",
      sha256: hash,
      is_primary: true,
      source_record_id,
      source_type: "governance_ledger",
    });

    if (sdErr) {
      console.error("archive-save-document: supporting_documents insert error", sdErr);
      return json(
        {
          ok: false,
          error: "Minute book entry created, but failed to insert supporting document.",
          details: sdErr,
        } satisfies Resp,
        400,
      );
    }

    // Best-effort verified_documents upsert (if table/columns exist)
    // If your verified_documents schema differs, this won’t block archiving.
    try {
      await supabase.from("verified_documents").insert({
        entity_key,
        source_record_id,
        storage_path,
        sha256: hash,
        title,
        doc_type: "resolution",
      });
    } catch {
      // ignore
    }

    return json({
      ok: true,
      minute_book_entry_id,
      already_archived: false,
      storage_path,
      sha256: hash,
    } satisfies Resp);
  } catch (err) {
    console.error("archive-save-document: unexpected", err);
    return json(
      { ok: false, error: err instanceof Error ? err.message : "Unexpected error." },
      500,
    );
  }
});
