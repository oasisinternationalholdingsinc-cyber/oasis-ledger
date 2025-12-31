import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json, getServiceClient } from "../_shared/archive.ts";

type ReqBody = {
  record_id: string;          // governance_ledger.id
  is_test?: boolean;          // must match ledger lane
  envelope_id?: string | null; // optional: for supporting_documents.signature_envelope_id
};

type SealReturn = {
  storage_bucket: string | null;
  storage_path: string | null;
  file_hash: string | null;
  verified_document_id?: string | null;
  // allow extra fields without breaking
  [k: string]: any;
};

function basename(p: string | null | undefined): string | null {
  if (!p) return null;
  const parts = p.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  try {
    const { record_id, is_test, envelope_id }: ReqBody = await req.json();
    if (!record_id) return json({ ok: false, error: "Missing record_id" }, 400);

    const supabase = getServiceClient();

    // 0) Load ledger row for lane + entity derivation (no guessing columns)
    const { data: gl, error: glErr } = await supabase
      .from("governance_ledger")
      .select("id, title, entity_id, is_test")
      .eq("id", record_id)
      .maybeSingle();

    if (glErr) {
      return json({ ok: false, step: "load_governance_ledger", error: glErr.message, details: glErr }, 500);
    }
    if (!gl) return json({ ok: false, step: "load_governance_ledger", error: "Ledger record not found" }, 404);

    const ledgerLane = !!gl.is_test;
    const lane = typeof is_test === "boolean" ? is_test : ledgerLane;

    // ✅ Enterprise guardrail: never cross lanes (SANDBOX vs RoT)
    if (lane !== ledgerLane) {
      return json(
        {
          ok: false,
          step: "validate_lane",
          error: "Lane mismatch (is_test) between request and governance_ledger row",
          request_is_test: lane,
          ledger_is_test: ledgerLane,
        },
        400,
      );
    }

    // 1) Seal via SQL single source of truth (deterministic PDF + verified_documents + locks ledger)
    const { data: sealedRaw, error: sealErr } = await supabase.rpc("seal_governance_record_for_archive", {
      p_ledger_id: record_id,
    });

    if (sealErr) {
      return json(
        {
          ok: false,
          step: "seal_governance_record_for_archive",
          error: sealErr.message,
          details: sealErr,
        },
        500,
      );
    }

    const sealed = (sealedRaw ?? {}) as SealReturn;

    if (!sealed.storage_path || !sealed.file_hash) {
      return json(
        {
          ok: false,
          step: "validate_seal_return",
          error: "Sealer did not return storage_path/file_hash (cannot register primary pointers)",
          sealed,
        },
        500,
      );
    }

    // 2) Derive entity_key_enum from entities.slug (ledger does NOT store entity_key)
    const { data: ent, error: entErr } = await supabase
      .from("entities")
      .select("id, slug")
      .eq("id", gl.entity_id)
      .maybeSingle();

    if (entErr || !ent?.slug) {
      return json(
        {
          ok: false,
          step: "load_entity_slug",
          error: entErr?.message ?? "Entity not found for ledger record",
          details: entErr ?? null,
        },
        500,
      );
    }

    const entity_key = String(ent.slug); // cast in SQL via ::public.entity_key_enum

    // 3) Ensure minute_book_entries exists (idempotent repair)
    //    We DO NOT assume a unique constraint exists; we pick latest if multiple.
    const { data: existingMBE, error: mbeSelErr } = await supabase
      .from("minute_book_entries")
      .select("id, title, is_test")
      .eq("source_record_id", record_id)
      .eq("is_test", lane)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (mbeSelErr) {
      return json({ ok: false, step: "select_minute_book_entry", error: mbeSelErr.message, details: mbeSelErr }, 500);
    }

    let minute_book_entry_id: string | null = existingMBE?.id ?? null;

    if (!minute_book_entry_id) {
      // Required columns per your schema notes: entity_id, entity_key, domain_key, title, source_record_id, is_test
      const insertPayload: any = {
        entity_id: gl.entity_id,
        entity_key: entity_key, // enum cast handled by PostgREST if types match; if not, still stored as enum text
        domain_key: "governance", // stable domain for Forge archives
        title: gl.title ?? "Governance Record",
        source_record_id: record_id,
        is_test: lane,
        // entry_type defaults to 'resolution' in your schema; entry_date defaults now()
      };

      const { data: ins, error: mbeInsErr } = await supabase
        .from("minute_book_entries")
        .insert(insertPayload)
        .select("id")
        .maybeSingle();

      if (mbeInsErr) {
        return json(
          { ok: false, step: "insert_minute_book_entry", error: mbeInsErr.message, details: mbeInsErr, insertPayload },
          500,
        );
      }

      minute_book_entry_id = ins?.id ?? null;
    }

    if (!minute_book_entry_id) {
      return json({ ok: false, step: "validate_minute_book_entry_id", error: "Failed to resolve minute_book_entry_id" }, 500);
    }

    // 4) Ensure PRIMARY supporting_documents row exists with storage pointers (Reader depends on this)
    const primaryFileName = basename(sealed.storage_path) ?? "archive.pdf";

    // Look for an existing primary doc pointing at this exact path/hash (repair-safe)
    const { data: existingPrimary, error: sdSelErr } = await supabase
      .from("supporting_documents")
      .select("id, file_path, file_hash, doc_type")
      .eq("entry_id", minute_book_entry_id)
      .eq("doc_type", "primary")
      .order("uploaded_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (sdSelErr) {
      return json({ ok: false, step: "select_primary_supporting_document", error: sdSelErr.message, details: sdSelErr }, 500);
    }

    if (!existingPrimary) {
      const sdInsert: any = {
        entry_id: minute_book_entry_id,
        doc_type: "primary",
        file_path: sealed.storage_path,
        file_name: primaryFileName,
        file_hash: sealed.file_hash,
        mime_type: "application/pdf",
        signature_envelope_id: envelope_id ?? null,
        verified: true,
        registry_visible: true,
      };

      const { error: sdInsErr } = await supabase.from("supporting_documents").insert(sdInsert);

      if (sdInsErr) {
        return json(
          { ok: false, step: "insert_primary_supporting_document", error: sdInsErr.message, details: sdInsErr, sdInsert },
          500,
        );
      }
    } else {
      // Repair mode: ensure the pointers exist (don’t regress/overwrite unless missing)
      const needsRepair =
        !existingPrimary.file_path ||
        !existingPrimary.file_hash ||
        existingPrimary.file_path !== sealed.storage_path ||
        existingPrimary.file_hash !== sealed.file_hash;

      if (needsRepair) {
        const { error: sdUpdErr } = await supabase
          .from("supporting_documents")
          .update({
            file_path: sealed.storage_path,
            file_hash: sealed.file_hash,
            file_name: primaryFileName,
            mime_type: "application/pdf",
            signature_envelope_id: envelope_id ?? null,
            verified: true,
            registry_visible: true,
          })
          .eq("id", existingPrimary.id);

        if (sdUpdErr) {
          return json(
            { ok: false, step: "repair_primary_supporting_document", error: sdUpdErr.message, details: sdUpdErr },
            500,
          );
        }
      }
    }

    // 5) Verified registry is already handled by the sealer; we just return latest row for UX
    const { data: vd, error: vdErr } = await supabase
      .from("verified_documents")
      .select("id, storage_bucket, storage_path, file_hash, verification_level, created_at")
      .eq("source_record_id", record_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (vdErr) {
      // Don’t fail the archive if verified view is temporarily blocked; sealer already inserted it
      console.warn("verified_documents read error:", vdErr);
    }

    return json(
      {
        ok: true,
        step: "archive-save-document",
        record_id,
        is_test: lane,
        minute_book_entry_id,
        sealed,
        verified_document: vd ?? null,
      },
      200,
    );
  } catch (e) {
    return json(
      { ok: false, step: "archive-save-document", error: e instanceof Error ? e.message : String(e) },
      500,
    );
  }
});
