import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

// Signed PDFs produced by Forge (where envelope.storage_path points)
const SIGNED_BUCKET = Deno.env.get("MINUTE_BOOK_BUCKET") ?? "minute_book";

// Where to file inside Minute Book (must exist in governance_domains.key)
const DEFAULT_DOMAIN_KEY =
  (Deno.env.get("DEFAULT_MINUTE_BOOK_DOMAIN_KEY") ?? "governance").trim();

const DEFAULT_SECTION_NAME =
  (Deno.env.get("DEFAULT_MINUTE_BOOK_SECTION_NAME") ?? "Resolutions").trim();

const corsHeaders: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

type ArchiveSaveDocumentResponse = {
  ok: boolean;
  minute_book_entry_id?: string;
  already_archived?: boolean;
  error?: string;
  details?: unknown;
};

type ReqBody = {
  envelope_id?: string;
  domain_key?: string;
  section_name?: string;
};

async function readInvokeErrorDetails(err: unknown): Promise<unknown> {
  try {
    const resp = (err as any)?.context as Response | undefined;
    if (!resp) return null;

    try {
      return await resp.clone().json();
    } catch {
      const t = await resp.clone().text();
      return t?.slice(0, 4000);
    }
  } catch {
    return null;
  }
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  try {
    const body = (await req.json().catch(() => ({}))) as ReqBody;
    const envelope_id = body.envelope_id?.trim();

    if (!envelope_id) {
      return json({ ok: false, error: "Missing envelope_id in request body." }, 400);
    }

    // 1) Envelope (immutable once completed)
    const { data: envelope, error: envErr } = await supabase
      .from("signature_envelopes")
      .select("id, status, record_id, storage_path")
      .eq("id", envelope_id)
      .maybeSingle();

    if (envErr) {
      console.error("archive-signed-resolution: envelope lookup error", envErr);
      return json({ ok: false, error: "Failed to look up signature envelope." }, 500);
    }
    if (!envelope) return json({ ok: false, error: "Envelope not found." }, 404);
    if (envelope.status !== "completed") {
      return json({ ok: false, error: "Envelope is not completed yet." }, 400);
    }
    if (!envelope.record_id) {
      return json({ ok: false, error: "Envelope missing record_id." }, 400);
    }
    if (!envelope.storage_path) {
      return json({ ok: false, error: "Envelope missing storage_path." }, 400);
    }

    const record_id = envelope.record_id as string;

    // 2) Ledger is the lane source of truth
    const { data: ledger, error: ledErr } = await supabase
      .from("governance_ledger")
      .select("id, title, entity_id, is_test, status")
      .eq("id", record_id)
      .maybeSingle();

    if (ledErr) {
      console.error("archive-signed-resolution: ledger lookup error", ledErr);
      return json({ ok: false, error: "Failed to look up governance_ledger record." }, 500);
    }
    if (!ledger) {
      return json({ ok: false, error: "governance_ledger record not found for envelope.record_id." }, 404);
    }

    const lane_is_test = Boolean(ledger.is_test);

    const domain_key = (body.domain_key?.trim() || DEFAULT_DOMAIN_KEY).trim();
    const section_name = (body.section_name?.trim() || DEFAULT_SECTION_NAME).trim();

    // 3) Download signed PDF
    const { data: file, error: downloadErr } = await supabase.storage
      .from(SIGNED_BUCKET)
      .download(envelope.storage_path);

    if (downloadErr || !file) {
      console.error("archive-signed-resolution: download failed", downloadErr);
      return json({ ok: false, error: "Failed to download signed PDF from storage." }, 500);
    }

    const pdf_base64 = arrayBufferToBase64(await file.arrayBuffer());

    // 4) Call archive-save-document (service_role)
    const { data: archiveData, error: archiveErr } =
      await supabase.functions.invoke<ArchiveSaveDocumentResponse>("archive-save-document", {
        body: {
          source_record_id: record_id,
          pdf_base64,
          is_test: lane_is_test,
          domain_key,
          section_name,
          title: ledger.title ?? "Signed Resolution",
          entity_id: ledger.entity_id,
          envelope_id,
          signed_bucket: SIGNED_BUCKET,
          signed_storage_path: envelope.storage_path,
        },
      });

    if (archiveErr) {
      const extra = await readInvokeErrorDetails(archiveErr);
      console.error("archive-signed-resolution: archive-save-document error", archiveErr, extra);
      return json(
        {
          ok: false,
          error: (extra as any)?.error ?? (archiveErr as any)?.message ?? "archive-save-document failed.",
          details: extra ?? null,
        },
        400,
      );
    }

    if (!archiveData?.ok) {
      return json(
        {
          ok: false,
          error: archiveData?.error ?? "archive-save-document returned ok=false.",
          details: archiveData?.details ?? null,
        },
        400,
      );
    }

    return json({
      ok: true,
      minute_book_entry_id: archiveData.minute_book_entry_id ?? null,
      already_archived: archiveData.already_archived ?? false,
      is_test: lane_is_test,
      domain_key,
      section_name,
    });
  } catch (err) {
    console.error("archive-signed-resolution: unexpected error", err);
    return json(
      { ok: false, error: err instanceof Error ? err.message : "Unexpected error." },
      500,
    );
  }
});
