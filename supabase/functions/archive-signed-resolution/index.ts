import { serve } from "https://deno.land/std/http/server.ts";
import {
  cors,
  json,
  getServiceClient,
  requireUUID,
  SEAL_RPC,
} from "../_shared/archive.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  try {
    const body = await req.json();
    const envelope_id = requireUUID(body.envelope_id, "envelope_id");

    const supabase = getServiceClient();

    const { data: env, error: envErr } = await supabase
      .from("signature_envelopes")
      .select("record_id")
      .eq("id", envelope_id)
      .single();

    if (envErr || !env?.record_id) {
      throw new Error("Envelope not linked to ledger record");
    }

    const { data, error } = await supabase
      .rpc(SEAL_RPC, { p_ledger_id: env.record_id })
      .single();

    if (error) throw error;

    return json({
      ok: true,
      minute_book_entry_id: data.minute_book_entry_id,
      verified_document_id: data.verified_document_id,
    });
  } catch (err: any) {
    return json(
      { ok: false, error: err.message ?? "archive-signed-resolution failed" },
      500
    );
  }
});
