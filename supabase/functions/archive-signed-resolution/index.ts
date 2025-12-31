import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { archiveLedgerEnterprise, getServiceClient } from "../_shared/archive.ts";

type ReqBody = {
  envelope_id: string; // signature_envelopes.id
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
    if (!body?.envelope_id) return json({ ok: false, error: "envelope_id required" }, 400);

    const supabase = getServiceClient();

    // Load envelope -> ledger_id
    const { data: env, error: envErr } = await supabase
      .from("signature_envelopes")
      .select("id, record_id, status")
      .eq("id", body.envelope_id)
      .single();

    if (envErr) throw envErr;
    if (!env?.record_id) return json({ ok: false, error: "Envelope missing record_id" }, 500);

    const result = await archiveLedgerEnterprise({
      supabase,
      ledger_id: env.record_id,
      envelope_id: env.id,
    });

    if (!result.ok) return json({ ok: false, step: "archive-signed-resolution", ...result }, 500);
    return json({ ok: true, step: "archive-signed-resolution", ...result }, 200);
  } catch (e) {
    return json({ ok: false, step: "archive-signed-resolution", error: (e as any)?.message ?? "unknown" }, 500);
  }
});
