// supabase/functions/archive-save-document/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  ledger_id: string;
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const { ledger_id } = (await req.json()) as ReqBody;
    if (!ledger_id) {
      return json({ ok: false, error: "ledger_id required" }, 400);
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE_KEY =
      Deno.env.get("SERVICE_ROLE_KEY") ??
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // 🔐 Service role client
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { fetch },
      auth: { persistSession: false },
    });

    // 👤 Resolve actor from caller JWT
    const userClient = createClient(
      SUPABASE_URL,
      req.headers.get("authorization") ?? "",
      { global: { fetch } }
    );

    const {
      data: { user },
    } = await userClient.auth.getUser();

    if (!user?.id) {
      throw new Error("Actor could not be resolved (auth required)");
    }

    // 🧠 Single canonical RPC (idempotent)
    const { data, error } = await admin.rpc(
      "seal_governance_record_for_archive",
      {
        p_ledger_id: ledger_id,
        p_actor_id: user.id,
      }
    );

    if (error) throw error;

    return json({
      ok: true,
      repaired: true,
      result: data,
    });
  } catch (err: any) {
    return json(
      {
        ok: false,
        error: err.message ?? "archive-save-document failed",
      },
      500
    );
  }
});
