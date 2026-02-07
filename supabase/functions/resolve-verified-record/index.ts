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

function safeText(v: unknown): string | null {
  if (v == null) return null;
  const t = String(v).trim();
  return t.length ? t : null;
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
  const hash =
    (body.hash ?? body.p_hash ?? null)?.toString().trim().toLowerCase() || null;

  const envelope_id =
    (body.envelope_id ?? body.p_envelope_id ?? null)
      ?.toString()
      .trim() || null;

  const ledger_id =
    (body.ledger_id ?? body.p_ledger_id ?? null)
      ?.toString()
      .trim() || null;

  const expires_in = clampExpiresIn(body.expires_in ?? 900);

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

  // ---------------------------------------------------------------------------
  // 1) Canonical SQL resolver (unchanged)
  // ---------------------------------------------------------------------------
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
      // ignore
    }
  }

  // ---------------------------------------------------------------------------
  // 1b) ENTERPRISE FALLBACK (NO DRIFT):
  // If RPC is ledger-centric and returns NOT_REGISTERED for a valid minute_book
  // certified hash, resolve directly from verified_documents.file_hash.
  // ---------------------------------------------------------------------------
  const rpcNotRegistered =
    !!hash &&
    payload &&
    payload.ok !== true &&
    String(payload.error || "").toUpperCase() === "NOT_REGISTERED";

  if (rpcNotRegistered) {
    const { data: vd, error: vdErr } = await supabaseAdmin
      .from("verified_documents")
      .select(
        "id, entity_id, entity_slug, title, document_class, verification_level, storage_bucket, storage_path, file_hash, created_at, updated_at",
      )
      .eq("file_hash", hash)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!vdErr && vd?.id && vd?.storage_bucket && vd?.storage_path && vd?.file_hash) {
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

      const s = await signUrl(supabaseAdmin, bucket, path, expires_in);

      // lane inference (no schema assumptions)
      const is_test =
        bucket === "governance_sandbox" || bucket.toLowerCase().includes("sandbox");

      // Return verify.html-compatible payload
      return json({
        ok: true,
        // verify.html reads canonical hash from verified.file_hash or payload.hash
        hash: (vd as any).file_hash,
        verified_document_id: (vd as any).id,
        ledger_id: null,
        envelope_id: null,

        entity: ent ?? { id: entId ?? null, name: ent?.name ?? "—", slug: ent?.slug ?? entSlug ?? "—" },
        ledger: {
          id: null,
          title: (vd as any).title ?? "Verified Document",
          status: "ARCHIVED",
          is_test,
          created_at: (vd as any).created_at ?? null,
        },

        // These fields feed your badges
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
        },

        // best_pdf/public_pdf shape expected by verify.html
        best_pdf: {
          kind: "verified_archive",
          storage_bucket: bucket,
          storage_path: path,
        },
        public_pdf: null,

        expires_in,
        urls: {
          best_pdf: s.url,
          minute_book_pdf: null,
          certified_archive_pdf: s.url,
        },
        notes: s.error ? { archive_sign_error: s.error } : { minute_book_pointer_missing: true },
      });
    }

    // If fallback can't find it, return RPC payload as-is (NO REGRESSION)
    return json(payload ?? { ok: false, error: "NOT_REGISTERED" }, 200);
  }

  // ---------------------------------------------------------------------------
  // 2) Normal signed URL enrichment (unchanged)
  // ---------------------------------------------------------------------------
  if (!payload || payload.ok !== true) {
    return json(payload ?? { ok: false, error: "RESOLVE_FAILED" }, 200);
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
