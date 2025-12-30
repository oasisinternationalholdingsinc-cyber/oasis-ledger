import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * Archive a signed governance record into:
 *  - minute_book_entries
 *  - supporting_documents (PRIMARY pointer)
 *  - verified_documents (created by seal RPC)
 *
 * IMPORTANT TRUTHS:
 *  - Lane (is_test) comes ONLY from governance_ledger
 *  - seal_governance_record_for_archive accepts ONLY (p_ledger_id uuid)
 *  - storage_bucket is NOT required (storage_path is canonical)
 */

type ReqBody = {
  record_id: string;   // governance_ledger.id
  envelope_id: string; // signature_envelopes.id (for supporting_documents linkage)
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

/**
 * Try to extract the acting user (Forge UI JWT)
 * Needed because supporting_documents.uploaded_by / owner_id are NOT NULL
 */
async function getActorUid(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const jwt = m?.[1]?.trim();
  if (!jwt) return null;

  const { data, error } = await supabase.auth.getUser(jwt);
  if (error || !data?.user?.id) return null;
  return data.user.id;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const body = (await req.json()) as ReqBody;
    const record_id = body?.record_id?.trim();
    const envelope_id = body?.envelope_id?.trim();

    if (!record_id) return json({ ok: false, error: "record_id is required" }, 400);
    if (!envelope_id) return json({ ok: false, error: "envelope_id is required" }, 400);

    // ─────────────────────────────────────────────
    // 1) Load ledger (AUTHORITATIVE SOURCE)
    // ─────────────────────────────────────────────
    const gl = await supabase
      .from("governance_ledger")
      .select("id, title, entity_id, created_by, is_test")
      .eq("id", record_id)
      .maybeSingle();

    if (gl.error || !gl.data) {
      return json({ ok: false, error: "governance_ledger not found" }, 404);
    }

    const entity_id = gl.data.entity_id;
    const title = gl.data.title ?? "Untitled Resolution";
    const is_test = Boolean(gl.data.is_test); // 🔒 CANONICAL LANE
    const ledger_created_by = gl.data.created_by ?? null;

    if (!entity_id) {
      return json({ ok: false, error: "Ledger missing entity_id" }, 500);
    }

    // ─────────────────────────────────────────────
    // 2) Resolve actor uid (Forge JWT preferred)
    // ─────────────────────────────────────────────
    const actor_uid = (await getActorUid(req)) ?? ledger_created_by;
    if (!actor_uid) {
      return json(
        {
          ok: false,
          error:
            "Cannot determine actor uid (need Authorization Bearer JWT OR governance_ledger.created_by)",
        },
        500
      );
    }

    // ─────────────────────────────────────────────
    // 3) Resolve entity_key (enum)
    // ─────────────────────────────────────────────
    const ec = await supabase
      .from("entity_companies")
      .select("key")
      .eq("entity_id", entity_id)
      .limit(1)
      .maybeSingle();

    const entity_key = ec.data?.key ?? null;
    if (!entity_key) {
      return json({ ok: false, error: "entity_key resolution failed" }, 500);
    }

    // ─────────────────────────────────────────────
    // 4) Find or create minute_book_entry (IDEMPOTENT)
    // ─────────────────────────────────────────────
    const existingEntry = await supabase
      .from("minute_book_entries")
      .select("id")
      .eq("source_record_id", record_id)
      .eq("is_test", is_test)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let minute_book_entry_id = existingEntry.data?.id ?? null;

    // Determine default governance domain + section
    const gd = await supabase
      .from("governance_domains")
      .select("key")
      .eq("active", true)
      .order("sort_order", { ascending: true })
      .limit(1)
      .maybeSingle();

    const domain_key = gd.data?.key ?? null;
    if (!domain_key) {
      return json({ ok: false, error: "No active governance_domains" }, 500);
    }

    const sec = await supabase
      .from("governance_domain_sections")
      .select("default_section")
      .eq("domain_key", domain_key)
      .limit(1)
      .maybeSingle();

    const default_section = sec.data?.default_section ?? null;
    if (!default_section) {
      return json({ ok: false, error: "No default_section for domain" }, 500);
    }

    if (!minute_book_entry_id) {
      const ins = await supabase
        .from("minute_book_entries")
        .insert({
          entity_id,
          entity_key,
          domain_key,
          section_name: String(default_section),
          title,
          source: "signed_resolution",
          source_record_id: record_id,
          source_envelope_id: envelope_id,
          entry_type: "resolution",
          is_test,
          created_by: actor_uid,
        })
        .select("id")
        .single();

      if (ins.error || !ins.data) {
        return json(
          { ok: false, error: "Failed to create minute_book_entry", details: ins.error },
          500
        );
      }

      minute_book_entry_id = ins.data.id;
    }

    // ─────────────────────────────────────────────
    // 5) SEAL ARCHIVE (CRITICAL FIX)
    // ─────────────────────────────────────────────
    const seal = await supabase.rpc("seal_governance_record_for_archive", {
      p_ledger_id: record_id,
    });

    if (seal.error) {
      return json(
        { ok: false, error: "seal_governance_record_for_archive failed", details: seal.error },
        500
      );
    }

    const sealed = seal.data ?? {};
    const storage_path = sealed.storage_path ?? sealed.path ?? null;
    const file_hash = sealed.file_hash ?? sealed.hash ?? null;

    if (!storage_path || !file_hash) {
      return json(
        {
          ok: false,
          error: "Seal did not return storage_path/file_hash",
          details: sealed,
        },
        500
      );
    }

    const file_name = storage_path.split("/").pop() ?? "resolution.pdf";

    // ─────────────────────────────────────────────
    // 6) PRIMARY supporting_documents POINTER (IDEMPOTENT)
    // ─────────────────────────────────────────────
    const sdExisting = await supabase
      .from("supporting_documents")
      .select("id")
      .eq("entry_id", minute_book_entry_id)
      .eq("file_path", storage_path)
      .limit(1)
      .maybeSingle();

    if (!sdExisting.data) {
      const sdIns = await supabase.from("supporting_documents").insert({
        entry_id: minute_book_entry_id,
        entity_key,
        section: default_section,
        file_path: storage_path,
        file_name,
        doc_type: "resolution_pdf",
        mime_type: "application/pdf",
        file_hash,
        signature_envelope_id: envelope_id,
        uploaded_by: actor_uid,
        owner_id: actor_uid,
        verified: true,
        registry_visible: true,
      });

      if (sdIns.error) {
        return json(
          {
            ok: false,
            error: "Failed to create supporting_documents primary pointer",
            details: sdIns.error,
          },
          500
        );
      }
    }

    // ─────────────────────────────────────────────
    // 7) Read verified_documents (created by seal)
    // ─────────────────────────────────────────────
    const vd = await supabase
      .from("verified_documents")
      .select("id, storage_path, file_hash, verification_level, created_at")
      .eq("source_record_id", record_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return json({
      ok: true,
      record_id,
      envelope_id,
      is_test,
      minute_book_entry_id,
      sealed: { storage_path, file_hash },
      verified_document: vd.data ?? null,
    });
  } catch (e: any) {
    return json({ ok: false, error: e?.message ?? "Unhandled error" }, 500);
  }
});
