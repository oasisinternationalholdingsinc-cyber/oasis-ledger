import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { decodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";

type ReqBody = {
  source_record_id: string; // governance_ledger.id (or other source id)
  pdf_base64: string; // base64 PDF bytes (no data: prefix)
  title: string;

  entity_id: string; // uuid
  entity_key: string; // entity_key_enum label (e.g. "holdings" | "lounge" | "real-estate")
  is_test?: boolean;

  domain_key: string; // e.g. "governance"
  section?: string; // supporting_documents.section enum label (defaults to domain_key)
  section_name?: string; // minute_book_entries.section_name (text, optional)
  entry_type?: string; // minute_book_entries.entry_type enum label; defaults "resolution"
  entry_date?: string; // YYYY-MM-DD
  bucket?: string; // default "minute_book"

  // IMPORTANT for supporting_documents (NOT NULL defaults to auth.uid() which is NULL under service_role)
  uploaded_by?: string; // uuid of user
  owner_id?: string; // uuid of user (defaults to uploaded_by)
  signature_envelope_id?: string; // optional uuid
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { global: { fetch } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(x: unknown, status = 200) {
  return new Response(JSON.stringify(x, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

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

async function resolveUploaderId(source_record_id: string): Promise<string | null> {
  // Best effort: pull created_by from governance_ledger if it exists in your schema
  try {
    const { data } = await supabase
      .from("governance_ledger")
      .select("created_by")
      .eq("id", source_record_id)
      .maybeSingle();
    const v = (data as any)?.created_by ?? null;
    return v;
  } catch {
    return null;
  }
}

serve(async (req) => {
  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

    const body = (await req.json()) as ReqBody;

    const bucket = body.bucket ?? "minute_book";
    const entry_type = body.entry_type ?? "resolution";
    const section_name = body.section_name ?? "Governance";
    const entry_date = body.entry_date ?? new Date().toISOString().slice(0, 10);
    const is_test = Boolean(body.is_test);

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

    // Canonical, lane-safe storage path
    const lanePrefix = is_test ? "sandbox" : "rot";
    const titleSlug = safeSlug(body.title) || "document";
    const storage_path = `${lanePrefix}/${body.entity_key}/${body.domain_key}/${body.source_record_id}/${titleSlug}.pdf`;

    // 1) Minute book entry idempotent by (entity_id, source_record_id, is_test)
    const { data: existingEntry, error: existingErr } = await supabase
      .from("minute_book_entries")
      .select("id, storage_path, pdf_hash")
      .eq("entity_id", body.entity_id)
      .eq("source_record_id", body.source_record_id)
      .eq("is_test", is_test)
      .maybeSingle();

    if (existingErr) {
      return json({ ok: false, error: "minute_book_entries select failed", details: existingErr.message }, 500);
    }

    let entryId = (existingEntry as any)?.id as string | undefined;

    if (!entryId) {
      const ins = await supabase
        .from("minute_book_entries")
        .insert({
          entity_id: body.entity_id,
          entity_key: body.entity_key, // enum label
          domain_key: body.domain_key,
          section_name,
          title: body.title,
          source_record_id: body.source_record_id,
          entry_type,
          entry_date,
          is_test,
          storage_path, // keep entry pointers hot
          pdf_hash: file_hash,
        })
        .select("id")
        .single();

      if (ins.error) {
        return json({ ok: false, error: "minute_book_entries insert failed", details: ins.error.message }, 500);
      }
      entryId = ins.data.id as string;
    } else {
      // Repair pointers if missing/regressed
      const needsEntryRepair =
        !(existingEntry as any)?.storage_path ||
        !(existingEntry as any)?.pdf_hash ||
        (existingEntry as any)?.storage_path !== storage_path ||
        (existingEntry as any)?.pdf_hash !== file_hash;

      if (needsEntryRepair) {
        const upd = await supabase
          .from("minute_book_entries")
          .update({ storage_path, pdf_hash: file_hash })
          .eq("id", entryId);

        if (upd.error) {
          return json({ ok: false, error: "minute_book_entries repair failed", details: upd.error.message }, 500);
        }
      }
    }

    // 2) Upload PDF (repair-capable: upsert=true is OK because storage_path is deterministic)
    const up = await supabase.storage.from(bucket).upload(storage_path, pdfBytes, {
      contentType: mime_type,
      cacheControl: "3600",
      upsert: true,
    });

    if (up.error) {
      return json({ ok: false, error: "storage upload failed", details: up.error.message }, 500);
    }

    // 3) supporting_documents PRIMARY (THIS is what your Reader depends on)
    // Your schema: file_path (NOT storage_path), required: uploaded_by + owner_id (auth.uid() is NULL under service_role)
    let uploaded_by = body.uploaded_by ?? null;
    if (!uploaded_by) uploaded_by = await resolveUploaderId(body.source_record_id);

    if (!uploaded_by) {
      return json(
        {
          ok: false,
          error:
            "supporting_documents requires uploaded_by/owner_id, but none could be resolved. Pass uploaded_by from the app (user id) or ensure governance_ledger.created_by exists.",
        },
        400,
      );
    }

    const owner_id = body.owner_id ?? uploaded_by;
    const section = body.section ?? body.domain_key; // must match supporting_documents.section enum label in your DB

    const { data: primaryDoc, error: primaryErr } = await supabase
      .from("supporting_documents")
      .select("id, file_path, file_hash")
      .eq("entry_id", entryId)
      .eq("doc_type", "primary")
      .maybeSingle();

    if (primaryErr) {
      return json({ ok: false, error: "supporting_documents select failed", details: primaryErr.message }, 500);
    }

    const docPayload: Record<string, any> = {
      entry_id: entryId,
      entity_key: body.entity_key,
      section,
      file_path: storage_path,
      file_name: `${titleSlug}.pdf`,
      doc_type: "primary",
      version: 1,
      uploaded_by,
      owner_id,
      file_hash,
      mime_type,
      file_size,
      signature_envelope_id: body.signature_envelope_id ?? null,
      metadata: {
        role: "primary",
        bucket,
        source: "archive-save-document",
        lane: is_test ? "SANDBOX" : "ROT",
        source_record_id: body.source_record_id,
      },
    };

    if (!primaryDoc) {
      const docIns = await supabase
        .from("supporting_documents")
        .insert(docPayload)
        .select("id")
        .single();

      if (docIns.error) {
        return json({ ok: false, error: "supporting_documents insert failed", details: docIns.error.message }, 500);
      }
    } else {
      const needsRepair =
        (primaryDoc as any).file_path !== storage_path || (primaryDoc as any).file_hash !== file_hash;

      if (needsRepair) {
        const upd = await supabase
          .from("supporting_documents")
          .update(docPayload)
          .eq("id", (primaryDoc as any).id);

        if (upd.error) {
          return json({ ok: false, error: "supporting_documents repair failed", details: upd.error.message }, 500);
        }
      }
    }

    return json({
      ok: true,
      entry_id: entryId,
      storage: { bucket, path: storage_path, file_hash, file_size, mime_type },
      lane: is_test ? "SANDBOX" : "ROT",
    });
  } catch (e: any) {
    return json({ ok: false, error: e?.message ?? "Unhandled error" }, 500);
  }
});
