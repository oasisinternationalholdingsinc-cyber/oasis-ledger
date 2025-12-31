import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

export type ArchiveResult = {
  ok: boolean;
  ledger_id?: string;
  envelope_id?: string | null;
  seal?: unknown;
  minute_book_entry_id?: string | null;
  primary_supporting_document_id?: string | null;
  error?: string;
  details?: unknown;
};

type ArchiveArgs = {
  supabase: SupabaseClient;
  ledger_id: string;
  envelope_id?: string | null;
};

function must(x: unknown, msg: string) {
  if (!x) throw new Error(msg);
}

export async function archiveLedgerEnterprise({ supabase, ledger_id, envelope_id }: ArchiveArgs): Promise<ArchiveResult> {
  try {
    // 1) Load ledger
    const { data: gl, error: glErr } = await supabase
      .from("governance_ledger")
      .select("id, entity_id, entity_key, title, is_test, approved_by_council, archived, locked")
      .eq("id", ledger_id)
      .single();

    if (glErr) throw glErr;
    must(gl, "Ledger not found");

    if (!gl.approved_by_council) {
      return { ok: false, ledger_id, envelope_id: envelope_id ?? null, error: "Ledger not approved by council" };
    }

    // 2) If envelope_id provided, validate it is completed and belongs to ledger
    if (envelope_id) {
      const { data: env, error: envErr } = await supabase
        .from("signature_envelopes")
        .select("id, record_id, status, completed_at")
        .eq("id", envelope_id)
        .single();

      if (envErr) throw envErr;
      must(env, "Envelope not found");
      if (env.record_id !== ledger_id) {
        return { ok: false, ledger_id, envelope_id, error: "Envelope does not belong to this ledger record" };
      }
      if (env.status !== "completed") {
        return { ok: false, ledger_id, envelope_id, error: `Envelope not completed (status=${env.status})` };
      }
    }

    // 3) Seal via SQL (service_role required; TRUTH LANE LOCKED will block non-service_role)
    const { data: seal, error: sealErr } = await supabase.rpc("seal_governance_record_for_archive", {
      p_ledger_id: ledger_id,
    });

    if (sealErr) throw sealErr;

    // Expect seal to include storage pointers
    const storage_bucket = (seal as any)?.storage_bucket as string | undefined;
    const storage_path = (seal as any)?.storage_path as string | undefined;
    const file_hash = (seal as any)?.file_hash as string | undefined;

    must(storage_bucket && storage_path && file_hash, "Seal did not return storage pointers");

    // 4) Upsert minute_book_entries (idempotent)
    // NOTE: this assumes you have minute_book_entries.source_record_id and is_test available (as per your architecture).
    // If your column names differ, adjust here ONLY (no UI rewiring).
    const { data: mbe, error: mbeErr } = await supabase
      .from("minute_book_entries")
      .upsert(
        {
          entity_id: gl.entity_id,
          entity_key: gl.entity_key,
          domain_key: "governance",
          section: "archive",
          title: gl.title ?? "",
          entry_type: "resolution",
          source_record_id: gl.id,
          is_test: !!gl.is_test,
        },
        { onConflict: "source_record_id" }
      )
      .select("id")
      .single();

    if (mbeErr) throw mbeErr;

    // 5) Ensure primary supporting_documents row exists with pointers (idempotent repair)
    const { data: sd, error: sdErr } = await supabase
      .from("supporting_documents")
      .upsert(
        {
          entry_id: mbe.id,
          is_primary: true,
          storage_bucket,
          storage_path,
          file_hash,
          mime_type: "application/pdf",
        },
        { onConflict: "entry_id,is_primary" }
      )
      .select("id")
      .single();

    if (sdErr) throw sdErr;

    return {
      ok: true,
      ledger_id,
      envelope_id: envelope_id ?? null,
      seal,
      minute_book_entry_id: mbe?.id ?? null,
      primary_supporting_document_id: sd?.id ?? null,
    };
  } catch (e) {
    return {
      ok: false,
      ledger_id,
      envelope_id: envelope_id ?? null,
      error: (e as any)?.message ?? "archive failed",
      details: e,
    };
  }
}

export function getServiceClient() {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE_KEY =
    Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { global: { fetch } });
}
