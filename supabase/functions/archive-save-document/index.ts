import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { decodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";

type ReqBody = {
  source_record_id: string;      // governance_ledger.id
  pdf_base64: string;            // raw base64 (no data: prefix)
  title: string;

  entity_id: string;             // uuid
  entity_key: string;            // entity_key_enum label (e.g. "holdings")
  is_test?: boolean;

  domain_key: string;            // e.g. "governance"
  section_name?: string;         // minute_book_entries.section_name (text)
  entry_type?: string;           // minute_book_entries.entry_type enum label
  entry_date?: string;           // YYYY-MM-DD

  // For supporting_documents
  signature_envelope_id?: string; // signature_envelopes.id (uuid), optional
  doc_type?: string;              // optional text, stored in supporting_documents.doc_type
  section?: string;               // supporting_documents.section enum label (REQUIRED by schema)
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { global: { fetch } });

const MINUTE_BOOK_BUCKET = "minute_book";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (x: unknown, s = 200) =>
  new Response(JSON.stringify(x, null, 2), {
    status: s,
    headers: { ...cors, "Content-Type": "application/json" },
  });

function safeSlug(input: string) {
  return (input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
}

function b64ToBytes(b64: string): Uint8Array {
  const clean = b64.includes(",") ? b64.split(",").pop()! : b64;
  return decodeBase64(clean);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const arr = new Uint8Array(hash);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}

serve(async (req) => {
  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

    const body = (await req.json()) as ReqBody;

    const is_test = Boolean(body.is_test);
    const entry_type = body.entry_type ?? "resolution";
    const section_name = body.section_name ?? "Governance";
    const entry_date = body.entry_date ?? new Date().toISOString().slice(0, 10);

    // supporting_documents.section is REQUIRED and is an enum in your schema.
    // In practice for governance archives, you want "governance".
    const support_section = body.section ?? "governance";

    if (!body.source_record_id) return json({ ok: false, error: "source_record_id required" }, 400);
    if (!body.pdf_base64) return json({ ok: false, error: "pdf_base64 required" }, 400);
    if (!body.title) return json({ ok: false, error: "title required" }, 400);
    if (!body.entity_id) return json({ ok: false, error: "entity_id required" }, 400);
    if (!body.entity_key) return json({ ok: false, error: "entity_key required" }, 400);
    if (!body.domain_key) return json({ ok: false, error: "domain_key required" }, 400);

    // Decode + hash
    const pdfBytes = b64ToBytes(body.pdf_base64);
    const file_hash = await sha256Hex(pdfBytes);
    const file_size = pdfBytes.byteLength;
    const mime_type = "application/pdf";

    // Canonical, deterministic path (lane-safe)
    const lanePrefix = is_test ? "sandbox" : "rot";
    const titleSlug = safeSlug(body.title) || "document";
    const file_path = `${lanePrefix}/${body.entity_key}/${body.domain_key}/${body.source_record_id}/${titleSlug}.pdf`;

    // 1) Minute book entry (idempotent by entity_id + source_record_id + is_test)
    const { data: existingEntry, error: existingErr } = await supabase
      .from("minute_book_entries")
      .select("id, storage_path, pdf_hash, domain_key, section_name")
      .eq("entity_id", body.entity_id)
      .eq("source_record_id", body.source_record_id)
      .eq("is_test", is_test)
      .maybeSingle();

    if (existingErr) {
      return json({ ok: false, error: "minute_book_entries select failed", details: existingErr.message }, 500);
    }

    let entryId = existingEntry?.id as string | undefined;

    if (!entryId) {
      const ins = await supabase
        .from("minute_book_entries")
        .insert({
          entity_id: body.entity_id,
          entity_key: body.entity_key,
          domain_key: body.domain_key,
          section_name,
          title: body.title,
          source_record_id: body.source_record_id,
          entry_type,
          entry_date,
          is_test,
          storage_path: file_path, // pointer
          pdf_hash: file_hash,     // pointer
          source: "signed_resolution",
          source_envelope_id: body.signature_envelope_id ?? null,
        })
        .select("id")
        .single();

      if (ins.error) {
        return json({ ok: false, error: "minute_book_entries insert failed", details: ins.error.message }, 500);
      }
      entryId = ins.data.id as string;
    } else {
      // Repair missing pointers on the entry
      const needsRepair =
        !existingEntry?.storage_path ||
        existingEntry.storage_path !== file_path ||
        !existingEntry?.pdf_hash ||
        existingEntry.pdf_hash !== file_hash;

      if (needsRepair) {
        const upd = await supabase
          .from("minute_book_entries")
          .update({
            storage_path: file_path,
            pdf_hash: file_hash,
            domain_key: body.domain_key,
            section_name,
            source_envelope_id: body.signature_envelope_id ?? null,
          })
          .eq("id", entryId);

        if (upd.error) {
          return json({ ok: false, error: "minute_book_entries repair failed", details: upd.error.message }, 500);
        }
      }
    }

    // 2) Ensure object exists (upload only if missing)
    const { data: existingObj, error: objErr } = await supabase
      .schema("storage")
      .from("objects")
      .select("id")
      .eq("bucket_id", MINUTE_BOOK_BUCKET)
      .eq("name", file_path)
      .maybeSingle();

    if (objErr) {
      return json({ ok: false, error: "storage.objects select failed", details: objErr.message }, 500);
    }

    if (!existingObj) {
      const up = await supabase.storage.from(MINUTE_BOOK_BUCKET).upload(file_path, pdfBytes, {
        contentType: mime_type,
        cacheControl: "3600",
        upsert: false,
      });

      if (up.error && !String(up.error.message || "").toLowerCase().includes("already exists")) {
        return json({ ok: false, error: "storage upload failed", details: up.error.message }, 500);
      }
    }

    // 3) supporting_documents (THIS is what your UI Reader needs)
    // Your schema uses: file_path (text), file_hash, mime_type, file_size, signature_envelope_id, metadata...
    const { data: supportDoc, error: sdSelErr } = await supabase
      .from("supporting_documents")
      .select("id, file_path, file_hash")
      .eq("entry_id", entryId)
      .eq("file_path", file_path)
      .maybeSingle();

    if (sdSelErr) {
      return json({ ok: false, error: "supporting_documents select failed", details: sdSelErr.message }, 500);
    }

    if (!supportDoc) {
      const sdIns = await supabase
        .from("supporting_documents")
        .insert({
          entry_id: entryId,
          entity_key: body.entity_key,         // enum
          section: support_section,            // enum (REQUIRED)
          file_path,                           // REQUIRED
          file_name: `${titleSlug}.pdf`,
          doc_type: body.doc_type ?? "signed_resolution",
          file_hash,
          mime_type,
          file_size,
          signature_envelope_id: body.signature_envelope_id ?? null,
          metadata: { role: "primary", bucket: MINUTE_BOOK_BUCKET, lane: is_test ? "SANDBOX" : "ROT" },
          registry_visible: true,
          verified: true,
        })
        .select("id")
        .single();

      if (sdIns.error) {
        return json({ ok: false, error: "supporting_documents insert failed", details: sdIns.error.message }, 500);
      }
    } else {
      const needsSdRepair =
        !supportDoc.file_hash || supportDoc.file_hash !== file_hash;

      if (needsSdRepair) {
        const sdUpd = await supabase
          .from("supporting_documents")
          .update({
            file_hash,
            mime_type,
            file_size,
            file_name: `${titleSlug}.pdf`,
            signature_envelope_id: body.signature_envelope_id ?? null,
            metadata: { role: "primary", bucket: MINUTE_BOOK_BUCKET, lane: is_test ? "SANDBOX" : "ROT" },
            verified: true,
            registry_visible: true,
          })
          .eq("id", supportDoc.id);

        if (sdUpd.error) {
          return json({ ok: false, error: "supporting_documents repair failed", details: sdUpd.error.message }, 500);
        }
      }
    }

    return json({
      ok: true,
      entry_id: entryId,
      storage: { bucket: MINUTE_BOOK_BUCKET, path: file_path, file_hash, file_size, mime_type },
      lane: is_test ? "SANDBOX" : "ROT",
    });
  } catch (e: any) {
    return json({ ok: false, error: e?.message ?? "Unhandled error" }, 500);
  }
});
