import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  envelope_id: string;    // signature_envelopes.id
  actor_uid?: string;     // who to stamp uploaded_by/owner_id (defaults to Abbas)
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

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

const DEFAULT_ACTOR_UID = "ac35a784-b5ce-4f2a-a5de-a5acd04955e7";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const body = (await req.json()) as ReqBody;
    const envelope_id = String(body.envelope_id || "").trim();
    const actor_uid = String(body.actor_uid || DEFAULT_ACTOR_UID).trim();

    if (!envelope_id) return json({ ok: false, error: "envelope_id required" }, 400);

    const { data: env, error: envErr } = await supabase
      .from("signature_envelopes")
      .select("id,status,record_id")
      .eq("id", envelope_id)
      .maybeSingle();

    if (envErr) return json({ ok: false, error: "load signature_envelopes failed", details: envErr }, 500);
    if (!env) return json({ ok: false, error: "envelope not found" }, 404);

    if (String(env.status) !== "completed") {
      return json({ ok: false, error: "envelope not completed", details: { status: env.status } }, 400);
    }

    const record_id = String(env.record_id || "").trim();
    if (!record_id) return json({ ok: false, error: "envelope.record_id missing" }, 500);

    // Delegate to archive-save-document (service role)
    const { data: res, error: fnErr } = await supabase.functions.invoke("archive-save-document", {
      body: { record_id, actor_uid },
    });

    if (fnErr) {
      return json({ ok: false, error: "archive-save-document failed", details: fnErr }, 500);
    }

    return json({ ok: true, envelope_id, record_id, result: res });
  } catch (e) {
    return json({ ok: false, error: "unhandled", details: String(e?.message ?? e) }, 500);
  }
});
