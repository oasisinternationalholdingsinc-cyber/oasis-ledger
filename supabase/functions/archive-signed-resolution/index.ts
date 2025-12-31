// supabase/functions/archive-signed-resolution/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { runArchiveSaveDocument } from "../_shared/archive.ts";

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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  let body: ReqBody;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  if (!body?.envelope_id) return json({ ok: false, error: "envelope_id is required" }, 400);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_ROLE_KEY =
    Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return json({ ok: false, error: "Missing SUPABASE_URL or SERVICE_ROLE_KEY" }, 500);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { fetch },
    auth: { persistSession: false },
  });

  // 1) Validate envelope completed + resolve record_id
  const { data: env, error: envErr } = await supabase
    .from("signature_envelopes")
    .select("id, status, record_id, is_test, completed_at")
    .eq("id", body.envelope_id)
    .maybeSingle();

  if (envErr) return json({ ok: false, error: envErr.message }, 500);
  if (!env) return json({ ok: false, error: "Envelope not found" }, 404);

  if (env.status !== "completed") {
    return json(
      {
        ok: false,
        error: "Envelope is not completed",
        details: { status: env.status, completed_at: env.completed_at ?? null },
      },
      409
    );
  }

  const record_id = env.record_id;
  if (!record_id) return json({ ok: false, error: "Envelope missing record_id" }, 500);

  // 2) Lane handling: prefer ledger lane, but we can pass a hint
  const laneHint = typeof env.is_test === "boolean" ? env.is_test : !!body.is_test;

  // 3) Call the same archive logic (NO HTTP)
  const result = await runArchiveSaveDocument(
    { SUPABASE_URL, SERVICE_ROLE_KEY },
    record_id,
    laneHint
  );

  if (!result.ok && result.warnings?.includes("Ledger record not found")) {
    return json({ ok: false, error: "Ledger record not found", record_id }, 404);
  }
  if (!result.ok) return json(result, 500);

  return json(
    {
      ok: true,
      envelope_id: env.id,
      record_id,
      archive: result,
    },
    200
  );
});
