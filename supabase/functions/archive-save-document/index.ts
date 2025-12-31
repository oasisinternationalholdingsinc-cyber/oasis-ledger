import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { makeServiceClient, sealLedgerForArchive } from "../_shared/archive.ts";

type ReqBody = { record_id: string };

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

  try {
    const body = (await req.json()) as ReqBody;
    const record_id = body?.record_id;

    if (!record_id) return json({ ok: false, error: "Missing record_id" }, 400);

    const supabase = makeServiceClient();

    // 1) Seal + get canonical storage pointers (idempotent)
    const seal = await sealLedgerForArchive(supabase, record_id);

    // 2) Load ledger row (we need entity + title + lane + created_by)
    const { data: gl, error: glErr } = await supabase
      .from("governance_ledger")
      .select("id, entity_id, entity_key, title, is_test, created_by")
      .eq("id", record_id)
      .single();

    if (glErr) throw new Error(`Load governance_ledger failed: ${glErr.message}`);

    // 3) Upsert minute_book_entries (idempotent repair)
    // NOTE: your schema requires entity_id, entity_key(enum), domain_key(text), etc.
    // Pick a deterministic domain for governance archive artifacts:
    const domain_key = "governance-ledger";

    const { data: mbe, error: mbeErr } = await supabase
      .from("minute_book_entries")
      .upsert(
        {
          entity_id: gl.entity_id,
          entity_key: gl.entity_key, // already enum in your table
          domain_key,
          section_name: "Archive",
          title: gl.title ?? "Governance Archive Artifact",
          entry_type: "resolution",
          source_record_id: gl.id,
          // if you added is_test to minute_book_entries, include it:
          is_test: gl.is_test ?? false,
        } as any,
        { onConflict: "source_record_id" },
      )
      .select("id, entity_id, entity_key, source_record_id")
      .single();

    if (mbeErr) throw new Error(`minute_book_entries upsert failed: ${mbeErr.message}`);

    // 4) Ensure primary supporting_documents pointer exists (Reader depends on this)
    // We upsert a primary PDF record that points at the sealed artifact.
    const { error: sdErr } = await supabase
      .from("supporting_documents")
      .upsert(
        {
          entity_id: gl.entity_id,
          entity_key: gl.entity_key,
          entry_id: mbe.id,
          title: "Primary PDF",
          is_primary: true,
          storage_bucket: seal.storage_bucket,
          storage_path: seal.storage_path,
          file_hash: seal.file_hash,
          mime_type: seal.mime_type ?? "application/pdf",
          created_by: gl.created_by ?? null,
        } as any,
        { onConflict: "entry_id,is_primary" },
      );

    if (sdErr) throw new Error(`supporting_documents upsert failed: ${sdErr.message}`);

    return json({
      ok: true,
      seal,
      minute_book_entry_id: mbe.id,
      storage_bucket: seal.storage_bucket,
      storage_path: seal.storage_path,
      file_hash: seal.file_hash,
    });
  } catch (e) {
    return json(
      { ok: false, error: "archive-save-document failed", details: { message: String(e) } },
      500,
    );
  }
});
