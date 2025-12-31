// supabase/functions/_shared/archive.ts
import { createClient } from "jsr:@supabase/supabase-js@2";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
};

export function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function getEnv(name: string) {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export function serviceClient() {
  const url = getEnv("SUPABASE_URL");
  const key =
    Deno.env.get("SERVICE_ROLE_KEY") ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
    "";
  if (!key) throw new Error("Missing SERVICE_ROLE_KEY / SUPABASE_SERVICE_ROLE_KEY");

  return createClient(url, key, { global: { fetch } });
}

export async function resolveActorUserId(req: Request, sb = serviceClient()): Promise<string | null> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";
  if (!token) return null;

  // service-role client can validate token
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user?.id) return null;
  return data.user.id;
}

export async function getEntityKeyFromEntityId(entity_id: string, sb = serviceClient()): Promise<string> {
  const { data, error } = await sb
    .from("entities")
    .select("slug")
    .eq("id", entity_id)
    .single();

  if (error || !data?.slug) throw new Error(`Could not resolve entity slug for entity_id=${entity_id}`);
  // must match your enum labels (holdings/lounge/real_estate etc.)
  return String(data.slug);
}

export function minuteBookPrimaryPath(entity_key: string, section: string, ledger_id: string, signed = true) {
  // Keep your existing convention
  // NOTE: your bucket is `minute_book`, and you already have holdings/Resolutions/<id>-signed.pdf
  const sec = section; // use enum label case (ex: "Resolutions")
  return `${entity_key}/${sec}/${ledger_id}${signed ? "-signed" : ""}.pdf`;
}

export async function ensureMinuteBookEntry(opts: {
  sb: ReturnType<typeof serviceClient>;
  entity_id: string;
  entity_key: string;
  domain_key: string;
  title: string;
  is_test: boolean;
  source_record_id: string; // governance_ledger.id
}) {
  const { sb, entity_id, entity_key, domain_key, title, is_test, source_record_id } = opts;

  // Try find existing
  const { data: existing } = await sb
    .from("minute_book_entries")
    .select("id")
    .eq("source_record_id", source_record_id)
    .order("created_at", { ascending: false })
    .limit(1);

  if (existing && existing.length > 0) return existing[0].id as string;

  // Create
  const { data: ins, error } = await sb
    .from("minute_book_entries")
    .insert({
      entity_id,
      entity_key,       // entity_key_enum
      domain_key,       // text (your schema)
      title,
      is_test,
      source_record_id,
    })
    .select("id")
    .single();

  if (error || !ins?.id) throw new Error(`minute_book_entries insert failed: ${error?.message ?? "no id"}`);
  return ins.id as string;
}

export async function upsertSupportingPrimary(opts: {
  sb: ReturnType<typeof serviceClient>;
  entry_id: string;
  entity_key: string;        // entity_key_enum
  section: string;           // doc_section_enum (ex: "Resolutions")
  file_path: string;         // path inside minute_book bucket
  file_name: string;
  file_hash: string | null;
  mime_type: string | null;
  file_size: number | null;
  signature_envelope_id: string | null;
  uploaded_by: string;
  owner_id: string;
  metadata: Record<string, unknown>;
}) {
  const {
    sb, entry_id, entity_key, section, file_path, file_name, file_hash, mime_type, file_size,
    signature_envelope_id, uploaded_by, owner_id, metadata,
  } = opts;

  // Your table has no storage_bucket column. `file_path` is the canonical pointer.
  // Use doc_type='primary' and version=1.
  const payload = {
    entry_id,
    entity_key,
    section,
    file_path,
    file_name,
    doc_type: "primary",
    version: 1,
    uploaded_by,
    uploaded_at: new Date().toISOString(),
    owner_id,
    file_hash,
    mime_type,
    file_size,
    signature_envelope_id,
    metadata: metadata ?? {},
    verified: true,
    registry_visible: true,
  };

  // Prefer "do nothing" if you have unique constraints; otherwise insert new.
  // Many of your installs use unique (entry_id, doc_type, version) or similar.
  const { error } = await sb.from("supporting_documents").insert(payload);
  if (!error) return;

  // fallback: if insert failed due to conflict/uniqueness, try update by selecting the latest primary
  const { data: row } = await sb
    .from("supporting_documents")
    .select("id")
    .eq("entry_id", entry_id)
    .eq("doc_type", "primary")
    .order("uploaded_at", { ascending: false })
    .limit(1);

  if (!row || row.length === 0) throw new Error(`supporting_documents insert failed: ${error.message}`);

  const { error: updErr } = await sb
    .from("supporting_documents")
    .update(payload)
    .eq("id", row[0].id);

  if (updErr) throw new Error(`supporting_documents update failed: ${updErr.message}`);
}
