// supabase/functions/_shared/archive.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
};

export function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

export async function readJson<T>(req: Request): Promise<T> {
  const ct = req.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    throw new Error(`Expected application/json, got: ${ct}`);
  }
  return (await req.json()) as T;
}

export function getServiceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key =
    Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url) throw new Error("Missing SUPABASE_URL env");
  if (!key) throw new Error("Missing SERVICE_ROLE_KEY / SUPABASE_SERVICE_ROLE_KEY env");

  return createClient(url, key, {
    global: { fetch },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function rpcOrThrow<T>(
  sb: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
  step: string,
): Promise<T> {
  const { data, error } = await sb.rpc(fn, args);
  if (error) {
    throw new Error(`${step}: ${error.message} (${error.code ?? "no_code"})`);
  }
  return data as T;
}
