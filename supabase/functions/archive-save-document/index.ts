// supabase/functions/archive-save-document/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { runArchiveSaveDocument } from "../_shared/archive.ts";

type ReqBody = {
  record_id: string; // governance_ledger.id
  is_test?: boolean;
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
};

const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  let body: ReqBody;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  if (!body?.record_id) return json({ ok: false, error: "record_id is required" }, 400);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_ROLE_KEY =
    Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return json({ ok: false, error: "Missing SUPABASE_URL or SERVICE_ROLE_KEY" }, 500);
  }

  const result = await runArchiveSaveDocument(
    { SUPABASE_URL, SERVICE_ROLE_KEY },
    body.record_id,
    !!body.is_test
  );

  // IMPORTANT:
  // Only return 404 when the *ledger record* truly doesn’t exist.
  // Everything else should be 500/400 so you don’t get “mystery 404”.
  if (!result.ok && result.warnings?.includes("Ledger record not found")) {
    return json(result, 404);
  }
  if (!result.ok) return json(result, 500);

  return json(result, 200);
});
