// supabase/functions/archive-save-document/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  json,
  cors,
  serviceClient,
  SEAL_RPC,
  pickFileName,
  getActorUserId,
  pickMinuteBookPdfPath,
} from "../_shared/archive.ts";

type ReqBody = {
  record_id: string;          // governance_ledger.id
  envelope_id?: string;       // signature_envelopes.id (optional but helpful)
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const body = (await req.json()) as ReqBody;
    if (!body?.record_id) return json({ ok: false, error: "record_id required" }, 400);

    const supabase = serviceClient(req);

    // Load ledger (for title/entity_id/is_test)
    const { data: gl, error: glErr } = await supabase
      .from("governance_ledger")
      .select("id,title,entity_id,is_test,approved_by_council")
      .eq("id", body.record_id)
      .single();

    if (glErr || !gl) return json({ ok: false, step: "load_ledger", glErr }, 500);

    // Derive entity_key enum label from entities.slug (your canonical mapping)
    const { data: ent, error: entErr } = await supabase
      .from("entities")
      .select("slug")
      .eq("id", gl.entity_id)
      .single();

    if (entErr || !ent?.slug) return json({ ok: false, step: "load_entity", entErr }, 500);

    const entity_key = ent.slug; // assumes slug matches entity_key_enum label (holdings/lounge/real-estate)

    // 1) Seal (repair-capable; will also repair verified_documents if missing)
    const { data: seal, error: sealErr } = await supabase.rpc(SEAL_RPC, { p_ledger_id: gl.id });
    if (sealErr) return json({ ok: false, step: "seal_rpc", sealErr }, 500);

    // 2) Upsert minute_book_entries (repair-capable)
    const { data: mbe, error: mbeErr } = await supabase
      .from("minute_book_entries")
      .upsert(
        {
          entity_id: gl.entity_id,
          entity_key,                 // entity_key_enum
          domain_key: "governance",
          title: gl.title,
          is_test: !!gl.is_test,
          source_record_id: gl.id,
        },
        { onConflict: "source_record_id" },
      )
      .select("id, entity_key")
      .single();

    if (mbeErr || !mbe) return json({ ok: false, step: "upsert_minute_book_entries", mbeErr }, 500);

    // 3) Ensure supporting_documents PRIMARY exists (Reader depends on this)
    const actorId = (await getActorUserId(supabase)) ?? null;
    if (!actorId) {
      return json(
        {
          ok: false,
          step: "actor_id_missing",
          error:
            "No user session found on request. Call this from Forge with Authorization Bearer <user JWT>.",
        },
        401,
      );
    }

    const file_path = await pickMinuteBookPdfPath(supabase, gl.id, entity_key);
    if (!file_path) {
      return json(
        { ok: false, step: "pick_minute_book_pdf", error: "No minute_book PDF found for record" },
        500,
      );
    }

    const file_name = pickFileName(file_path);

    // doc_section_enum: use the enum label your system uses for resolutions
    // (you showed both "Resolutions" and "resolutions" exist — pick one and standardize)
    const section = "Resolutions";

    // idempotent insert of primary
    const { data: existingPrimary, error: existErr } = await supabase
      .from("supporting_documents")
      .select("id")
      .eq("entry_id", mbe.id)
      .eq("doc_type", "primary")
      .eq("file_path", file_path)
      .limit(1);

    if (existErr) return json({ ok: false, step: "check_existing_primary", existErr }, 500);

    let supportingInserted = 0;

    if (!existingPrimary || existingPrimary.length === 0) {
      const { error: insErr } = await supabase.from("supporting_documents").insert({
        entry_id: mbe.id,
        entity_key: mbe.entity_key,
        section,                 // doc_section_enum
        doc_type: "primary",
        file_path,
        file_name,
        version: 1,
        uploaded_by: actorId,
        owner_id: actorId,
        signature_envelope_id: body.envelope_id ?? null,
        verified: true,
        registry_visible: true,
        uploaded_at: new Date().toISOString(),
        metadata: {
          source: "archive-save-document",
          source_record_id: gl.id,
          bucket: "minute_book",
          path: file_path,
        },
      });

      if (insErr) return json({ ok: false, step: "insert_supporting_primary", insErr }, 500);
      supportingInserted = 1;
    }

    return json({
      ok: true,
      step: "archive-save-document",
      record_id: gl.id,
      minute_book_entry_id: mbe.id,
      primary_file_path: file_path,
      supporting_primary_inserted: supportingInserted,
      seal_result: seal,
    });
  } catch (e) {
    return json({ ok: false, error: "archive-save-document failed", details: String(e) }, 500);
  }
});
