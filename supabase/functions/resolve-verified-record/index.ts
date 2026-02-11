import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/* ============================
   Types
============================ */
type ReqBody = {
  // UI / legacy
  hash?: string | null;
  envelope_id?: string | null;
  ledger_id?: string | null;
  entry_id?: string | null;

  // RPC-compatible
  p_hash?: string | null;
  p_envelope_id?: string | null;
  p_ledger_id?: string | null;
  p_entry_id?: string | null;

  expires_in?: number | null;
};

/* ============================
   CORS
============================ */
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

/* ============================
   Env
============================ */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
}

// Canonical SQL resolver (DO NOT RENAME)
const RESOLVE_RPC = "resolve_verified_record";

/* ============================
   Helpers
============================ */
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

function isUuid(s: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    s,
  );
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

/**
 * ONLY as fallback if DB source cannot be resolved.
 * Truth is derived from governance_ledger.is_test or minute_book_entries.is_test.
 */
function isTestFromBucketFallback(bucket: string) {
  const b = bucket.toLowerCase();
  return b === "governance_sandbox" || b.includes("sandbox");
}

/* ============================
   lane + minute_book resolver (DB truth, not verified_documents)
============================ */
async function resolveLaneAndMinuteBookFromSource(args: {
  supabaseAdmin: ReturnType<typeof createClient>;
  vd: any;
}): Promise<{
  is_test: boolean;
  ledger_id: string | null;
  minute_book: { storage_bucket: string; storage_path: string } | null;
}> {
  const { supabaseAdmin, vd } = args;

  const source_table = safeText(vd.source_table);
  const source_record_id = safeText(vd.source_record_id);

  // default fallback
  let is_test = isTestFromBucketFallback(String(vd.storage_bucket ?? ""));
  let ledger_id: string | null = null;
  let minute_book: { storage_bucket: string; storage_path: string } | null = null;

  // ✅ IMPORTANT: verified_documents has NO is_test — never read it.

  if (source_table === "governance_ledger" && source_record_id && isUuid(source_record_id)) {
    ledger_id = source_record_id;

    // authoritative lane from ledger
    const gl = await supabaseAdmin
      .from("governance_ledger")
      .select("id,is_test")
      .eq("id", ledger_id)
      .maybeSingle();

    if (!gl.error && gl.data && typeof (gl.data as any).is_test === "boolean") {
      is_test = !!(gl.data as any).is_test;
    }

    // minute book pointer from minute_book_entries
    const mbe = await supabaseAdmin
      .from("minute_book_entries")
      .select("storage_path, created_at")
      .eq("source_record_id", ledger_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const p = safeText((mbe.data as any)?.storage_path);
    if (p) {
      minute_book = { storage_bucket: "minute_book", storage_path: p };
    }
  }

  if (source_table === "minute_book_entries" && source_record_id && isUuid(source_record_id)) {
    // source is already a minute_book_entries record
    const mbe = await supabaseAdmin
      .from("minute_book_entries")
      .select("id,is_test,storage_path")
      .eq("id", source_record_id)
      .maybeSingle();

    const p = safeText((mbe.data as any)?.storage_path);
    if (p) minute_book = { storage_bucket: "minute_book", storage_path: p };

    if (!mbe.error && mbe.data && typeof (mbe.data as any).is_test === "boolean") {
      is_test = !!(mbe.data as any).is_test;
    }
  }

  return { is_test, ledger_id, minute_book };
}

/* ============================
   Build payload from verified_documents row
============================ */
async function buildFromVerifiedRow(args: {
  supabaseAdmin: ReturnType<typeof createClient>;
  vd: any;
  expires_in: number;
  noteExtras?: Record<string, unknown>;
}) {
  const { supabaseAdmin, vd, expires_in, noteExtras } = args;

  const bucket = String(vd.storage_bucket);
  const path = String(vd.storage_path);

  const signed = await signUrl(supabaseAdmin, bucket, path, expires_in);

  // ✅ FIX: lane + minute_book pointer from DB truth
  const derived = await resolveLaneAndMinuteBookFromSource({ supabaseAdmin, vd });
  const is_test = derived.is_test;

  // minute book signed url (best-effort)
  let minuteBookSigned: { url: string | null; error: string | null } = {
    url: null,
    error: null,
  };

  if (derived.minute_book?.storage_bucket && derived.minute_book?.storage_path) {
    minuteBookSigned = await signUrl(
      supabaseAdmin,
      derived.minute_book.storage_bucket,
      derived.minute_book.storage_path,
      expires_in,
    );
  }

  // entity hydration (best-effort, NO contamination)
  const entId = safeText(vd.entity_id);
  const entSlug = safeText(vd.entity_slug);

  let ent: any = null;
  if (entId && isUuid(entId)) {
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

  const notes: Record<string, unknown> = { ...(noteExtras ?? {}) };
  if (signed.error) notes.archive_sign_error = signed.error;
  if (minuteBookSigned.error) notes.minute_book_sign_error = minuteBookSigned.error;
  if (!derived.minute_book) notes.minute_book_pointer_missing = true;

  return {
    ok: true,
    hash: vd.file_hash,
    verified_document_id: vd.id,

    ledger_id: derived.ledger_id ?? null,
    envelope_id: vd.envelope_id ?? null,

    entity:
      ent ?? {
        id: entId ?? null,
        name: "—",
        slug: entSlug ?? "—",
      },

    ledger: {
      id: derived.ledger_id ?? null,
      title: vd.title ?? "Verified Document",
      status: "ARCHIVED",
      is_test,
      created_at: vd.created_at ?? null,
    },

    verified: {
      id: vd.id,
      entity_id: entId ?? null,
      entity_slug: entSlug ?? null,
      title: vd.title ?? null,
      document_class: vd.document_class ?? null,
      verification_level: vd.verification_level ?? "certified",
      storage_bucket: bucket,
      storage_path: path,
      file_hash: vd.file_hash,
      created_at: vd.created_at ?? null,
      source_table: vd.source_table ?? null,
      source_record_id: vd.source_record_id ?? null,
      envelope_id: vd.envelope_id ?? null,
    },

    // UI toggles
    best_pdf: {
      kind: "verified_archive",
      storage_bucket: bucket,
      storage_path: path,
    },

    public_pdf: derived.minute_book
      ? {
          kind: "minute_book",
          storage_bucket: derived.minute_book.storage_bucket,
          storage_path: derived.minute_book.storage_path,
        }
      : null,

    expires_in,
    urls: {
      best_pdf: signed.url,
      minute_book_pdf: minuteBookSigned.url,
      certified_archive_pdf: signed.url,
    },

    notes: Object.keys(notes).length ? notes : undefined,
  };
}

/* ============================
   Hash-first resolver (Verified Registry only)
============================ */
async function buildHashFirstPayload(args: {
  supabaseAdmin: ReturnType<typeof createClient>;
  hash: string;
  expires_in: number;
}) {
  const { supabaseAdmin, hash, expires_in } = args;

  const { data: vd, error: vdErr } = await supabaseAdmin
    .from("verified_documents")
    .select(
      "id, entity_id, entity_slug, title, document_class, verification_level, storage_bucket, storage_path, file_hash, created_at, updated_at, source_table, source_record_id, envelope_id",
    )
    .eq("file_hash", hash)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (vdErr) return { ok: false, error: "VERIFIED_LOOKUP_FAILED", details: vdErr };
  if (!vd?.id || !vd.storage_bucket || !vd.storage_path || !vd.file_hash) {
    return { ok: false, error: "NOT_REGISTERED" };
  }

  return buildFromVerifiedRow({ supabaseAdmin, vd, expires_in });
}

/* ============================
   Entry-first resolver (Minute Book certification QR)
============================ */
async function buildEntryFirstPayload(args: {
  supabaseAdmin: ReturnType<typeof createClient>;
  entry_id: string;
  expires_in: number;
}) {
  const { supabaseAdmin, entry_id, expires_in } = args;

  if (!isUuid(entry_id)) return { ok: false, error: "BAD_ENTRY_ID" };

  const { data: vd, error: vdErr } = await supabaseAdmin
    .from("verified_documents")
    .select(
      "id, entity_id, entity_slug, title, document_class, verification_level, storage_bucket, storage_path, file_hash, created_at, updated_at, source_table, source_record_id, envelope_id",
    )
    .eq("source_table", "minute_book_entries")
    .eq("source_record_id", entry_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (vdErr) return { ok: false, error: "VERIFIED_LOOKUP_FAILED", details: vdErr };
  if (!vd?.id || !vd.storage_bucket || !vd.storage_path || !vd.file_hash) {
    return { ok: false, error: "NOT_REGISTERED" };
  }

  return buildFromVerifiedRow({
    supabaseAdmin,
    vd,
    expires_in,
    noteExtras: { resolved_via: "entry_id" },
  });
}

/* ============================
   Handler
============================ */
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
    global: {
      fetch,
      headers: { "x-client-info": "odp-verify/resolve-verified-record" },
    },
  });

  let body: ReqBody = {};
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    return json({ ok: false, error: "INVALID_JSON", request_id: reqId }, 400);
  }

  const hash = safeText(body.hash ?? body.p_hash)?.toLowerCase() ?? null;
  const entry_id = safeText(body.entry_id ?? body.p_entry_id) ?? null;
  const envelope_id = safeText(body.envelope_id ?? body.p_envelope_id) ?? null;
  const ledger_id = safeText(body.ledger_id ?? body.p_ledger_id) ?? null;
  const expires_in = clampExpiresIn(body.expires_in ?? 900);

  if (!hash && !entry_id && !envelope_id && !ledger_id) {
    return json(
      {
        ok: false,
        error: "MISSING_INPUT",
        message: "Provide hash OR entry_id OR envelope_id OR ledger_id.",
        request_id: reqId,
      },
      400,
    );
  }

  // ✅ 1) HASH-FIRST (canonical)
  if (hash) {
    const fb = await buildHashFirstPayload({ supabaseAdmin, hash, expires_in });
    if ((fb as any).ok === true) return json({ ...(fb as any), request_id: reqId }, 200);

    // If ONLY hash provided, return that failure cleanly
    if (!entry_id && !envelope_id && !ledger_id) {
      return json({ ...(fb as any), request_id: reqId }, 200);
    }
  }

  // ✅ 2) ENTRY-FIRST (minute book QR)
  if (entry_id) {
    const eb = await buildEntryFirstPayload({ supabaseAdmin, entry_id, expires_in });
    if ((eb as any).ok === true) return json({ ...(eb as any), request_id: reqId }, 200);

    if (!envelope_id && !ledger_id) {
      return json({ ...(eb as any), request_id: reqId }, 200);
    }
  }

  // ✅ 3) Canonical SQL RPC (envelope_id / ledger_id)
  const { data: resolved, error: rpcErr } = await supabaseAdmin.rpc(RESOLVE_RPC, {
    p_hash: null, // IMPORTANT: hash handled above (registry-first)
    p_envelope_id: envelope_id,
    p_ledger_id: ledger_id,
  });

  if (rpcErr) {
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
      // keep as-is
    }
  }

  if (!payload || payload.ok !== true) {
    return json(
      { ...(payload ?? { ok: false, error: "RESOLVE_FAILED" }), request_id: reqId },
      200,
    );
  }

  // Signed URL enrichment (existing behavior)
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
  } else notes.best_pdf_pointer_missing = true;

  if (publicPdf?.storage_bucket && publicPdf?.storage_path) {
    const s = await signUrl(
      supabaseAdmin,
      String(publicPdf.storage_bucket),
      String(publicPdf.storage_path),
      expires_in,
    );
    minuteBookUrl = s.url;
    if (s.error) notes.minute_book_sign_error = s.error;
  } else notes.minute_book_pointer_missing = true;

  if (verified?.storage_bucket && verified?.storage_path) {
    const s = await signUrl(
      supabaseAdmin,
      String(verified.storage_bucket),
      String(verified.storage_path),
      expires_in,
    );
    archiveUrl = s.url;
    if (s.error) notes.archive_sign_error = s.error;
  } else notes.archive_pointer_missing = true;

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
