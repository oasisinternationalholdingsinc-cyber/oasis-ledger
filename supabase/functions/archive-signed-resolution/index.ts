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

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (x: unknown, s = 200) =>
  new Response(JSON.stringify(x, null, 2), {
    status: s,
    headers: { ...cors, "Content-Type": "application/json" },
  });

serve(async (req) => {
  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST")
      return json({ ok: false, error: "POST only" }, 405);

    const { envelope_id, record_id } = (await req.json()) as ReqBody;
    if (!envelope_id && !record_id) {
      return json(
        { ok: false, error: "envelope_id or record_id required" },
        400
      );
    }

    /* ---------------------------------------------------------
     * 1) Resolve envelope → record_id (ENVELOPE IS TRUTH)
     * ------------------------------------------------------- */
    let resolvedRecordId = record_id;
    let envelopeRow: any = null;

    if (envelope_id) {
      const { data, error } = await supabase
        .from("signature_envelopes")
        .select("id, record_id, status, is_test")
        .eq("id", envelope_id)
        .maybeSingle();

      if (error) return json({ ok: false, error: error.message }, 500);
      if (!data) return json({ ok: false, error: "Envelope not found" }, 404);
      if (data.status !== "completed")
        return json({ ok: false, error: "Envelope not completed" }, 400);

      envelopeRow = data;
      resolvedRecordId ||= data.record_id;
    }

    if (!resolvedRecordId) {
      return json({ ok: false, error: "Unable to resolve record_id" }, 400);
    }

    /* ---------------------------------------------------------
     * 2) Load ledger + entity (lane is ledger truth)
     * ------------------------------------------------------- */
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

    /* ---------------------------------------------------------
     * 3) Check idempotency (Minute Book already exists?)
     * ------------------------------------------------------- */
    const { data: existingMB } = await supabase
      .from("minute_book_entries")
      .select("id, storage_path, pdf_hash")
      .eq("source_record_id", resolvedRecordId)
      .maybeSingle();

    if (existingMB) {
      return json({
        ok: true,
        already_archived: true,
        minute_book: existingMB,
      });
    }

    /* ---------------------------------------------------------
     * 4) Locate signed PDF (authoritative storage scan)
     * ------------------------------------------------------- */
    const { data: signedObj, error: objErr } = await supabase
      .schema("storage")
      .from("objects")
      .select("bucket_id, name, created_at")
      .ilike("name", `%${resolvedRecordId}%`)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (objErr) return json({ ok: false, error: objErr.message }, 500);
    if (!signedObj)
      return json({ ok: false, error: "Signed PDF not found" }, 404);

    const { data: blob, error: dlErr } = await supabase.storage
      .from(signedObj.bucket_id)
      .download(signedObj.name);

    if (dlErr || !blob) {
      return json(
        { ok: false, error: "Failed to download signed PDF" },
        500
      );
    }

    const pdfBytes = new Uint8Array(await blob.arrayBuffer());
    const pdfBase64 = encodeBase64(pdfBytes);

    /* ---------------------------------------------------------
     * 5) Archive → Minute Book (single source of truth)
     * ------------------------------------------------------- */
    const { data: archiveRes, error: archiveErr } =
      await supabase.functions.invoke("archive-save-document", {
        body: {
          source_record_id: resolvedRecordId,
          pdf_base64: pdfBase64,
          title: ledger.title ?? "Signed Resolution",
          entity_id: ledger.entity_id,
          entity_key: entity.slug,
          is_test: ledger.is_test,
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
        500
      );
    }

    /* ---------------------------------------------------------
     * 6) Seal (non-blocking, deterministic)
     * ------------------------------------------------------- */
    let seal: any = null;
    try {
      const { data } = await supabase.rpc(SEAL_RPC, {
        record_id: resolvedRecordId,
      });
      seal = data ?? null;
    } catch {
      seal = null;
    }

    return json({
      ok: true,
      record_id: resolvedRecordId,
      entity: { slug: entity.slug, is_test: ledger.is_test },
      signed_pdf: {
        bucket: signedObj.bucket_id,
        path: signedObj.name,
      },
      minute_book: archiveRes,
      seal,
    });
  } catch (e: any) {
    return json({ ok: false, error: e?.message ?? "Unhandled error" }, 500);
  }
});
