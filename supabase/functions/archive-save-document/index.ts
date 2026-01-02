import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  try {
    const body = (await req.json()) as ReqBody;
    const record_id = requireUUID(body.record_id, "record_id");

    const { data, error } = await supabase
      .rpc("seal_governance_record_for_archive", { p_ledger_id: record_id })
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error("seal_governance_record_for_archive returned no row");

    return json({
      ok: true,
      record_id,
      storage_bucket: data.storage_bucket,
      storage_path: data.storage_path,
      file_hash: data.file_hash,
      verified_document_id: data.verified_document_id,
      minute_book_entry_id: data.minute_book_entry_id,
      already_archived: data.already_archived ?? null,
      repaired: data.repaired ?? null,
    });
  } catch (err: any) {
    return json(
      {
        ok: false,
        error: err?.message ?? "archive-save-document failed",
        details: err,
      },
      500
    );
  }
});
