import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

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

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
  auth: { persistSession: false, autoRefreshToken: false },
});

function requireUUID(v: unknown, field: string) {
  if (typeof v !== "string" || !/^[0-9a-fA-F-]{36}$/.test(v)) {
    throw new Error(`Invalid ${field}`);
  }
  return v;
}

/**
 * Minute Book Reader usually assumes bucket = "minute_book".
 * supporting_documents has file_path but not storage_bucket, so we ensure the PDF exists there.
 */
async function ensureInMinuteBookBucket(sourceBucket: string, path: string) {
  const MINUTE_BOOK_BUCKET = "minute_book";

  // Already in minute_book — nothing to do.
  if (sourceBucket === MINUTE_BOOK_BUCKET) return { copied: false, bucket: MINUTE_BOOK_BUCKET, path };

  // Check if it already exists in minute_book (idempotent)
  {
    const { data: already, error: existsErr } = await supabase.storage
      .from(MINUTE_BOOK_BUCKET)
      .download(path);

    // If download works, it exists.
    if (!existsErr && already) return { copied: false, bucket: MINUTE_BOOK_BUCKET, path };
  }

  // Download from source bucket
  const { data: file, error: dlErr } = await supabase.storage.from(sourceBucket).download(path);
  if (dlErr || !file) throw new Error(`Could not download from ${sourceBucket}/${path}: ${dlErr?.message ?? "no file"}`);

  // Upload into minute_book at same path (upsert true)
  const { error: upErr } = await supabase.storage
    .from(MINUTE_BOOK_BUCKET)
    .upload(path, file, { upsert: true, contentType: "application/pdf" });

  if (upErr) throw new Error(`Could not upload to minute_book/${path}: ${upErr.message}`);

  return { copied: true, bucket: MINUTE_BOOK_BUCKET, path };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  try {
    const body = (await req.json()) as ReqBody;
    const record_id = requireUUID(body.record_id, "record_id");

    // Seal + register (SQL is the source of truth)
    const { data, error } = await supabase
      .rpc("seal_governance_record_for_archive", { p_ledger_id: record_id })
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error("seal_governance_record_for_archive returned no row");

    // Ensure minute_book bucket contains the PDF so the Reader can open it
    const ensured = await ensureInMinuteBookBucket(data.storage_bucket, data.storage_path);

    return json({
      ok: true,
      record_id,
      ...data,
      reader_bucket: ensured.bucket,
      reader_path: ensured.path,
      copied_to_minute_book: ensured.copied,
    });
  } catch (err: any) {
    return json(
      { ok: false, error: err?.message ?? "archive-save-document failed", details: String(err) },
      500,
    );
  }
});
