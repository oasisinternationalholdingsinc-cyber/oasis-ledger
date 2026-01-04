// supabase/functions/resolve-verified-record/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  hash?: string | null;
  envelope_id?: string | null;
  ledger_id?: string | null;

  ensure_archive?: boolean;
  expires_in?: number;
  mode?: "viewer" | "download";
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
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

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

async function objectExists(bucket: string, path: string) {
  // storage.objects is not always readable from SQL clients, but Storage API is authoritative.
  const { data, error } = await supabaseAdmin.storage.from(bucket).download(path);
  if (!error && data) return { ok: true as const };
  return { ok: false as const, error: error?.message ?? "download failed" };
}

async function signUrl(bucket: string, path: string, expiresIn: number) {
  const { data, error } = await supabaseAdmin.storage
    .from(bucket)
    .createSignedUrl(path, expiresIn);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}

async function copyObject(fromBucket: string, fromPath: string, toBucket: string, toPath: string) {
  const { data: blob, error: dlErr } = await supabaseAdmin.storage
    .from(fromBucket)
    .download(fromPath);
  if (dlErr || !blob) throw new Error(dlErr?.message ?? "download failed");

  // Upload copy (upsert so idempotent)
  const { error: upErr } = await supabaseAdmin.storage
    .from(toBucket)
    .upload(toPath, blob, {
      contentType: "application/pdf",
      upsert: true,
    });

  if (upErr) throw new Error(upErr.message);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });

  try {
    const body: ReqBody = req.method === "GET"
      ? {
          hash: new URL(req.url).searchParams.get("hash"),
          envelope_id: new URL(req.url).searchParams.get("envelope_id"),
          ledger_id: new URL(req.url).searchParams.get("ledger_id"),
          ensure_archive: (new URL(req.url).searchParams.get("ensure_archive") ?? "true") !== "false",
          expires_in: Number(new URL(req.url).searchParams.get("expires_in") ?? "600"),
          mode: (new URL(req.url).searchParams.get("mode") as any) ?? "viewer",
        }
      : await req.json().catch(() => ({} as ReqBody));

    const ensureArchive = body.ensure_archive !== false;
    const expiresIn = Number.isFinite(body.expires_in) ? Math.max(60, Number(body.expires_in)) : 600;

    // 1) Call your canonical SQL resolver (SECURITY DEFINER)
    const { data: resolved, error: rpcErr } = await supabaseAdmin.rpc(
      "resolve_verified_record",
      {
        p_hash: body.hash ?? null,
        p_envelope_id: body.envelope_id ? body.envelope_id : null,
        p_ledger_id: body.ledger_id ? body.ledger_id : null,
      },
    );

    if (rpcErr) return json({ ok: false, error: "RPC_FAILED", message: rpcErr.message }, 500);
    if (!resolved || resolved.ok !== true) return json(resolved ?? { ok: false, error: "NOT_REGISTERED" }, 404);

    // 2) Extract pointers
    const publicPdf = resolved.public_pdf;   // minute_book pointer (private)
    const verified = resolved.verified;      // certified registry pointer (governance_*)

    if (!publicPdf?.storage_bucket || !publicPdf?.storage_path) {
      return json({
        ok: false,
        error: "PUBLIC_PDF_MISSING",
        message: "Resolver returned ok=true but public_pdf pointer was missing.",
        resolved,
      }, 500);
    }

    if (!verified?.storage_bucket || !verified?.storage_path) {
      return json({
        ok: false,
        error: "VERIFIED_POINTER_MISSING",
        message: "Resolver returned ok=true but verified pointer was missing.",
        resolved,
      }, 500);
    }

    // 3) Ensure certified archive exists (copy from minute_book if missing)
    if (ensureArchive) {
      const exists = await objectExists(verified.storage_bucket, verified.storage_path);
      if (!exists.ok) {
        // Copy the signed minute_book PDF as the certified archive artifact (idempotent)
        await copyObject(
          publicPdf.storage_bucket,
          publicPdf.storage_path,
          verified.storage_bucket,
          verified.storage_path,
        );
      }
    }

    // 4) Signed URLs (what verify.html uses)
    const verifiedUrl = await signUrl(verified.storage_bucket, verified.storage_path, expiresIn);
    const publicUrl = await signUrl(publicPdf.storage_bucket, publicPdf.storage_path, expiresIn);

    return json({
      ...resolved,
      urls: {
        verified_pdf_url: verifiedUrl,
        public_pdf_url: publicUrl,
      },
    });
  } catch (err) {
    return json({
      ok: false,
      error: "UNEXPECTED_ERROR",
      message: err instanceof Error ? err.message : String(err),
    }, 500);
  }
});
