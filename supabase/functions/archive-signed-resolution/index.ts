import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

const MINUTE_BOOK_BUCKET = "minute_book";
const SEAL_RPC = "seal_governance_record_for_archive";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};

const json = (x: unknown, s = 200) =>
  new Response(JSON.stringify(x, null, 2), {
    status: s,
    headers: { ...cors, "Content-Type": "application/json" },
  });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false }, 405);

  const { envelope_id, record_id } = await req.json();

  if (!envelope_id && !record_id) {
    return json({ ok: false, error: "envelope_id or record_id required" }, 400);
  }

  /* -------------------------------------------------------
     1. Load envelope (preferred truth source)
  ------------------------------------------------------- */
  let resolvedRecordId = record_id;

  if (envelope_id) {
    const { data: env } = await supabase
      .from("signature_envelopes")
      .select("record_id, status")
      .eq("id", envelope_id)
      .maybeSingle();

    if (!env) return json({ ok: false, error: "Envelope not found" }, 404);
    if (env.status !== "completed") {
      return json({ ok: false, error: "Envelope not completed" }, 400);
    }

    resolvedRecordId ||= env.record_id;
  }

  /* -------------------------------------------------------
     2. Load governance ledger (lane + entity)
  ------------------------------------------------------- */
  const { data: ledger } = await supabase
    .from("governance_ledger")
    .select("id, title, entity_id, is_test")
    .eq("id", resolvedRecordId)
    .maybeSingle();

  if (!ledger) {
    return json({ ok: false, error: "Ledger record not found" }, 404);
  }

  const { data: entity } = await supabase
    .from("entities")
    .select("slug")
    .eq("id", ledger.entity_id)
    .maybeSingle();

  if (!entity) {
    return json({ ok: false, error: "Entity not found" }, 400);
  }

  /* -------------------------------------------------------
     3. Find signed PDF in storage (NO assumptions)
  ------------------------------------------------------- */
  const { data: signedObj } = await supabase
    .schema("storage")
    .from("objects")
    .select("bucket_id, name")
    .ilike("name", `%${resolvedRecordId}%-signed.pdf`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!signedObj) {
    return json({
      ok: false,
      error: "Signed PDF not found in storage",
    }, 404);
  }

  const { data: blob } = await supabase.storage
    .from(signedObj.bucket_id)
    .download(signedObj.name);

  if (!blob) {
    return json({ ok: false, error: "Failed to download signed PDF" }, 500);
  }

  const pdfBytes = new Uint8Array(await blob.arrayBuffer());
  const pdfBase64 = btoa(
    String.fromCharCode(...pdfBytes)
  );

  /* -------------------------------------------------------
     4. Register PRIMARY Minute Book document
  ------------------------------------------------------- */
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
        bucket: MINUTE_BOOK_BUCKET,
      },
    });

  if (archiveErr) {
    return json({
      ok: false,
      error: "archive-save-document failed",
      details: archiveErr.message,
    }, 500);
  }

  /* -------------------------------------------------------
     5. Seal (non-blocking)
  ------------------------------------------------------- */
  let seal = null;
  const { data: sealData } = await supabase.rpc(SEAL_RPC, {
    record_id: resolvedRecordId,
  });

  seal = sealData ?? null;

  return json({
    ok: true,
    record_id: resolvedRecordId,
    signed_pdf: {
      bucket: signedObj.bucket_id,
      path: signedObj.name,
    },
    minute_book: archiveRes,
    seal,
  });
});
