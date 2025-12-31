// supabase/functions/archive-save-document/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  corsHeaders,
  json,
  serviceClient,
  resolveActorUserId,
  getEntityKeyFromEntityId,
  minuteBookPrimaryPath,
  ensureMinuteBookEntry,
  upsertSupportingPrimary,
} from "../_shared/archive.ts";

type ReqBody = {
  record_id: string;        // governance_ledger.id
  envelope_id?: string;     // signature_envelopes.id (optional)
};

const MINUTE_BOOK_BUCKET = "minute_book";
const SEAL_RPC = "seal_governance_record_for_archive";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const sb = serviceClient();
    const body = (await req.json().catch(() => ({}))) as Partial<ReqBody>;

    if (!body.record_id) return json({ ok: false, error: "Missing record_id" }, 400);

    // Load ledger row
    const { data: gl, error: glErr } = await sb
      .from("governance_ledger")
      .select("id, entity_id, title, is_test, created_by, approved_by_council, status")
      .eq("id", body.record_id)
      .single();

    if (glErr || !gl) return json({ ok: false, error: "Ledger not found", details: glErr }, 404);

    // Actor: prefer real user from bearer JWT; fallback to ledger.created_by; final fallback = null (but we require for supporting_documents)
    const actorFromJwt = await resolveActorUserId(req, sb);
    const actor = actorFromJwt ?? (gl.created_by ? String(gl.created_by) : null);
    if (!actor) {
      return json({
        ok: false,
        error: "Cannot resolve actor user id (needed for supporting_documents.uploaded_by/owner_id). Send request with Authorization bearer user JWT.",
      }, 400);
    }

    // Seal + get deterministic archive pointers (bucket/path/hash) + verified_documents upsert
    const { data: sealed, error: sealErr } = await sb.rpc(SEAL_RPC, { p_ledger_id: body.record_id });
    if (sealErr || !sealed) {
      return json({ ok: false, step: SEAL_RPC, error: sealErr?.message ?? "seal failed", details: sealErr }, 500);
    }

    const storage_bucket = sealed.storage_bucket as string | null;
    const storage_path = sealed.storage_path as string | null;
    const file_hash = sealed.file_hash as string | null;

    if (!storage_bucket || !storage_path || !file_hash) {
      return json({ ok: false, error: "Seal did not return bucket/path/hash", sealed }, 500);
    }

    // Download sealed artifact
    const dl = await sb.storage.from(storage_bucket).download(storage_path);
    if (dl.error || !dl.data) {
      return json({ ok: false, error: "Failed to download sealed PDF", details: dl.error }, 500);
    }
    const bytes = new Uint8Array(await dl.data.arrayBuffer());

    // Derive entity_key enum from entities.slug
    const entity_key = await getEntityKeyFromEntityId(String(gl.entity_id), sb);

    // Section enum label (doc_section_enum). Use the canonical label you already have.
    const section = "Resolutions";

    // Upload/copy into minute_book bucket using your canonical path
    const mbPath = minuteBookPrimaryPath(entity_key, section, body.record_id, true);
    const up = await sb.storage.from(MINUTE_BOOK_BUCKET).upload(mbPath, bytes, {
      contentType: "application/pdf",
      upsert: true,
    });
    if (up.error) {
      return json({ ok: false, error: "Failed to upload to minute_book", details: up.error }, 500);
    }

    // Ensure minute_book_entries exists
    const entry_id = await ensureMinuteBookEntry({
      sb,
      entity_id: String(gl.entity_id),
      entity_key,                 // entity_key_enum
      domain_key: "governance",    // your minute_book_entries.domain_key (text)
      title: String(gl.title ?? "Untitled"),
      is_test: Boolean(gl.is_test),
      source_record_id: body.record_id,
    });

    // Resolve envelope_id if missing
    let envelope_id = body.envelope_id ?? null;
    if (!envelope_id) {
      const { data: envRow } = await sb
        .from("signature_envelopes")
        .select("id")
        .eq("record_id", body.record_id)
        .order("created_at", { ascending: false })
        .limit(1);
      envelope_id = envRow?.[0]?.id ?? null;
    }

    // Upsert/repair supporting_documents primary row
    await upsertSupportingPrimary({
      sb,
      entry_id,
      entity_key,
      section,
      file_path: mbPath,
      file_name: mbPath.split("/").pop() ?? `${body.record_id}-signed.pdf`,
      file_hash,
      mime_type: "application/pdf",
      file_size: bytes.byteLength,
      signature_envelope_id: envelope_id,
      uploaded_by: actor,
      owner_id: actor,
      metadata: {
        source: "archive-save-document",
        ledger_id: body.record_id,
        envelope_id,
        sealed_bucket: storage_bucket,
        sealed_path: storage_path,
        sealed_hash: file_hash,
        is_test: Boolean(gl.is_test),
      },
    });

    return json({
      ok: true,
      record_id: body.record_id,
      entry_id,
      minute_book_bucket: MINUTE_BOOK_BUCKET,
      minute_book_path: mbPath,
      verified: {
        storage_bucket,
        storage_path,
        file_hash,
        verified_document_id: sealed.verified_document_id ?? null,
      },
      sealed_status: sealed.status ?? null,
    });
  } catch (e) {
    return json({ ok: false, error: String(e?.message ?? e), stack: String(e?.stack ?? "") }, 500);
  }
});
