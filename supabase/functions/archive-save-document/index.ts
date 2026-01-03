import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  ledger_id?: string;
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

serve(async (req) => {
  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST")
      return json({ ok: false, error: "POST required" }, 405);

    // Auth header must be present so we can resolve actor_id
    const authHeader = req.headers.get("authorization") ?? "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) {
      return json({ ok: false, error: "Auth session missing!" }, 401);
    }

    const body = (await req.json().catch(() => ({}))) as ReqBody;
    const ledger_id = body.ledger_id?.trim();
    if (!ledger_id) return json({ ok: false, error: "ledger_id required" }, 400);

    // Service-role client for RPC + writes
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { fetch },
      auth: { persistSession: false },
    });

    // Resolve actor from the incoming JWT (so supporting_documents uploaded_by/owner_id is valid)
    const authed = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { fetch, headers: { authorization: authHeader } },
      auth: { persistSession: false },
    });

    const { data: userData, error: userErr } = await authed.auth.getUser();
    if (userErr || !userData?.user?.id) {
      return json(
        { ok: false, error: "Auth session missing!", details: userErr?.message },
        401,
      );
    }
    const actor_id = userData.user.id;

    // ✅ IMPORTANT: call the API wrapper that matches your DB signature
    // public.seal_governance_record_for_archive_api(p_ledger_id uuid, p_actor_id uuid) returns jsonb
    const { data, error } = await admin.rpc("seal_governance_record_for_archive_api", {
      p_ledger_id: ledger_id,
      p_actor_id: actor_id,
    });

    if (error) {
      return json(
        {
          ok: false,
          error: error.message,
          details: { code: error.code, hint: error.hint, details: error.details },
        },
        500,
      );
    }

    return json({ ok: true, ...data }, 200);
  } catch (e) {
    return json(
      { ok: false, error: "archive-save-document failed", details: String(e) },
      500,
    );
  }
});
