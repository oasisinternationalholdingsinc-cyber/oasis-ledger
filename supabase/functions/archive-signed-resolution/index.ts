// supabase/functions/archive-signed-resolution/index.ts
import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  try {
    const { envelope_id } = await req.json();
    if (!envelope_id) throw new Error("envelope_id required");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // resolve ledger_id
    const { data: env, error } = await supabase
      .from("signature_envelopes")
      .select("record_id")
      .eq("id", envelope_id)
      .single();

    if (error || !env?.record_id) {
      throw new Error("Envelope not linked to ledger record");
    }

    const { data, error: sealErr } = await supabase
      .rpc("seal_governance_record_for_archive", {
        p_ledger_id: env.record_id,
      })
      .single();

    if (sealErr) throw sealErr;

    return new Response(
      JSON.stringify({
        ok: true,
        minute_book_entry_id: data.minute_book_entry_id,
        verified_document_id: data.verified_document_id,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: err.message ?? "archive-signed-resolution failed",
      }),
      { status: 500 }
    );
  }
});
