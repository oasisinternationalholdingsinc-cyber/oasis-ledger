import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  record_id: string;   // governance_ledger.id
  envelope_id: string; // signature_envelopes.id
  is_test?: boolean;   // optional; ledger.is_test is source of truth
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

const MINUTE_BOOK_BUCKET = "minute_book";

// IMPORTANT: your seal RPC returns a “sealed artifact” (bucket/path/hash).
// We also copy that PDF into minute_book bucket so your Minute Book Reader can open it
// (supporting_documents has no bucket column).
function minuteBookPrimaryPath(is_test: boolean, entitySlugOrKey: string, recordId: string) {
  const lane = is_test ? "sandbox" : "rot";
  // keep it simple & deterministic
  return `${lane}/${entitySlugOrKey}/governance/${recordId}.pdf`;
}

function asBool(v: unknown, fallback = false) {
  return typeof v === "boolean" ? v : fallback;
}

async function tryRpc(fn: string, args: any) {
  return await supabase.rpc(fn as any, args as any);
}

async function downloadFromBucket(bucket: string, path: string): Promise<Uint8Array> {
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error || !data) throw new Error(`storage.download failed: ${error?.message ?? "no data"}`);
  const ab = await data.arrayBuffer();
  return new Uint8Array(ab);
}

async function uploadToBucket(bucket: string, path: string, bytes: Uint8Array) {
  // upsert true so Archive Now is repair/idempotent
  const { error } = await supabase.storage.from(bucket).upload(path, bytes, {
    contentType: "application/pdf",
    upsert: true,
  });
  if (error) throw new Error(`storage.upload failed: ${error.message}`);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const body = (await req.json()) as ReqBody;

    const record_id = (body?.record_id ?? "").trim();
    const envelope_id = (body?.envelope_id ?? "").trim();

    if (!record_id) return json({ ok: false, error: "record_id is required" }, 400);
    if (!envelope_id) return json({ ok: false, error: "envelope_id is required" }, 400);

    // 0) Envelope must exist + be completed + match record_id
    const env = await supabase
      .from("signature_envelopes")
      .select("id, record_id, status, created_by, is_test")
      .eq("id", envelope_id)
      .maybeSingle();

    if (env.error || !env.data) {
      return json({ ok: false, error: "signature_envelopes row not found", details: env.error ?? null }, 404);
    }

    const envRecordId = (env.data as any).record_id as string;
    const envStatus = ((env.data as any).status as string | null) ?? null;
    const envCreatedBy = (env.data as any).created_by as string | null;

    if (envRecordId !== record_id) {
      return json(
        { ok: false, error: "Envelope record_id mismatch", envelope_record_id: envRecordId, request_record_id: record_id },
        400,
      );
    }
    if (envStatus !== "completed") {
      return json({ ok: false, error: "Envelope is not completed yet.", envelope_status: envStatus }, 400);
    }
    if (!envCreatedBy) {
      return json({ ok: false, error: "Envelope missing created_by (needed for minute book pointers)." }, 500);
    }

    // 1) Ledger basics (ledger.is_test is source of truth)
    const gl = await supabase
      .from("governance_ledger")
      .select("id, title, entity_id, created_by, is_test")
      .eq("id", record_id)
      .maybeSingle();

    if (gl.error || !gl.data) {
      return json({ ok: false, error: "governance_ledger row not found", details: gl.error ?? null }, 404);
    }

    const entity_id = (gl.data as any).entity_id as string | null;
    const title = ((gl.data as any).title as string | null) ?? "Untitled Resolution";
    const ledgerCreatedBy = (gl.data as any).created_by as string | null;
    const ledgerIsTest = asBool((gl.data as any).is_test, false);

    if (!entity_id) return json({ ok: false, error: "Ledger missing entity_id (required for minute_book_entries)" }, 500);

    // Optional input is_test must not fight ledger truth
    if (typeof body.is_test === "boolean" && body.is_test !== ledgerIsTest) {
      return json(
        { ok: false, error: "Lane mismatch: body.is_test != governance_ledger.is_test", body_is_test: body.is_test, ledger_is_test: ledgerIsTest },
        400,
      );
    }

    // 2) Resolve entity slug/key (use entities table; do NOT rely on organization_entities)
    const ent = await supabase
      .from("entities")
      .select("id, slug")
      .eq("id", entity_id)
      .maybeSingle();

    const entity_slug = (ent.data as any)?.slug ?? "unknown-entity";
    const entity_key = entity_slug; // your minute_book_entries.entity_key is an enum in your schema; assuming slug matches your enum label

    // 3) If ledger.created_by is NULL, set it to envelope.created_by (service_role allowed)
    if (!ledgerCreatedBy) {
      const up = await supabase
        .from("governance_ledger")
        .update({ created_by: envCreatedBy })
        .eq("id", record_id)
        .is("created_by", null);

      // don’t hard fail if it was set concurrently
      if (up.error) {
        return json({ ok: false, error: "Failed to set governance_ledger.created_by", details: up.error }, 500);
      }
    }

    // 4) Find/create minute_book_entries lane-safe (source_record_id + is_test)
    const existing = await supabase
      .from("minute_book_entries")
      .select("id, title, is_test, storage_path, pdf_hash")
      .eq("source_record_id", record_id)
      .eq("is_test", ledgerIsTest)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let minute_book_entry_id: string | null = (existing.data as any)?.id ?? null;
    const already_has_entry = !!minute_book_entry_id;

    if (!minute_book_entry_id) {
      // domain_key must exist; choose "governance" if present else first active
      const dom = await supabase
        .from("governance_domains")
        .select("key")
        .eq("key", "governance")
        .limit(1)
        .maybeSingle();

      let domain_key = (dom.data as any)?.key ?? null;

      if (!domain_key) {
        const dom2 = await supabase
          .from("governance_domains")
          .select("key")
          .eq("active", true)
          .order("sort_order", { ascending: true })
          .limit(1)
          .maybeSingle();
        domain_key = (dom2.data as any)?.key ?? null;
      }

      if (!domain_key) {
        return json({ ok: false, error: "No governance_domains found. Seed governance_domains before archiving." }, 500);
      }

      const section = await supabase
        .from("governance_domain_sections")
        .select("default_section")
        .eq("domain_key", domain_key)
        .limit(1)
        .maybeSingle();

      const section_name = (section.data as any)?.default_section ?? "General";

      const ins = await supabase
        .from("minute_book_entries")
        .insert({
          entity_id,
          entity_key,
          domain_key,
          section_name,
          title,
          source: "signed_resolution",
          source_record_id: record_id,
          source_envelope_id: envelope_id,
          is_test: ledgerIsTest,
          entry_type: "resolution",
        })
        .select("id")
        .single();

      if (ins.error || !ins.data) {
        return json({ ok: false, error: "Failed to create minute_book_entries row", details: ins.error ?? null }, 500);
      }
      minute_book_entry_id = (ins.data as any).id as string;
    }

    // 5) Seal/render archive artifact (idempotent)
    let seal = await tryRpc("seal_governance_record_for_archive", {
      record_id,
      envelope_id,
      is_test: ledgerIsTest,
    });

    if (seal.error) {
      seal = await tryRpc("seal_governance_record_for_archive", {
        p_record_id: record_id,
        p_envelope_id: envelope_id,
        p_is_test: ledgerIsTest,
      });
    }

    if (seal.error) {
      return json({ ok: false, error: "seal_governance_record_for_archive failed", details: seal.error ?? null }, 500);
    }

    const sealed = seal.data ?? {};
    const sealed_bucket = sealed.storage_bucket ?? sealed.bucket ?? null;
    const sealed_path = sealed.storage_path ?? sealed.path ?? null;
    const sealed_hash = sealed.file_hash ?? sealed.hash ?? null;

    if (!sealed_bucket || !sealed_path || !sealed_hash) {
      return json(
        { ok: false, error: "Seal did not return storage_bucket/storage_path/file_hash", details: sealed },
        500,
      );
    }

    // 6) Copy sealed PDF into minute_book bucket for the Minute Book Reader
    const primary_path = minuteBookPrimaryPath(ledgerIsTest, entity_slug, record_id);
    const pdfBytes = await downloadFromBucket(sealed_bucket, sealed_path);
    await uploadToBucket(MINUTE_BOOK_BUCKET, primary_path, pdfBytes);

    // 7) Update minute_book_entries primary pointers (repair-safe)
    const mbUp = await supabase
      .from("minute_book_entries")
      .update({
        storage_path: primary_path,
        pdf_hash: sealed_hash,
        file_name: primary_path.split("/").pop() ?? "resolution.pdf",
        source_envelope_id: envelope_id,
        source_record_id: record_id,
      })
      .eq("id", minute_book_entry_id);

    if (mbUp.error) {
      return json({ ok: false, error: "Failed to update minute_book_entries pointers", details: mbUp.error }, 500);
    }

    // 8) Insert supporting_documents pointer (MUST set uploaded_by + owner_id explicitly)
    // (If you have dedupe constraints in DB, it will naturally prevent duplicates; otherwise this may add rows — tolerable.)
    const sd = await supabase.from("supporting_documents").insert({
      entry_id: minute_book_entry_id,
      entity_key,
      section: "general", // must be a valid enum label in your schema; change if needed
      doc_type: "resolution_pdf",
      file_path: primary_path,
      file_name: primary_path.split("/").pop() ?? "resolution.pdf",
      file_hash: sealed_hash,
      mime_type: "application/pdf",
      signature_envelope_id: envelope_id,
      verified: true,
      registry_visible: true,
      uploaded_by: envCreatedBy,
      owner_id: envCreatedBy,
      metadata: { sealed_bucket, sealed_path }, // keep provenance
    });

    // Don’t hard fail on duplicates / enum mismatch; BUT surface it
    if (sd.error) {
      console.warn("supporting_documents insert error:", sd.error);
    }

    // 9) Ensure verified_documents exists (source_record_id, NOT source_entry_id)
    const vdExisting = await supabase
      .from("verified_documents")
      .select("id, storage_bucket, storage_path, file_hash, verification_level, created_at")
      .eq("source_record_id", record_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!vdExisting.data) {
      const vdIns = await supabase.from("verified_documents").insert({
        source_table: "governance_ledger",
        source_record_id: record_id,
        entity_id,
        entity_slug,
        title,
        storage_bucket: sealed_bucket,
        storage_path: sealed_path,
        file_hash: sealed_hash,
        envelope_id,
        verification_level: "draft", // keep enum-safe; your type may not accept "SEALED"
        is_archived: true,
        created_by: envCreatedBy,
        updated_by: envCreatedBy,
        entity_key: entity_key,
      });

      if (vdIns.error) {
        return json({ ok: false, error: "Failed to create verified_documents row", details: vdIns.error }, 500);
      }
    }

    const vdFinal = await supabase
      .from("verified_documents")
      .select("id, storage_bucket, storage_path, file_hash, verification_level, created_at")
      .eq("source_record_id", record_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return json({
      ok: true,
      record_id,
      envelope_id,
      is_test: ledgerIsTest,
      minute_book_entry_id,
      already_had_entry: already_has_entry,
      sealed: { storage_bucket: sealed_bucket, storage_path: sealed_path, file_hash: sealed_hash, raw: sealed },
      minute_book_primary: { bucket: MINUTE_BOOK_BUCKET, path: primary_path, hash: sealed_hash },
      verified_document: vdFinal.data ?? null,
      supporting_documents_insert_error: sd.error ?? null,
    });
  } catch (e: any) {
    return json({ ok: false, error: e?.message ?? "Unhandled error" }, 500);
  }
});
