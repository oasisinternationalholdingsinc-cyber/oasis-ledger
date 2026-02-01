// supabase/functions/archive-signed-resolution/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/* ============================
   Types
============================ */
type ReqBody = {
  envelope_id: string;
  actor_id?: string;

  // tolerated (no regressions if client sends extra fields)
  trigger?: string;
  is_test?: boolean;
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

    const authHeader =
      req.headers.get("authorization") ?? req.headers.get("Authorization");
    const jwt = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!jwt) {
      return json(
        { ok: false, error: "Auth session missing", request_id: reqId },
        401,
      );
    }

    const body = (await req.json().catch(() => ({}))) as Partial<ReqBody>;
    const envelopeId = body.envelope_id?.trim();

    if (!envelopeId || !isUuid(envelopeId)) {
      return json(
        { ok: false, error: "envelope_id must be a uuid", request_id: reqId },
        400,
      );
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { fetch },
      auth: { persistSession: false },
    });

    /* -------- resolve actor -------- */
    let actorId = body.actor_id?.trim() ?? null;

    if (actorId && !isUuid(actorId)) {
      return json(
        { ok: false, error: "actor_id must be a uuid", request_id: reqId },
        400,
      );
    }

    if (!actorId) {
      const { data, error } = await supabaseAdmin.auth.getUser(jwt);
      if (error) {
        console.error("archive-signed-resolution getUser error:", error);
        return json(
          { ok: false, error: "Unable to resolve actor", request_id: reqId },
          401,
        );
      }
      actorId = data?.user?.id ?? null;
      if (!actorId) {
        return json(
          { ok: false, error: "Unable to resolve actor", request_id: reqId },
          401,
        );
      }
    }

    /* -------- load envelope -------- */
    const { data: env, error: envErr } = await supabaseAdmin
      .from("signature_envelopes")
      .select("id,status,record_id")
      .eq("id", envelopeId)
      .maybeSingle();

    if (envErr) {
      console.error("archive-signed-resolution envelope load error:", envErr);
      return json(
        { ok: false, error: "Envelope lookup failed", request_id: reqId },
        500,
      );
    }

    if (!env) {
      return json(
        { ok: false, error: "Envelope not found", request_id: reqId },
        404,
      );
    }

    if (env.status !== "completed") {
      return json(
        {
          ok: false,
          error: "Envelope not completed",
          status: env.status,
          request_id: reqId,
        },
        400,
      );
    }

    const ledgerId = env.record_id?.toString?.() ?? null;
    if (!ledgerId || !isUuid(ledgerId)) {
      return json(
        {
          ok: false,
          error: "Envelope record_id invalid",
          record_id: ledgerId,
          request_id: reqId,
        },
        500,
      );
    }

    /* ============================================================
       ✅ OPTION A (ENTERPRISE): CERTIFY FIRST (QR + REAL PDF HASH)
       - No regressions: sealer call unchanged
       - Certification is explicit authority and updates verified_documents
    ============================================================ */
    const certRes = await fetch(`${edgeBase}/functions/v1/certify-governance-record`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        "x-client-info": "odp/archive-signed-resolution:certify",
      },
      body: JSON.stringify({
        ledger_id: ledgerId,
        actor_id: actorId,
      }),
    });

    if (!certRes.ok) {
      const t = await certRes.text().catch(() => "");
      console.error("certify-governance-record failed:", certRes.status, t);
      return json(
        {
          ok: false,
          error: "CERTIFY_FAILED",
          status: certRes.status,
          details: t,
          envelope_id: envelopeId,
          ledger_id: ledgerId,
          actor_id: actorId,
          request_id: reqId,
        },
        500,
      );
    }

    /* -------- canonical sealer call (LOCKED) --------
       - No extra args. No p_file_hash. No minute_book assumptions.
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
          envelope_id: envelopeId,
          ledger_id: ledgerId,
          actor_id: actorId,
          request_id: reqId,
        },
        500,
      );
    }

    const row = Array.isArray(r.data) ? r.data[0] : r.data;

    return json({
      ok: true,
      envelope_id: envelopeId,
      ledger_id: ledgerId,
      actor_id: actorId,
      result: row ?? null,
      request_id: reqId,
    });
  } catch (e) {
    console.error("archive-signed-resolution fatal:", e);
    return json(
      {
        ok: false,
        error: "ARCHIVE_SIGNED_FATAL",
        message: String((e as any)?.message ?? e),
        request_id: reqId,
      },
      500,
    );
  }
});
