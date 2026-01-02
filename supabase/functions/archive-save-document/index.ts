// supabase/functions/archive-save-document/index.ts
import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*" } });
  }

  try {
    const { record_id } = await req.json();
    if (!record_id) throw new Error("record_id is required");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data, error } = await supabase
      .rpc("seal_governance_record_for_archive", { p_ledger_id: record_id })
      .single();

    if (error) throw error;

    return new Response(
      JSON.stringify({
        ok: true,
        minute_book_entry_id: data.minute_book_entry_id,
        verified_document_id: data.verified_document_id,
        repaired: false,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: err.message ?? "archive-save-document failed",
      }),
      { status: 500 }
    );
  }
});
