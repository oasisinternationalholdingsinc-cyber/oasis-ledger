// supabase/functions/archive-signed-resolution/index.ts
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

const SIGNED_BUCKET = Deno.env.get("MINUTE_BOOK_BUCKET") ?? "minute_book";

// IMPORTANT: this must be a VALID key that exists in governance_domains.key
// Set it in Supabase secrets if you want to control it centrally:
//   DEFAULT_MINUTE_BOOK_DOMAIN_KEY="governance"
const DEFAULT_DOMAIN_KEY = Deno.env.get("DEFAULT_MINUTE_BOOK_DOMAIN_KEY") ?? "governance";

// Optional, purely cosmetic grouping in the Minute Book registry
const DEFAULT_SECTION_NAME = Deno.env.get("DEFAULT_MINUTE_BOOK_SECTION_NAME") ?? "Governance";

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

  // NEW: allow caller to override where this lands in Minute Book
  domain_key?: string;     // must exist in governance_domains.key
  section_name?: string;   // e.g. "Resolutions"
};

async function readInvokeErrorDetails(err: unknown): Promise<unknown> {
  try {
    const resp = (err as any)?.context as Response | undefined;
    if (resp) {
      // Try json first
      try {
        return await resp.clone().json();
      } catch {
        const t = await resp.clone().text();
        return t?.slice(0, 2000);
      }
    }
  } catch {
    // ignore
  }
  return null;
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  try {
    const body = (await req.json().catch(() => ({}))) as ReqBody;
    const envelope_id = body.envelope_id;

    if (!envelope_id) {
      return json({ ok: false, error: "Missing envelope_id in request body." }, 400);
    }

    // 1) Envelope: we need record_id + storage_path
    const { data: envelope, error: envErr } = await supabase
      .from("signature_envelopes")
      .select("id, status, record_id, storage_path, is_test")
      .eq("id", envelope_id)
      .maybeSingle();

    if (envErr) {
      console.error("archive-signed-resolution: envelope lookup error", envErr);
      return json({ ok: false, error: "Failed to look up signature envelope." }, 500);
    }
    if (!envelope) {
      return json({ ok: false, error: "No signature envelope found for this ID." }, 404);
    }
    if (envelope.status !== "completed") {
      return json(
        { ok: false, error: "Envelope is not completed yet. Wait for signature before archiving." },
        400,
      );
    }
    if (!envelope.storage_path) {
      return json(
        { ok: false, error: "Envelope has no storage_path for the signed PDF. Cannot archive." },
        400,
      );
    }
    if (!envelope.record_id) {
      return json(
        { ok: false, error: "Envelope is missing record_id (governance_ledger link). Cannot archive." },
        400,
      );
    }

    const record_id = envelope.record_id as string;

    // 2) Ledger lookup (for lane + entity + title)
    // NOTE: we do NOT update anything here (TRUTH LANE LOCKED stays sacred).
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
      return json({ ok: false, error: "No governance_ledger record found for envelope.record_id." }, 404);
    }

    // 3) Determine lane + domain placement
    const lane_is_test = (ledger.is_test ?? envelope.is_test ?? false) as boolean;

    // domain_key is REQUIRED by minute_book_entries (NOT NULL)
    // Priority: request override -> (future: ledger.domain_key if you add it) -> env default
    const domain_key = (body.domain_key?.trim() || DEFAULT_DOMAIN_KEY).trim();

    // section_name is optional but helps the registry UI
    const section_name = (body.section_name?.trim() || DEFAULT_SECTION_NAME).trim();

    // 4) Download signed PDF bytes
    const { data: file, error: downloadErr } = await supabase.storage
      .from(SIGNED_BUCKET)
      .download(envelope.storage_path);

    if (downloadErr || !file) {
      console.error("archive-signed-resolution: failed to download PDF", downloadErr);
      return json(
        { ok: false, error: "Failed to download signed PDF from storage. Check bucket + storage_path." },
        500,
      );
    }

    const pdf_base64 = arrayBufferToBase64(await file.arrayBuffer());

    // 5) Invoke ingest layer (archive-save-document)
    // We pass the REQUIRED domain_key + lane flag so it lands correctly in RoT vs SANDBOX.
    const { data: archiveData, error: archiveErr } =
      await supabase.functions.invoke<ArchiveSaveDocumentResponse>("archive-save-document", {
        body: {
          // required by archive-save-document
          source_record_id: record_id,
          pdf_base64,

          // lane + placement (this is the fix)
          is_test: lane_is_test,
          domain_key,
          section_name,

          // useful metadata for the insert (if your ingest uses it)
          title: ledger.title ?? "Signed Resolution",
          entity_id: ledger.entity_id,
          envelope_id: envelope_id,

          // traceability
          bucket: SIGNED_BUCKET,
          storage_path: envelope.storage_path,
        },
      });

    if (archiveErr) {
      const extra = await readInvokeErrorDetails(archiveErr);
      console.error("archive-signed-resolution: archive-save-document error", archiveErr, extra);

      return json(
        {
          ok: false,
          error:
            (extra as any)?.error ??
            (archiveErr as any)?.message ??
            "archive-save-document failed while archiving the signed PDF.",
          details: extra ?? null,
        },
        400,
      );
    }

    if (!archiveData?.ok) {
      console.error("archive-signed-resolution: archive-save-document returned ok=false", archiveData);
      return json(
        {
          ok: false,
          error: archiveData?.error ?? "archive-save-document returned ok=false while archiving.",
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
      { ok: false, error: err instanceof Error ? err.message : "Unexpected error in function." },
      500,
    );
  }
});
