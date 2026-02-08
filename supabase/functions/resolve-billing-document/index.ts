import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  hash?: string;        // file_hash (sha256 hex) — preferred
  file_hash?: string;   // alias
  document_id?: string; // uuid — fallback
  id?: string;          // alias

  // tolerated (no regressions if clients send extra fields)
  is_test?: boolean;
  entity_id?: string;
  trigger?: string;
};

type Resp =
  | {
      ok: true;
      document_id: string;
      file_hash: string;
      entity_id: string | null;
      is_test: boolean | null;

      title: string | null;
      document_kind: string | null; // invoice / receipt / etc (enum text)
      currency: string | null;
      amount_cents: number | null;

      storage: {
        bucket: string;
        path: string;
      };

      urls: {
        pdf: string; // signed url
      };

      // optional: useful for UI
      created_at?: string | null;
      issued_at?: string | null;
    }
  | {
      ok: false;
      error:
        | "MISSING_IDENTIFIER"
        | "NOT_REGISTERED"
        | "STORAGE_POINTER_MISSING"
        | "FAILED";
      details?: string;
      status?: number;
      request_id?: string | null;
    };

/* -----------------------------
   CORS
----------------------------- */
const cors = {
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
  const h = (b.hash ?? b.file_hash ?? "").trim();
  return h || null;
}
function pickId(b: ReqBody) {
  const id = (b.document_id ?? b.id ?? "").trim();
  return id || null;
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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const request_id = req.headers.get("x-sb-request-id");

  if (req.method !== "POST") {
    return json(
      { ok: false, error: "FAILED", details: "Method not allowed", status: 405, request_id } satisfies Resp,
      405
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

  if (!hash && !docId) {
    return json(
      { ok: false, error: "MISSING_IDENTIFIER", details: "Provide {hash} or {document_id}.", status: 400, request_id } satisfies Resp,
      400
    );
  }

  try {
    // -----------------------------
    // Resolve billing_documents row
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
      const { data, error } = await supabase
        .from("billing_documents")
        .select("*")
        .eq("id", docId)
        .maybeSingle();

      if (error) throw error;
      row = data;
    }

    if (!row) {
      return json(
        { ok: false, error: "NOT_REGISTERED", details: "No billing document found for identifier.", status: 404, request_id } satisfies Resp,
        404
      );
    }

    const bucket = (row.storage_bucket ?? "").toString().trim();
    const path = (row.storage_path ?? "").toString().trim();

    if (!bucket || !path) {
      return json(
        {
          ok: false,
          error: "STORAGE_POINTER_MISSING",
          details: "billing_documents row exists but storage pointer is missing.",
          status: 409,
          request_id,
        } satisfies Resp,
        409
      );
    }

    // -----------------------------
    // Signed URL (PDF)
    // -----------------------------
    const expiresIn = 60 * 10; // 10 min
    const { data: signed, error: signErr } = await supabase.storage.from(bucket).createSignedUrl(path, expiresIn);
    if (signErr || !signed?.signedUrl) {
      return json(
        { ok: false, error: "FAILED", details: signErr?.message || "Failed to sign URL.", status: 500, request_id } satisfies Resp,
        500
      );
    }

    const resp: Resp = {
      ok: true,
      document_id: row.id,
      file_hash: row.file_hash,
      entity_id: row.entity_id ?? null,
      is_test: row.is_test ?? null,
      title: row.title ?? null,
      document_kind: row.document_kind ?? row.kind ?? null,
      currency: row.currency ?? null,
      amount_cents: row.amount_cents ?? row.total_cents ?? null,
      storage: { bucket, path },
      urls: { pdf: signed.signedUrl },
      created_at: row.created_at ?? null,
      issued_at: row.issued_at ?? row.period_start ?? null,
    };

    return json(resp, 200);
  } catch (e: any) {
    return json(
      { ok: false, error: "FAILED", details: e?.message || "Unknown failure", status: 500, request_id } satisfies Resp,
      500
    );
  }
});
