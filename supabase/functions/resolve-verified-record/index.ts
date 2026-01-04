import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  hash?: string | null;
  envelope_id?: string | null;
  ledger_id?: string | null;
  expires_in?: number | null; // seconds
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
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

// Canonical SQL resolver RPC name
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

  if (error) return { url: null, error: error.message };
  return { url: data?.signedUrl ?? null, error: null };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);

  // We accept anon/auth headers from browser, but we do ALL privileged work via service role.
  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
    global: { headers: { "x-client-info": "odp-verify/resolve-verified-record" } },
  });

  let body: ReqBody = {};
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    return json({ ok: false, error: "INVALID_JSON" }, 400);
  }

  const hash = (body.hash ?? null)?.toString().trim() || null;
  const envelope_id = (body.envelope_id ?? null)?.toString().trim() || null;
  const ledger_id = (body.ledger_id ?? null)?.toString().trim() || null;

  const expires_in = Math.max(60, Math.min(3600, Number(body.expires_in ?? 900))); // clamp 1m..60m

  if (!hash && !envelope_id && !ledger_id) {
    return json({ ok: false, error: "MISSING_INPUT", message: "Provide hash OR envelope_id OR ledger_id." }, 400);
  }

  // 1) Call canonical SQL resolver
  const { data: resolved, error: rpcErr } = await supabaseAdmin.rpc(RESOLVE_RPC, {
    p_hash: hash,
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
      },
      500,
    );
  }

  // Your SQL returns jsonb; depending on supabase-js it may come as object already or string.
  let payload: any = resolved;
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch { /* keep string */ }
  }

  if (!payload || payload.ok !== true) {
    // Pass through canonical SQL error (NOT_REGISTERED / OBJECT_NOT_FOUND / etc.)
    return json(payload ?? { ok: false, error: "RESOLVE_FAILED" }, 200);
  }

  // 2) Create signed URLs from returned pointers
  const publicPdf = payload.public_pdf ?? null;
  const verified = payload.verified ?? null;

  let minuteBookUrl: string | null = null;
  let archiveUrl: string | null = null;

  const notes: Record<string, unknown> = {};

  // Minute Book (reader copy)
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

  // Certified archive (registry copy)
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

  // 3) Return payload + urls (what your verify.html expects)
  return json({
    ...payload,
    expires_in,
    urls: {
      minute_book_pdf: minuteBookUrl,
      certified_archive_pdf: archiveUrl,
    },
    notes: Object.keys(notes).length ? notes : undefined,
  });
});
