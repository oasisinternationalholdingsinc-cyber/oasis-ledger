// supabase/functions/archive-save-document/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { cors, json, readJson, getServiceClient, rpcOrThrow } from "../_shared/archive.ts";

type ReqBody = {
  record_id: string; // governance_ledger.id
};

type SealResult = {
  status: "archived" | "already_sealed";
  ledger_id: string;
  verified_document_id: string | null;
  storage_bucket: string;
  storage_path: string;
  file_hash: string;
  file_size: number;
  mime_type: string;
  document_class?: string;
  verification_level?: string;
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  try {
    const body = await readJson<ReqBody>(req);
    const recordId = body.record_id?.trim();
    if (!recordId) return json({ ok: false, error: "Missing record_id" }, 400);

    const sb = getServiceClient();

    // 1) Load ledger row (authoritative lane/is_test)
    const { data: gl, error: glErr } = await sb
      .from("governance_ledger")
      .select("id, entity_id, title, record_type, approved_by_council, archived, locked, is_test")
      .eq("id", recordId)
      .maybeSingle();

    if (glErr) throw new Error(`load_ledger: ${glErr.message}`);
    if (!gl) return json({ ok: false, error: `Ledger not found: ${recordId}` }, 404);
    if (!gl.approved_by_council) {
      return json(
        { ok: false, error: "Not eligible for archive (approved_by_council=false)", record_id: recordId },
        400,
      );
    }

    // 2) SEAL (service_role) — this is the ONLY place that flips archived/locked + upserts verified_documents
    const seal = await rpcOrThrow<SealResult>(
      sb,
      "seal_governance_record_for_archive",
      { p_ledger_id: recordId },
      "seal_governance_record_for_archive",
    );

    // 3) Repair / create minute_book_entries (idempotent)
    //    NOTE: Adjust the domain_key/section if you want different taxonomy — but this is safe/default.
    const entityId = gl.entity_id as string;
    const isTest = !!gl.is_test;

    // Try to find existing minute book entry by source_record_id + entity_id + is_test
    const { data: existingEntry, error: entryFindErr } = await sb
      .from("minute_book_entries")
      .select("id")
      .eq("source_record_id", recordId)
      .eq("entity_id", entityId)
      .eq("is_test", isTest)
      .maybeSingle();

    if (entryFindErr) throw new Error(`minute_book_find: ${entryFindErr.message}`);

    let entryId: string;

    if (existingEntry?.id) {
      entryId = existingEntry.id;
      const { error: entryUpdErr } = await sb
        .from("minute_book_entries")
        .update({
          title: gl.title ?? "Untitled",
          domain_key: "governance",
          entry_type: "resolution",
          // these two are the important ones for Reader access:
          storage_bucket: seal.storage_bucket,
          storage_path: seal.storage_path,
          pdf_hash: seal.file_hash,
        })
        .eq("id", entryId);

      if (entryUpdErr) throw new Error(`minute_book_update: ${entryUpdErr.message}`);
    } else {
      // derive entity_key enum from entities.slug (common pattern in your schema)
      const { data: ent, error: entErr } = await sb
        .from("entities")
        .select("slug")
        .eq("id", entityId)
        .maybeSingle();
      if (entErr) throw new Error(`entity_lookup: ${entErr.message}`);

      const { data: inserted, error: entryInsErr } = await sb
        .from("minute_book_entries")
        .insert({
          entity_id: entityId,
          entity_key: ent?.slug, // assumes slug matches enum label; if your column is strict enum, keep this aligned
          domain_key: "governance",
          entry_type: "resolution",
          title: gl.title ?? "Untitled",
          section: "Governance Ledger",
          source_record_id: recordId,
          is_test: isTest,
          // primary pointers for Reader:
          storage_bucket: seal.storage_bucket,
          storage_path: seal.storage_path,
          pdf_hash: seal.file_hash,
        })
        .select("id")
        .single();

      if (entryInsErr) throw new Error(`minute_book_insert: ${entryInsErr.message}`);
      entryId = inserted.id;
    }

    // 4) Ensure supporting_documents has the PRIMARY row the Registry UI depends on (idempotent repair)
    //    If your schema uses different column names, THIS is the only part to rename.
    const { data: primaryDoc, error: docFindErr } = await sb
      .from("supporting_documents")
      .select("id")
      .eq("entry_id", entryId)
      .eq("is_primary", true)
      .maybeSingle();

    if (docFindErr) throw new Error(`supporting_find: ${docFindErr.message}`);

    if (primaryDoc?.id) {
      const { error: docUpdErr } = await sb
        .from("supporting_documents")
        .update({
          storage_bucket: seal.storage_bucket,
          storage_path: seal.storage_path,
          file_hash: seal.file_hash,
          file_size: seal.file_size,
          mime_type: seal.mime_type,
        })
        .eq("id", primaryDoc.id);

      if (docUpdErr) throw new Error(`supporting_update: ${docUpdErr.message}`);
    } else {
      const { error: docInsErr } = await sb.from("supporting_documents").insert({
        entry_id: entryId,
        is_primary: true,
        title: gl.title ?? "Governance Archive PDF",
        storage_bucket: seal.storage_bucket,
        storage_path: seal.storage_path,
        file_hash: seal.file_hash,
        file_size: seal.file_size,
        mime_type: seal.mime_type,
      });

      if (docInsErr) throw new Error(`supporting_insert: ${docInsErr.message}`);
    }

    return json({
      ok: true,
      step: "archived_and_registered",
      record_id: recordId,
      entry_id: entryId,
      seal,
    });
  } catch (e) {
    return json(
      {
        ok: false,
        step: "archive-save-document",
        error: (e as Error).message ?? String(e),
      },
      500,
    );
  }
});
