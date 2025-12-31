import { createClient } from "jsr:@supabase/supabase-js@2";

export type Supa = ReturnType<typeof createClient>;

export type SealResult = {
  ok: boolean;
  record_id: string;
  verified_document_id?: string | null;
  storage_bucket?: string | null;
  storage_path?: string | null;
  file_hash?: string | null;
  minute_book_entry_id?: string | null;
  note?: string | null;
};

export async function sealAndRepairArchive(params: {
  supabase: Supa;
  record_id: string;
  // optionally passed if you want to force/validate lane; most lane safety is inside SQL.
  is_test?: boolean;
}) {
  const { supabase, record_id } = params;

  // 1) Seal via canonical SQL function (idempotent + lane safe)
  const { data: sealed, error: sealErr } = await supabase.rpc("seal_governance_record_for_archive", {
    p_ledger_id: record_id,
  });

  if (sealErr) {
    return { ok: false as const, step: "seal_governance_record_for_archive", error: sealErr.message, details: sealErr };
  }

  // Expect sealed to include storage_bucket/storage_path/file_hash + verified_document_id (per your finalized function)
  const storage_bucket = sealed?.storage_bucket ?? null;
  const storage_path = sealed?.storage_path ?? null;
  const file_hash = sealed?.file_hash ?? null;
  const verified_document_id = sealed?.verified_document_id ?? null;

  // 2) Repair/create minute_book_entries + primary supporting_documents pointers (idempotent repair)
  // NOTE: This assumes your archive-save-document logic already knows how to upsert/repair:
  // - minute_book_entries
  // - supporting_documents "primary" row
  // - verified_documents consistency (source_record_id)
  //
  // If you moved that logic to SQL already, call that RPC here instead.
  // Otherwise, keep minimal “repair” here.

  // Load governance record for metadata to create minute book entry if missing
  const { data: ledger, error: ledErr } = await supabase
    .from("governance_ledger")
    .select("id,title,entity_id,is_test,created_at")
    .eq("id", record_id)
    .single();

  if (ledErr) {
    return { ok: false as const, step: "load_governance_ledger", error: ledErr.message, details: ledErr };
  }

  // Ensure minute_book_entries row exists (upsert by source_record_id)
  const domain_key = "governance";
  const entry_type = "resolution";

  const { data: mbe, error: mbeErr } = await supabase
    .from("minute_book_entries")
    .upsert(
      {
        source_record_id: record_id,
        title: ledger.title,
        domain_key,
        entry_type,
        entity_id: ledger.entity_id,
        is_test: ledger.is_test,
      },
      { onConflict: "source_record_id" }
    )
    .select("id")
    .single();

  if (mbeErr) {
    return { ok: false as const, step: "upsert_minute_book_entries", error: mbeErr.message, details: mbeErr };
  }

  // Ensure primary supporting_documents row exists with pointers
  // (registry UI depends on this row)
  const { error: sdErr } = await supabase
    .from("supporting_documents")
    .upsert(
      {
        entry_id: mbe.id,
        is_primary: true,
        storage_bucket,
        storage_path,
        file_hash,
        title: ledger.title,
      },
      { onConflict: "entry_id,is_primary" }
    );

  if (sdErr) {
    return { ok: false as const, step: "upsert_supporting_documents_primary", error: sdErr.message, details: sdErr };
  }

  return {
    ok: true as const,
    record_id,
    verified_document_id,
    storage_bucket,
    storage_path,
    file_hash,
    minute_book_entry_id: mbe.id,
  };
}
