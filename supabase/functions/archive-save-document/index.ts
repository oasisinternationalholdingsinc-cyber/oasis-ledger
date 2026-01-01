import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  cors,
  json,
  serviceClient,
  getActorUserId,
  MINUTE_BOOK_BUCKET,
  pickFileName,
  pickMinuteBookPdfPath,
} from "../_shared/archive.ts";

type ReqBody = {
  record_id: string; // governance_ledger.id
  is_test?: boolean;
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const supabase = serviceClient(req);

  try {
    const body = (await req.json()) as Partial<ReqBody>;
    const record_id = body.record_id?.trim();
    const is_test = !!body.is_test;

    if (!record_id) return json({ ok: false, error: "missing_record_id" }, 400);

    const actorId = await getActorUserId(supabase);

    // 1) Load ledger record (need entity + title)
    const { data: gl, error: glErr } = await supabase
      .from("governance_ledger")
      .select("id, title, entity_id, is_test")
      .eq("id", record_id)
      .maybeSingle();

    if (glErr) return json({ ok: false, error: "load_ledger_failed", details: glErr }, 500);
    if (!gl) return json({ ok: false, error: "ledger_not_found" }, 404);

    // Lane safety: prefer request flag, but if ledger has is_test, respect it
    const laneIsTest = typeof gl.is_test === "boolean" ? gl.is_test : is_test;

    // 2) Get entity slug -> entity_key
    const { data: ent, error: entErr } = await supabase
      .from("entities")
      .select("id, slug")
      .eq("id", gl.entity_id)
      .maybeSingle();

    if (entErr) return json({ ok: false, error: "load_entity_failed", details: entErr }, 500);
    if (!ent?.slug) return json({ ok: false, error: "entity_missing_slug" }, 500);

    const entitySlug = ent.slug;
    const entityKey = entitySlug; // your enum is derived from entities.slug (holdings/lounge/real-estate)

    // 3) Find the actual storage object path (case-sensitive)
    const picked = await pickMinuteBookPdfPath(supabase, record_id, entitySlug);
    if (!picked.path) {
      return json({
        ok: false,
        error: "minute_book_pdf_not_found",
        hint: `No object in bucket '${MINUTE_BOOK_BUCKET}' matched ledger id.`,
      }, 404);
    }

    const storage_path = picked.path;
    const storage_object_id = picked.objectId;
    const file_name = pickFileName(storage_path);

    // 4) Ensure minute_book_entries exists
    const { data: existingMBE, error: mbeFindErr } = await supabase
      .from("minute_book_entries")
      .select("id, entity_id, entity_key, is_test, source_record_id, title")
      .eq("source_record_id", record_id)
      .eq("is_test", laneIsTest)
      .maybeSingle();

    if (mbeFindErr) return json({ ok: false, error: "mbe_lookup_failed", details: mbeFindErr }, 500);

    let mbeId = existingMBE?.id as string | undefined;

    if (!mbeId) {
      const { data: inserted, error: mbeInsErr } = await supabase
        .from("minute_book_entries")
        .insert({
          entity_id: gl.entity_id,
          entity_key: entityKey,           // enum
          is_test: laneIsTest,
          domain_key: "resolutions",       // your upload contract
          section_name: "Resolutions",
          entry_type: "resolution",
          title: gl.title ?? "Untitled Resolution",
          source_record_id: record_id,
        })
        .select("id")
        .single();

      if (mbeInsErr) return json({ ok: false, error: "mbe_insert_failed", details: mbeInsErr }, 500);
      mbeId = inserted.id;
    }

    // 5) Ensure supporting_documents PRIMARY pointer exists (idempotent)
    // supporting_documents schema uses file_path/file_name/uploaded_at (NOT created_at)
    const { data: primarySD, error: sdFindErr } = await supabase
      .from("supporting_documents")
      .select("id, entry_id, file_path, doc_type")
      .eq("entry_id", mbeId!)
      .eq("doc_type", "primary")
      .order("uploaded_at", { ascending: false })
      .limit(1);

    if (sdFindErr) return json({ ok: false, error: "sd_lookup_failed", details: sdFindErr }, 500);

    if (primarySD?.[0]?.id) {
      const { error: sdUpdErr } = await supabase
        .from("supporting_documents")
        .update({
          file_path: storage_path,
          file_name,
          verified: true,
          registry_visible: true,
          storage_object_id,
          uploaded_at: new Date().toISOString(),
          uploaded_by: actorId ?? undefined,
          owner_id: actorId ?? undefined,
        })
        .eq("id", primarySD[0].id);

      if (sdUpdErr) return json({ ok: false, error: "sd_update_failed", details: sdUpdErr }, 500);
    } else {
      const { error: sdInsErr } = await supabase.from("supporting_documents").insert({
        entry_id: mbeId!,
        entity_key: entityKey,
        doc_type: "primary",
        file_path: storage_path,
        file_name,
        verified: true,
        registry_visible: true,
        storage_object_id,
        uploaded_at: new Date().toISOString(),
        uploaded_by: actorId ?? undefined,
        owner_id: actorId ?? undefined,
      });

      if (sdInsErr) {
        // If a primary already exists (unique partial index), repair it by updating the newest primary
        const { data: newest, error: newestErr } = await supabase
          .from("supporting_documents")
          .select("id")
          .eq("entry_id", mbeId!)
          .eq("doc_type", "primary")
          .order("uploaded_at", { ascending: false })
          .limit(1);

        if (newestErr || !newest?.[0]?.id) {
          return json({ ok: false, error: "sd_insert_failed", details: sdInsErr }, 500);
        }

        const { error: repairErr } = await supabase
          .from("supporting_documents")
          .update({
            file_path: storage_path,
            file_name,
            verified: true,
            registry_visible: true,
            storage_object_id,
            uploaded_at: new Date().toISOString(),
            uploaded_by: actorId ?? undefined,
            owner_id: actorId ?? undefined,
          })
          .eq("id", newest[0].id);

        if (repairErr) return json({ ok: false, error: "sd_repair_failed", details: repairErr }, 500);
      }
    }

    // 6) UPSERT verified_documents (DO NOT set generated columns)
    // document_class MUST be one of enum values -> use 'resolution'
    const upsertPayload = {
      entity_id: gl.entity_id,
      entity_slug: entitySlug,
      entity_key: entityKey,

      document_class: "resolution",
      title: "Certified Governance Archive PDF",
      source_table: "governance_ledger",
      source_record_id: record_id,

      storage_bucket: MINUTE_BOOK_BUCKET,
      storage_path,

      verification_level: "certified",
      is_archived: true,

      document_purpose: laneIsTest ? "SANDBOX" : "ROT",
      created_by: actorId ?? undefined,
    };

    const { data: vd, error: vdErr } = await supabase
      .from("verified_documents")
      .upsert(upsertPayload, { onConflict: "source_record_id,storage_bucket,storage_path" })
      .select("id")
      .single();

    if (vdErr) return json({ ok: false, error: "verified_upsert_failed", details: vdErr }, 500);

    return json({
      ok: true,
      minute_book_entry_id: mbeId,
      verified_document_id: vd?.id ?? null,
      storage_bucket: MINUTE_BOOK_BUCKET,
      storage_path,
      repaired: true,
    });
  } catch (e) {
    return json({ ok: false, error: "unhandled_exception", details: String(e) }, 500);
  }
});
