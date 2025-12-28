import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error("Missing Supabase env");

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { global: { fetch } });

const MINUTE_BOOK_BUCKET = Deno.env.get("MINUTE_BOOK_BUCKET") ?? "minute_book";

const corsHeaders: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function asString(x: unknown) {
  return typeof x === "string" ? x.trim() : "";
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

type ReqBody = {
  record_id?: string;   // governance_ledger.id (REQUIRED)
  envelope_id?: string; // signature_envelopes.id (REQUIRED)
};

async function findSignedPdfPath(recordId: string): Promise<string | null> {
  // Prefer the explicit "-signed.pdf" file
  const { data, error } = await supabase
    .from("storage.objects")
    .select("name, created_at")
    .eq("bucket_id", MINUTE_BOOK_BUCKET)
    .ilike("name", `%${recordId}%-signed.pdf`)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) throw new Error(`storage.objects lookup failed: ${error.message}`);
  if (data && data.length > 0) return data[0].name as string;

  // Fallback: any PDF containing record id (last resort)
  const { data: data2, error: error2 } = await supabase
    .from("storage.objects")
    .select("name, created_at")
    .eq("bucket_id", MINUTE_BOOK_BUCKET)
    .ilike("name", `%${recordId}%.pdf`)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error2) throw new Error(`storage.objects fallback lookup failed: ${error2.message}`);
  if (data2 && data2.length > 0) return data2[0].name as string;

  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "POST required" }, 405);

  let body: ReqBody;
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const record_id = asString(body.record_id);
  const envelope_id = asString(body.envelope_id);

  if (!record_id || !envelope_id) {
    return json({ ok: false, error: "record_id (governance_ledger.id) and envelope_id are required" }, 400);
  }

  // 1) Load governance record (truth for entity_id + lane + title)
  const { data: ledger, error: ledErr } = await supabase
    .from("governance_ledger")
    .select("id, title, entity_id, is_test")
    .eq("id", record_id)
    .maybeSingle();

  if (ledErr) return json({ ok: false, error: "Failed to load governance_ledger", details: ledErr.message }, 500);
  if (!ledger) return json({ ok: false, error: "record_id not found in governance_ledger" }, 404);

  const lane_is_test = (ledger.is_test ?? false) === true;

  // 2) Load envelope (only for status sanity; DO NOT trust lane from envelope)
  const { data: env, error: envErr } = await supabase
    .from("signature_envelopes")
    .select("id, record_id, status, completed_at")
    .eq("id", envelope_id)
    .maybeSingle();

  if (envErr) return json({ ok: false, error: "Failed to load signature_envelopes", details: envErr.message }, 500);
  if (!env) return json({ ok: false, error: "envelope_id not found in signature_envelopes" }, 404);

  if ((env.status || "").toLowerCase() !== "completed") {
    return json({ ok: false, error: "Envelope is not completed", envelope_status: env.status }, 400);
  }

  // 3) Find signed pdf path in minute_book bucket
  let signedPath: string | null = null;
  try {
    signedPath = await findSignedPdfPath(record_id);
  } catch (e) {
    return json({ ok: false, error: "Failed searching for signed PDF", details: (e as Error).message }, 500);
  }

  if (!signedPath) {
    return json({
      ok: false,
      error: "Signed PDF not found in storage",
      hint: `Expected something like: holdings/Resolutions/${record_id}-signed.pdf in bucket ${MINUTE_BOOK_BUCKET}`,
    }, 404);
  }

  // 4) Download PDF bytes
  const { data: dl, error: dlErr } = await supabase.storage
    .from(MINUTE_BOOK_BUCKET)
    .download(signedPath);

  if (dlErr || !dl) {
    return json({
      ok: false,
      error: "Failed to download signed PDF",
      details: dlErr?.message ?? "download returned null",
      bucket: MINUTE_BOOK_BUCKET,
      path: signedPath,
    }, 500);
  }

  const pdfBytes = new Uint8Array(await dl.arrayBuffer());
  const pdf_base64 = bytesToBase64(pdfBytes);

  // 5) Call archive-save-document (service-role) to register Minute Book + supporting_documents
  const url = `${SUPABASE_URL}/functions/v1/archive-save-document`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
      "apikey": SERVICE_ROLE_KEY,
    },
    body: JSON.stringify({
      source_record_id: record_id,
      pdf_base64,
      envelope_id,
      is_test: lane_is_test,
      title: ledger.title ?? "Signed Resolution",
      entity_id: ledger.entity_id,
      bucket: MINUTE_BOOK_BUCKET,
    }),
  });

  const outText = await resp.text();
  let outJson: any = null;
  try { outJson = JSON.parse(outText); } catch { /* ignore */ }

  if (!resp.ok) {
    return json({
      ok: false,
      error: "archive-save-document failed",
      status: resp.status,
      details: outJson ?? outText,
      record_id,
      envelope_id,
      is_test: lane_is_test,
      bucket: MINUTE_BOOK_BUCKET,
      path: signedPath,
    }, 500);
  }

  // 6) Best-effort seal into verified registry (won't break if RPC missing)
  let seal_result: any = null;
  let seal_error: string | null = null;
  try {
    const { data, error } = await supabase.rpc("seal_governance_record_for_archive", {
      p_record_id: record_id,
    } as any);
    if (error) seal_error = error.message;
    else seal_result = data;
  } catch (e) {
    seal_error = (e as Error).message;
  }

  return json({
    ok: true,
    record_id,
    envelope_id,
    is_test: lane_is_test,
    bucket: MINUTE_BOOK_BUCKET,
    signed_pdf_path: signedPath,
    archive_save_document: outJson ?? outText,
    seal_result,
    seal_error,
  });
});
