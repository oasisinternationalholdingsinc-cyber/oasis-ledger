import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  record_id: string;      // governance_ledger.id
  actor_uid?: string;     // who to stamp uploaded_by/owner_id (defaults to Abbas)
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

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

const SEAL_RPC = "seal_governance_record_for_archive";

// Your user id (used when actor_uid not passed)
const DEFAULT_ACTOR_UID = "ac35a784-b5ce-4f2a-a5de-a5acd04955e7";

// Minute book “domain taxonomy” in prod
const DOMAIN_KEY = "governance";      // exists in governance_domains (Resolutions & Minutes)
const SECTION_NAME = "Resolutions";   // display grouping
const SOURCE_ALLOWED = "signed_resolution"; // passes chk_minute_book_source
const BUCKET_MINUTE_BOOK = "minute_book";

function firstRow(data: unknown): any | null {
  if (!data) return null;
  if (Array.isArray(data)) return data[0] ?? null;
  if (typeof data === "object") return data as any;
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const body = (await req.json()) as ReqBody;
    const record_id = String(body.record_id || "").trim();
    const actor_uid = String(body.actor_uid || DEFAULT_ACTOR_UID).trim();

    if (!record_id) return json({ ok: false, error: "record_id required" }, 400);

    // 1) Load ledger + entity slug (needed for entity_key_enum + entity_id)
    const { data: gl, error: glErr } = await supabase
      .from("governance_ledger")
      .select("id,title,entity_id,is_test,approved_by_council,archived,locked,status")
      .eq("id", record_id)
      .maybeSingle();

    if (glErr) return json({ ok: false, error: "load governance_ledger failed", details: glErr }, 500);
    if (!gl) return json({ ok: false, error: "ledger not found" }, 404);

    const { data: ent, error: entErr } = await supabase
      .from("entities")
      .select("id,slug")
      .eq("id", gl.entity_id)
      .maybeSingle();

    if (entErr) return json({ ok: false, error: "load entities failed", details: entErr }, 500);
    if (!ent?.slug) return json({ ok: false, error: "entity slug missing for ledger.entity_id" }, 500);

    const entity_slug = String(ent.slug);
    const entity_id = String(ent.id);
    const title = String(gl.title ?? "Untitled");

    // 2) Seal (single source of truth) — IMPORTANT: correct arg name
    const { data: sealData, error: sealErr } = await supabase.rpc(SEAL_RPC, {
      p_ledger_id: record_id,
    });

    if (sealErr) {
      return json({ ok: false, error: "seal rpc failed", details: sealErr }, 500);
    }

    const seal = firstRow(sealData);
    const storage_bucket = seal?.storage_bucket ?? seal?.bucket ?? seal?.bucket_id ?? null;
    const storage_path = seal?.storage_path ?? seal?.path ?? null;
    const file_hash = seal?.file_hash ?? seal?.pdf_hash ?? null;
    const verified_document_id = seal?.verified_document_id ?? null;
    const minute_book_entry_id = seal?.minute_book_entry_id ?? null;

    // If seal returns no pointers, we can still repair from storage.objects by searching for a pdf containing record_id.
    // But this SHOULD NOT happen if the RPC is correct. Still, we fail loudly with context.
    if (!storage_bucket || !storage_path) {
      return json(
        {
          ok: false,
          error: "seal did not return storage pointers",
          details: {
            seal_preview: seal,
            hint: "Check RPC return columns & ensure rpc arg is { p_ledger_id }",
          },
        },
        500,
      );
    }

    // 3) Upsert minute_book_entries (idempotent) — must respect your unique key:
    // minute_book_entries_entity_key_entry_date_title_key
    //
    // We choose entry_date as COALESCE(gl.signed_at?, gl.created_at?, now()) BUT we only have title + record.
    // To keep it stable and avoid duplicates, we prefer:
    // - if already exists for source_record_id, update it
    // - else upsert using (entity_key, entry_date::date, title) with entry_date = today (UTC)
    //
    // Since you already created rows successfully with entry_date = current date, we do same.
    const entry_date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC date)

    // Try find existing entry by source_record_id first
    const { data: mbeExisting, error: mbeFindErr } = await supabase
      .from("minute_book_entries")
      .select("id,entry_date,title,entity_key,is_test,storage_path,source_record_id")
      .eq("source_record_id", record_id)
      .limit(1)
      .maybeSingle();

    if (mbeFindErr) {
      return json({ ok: false, error: "minute_book_entries lookup failed", details: mbeFindErr }, 500);
    }

    let mbe_id: string | null = mbeExisting?.id ?? null;

    if (mbe_id) {
      // Update existing
      const { error: mbeUpdErr } = await supabase
        .from("minute_book_entries")
        .update({
          entity_id,
          is_test: !!gl.is_test,
          domain_key: DOMAIN_KEY,
          section_name: SECTION_NAME,
          source: SOURCE_ALLOWED,
          source_record_id: record_id,
          storage_path: storage_path,
          pdf_hash: file_hash,
          // keep entry_date/title as-is to preserve unique key stability
        })
        .eq("id", mbe_id);

      if (mbeUpdErr) return json({ ok: false, error: "minute_book_entries update failed", details: mbeUpdErr }, 500);
    } else {
      // Insert with ON CONFLICT emulation: use upsert on the unique key columns
      // Supabase upsert needs explicit onConflict string.
      const { data: mbeIns, error: mbeInsErr } = await supabase
        .from("minute_book_entries")
        .upsert(
          {
            entity_id,
            entity_key: entity_slug, // casts to entity_key_enum (holdings/lounge/real-estate)
            entry_date,
            entry_type: "resolution", // entry_type_enum
            title,
            is_test: !!gl.is_test,
            domain_key: DOMAIN_KEY,
            section_name: SECTION_NAME,
            source: SOURCE_ALLOWED, // passes chk_minute_book_source
            source_record_id: record_id,
            storage_path,
            pdf_hash: file_hash,
            registry_status: "active",
          } as any,
          { onConflict: "entity_key,entry_date,title" },
        )
        .select("id")
        .limit(1)
        .maybeSingle();

      if (mbeInsErr) {
        return json(
          {
            ok: false,
            error: "minute_book_entries upsert failed",
            details: mbeInsErr,
            hint: "If this is duplicate-key, it already exists; run a lookup by source_record_id.",
          },
          500,
        );
      }

      mbe_id = mbeIns?.id ?? null;
    }

    if (!mbe_id) {
      return json({ ok: false, error: "minute_book_entries id missing after upsert" }, 500);
    }

    // 4) Ensure primary supporting_documents pointer exists (idempotent)
    const { data: primaryExisting, error: pFindErr } = await supabase
      .from("supporting_documents")
      .select("id")
      .eq("entry_id", mbe_id)
      .eq("doc_type", "primary")
      .limit(1)
      .maybeSingle();

    if (pFindErr) return json({ ok: false, error: "supporting_documents lookup failed", details: pFindErr }, 500);

    let primary_doc_id: string | null = primaryExisting?.id ?? null;

    if (!primary_doc_id) {
      const { data: pIns, error: pInsErr } = await supabase
        .from("supporting_documents")
        .insert({
          entry_id: mbe_id,
          entity_key: entity_slug,         // entity_key_enum
          section: "resolutions",          // doc_section_enum (you already used this successfully)
          file_path: storage_path,
          file_name: storage_path.split("/").pop() ?? `${record_id}.pdf`,
          doc_type: "primary",
          version: 1,
          uploaded_by: actor_uid,          // NOT NULL
          uploaded_at: new Date().toISOString(),
          owner_id: actor_uid,             // NOT NULL
          file_hash: file_hash,
          mime_type: "application/pdf",
          verified: true,
          registry_visible: true,
          metadata: {},                    // NOT NULL jsonb
        } as any)
        .select("id")
        .limit(1)
        .maybeSingle();

      if (pInsErr) return json({ ok: false, error: "supporting_documents insert failed", details: pInsErr }, 500);

      primary_doc_id = pIns?.id ?? null;
    }

    // 5) Ensure verified_documents row exists pointing to minute_book storage pointers (idempotent)
    const { data: vdExisting, error: vdFindErr } = await supabase
      .from("verified_documents")
      .select("id")
      .eq("source_record_id", record_id)
      .eq("storage_bucket", BUCKET_MINUTE_BOOK)
      .eq("storage_path", storage_path)
      .limit(1)
      .maybeSingle();

    if (vdFindErr) return json({ ok: false, error: "verified_documents lookup failed", details: vdFindErr }, 500);

    let verified_id: string | null = vdExisting?.id ?? verified_document_id ?? null;

    if (!vdExisting?.id) {
      const { data: vdIns, error: vdInsErr } = await supabase
        .from("verified_documents")
        .insert({
          entity_id,
          entity_slug,
          document_class: "resolution",          // enum document_class
          title,                                // NOT NULL
          source_table: "governance_ledger",
          source_record_id: record_id,
          storage_bucket: BUCKET_MINUTE_BOOK,
          storage_path,
          file_hash: file_hash,
          mime_type: "application/pdf",
          verification_level: "certified",       // enum verification_level
          is_archived: true,
          document_type: "other",
        } as any)
        .select("id")
        .limit(1)
        .maybeSingle();

      if (vdInsErr) return json({ ok: false, error: "verified_documents insert failed", details: vdInsErr }, 500);

      verified_id = vdIns?.id ?? null;
    }

    return json({
      ok: true,
      record_id,
      entity_slug,
      is_test: !!gl.is_test,
      seal: {
        storage_bucket,
        storage_path,
        file_hash,
        verified_document_id: verified_id,
        minute_book_entry_id: mbe_id,
      },
      repaired: {
        minute_book_entry_id: mbe_id,
        primary_doc_id,
        verified_document_id: verified_id,
      },
    });
  } catch (e) {
    return json({ ok: false, error: "unhandled", details: String(e?.message ?? e) }, 500);
  }
});
