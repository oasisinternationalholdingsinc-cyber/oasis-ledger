import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  record_id?: string;     // governance_ledger.id (optional; can be derived from envelope)
  envelope_id: string;    // signature_envelopes.id
  is_test?: boolean;      // lane flag (optional; defaults from envelope/ledger)
  domain_key?: string;    // optional
  section_name?: string;  // optional
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
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

serve(async (req) => {
  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);

    const body = (await req.json().catch(() => null)) as ReqBody | null;
    if (!body?.envelope_id) {
      return json({ ok: false, error: "envelope_id is required" }, 400);
    }

    // 1) Load envelope + sanity
    const { data: env, error: envErr } = await supabase
      .from("signature_envelopes")
      .select("id, record_id, status, is_test")
      .eq("id", body.envelope_id)
      .maybeSingle();

    if (envErr) return json({ ok: false, error: envErr.message }, 500);
    if (!env) return json({ ok: false, error: "signature_envelope not found" }, 404);

    const record_id = body.record_id ?? env.record_id;
    if (!record_id) return json({ ok: false, error: "record_id could not be determined" }, 400);

    if (env.status !== "completed") {
      return json(
        { ok: false, error: "envelope is not completed; cannot archive yet", status: env.status },
        400,
      );
    }

    const is_test = Boolean(body.is_test ?? env.is_test ?? false);

    // 2) Call archive-save-document (service_role)
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/archive-save-document`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        apikey: SERVICE_ROLE_KEY,
      },
      body: JSON.stringify({
        record_id,
        envelope_id: env.id,
        is_test,
        domain_key: body.domain_key,         // optional; archive-save-document validates/falls back
        section_name: body.section_name,     // optional
      }),
    });

    const out = await resp.json().catch(() => ({}));
    if (!resp.ok || !out?.ok) {
      return json(
        {
          ok: false,
          error: "archive-save-document failed",
          status: resp.status,
          details: out,
        },
        500,
      );
    }

    return json({ ok: true, ...out });
  } catch (e) {
    return json({ ok: false, error: String((e as any)?.message ?? e) }, 500);
  }
});
