// supabase/functions/_shared/archive.ts
import { createClient } from "jsr:@supabase/supabase-js@2";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export const MINUTE_BOOK_BUCKET = "minute_book";
export const SEAL_RPC = "seal_governance_record_for_archive";

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
};

export const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

export function getServiceClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { fetch },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function requireUUID(id: unknown, field: string) {
  if (typeof id !== "string" || !/^[0-9a-fA-F-]{36}$/.test(id)) {
    throw new Error(`Invalid ${field}`);
  }
  return id;
}
