// supabase/functions/resolve-verified-record/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  // UI / legacy
  hash?: string | null;
  envelope_id?: string | null;
  ledger_id?: string | null;

  // RPC-compatible (enterprise forward-compat)
  p_hash?: string | null;
  p_envelope_id?: string | null;
  p_ledger_id?: string | null;

  expires_in?: number | null;
};

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
};

function withCors(extra?: Record<string, string>) {
  return { ...cors, ...(extra ?? {}) };
}

const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x, null, 2), {
    status,
    headers: withCors({ "Content-Type": "application/json" }),
  });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
}

// Canonical SQL resolver
const RESOLVE_RPC = "resolve_verified_record";

const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    s,
  );

function safeText(v: unknown): string | null {
  if (v == null) return null;
  const t = String(v).trim();
  return t.length ? t : null;
}

async function signUrl(
  supabaseAdmin: ReturnType<typeof createClient>,
  bucket: string,
  path: string,
  expiresIn: number,
) {
  const { data, error } = await supabaseAdmin.storage
    .from(bucket)
    .createSignedUrl(path, expiresIn);

  if (error) return { url: null as string | null, error: error.message };
  return { url: data?.signedUrl ?? null, error: null as string | null };
}

function clampExpiresIn(n: unknown) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 900;
  return Math.max(60, Math.min(3600, v)); // 1m..60m
}

function pickBestPdfPointer(payload: any) {
  // Enterprise rule:
  // - Prefer payload.best_pdf if present (SQL may set to preferred pointer)
  // - Else fallback to public_pdf (minute book render)
  // - Else fallback to verified (archive)
  return (
    payload?.best_pdf ??
    payload?.public_pdf ??
    payload?.verified ??
    null
  );
}

/**
 * ✅ ENTERPRISE NO-REGRESSION PATCH:
 * If SQL resolver returns ok:false with "ledger_id required" (or similar)
 * but caller provided HASH, we do a safe, schema-neutral fallback:
 *
 * - Find verified_documents by file_hash
 * - Use that row's storage_bucket/storage_path as the certified archive pointer
 * - Also provide best_pdf = that same pointer (so verify UI can open something)
 *
 * This does NOT modify schema, enums, or verify.html.
 * It only avoids hard-failing hash-first for minute_book_entries certifications.
 */
async function fallbackResolveByHash(
  supabaseAdmin: ReturnType<typeof createClient>,
  hash: string,
) {
  const { data, error } = await supabaseAdmin
    .from("verified_documents")
    .select(
      "id, entity_id, entity_slug, title, document_class, source_table, source_record_id, storage_bucket, storage_path, file_hash, created_at",
    )
    .eq("file_hash", hash)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    return {
      ok: false,
      error: "HASH_FALLBACK_QUERY_FAILED",
      details: error,
    };
  }

  const row = (data ?? [])[0] as any;
  if (!row?.id) {
    return { ok: false, error: "NOT_REGISTERED" };
  }

  const storage_bucket = safeText(row.storage_bucket);
  const storage_path = safeText(row.storage_path);

  if (!storage_bucket || !storage_path) {
    return {
      ok: false,
      error: "POINTER_MISSING",
      details: "verified_documents row found for hash but storage pointer missing.",
    };
  }

  // Minimal enterprise payload that verify.html can consume:
  // - best_pdf / verified pointers
  // - entity + ledger optional (not always applicable for minute_book_entries)
  // - keep hash as canonical
  return {
    ok: true,
    // keep shape compatible with existing caller expectations
    hash: row.file_hash,
    verified_document_id: row.id,
    entity: row.entity_id
      ? { id: row.entity_id, slug: row.entity_slug ?? null }
      : { id: null, slug: row.entity_slug ?? null },
    record: {
      source_table: row.source_table ?? null,
      source_record_id: row.source_record_id ?? null,
      title: row.title ?? null,
      document_class: row.document_class ?? null,
    },
    best_pdf: { storage_bucket, storage_path },
    public_pdf: null, // unknown here; SQL is canonical for minute_book render
    verified: {
      storage_bucket,
      storage_path,
      file_hash: row.file_hash,
      created_at: row.created_at ?? null,
    },
    // preserve naming used elsewhere
    best_pdf_reason: "hash-fallback",
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: withCors() });
  }

  if (req.method !== "POST") {
    return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
    global: {
      headers: { "x-client-info": "odp-verify/resolve-verified-record" },
    },
  });

  let body: ReqBody = {};
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    return json({ ok: false, error: "INVALID_JSON" }, 400);
  }

  // 🔒 ENTERPRISE INPUT NORMALIZATION (NO REGRESSION)
  const hash = safeText(body.hash ?? body.p_hash);
  const envelope_id = safeText(body.envelope_id ?? body.p_envelope_id);
  const ledger_id = safeText(body.ledger_id ?? body.p_ledger_id);

  const expires_in = clampExpiresIn(body.expires_in ?? 900);

  // validate UUID inputs (defensive, no behavior change for valid clients)
  if (envelope_id && !isUuid(envelope_id)) {
    return json({ ok: false, error: "INVALID_ENVELOPE_ID" }, 400);
  }
  if (ledger_id && !isUuid(ledger_id)) {
    return json({ ok: false, error: "INVALID_LEDGER_ID" }, 400);
  }
  if (hash && hash.length < 16) {
    // avoid obvious junk; still allow shorter if you ever use non-sha hashes
    // (but your system uses sha256 hex => 64 chars)
    // We'll only warn, not block.
  }

  if (!hash && !envelope_id && !ledger_id) {
    return json(
      {
        ok: false,
        error: "MISSING_INPUT",
        message: "Provide hash OR envelope_id OR ledger_id.",
      },
      400,
    );
  }

  // 1) Canonical SQL resolver (unchanged call)
  const { data: resolved, error: rpcErr } = await supabaseAdmin.rpc(
    RESOLVE_RPC,
    {
      p_hash: hash,
      p_envelope_id: envelope_id,
      p_ledger_id: ledger_id,
    },
  );

  if (rpcErr) {
    return json(
      {
        ok: false,
        error: "RPC_FAILED",
        message: rpcErr.message,
        details: rpcErr,
      },
      500,
    );
  }

  let payload: any = resolved;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      // leave as-is
    }
  }

  // ✅ NO-REGRESSION HASH-FIRST FALLBACK
  // If SQL returns ok:false (often "ledger_id required") but we DO have hash,
  // resolve directly from verified_documents by hash so verify.html can open it.
  if ((!payload || payload.ok !== true) && hash) {
    const fb = await fallbackResolveByHash(supabaseAdmin, hash);
    payload = fb;
  }

  if (!payload || payload.ok !== true) {
    return json(payload ?? { ok: false, error: "RESOLVE_FAILED" }, 200);
  }

  // 2) Signed URLs (same behavior; just more robust "best pdf" selection)
  const bestPdf = pickBestPdfPointer(payload);
  const publicPdf = payload.public_pdf ?? null;
  const verified = payload.verified ?? null;

  const notes: Record<string, unknown> = {};

  let bestUrl: string | null = null;
  let minuteBookUrl: string | null = null;
  let archiveUrl: string | null = null;

  if (bestPdf?.storage_bucket && bestPdf?.storage_path) {
    const s = await signUrl(
      supabaseAdmin,
      String(bestPdf.storage_bucket),
      String(bestPdf.storage_path),
      expires_in,
    );
    bestUrl = s.url;
    if (s.error) notes.best_pdf_sign_error = s.error;
  } else {
    notes.best_pdf_pointer_missing = true;
  }

  if (publicPdf?.storage_bucket && publicPdf?.storage_path) {
    const s = await signUrl(
      supabaseAdmin,
      String(publicPdf.storage_bucket),
      String(publicPdf.storage_path),
      expires_in,
    );
    minuteBookUrl = s.url;
    if (s.error) notes.minute_book_sign_error = s.error;
  } else {
    // minute book render may legitimately be absent for some certified docs
    notes.minute_book_pointer_missing = true;
  }

  if (verified?.storage_bucket && verified?.storage_path) {
    const s = await signUrl(
      supabaseAdmin,
      String(verified.storage_bucket),
      String(verified.storage_path),
      expires_in,
    );
    archiveUrl = s.url;
    if (s.error) notes.archive_sign_error = s.error;
  } else {
    notes.archive_pointer_missing = true;
  }

  return json({
    ...payload,
    expires_in,
    urls: {
      best_pdf: bestUrl,
      minute_book_pdf: minuteBookUrl,
      certified_archive_pdf: archiveUrl,
    },
    notes: Object.keys(notes).length ? notes : undefined,
  });
});
