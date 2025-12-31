import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { sealAndRepairArchive } from "../_shared/archive.ts";

type ReqBody = { record_id: string; is_test?: boolean };

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
};

const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x, null, 2), { status, headers: { ...cors, "Content-Type": "application/json" } });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE_KEY =
      Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { global: { fetch } });

    const body = (await req.json()) as ReqBody;
    if (!body?.record_id) return json({ ok: false, error: "Missing record_id" }, 400);

    const out = await sealAndRepairArchive({
      supabase,
      record_id: body.record_id,
      is_test: body.is_test,
    });

    if (!out.ok) return json(out, 500);
    return json(out, 200);
  } catch (e) {
    return json({ ok: false, error: "Unhandled error", details: String(e) }, 500);
  }
});
