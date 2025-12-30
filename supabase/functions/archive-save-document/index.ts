import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  record_id: string; // governance_ledger.id
  envelope_id: string; // signature_envelopes.id
  is_test?: boolean; // lane flag
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  // IMPORTANT: supabase-js sends x-client-info; must be allowed or browser blocks
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

    // 0) Ensure envelope exists + completed (defensive)
    const env = await supabase
      .from("signature_envelopes")
      .select("id, record_id, status")
      .eq("id", envelope_id)
      .maybeSingle();

    if (env.error || !env.data) {
      return json(
        { ok: false, error: "signature_envelopes row not found", details: env.error ?? null },
        404
      );
    }

    const envRecordId = (env.data as any).record_id as string;
    const envStatus = ((env.data as any).status as string | null) ?? null;

    if (envRecordId !== record_id) {
      return json(
        {
          ok: false,
          error: "Envelope record_id mismatch",
          envelope_record_id: envRecordId,
          request_record_id: record_id,
        },
        400
      );
    }

    if (envStatus !== "completed") {
      return json(
        { ok: false, error: "Envelope is not completed yet.", envelope_status: envStatus },
        400
      );
    }

    // 1) Load ledger basics (keep selects conservative)
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

    if (!entity_id) {
      return json(
        { ok: false, error: "Ledger missing entity_id (required for minute_book_entries)" },
        500
      );
    }

    // 2) Resolve entity_key enum label (best-effort)
    // Expect public.organization_entities exists in your schema.
    let entity_key: string | null = null;
    let entity_slug: string | null = null;

    const ent = await supabase
      .from("organization_entities")
      .select("id, slug, entity_key")
      .eq("id", entity_id)
      .maybeSingle();

    if (!ent.error && ent.data) {
      entity_slug = (ent.data as any).slug ?? null;
      entity_key = (ent.data as any).entity_key ?? entity_slug ?? null;
    }

    if (!entity_key) {
      return json(
        {
          ok: false,
          error:
            "Unable to resolve entity_key for minute_book_entries (organization_entities lookup failed).",
          details: ent.error ?? null,
        },
        500
      );
    }

    // 3) Find/create minute_book_entries row (lane-safe, idempotent)
    const existing = await supabase
      .from("minute_book_entries")
      .select("id, title, is_test")
      .eq("source_record_id", record_id)
      .eq("is_test", is_test)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let minute_book_entry_id: string | null = (existing.data as any)?.id ?? null;
    const already_archived = !!minute_book_entry_id;

    if (!minute_book_entry_id) {
      // FK requires domain_key exist in governance_domains(key)
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
          {
            ok: false,
            error:
              "No active governance_domains found. Seed governance_domains (key/label/active) before archiving, or FK will fail.",
          },
          500
        );
      }

      const section = await supabase
        .from("governance_domain_sections")
        .select("default_section")
        .eq("domain_key", domain_key)
        .limit(1)
        .maybeSingle();

      const section_name = (section.data as any)?.default_section ?? "General";

      const ins = await supabase
        .from("minute_book_entries")
        .insert({
          entity_id,
          entity_key, // enum label must match your entity_key_enum
          domain_key,
          section_name,
          title,
          source_record_id: record_id,
          is_test,
          entry_type: "resolution",
        })
        .select("id")
        .single();

      if (ins.error || !ins.data) {
        return json(
          {
            ok: false,
            error: "Failed to create minute_book_entries row",
            details: ins.error ?? null,
          },
          500
        );
      }

      minute_book_entry_id = (ins.data as any).id as string;
    }

    // 4) Seal/render archive PDF (idempotent) — supports multiple param name variants
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
      // Don’t hide this — this is the core of “No storage path on primary document”
      return json(
        { ok: false, error: "seal_governance_record_for_archive failed", details: seal.error ?? null },
        500
      );
    }

    const sealed = seal.data ?? {};
    const storage_bucket = sealed.storage_bucket ?? sealed.bucket ?? null;
    const storage_path = sealed.storage_path ?? sealed.path ?? null;
    const file_hash = sealed.file_hash ?? sealed.hash ?? null;

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

    // 5) Register primary PDF pointer as supporting_documents (idempotent-ish)
    // If your table has a uniqueness rule, this will behave as upsert by “insert and ignore duplicates” at DB layer.
    // If not, it still won’t break anything; worst case duplicates, but your UI can pick latest.
    const file_name = storage_path.split("/").pop() ?? "resolution.pdf";

    const sd = await supabase.from("supporting_documents").insert({
      entry_id: minute_book_entry_id,
      doc_type: "resolution_pdf",
      file_path: storage_path,
      file_name,
      file_hash,
      mime_type: "application/pdf",
      file_size: null,
      signature_envelope_id: envelope_id,
      verified: true,
      registry_visible: true,
    });

    // don’t hard-fail if your schema has uniqueness preventing duplicates
    if (sd.error) {
      // log but continue — the seal + verified registry are the critical pieces
      console.warn("supporting_documents insert error:", sd.error);
    }

    // 6) Ensure verified_documents row exists (uses source_record_id — NOT source_entry_id)
    const vdExisting = await supabase
      .from("verified_documents")
      .select("id, storage_bucket, storage_path, file_hash, verification_level, created_at")
      .eq("source_record_id", record_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!vdExisting.data) {
      const vdIns = await supabase.from("verified_documents").insert({
        source_record_id: record_id,
        entity_id,
        is_test,
        storage_bucket,
        storage_path,
        file_hash,
        verification_level: "SEALED",
      });

      if (vdIns.error) {
        return json(
          { ok: false, error: "Failed to create verified_documents row", details: vdIns.error ?? null },
          500
        );
      }
    }

    const vdFinal = await supabase
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
      already_archived,
      sealed: { storage_bucket, storage_path, file_hash, raw: sealed },
      verified_document: vdFinal.data ?? null,
    });
  } catch (e: any) {
    return json({ ok: false, error: e?.message ?? "Unhandled error" }, 500);
  }
});
