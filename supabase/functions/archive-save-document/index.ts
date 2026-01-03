import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  // Support both names forever (UI/back-compat)
  ledger_id?: string;
  record_id?: string; // legacy
};

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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    // 1) Parse body safely
    let body: ReqBody = {};
    try {
      body = (await req.json()) as ReqBody;
    } catch {
      body = {};
    }

    const ledgerId = (body.ledger_id ?? body.record_id ?? "").trim();
    if (!ledgerId) return json({ ok: false, error: "ledger_id required" }, 400);

    // 2) Env
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE_KEY =
      Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return json({ ok: false, error: "Missing SUPABASE_URL or SERVICE_ROLE_KEY" }, 500);
    }

    // 3) Resolve actor from caller JWT (required for supporting_documents uploaded_by/owner_id)
    const authHeader = req.headers.get("authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      global: { fetch },
      auth: { persistSession: false },
      headers: authHeader ? { Authorization: authHeader } : {},
    });

    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr) throw userErr;

    const actorId = userData?.user?.id;
    if (!actorId) {
      return json(
        { ok: false, error: "Actor could not be resolved (auth required)" },
        401
      );
    }

    // 4) Service role RPC call (canonical)
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { fetch },
      auth: { persistSession: false },
    });

    const { data, error } = await admin.rpc("seal_governance_record_for_archive", {
      p_ledger_id: ledgerId,
      p_actor_id: actorId,
    });

    if (error) throw error;

    return json({ ok: true, ledger_id: ledgerId, actor_id: actorId, result: data });
  } catch (err: any) {
    console.error("archive-save-document error", err);
    return json(
      {
        ok: false,
        error: err?.message ?? "archive-save-document failed",
      },
      500
    );
  }
});
