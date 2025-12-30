// supabase/functions/archive-save-document/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  record_id: string;          // governance_ledger.id
  envelope_id?: string;       // signature_envelopes.id (recommended)
  is_test?: boolean;          // lane flag (must match ledger/envelope)
  domain_key?: string;
  section_name?: string;
  title?: string;
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
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

const MINUTE_BOOK_BUCKET = "minute_book";

serve(async (req) => {
  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);

    const body = (await req.json().catch(() => null)) as ReqBody | null;
    if (!body?.record_id) return json({ ok: false, error: "record_id is required" }, 400);

    const record_id = body.record_id;

    // 1) Load ledger record
    const { data: ledger, error: ledgerErr } = await supabase
      .from("governance_ledger")
      .select("id, entity_id, title, record_type, status, created_by, is_test")
      .eq("id", record_id)
      .maybeSingle();

    if (ledgerErr) return json({ ok: false, error: ledgerErr.message }, 500);
    if (!ledger) return json({ ok: false, error: "governance_ledger record not found" }, 404);
    if (!ledger.entity_id) return json({ ok: false, error: "governance_ledger.entity_id is NULL" }, 400);

    const entity_id = ledger.entity_id as string;

    // 2) Load entity (slug is used for entity_key enum + path)
    const { data: ent, error: entErr } = await supabase
      .from("entities")
      .select("id, slug, name")
      .eq("id", entity_id)
      .maybeSingle();

    if (entErr) return json({ ok: false, error: entErr.message }, 500);
    if (!ent?.slug) return json({ ok: false, error: "entities.slug not found for entity_id" }, 400);

    const entity_slug = String(ent.slug);
    const laneIsTest = Boolean(ledger.is_test);

    // Enforce lane match (prevents cross-lane accidental writes)
    if (typeof body.is_test === "boolean" && body.is_test !== laneIsTest) {
      return json(
        {
          ok: false,
          error: "Lane mismatch: body.is_test does not match governance_ledger.is_test",
          details: { body_is_test: body.is_test, ledger_is_test: laneIsTest },
        },
        409,
      );
    }

    const lanePrefix = laneIsTest ? "sandbox" : "rot";

    // 3) Optional: load envelope for pointers
    let envelope: any = null;
    if (body.envelope_id) {
      const { data: env, error: envErr } = await supabase
        .from("signature_envelopes")
        .select("id, record_id, entity_id, status, is_test, storage_path, storage_hash, completed_at, created_by")
        .eq("id", body.envelope_id)
        .maybeSingle();

      if (envErr) return json({ ok: false, error: envErr.message }, 500);
      if (!env) return json({ ok: false, error: "signature_envelope not found" }, 404);

      if (env.record_id !== record_id) {
        return json({ ok: false, error: "envelope_id does not match record_id" }, 400);
      }
      if (env.entity_id !== entity_id) {
        return json({ ok: false, error: "envelope.entity_id does not match ledger.entity_id" }, 400);
      }
      if (Boolean(env.is_test) !== laneIsTest) {
        return json(
          {
            ok: false,
            error: "Lane mismatch: envelope.is_test does not match governance_ledger.is_test",
            details: { envelope_is_test: env.is_test, ledger_is_test: laneIsTest },
          },
          409,
        );
      }

      envelope = env;
    }

    // 4) created_by is required for supporting_documents owner fields
    const created_by = (ledger.created_by ?? envelope?.created_by ?? null) as string | null;
    if (!created_by) {
      return json(
        {
          ok: false,
          error: "Ledger missing created_by (needed for supporting_documents)",
          hint: "Ensure governance_ledger.created_by is set (uuid) for this record.",
        },
        400,
      );
    }

    // 5) Resolve archive fields
    const title = body.title ?? ledger.title ?? "Governance Record";
    const entry_type = (ledger.record_type ?? "resolution") as any;

    const domain_key = body.domain_key ?? "resolutions-minutes";
    const section_name = body.section_name ?? "Resolutions & Minutes";

    // 6) Idempotent find Minute Book entry (per lane)
    const { data: existingEntry, error: existingErr } = await supabase
      .from("minute_book_entries")
      .select("id, storage_path, pdf_hash, source_record_id, source_envelope_id, domain_key, section_name, is_test")
      .eq("source_record_id", record_id)
      .eq("is_test", laneIsTest)
      .maybeSingle();

    if (existingErr) return json({ ok: false, error: existingErr.message }, 500);

    // 7) Primary path + hash (prefer envelope pointers)
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
          entity_key: entity_slug as any, // enum label must match slug
          domain_key,
          section_name,
          entry_type,
          title,
          source: envelope ? "signed_resolution" : "system_generated",
          source_record_id: record_id,
          source_envelope_id: envelope?.id ?? null,
          storage_path: primaryPath,
          pdf_hash: primaryHash,
          is_test: laneIsTest,
          created_by,
        })
        .select("id")
        .single();

      if (insErr) return json({ ok: false, error: insErr.message }, 500);
      entry_id = inserted.id;
    } else {
      entry_id = existingEntry.id;

      const patch: Record<string, unknown> = {};
      if (!existingEntry.storage_path) patch.storage_path = primaryPath;
      if (!existingEntry.pdf_hash && primaryHash) patch.pdf_hash = primaryHash;
      if (!existingEntry.source_envelope_id && envelope?.id) patch.source_envelope_id = envelope.id;
      if (existingEntry.domain_key !== domain_key) patch.domain_key = domain_key;
      if (existingEntry.section_name !== section_name) patch.section_name = section_name;

      if (Object.keys(patch).length) {
        const { error: upErr } = await supabase
          .from("minute_book_entries")
          .update({ ...patch, updated_at: new Date().toISOString() })
          .eq("id", entry_id);

        if (upErr) return json({ ok: false, error: upErr.message }, 500);
      }
    }

    // 9) Ensure supporting_documents for primary PDF (Reader relies on this)
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
          section: section_name as any, // must be valid for your section enum; if not, change to a known valid enum label
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
              "If this fails on supporting_documents.section enum, use a known-valid enum label for section and store display section_name in metadata instead.",
          },
          500,
        );
      }
    }

    // 10) Upsert verified_documents (canonical pointer: minute_book_entries)
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
          entity_key: entity_slug as any,
          document_class: "minute_book" as any,
          title,
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
      is_test: laneIsTest,
    });
  } catch (e) {
    return json({ ok: false, error: String((e as any)?.message ?? e) }, 500);
  }
});
