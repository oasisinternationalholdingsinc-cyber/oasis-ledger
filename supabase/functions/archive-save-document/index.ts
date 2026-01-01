import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/* ---------------------------------------------
   CORS (MANDATORY)
--------------------------------------------- */
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

/* ---------------------------------------------
   Env
--------------------------------------------- */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  global: { fetch },
});

type ReqBody = {
  record_id: string; // governance_ledger.id
  trigger?: string;  // optional (for logs)
};

serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  let body: ReqBody;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const record_id = body?.record_id?.trim();
  if (!record_id) {
    return json({ ok: false, error: "record_id is required" }, 400);
  }

  try {
    const { data, error } = await supabase.rpc(
      "seal_governance_record_for_archive",
      { p_ledger_id: record_id },
    );

    if (error) {
      console.error("seal_governance_record_for_archive error", error);
      return json(
        { ok: false, error: `Archive seal failed: ${error.message}` },
        500,
      );
    }

    return json({ ok: true, result: data });
  } catch (e: any) {
    console.error("archive-save-document fatal", e);
    return json(
      { ok: false, error: `Archive save failed: ${e?.message ?? "unknown error"}` },
      500,
    );
  }
});
