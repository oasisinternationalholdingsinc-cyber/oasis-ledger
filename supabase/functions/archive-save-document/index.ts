import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing Supabase env");
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

const BUCKET = Deno.env.get("MINUTE_BOOK_BUCKET") ?? "minute_book";
const DEFAULT_DOMAIN_KEY =
  Deno.env.get("DEFAULT_MINUTE_BOOK_DOMAIN_KEY") ?? "governance";
const DEFAULT_SECTION_NAME =
  Deno.env.get("DEFAULT_MINUTE_BOOK_SECTION_NAME") ?? "Governance";

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

function asString(v: unknown) {
  return typeof v === "string" ? v.trim() : "";
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

type ReqBody = {
  source_record_id: string; // governance_ledger.id
  pdf_base64: string;

  domain_key?: string;
  section_name?: string;

  title?: string;
  entity_key?: string;
  is_test?: boolean;

  envelope_id?: string;
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return json({ ok: false, error: "POST required" }, 405);
  }

  const body = (await req.json().catch(() => null)) as ReqBody | null;
  if (!body) return json({ ok: false, error: "Invalid JSON" }, 400);

  const source_record_id = asString(body.source_record_id);
  const pdf_base64 = asString(body.pdf_base64);

  if (!source_record_id || !pdf_base64) {
    return json(
      { ok: false, error: "source_record_id and pdf_base64 are required" },
      400,
    );
  }

  const domain_key = asString(body.domain_key) || DEFAULT_DOMAIN_KEY;
  const section_name = asString(body.section_name) || DEFAULT_SECTION_NAME;

  // ─────────────────────────────────────────────
  // Load governance ledger (SINGLE SOURCE OF TRUTH)
  // ─────────────────────────────────────────────
  const { data: ledger, error: ledErr } = await supabase
    .from("governance_ledger")
    .select("id, title, entity_id, is_test")
    .eq("id", source_record_id)
    .maybeSingle();

  if (ledErr) {
    return json({ ok: false, error: "Failed to load ledger", details: ledErr.message }, 500);
  }
  if (!ledger) {
    return json({ ok: false, error: "Ledger record not found" }, 404);
  }

  const is_test = ledger.is_test === true;

  // ─────────────────────────────────────────────
  // Resolve entity_key from entity_id
  // ─────────────────────────────────────────────
  let entity_key = asString(body.entity_key);

  if (!entity_key) {
    const { data: ent, error: entErr } = await supabase
      .from("entities")
      .select("slug")
      .eq("id", ledger.entity_id)
      .maybeSingle();

    if (entErr || !ent?.slug) {
      return json({ ok: false, error: "Failed to resolve entity_key" }, 500);
    }

    entity_key = ent.slug;
  }

  const title = asString(body.title) || ledger.title || "Signed Resolution";

  // ─────────────────────────────────────────────
  // Decode + hash PDF
  // ─────────────────────────────────────────────
  const pdfBytes = base64ToBytes(pdf_base64);
  const sha256 = await sha256Hex(pdfBytes);

  // ─────────────────────────────────────────────
  // Idempotency (same ledger record → same entry)
  // ─────────────────────────────────────────────
  const { data: existing } = await supabase
    .from("minute_book_entries")
    .select("id")
    .eq("source_record_id", source_record_id)
    .maybeSingle();

  if (existing?.id) {
    return json({
      ok: true,
      already_archived: true,
      minute_book_entry_id: existing.id,
    });
  }

  // ─────────────────────────────────────────────
  // INSERT minute_book_entries (EXPLICIT entity_id)
  // entry_type = 'resolution' (Forge output)
  // entry_date = DEFAULT (CURRENT_DATE)
  // ─────────────────────────────────────────────
  const { data: mbe, error: mbeErr } = await supabase
    .from("minute_book_entries")
    .insert({
      entity_id: ledger.entity_id,     // 🔒 REQUIRED
      entity_key,
      domain_key,
      section_name,
      title,
      entry_type: "resolution",
      source_record_id,
    })
    .select("id")
    .single();

  if (mbeErr) {
    return json(
      { ok: false, error: "Failed to insert minute_book_entries", details: mbeErr.message },
      400,
    );
  }

  const entry_id = mbe.id as string;

  // ─────────────────────────────────────────────
  // Storage path (entity + lane + domain safe)
  // ─────────────────────────────────────────────
  const safeTitle = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80);

  const lane = is_test ? "sandbox" : "rot";
  const storage_path =
    `${entity_key}/${lane}/${domain_key}/${entry_id}/${safeTitle || "resolution"}.pdf`;

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(storage_path, pdfBytes, {
      contentType: "application/pdf",
      upsert: true,
    });

  if (upErr) {
    return json(
      { ok: false, error: "Failed to upload PDF", details: upErr.message },
      500,
    );
  }

  // ─────────────────────────────────────────────
  // PRIMARY supporting document (verified)
  // ─────────────────────────────────────────────
  const { error: sdErr } = await supabase
    .from("supporting_documents")
    .insert({
      entity_key,
      minute_book_entry_id: entry_id,
      is_primary: true,
      storage_path,
      file_name: `${safeTitle || "resolution"}.pdf`,
      mime_type: "application/pdf",
      sha256,
      source_record_id,
      envelope_id: body.envelope_id ?? null,
    });

  if (sdErr) {
    return json(
      {
        ok: false,
        error: "Archive partial: supporting_documents insert failed",
        details: sdErr.message,
        minute_book_entry_id: entry_id,
      },
      500,
    );
  }

  return json({
    ok: true,
    minute_book_entry_id: entry_id,
    entity_key,
    domain_key,
    section_name,
    is_test,
    storage_path,
    sha256,
  });
});
