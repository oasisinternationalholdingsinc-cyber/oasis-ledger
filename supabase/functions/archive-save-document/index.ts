import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error("Missing Supabase env");

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

const MINUTE_BOOK_BUCKET = Deno.env.get("MINUTE_BOOK_BUCKET") ?? "minute_book";

// If your signed PDFs always live somewhere else, set SIGNED_PDF_BUCKET.
// In your case it’s minute_book, so default is correct.
const SIGNED_PDF_BUCKET = Deno.env.get("SIGNED_PDF_BUCKET") ?? MINUTE_BOOK_BUCKET;

const DEFAULT_DOMAIN_KEY = Deno.env.get("DEFAULT_MINUTE_BOOK_DOMAIN_KEY") ?? "governance";
const DEFAULT_SECTION_NAME = Deno.env.get("DEFAULT_MINUTE_BOOK_SECTION_NAME") ?? "Governance";

// Optional: seal into verified registry
const SEAL_RPC_NAME = Deno.env.get("SEAL_RPC_NAME") ?? "seal_governance_record_for_archive";

const corsHeaders: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function asString(x: unknown) {
  return typeof x === "string" ? x.trim() : "";
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

type ReqBody = {
  envelope_id?: string;
  record_id?: string;

  // optional placement overrides
  domain_key?: string;
  section_name?: string;

  // optional override
  signed_bucket?: string;
};

function deriveSignedCandidate(p: string): string[] {
  const s = asString(p);
  if (!s) return [];

  const out = new Set<string>();

  // If already signed, keep it.
  out.add(s);

  // If unsigned ".../X.pdf" => try ".../X-signed.pdf"
  if (s.toLowerCase().endsWith(".pdf") && !s.toLowerCase().includes("-signed.pdf")) {
    out.add(s.replace(/\.pdf$/i, "-signed.pdf"));
  }

  // If some systems store as ".../X-signed.pdf" but you got ".../X"
  if (!s.toLowerCase().endsWith(".pdf")) {
    out.add(`${s}-signed.pdf`);
    out.add(`${s}.pdf`);
  }

  return Array.from(out).filter(Boolean);
}

async function tryDownload(bucket: string, path: string): Promise<Uint8Array | null> {
  const b = asString(bucket);
  const p = asString(path);
  if (!b || !p) return null;

  const { data: blob, error } = await supabase.storage.from(b).download(p);
  if (error || !blob) return null;

  return new Uint8Array(await blob.arrayBuffer());
}

async function findByList(
  bucket: string,
  folder: string,
  recordId: string,
): Promise<string | null> {
  const b = asString(bucket);
  const f = asString(folder).replace(/^\/+|\/+$/g, "");
  if (!b) return null;

  // list() takes a folder path ("" for root)
  const { data, error } = await supabase.storage.from(b).list(f, {
    limit: 200,
    // search matches file name within this folder
    search: recordId,
  });

  if (error || !data?.length) return null;

  // We specifically want "*<recordId>*-signed.pdf"
  const wanted = data.find((x) =>
    (x.name ?? "").toLowerCase().includes(recordId.toLowerCase()) &&
    (x.name ?? "").toLowerCase().includes("-signed.pdf")
  );

  if (!wanted?.name) return null;

  return f ? `${f}/${wanted.name}` : wanted.name;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "POST required" }, 405);

  let body: ReqBody;
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const envelope_id = asString(body.envelope_id);
  const record_id_in = asString(body.record_id);
  if (!envelope_id && !record_id_in) {
    return json({ ok: false, error: "Provide envelope_id (preferred) or record_id" }, 400);
  }

  // 1) Resolve record_id + envelope storage path hints
  let record_id = record_id_in;
  let envelope_status = "";
  let envelope_paths: string[] = [];

  if (envelope_id) {
    const { data: env, error: envErr } = await supabase
      .from("signature_envelopes")
      .select("id, record_id, status, storage_path, supporting_document_path")
      .eq("id", envelope_id)
      .maybeSingle();

    if (envErr) {
      return json({ ok: false, error: "Failed to load signature_envelopes", details: envErr.message }, 500);
    }
    if (!env) return json({ ok: false, error: "Envelope not found", envelope_id }, 404);

    record_id = record_id || asString(env.record_id);
    envelope_status = asString(env.status);

    envelope_paths = [
      ...deriveSignedCandidate(asString(env.storage_path)),
      ...deriveSignedCandidate(asString(env.supporting_document_path)),
    ];
  }

  if (!record_id) return json({ ok: false, error: "Could not resolve record_id" }, 400);

  // 2) Load governance record (truth source for entity + lane + title)
  const { data: ledger, error: ledErr } = await supabase
    .from("governance_ledger")
    .select("id, title, entity_id, is_test")
    .eq("id", record_id)
    .maybeSingle();

  if (ledErr) return json({ ok: false, error: "Failed to load governance_ledger", details: ledErr.message }, 500);
  if (!ledger) return json({ ok: false, error: "record_id not found in governance_ledger", record_id }, 404);

  const lane_is_test = (ledger.is_test ?? false) === true;
  const title = asString(ledger.title) || "Signed Resolution";
  const entity_id = asString(ledger.entity_id);
  if (!entity_id) return json({ ok: false, error: "governance_ledger.entity_id missing", record_id }, 400);

  // 3) Resolve entity_key from entities.slug
  const { data: ent, error: entErr } = await supabase
    .from("entities")
    .select("slug")
    .eq("id", entity_id)
    .maybeSingle();

  if (entErr) return json({ ok: false, error: "Failed to resolve entity slug", details: entErr.message }, 500);
  const entity_key = asString(ent?.slug);
  if (!entity_key) return json({ ok: false, error: "Could not resolve entity_key from entities.slug", entity_id }, 400);

  const signed_bucket = asString(body.signed_bucket) || SIGNED_PDF_BUCKET;

  // 4) Candidate paths (KNOWN good pattern + envelope-derived + common variations)
  const candidates = new Set<string>();

  // known patterns you actually use in prod (case matters in storage paths)
  candidates.add(`${entity_key}/Resolutions/${record_id}-signed.pdf`);
  candidates.add(`${entity_key}/resolutions/${record_id}-signed.pdf`);

  // if your app sometimes uses holdings/Resolutions (we’ve seen that in storage)
  candidates.add(`holdings/Resolutions/${record_id}-signed.pdf`);
  candidates.add(`holdings/resolutions/${record_id}-signed.pdf`);

  // envelope-derived
  for (const p of envelope_paths) candidates.add(p);

  // 5) Try download each candidate (no storage.objects queries)
  let signed_path: string | null = null;
  let signedBytes: Uint8Array | null = null;

  for (const p of candidates) {
    const bytes = await tryDownload(signed_bucket, p);
    if (bytes) {
      signed_path = p;
      signedBytes = bytes;
      break;
    }
  }

  // 6) If not found, search via storage.list() in likely folders
  if (!signedBytes) {
    const likelyFolders = [
      `${entity_key}/Resolutions`,
      `${entity_key}/resolutions`,
      `holdings/Resolutions`,
      `holdings/resolutions`,
      `${entity_key}`, // last resort
      `holdings`,      // last resort
      ``,
    ];

    for (const folder of likelyFolders) {
      const foundPath = await findByList(signed_bucket, folder, record_id);
      if (!foundPath) continue;

      const bytes = await tryDownload(signed_bucket, foundPath);
      if (bytes) {
        signed_path = foundPath;
        signedBytes = bytes;
        break;
      }
    }
  }

  if (!signedBytes || !signed_path) {
    return json(
      {
        ok: false,
        error: "Failed to locate signed PDF in storage",
        record_id,
        envelope_id: envelope_id || null,
        hint: `Checked bucket "${signed_bucket}" via download() candidates + list(). Expected: *${record_id}*-signed.pdf`,
        debug: {
          tried_candidates: Array.from(candidates).slice(0, 30),
          entity_key,
        },
      },
      404,
    );
  }

  const pdf_base64 = base64FromBytes(signedBytes);

  // 7) Call archive-save-document
  const domain_key = asString(body.domain_key) || DEFAULT_DOMAIN_KEY;
  const section_name = asString(body.section_name) || DEFAULT_SECTION_NAME;

  const { data: saveRes, error: saveErr } = await supabase.functions.invoke("archive-save-document", {
    body: {
      source_record_id: record_id,
      pdf_base64,
      title,
      entity_id,
      entity_key,
      is_test: lane_is_test,
      envelope_id: envelope_id || null,
      domain_key,
      section_name,
      bucket: MINUTE_BOOK_BUCKET,
    },
  });

  if (saveErr) {
    return json(
      {
        ok: false,
        error: "archive-save-document failed",
        details: saveErr.message,
        record_id,
        envelope_id: envelope_id || null,
      },
      500,
    );
  }

  // 8) Best-effort seal (non-blocking)
  let seal_result: unknown = null;
  {
    const { data: sealData, error: sealErr } = await supabase.rpc(SEAL_RPC_NAME as any, {
      record_id,
    } as any);

    if (!sealErr) seal_result = sealData;
  }

  return json({
    ok: true,
    record_id,
    envelope_id: envelope_id || null,
    envelope_status: envelope_status || null,
    lane_is_test,
    signed_bucket,
    signed_path,
    minute_book_bucket: MINUTE_BOOK_BUCKET,
    archive_save_result: saveRes ?? null,
    seal_result,
  });
});
