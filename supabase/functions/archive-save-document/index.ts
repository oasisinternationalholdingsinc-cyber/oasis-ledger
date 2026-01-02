import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MINUTE_BOOK_BUCKET = "minute_book";
const SEAL_RPC = "seal_governance_record_for_archive";

// IMPORTANT: minute_book_entries.chk_minute_book_source only allows:
// manual_upload, system_generated, signed_resolution, imported, legacy
const MINUTE_BOOK_SOURCE = "signed_resolution";

// IMPORTANT: governance_domains.key list shows 'governance' is the FK-safe domain for Resolutions & Minutes
const DOMAIN_KEY = "governance";
const SECTION_NAME = "Resolutions";

// supporting_documents requires NOT NULL uploaded_by + owner_id
// If auth.getUser() fails for any reason, you can set a system UUID here (optional):
const FALLBACK_SYSTEM_USER_ID = Deno.env.get("SYSTEM_USER_ID") ?? null;

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

type ReqBody = {
  record_id: string; // governance_ledger.id
};

function pickFileName(path: string) {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

function serviceClient(req: Request) {
  // service_role for DB writes, but preserve user's JWT so auth.getUser() works
  const authHeader = req.headers.get("authorization") ?? "";
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { authorization: authHeader } },
  });
}

async function getActorUserId(supabase: ReturnType<typeof createClient>) {
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  return data?.user?.id ?? null;
}

async function trySeal(
  supabase: ReturnType<typeof createClient>,
  recordId: string,
) {
  // Try multiple arg names to survive signature drift
  const attempts: Array<Record<string, unknown>> = [
    { p_ledger_id: recordId },
    { p_record_id: recordId },
    { record_id: recordId },
    { id: recordId },
  ];

  let lastErr: any = null;

  for (const args of attempts) {
    const { data, error } = await supabase.rpc(SEAL_RPC, args);
    if (!error) return data;
    lastErr = error;
  }

  throw lastErr ?? new Error("seal rpc failed");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  try {
    const supabase = serviceClient(req);
    const actorId = (await getActorUserId(supabase)) ?? FALLBACK_SYSTEM_USER_ID;

    if (!actorId) {
      return json(
        {
          ok: false,
          error:
            "No actor user id (auth.getUser failed). Provide Authorization Bearer JWT from UI, or set SYSTEM_USER_ID env.",
        },
        401,
      );
    }

    const body = (await req.json()) as Partial<ReqBody>;
    const recordId = String(body.record_id ?? "").trim();
    if (!recordId) return json({ ok: false, error: "record_id required" }, 400);

    // 1) Load ledger + entity slug (entity_key_enum must be holdings/lounge/real_estate — NOT sandbox)
    const { data: gl, error: glErr } = await supabase
      .from("governance_ledger")
      .select("id,title,entity_id,is_test,created_at,approved_by_council,archived,locked,status")
      .eq("id", recordId)
      .maybeSingle();

    if (glErr || !gl) {
      return json({ ok: false, error: "ledger not found", details: glErr }, 404);
    }

    const { data: ent, error: entErr } = await supabase
      .from("entities")
      .select("id,slug")
      .eq("id", gl.entity_id)
      .maybeSingle();

    if (entErr || !ent?.slug) {
      return json({ ok: false, error: "entity slug not found", details: entErr }, 400);
    }

    const entityKey = String(ent.slug); // "holdings" | "lounge" | "real_estate" (must match enum)

    // 2) Seal (idempotent, lane-safe) — MUST return storage pointers
    const seal = await trySeal(supabase, recordId);

    // Expected keys from your function: storage_bucket, storage_path, file_hash
    const storageBucket = seal?.storage_bucket ?? seal?.bucket ?? seal?.storageBucket ?? null;
    const storagePath = seal?.storage_path ?? seal?.path ?? seal?.storagePath ?? null;
    const fileHash = seal?.file_hash ?? seal?.hash ?? seal?.fileHash ?? null;

    if (!storageBucket || !storagePath) {
      return json(
        { ok: false, error: "Seal did not return storage pointers", details: seal ?? null },
        500,
      );
    }

    // 3) Upsert minute_book_entries (FK-safe domain_key + chk_minute_book_source safe source)
    const entryDate = (gl.created_at ? String(gl.created_at).slice(0, 10) : null) ?? null;

    const { data: mbeRows, error: mbeErr } = await supabase
      .from("minute_book_entries")
      .upsert(
        {
          entity_id: gl.entity_id,
          entity_key: entityKey,
          is_test: !!gl.is_test,
          entry_type: "resolution",
          title: gl.title,
          entry_date: entryDate, // can be null if DB default exists; but your schema shows NOT NULL, so we pass it.
          domain_key: DOMAIN_KEY,
          section_name: SECTION_NAME,
          source: MINUTE_BOOK_SOURCE,
          source_record_id: gl.id,
          storage_path: storagePath,
          pdf_hash: fileHash,
        } as any,
        {
          onConflict: "entity_key,entry_date,title",
          ignoreDuplicates: false,
        },
      )
      .select("id,source_record_id,storage_path")
      .limit(1);

    if (mbeErr || !mbeRows?.[0]?.id) {
      return json({ ok: false, error: "minute_book_entries upsert failed", details: mbeErr }, 500);
    }

    const mbeId = mbeRows[0].id as string;

    // 4) Ensure supporting_documents PRIMARY pointer exists (required: uploaded_by, owner_id)
    const { data: existingPrimary } = await supabase
      .from("supporting_documents")
      .select("id")
      .eq("entry_id", mbeId)
      .eq("doc_type", "primary")
      .limit(1);

    let primaryDocId: string | null = existingPrimary?.[0]?.id ?? null;

    if (!primaryDocId) {
      const { data: ins, error: insErr } = await supabase
        .from("supporting_documents")
        .insert(
          {
            entry_id: mbeId,
            entity_key: entityKey,
            section: "resolutions", // doc_section_enum in your schema; "resolutions" is what you've been using successfully
            file_path: storagePath,
            file_name: pickFileName(storagePath),
            doc_type: "primary",
            version: 1,
            uploaded_by: actorId,
            uploaded_at: new Date().toISOString(),
            owner_id: actorId,
            file_hash: fileHash,
            mime_type: "application/pdf",
            verified: true,
            registry_visible: true,
            metadata: {},
          } as any,
        )
        .select("id")
        .limit(1);

      if (insErr || !ins?.[0]?.id) {
        return json(
          { ok: false, error: "supporting_documents primary insert failed", details: insErr },
          500,
        );
      }

      primaryDocId = ins[0].id as string;
    }

    // 5) Ensure verified_documents row exists (DO NOT supply generated columns)
    // Required: title NOT NULL, verification_level is enum, document_class is enum.
    // Also: storage_bucket + storage_path are required.
    const { data: existingVD } = await supabase
      .from("verified_documents")
      .select("id")
      .eq("source_record_id", gl.id)
      .eq("storage_bucket", MINUTE_BOOK_BUCKET)
      .eq("storage_path", storagePath)
      .limit(1);

    let verifiedDocumentId: string | null = existingVD?.[0]?.id ?? null;

    if (!verifiedDocumentId) {
      const { data: vdIns, error: vdErr } = await supabase
        .from("verified_documents")
        .insert(
          {
            entity_id: gl.entity_id,
            entity_slug: entityKey,
            document_class: "resolution",
            title: gl.title,
            source_table: "governance_ledger",
            source_record_id: gl.id,
            storage_bucket: MINUTE_BOOK_BUCKET,
            storage_path: storagePath,
            file_hash: fileHash,
            verification_level: "certified",
            is_archived: true,
          } as any,
        )
        .select("id")
        .limit(1);

      if (vdErr || !vdIns?.[0]?.id) {
        return json({ ok: false, error: "verified_documents insert failed", details: vdErr }, 500);
      }

      verifiedDocumentId = vdIns[0].id as string;
    }

    return json({
      ok: true,
      record_id: gl.id,
      minute_book_entry_id: mbeId,
      primary_doc_id: primaryDocId,
      verified_document_id: verifiedDocumentId,
      storage_bucket: storageBucket,
      storage_path: storagePath,
      file_hash: fileHash,
    });
  } catch (e) {
    return json(
      {
        ok: false,
        error: "archive-save-document failed",
        details: { message: String((e as any)?.message ?? e), raw: e ?? null },
      },
      500,
    );
  }
});
