import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { archiveLedgerEnterprise, getServiceClient } from "../_shared/archive.ts";

type ReqBody = {
  record_id: string; // governance_ledger.id
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
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  try {
    const body = (await req.json()) as ReqBody;
    if (!body?.record_id) return json({ ok: false, error: "record_id required" }, 400);

    const supabase = getServiceClient();
    const result = await archiveLedgerEnterprise({ supabase, ledger_id: body.record_id });

    if (!result.ok) return json({ ok: false, step: "archive-save-document", ...result }, 500);
    return json({ ok: true, step: "archive-save-document", ...result }, 200);
  } catch (e) {
    return json({ ok: false, step: "archive-save-document", error: (e as any)?.message ?? "unknown" }, 500);
  }
});
