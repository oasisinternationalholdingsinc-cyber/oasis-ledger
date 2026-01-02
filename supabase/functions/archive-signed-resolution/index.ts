import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  envelope_id: string; // signature_envelopes.id
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
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
  auth: { persistSession: false, autoRefreshToken: false },
});

function requireUUID(v: unknown, field: string) {
  if (typeof v !== "string" || !/^[0-9a-fA-F-]{36}$/.test(v)) {
    throw new Error(`Invalid ${field}`);
  }
  return v;
}

async function callArchiveSaveDocument(record_id: string) {
  const url = `${SUPABASE_URL}/functions/v1/archive-save-document`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      // Use service role for both headers to keep it simple + consistent.
      authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      apikey: SERVICE_ROLE_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({ record_id }),
  });

  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep raw text
  }

  if (!res.ok) {
    const msg =
      parsed?.error ||
      parsed?.message ||
      `archive-save-document HTTP ${res.status}`;
    const detail = parsed ?? text;
    const err = new Error(msg);
    (err as any).detail = detail;
    (err as any).status = res.status;
    throw err;
  }

  return parsed ?? text;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const body = (await req.json()) as ReqBody;
    const envelope_id = requireUUID(body.envelope_id, "envelope_id");

    // 1) Load envelope → record_id (governance_ledger.id)
    const { data: env, error: envErr } = await supabase
      .from("signature_envelopes")
      .select("id, record_id, status")
      .eq("id", envelope_id)
      .maybeSingle();

    if (envErr) throw envErr;
    if (!env) throw new Error("Envelope not found");
    if (!env.record_id) throw new Error("Envelope missing record_id");
    if (env.status !== "completed") {
      throw new Error(
        `Archive blocked: envelope status is '${env.status}', expected 'completed'`,
      );
    }

    // 2) Delegate to archive-save-document (single enterprise path)
    const result = await callArchiveSaveDocument(env.record_id);

    return json({
      ok: true,
      envelope_id: env.id,
      record_id: env.record_id,
      result,
    });
  } catch (err: any) {
    return json(
      {
        ok: false,
        error: err?.message ?? "archive-signed-resolution failed",
        status: err?.status,
        detail: err?.detail,
      },
      500,
    );
  }
});
