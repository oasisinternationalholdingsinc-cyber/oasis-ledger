import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { global: { fetch } });

const MINUTE_BOOK_BUCKET = Deno.env.get("MINUTE_BOOK_BUCKET") ?? "minute_book";

// archived PDF path pattern (lane-safe)
const ARCHIVE_PREFIX_ROT = Deno.env.get("ARCHIVE_PREFIX_ROT") ?? "archive";
const ARCHIVE_PREFIX_SANDBOX = Deno.env.get("ARCHIVE_PREFIX_SANDBOX") ?? "sandbox/archive";

const DEFAULT_DOMAIN_KEY = Deno.env.get("DEFAULT_MINUTE_BOOK_DOMAIN_KEY") ?? "governance";
const DEFAULT_SECTION_NAME = Deno.env.get("DEFAULT_MINUTE_BOOK_SECTION_NAME") ?? "Resolutions";

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

function base64ToUint8Array(b64: string): Uint8Array {
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
  source_record_id?: string; // governance_ledger.id
  pdf_base64?: string;

  // ✅ required to satisfy minute_book_entries.domain_key NOT NULL
  domain_key?: string;
  section_name?: string;

  // lane + context
  is_test?: boolean;

  // optional metadata
  title?: string;
  entity_id?: string;
  envelope_id?: string;

  // traceability only
  signed_bucket?: string;
  signed_storage_path?: string;
};

type ResBody = {
  ok: boolean;
  minute_book_entry_id?: string;
  already_archived?: boolean;
  error?: string;
  details?: unknown;
};

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  try {
    const body = (await req.json().catch(() => ({}))) as ReqBody;

    const source_record_id = body.source_record_id?.trim();
    const pdf_base64 = body.pdf_base64?.trim();

    if (!source_record_id) return json({ ok: false, error: "Missing source_record_id" }, 400);
    if (!pdf_base64) return json({ ok: false, error: "Missing pdf_base64" }, 400);

    const is_test = Boolean(body.is_test);

    // domain_key MUST be non-null for minute_book_entries
    const domain_key = (body.domain_key?.trim() || DEFAULT_DOMAIN_KEY).trim();
    const section_name = (body.section_name?.trim() || DEFAULT_SECTION_NAME).trim();

    // validate domain_key exists
    const { data: dom, error: domErr } = await supabase
      .from("governance_domains")
      .select("key")
      .eq("key", domain_key)
      .maybeSingle();

    if (domErr) return json({ ok: false, error: "Failed to validate governance domain.", details: domErr }, 500);
    if (!dom) return json({ ok: false, error: `Invalid domain_key: "${domain_key}" does not exist in governance_domains.key` }, 400);

    // load ledger record (authoritative source for entity_id/title if not provided)
    const { data: ledger, error: ledErr } = await supabase
      .from("governance_ledger")
      .select("id, title, entity_id, is_test")
      .eq("id", source_record_id)
      .maybeSingle();

    if (ledErr) return json({ ok: false, error: "Failed to load governance_ledger record.", details: ledErr }, 500);
    if (!ledger) return json({ ok: false, error: "governance_ledger record not found for source_record_id" }, 404);

    // lane safety: prefer ledger.is_test if present
    const lane_is_test = Boolean(ledger.is_test ?? is_test);

    // entity slug/key for storage layout + registry (assumes entities table has key/slug)
    const entity_id = String(body.entity_id ?? ledger.entity_id ?? "");
    if (!entity_id) return json({ ok: false, error: "Missing entity_id (could not resolve from governance_ledger)." }, 400);

    const { data: ent, error: entErr } = await supabase
      .from("entities")
      .select("id, key, slug, name")
      .eq("id", entity_id)
      .maybeSingle();

    if (entErr) return json({ ok: false, error: "Failed to load entity.", details: entErr }, 500);
    if (!ent) return json({ ok: false, error: "Entity not found for entity_id." }, 404);

    const entity_key = (ent as any).key ?? (ent as any).slug ?? "entity";

    // compute archive storage path
    const prefix = lane_is_test ? ARCHIVE_PREFIX_SANDBOX : ARCHIVE_PREFIX_ROT;
    const storage_path = `${entity_key}/${prefix}/${source_record_id}.pdf`;

    // decode + hash
    const pdfBytes = base64ToUint8Array(pdf_base64);
    const sha256 = await sha256Hex(pdfBytes);

    // 1) Upload archived PDF (idempotent overwrite is ok for sandbox; RoT should be immutable at seal-time)
    const { error: upErr } = await supabase.storage
      .from(MINUTE_BOOK_BUCKET)
      .upload(storage_path, pdfBytes, {
        contentType: "application/pdf",
        upsert: lane_is_test, // sandbox can overwrite; RoT should normally be immutable elsewhere
      });

    if (upErr) return json({ ok: false, error: "Failed to upload archived PDF to storage.", details: upErr }, 500);

    // 2) Check if already archived (by source_record_id + lane)
    // NOTE: adjust table name if yours differs; this matches your Verified Registry concept.
    const { data: existingV, error: exErr } = await supabase
      .from("verified_documents")
      .select("id")
      .eq("source_record_id", source_record_id)
      .eq("is_test", lane_is_test)
      .maybeSingle();

    if (exErr) {
      // not fatal, but we log
      console.error("archive-save-document: verified_documents lookup failed", exErr);
    }

    // 3) Insert minute_book_entries (THIS is where your domain_key was missing)
    const title = (body.title ?? ledger.title ?? "Archived Resolution").toString();

    const { data: mbe, error: mbeErr } = await supabase
      .from("minute_book_entries")
      .insert({
        entity_key,
        domain_key,          // ✅ REQUIRED (fix)
        section_name,        // optional but nice
        title,
        entry_type: "resolution",
        source_record_id: source_record_id,
        is_test: lane_is_test,
      })
      .select("id")
      .maybeSingle();

    if (mbeErr) {
      console.error("archive-save-document: minute_book_entries insert failed", mbeErr);
      return json(
        { ok: false, error: "Failed to insert minute book entry", details: mbeErr?.message ?? mbeErr },
        400,
      );
    }

    const minute_book_entry_id = mbe?.id as string;

    // 4) supporting_documents (primary doc for registry PDF access)
    const { error: sdErr } = await supabase
      .from("supporting_documents")
      .insert({
        entry_id: minute_book_entry_id,
        bucket: MINUTE_BOOK_BUCKET,
        storage_path,
        sha256,
        is_primary: true,
        is_test: lane_is_test,
        source_record_id,
      });

    if (sdErr) {
      console.error("archive-save-document: supporting_documents insert failed", sdErr);
      return json({ ok: false, error: "Failed to insert supporting document", details: sdErr?.message ?? sdErr }, 400);
    }

    // 5) verified_documents upsert-ish
    if (!existingV?.id) {
      const { error: vErr } = await supabase.from("verified_documents").insert({
        entity_key,
        source_record_id,
        bucket: MINUTE_BOOK_BUCKET,
        storage_path,
        sha256,
        is_test: lane_is_test,
        envelope_id: body.envelope_id ?? null,
        title,
      });

      if (vErr) {
        // not fatal to minute book, but we return it (you want verified registry to be correct)
        console.error("archive-save-document: verified_documents insert failed", vErr);
        return json({ ok: false, error: "Failed to insert verified document", details: vErr?.message ?? vErr }, 400);
      }
    }

    const res: ResBody = {
      ok: true,
      minute_book_entry_id,
      already_archived: Boolean(existingV?.id),
    };
    return json(res, 200);
  } catch (err) {
    console.error("archive-save-document: unexpected", err);
    return json({ ok: false, error: err instanceof Error ? err.message : "Unexpected error" }, 500);
  }
});
