import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  envelope_id: string; // signature_envelopes.id
  is_test?: boolean;   // optional; archive-save-document will derive lane from ledger anyway
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

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { global: { fetch } });

function asBool(v: unknown, fallback = false) {
  if (typeof v === "boolean") return v;
  return fallback;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const body = (await req.json()) as ReqBody;
    const envelope_id = (body?.envelope_id ?? "").trim();
    const is_test = asBool(body?.is_test, false);

    if (!envelope_id) return json({ ok: false, error: "envelope_id is required" }, 400);

    // 1) Load envelope
    const env = await supabase
      .from("signature_envelopes")
      .select("id, record_id, status")
      .eq("id", envelope_id)
      .maybeSingle();

    if (env.error || !env.data) {
      return json({ ok: false, error: "signature_envelopes row not found", details: env.error ?? null }, 404);
    }

    const record_id = (env.data as any).record_id as string;
    const status = ((env.data as any).status as string | null) ?? null;

    if (status !== "completed") {
      return json({ ok: false, error: "Envelope is not completed yet.", envelope_status: status }, 400);
    }

    // 2) Delegate to archive-save-document (service_role)
    const { data, error } = await supabase.functions.invoke("archive-save-document", {
      body: { record_id, envelope_id, is_test },
      // NOTE: caller Authorization header will still be present in browser → archive-save-document can resolve actor uid
    });

    if (error) {
      return json({ ok: false, error: "archive-save-document failed", details: error }, 500);
    }
    if (!data?.ok) {
      return json({ ok: false, error: data?.error ?? "archive-save-document failed", details: data ?? null }, 500);
    }

    return json({
      ok: true,
      record_id,
      envelope_id,
      is_test: data.is_test ?? is_test,
      minute_book_entry_id: data.minute_book_entry_id ?? null,
      already_had_entry: data.already_had_entry ?? false,
      sealed: data.sealed ?? null,
      verify_json: data.verify_json ?? null,
      verified_document: data.verified_document ?? null,
      lane_warning: data.lane_warning ?? null,
    });
  } catch (e: any) {
    return json({ ok: false, error: e?.message ?? "Unhandled error" }, 500);
  }
});
