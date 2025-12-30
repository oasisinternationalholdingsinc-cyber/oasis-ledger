import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  record_id: string;          // governance_ledger.id
  envelope_id?: string;       // signature_envelopes.id (optional but recommended for signed flow)
  is_test?: boolean;          // lane flag
  domain_key?: string;        // optional override
  section_name?: string;      // optional override
  title?: string;             // optional override
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};

const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { global: { fetch } });

const MINUTE_BOOK_BUCKET = "minute_book"; // your canonical bucket name in this project

serve(async (req) => {
  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

    const body = (await req.json().catch(() => null)) as ReqBody | null;
    if (!body?.record_id) return json({ ok: false, error: "record_id is required" }, 400);

    const record_id = body.record_id;
    const is_test = !!body.is_test;

    // 1) Load ledger record
    const { data: ledger, error: ledgerErr } = await supabase
      .from("governance_ledger")
      .select("id, entity_id, title, record_type, status, created_by, is_test")
      .eq("id", record_id)
      .maybeSingle();

    if (ledgerErr) return json({ ok: false, error: ledgerErr.message }, 500);
    if (!ledger) return json({ ok: false, error: "governance_ledger record not found" }, 404);

    const entity_id = ledger.entity_id;
    if (!entity_id) return json({ ok: false, error: "governance_ledger.entity_id is NULL" }, 400);

    // 2) Load entity slug (for entity_key enum cast + lane path)
    const { data: ent, error: entErr } = await supabase
      .from("entities")
      .select("id, slug, name")
      .eq("id", entity_id)
      .maybeSingle();

    if (entErr) return json({ ok: false, error: entErr.message }, 500);
    if (!ent?.slug) return json({ ok: false, error: "entities.slug not found for entity_id" }, 400);

    const entity_slug = ent.slug;
    const lanePrefix = is_test ? "sandbox" : "rot";

    // 3) If envelope_id provided, load envelope for storage_path/hash pointers
    let envelope: any = null;
    if (body.envelope_id) {
      const { data: env, error: envErr } = await supabase
        .from("signature_envelopes")
        .select("id, record_id, entity_id, status, storage_path, storage_hash, certificate_path, created_by, is_test, completed_at")
        .eq("id", body.envelope_id)
        .maybeSingle();

      if (envErr) return json({ ok: false, error: envErr.message }, 500);
      if (!env) return json({ ok: false, error: "signature_envelope not found" }, 404);
      envelope = env;
    }

    // 4) Determine who "owns" the archival inserts (supporting_documents needs uploaded_by + owner_id NOT NULL)
    // Prefer ledger.created_by; else envelope.created_by; else last resort: entity_id (still UUID) to avoid NULL.
    const created_by =
      ledger.created_by ??
      (envelope?.created_by ?? null) ??
      null;

    if (!created_by) {
      // we refuse only if we must insert supporting_documents; but we CAN still create minute_book_entries without supporting docs.
      // However your UI expects a primary doc pointer, so we hard fail here to avoid half-broken entries.
      return json(
        {
          ok: false,
          error: "Ledger missing created_by (needed for supporting_documents)",
          hint:
            "Set governance_ledger.created_by for this record OR ensure envelope.created_by is a real UUID; supporting_documents requires uploaded_by/owner_id.",
        },
        400,
      );
    }

    // 5) Resolve archive fields
    const title = body.title ?? ledger.title ?? "Governance Record";
    const entry_type = (ledger.record_type ?? "resolution") as string;

    // Default mapping: signed resolutions go under "resolutions-minutes" domain unless overridden
    const domain_key = body.domain_key ?? "resolutions-minutes";
    const section_name = body.section_name ?? "Resolutions & Minutes";

    // 6) Find existing minute_book entry (idempotent repair)
    const { data: existingEntry, error: existingErr } = await supabase
      .from("minute_book_entries")
      .select("id, storage_path, pdf_hash, source_record_id, source_envelope_id, domain_key, is_test")
      .eq("source_record_id", record_id)
      .eq("is_test", is_test)
      .maybeSingle();

    if (existingErr) return json({ ok: false, error: existingErr.message }, 500);

    // 7) Compute primary storage path (prefer envelope storage_path if present)
    // If envelope has a storage_path, treat it as the primary signed PDF path
    const primaryPath =
      envelope?.storage_path ??
      `${lanePrefix}/${entity_slug}/${domain_key}/${record_id}.pdf`;

    const primaryHash = envelope?.storage_hash ?? null;

    // 8) Upsert minute_book_entries
    let entry_id: string;

    if (!existingEntry) {
      const { data: inserted, error: insErr } = await supabase
        .from("minute_book_entries")
        .insert({
          entity_id,
          // entity_key is enum; cast from slug in SQL layer by passing slug string (works if enum labels match)
          entity_key: entity_slug as any,
          domain_key,
          section_name,
          entry_type: entry_type as any,
          title,
          source: envelope ? "signed_resolution" : "system_generated",
          source_record_id: record_id,
          source_envelope_id: envelope?.id ?? null,
          storage_path: primaryPath,
          pdf_hash: primaryHash,
          is_test,
          created_by,
        })
        .select("id")
        .single();

      if (insErr) return json({ ok: false, error: insErr.message }, 500);
      entry_id = inserted.id;
    } else {
      entry_id = existingEntry.id;

      // Repair pointers if missing/outdated (idempotent)
      const patch: Record<string, unknown> = {};
      if (!existingEntry.storage_path) patch.storage_path = primaryPath;
      if (!existingEntry.pdf_hash && primaryHash) patch.pdf_hash = primaryHash;
      if (!existingEntry.source_envelope_id && envelope?.id) patch.source_envelope_id = envelope.id;
      if (existingEntry.domain_key !== domain_key) patch.domain_key = domain_key; // safe if you want repair

      if (Object.keys(patch).length) {
        const { error: upErr } = await supabase
          .from("minute_book_entries")
          .update({ ...patch, updated_at: new Date().toISOString() })
          .eq("id", entry_id);

        if (upErr) return json({ ok: false, error: upErr.message }, 500);
      }
    }

    // 9) Ensure supporting_documents row exists for the primary PDF (UI Reader relies on this)
    // We store the primaryPath in supporting_documents.file_path, bucket is implicit in your app but we keep it in metadata.
    const { data: existingDoc, error: docErr } = await supabase
      .from("supporting_documents")
      .select("id, file_path")
      .eq("entry_id", entry_id)
      .eq("file_path", primaryPath)
      .maybeSingle();

    if (docErr) return json({ ok: false, error: docErr.message }, 500);

    if (!existingDoc) {
      const file_name = primaryPath.split("/").pop() ?? `${record_id}.pdf`;

      const { error: docInsErr } = await supabase
        .from("supporting_documents")
        .insert({
          entry_id,
          entity_key: entity_slug as any,
          section: section_name as any, // your section is USER-DEFINED; if this enum doesn't accept the label it will error
          file_path: primaryPath,
          file_name,
          doc_type: "pdf",
          mime_type: "application/pdf",
          file_hash: primaryHash,
          signature_envelope_id: envelope?.id ?? null,
          uploaded_by: created_by,
          owner_id: created_by,
          metadata: {
            bucket: MINUTE_BOOK_BUCKET,
            lane: lanePrefix,
            entity_slug,
            source_table: "signature_envelopes",
            envelope_id: envelope?.id ?? null,
          },
        });

      if (docInsErr) {
        return json(
          {
            ok: false,
            error: docInsErr.message,
            hint:
              "If this errors on supporting_documents.section enum, switch this insert to use a known-valid section label (or store section in metadata only).",
          },
          500,
        );
      }
    }

    // 10) Upsert verified_documents (NO source_entry_id; use source_table + source_record_id)
    // Make verified record point at the minute_book entry as the source_record_id (canonical registry of record).
    const verifiedTitle = title;

    const { data: existingVerified, error: verSelErr } = await supabase
      .from("verified_documents")
      .select("id, storage_path, file_hash")
      .eq("source_table", "minute_book_entries")
      .eq("source_record_id", entry_id)
      .maybeSingle();

    if (verSelErr) return json({ ok: false, error: verSelErr.message }, 500);

    if (!existingVerified) {
      const { error: verInsErr } = await supabase
        .from("verified_documents")
        .insert({
          entity_id,
          entity_slug,
          entity_key: entity_slug,
          document_class: "minute_book" as any,
          title: verifiedTitle,
          source_table: "minute_book_entries",
          source_record_id: entry_id,
          storage_bucket: MINUTE_BOOK_BUCKET,
          storage_path: primaryPath,
          file_hash: primaryHash,
          mime_type: "application/pdf",
          envelope_id: envelope?.id ?? null,
          signed_at: envelope?.completed_at ?? null,
          created_by,
          updated_by: created_by,
          is_archived: true,
          document_purpose: "governance_archive",
        });

      if (verInsErr) return json({ ok: false, error: verInsErr.message }, 500);
    } else {
      // repair pointers if needed
      const patch: Record<string, unknown> = {};
      if (!existingVerified.storage_path) patch.storage_path = primaryPath;
      if (!existingVerified.file_hash && primaryHash) patch.file_hash = primaryHash;

      if (Object.keys(patch).length) {
        const { error: verUpErr } = await supabase
          .from("verified_documents")
          .update({ ...patch, updated_at: new Date().toISOString(), updated_by: created_by })
          .eq("id", existingVerified.id);

        if (verUpErr) return json({ ok: false, error: verUpErr.message }, 500);
      }
    }

    return json({
      ok: true,
      record_id,
      entry_id,
      verified_source_table: "minute_book_entries",
      verified_source_record_id: entry_id,
      storage_bucket: MINUTE_BOOK_BUCKET,
      storage_path: primaryPath,
      is_test,
    });
  } catch (e) {
    return json({ ok: false, error: String(e?.message ?? e) }, 500);
  }
});
