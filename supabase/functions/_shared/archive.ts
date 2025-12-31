import { createClient } from "jsr:@supabase/supabase-js@2";

export type SealResult = {
  status: string;
  ledger_id: string;
  verified_document_id: string;
  storage_bucket: string;
  storage_path: string;
  file_hash: string;
  file_size?: number;
  mime_type?: string;
};

export function makeServiceClient() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key =
    Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key, { global: { fetch } });
}

export async function sealLedgerForArchive(
  supabase: ReturnType<typeof makeServiceClient>,
  ledgerId: string,
) {
  const { data, error } = await supabase.rpc("seal_governance_record_for_archive", {
    p_ledger_id: ledgerId,
  });

  if (error) {
    throw new Error(`seal_governance_record_for_archive failed: ${error.message}`);
  }

  return data as SealResult;
}
