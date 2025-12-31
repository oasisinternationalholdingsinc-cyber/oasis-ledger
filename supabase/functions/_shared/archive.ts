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

export function getServiceClient(): SupabaseClient {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_ROLE_KEY =
    Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL");
  if (!SERVICE_ROLE_KEY) throw new Error("Missing SERVICE_ROLE_KEY / SUPABASE_SERVICE_ROLE_KEY");

  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { global: { fetch } });
}

/**
 * Call another Edge Function as service_role (server-to-server).
 * This is critical for TRUTH LANE LOCKED flows.
 */
export async function invokeEdgeFunction(
  fnName: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; text: string; json?: any }> {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_ROLE_KEY =
    Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL");
  if (!SERVICE_ROLE_KEY) throw new Error("Missing SERVICE_ROLE_KEY / SUPABASE_SERVICE_ROLE_KEY");

  const url = `${SUPABASE_URL}/functions/v1/${fnName}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // ✅ ensure downstream is service_role
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let parsed: any = undefined;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    // keep text only
  }

  return { ok: res.ok, status: res.status, text, json: parsed };
}
