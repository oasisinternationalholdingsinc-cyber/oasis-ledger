import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  ledger_id?: string; // canonical
  record_id?: string; // backward compat
  actor_id?: string;  // optional override (normally derived from auth session)
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
const SUPABASE_ANON_KEY =
  Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_ANON_PUBLIC_KEY")!;

const SEAL_API_RPC = "seal_governance_record_for_archive_api";

serve(async (req) => {
  try {
    // Preflight
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

    // Must be POST for mutations
    if (req.method !== "POST") {
      return json({ ok: false, error: "POST required" }, 405);
    }

    // Parse body
    let body: ReqBody = {};
    try {
      body = (await req.json()) as ReqBody;
    } catch {
      body = {};
    }

    const ledgerId = body.ledger_id ?? body.record_id;
    if (!ledgerId) return json({ ok: false, error: "ledger_id required" }, 400);

    // Auth: require a real session
    const authHeader = req.headers.get("authorization") ?? "";
    if (!authHeader) return json({ ok: false, error: "Auth session missing!" }, 401);

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: {
        fetch,
        headers: {
          Authorization: authHeader,
          apikey: req.headers.get("apikey") ?? SUPABASE_ANON_KEY,
        },
      },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });

    // Resolve actor
    let actorId = body.actor_id ?? null;

    if (!actorId) {
      const { data: userData, error: userErr } = await userClient.auth.getUser();
      if (userErr || !userData?.user?.id) {
        return json(
          { ok: false, error: "Auth session missing!", details: userErr?.message ?? null },
          401,
        );
      }
      actorId = userData.user.id;
    }

    // Call the stable API wrapper (SECURITY DEFINER JSON wrapper)
    const { data, error } = await userClient.rpc(SEAL_API_RPC, {
      p_ledger_id: ledgerId,
      p_actor_id: actorId,
    });

    if (error) {
      return json(
        {
          ok: false,
          error: error.message ?? "seal failed",
          details: {
            code: error.code ?? null,
            hint: (error as any).hint ?? null,
            details: (error as any).details ?? null,
          },
        },
        500,
      );
    }

    // data is jsonb from the wrapper
    return json(data ?? { ok: true }, 200);
  } catch (e) {
    return json(
      {
        ok: false,
        error: "archive-save-document failed",
        details: String(e?.message ?? e),
      },
      500,
    );
  }
});
