import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  verified_document_id?: string;
  envelope_id?: string;
  ledger_id?: string;
  hash?: string;
  // optional override (defaults to 120)
  expires_in?: number;
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
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

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

function safeFileName(title: string | null | undefined): string {
  const base =
    (title ?? "Oasis-Verified-Document")
      .replace(/["']/g, "")
      .replace(/[^a-zA-Z0-9\- ]/g, "")
      .trim()
      .replace(/\s+/g, "-") || "Oasis-Verified-Document";
  return `${base}.pdf`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });

  if (req.method !== "POST") {
    return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
  }

  try {
    const body = (await req.json().catch(() => ({}))) as ReqBody;

    const expiresIn = Math.max(
      30,
      Math.min(600, Number(body.expires_in ?? 120)),
    );

    const verifiedDocId = body.verified_document_id?.trim() || null;
    const envelopeId = body.envelope_id?.trim() || null;
    const ledgerId = body.ledger_id?.trim() || null;
    const hash = body.hash?.trim() || null;

    if (!verifiedDocId && !envelopeId && !ledgerId && !hash) {
      return json(
        {
          ok: false,
          error: "MISSING_INPUT",
          message:
            "Provide one of: verified_document_id, envelope_id, ledger_id, hash.",
        },
        400,
      );
    }

    // ------------------------------------------------------------
    // A) Resolve to verified_documents row (NO DRIFT):
    // - If verified_document_id provided, fetch directly.
    // - Else call your canonical SQL: public.resolve_verified_record(...)
    //   then use returned verified.storage_bucket/storage_path/hash.
    // ------------------------------------------------------------

    let bucket: string | null = null;
    let path: string | null = null;
    let fileHash: string | null = null;
    let title: string | null = null;
    let resolvedVerifiedId: string | null = verifiedDocId;

    if (verifiedDocId) {
      const { data: vd, error } = await supabase
        .from("verified_documents")
        .select("id, storage_bucket, storage_path, file_hash, title, source_record_id")
        .eq("id", verifiedDocId)
        .maybeSingle();

      if (error) {
        return json(
          { ok: false, error: "VERIFIED_DOC_LOOKUP_FAILED", message: error.message },
          500,
        );
      }
      if (!vd) return json({ ok: false, error: "NOT_REGISTERED" }, 404);

      bucket = vd.storage_bucket;
      path = vd.storage_path;
      fileHash = vd.file_hash ?? null;
      title = vd.title ?? null;
      resolvedVerifiedId = vd.id;
    } else {
      // Call canonical SQL resolver (SECURITY DEFINER, already correct)
      const { data, error } = await supabase.rpc("resolve_verified_record", {
        p_hash: hash,
        p_envelope_id: envelopeId,
        p_ledger_id: ledgerId,
      });

      if (error) {
        return json(
          { ok: false, error: "RESOLVE_FAILED", message: error.message },
          500,
        );
      }

      const payload = data as any;
      if (!payload?.ok) {
        return json(
          { ok: false, error: payload?.error ?? "NOT_REGISTERED", message: payload?.message },
          404,
        );
      }

      resolvedVerifiedId = String(payload.verified_document_id ?? "");
      fileHash = payload.hash ?? null;
      title = payload?.ledger?.title ?? null;

      // IMPORTANT: use VERIFIED registry pointers (certified archive), not public_pdf
      bucket = payload?.verified?.storage_bucket ?? null;
      path = payload?.verified?.storage_path ?? null;

      if (!bucket || !path) {
        return json(
          {
            ok: false,
            error: "MISSING_VERIFIED_POINTERS",
            message:
              "Resolver returned ok=true but verified.storage_bucket/path missing.",
          },
          500,
        );
      }
    }

    if (!bucket || !path || !resolvedVerifiedId) {
      return json(
        {
          ok: false,
          error: "INTERNAL_POINTERS_MISSING",
          message: "Could not resolve verified document storage pointers.",
        },
        500,
      );
    }

    // ------------------------------------------------------------
    // B) Create signed URLs
    // view: inline (iframe)
    // download: forces filename
    // ------------------------------------------------------------
    const filename = safeFileName(title);

    const { data: viewData, error: viewErr } = await supabase.storage
      .from(bucket)
      .createSignedUrl(path, expiresIn);

    if (viewErr || !viewData?.signedUrl) {
      return json(
        {
          ok: false,
          error: "SIGNED_URL_FAILED",
          message: viewErr?.message ?? "No signedUrl returned",
        },
        500,
      );
    }

    const { data: dlData, error: dlErr } = await supabase.storage
      .from(bucket)
      .createSignedUrl(path, expiresIn, { download: filename });

    if (dlErr || !dlData?.signedUrl) {
      return json(
        {
          ok: false,
          error: "SIGNED_URL_DOWNLOAD_FAILED",
          message: dlErr?.message ?? "No signedUrl returned",
        },
        500,
      );
    }

    return json({
      ok: true,
      verified_document_id: resolvedVerifiedId,
      hash: fileHash,
      expires_in: expiresIn,
      urls: {
        view: viewData.signedUrl,
        download: dlData.signedUrl,
      },
      // optional but useful for debugging (remove if you want)
      storage: { bucket, path },
    });
  } catch (err) {
    return json(
      {
        ok: false,
        error: "UNEXPECTED_ERROR",
        message: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});
