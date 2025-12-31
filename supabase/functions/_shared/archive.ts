// supabase/functions/_shared/archive.ts
import { createClient } from "jsr:@supabase/supabase-js@2";

export type ArchiveInputs = {
  ledgerId: string;               // governance_ledger.id
  envelopeId?: string | null;     // signature_envelopes.id (optional)
  isTest?: boolean;               // lane flag (optional)
  actorUserId?: string | null;    // optional fallback for uploaded_by/owner_id
};

export type SealResult = {
  ok: boolean;
  status?: string;

  // canonical archive artifact (must exist for CI-Archive Reader)
  storage_bucket?: string;
  storage_path?: string;
  file_hash?: string;

  // optional ids produced by backend
  verified_document_id?: string;
  minute_book_entry_id?: string;
};

export type ArchiveOutcome = {
  ok: boolean;
  ledger_id: string;
  envelope_id?: string | null;

  minute_book_entry_id?: string;
  supporting_document_id?: string;
  verified_document_id?: string;

  storage_bucket?: string;
  storage_path?: string;
  file_hash?: string;

  repaired?: boolean;
  details?: unknown;
};

export function getServiceClient() {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE_KEY =
    Deno.env.get("SERVICE_ROLE_KEY") ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { fetch },
    auth: { persistSession: false },
  });
}

function lastPathToken(p: string) {
  const parts = p.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

function normalizeLanePrefix(isTest?: boolean) {
  // If you ever decide to store in a lane prefix, do it here.
  // For now your minute_book paths are already canonical (e.g. holdings/Resolutions/...).
  return isTest ? "sandbox" : "rot";
}

export async function archiveGovernanceRecord(
  supabase: ReturnType<typeof getServiceClient>,
  input: ArchiveInputs,
): Promise<ArchiveOutcome> {
  const ledgerId = input.ledgerId;
  const envelopeId = input.envelopeId ?? null;

  // 1) Load governance_ledger (need entity_id, created_by, title, is_test)
  const { data: gl, error: glErr } = await supabase
    .from("governance_ledger")
    .select("id, entity_id, title, created_by, is_test, approved_by_council, archived, locked, status")
    .eq("id", ledgerId)
    .maybeSingle();

  if (glErr) {
    return { ok: false, ledger_id: ledgerId, envelope_id: envelopeId, details: glErr };
  }
  if (!gl) {
    return { ok: false, ledger_id: ledgerId, envelope_id: envelopeId, details: "governance_ledger not found" };
  }

  // 2) Resolve entity_key from entities.slug
  const { data: ent, error: entErr } = await supabase
    .from("entities")
    .select("slug")
    .eq("id", gl.entity_id)
    .maybeSingle();

  if (entErr) {
    return { ok: false, ledger_id: ledgerId, envelope_id: envelopeId, details: entErr };
  }
  if (!ent?.slug) {
    return { ok: false, ledger_id: ledgerId, envelope_id: envelopeId, details: "entities.slug missing" };
  }

  const entityKey = ent.slug; // must cast to entity_key_enum in SQL inserts

  // 3) Call sealer RPC (must return storage_bucket/storage_path/file_hash)
  // NOTE: Your DB function MUST be enterprise-grade and idempotent.
  const { data: seal, error: sealErr } = await supabase.rpc(
    "seal_governance_record_for_archive",
    { p_ledger_id: ledgerId },
  );

  if (sealErr) {
    return {
      ok: false,
      ledger_id: ledgerId,
      envelope_id: envelopeId,
      details: { step: "seal_governance_record_for_archive", error: sealErr },
    };
  }

  const sealRes = (seal ?? {}) as SealResult;

  // If your SQL returns jsonb with those keys, we use them directly.
  const storageBucket = sealRes.storage_bucket;
  const storagePath = sealRes.storage_path;
  const fileHash = sealRes.file_hash;
  const verifiedDocumentId = sealRes.verified_document_id;

  if (!storageBucket || !storagePath) {
    return {
      ok: false,
      ledger_id: ledgerId,
      envelope_id: envelopeId,
      details: { step: "seal_result_missing_storage_pointers", seal: sealRes },
    };
  }

  // 4) Ensure/repair minute_book_entries row (idempotent)
  // domain_key: keep it stable/canonical (you used 'governance' in your screenshot)
  const domainKey = "governance";

  // Try find existing entry by source_record_id
  const { data: mbeExisting, error: mbeFindErr } = await supabase
    .from("minute_book_entries")
    .select("id, entity_id, entity_key, domain_key, title, is_test, source_record_id")
    .eq("source_record_id", ledgerId)
    .maybeSingle();

  if (mbeFindErr) {
    return { ok: false, ledger_id: ledgerId, envelope_id: envelopeId, details: mbeFindErr };
  }

  let entryId = mbeExisting?.id as string | undefined;

  if (!entryId) {
    const { data: mbeIns, error: mbeInsErr } = await supabase
      .from("minute_book_entries")
      .insert({
        entity_id: gl.entity_id,
        entity_key: entityKey,     // enum cast happens server-side; slug must match enum label
        domain_key: domainKey,
        title: gl.title,
        is_test: !!gl.is_test,
        source_record_id: ledgerId,
      })
      .select("id")
      .single();

    if (mbeInsErr) {
      return {
        ok: false,
        ledger_id: ledgerId,
        envelope_id: envelopeId,
        details: { step: "insert_minute_book_entries", error: mbeInsErr },
      };
    }
    entryId = mbeIns.id;
  }

  // 5) Ensure/repair PRIMARY supporting_documents row (THIS fixes CI-Archive Reader)
  // supporting_documents requires uploaded_by + owner_id NOT NULL, metadata NOT NULL
  // Prefer governance_ledger.created_by; if missing, fall back to actorUserId (from client) or envelope-created-by.
  let fallbackUserId: string | null = input.actorUserId ?? null;

  if (!fallbackUserId && envelopeId) {
    const { data: env, error: envErr } = await supabase
      .from("signature_envelopes")
      .select("id, created_by")
      .eq("id", envelopeId)
      .maybeSingle();
    if (!envErr && env?.created_by) fallbackUserId = env.created_by as string;
  }

  const uploader = (gl.created_by as string | null) ?? fallbackUserId;
  if (!uploader) {
    return {
      ok: false,
      ledger_id: ledgerId,
      envelope_id: envelopeId,
      details: {
        step: "missing_uploaded_by",
        message:
          "governance_ledger.created_by is NULL and no actorUserId/envelope.created_by fallback was provided. Need a non-null uploaded_by/owner_id for supporting_documents.",
      },
    };
  }

  const fileName = lastPathToken(storagePath);

  // section enum: you confirmed doc_section_enum exists; pick canonical label you use in UI
  const section = "Resolutions"; // matches your stored paths holdings/Resolutions/...
  const docType = "primary";
  const version = 1;

  // Does a primary doc already exist for this entry?
  const { data: sdExisting, error: sdFindErr } = await supabase
    .from("supporting_documents")
    .select("id, file_path, file_hash")
    .eq("entry_id", entryId)
    .eq("doc_type", docType)
    .eq("version", version)
    .maybeSingle();

  if (sdFindErr) {
    return { ok: false, ledger_id: ledgerId, envelope_id: envelopeId, details: sdFindErr };
  }

  let supportingDocumentId: string | undefined;

  if (!sdExisting?.id) {
    const { data: sdIns, error: sdInsErr } = await supabase
      .from("supporting_documents")
      .insert({
        entry_id: entryId,
        entity_key: entityKey,           // enum label must match entity_key_enum
        section,                         // doc_section_enum
        file_path: storagePath,
        file_name: fileName,
        doc_type: docType,
        version,
        uploaded_by: uploader,
        owner_id: uploader,
        file_hash: fileHash ?? null,
        signature_envelope_id: envelopeId,
        metadata: {
          source: "archive-save-document",
          bucket: storageBucket,
          path: storagePath,
          file_hash: fileHash ?? null,
          ledger_id: ledgerId,
          envelope_id: envelopeId,
          lane: normalizeLanePrefix(!!gl.is_test),
        },
        verified: true,
        registry_visible: true,
        uploaded_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (sdInsErr) {
      return {
        ok: false,
        ledger_id: ledgerId,
        envelope_id: envelopeId,
        details: { step: "insert_supporting_documents", error: sdInsErr },
      };
    }

    supportingDocumentId = sdIns.id;
  } else {
    supportingDocumentId = sdExisting.id;

    // repair missing pointers/hash if needed
    const needsRepair =
      !sdExisting.file_path ||
      sdExisting.file_path !== storagePath ||
      (!sdExisting.file_hash && !!fileHash);

    if (needsRepair) {
      const { error: sdUpErr } = await supabase
        .from("supporting_documents")
        .update({
          file_path: storagePath,
          file_name: fileName,
          file_hash: fileHash ?? sdExisting.file_hash ?? null,
          signature_envelope_id: envelopeId,
          verified: true,
          registry_visible: true,
          metadata: {
            source: "archive-save-document-repair",
            bucket: storageBucket,
            path: storagePath,
            file_hash: fileHash ?? null,
            ledger_id: ledgerId,
            envelope_id: envelopeId,
            lane: normalizeLanePrefix(!!gl.is_test),
          },
        })
        .eq("id", supportingDocumentId);

      if (sdUpErr) {
        return {
          ok: false,
          ledger_id: ledgerId,
          envelope_id: envelopeId,
          details: { step: "repair_supporting_documents", error: sdUpErr },
        };
      }
    }
  }

  // 6) Ensure verified_documents row exists (idempotent)
  if (!verifiedDocumentId) {
    // If sealer didn’t create it, we upsert it here (based on your verified_documents columns).
    const { data: vdExisting, error: vdFindErr } = await supabase
      .from("verified_documents")
      .select("id")
      .eq("source_record_id", ledgerId)
      .maybeSingle();

    if (vdFindErr) {
      return { ok: false, ledger_id: ledgerId, envelope_id: envelopeId, details: vdFindErr };
    }

    if (!vdExisting?.id) {
      const { data: vdIns, error: vdInsErr } = await supabase
        .from("verified_documents")
        .insert({
          source_record_id: ledgerId,
          storage_bucket: storageBucket,
          storage_path: storagePath,
          file_hash: fileHash ?? null,
        })
        .select("id")
        .single();

      if (vdInsErr) {
        return {
          ok: false,
          ledger_id: ledgerId,
          envelope_id: envelopeId,
          details: { step: "insert_verified_documents", error: vdInsErr },
        };
      }

      return {
        ok: true,
        ledger_id: ledgerId,
        envelope_id: envelopeId,
        minute_book_entry_id: entryId,
        supporting_document_id: supportingDocumentId,
        verified_document_id: vdIns.id,
        storage_bucket: storageBucket,
        storage_path: storagePath,
        file_hash: fileHash ?? undefined,
        repaired: !!sdExisting?.id,
      };
    }

    return {
      ok: true,
      ledger_id: ledgerId,
      envelope_id: envelopeId,
      minute_book_entry_id: entryId,
      supporting_document_id: supportingDocumentId,
      verified_document_id: vdExisting.id,
      storage_bucket: storageBucket,
      storage_path: storagePath,
      file_hash: fileHash ?? undefined,
      repaired: !!sdExisting?.id,
    };
  }

  return {
    ok: true,
    ledger_id: ledgerId,
    envelope_id: envelopeId,
    minute_book_entry_id: entryId,
    supporting_document_id: supportingDocumentId,
    verified_document_id: verifiedDocumentId,
    storage_bucket: storageBucket,
    storage_path: storagePath,
    file_hash: fileHash ?? undefined,
    repaired: !!sdExisting?.id,
  };
}
