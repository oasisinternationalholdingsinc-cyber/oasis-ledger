import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  record_id: string;     // governance_ledger.id
  envelope_id: string;   // signature_envelopes.id
  is_test?: boolean;     // lane flag
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
  Deno.env.get("SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

function asBool(v: unknown, fallback = false) {
  return typeof v === "boolean" ? v : fallback;
}

async function tryRpc(fn: string, args: any) {
  return supabase.rpc(fn as any, args as any);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const body = (await req.json()) as ReqBody;

    const record_id = body?.record_id?.trim();
    const envelope_id = body?.envelope_id?.trim();
    const is_test = asBool(body?.is_test, false);

    if (!record_id) return json({ ok: false, error: "record_id is required" }, 400);
    if (!envelope_id) return json({ ok: false, error: "envelope_id is required" }, 400);

    /* ------------------------------------------------------------
       0) Load envelope (MUST be completed)
    ------------------------------------------------------------ */
    const env = await supabase
      .from("signature_envelopes")
      .select("id, record_id, status, created_by")
      .eq("id", envelope_id)
      .maybeSingle();

    if (!env.data || env.error) {
      return json({ ok: false, error: "signature_envelopes not found", details: env.error }, 404);
    }

    if (env.data.record_id !== record_id) {
      return json({ ok: false, error: "Envelope record mismatch" }, 400);
    }

    if (env.data.status !== "completed") {
      return json({ ok: false, error: "Envelope not completed" }, 400);
    }

    /* ------------------------------------------------------------
       1) Load ledger (NO mutation)
    ------------------------------------------------------------ */
    const gl = await supabase
      .from("governance_ledger")
      .select("id, title, entity_id, created_by, is_test")
      .eq("id", record_id)
      .maybeSingle();

    if (!gl.data || gl.error) {
      return json({ ok: false, error: "governance_ledger not found", details: gl.error }, 404);
    }

    const entity_id = gl.data.entity_id;
    const title = gl.data.title ?? "Untitled Resolution";

    if (!entity_id) {
      return json({ ok: false, error: "Ledger missing entity_id" }, 500);
    }

    /* ------------------------------------------------------------
       2) Resolve ACTOR (CRITICAL FIX)
    ------------------------------------------------------------ */
    const actor_uid = env.data.created_by ?? gl.data.created_by;

    if (!actor_uid) {
      return json(
        {
          ok: false,
          error: "Missing actor_uid (envelope.created_by and ledger.created_by are NULL)",
        },
        400
      );
    }

    /* ------------------------------------------------------------
       3) Resolve entity_key
    ------------------------------------------------------------ */
    const ent = await supabase
      .from("organization_entities")
      .select("id, slug, entity_key")
      .eq("id", entity_id)
      .maybeSingle();

    const entity_key = ent.data?.entity_key ?? ent.data?.slug;
    if (!entity_key) {
      return json({ ok: false, error: "Unable to resolve entity_key" }, 500);
    }

    /* ------------------------------------------------------------
       4) Find / create minute_book_entries (idempotent)
    ------------------------------------------------------------ */
    const existing = await supabase
      .from("minute_book_entries")
      .select("id")
      .eq("source_record_id", record_id)
      .eq("is_test", is_test)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let minute_book_entry_id = existing.data?.id ?? null;
    const already_archived = !!minute_book_entry_id;

    if (!minute_book_entry_id) {
      const gd = await supabase
        .from("governance_domains")
        .select("key")
        .eq("active", true)
        .order("sort_order", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (!gd.data?.key) {
        return json({ ok: false, error: "No active governance_domains" }, 500);
      }

      const ins = await supabase
        .from("minute_book_entries")
        .insert({
          entity_id,
          entity_key,
          domain_key: gd.data.key,
          section_name: "General",
          title,
          source_record_id: record_id,
          is_test,
          entry_type: "resolution",
        })
        .select("id")
        .single();

      if (ins.error) {
        return json({ ok: false, error: "Failed to create minute_book_entry", details: ins.error }, 500);
      }

      minute_book_entry_id = ins.data.id;
    }

    /* ------------------------------------------------------------
       5) Seal archive PDF (RPC)
    ------------------------------------------------------------ */
    let seal = await tryRpc("seal_governance_record_for_archive", {
      record_id,
      envelope_id,
      is_test,
    });

    if (seal.error) {
      seal = await tryRpc("seal_governance_record_for_archive", {
        p_record_id: record_id,
        p_envelope_id: envelope_id,
        p_is_test: is_test,
      });
    }

    if (seal.error) {
      return json({ ok: false, error: "seal_governance_record_for_archive failed", details: seal.error }, 500);
    }

    const sealed = seal.data ?? {};
    const storage_bucket = sealed.storage_bucket;
    const storage_path = sealed.storage_path;
    const file_hash = sealed.file_hash;

    if (!storage_bucket || !storage_path || !file_hash) {
      return json({ ok: false, error: "Seal missing storage pointers", details: sealed }, 500);
    }

    /* ------------------------------------------------------------
       6) supporting_documents (EXPLICIT ACTOR)
    ------------------------------------------------------------ */
    const file_name = storage_path.split("/").pop() ?? "resolution.pdf";

    const sd = await supabase.from("supporting_documents").insert({
      entry_id: minute_book_entry_id,
      doc_type: "resolution_pdf",
      file_path: storage_path,
      file_name,
      file_hash,
      mime_type: "application/pdf",
      signature_envelope_id: envelope_id,
      verified: true,
      registry_visible: true,
      uploaded_by: actor_uid,
      owner_id: actor_uid,
    });

    if (sd.error) {
      console.warn("supporting_documents insert warning:", sd.error);
    }

    /* ------------------------------------------------------------
       7) verified_documents (source_record_id)
    ------------------------------------------------------------ */
    const vd = await supabase
      .from("verified_documents")
      .select("id")
      .eq("source_record_id", record_id)
      .limit(1)
      .maybeSingle();

    if (!vd.data) {
      const ins = await supabase.from("verified_documents").insert({
        source_record_id: record_id,
        entity_id,
        is_test,
        storage_bucket,
        storage_path,
        file_hash,
        verification_level: "SEALED",
      });

      if (ins.error) {
        return json({ ok: false, error: "Failed to create verified_documents", details: ins.error }, 500);
      }
    }

    return json({
      ok: true,
      record_id,
      envelope_id,
      is_test,
      minute_book_entry_id,
      already_archived,
      sealed: { storage_bucket, storage_path, file_hash },
    });
  } catch (e: any) {
    return json({ ok: false, error: e?.message ?? "Unhandled error" }, 500);
  }
});
