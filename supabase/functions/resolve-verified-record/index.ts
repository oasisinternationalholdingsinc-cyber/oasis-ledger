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

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
}

// Canonical SQL resolver (do not rename)
const RESOLVE_RPC = "resolve_verified_record";

function clampExpiresIn(n: unknown) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 900;
  return Math.max(60, Math.min(3600, v)); // 1m..60m
}

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

function isTestFromBucket(bucket: string) {
  const b = bucket.toLowerCase();
  return b === "governance_sandbox" || b.includes("sandbox");
}

// Build a verify.html-compatible payload using ONLY verified_documents (hash-first)
async function buildHashFirstPayload(args: {
  supabaseAdmin: ReturnType<typeof createClient>;
  hash: string;
  expires_in: number;
}) {
  const { supabaseAdmin, hash, expires_in } = args;

  // verified_documents lookup (NO schema drift: uses existing columns you already rely on)
  const { data: vd, error: vdErr } = await supabaseAdmin
    .from("verified_documents")
    .select(
      "id, entity_id, entity_slug, title, document_class, verification_level, storage_bucket, storage_path, file_hash, created_at, updated_at, source_table, source_record_id",
    )
    .eq("file_hash", hash)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (vdErr) {
    return { ok: false, error: "VERIFIED_LOOKUP_FAILED", details: vdErr };
  }

  if (!vd?.id || !vd.storage_bucket || !vd.storage_path || !vd.file_hash) {
    return { ok: false, error: "NOT_REGISTERED" };
  }

  // entity hydration (best-effort, no hardcoding)
  const entId = safeText((vd as any).entity_id);
  const entSlug = safeText((vd as any).entity_slug);

  let ent: any = null;
  if (entId) {
    const r = await supabaseAdmin
      .from("entities")
      .select("id,name,slug")
      .eq("id", entId)
      .maybeSingle();
    if (!r.error && r.data) ent = r.data;
  } else if (entSlug) {
    const r = await supabaseAdmin
      .from("entities")
      .select("id,name,slug")
      .eq("slug", entSlug)
      .maybeSingle();
    if (!r.error && r.data) ent = r.data;
  }

  const bucket = String((vd as any).storage_bucket);
  const path = String((vd as any).storage_path);

  const signed = await signUrl(supabaseAdmin, bucket, path, expires_in);

  const is_test = isTestFromBucket(bucket);

  // IMPORTANT: verify.html expects:
  // - ok:true
  // - hash (or verified.file_hash)
  // - verified.storage_bucket/storage_path
  // - urls.best_pdf at minimum to render iframe/open/download
  return {
    ok: true,
    hash: (vd as any).file_hash,
    verified_document_id: (vd as any).id,

    // Ledger/envelope not available in pure hash-only path (that’s fine)
    ledger_id: null,
    envelope_id: null,

    entity:
      ent ??
      ({
        id: entId ?? null,
        name: ent?.name ?? "—",
        slug: ent?.slug ?? entSlug ?? "—",
      } as any),

    ledger: {
      id: null,
      title: (vd as any).title ?? "Verified Document",
      status: "ARCHIVED",
      is_test,
      created_at: (vd as any).created_at ?? null,
    },

    verified: {
      id: (vd as any).id,
      entity_id: entId ?? null,
      entity_slug: entSlug ?? null,
      title: (vd as any).title ?? null,
      document_class: (vd as any).document_class ?? null,
      verification_level: (vd as any).verification_level ?? "certified",
      storage_bucket: bucket,
      storage_path: path,
      file_hash: (vd as any).file_hash,
      created_at: (vd as any).created_at ?? null,
      // keep envelope/ledger absent in hash-only
    },

    best_pdf: {
      kind: "verified_archive",
      storage_bucket: bucket,
      storage_path: path,
    },

    public_pdf: null,

    expires_in,
    urls: {
      best_pdf: signed.url,
      minute_book_pdf: null,
      certified_archive_pdf: signed.url,
    },

    notes: signed.error
      ? { archive_sign_error: signed.error, minute_book_pointer_missing: true }
      : { minute_book_pointer_missing: true },
  };
}

serve(async (req) => {
  const reqId = req.headers.get("x-sb-request-id") ?? null;

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: withCors() });
  }

  if (req.method !== "POST") {
    return json({ ok: false, error: "METHOD_NOT_ALLOWED", request_id: reqId }, 405);
  }

  const supabaseAdmin = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
    global: { fetch, headers: { "x-client-info": "odp-verify/resolve-verified-record" } },
  });

  let body: ReqBody = {};
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    return json({ ok: false, error: "INVALID_JSON", request_id: reqId }, 400);
  }

  // ✅ ENTERPRISE INPUT NORMALIZATION (NO REGRESSION)
  const hash =
    safeText(body.hash ?? body.p_hash)?.toLowerCase() ?? null;

  const envelope_id =
    safeText(body.envelope_id ?? body.p_envelope_id) ?? null;

  const ledger_id =
    safeText(body.ledger_id ?? body.p_ledger_id) ?? null;

  const expires_in = clampExpiresIn(body.expires_in ?? 900);

  if (!hash && !envelope_id && !ledger_id) {
    return json(
      {
        ok: false,
        error: "MISSING_INPUT",
        message: "Provide hash OR envelope_id OR ledger_id.",
        request_id: reqId,
      },
      400,
    );
  }

  // ---------------------------------------------------------------------------
  // 1) Canonical SQL resolver (unchanged call)
  // ---------------------------------------------------------------------------
  const { data: resolved, error: rpcErr } = await supabaseAdmin.rpc(RESOLVE_RPC, {
    p_hash: hash,
    p_envelope_id: envelope_id,
    p_ledger_id: ledger_id,
  });

  // If RPC hard-fails, we still allow hash-first fallback (if hash present)
  if (rpcErr) {
    if (hash) {
      const fb = await buildHashFirstPayload({ supabaseAdmin, hash, expires_in });
      return json({ ...fb, request_id: reqId }, 200);
    }
    return json(
      {
        ok: false,
        error: "RPC_FAILED",
        message: rpcErr.message,
        details: rpcErr,
        request_id: reqId,
      },
      500,
    );
  }

  let payload: any = resolved;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      // ignore
    }
  }

  // ---------------------------------------------------------------------------
  // 1b) ✅ ENTERPRISE HASH-FIRST FALLBACK (NO DRIFT)
  // If SQL is still ledger-centric and returns "ledger_id required" (or NOT_REGISTERED),
  // we must still allow hash-only resolution via verified_documents.
  // ---------------------------------------------------------------------------
  const rpcErrStr = String(payload?.error ?? "").toLowerCase();
  const needsHashFallback =
    !!hash &&
    payload &&
    payload.ok !== true &&
    (rpcErrStr === "not_registered" ||
      rpcErrStr.includes("ledger_id required") ||
      rpcErrStr.includes("ledger_id is required") ||
      rpcErrStr.includes("ledger_id"));

  if (needsHashFallback) {
    const fb = await buildHashFirstPayload({ supabaseAdmin, hash, expires_in });
    // If fallback succeeds, return it; otherwise return original payload (no regression)
    if ((fb as any).ok === true) return json({ ...(fb as any), request_id: reqId }, 200);
    return json({ ...(payload ?? { ok: false, error: "NOT_REGISTERED" }), request_id: reqId }, 200);
  }

  // ---------------------------------------------------------------------------
  // 2) Normal signed URL enrichment (NO REGRESSION)
  // ---------------------------------------------------------------------------
  if (!payload || payload.ok !== true) {
    return json({ ...(payload ?? { ok: false, error: "RESOLVE_FAILED" }), request_id: reqId }, 200);
  }

  const bestPdf = payload.best_pdf ?? null;
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

  return json(
    {
      ...payload,
      expires_in,
      urls: {
        best_pdf: bestUrl,
        minute_book_pdf: minuteBookUrl,
        certified_archive_pdf: archiveUrl,
      },
      notes: Object.keys(notes).length ? notes : undefined,
      request_id: reqId,
    },
    200,
  );
});
