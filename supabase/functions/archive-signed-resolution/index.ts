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
  Deno.env.get("SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  try {
    const body = (await req.json()) as ReqBody;
    const envelope_id = requireUUID(body.envelope_id, "envelope_id");

    // Load envelope -> ledger record_id
    const { data: env, error: envErr } = await supabase
      .from("signature_envelopes")
      .select("id, record_id, status")
      .eq("id", envelope_id)
      .maybeSingle();

    if (envErr) throw envErr;
    if (!env) return json({ ok: false, error: "Envelope not found" }, 404);
    if (!env.record_id) {
      return json({ ok: false, error: "Envelope missing record_id" }, 400);
    }

    if (env.status !== "completed") {
      return json(
        {
          ok: false,
          error: `Archive blocked: envelope status is '${env.status}', expected 'completed'`,
          envelope_id: env.id,
          record_id: env.record_id,
        },
        400,
      );
    }

    // Canonical RPC (the one PostgREST actually sees)
    const { data, error } = await supabase
      .rpc("seal_governance_record_for_archive_with_envelope", {
        p_ledger_id: env.record_id,
        p_envelope_id: env.id,
      })
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error("seal RPC returned no row");

    return json({
      ok: true,
      envelope_id: env.id,
      record_id: env.record_id,
      storage_bucket: data.storage_bucket ?? null,
      storage_path: data.storage_path ?? null,
      file_hash: data.file_hash ?? null,
      verified_document_id: data.verified_document_id ?? null,
      minute_book_entry_id: data.minute_book_entry_id ?? null,
    });
  } catch (err: any) {
    return json(
      {
        ok: false,
        error: err?.message ?? "archive-signed-resolution failed",
        details: err,
      },
      500,
    );
  }
});
