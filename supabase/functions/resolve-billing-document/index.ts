// supabase/functions/resolve-billing-document/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * resolve-billing-document (PRODUCTION — LOCKED)
 * ✅ hash-first resolver (file_hash)
 * ✅ tolerant identifiers (document_id/id)
 * ✅ service_role signs URLs (private buckets OK)
 * ✅ NO REGRESSION: preserves existing response shape
 * ✅ adds OPTIONAL certified support (prefer_certified + urls.certified_pdf)
 */

type ReqBody = {
  // preferred
  hash?: string | null;
  file_hash?: string | null;

  // fallback
  document_id?: string | null;
  id?: string | null;

  // tolerated extras (non-breaking)
  is_test?: boolean | null;
  entity_id?: string | null;
  trigger?: string | null;

  // optional enhancements (non-breaking)
  expires_in?: number | null; // seconds
  prefer_certified?: boolean | null;
};

type Resp =
  | {
      ok: true;
      document_id: string;
      file_hash: string;
      entity_id: string | null;
      is_test: boolean | null;

      // tolerate schema drift (UI can ignore)
      title: string | null;
      document_kind: string | null;
      currency: string | null;
      amount_cents: number | null;

      storage: { bucket: string; path: string };

      urls: {
        pdf: string; // signed url (source OR certified depending on prefer_certified)
        certified_pdf?: string | null; // signed url (if certified pointers exist)
        source_pdf?: string | null; // signed url (source pointer)
      };

      created_at?: string | null;
      issued_at?: string | null;

      // optional pointers (handy for UI)
      certified_storage?: { bucket: string; path: string } | null;
      certified_file_hash?: string | null;
    }
  | {
      ok: false;
      error: "MISSING_IDENTIFIER" | "NOT_REGISTERED" | "STORAGE_POINTER_MISSING" | "FAILED";
      details?: string;
      status?: number;
      request_id?: string | null;
    };

/* -----------------------------
   CORS
----------------------------- */
const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
};

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...cors, "content-type": "application/json; charset=utf-8" },
  });
}

function pickHash(b: ReqBody) {
  const h = (b.hash ?? b.file_hash ?? "").toString().trim();
  return h || null;
}
function pickId(b: ReqBody) {
  const id = (b.document_id ?? b.id ?? "").toString().trim();
  return id || null;
}

function cleanPath(p: string) {
  // storage paths must NOT start with "/"
  const s = (p ?? "").toString().trim();
  return s.replace(/^\/+/, "");
}

function clampExpiresInSeconds(v: any) {
  const n = Number(v);
  // allow 60s .. 14 days
  if (!Number.isFinite(n)) return 60 * 10; // default 10 min
  return Math.max(60, Math.min(60 * 60 * 24 * 14, Math.floor(n)));
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
}

// service_role client (internal read + signed urls)
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
  auth: { persistSession: false },
});

async function sign(bucket: string, path: string, expiresIn: number) {
  const b = (bucket ?? "").toString().trim();
  const p = cleanPath(path ?? "");
  if (!b || !p) return { signedUrl: null as string | null, error: "missing pointer" };

  const { data, error } = await supabase.storage.from(b).createSignedUrl(p, expiresIn);
  if (error || !data?.signedUrl) return { signedUrl: null as string | null, error: error?.message || "sign failed" };
  return { signedUrl: data.signedUrl, error: null as string | null };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const request_id = req.headers.get("x-sb-request-id");

  if (req.method !== "POST") {
    return json(
      { ok: false, error: "FAILED", details: "Method not allowed", status: 405, request_id } satisfies Resp,
      405,
    );
  }

  let body: ReqBody = {};
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    body = {};
  }

  const hash = pickHash(body);
  const docId = pickId(body);
  const expiresIn = clampExpiresInSeconds(body.expires_in);
  const preferCertified = Boolean(body.prefer_certified);

  if (!hash && !docId) {
    return json(
      {
        ok: false,
        error: "MISSING_IDENTIFIER",
        details: "Provide {hash} or {document_id}.",
        status: 400,
        request_id,
      } satisfies Resp,
      400,
    );
  }

  try {
    // -----------------------------
    // Resolve billing_documents row (hash-first)
    // -----------------------------
    let row: any = null;

    if (hash) {
      const { data, error } = await supabase
        .from("billing_documents")
        .select("*")
        .eq("file_hash", hash)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw error;
      row = data;
    }

    if (!row && docId) {
      const { data, error } = await supabase.from("billing_documents").select("*").eq("id", docId).maybeSingle();
      if (error) throw error;
      row = data;
    }

    if (!row) {
      return json(
        {
          ok: false,
          error: "NOT_REGISTERED",
          details: "No billing document found for identifier.",
          status: 404,
          request_id,
        } satisfies Resp,
        404,
      );
    }

    const srcBucket = (row.storage_bucket ?? "").toString().trim();
    const srcPath = cleanPath((row.storage_path ?? "").toString().trim());

    if (!srcBucket || !srcPath) {
      return json(
        {
          ok: false,
          error: "STORAGE_POINTER_MISSING",
          details: "billing_documents row exists but storage pointer is missing.",
          status: 409,
          request_id,
        } satisfies Resp,
        409,
      );
    }

    // certified pointers (optional)
    const certBucket = (row.certified_storage_bucket ?? "").toString().trim();
    const certPath = cleanPath((row.certified_storage_path ?? "").toString().trim());
    const hasCertifiedPointer = Boolean(certBucket && certPath);

    // -----------------------------
    // Signed URLs
    // -----------------------------
    const srcSigned = await sign(srcBucket, srcPath, expiresIn);
    if (!srcSigned.signedUrl) {
      return json(
        {
          ok: false,
          error: "FAILED",
          details: srcSigned.error || "Failed to sign source URL.",
          status: 500,
          request_id,
        } satisfies Resp,
        500,
      );
    }

    let certSignedUrl: string | null = null;
    if (hasCertifiedPointer) {
      const certSigned = await sign(certBucket, certPath, expiresIn);
      certSignedUrl = certSigned.signedUrl;
      // NOTE: if certified pointer exists but signing fails, we do NOT fail the resolver.
      // We still return the source PDF to avoid regressions.
    }

    // decide primary pdf url
    const primaryPdf = preferCertified && certSignedUrl ? certSignedUrl : srcSigned.signedUrl;

    const resp: Resp = {
      ok: true,
      document_id: row.id,
      file_hash: row.file_hash,
      entity_id: row.entity_id ?? row.provider_entity_id ?? null,
      is_test: row.is_test ?? null,

      // tolerate drift
      title: row.title ?? row.document_type ?? null,
      document_kind: row.document_kind ?? row.document_type ?? row.kind ?? null,
      currency: row.currency ?? null,
      amount_cents: row.amount_cents ?? row.total_cents ?? null,

      storage: { bucket: srcBucket, path: srcPath },

      urls: {
        pdf: primaryPdf,
        source_pdf: srcSigned.signedUrl,
        certified_pdf: certSignedUrl,
      },

      created_at: row.created_at ?? null,
      issued_at: row.issued_at ?? row.period_start ?? null,

      certified_storage: hasCertifiedPointer ? { bucket: certBucket, path: certPath } : null,
      certified_file_hash: row.certified_file_hash ?? null,
    };

    return json(resp, 200);
  } catch (e: any) {
    return json(
      {
        ok: false,
        error: "FAILED",
        details: e?.message || "Unknown failure",
        status: 500,
        request_id,
      } satisfies Resp,
      500,
    );
  }
});
