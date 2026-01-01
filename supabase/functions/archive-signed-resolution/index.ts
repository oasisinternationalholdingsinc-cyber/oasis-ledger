import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

serve(async (req) => {
  /* 🔴 CRITICAL: preflight must always succeed */
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  try {
    const { envelope_id, is_test } = await req.json();

    if (!envelope_id) {
      return json({ ok: false, error: "Missing envelope_id" }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { global: { fetch } }
    );

    // 🔐 Resolve ledger_id from envelope
    const { data: env, error: envErr } = await supabase
      .from("signature_envelopes")
      .select("record_id")
      .eq("id", envelope_id)
      .maybeSingle();

    if (envErr || !env?.record_id) {
      return json({ ok: false, error: "Envelope not found" }, 404);
    }

    // 🔁 Delegate to canonical archive
    const { data, error } = await supabase.functions.invoke(
      "archive-save-document",
      {
        body: {
          record_id: env.record_id,
          is_test,
          trigger: "archive-signed-resolution",
        },
      }
    );

    if (error) {
      return json(
        { ok: false, error: error.message ?? "Archive failed" },
        500
      );
    }

    return json({ ok: true, ...data });
  } catch (e: any) {
    return json({ ok: false, error: e.message }, 500);
  }
});
