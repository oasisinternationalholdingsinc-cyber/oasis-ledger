// supabase/functions/archive-signed-resolution/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  envelope_id?: string;

  // tolerated from Forge / callers
  ledger_id?: string;
  record_id?: string; // alias
  actor_id?: string;

  trigger?: string;
  is_test?: boolean;
};

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
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(s);

const safeText = (v: unknown) => {
  if (v == null) return null;
  const t = String(v).trim();
  return t.length ? t : null;
};

const edgeBase = SUPABASE_URL.replace(/\/rest\/v1\/?$/, "");

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

    const body = (await req.json().catch(() => ({}))) as ReqBody;

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { fetch },
      auth: { persistSession: false },
    });

    // Resolve actor
    let actorId = safeText(body.actor_id);
    if (actorId && !isUuid(actorId)) {
      return json({ ok: false, error: "actor_id must be uuid", request_id: reqId }, 400);
    }
    if (!actorId) {
      const { data, error } = await supabaseAdmin.auth.getUser(jwt);
      if (error || !data?.user?.id) {
        return json({ ok: false, error: "Unable to resolve actor", request_id: reqId }, 401);
      }
      actorId = data.user.id;
    }

    // Resolve ledgerId (prefer body, fallback envelope.record_id)
    let ledgerId = safeText(body.ledger_id ?? body.record_id);
    const envelopeId = safeText(body.envelope_id);

    if (!ledgerId) {
      if (!envelopeId || !isUuid(envelopeId)) {
        return json(
          { ok: false, error: "ledger_id or envelope_id required", request_id: reqId },
          400,
        );
      }

      const env = await supabaseAdmin
        .from("signature_envelopes")
        .select("id, status, record_id")
        .eq("id", envelopeId)
        .maybeSingle();

      if (env.error) {
        return json({ ok: false, error: "Envelope lookup failed", details: env.error, request_id: reqId }, 500);
      }
      if (!env.data?.id) {
        return json({ ok: false, error: "Envelope not found", request_id: reqId }, 404);
      }
      if (String((env.data as any).status).toLowerCase() !== "completed") {
        return json({ ok: false, error: "Envelope not completed", status: (env.data as any).status, request_id: reqId }, 400);
      }

      ledgerId = String((env.data as any).record_id ?? "");
    }

    if (!ledgerId || !isUuid(ledgerId)) {
      return json({ ok: false, error: "ledger_id invalid", ledger_id: ledgerId, request_id: reqId }, 400);
    }

    // ✅ STEP 1: Seal first (creates minute_book_entries pointer, marks archived, links intent)
    const seal = await supabaseAdmin.rpc("seal_governance_record_for_archive", {
      p_actor_id: actorId,
      p_ledger_id: ledgerId,
    });

    if (seal.error) {
      return json(
        {
          ok: false,
          error: "SEAL_FAILED",
          details: seal.error,
          ledger_id: ledgerId,
          envelope_id: envelopeId ?? null,
          actor_id: actorId,
          request_id: reqId,
        },
        500,
      );
    }

    // ✅ STEP 2: Certify using the minute_book pointer created by seal
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
      return json(
        {
          ok: false,
          error: "CERTIFY_FAILED",
          status: certRes.status,
          details: t,
          ledger_id: ledgerId,
          envelope_id: envelopeId ?? null,
          actor_id: actorId,
          request_id: reqId,
        },
        500,
      );
    }

    const certJson = await certRes.json().catch(() => null);

    return json({
      ok: true,
      ledger_id: ledgerId,
      envelope_id: envelopeId ?? null,
      actor_id: actorId,
      sealed: seal.data ?? null,
      certified: certJson ?? null,
      request_id: reqId,
    });
  } catch (e) {
    console.error("archive-signed-resolution fatal:", e);
    return json(
      {
        ok: false,
        error: "ARCHIVE_SIGNED_FATAL",
        details: String((e as any)?.message ?? e),
        request_id: req.headers.get("x-sb-request-id") ?? null,
      },
      500,
    );
  }
});
