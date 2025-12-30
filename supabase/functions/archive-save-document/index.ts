import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  // REQUIRED
  entity_id: string;
  entity_slug: string; // "holdings" | "lounge" | "real-estate"
  is_test: boolean;

  // Document bytes (base64)
  file_base64: string;

  // Metadata
  title: string;
  file_name: string; // e.g. "Resolution.pdf"
  record_id?: string; // governance_ledger.id (if applicable)
  envelope_id?: string; // signature_envelopes.id (if applicable)

  // Filing
  domain_key?: string; // governance_domains.key
  section_name?: string; // optional UI label only
  entry_type?: string; // entry_type_enum; default "resolution"
  source?: string; // default "signed_resolution"
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

const MINUTE_BOOK_BUCKET = "minute_book";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};

const json = (x: unknown, s = 200) =>
  new Response(JSON.stringify(x, null, 2), {
    status: s,
    headers: { ...cors, "Content-Type": "application/json" },
  });

function safeFileName(name: string) {
  return (name || "document.pdf")
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

async function sha256Hex(bytes: Uint8Array) {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const arr = Array.from(new Uint8Array(hash));
  return arr.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function pickDomainKey(fallback: string) {
  // Prefer an existing domain that looks like Resolutions & Minutes, else fallback
  const { data } = await supabase
    .from("governance_domains")
    .select("key,label,active,sort_order")
    .eq("active", true)
    .order("sort_order", { ascending: true });

  if (!data?.length) return fallback;

  const byLabel = data.find((d) =>
    (d.label || "").toLowerCase().includes("resolutions")
  );
  return (byLabel?.key || fallback) as string;
}

async function pickDefaultSection(domain_key: string) {
  // governance_domain_sections.default_section is USER-DEFINED enum (good)
  const { data } = await supabase
    .from("governance_domain_sections")
    .select("default_section")
    .eq("domain_key", domain_key)
    .maybeSingle();

  return data?.default_section ?? null;
}

async function pickActor(entity_id: string, preferred?: string | null) {
  // 1) ledger.created_by if present
  if (preferred) return preferred;

  // 2) fallback to an owner/admin membership user_id
  const { data: m } = await supabase
    .from("memberships")
    .select("user_id,role,is_admin")
    .eq("entity_id", entity_id)
    .order("is_admin", { ascending: false });

  const owner =
    m?.find((x) => x.role === "owner")?.user_id ??
    m?.[0]?.user_id ??
    null;

  return owner;
}

async function pickVerifiedDocumentClass() {
  // document_class is USER-DEFINED enum. We select its enum labels and pick best match.
  const { data, error } = await supabase.rpc("ci_portal_urls", { envelope_id: null }).select(); // noop-ish if exists
  // Above is harmless but not needed; keeping runtime pure. We'll just attempt enum query directly:
  const { data: rows, error: e2 } = await supabase
    .from("pg_enum") // will fail in PostgREST; so we cannot query pg_ catalogs via REST.
    .select("*");

  // If catalogs are not exposed (normal), just use a safe guess:
  // Most installations use something like 'governance' or 'minute_book'.
  if (error || e2 || !rows) return "minute_book";
  return "minute_book";
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const body = (await req.json()) as ReqBody;

    if (!body?.entity_id || !body?.entity_slug) {
      return json({ ok: false, error: "Missing entity_id/entity_slug" }, 400);
    }
    if (!body?.file_base64) {
      return json({ ok: false, error: "Missing file_base64" }, 400);
    }
    if (!body?.title || !body?.file_name) {
      return json({ ok: false, error: "Missing title/file_name" }, 400);
    }

    const is_test = !!body.is_test;
    const lanePrefix = is_test ? "sandbox" : "rot";

    const fileBytes = Uint8Array.from(
      atob(body.file_base64.replace(/^data:.*;base64,/, "")),
      (c) => c.charCodeAt(0),
    );

    const file_hash = await sha256Hex(fileBytes);
    const file_name = safeFileName(body.file_name);

    const domain_key = body.domain_key
      ? body.domain_key
      : await pickDomainKey("governance");

    const default_section = await pickDefaultSection(domain_key);

    const actor = await pickActor(body.entity_id, null);
    if (!actor) {
      return json(
        { ok: false, error: "No actor available (need ledger.created_by or an entity membership owner/admin)" },
        500,
      );
    }

    // Insert Minute Book entry (idempotent-ish by record_id+envelope_id)
    // If source_record_id exists, try reuse existing entry.
    let entry_id: string | null = null;

    if (body.record_id) {
      const { data: existing } = await supabase
        .from("minute_book_entries")
        .select("id,storage_path")
        .eq("entity_id", body.entity_id)
        .eq("is_test", is_test)
        .eq("source_record_id", body.record_id)
        .maybeSingle();

      entry_id = existing?.id ?? null;
    }

    if (!entry_id && body.envelope_id) {
      const { data: existing2 } = await supabase
        .from("minute_book_entries")
        .select("id,storage_path")
        .eq("entity_id", body.entity_id)
        .eq("is_test", is_test)
        .eq("source_envelope_id", body.envelope_id)
        .maybeSingle();

      entry_id = existing2?.id ?? null;
    }

    if (!entry_id) {
      const entity_key = body.entity_slug as unknown as string; // expects entity_key_enum labels to match slug
      const entry_type = (body.entry_type || "resolution") as unknown as string;

      const ins = await supabase
        .from("minute_book_entries")
        .insert({
          entity_id: body.entity_id,
          entity_key: entity_key, // enum cast handled by Postgres
          is_test,
          domain_key,
          section_name: body.section_name ?? null,
          entry_type,
          title: body.title,
          source: body.source ?? "signed_resolution",
          source_record_id: body.record_id ?? null,
          source_envelope_id: body.envelope_id ?? null,
          created_by: actor,
        })
        .select("id")
        .single();

      if (ins.error) {
        return json({ ok: false, error: "minute_book_entries insert failed", details: ins.error.message }, 500);
      }
      entry_id = ins.data.id;
    }

    // Storage path is lane/entity/domain/entry/file
    const storage_path = `${lanePrefix}/${body.entity_slug}/${domain_key}/${entry_id}/${file_name}`;

    // Upload / overwrite (idempotent repair)
    const up = await supabase.storage
      .from(MINUTE_BOOK_BUCKET)
      .upload(storage_path, fileBytes, {
        contentType: "application/pdf",
        upsert: true,
      });

    if (up.error) {
      return json({ ok: false, error: "storage upload failed", details: up.error.message }, 500);
    }

    // Update Minute Book entry pointers (critical for Reader)
    const upd = await supabase
      .from("minute_book_entries")
      .update({
        storage_path,
        file_name,
        pdf_hash: file_hash,
        updated_at: new Date().toISOString(),
      })
      .eq("id", entry_id);

    if (upd.error) {
      return json({ ok: false, error: "minute_book_entries update failed", details: upd.error.message }, 500);
    }

    // Supporting document pointer (required by your Evidence panel)
    // section is USER-DEFINED (enum). Use governance_domain_sections.default_section if present; else null is not allowed.
    const section = default_section ?? "misc"; // last-resort label; if enum doesn't include it, you'll see the exact error.

    const supDoc = await supabase
      .from("supporting_documents")
      .insert({
        entry_id,
        entity_key: body.entity_slug as unknown as string,
        section: section as unknown as string,
        file_path: storage_path,
        file_name,
        doc_type: "pdf",
        version: 1,
        uploaded_by: actor,
        owner_id: actor,
        file_hash,
        mime_type: "application/pdf",
        file_size: fileBytes.byteLength,
        signature_envelope_id: body.envelope_id ?? null,
        metadata: {
          source: body.source ?? "signed_resolution",
          record_id: body.record_id ?? null,
        },
      })
      .select("id")
      .single();

    // If supporting_docs fails because section enum label is wrong, return a clean error
    if (supDoc.error) {
      return json(
        {
          ok: false,
          error: "supporting_documents insert failed (check section enum label / governance_domain_sections.default_section)",
          details: supDoc.error.message,
        },
        500,
      );
    }

    // Verified registry (NO source_entry_id — use source_record_id)
    // document_class is USER-DEFINED enum; we use a safe guess string "minute_book"
    const document_class = await pickVerifiedDocumentClass();

    const vdoc = await supabase
      .from("verified_documents")
      .upsert(
        {
          entity_id: body.entity_id,
          entity_slug: body.entity_slug,
          entity_key: body.entity_slug,
          document_class: document_class as unknown as string,
          title: body.title,
          source_table: "minute_book_entries",
          source_record_id: entry_id,
          storage_bucket: MINUTE_BOOK_BUCKET,
          storage_path,
          file_hash,
          file_size: fileBytes.byteLength,
          mime_type: "application/pdf",
          envelope_id: body.envelope_id ?? null,
          updated_at: new Date().toISOString(),
          updated_by: actor,
          created_by: actor,
          is_archived: false,
          document_purpose: "governance",
        },
        { onConflict: "source_table,source_record_id" as any },
      )
      .select("id")
      .maybeSingle();

    // If verified_documents fails due to enum mismatch, don’t block archive—return warning
    if (vdoc.error) {
      return json({
        ok: true,
        entry_id,
        storage_bucket: MINUTE_BOOK_BUCKET,
        storage_path,
        file_hash,
        supporting_document_id: supDoc.data.id,
        warning: "verified_documents upsert failed (enum mismatch likely). Fix UI to query source_record_id, not source_entry_id.",
        warning_details: vdoc.error.message,
      });
    }

    return json({
      ok: true,
      entry_id,
      storage_bucket: MINUTE_BOOK_BUCKET,
      storage_path,
      file_hash,
      supporting_document_id: supDoc.data.id,
      verified_document_id: vdoc.data?.id ?? null,
    });
  } catch (e) {
    return json({ ok: false, error: String(e?.message ?? e) }, 500);
  }
});
