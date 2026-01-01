import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { cors, json, SUPABASE_URL, SERVICE_ROLE_KEY } from "../_shared/archive.ts";

type ReqBody = {
  envelope_id: string; // signature_envelopes.id
  is_test?: boolean;
};

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

    const { data: env, error: envErr } = await supabase
      .from("signature_envelopes")
      .select("id, record_id, status, completed_at")
      .eq("id", envelope_id)
      .maybeSingle();

    if (envErr) return json({ ok: false, error: "load_envelope_failed", details: envErr }, 500);
    if (!env) return json({ ok: false, error: "envelope_not_found" }, 404);

    const record_id = env.record_id as string | null;
    if (!record_id) {
      return json(
        { ok: false, error: "envelope_missing_record_id", hint: "signature_envelopes.record_id must be governance_ledger.id" },
        500,
      );
    }

    const done =
      !!env.completed_at ||
      String(env.status || "").toLowerCase() === "completed" ||
      String(env.status || "").toLowerCase() === "signed";

    if (!done) return json({ ok: false, error: "envelope_not_completed", status: env.status }, 409);

    const resp = await fetch(`${SUPABASE_URL}/functions/v1/archive-save-document`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: req.headers.get("authorization") ?? "", // preserve actor JWT if present
        apikey: SERVICE_ROLE_KEY,
      },
      body: JSON.stringify({ record_id, is_test }),
    });

    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return json({ ok: false, error: "archive_save_document_failed", status: resp.status, details: payload }, 500);
    }

    return json({ ok: true, envelope_id, record_id, ...payload });
  } catch (e) {
    return json({ ok: false, error: "unhandled_exception", details: String(e) }, 500);
  }
});
