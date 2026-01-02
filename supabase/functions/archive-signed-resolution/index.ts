import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  envelope_id: string;   // signature_envelopes.id
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const SEAL_RPC = "seal_governance_record_for_archive";
const MINUTE_BOOK_BUCKET = "minute_book";
const SUPPORTING_SECTION = "governance";

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

function basename(p: string) {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { fetch },
      auth: { persistSession: false },
    });

    const body = (await req.json()) as ReqBody;
    const envelope_id = body?.envelope_id;
    if (!envelope_id) return json({ ok: false, error: "Missing envelope_id" }, 400);

    // 1) Load envelope
    const { data: env, error: envErr } = await supabase
      .from("signature_envelopes")
      .select("id, record_id, entity_id, status, is_test, completed_at, title")
      .eq("id", envelope_id)
      .single();

    if (envErr) return json({ ok: false, error: "signature_envelopes fetch failed", details: envErr }, 500);
    if (env.status !== "completed") return json({ ok: false, error: "Envelope not completed", details: { status: env.status } }, 400);

    const record_id = env.record_id;

    // 2) Load ledger + enforce lane match
    const { data: gl, error: glErr } = await supabase
      .from("governance_ledger")
      .select("id, title, entity_id, is_test")
      .eq("id", record_id)
      .single();

    if (glErr) return json({ ok: false, error: "governance_ledger fetch failed", details: glErr }, 500);

    if (gl.is_test !== env.is_test) {
      return json({
        ok: false,
        error: "LANE_MISMATCH",
        details: { ledger_is_test: gl.is_test, envelope_is_test: env.is_test },
      }, 400);
    }

    // 3) Seal (idempotent)
    const { data: seal, error: sealErr } = await supabase.rpc(SEAL_RPC, {
      p_ledger_id: record_id,
    });

    if (sealErr) return json({ ok: false, error: "seal rpc failed", details: sealErr }, 500);

    const storage_bucket = seal?.storage_bucket ?? MINUTE_BOOK_BUCKET;
    const storage_path = seal?.storage_path;
    const file_hash = seal?.file_hash ?? seal?.pdf_hash ?? null;

    if (!storage_path) return json({ ok: false, error: "Seal returned no storage_path", seal }, 500);
    const file_name = basename(storage_path);

    // 4) Entity slug for entity_key_enum + verified registry
    const { data: ent, error: entErr } = await supabase
      .from("entities")
      .select("id, slug")
      .eq("id", gl.entity_id)
      .single();

    if (entErr) return json({ ok: false, error: "entities fetch failed", details: entErr }, 500);
    const entity_slug = ent?.slug;
    if (!entity_slug) return json({ ok: false, error: "Entity missing slug" }, 500);

    // 5) Upsert/repair minute_book_entries
    const { data: mbeExisting, error: mbeSelErr } = await supabase
      .from("minute_book_entries")
      .select("id")
      .eq("source_record_id", record_id)
      .eq("is_test", gl.is_test)
      .limit(1);

    if (mbeSelErr) return json({ ok: false, error: "minute_book_entries select failed", details: mbeSelErr }, 500);

    let entry_id: string;

    if (mbeExisting && mbeExisting.length > 0) {
      entry_id = mbeExisting[0].id;

      const { error: mbeUpdErr } = await supabase
        .from("minute_book_entries")
        .update({
          title: gl.title,
          storage_path,
          file_name,
          pdf_hash: file_hash,
          source_envelope_id: envelope_id,
          updated_at: new Date().toISOString(),
        })
        .eq("id", entry_id);

      if (mbeUpdErr) return json({ ok: false, error: "minute_book_entries update failed", details: mbeUpdErr }, 500);
    } else {
      const { data: mbeIns, error: mbeInsErr } = await supabase
        .from("minute_book_entries")
        .insert({
          entity_id: gl.entity_id,
          entity_key: entity_slug,
          entry_type: "resolution",
          title: gl.title,
          source: "signed_resolution",
          source_record_id: record_id,
          source_envelope_id: envelope_id,
          storage_path,
          file_name,
          pdf_hash: file_hash,
          domain_key: "resolutions",
          is_test: gl.is_test,
        })
        .select("id")
        .single();

      if (mbeInsErr) return json({ ok: false, error: "minute_book_entries insert failed", details: mbeInsErr }, 500);
      entry_id = mbeIns.id;
    }

    // 6) Ensure supporting_documents PRIMARY pointer
    const { data: sdExisting, error: sdSelErr } = await supabase
      .from("supporting_documents")
      .select("id")
      .eq("entry_id", entry_id)
      .eq("doc_type", "primary")
      .limit(1);

    if (sdSelErr) return json({ ok: false, error: "supporting_documents select failed", details: sdSelErr }, 500);

    if (sdExisting && sdExisting.length > 0) {
      const { error: sdUpdErr } = await supabase
        .from("supporting_documents")
        .update({
          file_path: storage_path,
          file_name,
          file_hash,
          signature_envelope_id: envelope_id,
          verified: true,
          registry_visible: true,
        })
        .eq("id", sdExisting[0].id);

      if (sdUpdErr) return json({ ok: false, error: "supporting_documents update failed", details: sdUpdErr }, 500);
    } else {
      const { error: sdInsErr } = await supabase
        .from("supporting_documents")
        .insert({
          entry_id,
          entity_key: entity_slug,
          section: SUPPORTING_SECTION as any,
          file_path: storage_path,
          file_name,
          doc_type: "primary",
          file_hash,
          signature_envelope_id: envelope_id,
          verified: true,
          registry_visible: true,
        });

      if (sdInsErr) {
        return json({
          ok: false,
          error: "supporting_documents insert failed",
          hint: "If this fails with enum error, set SUPPORTING_SECTION to a valid supporting_documents.section enum label.",
          details: sdInsErr,
        }, 500);
      }
    }

    // 7) Ensure verified_documents (don’t set generated columns)
    const { data: vdExisting, error: vdSelErr } = await supabase
      .from("verified_documents")
      .select("id")
      .eq("source_record_id", record_id)
      .limit(1);

    if (vdSelErr) return json({ ok: false, error: "verified_documents select failed", details: vdSelErr }, 500);

    if (!vdExisting || vdExisting.length === 0) {
      const { error: vdInsErr } = await supabase
        .from("verified_documents")
        .insert({
          entity_id: gl.entity_id,
          entity_slug,
          document_class: "resolution",
          title: gl.title,
          source_table: "governance_ledger",
          source_record_id: record_id,
          storage_bucket,
          storage_path,
          file_hash,
          verification_level: "certified",
          envelope_id,
          signed_at: env.completed_at,
          is_archived: true,
        });

      if (vdInsErr) return json({ ok: false, error: "verified_documents insert failed", details: vdInsErr }, 500);
    }

    return json({
      ok: true,
      envelope_id,
      record_id,
      entry_id,
      storage_bucket,
      storage_path,
      file_hash,
      message: "Archived (seal + repair pointers) from completed envelope (idempotent).",
    });
  } catch (e) {
    return json({ ok: false, error: "Unhandled", details: String(e) }, 500);
  }
});
