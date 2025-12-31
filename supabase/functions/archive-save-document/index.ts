// supabase/functions/archive-save-document/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  record_id: string;   // governance_ledger.id
  envelope_id?: string; // signature_envelopes.id (optional but recommended)
  is_test?: boolean;   // lane flag (must match governance_ledger.is_test)
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
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

function asBool(v: unknown, fallback = false) {
  if (typeof v === "boolean") return v;
  return fallback;
}

const SEAL_RPC = "seal_governance_record_for_archive";
const SYNC_ENVELOPE_LANE_RPC = "sync_envelope_lane_from_ledger";

// NOTE: keep these aligned with your schema defaults/taxonomy.
// If your enums differ, adjust these two.
const DEFAULT_DOMAIN_KEY = "governance"; // minute_book_entries.domain_key (text)
const DEFAULT_SECTION = "Resolutions";   // minute_book_entries.section_name (text)

// Buckets: archive PDF is produced by generate_governance_archive_pdf + seal fn.
// Minute book bucket name is typically "minute_book".
const MINUTE_BOOK_BUCKET = "minute_book";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const body = (await req.json()) as ReqBody;

    const record_id = (body?.record_id ?? "").trim();
    const envelope_id = (body?.envelope_id ?? "").trim();
    const is_test = asBool(body?.is_test, false);

    if (!record_id) return json({ ok: false, error: "record_id is required" }, 400);

    // 1) Load ledger (service_role bypasses RLS)
    const led = await supabase
      .from("governance_ledger")
      .select(
        "id,title,status,is_test,entity_id,entity_key,archived,locked,approved_by_council,approved_by,created_by",
      )
      .eq("id", record_id)
      .maybeSingle();

    if (led.error || !led.data) {
      return json(
        { ok: false, error: "governance_ledger row not found", details: led.error ?? null },
        404,
      );
    }

    const gl = led.data as any;

    // 2) Lane safety: request lane must match record lane
    if (Boolean(gl.is_test) !== Boolean(is_test)) {
      return json(
        {
          ok: false,
          error: "Lane mismatch (is_test). Refusing to archive across lanes.",
          record_is_test: Boolean(gl.is_test),
          request_is_test: Boolean(is_test),
        },
        400,
      );
    }

    // 3) Eligibility gate: require APPROVED and approved_by_council true (your seal fn is strict)
    // (Council sets status='APPROVED' and approved_by_council=true)
    if (gl.status !== "APPROVED" || Boolean(gl.approved_by_council) !== true) {
      return json(
        {
          ok: false,
          error: "Ledger not eligible for archive. Must be APPROVED and approved_by_council=true.",
          status: gl.status,
          approved_by_council: Boolean(gl.approved_by_council),
        },
        400,
      );
    }

    // 4) If envelope provided: validate belongs + completed, then sync its lane from ledger (Patch #2/#3)
    let envelope: any = null;
    if (envelope_id) {
      const envRes = await supabase
        .from("signature_envelopes")
        .select("id,record_id,status,is_test")
        .eq("id", envelope_id)
        .maybeSingle();

      if (envRes.error || !envRes.data) {
        return json(
          { ok: false, error: "signature_envelopes row not found", details: envRes.error ?? null },
          404,
        );
      }

      envelope = envRes.data as any;

      if (String(envelope.record_id) !== String(record_id)) {
        return json(
          { ok: false, error: "Envelope does not belong to record_id", record_id, envelope_id },
          400,
        );
      }

      if ((envelope.status ?? null) !== "completed") {
        return json(
          { ok: false, error: "Envelope is not completed", envelope_status: envelope.status ?? null },
          400,
        );
      }

      // Sync envelope lane from ledger (your trigger now allows updating is_test on completed envelope)
      const sync = await supabase.rpc(SYNC_ENVELOPE_LANE_RPC, { p_envelope_id: envelope_id });
      if (sync.error) {
        return json(
          { ok: false, error: "sync_envelope_lane_from_ledger failed", details: sync.error },
          500,
        );
      }
      envelope = sync.data ?? envelope;
    }

    // 5) Seal (idempotent). This generates deterministic archive PDF + upserts verified_documents (via your patch),
    // then locks/archives governance_ledger (TRUTH LANE LOCK allows service_role).
    const sealRes = await supabase.rpc(SEAL_RPC, { p_ledger_id: record_id });
    if (sealRes.error) {
      return json({ ok: false, error: `${SEAL_RPC} failed`, details: sealRes.error }, 500);
    }

    const seal = sealRes.data as any;

    // Normalize pointers from seal
    const storage_bucket: string =
      (seal?.storage_bucket as string) || MINUTE_BOOK_BUCKET;

    const storage_path: string | null =
      (seal?.storage_path as string) || null;

    const file_hash: string | null =
      (seal?.file_hash as string) || null;

    const file_size: number | null =
      typeof seal?.file_size === "number" ? seal.file_size : null;

    const mime_type: string | null =
      (seal?.mime_type as string) || "application/pdf";

    const verified_document_id: string | null =
      (seal?.verified_document_id as string) || null;

    if (!storage_path) {
      return json(
        {
          ok: false,
          error: "Seal did not return storage_path (cannot continue; UI needs primary storage pointers).",
          seal,
        },
        500,
      );
    }

    // 6) Ensure minute_book_entries exists (idempotent by source_record_id)
    // IMPORTANT: your schema requires entity_id (uuid NOT NULL), entity_key (enum), domain_key (text NOT NULL).
    // We also store is_test for lane filtering in CI-Archive.
    const existingEntry = await supabase
      .from("minute_book_entries")
      .select("id,storage_path,file_name,pdf_hash,entity_id,is_test")
      .eq("source_record_id", record_id)
      .maybeSingle();

    let minute_book_entry_id: string;

    if (!existingEntry.data) {
      const ins = await supabase
        .from("minute_book_entries")
        .insert({
          entity_id: gl.entity_id,
          entity_key: gl.entity_key,              // enum already on ledger (per your screenshots)
          is_test: Boolean(is_test),
          domain_key: DEFAULT_DOMAIN_KEY,
          section_name: DEFAULT_SECTION,
          title: gl.title ?? "Untitled",
          source_record_id: record_id,
          source_envelope_id: envelope_id || null,

          // primary pointers (so Reader can open immediately)
          storage_bucket,
          storage_path,
          pdf_hash: file_hash,
          file_name: `${record_id}.pdf`,
        })
        .select("id")
        .single();

      if (ins.error) {
        return json(
          { ok: false, error: "Failed to insert minute_book_entries", details: ins.error },
          500,
        );
      }
      minute_book_entry_id = (ins.data as any).id;
    } else {
      minute_book_entry_id = (existingEntry.data as any).id;

      // Repair/ensure pointers match sealed artifact (idempotent / repair-capable)
      const upd = await supabase
        .from("minute_book_entries")
        .update({
          entity_id: gl.entity_id,
          entity_key: gl.entity_key,
          is_test: Boolean(is_test),
          title: gl.title ?? "Untitled",
          source_envelope_id: envelope_id || null,

          storage_bucket,
          storage_path,
          pdf_hash: file_hash,
          file_name: `${record_id}.pdf`,
        })
        .eq("id", minute_book_entry_id);

      if (upd.error) {
        return json(
          { ok: false, error: "Failed to update minute_book_entries pointers", details: upd.error },
          500,
        );
      }
    }

    // 7) Ensure supporting_documents has a PRIMARY pointer for this minute_book_entry
    // (Your CI-Archive Reader expects primary doc pointers even if entry has pointers.)
    // We do a "best effort" upsert: if you already have a primary doc row, we update it; else insert.
    // Adjust column names if yours differ (common: is_primary, storage_bucket, storage_path, file_hash, mime_type, file_size).
    const primaryDoc = await supabase
      .from("supporting_documents")
      .select("id,is_primary")
      .eq("minute_book_entry_id", minute_book_entry_id)
      .eq("is_primary", true)
      .maybeSingle();

    if (!primaryDoc.data) {
      const insDoc = await supabase
        .from("supporting_documents")
        .insert({
          minute_book_entry_id,
          is_primary: true,
          title: gl.title ?? "Resolution PDF",
          storage_bucket,
          storage_path,
          file_hash,
          file_size,
          mime_type,
          is_test: Boolean(is_test), // if your supporting_documents also has lane flag
        })
        .select("id")
        .single();

      // If your schema doesn’t have is_test on supporting_documents, Supabase will error here.
      // In that case, remove is_test from this insert/update.
      if (insDoc.error) {
        // Retry without is_test (safe fallback if column doesn't exist)
        const insDoc2 = await supabase
          .from("supporting_documents")
          .insert({
            minute_book_entry_id,
            is_primary: true,
            title: gl.title ?? "Resolution PDF",
            storage_bucket,
            storage_path,
            file_hash,
            file_size,
            mime_type,
          })
          .select("id")
          .single();

        if (insDoc2.error) {
          return json(
            { ok: false, error: "Failed to insert PRIMARY supporting_documents", details: insDoc2.error },
            500,
          );
        }
      }
    } else {
      const updDoc = await supabase
        .from("supporting_documents")
        .update({
          storage_bucket,
          storage_path,
          file_hash,
          file_size,
          mime_type,
          title: gl.title ?? "Resolution PDF",
        })
        .eq("id", (primaryDoc.data as any).id);

      if (updDoc.error) {
        return json(
          { ok: false, error: "Failed to update PRIMARY supporting_documents pointers", details: updDoc.error },
          500,
        );
      }
    }

    // 8) Fetch verified_documents row (seal created/updated it; unique index ensures one per source)
    // Your schema uses source_table + source_record_id (and you added unique index on those).
    let verified_document: any = null;
    if (verified_document_id) {
      const vd = await supabase
        .from("verified_documents")
        .select("*")
        .eq("id", verified_document_id)
        .maybeSingle();

      verified_document = vd.data ?? null;
    } else {
      const vd = await supabase
        .from("verified_documents")
        .select("*")
        .eq("source_table", "governance_ledger")
        .eq("source_record_id", record_id)
        .maybeSingle();

      verified_document = vd.data ?? null;
    }

    return json({
      ok: true,
      record_id,
      envelope_id: envelope_id || null,
      is_test: Boolean(is_test),
      minute_book_entry_id,
      pointers: {
        storage_bucket,
        storage_path,
        file_hash,
        file_size,
        mime_type,
      },
      seal,
      verified_document,
    });
  } catch (e: any) {
    return json({ ok: false, error: e?.message ?? "Unhandled error", details: e ?? null }, 500);
  }
});
