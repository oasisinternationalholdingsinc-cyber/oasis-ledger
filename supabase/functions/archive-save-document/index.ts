// supabase/functions/archive-save-document/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/* ============================
   Types
============================ */
type ReqBody = {
  ledger_id?: string;
  record_id?: string;

  // Optional override (normally resolved from JWT)
  actor_id?: string;

  // tolerated (no regressions if clients send extra fields)
  is_test?: boolean;
  trigger?: string;
};

/* ============================
   CORS / helpers
============================ */
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
};

const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
}

const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    s,
  );

// Normalize base URL for Edge Functions calls (works whether SUPABASE_URL ends with /rest/v1 or not)
const edgeBase = SUPABASE_URL.replace(/\/rest\/v1\/?$/, "");

/* ============================
   MAIN
============================ */
serve(async (req) => {
  const reqId = req.headers.get("x-sb-request-id") ?? null;

  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") {
      return json({ ok: false, error: "POST only", request_id: reqId }, 405);
    }

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

    if (!jwt) {
      return json({ ok: false, error: "Auth required", request_id: reqId }, 401);
    }

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
      const { data, error } = await supabaseAdmin.auth.getUser(jwt);
      if (error) {
        console.error("archive-save-document getUser error:", error);
        return json(
          { ok: false, error: "Actor unresolved", request_id: reqId },
          401,
        );
      }
      actorId = data?.user?.id ?? null;
      if (!actorId) {
        return json(
          { ok: false, error: "Actor unresolved", request_id: reqId },
          401,
        );
      }
    }

    /* ============================================================
       ✅ OPTION A (ENTERPRISE): CERTIFY FIRST (QR + REAL PDF HASH)
       - No regressions: sealer call unchanged
       - Certification is explicit authority; it creates/updates verified_documents
       - Uses service_role to call internal Edge Function (no UI dependency)
    ============================================================ */
    const certRes = await fetch(
      `${edgeBase}/functions/v1/certify-governance-record`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          "x-client-info": "odp/archive-save-document:certify",
        },
        body: JSON.stringify({
          ledger_id: ledgerId,
          actor_id: actorId,
        }),
      },
    );

    if (!certRes.ok) {
      const t = await certRes.text().catch(() => "");
      console.error("certify-governance-record failed:", certRes.status, t);
      return json(
        {
          ok: false,
          error: "CERTIFY_FAILED",
          status: certRes.status,
          details: t,
          ledger_id: ledgerId,
          actor_id: actorId,
          request_id: reqId,
        },
        500,
      );
    }

    /* -------- canonical sealer call (LOCKED) --------
       IMPORTANT:
       - DO NOT pass extra params (no p_file_hash, no drift).
       - Sealer remains source of truth for linking + minute_book pointers + status.
    */
    const rpcArgs = {
      p_actor_id: actorId,
      p_ledger_id: ledgerId,
    };

    const r = await supabaseAdmin.rpc("seal_governance_record_for_archive", rpcArgs);

    if (r.error) {
      console.error("seal_governance_record_for_archive error:", r.error);
      return json(
        {
          ok: false,
          error: r.error.message ?? String(r.error),
          ledger_id: ledgerId,
          actor_id: actorId,
          request_id: reqId,
        },
        500,
      );
    }

    const row = Array.isArray(r.data) ? r.data[0] : r.data;

    // Return sealer output directly (enterprise, no invented pointers)
    return json({
      ok: true,
      ledger_id: ledgerId,
      actor_id: actorId,
      result: row ?? null,
      request_id: reqId,
    });
  } catch (e) {
    console.error("archive-save-document fatal:", e);
    return json(
      {
        ok: false,
        error: "ARCHIVE_SAVE_FATAL",
        message: String((e as any)?.message ?? e),
        request_id: reqId,
      },
      500,
    );
  }
});
