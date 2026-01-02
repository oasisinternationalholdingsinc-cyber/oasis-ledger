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
    const record_id = requireUUID(body.record_id, "record_id");

    const supabase = getServiceClient();

    const { data, error } = await supabase
      .rpc(SEAL_RPC, { p_ledger_id: record_id })
      .single();

    if (error) throw error;

    return json({
      ok: true,
      minute_book_entry_id: data.minute_book_entry_id,
      verified_document_id: data.verified_document_id,
      storage_bucket: data.storage_bucket,
      storage_path: data.storage_path,
    });
  } catch (err: any) {
    return json(
      { ok: false, error: err.message ?? "archive-save-document failed" },
      500
    );
  }
});
