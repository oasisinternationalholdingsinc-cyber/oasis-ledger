import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error("Missing Supabase env");

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { global: { fetch } });

// IMPORTANT: signed envelope PDFs usually live in the governance bucket, NOT minute_book
const SIGNED_PDF_BUCKET = Deno.env.get("SIGNED_PDF_BUCKET") ?? "governance_sandbox";
const MINUTE_BOOK_BUCKET = Deno.env.get("MINUTE_BOOK_BUCKET") ?? "minute_book";

const DEFAULT_DOMAIN_KEY = Deno.env.get("DEFAULT_MINUTE_BOOK_DOMAIN_KEY") ?? "governance";
const DEFAULT_SECTION_NAME = Deno.env.get("DEFAULT_MINUTE_BOOK_SECTION_NAME") ?? "Governance";

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

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

type ReqBody = {
  envelope_id?: string;
  domain_key?: string;
  section_name?: string;
};

type ArchiveSaveResp = {
  ok: boolean;
  minute_book_entry_id?: string;
  already_archived?: boolean;
  storage_path?: string;
  file_name?: string;
  sha256?: string;
  error?: string;
  details?: unknown;
};

async function readInvokeErrorDetails(err: unknown): Promise<unknown> {
  try {
    const resp = (err as any)?.context as Response | undefined;
    if (!resp) return null;
    try {
      return await resp.clone().json();
    } catch {
      return (await resp.clone().text())?.slice(0, 2000);
    }
  } catch {
    return null;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "POST required" }, 405);

  const body = (await req.json().catch(() => ({}))) as ReqBody;
  const envelope_id = asString(body.envelope_id);
  if (!envelope_id) return json({ ok: false, error: "Missing envelope_id" }, 400);

  // 1) Envelope
  const { data: env, error: envErr } = await supabase
    .from("signature_envelopes")
    .select("id, status, record_id, storage_path")
    .eq("id", envelope_id)
    .maybeSingle();

  if (envErr) return json({ ok: false, error: "Failed to look up envelope", details: envErr.message }, 500);
  if (!env) return json({ ok: false, error: "Envelope not found" }, 404);
  if (env.status !== "completed") return json({ ok: false, error: "Envelope not completed yet" }, 400);
  if (!env.storage_path) return json({ ok: false, error: "Envelope missing storage_path" }, 400);
  if (!env.record_id) return json({ ok: false, error: "Envelope missing record_id" }, 400);

  const record_id = env.record_id as string;

  // 2) Ledger (lane truth + entity + title)
  const { data: ledger, error: ledErr } = await supabase
    .from("governance_ledger")
    .select("id, title, entity_id, is_test")
    .eq("id", record_id)
    .maybeSingle();

  if (ledErr) return json({ ok: false, error: "Failed to load governance_ledger", details: ledErr.message }, 500);
  if (!ledger) return json({ ok: false, error: "governance_ledger record not found for envelope.record_id" }, 404);

  const domain_key = (asString(body.domain_key) || DEFAULT_DOMAIN_KEY).trim();
  const section_name = (asString(body.section_name) || DEFAULT_SECTION_NAME).trim();

  // 3) Download signed pdf (from SIGNED_PDF_BUCKET)
  const { data: file, error: dlErr } = await supabase.storage
    .from(SIGNED_PDF_BUCKET)
    .download(env.storage_path);

  if (dlErr || !file) {
    return json({ ok: false, error: "Failed to download signed PDF", details: dlErr?.message }, 500);
  }

  const pdf_base64 = arrayBufferToBase64(await file.arrayBuffer());

  // 4) Invoke archive-save-document (canonical insert path)
  const { data: out, error: invErr } = await supabase.functions.invoke<ArchiveSaveResp>(
    "archive-save-document",
    {
      body: {
        source_record_id: record_id,
        pdf_base64,
        domain_key,
        section_name,
        title: ledger.title ?? "Signed Resolution",
        entity_id: ledger.entity_id,
        is_test: ledger.is_test ?? false,
        envelope_id,
        bucket: MINUTE_BOOK_BUCKET,
      },
    },
  );

  if (invErr) {
    const extra = await readInvokeErrorDetails(invErr);
    return json(
      { ok: false, error: (extra as any)?.error ?? invErr.message ?? "archive-save-document failed", details: extra ?? null },
      400,
    );
  }

  if (!out?.ok) {
    return json({ ok: false, error: out?.error ?? "archive-save-document returned ok=false", details: out?.details ?? null }, 400);
  }

  // 5) Seal -> Verified Registry (this is the missing link)
  const { data: sealOut, error: sealErr } = await supabase.rpc("seal_governance_record_for_archive", {
    p_ledger_id: record_id,
  });

  if (sealErr) {
    return json(
      {
        ok: false,
        error: "Archived to minute book but sealing (verified registry) failed",
        details: sealErr.message,
        minute_book_entry_id: out.minute_book_entry_id ?? null,
        record_id,
        envelope_id,
      },
      500,
    );
  }

  return json({
    ok: true,
    minute_book_entry_id: out.minute_book_entry_id ?? null,
    already_archived: out.already_archived ?? false,
    record_id,
    envelope_id,
    domain_key,
    section_name,
    is_test: ledger.is_test ?? false,
    seal: sealOut ?? null,
  });
});
