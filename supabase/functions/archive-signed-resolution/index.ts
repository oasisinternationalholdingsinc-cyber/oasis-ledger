import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";

type ReqBody = {
  envelope_id?: string;
  record_id?: string; // governance_ledger.id
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

const MINUTE_BOOK_BUCKET = "minute_book";
const SEAL_RPC = "seal_governance_record_for_archive";

/* =========================
   ENTERPRISE CORS (FIXED)
   ========================= */
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (x: unknown, s = 200) =>
  new Response(JSON.stringify(x, null, 2), {
    status: s,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

async function bestEffortUpdateSignatureEnvelope(
  envelopeId: string,
  patch: Record<string, any>,
) {
  try {
    const { error } = await supabase
      .from("signature_envelopes")
      .update(patch)
      .eq("id", envelopeId);
    return !error;
  } catch {
    return false;
  }
}

serve(async (req) => {
  try {
    /* ========= CORS PRE-FLIGHT ========= */
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    if (req.method !== "POST") {
      return json({ ok: false, error: "POST only" }, 405);
    }

    const { envelope_id, record_id } = (await req.json()) as ReqBody;
    if (!envelope_id && !record_id) {
      return json(
        { ok: false, error: "envelope_id or record_id required" },
        400,
      );
    }

    /* ========= 1) Resolve Envelope / Record ========= */
    let resolvedRecordId = record_id ?? null;
    let envRow: any = null;

    if (envelope_id) {
      const { data: env, error } = await supabase
        .from("signature_envelopes")
        .select("id, record_id, status, storage_bucket, storage_path")
        .eq("id", envelope_id)
        .maybeSingle();

      if (error) return json({ ok: false, error: error.message }, 500);
      if (!env) return json({ ok: false, error: "Envelope not found" }, 404);
      if (env.status !== "completed") {
        return json(
          { ok: false, error: "Envelope not completed" },
          400,
        );
      }

      envRow = env;
      resolvedRecordId = resolvedRecordId ?? env.record_id ?? null;
    }

    if (!resolvedRecordId) {
      return json({ ok: false, error: "Unable to resolve record_id" }, 400);
    }

    /* ========= 2) Ledger = Lane Truth ========= */
    const { data: ledger, error: ledErr } = await supabase
      .from("governance_ledger")
      .select("id, title, entity_id, is_test")
      .eq("id", resolvedRecordId)
      .maybeSingle();

    if (ledErr) return json({ ok: false, error: ledErr.message }, 500);
    if (!ledger)
      return json({ ok: false, error: "Ledger record not found" }, 404);

    const { data: entity, error: entErr } = await supabase
      .from("entities")
      .select("slug")
      .eq("id", ledger.entity_id)
      .maybeSingle();

    if (entErr) return json({ ok: false, error: entErr.message }, 500);
    if (!entity)
      return json({ ok: false, error: "Entity not found" }, 400);

    /* ========= 3) Locate Signed PDF ========= */
    let signedBucket: string | null = envRow?.storage_bucket ?? null;
    let signedPath: string | null = envRow?.storage_path ?? null;

    if (!signedPath) {
      const { data: obj, error } = await supabase
        .schema("storage")
        .from("objects")
        .select("bucket_id, name")
        .ilike("name", `%${resolvedRecordId}%.pdf%`)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) return json({ ok: false, error: error.message }, 500);
      if (!obj)
        return json(
          { ok: false, error: "Signed PDF not found in storage" },
          404,
        );

      signedBucket = obj.bucket_id;
      signedPath = obj.name;
    }

    if (!signedBucket || !signedPath) {
      return json(
        { ok: false, error: "Unable to resolve signed PDF pointers" },
        500,
      );
    }

    /* ========= 4) Download PDF ========= */
    const { data: blob, error: dlErr } = await supabase.storage
      .from(signedBucket)
      .download(signedPath);

    if (dlErr || !blob) {
      return json(
        { ok: false, error: "Failed to download signed PDF" },
        500,
      );
    }

    const pdfBytes = new Uint8Array(await blob.arrayBuffer());
    const pdfBase64 = encodeBase64(pdfBytes);

    /* ========= 5) Archive (Idempotent / Repair) ========= */
    const { data: archiveRes, error: archiveErr } =
      await supabase.functions.invoke("archive-save-document", {
        body: {
          source_record_id: resolvedRecordId,
          pdf_base64: pdfBase64,
          title: ledger.title ?? "Signed Resolution",
          entity_id: ledger.entity_id,
          entity_key: entity.slug,
          is_test: Boolean(ledger.is_test),
          domain_key: "governance",
          section_name: "Governance",
          entry_type: "resolution",
          bucket: MINUTE_BOOK_BUCKET,
        },
      });

    if (archiveErr) {
      return json(
        {
          ok: false,
          error: "archive-save-document failed",
          details: archiveErr.message,
        },
        500,
      );
    }

    /* ========= 6) Seal (Non-blocking) ========= */
    let seal: any = null;
    try {
      const { data } = await supabase.rpc(SEAL_RPC, {
        record_id: resolvedRecordId,
      });
      seal = data ?? null;
    } catch {
      seal = null;
    }

    /* ========= 7) Best-effort Envelope Backfill ========= */
    if (envelope_id) {
      await bestEffortUpdateSignatureEnvelope(envelope_id, {
        minute_book_entry_id: archiveRes?.entry_id ?? null,
        minute_book_storage_path: archiveRes?.storage?.path ?? null,
        minute_book_pdf_hash: archiveRes?.storage?.file_hash ?? null,
        verified_document_id: seal?.verified_document_id ?? null,
        verified_storage_path: seal?.verified_storage_path ?? null,
        verified_hash: seal?.verified_hash ?? null,
      });
    }

    return json({
      ok: true,
      record_id: resolvedRecordId,
      lane: ledger.is_test ? "SANDBOX" : "ROT",
      entity: entity.slug,
      signed_pdf: { bucket: signedBucket, path: signedPath },
      minute_book: archiveRes,
      seal,
    });
  } catch (e: any) {
    return json({ ok: false, error: e?.message ?? "Unhandled error" }, 500);
  }
});
