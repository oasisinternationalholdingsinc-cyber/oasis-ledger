import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
};

export function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function getEnv() {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_ROLE_KEY =
    Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL");
  if (!SERVICE_ROLE_KEY) throw new Error("Missing SERVICE_ROLE_KEY / SUPABASE_SERVICE_ROLE_KEY");

  return { SUPABASE_URL, SERVICE_ROLE_KEY };
}

export function getServiceClient(): SupabaseClient {
  const { SUPABASE_URL, SERVICE_ROLE_KEY } = getEnv();

  // ✅ Enterprise: FORCE headers so DB sees service_role in request.jwt.claim.role
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: {
      fetch,
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
    },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function invokeEdgeFunction(
  fnName: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; text: string; json?: any }> {
  const { SUPABASE_URL, SERVICE_ROLE_KEY } = getEnv();

  const url = `${SUPABASE_URL}/functions/v1/${fnName}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // ✅ Enterprise: FORCE both headers for function gateway consistency
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let parsed: any = undefined;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    // keep text
  }

  return { ok: res.ok, status: res.status, text, json: parsed };
}
