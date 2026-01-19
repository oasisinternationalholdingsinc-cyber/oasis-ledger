import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/* ============================
   Types
============================ */
type ReqBody = {
  ledger_id?: string;
  record_id?: string;
  actor_id?: string;
};

/* ============================
   CORS / helpers
============================ */
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
  Deno.env.get("SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ✅ Needed so the RPC can run with a real auth.uid() when your SQL uses auth.uid()
// (prevents supporting_documents.owner_id = null failures when calling via service_role)
const ANON_KEY =
  Deno.env.get("SUPABASE_ANON_KEY") ??
  Deno.env.get("SUPABASE_ANON_PUBLIC_KEY") ??
  Deno.env.get("ANON_KEY") ??
  null;

const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(s);

/* ============================
   🔐 SHA-256 helper
============================ */
async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* ============================
   MAIN
============================ */
serve(async (req) => {
  const reqId = req.headers.get("x-sb-request-id") ?? null;

  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST")
      return json({ ok: false, error: "POST only", request_id: reqId }, 405);

    const body = (await req.json().catch(() => ({}))) as ReqBody;

    const ledgerId = (body.ledger_id ?? body.record_id)?.trim();
    if (!ledgerId || !isUuid(ledgerId)) {
      return json(
        { ok: false, error: "ledger_id must be uuid", request_id: reqId },
        400,
      );
    }

    const authHeader =
      req.headers.get("authorization") ?? req.headers.get("Authorization");
    const jwt = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { fetch },
      auth: { persistSession: false },
    });

    /* -------- resolve actor -------- */
    let actorId = body.actor_id?.trim() ?? null;

    if (actorId && !isUuid(actorId)) {
      return json(
        { ok: false, error: "actor_id must be uuid", request_id: reqId },
        400,
      );
    }

    if (!actorId) {
      if (!jwt) {
        return json(
          { ok: false, error: "Auth required", request_id: reqId },
          401,
        );
      }
      const { data } = await supabaseAdmin.auth.getUser(jwt);
      actorId = data?.user?.id ?? null;
      if (!actorId) {
        return json(
          { ok: false, error: "Actor unresolved", request_id: reqId },
          401,
        );
      }
    }

    /* -------- load minute book entry -------- */
    const { data: mbe } = await supabaseAdmin
      .from("minute_book_entries")
      .select("id, storage_path, pdf_hash")
      .eq("source_record_id", ledgerId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let fileHash = mbe?.pdf_hash ?? null;

    /* -------- compute hash ONLY if missing -------- */
    if (!fileHash && mbe?.storage_path) {
      const { data: pdf } = await supabaseAdmin.storage
        .from("minute_book")
        .download(mbe.storage_path);

      if (pdf) fileHash = await sha256Hex(pdf);
    }

    /* -------- canonical sealer call (NO REGRESSION) --------
       IMPORTANT FIX:
       Try calling RPC as the *user* (auth.uid() present) to avoid
       supporting_documents.owner_id NOT NULL failures when SQL uses auth.uid().
       Fallback to service_role RPC only if needed.
    */
    const rpcArgs: Record<string, unknown> = {
      p_actor_id: actorId,
      p_ledger_id: ledgerId,
    };
    if (fileHash) rpcArgs.p_file_hash = fileHash;

    let data: any = null;
    let error: any = null;

    // Attempt as authenticated user (auth.uid() = actor)
    if (jwt && ANON_KEY) {
      const supabaseUser = createClient(SUPABASE_URL, ANON_KEY, {
        global: { fetch, headers: { Authorization: `Bearer ${jwt}` } },
        auth: { persistSession: false },
      });

      const r1 = await supabaseUser.rpc("seal_governance_record_for_archive", rpcArgs);
      data = r1.data;
      error = r1.error;
    }

    // Fallback to admin RPC if anon key missing or user RPC failed for permission reasons
    if (error || !data) {
      const r2 = await supabaseAdmin.rpc("seal_governance_record_for_archive", rpcArgs);
      data = r2.data;
      error = r2.error;
    }

    if (error) {
      return json(
        { ok: false, error: error.message ?? String(error), request_id: reqId },
        500,
      );
    }

    const row = Array.isArray(data) ? data[0] : data;

    return json({
      ok: true,
      ledger_id: ledgerId,
      actor_id: actorId,

      /* PRIMARY POINTERS — unchanged */
      storage_bucket: "minute_book",
      storage_path: row?.storage_path ?? mbe?.storage_path ?? null,

      /* Hash */
      file_hash: fileHash ?? row?.file_hash ?? null,

      minute_book_entry_id: row?.minute_book_entry_id ?? mbe?.id ?? null,
      verified_document_id: row?.verified_document_id ?? null,

      request_id: reqId,
    });
  } catch (e) {
    return json(
      {
        ok: false,
        error: "archive-save-document failed",
        details: String(e),
        request_id: reqId,
      },
      500,
    );
  }
});
