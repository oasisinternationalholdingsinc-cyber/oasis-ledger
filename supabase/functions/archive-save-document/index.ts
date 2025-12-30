import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { decodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";

type ReqBody = {
  source_record_id: string;     // governance_ledger.id
  pdf_base64: string;           // base64 bytes (no data: prefix)
  title: string;

  entity_id: string;            // uuid
  entity_key: string;           // entity_key_enum label: "holdings" | "lounge" | "real-estate"
  is_test?: boolean;

  domain_key: string;           // e.g. "governance"
  section_name?: string;        // display label (minute_book_entries)
  entry_type?: string;          // entry_type_enum label; default "resolution"
  entry_date?: string;          // YYYY-MM-DD
  bucket?: string;              // default "minute_book"

  // ✅ REQUIRED for supporting_documents (because service_role => auth.uid() NULL)
  actor_id: string;             // auth.users.id (uuid)
  signature_envelope_id?: string; // signature_envelopes.id (uuid)
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
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
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

    // ✅ critical: needed for supporting_documents NOT NULL columns
    if (!body.actor_id) return json({ ok: false, error: "actor_id required" }, 400);

    // Decode + hash
    const pdfBytes = b64ToBytes(body.pdf_base64);
    const file_hash = await sha256Hex(pdfBytes);
    const file_size = pdfBytes.byteLength;
    const mime_type = "application/pdf";

    // Lane-safe deterministic path
    const lanePrefix = is_test ? "sandbox" : "rot";
    const titleSlug = safeSlug(body.title) || "document";
    const storage_path =
      `${lanePrefix}/${body.entity_key}/${body.domain_key}/${body.source_record_id}/${titleSlug}.pdf`;

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

    let entryId = existingEntry?.id as string | undefined;

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
          storage_path,
          pdf_hash: file_hash,
        })
        .select("id")
        .single();

      if (ins.error) {
        return json({ ok: false, error: "minute_book_entries insert failed", details: ins.error.message }, 500);
      }
      entryId = ins.data.id as string;
    } else {
      // Repair pointers if missing
      if (!existingEntry?.storage_path || !existingEntry?.pdf_hash) {
        const updEntry = await supabase
          .from("minute_book_entries")
          .update({ storage_path, pdf_hash: file_hash })
          .eq("id", entryId);

        if (updEntry.error) {
          return json({ ok: false, error: "minute_book_entries pointer repair failed", details: updEntry.error.message }, 500);
        }
      }
    }

    // 2) Upload object if missing
    const { data: existingObj, error: objErr } = await supabase
      .schema("storage")
      .from("objects")
      .select("id")
      .eq("bucket_id", bucket)
      .eq("name", storage_path)
      .maybeSingle();

    if (objErr) {
      return json({ ok: false, error: "storage.objects select failed", details: objErr.message }, 500);
    }

    if (!existingObj) {
      const up = await supabase.storage.from(bucket).upload(storage_path, pdfBytes, {
        contentType: mime_type,
        cacheControl: "3600",
        upsert: false,
      });

      if (up.error && !String(up.error.message || "").toLowerCase().includes("already exists")) {
        return json({ ok: false, error: "storage upload failed", details: up.error.message }, 500);
      }
    }

    // 3) supporting_documents PRIMARY POINTER (your schema)
    //    - file_path is the pointer your UI needs
    //    - uploaded_by/owner_id must be set explicitly (service_role => auth.uid() NULL)
    const { data: existingDoc, error: docSelErr } = await supabase
      .from("supporting_documents")
      .select("id, file_path, file_hash")
      .eq("entry_id", entryId)
      .eq("file_path", storage_path)
      .maybeSingle();

    if (docSelErr) {
      return json({ ok: false, error: "supporting_documents select failed", details: docSelErr.message }, 500);
    }

    if (!existingDoc) {
      const docIns = await supabase
        .from("supporting_documents")
        .insert({
          entry_id: entryId,
          entity_key: body.entity_key,     // enum
          section: body.domain_key,        // ⚠ assumes enum contains "governance" etc (your domain keys)
          file_path: storage_path,
          file_name: `${titleSlug}.pdf`,
          doc_type: "primary",
          file_hash,
          mime_type,
          file_size,
          signature_envelope_id: body.signature_envelope_id ?? null,
          uploaded_by: body.actor_id,
          owner_id: body.actor_id,
          metadata: {},
        })
        .select("id")
        .single();

      if (docIns.error) {
        return json({ ok: false, error: "supporting_documents insert failed", details: docIns.error.message }, 500);
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
