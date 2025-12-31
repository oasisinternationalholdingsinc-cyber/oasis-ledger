// supabase/functions/archive-save-document/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

import {
  cors,
  json,
  getCallerUid,
  makeServiceClient,
  mapRecordTypeToSection,
  minuteBookPrimaryPath,
  fileNameFromPath,
} from "../_shared/archive.ts";

type ReqBody = {
  record_id: string;          // governance_ledger.id
  envelope_id?: string;       // signature_envelopes.id (optional)
  is_test?: boolean;          // lane hint (optional)
};

const MINUTE_BOOK_BUCKET = "minute_book";
const SEAL_RPC = "seal_governance_record_for_archive";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const body = (await req.json()) as ReqBody;
    if (!body?.record_id) return json({ ok: false, error: "missing record_id" }, 400);

    const supabase = makeServiceClient();

    // Caller uid (best), else fallback to governance_ledger.created_by
    const callerUid = getCallerUid(req);

    // Load ledger row (schema-aligned)
    const { data: gl, error: glErr } = await supabase
      .from("governance_ledger")
      .select("id, entity_id, title, record_type, created_by, is_test, approved_by_council, archived, locked, status")
      .eq("id", body.record_id)
      .single();

    if (glErr || !gl) return json({ ok: false, step: "load_governance_ledger", error: glErr?.message ?? "not found" }, 404);

    const actorUid = callerUid ?? gl.created_by ?? null;
    if (!actorUid) {
      return json({
        ok: false,
        step: "resolve_actor_uid",
        error: "Missing actor uid: call from app (user JWT) or ensure governance_ledger.created_by is set",
      }, 400);
    }

    // Resolve entity_key from entities.slug (casted in SQL on insert)
    const { data: ent, error: entErr } = await supabase
      .from("entities")
      .select("id, slug")
      .eq("id", gl.entity_id)
      .single();

    if (entErr || !ent?.slug) return json({ ok: false, step: "resolve_entity_key", error: entErr?.message ?? "entity not found" }, 500);

    const entity_key = ent.slug; // will be cast to entity_key_enum by DB via ::public.entity_key_enum in SQL, or store as text if column is enum-compatible

    // ---- SEAL (must be service_role-safe) ----
    const { data: sealData, error: sealErr } = await supabase.rpc(SEAL_RPC, {
      p_ledger_id: gl.id,
    });

    if (sealErr) {
      return json({
        ok: false,
        step: "seal_governance_record_for_archive",
        error: sealErr.message,
        details: sealErr,
      }, 500);
    }

    // Expect seal to return storage pointers + hash for verified registry
    const seal = sealData as {
      ok?: boolean;
      status?: string;
      ledger_id?: string;
      entity_id?: string;
      entity_key?: string;
      is_test?: boolean;
      storage_bucket?: string;
      storage_path?: string;
      file_hash?: string;
      verified_document_id?: string;
    };

    // If your current SQL seal returns only status, you MUST upgrade it to return these.
    if (!seal?.storage_bucket || !seal?.storage_path || !seal?.file_hash) {
      return json({
        ok: false,
        step: "seal_result_invalid",
        error: "seal_governance_record_for_archive must return storage_bucket, storage_path, file_hash",
        seal,
      }, 500);
    }

    // ---- Ensure Minute Book Entry ----
    const domain_key = "governance"; // your minute_book_entries.domain_key is TEXT, required
    const { data: mbeRow, error: mbeErr } = await supabase
      .from("minute_book_entries")
      .upsert({
        entity_id: gl.entity_id,
        entity_key: entity_key,       // enum in DB
        domain_key,
        title: gl.title,
        is_test: gl.is_test ?? body.is_test ?? false,
        source_record_id: gl.id,
      }, { onConflict: "source_record_id" })
      .select("id, entity_id, entity_key, domain_key, title, is_test, source_record_id")
      .single();

    if (mbeErr || !mbeRow) {
      return json({ ok: false, step: "upsert_minute_book_entry", error: mbeErr?.message ?? "failed" }, 500);
    }

    // ---- Primary evidence path in minute_book bucket ----
    // Use your established convention: section enum labels like "Resolutions"
    const section = mapRecordTypeToSection(gl.record_type ?? "resolution");

    // Prefer SIGNED PDF if envelope_id exists; otherwise use deterministic archive artifact as primary
    const suffix = body.envelope_id ? "-signed" : "";
    const primaryPath = minuteBookPrimaryPath(entity_key, section, gl.id, suffix);
    const primaryName = fileNameFromPath(primaryPath);

    // If the signed PDF already exists (your storage screenshot shows it does), do NOT copy again.
    // Otherwise, copy the sealed artifact into minute_book bucket to make CI-Archive Reader work.
    const needsCopy = !body.envelope_id; // for deterministic archive-as-primary; adjust if you want copy always

    if (needsCopy) {
      // Copy from sealed bucket/path -> minute_book/primaryPath
      // NOTE: this uses the Storage API; permissions are service role.
      const { error: copyErr } = await supabase.storage
        .from(MINUTE_BOOK_BUCKET)
        .copy(`${seal.storage_path}`, primaryPath); // <-- if seal.storage_bucket is NOT minute_book, you must download+upload. See note below.

      // If your seal artifacts live in a different bucket (governance_sandbox), Supabase Storage copy() cannot cross buckets.
      // In that case: download from seal bucket and upload to minute_book.
      if (copyErr) {
        // Attempt cross-bucket download+upload fallback:
        const { data: dl, error: dlErr } = await supabase.storage
          .from(seal.storage_bucket)
          .download(seal.storage_path);

        if (dlErr || !dl) {
          return json({ ok: false, step: "download_sealed_artifact", error: dlErr?.message ?? "download failed" }, 500);
        }

        const ab = await dl.arrayBuffer();
        const { error: upErr } = await supabase.storage
          .from(MINUTE_BOOK_BUCKET)
          .upload(primaryPath, ab, { contentType: "application/pdf", upsert: true });

        if (upErr) {
          return json({ ok: false, step: "upload_primary_to_minute_book", error: upErr.message }, 500);
        }
      }
    }

    // ---- Ensure Supporting Document primary row (THIS is what Reader needs) ----
    // supporting_documents schema (from your screenshot):
    // entry_id, entity_key(enum), section(enum doc_section_enum), file_path(text), file_name(text),
    // doc_type(text nullable), version(int NOT NULL), uploaded_by(uuid NOT NULL), owner_id(uuid NOT NULL),
    // uploaded_at(timestamptz NOT NULL), metadata(jsonb NOT NULL), file_hash(text nullable), signature_envelope_id uuid nullable, registry_visible bool, verified bool
    const { data: sdRow, error: sdErr } = await supabase
      .from("supporting_documents")
      .upsert({
        entry_id: mbeRow.id,
        entity_key: entity_key,        // enum
        section: section,              // doc_section_enum
        file_path: primaryPath,
        file_name: primaryName,
        doc_type: "primary",
        version: 1,
        uploaded_by: actorUid,
        owner_id: actorUid,
        file_hash: seal.file_hash,     // ✅ hash included
        signature_envelope_id: body.envelope_id ?? null,
        verified: true,
        registry_visible: true,
        uploaded_at: new Date().toISOString(),
        metadata: {
          source: "archive-save-document",
          ledger_id: gl.id,
          sealed: {
            storage_bucket: seal.storage_bucket,
            storage_path: seal.storage_path,
            file_hash: seal.file_hash,
            verified_document_id: seal.verified_document_id ?? null,
          },
          primary: {
            bucket: MINUTE_BOOK_BUCKET,
            path: primaryPath,
          },
        },
      }, {
        // choose your real unique index/constraint if you have one; this is safest generic:
        onConflict: "entry_id,file_path",
      })
      .select("id, entry_id, file_path, file_hash, verified, registry_visible")
      .single();

    if (sdErr || !sdRow) {
      return json({ ok: false, step: "upsert_supporting_documents_primary", error: sdErr?.message ?? "failed" }, 500);
    }

    return json({
      ok: true,
      step: "archive-save-document",
      ledger_id: gl.id,
      minute_book_entry_id: mbeRow.id,
      supporting_document_id: sdRow.id,
      primary: { bucket: MINUTE_BOOK_BUCKET, path: primaryPath, hash: seal.file_hash },
      verified: { bucket: seal.storage_bucket, path: seal.storage_path, hash: seal.file_hash, id: seal.verified_document_id ?? null },
    });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
