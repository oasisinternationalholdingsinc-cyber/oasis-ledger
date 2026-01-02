import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/* ---------------------------------------------
   CORS
--------------------------------------------- */
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

/* ---------------------------------------------
   Env
--------------------------------------------- */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error("Missing Supabase env vars");

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  global: { fetch },
});

/* ---------------------------------------------
   Types
--------------------------------------------- */
type ReqBody = {
  envelope_id: string; // signature_envelopes.id
  is_test?: boolean;   // informational only (lane enforced in SQL + data)
  trigger?: string;
};

/* ---------------------------------------------
   Handler
--------------------------------------------- */
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  let body: ReqBody;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const { envelope_id } = body;
  if (!envelope_id) return json({ ok: false, error: "envelope_id is required" }, 400);

  try {
    // 1) Load envelope + validate completion
    const { data: envRow, error: envErr } = await supabase
      .from("signature_envelopes")
      .select("id, status, record_id")
      .eq("id", envelope_id)
      .maybeSingle();

    if (envErr) {
      console.error("signature_envelopes select error", envErr);
      return json({ ok: false, error: `Envelope lookup failed: ${envErr.message}` }, 500);
    }
    if (!envRow) return json({ ok: false, error: "Envelope not found" }, 404);
    if (envRow.status !== "completed") {
      return json({ ok: false, error: "Archive blocked: envelope not completed" }, 400);
    }
    if (!envRow.record_id) {
      return json({ ok: false, error: "Archive blocked: envelope missing record_id" }, 400);
    }

    const record_id = envRow.record_id as string;

    // 2) Delegate to canonical sealer (idempotent + repair-safe)
    const { data, error } = await supabase.rpc("seal_governance_record_for_archive", {
      p_ledger_id: record_id,
    });

    if (error) {
      console.error("seal_governance_record_for_archive error", error);
      return json({ ok: false, error: `Archive seal failed: ${error.message}` }, 500);
    }
    if (!data) return json({ ok: false, error: "Archive seal failed: no data returned" }, 500);

    const row: any = Array.isArray(data) ? data[0] : data;

    return json({
      ok: true,
      ledger_id: record_id,
      minute_book_entry_id: row?.minute_book_entry_id ?? null,
      verified_document_id: row?.verified_document_id ?? null,
      storage_bucket: row?.storage_bucket ?? null,
      storage_path: row?.storage_path ?? null,
      file_hash: row?.file_hash ?? null,
      repaired: Boolean(row?.repaired ?? false),
      already_sealed: Boolean(row?.already_sealed ?? (row?.status === "already_sealed")),
    });
  } catch (e: any) {
    console.error("archive-signed-resolution fatal error", e);
    return json({ ok: false, error: `Archive signed failed: ${e?.message ?? "unknown error"}` }, 500);
  }
});
