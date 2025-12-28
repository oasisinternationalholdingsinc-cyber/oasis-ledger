import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error("Missing Supabase env");

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { global: { fetch } });

const MINUTE_BOOK_BUCKET = Deno.env.get("MINUTE_BOOK_BUCKET") ?? "minute_book";
const DEFAULT_DOMAIN_KEY = Deno.env.get("DEFAULT_MINUTE_BOOK_DOMAIN_KEY") ?? "governance";
const DEFAULT_SECTION_NAME = Deno.env.get("DEFAULT_MINUTE_BOOK_SECTION_NAME") ?? "Governance";

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

// base64 -> Uint8Array
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// sha256 hex
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const arr = Array.from(new Uint8Array(digest));
  return arr.map((b) => b.toString(16).padStart(2, "0")).join("");
}

type ReqBody = {
  source_record_id?: string; // governance_ledger.id
  pdf_base64?: string;

  // placement
  domain_key?: string;
  section_name?: string;

  // context
  title?: string;
  entity_id?: string;     // optional shortcut
  entity_key?: string;    // optional shortcut (holdings/lounge/real-estate)
  is_test?: boolean;      // lane flag
  envelope_id?: string;

  // optional override
  bucket?: string;
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "POST required" }, 405);

  let body: ReqBody;
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const source_record_id = asString(body.source_record_id);
  const pdf_base64 = asString(body.pdf_base64);
  if (!source_record_id || !pdf_base64) {
    return json({ ok: false, error: "source_record_id and pdf_base64 are required" }, 400);
  }

  const domain_key = (asString(body.domain_key) || DEFAULT_DOMAIN_KEY).trim();
  const section_name = (asString(body.section_name) || DEFAULT_SECTION_NAME).trim();
  const bucket = asString(body.bucket) || MINUTE_BOOK_BUCKET;

  // 1) Validate domain_key exists
  {
    const { data: dom, error: domErr } = await supabase
      .from("governance_domains")
      .select("key")
      .eq("key", domain_key)
      .maybeSingle();

    if (domErr) return json({ ok: false, error: "Failed to validate domain_key", details: domErr.message }, 500);
    if (!dom) return json({ ok: false, error: `Invalid domain_key '${domain_key}'` }, 400);
  }

  // 2) Load governance record (truth source for entity_id + lane + title)
  const { data: ledger, error: ledErr } = await supabase
    .from("governance_ledger")
    .select("id, title, entity_id, is_test")
    .eq("id", source_record_id)
    .maybeSingle();

  if (ledErr) return json({ ok: false, error: "Failed to load governance_ledger", details: ledErr.message }, 500);
  if (!ledger) return json({ ok: false, error: "source_record_id not found in governance_ledger" }, 404);

  const lane_is_test = (ledger.is_test ?? body.is_test ?? false) === true;

  // 3) Resolve entity_id
  const entity_id = asString(body.entity_id) || asString(ledger.entity_id);
  if (!entity_id) return json({ ok: false, error: "Missing entity_id" }, 400);

  // 4) Resolve entity_key (enum)
  let entity_key = asString(body.entity_key);
  if (!entity_key) {
    const { data: ent, error: entErr } = await supabase
      .from("entities")
      .select("slug")
      .eq("id", entity_id)
      .maybeSingle();

    if (entErr) return json({ ok: false, error: "Failed to resolve entity", details: entErr.message }, 500);
    if (!ent?.slug) return json({ ok: false, error: "Could not resolve entity_key from entities.slug" }, 400);

    entity_key = ent.slug;
  }

  const title = asString(body.title) || asString(ledger.title) || "Signed Resolution";

  // 5) Decode + hash
  const pdfBytes = base64ToBytes(pdf_base64);
  const hash_hex = await sha256Hex(pdfBytes);

  // 6) Idempotency (lane-safe): source_record_id + is_test
  const { data: existing, error: exErr } = await supabase
    .from("minute_book_entries")
    .select("id, storage_path, file_name, pdf_hash")
    .eq("source_record_id", source_record_id)
    .eq("is_test", lane_is_test)
    .maybeSingle();

  if (exErr) console.warn("archive-save-document: idempotency check failed", exErr.message);

  // helper for path pieces
  const safeTitle = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80);

  const lanePrefix = lane_is_test ? "sandbox" : "rot";
  const file_name = `${safeTitle || "resolution"}.pdf`;

  // NOTE: keep your existing path style:
  // <entity_key>/<lane>/<domain>/<entry_id>/<file>
  // We need entry_id to compute the final path, so for "existing" we’ll reuse its current storage_path if present.
  // If missing, we’ll compute a new one (using entry_id).

  let entry_id: string;

  // 7) Create or reuse minute_book_entries row
  if (existing?.id) {
    entry_id = existing.id;
  } else {
    const { data: mbe, error: mbeErr } = await supabase
      .from("minute_book_entries")
      .insert({
        entity_id,
        entity_key: entity_key as any, // enum
        domain_key,
        section_name,
        title,
        source_record_id,
        source_envelope_id: asString(body.envelope_id) || null,
        is_test: lane_is_test,

        // explicitly set these so NOT NULL / UI expectations are always satisfied
        entry_type: "resolution" as any, // long-term: you can pass this in later; for now keep canonical
        entry_date: new Date().toISOString().slice(0, 10), // YYYY-MM-DD (safe even if default exists)
      })
      .select("id")
      .single();

    if (mbeErr) {
      return json({ ok: false, error: "Failed to insert minute book entry", details: mbeErr.message }, 400);
    }

    entry_id = mbe.id as string;
  }

  // 8) Upload PDF to storage
  const storage_path =
    existing?.storage_path ||
    `${entity_key}/${lanePrefix}/${domain_key}/${entry_id}/${file_name}`;

  const { error: upErr } = await supabase.storage
    .from(bucket)
    .upload(storage_path, pdfBytes, {
      contentType: "application/pdf",
      upsert: true,
    });

  if (upErr) {
    return json({ ok: false, error: "Failed to upload PDF to storage", details: upErr.message }, 500);
  }

  // 9) Update minute_book_entries with primary doc pointers (THIS FIXES OPEN/DOWNLOAD)
  {
    const { error: updErr } = await supabase
      .from("minute_book_entries")
      .update({
        storage_path,
        file_name,
        pdf_hash: hash_hex,
        source_envelope_id: asString(body.envelope_id) || null,
        is_test: lane_is_test,
      })
      .eq("id", entry_id);

    if (updErr) {
      return json(
        {
          ok: false,
          error: "Uploaded PDF but failed to update minute_book_entries pointers",
          details: updErr.message,
          minute_book_entry_id: entry_id,
          storage_path,
        },
        500,
      );
    }
  }

  // 10) Upsert supporting_documents PRIMARY
  // (If you already have unique constraints, this stays safe. If not, we still keep it best-effort.)
  {
    // Try delete existing primary for this entry to prevent duplicates (safe even if none)
    await supabase
      .from("supporting_documents")
      .delete()
      .eq("minute_book_entry_id", entry_id)
      .eq("is_primary", true);

    const { error: sdErr } = await supabase
      .from("supporting_documents")
      .insert({
        entity_key,
        minute_book_entry_id: entry_id,
        is_primary: true,
        storage_path,
        file_name,
        mime_type: "application/pdf",
        sha256: hash_hex,
        source_record_id,
        envelope_id: asString(body.envelope_id) || null,
      });

    if (sdErr) {
      return json(
        {
          ok: false,
          error: "Minute book entry created but failed to insert supporting_documents",
          details: sdErr.message,
          minute_book_entry_id: entry_id,
          storage_path,
        },
        500,
      );
    }
  }

  return json({
    ok: true,
    minute_book_entry_id: entry_id,
    already_archived: !!existing?.id,
    entity_id,
    entity_key,
    domain_key,
    section_name,
    is_test: lane_is_test,
    storage_path,
    file_name,
    sha256: hash_hex,
  });
});
