import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  envelope_id: string; // signature_envelopes.id
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

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  try {
    const body = (await req.json()) as Partial<ReqBody>;
    const envelope_id = body.envelope_id?.trim();
    const is_test = !!body.is_test;

    if (!envelope_id) return json({ ok: false, error: "missing_envelope_id" }, 400);

    // 1) Load envelope
    const { data: env, error: envErr } = await supabase
      .from("signature_envelopes")
      .select("id, record_id, status, completed_at")
      .eq("id", envelope_id)
      .maybeSingle();

    if (envErr) return json({ ok: false, error: "load_envelope_failed", details: envErr }, 500);
    if (!env) return json({ ok: false, error: "envelope_not_found" }, 404);

    const ledger_id = env.record_id as string | null;

    if (!ledger_id) {
      return json(
        { ok: false, error: "envelope_missing_record_id", hint: "signature_envelopes.record_id must be governance_ledger.id" },
        500,
      );
    }

    // 2) Validate completion (your schema may use status strings; keep both checks)
    const done =
      !!env.completed_at ||
      String(env.status || "").toLowerCase() === "completed" ||
      String(env.status || "").toLowerCase() === "signed";

    if (!done) {
      return json({ ok: false, error: "envelope_not_completed", status: env.status }, 409);
    }

    // 3) Delegate to archive-save-document (single source of truth)
    const url = `${SUPABASE_URL}/functions/v1/archive-save-document`;
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      apikey: SERVICE_ROLE_KEY,
    };

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ record_id: ledger_id, is_test }),
    });

    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return json(
        { ok: false, error: "archive_save_document_failed", status: resp.status, details: payload },
        500,
      );
    }

    return json({
      ok: true,
      envelope_id,
      record_id: ledger_id,
      ...payload,
    });
  } catch (e) {
    return json({ ok: false, error: "unhandled_exception", details: String(e) }, 500);
  }
});
