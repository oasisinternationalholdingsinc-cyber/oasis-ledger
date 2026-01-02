import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  record_id: string; // governance_ledger.id
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MINUTE_BOOK_BUCKET = "minute_book";
const SEAL_RPC = "seal_governance_record_for_archive";

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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { global: { fetch } });

  try {
    const body = (await req.json().catch(() => ({}))) as Partial<ReqBody>;
    const record_id = (body.record_id ?? "").trim();
    if (!record_id) return json({ ok: false, error: "Missing record_id" }, 400);

    // 1) Seal (idempotent + lane-safe) -> returns pointers for the deterministic archive artifact
    const { data: seal, error: sealErr } = await supabase.rpc(SEAL_RPC, {
      p_ledger_id: record_id,
    });

    if (sealErr) {
      return json({ ok: false, error: "seal_governance_record_for_archive failed", details: sealErr }, 500);
    }

    // Expected: { storage_bucket, storage_path, file_hash, verified_document_id?, minute_book_entry_id? ... }
    const storage_bucket = String(seal?.storage_bucket ?? MINUTE_BOOK_BUCKET);
    const storage_path = String(seal?.storage_path ?? "");
    const file_hash = String(seal?.file_hash ?? "");
    if (!storage_path) {
      return json({ ok: false, error: "Seal returned no storage_path", seal }, 500);
    }

    // 2) Fetch governance_ledger to derive entity_id + title + lane
    const { data: gl, error: glErr } = await supabase
      .from("governance_ledger")
      .select("id, title, entity_id, is_test")
      .eq("id", record_id)
      .single();

    if (glErr || !gl) {
      return json({ ok: false, error: "governance_ledger not found", details: glErr }, 404);
    }

    const entity_id = gl.entity_id as string | null;
    const is_test = Boolean(gl.is_test);
    const title = String(gl.title ?? "Archived Governance Record");

    if (!entity_id) {
      return json({ ok: false, error: "Ledger missing entity_id" }, 400);
    }

    // 3) Resolve entity_key from entities.slug (holdings/lounge/real-estate)
    const { data: ent, error: entErr } = await supabase
      .from("entities")
      .select("slug")
      .eq("id", entity_id)
      .single();

    if (entErr || !ent?.slug) {
      return json({ ok: false, error: "Entity slug lookup failed", details: entErr }, 500);
    }

    const entity_slug = String(ent.slug);
    // your minute_book_entries.entity_key is an enum; your DB accepts slug-cast as entity_key_enum
    const entity_key = entity_slug; // keep as string; DB will cast if needed

    // 4) Upsert/repair minute_book_entries for this record (idempotent)
    //    We match on (source_record_id, is_test) to avoid lane collisions.
    const { data: existingEntry, error: entryFindErr } = await supabase
      .from("minute_book_entries")
      .select("id")
      .eq("source_record_id", record_id)
      .eq("is_test", is_test)
      .maybeSingle();

    if (entryFindErr) {
      return json({ ok: false, error: "minute_book_entries lookup failed", details: entryFindErr }, 500);
    }

    let entry_id: string;

    if (existingEntry?.id) {
      entry_id = existingEntry.id;
      const { error: updErr } = await supabase
        .from("minute_book_entries")
        .update({
          title,
          source: "signed_resolution",
          source_record_id: record_id,
          entity_id,
          is_test,
          storage_path,
          pdf_hash: file_hash || null,
          file_name: storage_path.split("/").pop() ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", entry_id);

      if (updErr) return json({ ok: false, error: "minute_book_entries update failed", details: updErr }, 500);
    } else {
      const { data: ins, error: insErr } = await supabase
        .from("minute_book_entries")
        .insert({
          entity_id,
          entity_key, // DB enum cast
          title,
          entry_type: "resolution",
          source: "signed_resolution",
          source_record_id: record_id,
          is_test,
          storage_path,
          pdf_hash: file_hash || null,
          file_name: storage_path.split("/").pop() ?? null,
          domain_key: "governance",
        })
        .select("id")
        .single();

      if (insErr || !ins?.id) return json({ ok: false, error: "minute_book_entries insert failed", details: insErr }, 500);
      entry_id = ins.id;
    }

    // 5) Ensure supporting_documents has a PRIMARY row pointing to the archive pdf
    //    Avoid your uq_supporting_documents_entry_file_path collisions by upserting on (entry_id, file_path) behavior
    //    If you have a unique constraint, safest is: try find first, else insert.
    const { data: primaryDoc, error: docFindErr } = await supabase
      .from("supporting_documents")
      .select("id")
      .eq("entry_id", entry_id)
      .eq("doc_type", "primary")
      .maybeSingle();

    if (docFindErr) {
      return json({ ok: false, error: "supporting_documents lookup failed", details: docFindErr }, 500);
    }

    if (primaryDoc?.id) {
      const { error: docUpdErr } = await supabase
        .from("supporting_documents")
        .update({
          file_path: storage_path,
          file_name: storage_path.split("/").pop() ?? title + ".pdf",
          file_hash: file_hash || null,
          verified: true,
          registry_visible: true,
        })
        .eq("id", primaryDoc.id);

      if (docUpdErr) return json({ ok: false, error: "supporting_documents update failed", details: docUpdErr }, 500);
    } else {
      const { error: docInsErr } = await supabase.from("supporting_documents").insert({
        entry_id,
        entity_key, // DB enum cast
        section: "governance", // matches your enum section type
        file_path: storage_path,
        file_name: storage_path.split("/").pop() ?? title + ".pdf",
        doc_type: "primary",
        file_hash: file_hash || null,
        verified: true,
        registry_visible: true,
      });

      if (docInsErr) return json({ ok: false, error: "supporting_documents insert failed", details: docInsErr }, 500);
    }

    // 6) Repair verified_documents if missing for this record
    // IMPORTANT: do NOT insert generated columns (source_storage_bucket/source_storage_path/source_entry_id)
    const { data: vdExisting, error: vdFindErr } = await supabase
      .from("verified_documents")
      .select("id, storage_bucket, storage_path")
      .eq("source_record_id", record_id)
      .maybeSingle();

    if (vdFindErr) {
      return json({ ok: false, error: "verified_documents lookup failed", details: vdFindErr }, 500);
    }

    if (!vdExisting?.id) {
      const { error: vdInsErr } = await supabase.from("verified_documents").insert({
        entity_id,
        entity_slug: entity_slug,
        document_class: "resolution",
        title,
        source_table: "governance_ledger",
        source_record_id: record_id,
        storage_bucket,
        storage_path,
        file_hash: file_hash || null,
        verification_level: "certified",
        is_archived: true,
      });

      if (vdInsErr) {
        return json({ ok: false, error: "verified_documents insert failed", details: vdInsErr }, 500);
      }
    }

    return json({
      ok: true,
      record_id,
      entry_id,
      storage_bucket,
      storage_path,
      file_hash,
      is_test,
      note: "Idempotent seal + pointers repaired",
    });
  } catch (e) {
    return json({ ok: false, error: "archive-save-document failed", details: { message: String(e) } }, 500);
  }
});
