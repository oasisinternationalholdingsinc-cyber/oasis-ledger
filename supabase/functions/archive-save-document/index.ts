import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  record_id: string;      // governance_ledger.id
  envelope_id: string;    // signature_envelopes.id
  is_test?: boolean;      // lane flag (RoT=false, SANDBOX=true)
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

function asBool(v: unknown, fallback = false) {
  if (typeof v === "boolean") return v;
  return fallback;
}

async function getActorUid(req: Request): Promise<string | null> {
  // Prefer the caller's JWT (Forge UI) so supporting_documents NOT NULL columns can be satisfied.
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const jwt = m?.[1]?.trim();
  if (!jwt) return null;

  // service_role can validate any JWT
  const { data, error } = await supabase.auth.getUser(jwt);
  if (error || !data?.user?.id) return null;
  return data.user.id;
}

async function tryRpc(fn: string, args: any) {
  return await supabase.rpc(fn as any, args as any);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const body = (await req.json()) as ReqBody;

    const record_id = (body?.record_id ?? "").trim();
    const envelope_id = (body?.envelope_id ?? "").trim();
    const is_test = asBool(body?.is_test, false);

    if (!record_id) return json({ ok: false, error: "record_id is required" }, 400);
    if (!envelope_id) return json({ ok: false, error: "envelope_id is required" }, 400);

    // 0) Identify actor uid (needed for supporting_documents NOT NULL fields)
    const actor_uid = await getActorUid(req);

    // 1) Ensure envelope exists + completed + matches record_id
    const env = await supabase
      .from("signature_envelopes")
      .select("id, record_id, status, entity_id, is_test")
      .eq("id", envelope_id)
      .maybeSingle();

    if (env.error || !env.data) {
      return json({ ok: false, error: "signature_envelopes row not found", details: env.error ?? null }, 404);
    }

    const envRecordId = (env.data as any).record_id as string;
    const envStatus = ((env.data as any).status as string | null) ?? null;

    if (envRecordId !== record_id) {
      return json(
        { ok: false, error: "Envelope record_id mismatch", envelope_record_id: envRecordId, request_record_id: record_id },
        400
      );
    }

    if (envStatus !== "completed") {
      return json({ ok: false, error: "Envelope is not completed yet.", envelope_status: envStatus }, 400);
    }

    // 2) Load ledger basics (keep conservative)
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
    const ledger_created_by = (gl.data as any).created_by as string | null;

    if (!entity_id) {
      return json({ ok: false, error: "Ledger missing entity_id (required for minute_book_entries)" }, 500);
    }

    // Choose an actor uid for inserts:
    //  - Prefer caller JWT
    //  - Else fallback to ledger.created_by
    const effective_actor = actor_uid ?? ledger_created_by;
    if (!effective_actor) {
      return json(
        {
          ok: false,
          error:
            "Cannot determine actor uid for supporting_documents (need Authorization Bearer JWT from app OR governance_ledger.created_by not null).",
        },
        500
      );
    }

    // 3) Resolve entity_key (use entity_companies, not organization_entities)
    const ec = await supabase
      .from("entity_companies")
      .select("key")
      .eq("entity_id", entity_id)
      .limit(1)
      .maybeSingle();

    const entity_key = (ec.data as any)?.key ?? null;
    if (!entity_key) {
      return json(
        {
          ok: false,
          error: "Unable to resolve entity_key for minute_book_entries (entity_companies lookup failed).",
          details: ec.error ?? null,
        },
        500
      );
    }

    // 4) Find/create minute_book_entries (lane-safe, idempotent)
    const existingEntry = await supabase
      .from("minute_book_entries")
      .select("id, title, is_test")
      .eq("source_record_id", record_id)
      .eq("is_test", is_test)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let minute_book_entry_id: string | null = (existingEntry.data as any)?.id ?? null;
    const already_had_entry = !!minute_book_entry_id;

    // Determine domain + default section (default_section is USER-DEFINED, good for supporting_documents.section)
    const gd = await supabase
      .from("governance_domains")
      .select("key")
      .eq("active", true)
      .order("sort_order", { ascending: true })
      .limit(1)
      .maybeSingle();

    const domain_key = (gd.data as any)?.key ?? null;
    if (!domain_key) {
      return json(
        { ok: false, error: "No active governance_domains found. Seed governance_domains before archiving." },
        500
      );
    }

    const sec = await supabase
      .from("governance_domain_sections")
      .select("default_section")
      .eq("domain_key", domain_key)
      .limit(1)
      .maybeSingle();

    // default_section is an enum label; perfect for supporting_documents.section
    const default_section = (sec.data as any)?.default_section ?? null;
    if (!default_section) {
      return json(
        {
          ok: false,
          error:
            "No governance_domain_sections.default_section for this domain_key. Seed governance_domain_sections so we can write supporting_documents.section safely.",
          domain_key,
        },
        500
      );
    }

    if (!minute_book_entry_id) {
      const ins = await supabase
        .from("minute_book_entries")
        .insert({
          entity_id,
          entity_key,                 // entity_key_enum label
          domain_key,
          section_name: String(default_section), // UI-friendly text
          title,
          source: "signed_resolution",
          source_record_id: record_id,
          source_envelope_id: envelope_id,
          is_test,
          entry_type: "resolution",
          created_by: effective_actor,
        })
        .select("id")
        .single();

      if (ins.error || !ins.data) {
        return json({ ok: false, error: "Failed to create minute_book_entries row", details: ins.error ?? null }, 500);
      }

      minute_book_entry_id = (ins.data as any).id as string;
    }

    // 5) Seal/render archive PDF (idempotent) — supports multiple param name variants
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
      return json(
        { ok: false, error: "seal_governance_record_for_archive failed", details: seal.error ?? null },
        500
      );
    }

    const sealed = seal.data ?? {};
    const storage_bucket = sealed.storage_bucket ?? sealed.bucket ?? null;
    const storage_path = sealed.storage_path ?? sealed.path ?? null;
    const file_hash = sealed.file_hash ?? sealed.hash ?? null;
    const file_size = sealed.file_size ?? null;

    if (!storage_bucket || !storage_path || !file_hash) {
      return json(
        {
          ok: false,
          error: "Seal did not return storage_bucket/storage_path/file_hash (cannot register primary pointers).",
          details: sealed,
        },
        500
      );
    }

    const file_name = storage_path.split("/").pop() ?? "resolution.pdf";

    // 6) Ensure supporting_documents has the PRIMARY PDF pointer (idempotent repair)
    // We look for an existing pointer to the same file_path for this entry. If missing, insert it.
    const sdExisting = await supabase
      .from("supporting_documents")
      .select("id, file_path, created_at")
      .eq("entry_id", minute_book_entry_id!)
      .eq("file_path", storage_path)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!sdExisting.data) {
      const sdIns = await supabase.from("supporting_documents").insert({
        entry_id: minute_book_entry_id,
        entity_key,
        section: default_section,          // enum label
        file_path: storage_path,
        file_name,
        doc_type: "resolution_pdf",
        mime_type: "application/pdf",
        file_hash,
        file_size,
        signature_envelope_id: envelope_id,
        verified: true,
        registry_visible: true,
        uploaded_by: effective_actor,      // NOT NULL
        owner_id: effective_actor,         // NOT NULL
      });

      if (sdIns.error) {
        return json(
          { ok: false, error: "Failed to create supporting_documents primary pointer", details: sdIns.error ?? null },
          500
        );
      }
    }

    // 7) Patch minute_book_entries primary pointers (storage_path + pdf_hash) if missing
    const mbePatch = await supabase
      .from("minute_book_entries")
      .update({
        storage_path,
        pdf_hash: file_hash,
        file_name,
        updated_at: new Date().toISOString(),
      })
      .eq("id", minute_book_entry_id)
      .select("id, storage_path, pdf_hash")
      .maybeSingle();

    if (mbePatch.error) {
      // Not fatal, but should be visible
      console.warn("minute_book_entries patch error:", mbePatch.error);
    }

    // 8) Verified registry is created by the seal pipeline in your system.
    // We only read it here (and we use source_record_id, NOT source_entry_id).
    const vd = await supabase
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
      is_test,
      minute_book_entry_id,
      already_had_entry,
      sealed: { storage_bucket, storage_path, file_hash, file_size, raw: sealed },
      verified_document: vd.data ?? null,
    });
  } catch (e: any) {
    return json({ ok: false, error: e?.message ?? "Unhandled error" }, 500);
  }
});
