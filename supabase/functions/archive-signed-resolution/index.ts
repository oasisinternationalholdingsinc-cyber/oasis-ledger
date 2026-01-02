import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
};

const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

type ReqBody = {
  envelope_id: string; // signature_envelopes.id
};

// service_role for DB writes, but preserve user's JWT for auth.getUser
function serviceClient(req: Request) {
  const authHeader = req.headers.get("authorization") ?? "";
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { authorization: authHeader } },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  try {
    const supabase = serviceClient(req);
    const body = (await req.json()) as Partial<ReqBody>;
    const envelopeId = String(body.envelope_id ?? "").trim();
    if (!envelopeId) return json({ ok: false, error: "envelope_id required" }, 400);

    // 1) Load envelope, ensure completed, read ledger_id from record_id
    const { data: env, error: envErr } = await supabase
      .from("signature_envelopes")
      .select("id,record_id,status,completed_at")
      .eq("id", envelopeId)
      .maybeSingle();

    if (envErr || !env) {
      return json({ ok: false, error: "envelope not found", details: envErr }, 404);
    }

    if (String(env.status) !== "completed") {
      return json(
        {
          ok: false,
          error: "Envelope not completed",
          details: { status: env.status, completed_at: env.completed_at ?? null },
        },
        400,
      );
    }

    const recordId = String(env.record_id ?? "").trim();
    if (!recordId) {
      return json({ ok: false, error: "Envelope missing record_id (ledger id)" }, 500);
    }

    // 2) Delegate to archive-save-document (same behavior as Re-Seal/Repair)
    //    Call it internally via RPC? easiest: direct HTTP call to same edge runtime:
    const url = new URL(req.url);
    url.pathname = "/functions/v1/archive-save-document";

    const resp = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // preserve the caller auth header for actor user resolution
        authorization: req.headers.get("authorization") ?? "",
        apikey: req.headers.get("apikey") ?? "",
      },
      body: JSON.stringify({ record_id: recordId }),
    });

    const out = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      return json(
        { ok: false, error: "archive-save-document failed", details: out ?? null },
        500,
      );
    }

    return json({
      ok: true,
      envelope_id: envelopeId,
      record_id: recordId,
      delegated: true,
      result: out,
    });
  } catch (e) {
    return json(
      {
        ok: false,
        error: "archive-signed-resolution failed",
        details: { message: String((e as any)?.message ?? e), raw: e ?? null },
      },
      500,
    );
  }
});
