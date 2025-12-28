// supabase/functions/archive-save-document/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error("Missing Supabase env");

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { global: { fetch } });

const BUCKET = Deno.env.get("MINUTE_BOOK_BUCKET") ?? "minute_book";
const DEFAULT_DOMAIN_KEY = Deno.env.get("DEFAULT_MINUTE_BOOK_DOMAIN_KEY") ?? "governance";
const DEFAULT_SECTION_NAME = Deno.env.get("DEFAULT_MINUTE_BOOK_SECTION_NAME") ?? "Governance";

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
  entity_id?: string;  // optional; if not provided we can derive via governance_ledger
  entity_key?: string; // optional shortcut (holdings/lounge/real-estate)
  is_test?: boolean;   // lane flag (used for path + trace)
  envelope_id?: string;

  // trace
  storage_path?: string;
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
    return json(
      { ok: false, error: "source_record_id and pdf_base64 are required" },
      400,
    );
  }

  const domain_key = (asString(body.domain_key) || DEFAULT_DOMAIN_KEY).trim();
  const section_name = (asString(body.section_name) || DEFAULT_SECTION_NAME).trim();

  // 1) Validate domain_key exists (enterprise guardrail)
  {
    const { data: dom, error: domErr } = await supabase
      .from("governance_domains")
      .select("key")
      .eq("key", domain_key)
      .maybeSingle();
    if (domErr) {
      return json({ ok: false, error: "Failed to validate domain_key", details: domErr.message }, 500);
    }
    if (!dom) {
      return json({ ok: false, error: `Invalid domain_key '${domain_key}'` }, 400);
    }
  }

  // 2) Load governance record (for entity + title + lane truth)
  const { data: ledger, error: ledErr } = await supabase
    .from("governance_ledger")
    .select("id, title, entity_id, is_test")
    .eq("id", source_record_id)
    .maybeSingle();

  if (ledErr) return json({ ok: false, error: "Failed to load governance_ledger", details: ledErr.message }, 500);
  if (!ledger) return json({ ok: false, error: "source_record_id not found in governance_ledger" }, 404);

  const lane_is_test = (ledger.is_test ?? body.is_test ?? false) === true;

  // 3) Resolve entity_key
  let entity_key = asString(body.entity_key);
  if (!entity_key) {
    const entity_id = asString(body.entity_id) || asString(ledger.entity_id);
    if (!entity_id) return json({ ok: false, error: "Missing entity_id" }, 400);

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

  // 4) Decode + hash
  const pdfBytes = base64ToBytes(pdf_base64);
  const hash_hex = await sha256Hex(pdfBytes);

  // 5) Idempotency: if already archived for this source_record_id, return existing
  const { data: existing, error: exErr } = await supabase
    .from("minute_book_entries")
    .select("id")
    .eq("source_record_id", source_record_id)
    .maybeSingle();

  if (exErr) {
    // do not hard fail; continue to attempt insert
    console.warn("archive-save-document: idempotency check failed", exErr.message);
  }
  if (existing?.id) {
    return json({ ok: true, already_archived: true, minute_book_entry_id: existing.id });
  }

  // 6) Create minute_book_entries row
  const { data: mbe, error: mbeErr } = await supabase
    .from("minute_book_entries")
    .insert({
      entity_key,
      domain_key,
      section_name,
      title,
      source_record_id,
      // NOTE: do NOT include sha256 here — your schema does NOT have it.
    })
    .select("id")
    .single();

  if (mbeErr) {
    return json({
      ok: false,
      error: "Failed to insert minute book entry",
      details: mbeErr.message,
    }, 400);
  }

  const entry_id = mbe.id as string;

  // 7) Upload PDF to storage using lane-safe path
  const safeTitle = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80);

  const lanePrefix = lane_is_test ? "sandbox" : "rot";
  const storage_path =
    `${entity_key}/${lanePrefix}/${domain_key}/${entry_id}/${safeTitle || "resolution"}.pdf`;

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(storage_path, pdfBytes, {
      contentType: "application/pdf",
      upsert: true,
    });

  if (upErr) {
    return json({ ok: false, error: "Failed to upload PDF to storage", details: upErr.message }, 500);
  }

  // 8) Insert supporting_documents PRIMARY (THIS is where hash belongs)
  const { error: sdErr } = await supabase
    .from("supporting_documents")
    .insert({
      entity_key,
      minute_book_entry_id: entry_id,
      is_primary: true,
      storage_path,
      file_name: `${safeTitle || "resolution"}.pdf`,
      mime_type: "application/pdf",
      sha256: hash_hex,
      source_record_id,
      // optional trace
      envelope_id: asString(body.envelope_id) || null,
    });

  if (sdErr) {
    return json({
      ok: false,
      error: "Minute book entry created but failed to insert supporting_documents",
      details: sdErr.message,
      minute_book_entry_id: entry_id,
      storage_path,
    }, 500);
  }

  return json({
    ok: true,
    minute_book_entry_id: entry_id,
    already_archived: false,
    entity_key,
    domain_key,
    section_name,
    is_test: lane_is_test,
    storage_path,
    sha256: hash_hex,
  });
});
