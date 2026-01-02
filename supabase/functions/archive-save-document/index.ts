import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok");

  const { record_id } = await req.json();
  if (!record_id) {
    return new Response(JSON.stringify({ ok: false, error: "record_id required" }), { status: 400 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { global: { fetch } }
  );

  const { data, error } = await supabase
    .rpc("seal_governance_record_for_archive", { p_ledger_id: record_id });

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500 });
  }

  return new Response(JSON.stringify({ ok: true, data }));
});
