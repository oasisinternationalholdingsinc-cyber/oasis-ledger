// supabase/functions/_shared/archive.ts
import { createClient } from "jsr:@supabase/supabase-js@2";

export type ArchiveResult = {
  ok: boolean;
  record_id: string;
  is_test: boolean;

  // from seal_governance_record_for_archive
  storage_bucket?: string;
  storage_path?: string;
  file_hash?: string;
  verified_document_id?: string;

  // minute book
  minute_book_entry_id?: string;

  repaired?: {
    minute_book_entry: boolean;
    supporting_primary: boolean;
    verified_document: boolean;
  };

  warnings?: string[];
};

export type ArchiveContext = {
  SUPABASE_URL: string;
  SERVICE_ROLE_KEY: string;
};

const MINUTE_BOOK_BUCKET = "minute_book";
const SEAL_RPC = "seal_governance_record_for_archive";

// You said this is now the canonical, lane-safe, idempotent function.
// We call it and then “repair” the registry pointers around it.
export async function runArchiveSaveDocument(
  ctx: ArchiveContext,
  record_id: string,
  is_test: boolean
): Promise<ArchiveResult> {
  const supabase = createClient(ctx.SUPABASE_URL, ctx.SERVICE_ROLE_KEY, {
    global: { fetch },
    auth: { persistSession: false },
  });

  const warnings: string[] = [];
  const repaired = {
    minute_book_entry: false,
    supporting_primary: false,
    verified_document: false,
  };

  // 1) Load ledger row (need entity_id + title; also ensures record exists)
  const { data: ledger, error: ledgerErr } = await supabase
    .from("governance_ledger")
    .select("id, title, entity_id, is_test, created_at")
    .eq("id", record_id)
    .maybeSingle();

  if (ledgerErr) {
    return { ok: false, record_id, is_test, warnings: [ledgerErr.message] };
  }
  if (!ledger) {
    // This is the clean, meaningful 404 you WANT (record not found)
    return { ok: false, record_id, is_test, warnings: ["Ledger record not found"] };
  }

  // force lane from DB if caller passed nothing / wrong
  const lane = typeof ledger.is_test === "boolean" ? ledger.is_test : is_test;

  // 2) Seal via canonical SQL function (idempotent)
  // NOTE: your finalized function takes p_ledger_id (per our checkpoint).
  const { data: seal, error: sealErr } = await supabase.rpc(SEAL_RPC, {
    p_ledger_id: record_id,
  });

  if (sealErr) {
    return {
      ok: false,
      record_id,
      is_test: lane,
      warnings: [`seal rpc failed: ${sealErr.message}`],
    };
  }

  // Expecting seal to return storage pointers + hash + verified_document id
  // We stay defensive in case the return keys differ slightly.
  const storage_bucket = seal?.storage_bucket ?? MINUTE_BOOK_BUCKET;
  const storage_path = seal?.storage_path;
  const file_hash = seal?.file_hash ?? seal?.hash ?? seal?.pdf_hash;
  const verified_document_id = seal?.verified_document_id ?? seal?.verified_id;

  if (!storage_path) warnings.push("seal rpc returned no storage_path");
  if (!file_hash) warnings.push("seal rpc returned no file_hash");

  // 3) Ensure minute_book_entries row exists (or repair) for this record
  // Minimal, enterprise-safe: create if missing; update pointers if present.
  const { data: existingEntry, error: entryLookupErr } = await supabase
    .from("minute_book_entries")
    .select("id, source_record_id, is_test")
    .eq("source_record_id", record_id)
    .maybeSingle();

  if (entryLookupErr) {
    warnings.push(`minute_book_entries lookup error: ${entryLookupErr.message}`);
  }

  let minute_book_entry_id = existingEntry?.id as string | undefined;

  if (!minute_book_entry_id) {
    // NOTE: you confirmed minute_book_entries requires entity_id, domain_key, etc.
    // We use a conservative domain_key and let your UI organize by domain/section.
    const { data: insertedEntry, error: entryInsErr } = await supabase
      .from("minute_book_entries")
      .insert({
        entity_id: ledger.entity_id,
        source_record_id: record_id,
        title: ledger.title,
        domain_key: "governance",
        section: "Governance",
        entry_type: "resolution",
        is_test: lane,
        entry_date: new Date().toISOString().slice(0, 10),
      })
      .select("id")
      .single();

    if (entryInsErr) {
      warnings.push(`minute_book_entries insert error: ${entryInsErr.message}`);
    } else {
      minute_book_entry_id = insertedEntry.id;
      repaired.minute_book_entry = true;
    }
  } else {
    // ensure lane is correct
    const { error: entryUpErr } = await supabase
      .from("minute_book_entries")
      .update({ is_test: lane })
      .eq("id", minute_book_entry_id);

    if (entryUpErr) warnings.push(`minute_book_entries lane update error: ${entryUpErr.message}`);
  }

  // 4) Ensure supporting_documents “primary” row exists + has storage pointers
  // Your CI-Archive Reader depends on supporting_documents primary pointers.
  // We "repair" by upserting/patching the primary row.
  if (minute_book_entry_id && storage_path) {
    const { data: primaryDoc, error: primaryLookupErr } = await supabase
      .from("supporting_documents")
      .select("id, storage_path, pdf_hash, is_primary")
      .eq("source_record_id", record_id)
      .eq("is_primary", true)
      .maybeSingle();

    if (primaryLookupErr) {
      warnings.push(`supporting_documents lookup error: ${primaryLookupErr.message}`);
    }

    if (!primaryDoc) {
      const { error: primaryInsErr } = await supabase.from("supporting_documents").insert({
        source_record_id: record_id,
        entry_id: minute_book_entry_id,
        title: ledger.title,
        bucket: storage_bucket,
        storage_path,
        pdf_hash: file_hash ?? null,
        is_primary: true,
      });

      if (primaryInsErr) {
        warnings.push(`supporting_documents primary insert error: ${primaryInsErr.message}`);
      } else {
        repaired.supporting_primary = true;
      }
    } else {
      // patch missing pointers (idempotent repair)
      const patch: Record<string, unknown> = {};
      if (!primaryDoc.storage_path) patch.storage_path = storage_path;
      if (!primaryDoc.pdf_hash && file_hash) patch.pdf_hash = file_hash;

      if (Object.keys(patch).length > 0) {
        const { error: primaryUpErr } = await supabase
          .from("supporting_documents")
          .update(patch)
          .eq("id", primaryDoc.id);

        if (primaryUpErr) {
          warnings.push(`supporting_documents primary patch error: ${primaryUpErr.message}`);
        } else {
          repaired.supporting_primary = true;
        }
      }
    }
  }

  // 5) Verified registry consistency
  // Your seal RPC already inserts/repairs verified_documents (source_record_id).
  // Here we just sanity-check it exists when verified_document_id wasn’t returned.
  if (!verified_document_id) {
    const { data: vd, error: vdErr } = await supabase
      .from("verified_documents")
      .select("id")
      .eq("source_record_id", record_id)
      .maybeSingle();

    if (vdErr) warnings.push(`verified_documents lookup error: ${vdErr.message}`);
    if (vd?.id) repaired.verified_document = true;
  } else {
    repaired.verified_document = true;
  }

  return {
    ok: true,
    record_id,
    is_test: lane,
    storage_bucket,
    storage_path,
    file_hash,
    verified_document_id,
    minute_book_entry_id,
    repaired,
    warnings: warnings.length ? warnings : undefined,
  };
}
