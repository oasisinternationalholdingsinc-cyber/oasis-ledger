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

const MINUTE_BOOK_BUCKET =
  Deno.env.get("MINUTE_BOOK_BUCKET") ?? "minute_book";

const corsHeaders: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
}

// Helper: convert ArrayBuffer -> base64
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

type ArchiveSaveDocumentResponse = {
  ok: boolean;
  minute_book_entry_id?: string;
  already_archived?: boolean;
  error?: string;
};

serve(async (req: Request): Promise<Response> => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const envelope_id: string | undefined = body.envelope_id;

    if (!envelope_id) {
      return json(
        { ok: false, error: "Missing envelope_id in request body." },
        400,
      );
    }

    // 1) Look up the envelope: we need record_id + storage_path
    const { data: envelope, error: envErr } = await supabase
      .from("signature_envelopes")
      .select("id, status, record_id, storage_path")
      .eq("id", envelope_id)
      .maybeSingle();

    if (envErr) {
      console.error("archive-signed-resolution: envelope lookup error", envErr);
      return json(
        { ok: false, error: "Failed to look up signature envelope." },
        500,
      );
    }

    if (!envelope) {
      return json(
        { ok: false, error: "No signature envelope found for this ID." },
        404,
      );
    }

    if (envelope.status !== "completed") {
      return json(
        {
          ok: false,
          error:
            "Envelope is not completed yet. Wait for signature before archiving.",
        },
        400,
      );
    }

    if (!envelope.storage_path) {
      return json(
        {
          ok: false,
          error:
            "Envelope has no storage_path for the signed PDF. Cannot archive.",
        },
        400,
      );
    }

    const governance_document_id: string | null = envelope.record_id ?? null;

    if (!governance_document_id) {
      return json(
        {
          ok: false,
          error:
            "Envelope is missing record_id (governance document link). Cannot archive.",
        },
        400,
      );
    }

    // 2) Download the signed PDF from storage
    const { data: file, error: downloadErr } = await supabase.storage
      .from(MINUTE_BOOK_BUCKET)
      .download(envelope.storage_path);

    if (downloadErr || !file) {
      console.error(
        "archive-signed-resolution: failed to download PDF",
        downloadErr,
      );
      return json(
        {
          ok: false,
          error:
            "Failed to download signed PDF from storage for archiving. Check storage_path and bucket.",
        },
        500,
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const pdf_base64 = arrayBufferToBase64(arrayBuffer);

    // 3) Call ingest layer: archive-save-document
    const { data: archiveData, error: archiveErr } =
      await supabase.functions.invoke<ArchiveSaveDocumentResponse>(
        "archive-save-document",
        {
          body: {
            // Required by current archive-save-document implementation
            source_record_id: governance_document_id,
            pdf_base64,

            // Extra context (non-required but useful)
            bucket: MINUTE_BOOK_BUCKET,
            storagePath: envelope.storage_path,
            envelope_id,
          },
        },
      );

    if (archiveErr) {
      let extra: any = null;
      try {
        const resp = (archiveErr as any).context as Response | undefined;
        if (resp && !resp.bodyUsed) {
          extra = await resp.json();
        }
      } catch {
        // ignore JSON parse failure
      }

      console.error(
        "archive-signed-resolution: archive-save-document error",
        archiveErr,
        extra,
      );

      return json(
        {
          ok: false,
          error:
            extra?.error ??
            archiveErr.message ??
            "archive-save-document failed while archiving the signed PDF.",
        },
        400,
      );
    }

    if (!archiveData?.ok) {
      console.error(
        "archive-signed-resolution: archive-save-document returned ok=false",
        archiveData,
      );
      return json(
        {
          ok: false,
          error:
            archiveData?.error ??
            "archive-save-document returned ok=false while archiving.",
        },
        400,
      );
    }

    // 4) Normalize response for CI-Forge
    return json({
      ok: true,
      minute_book_entry_id: archiveData.minute_book_entry_id ?? null,
      already_archived: archiveData.already_archived ?? false,
    });
  } catch (err) {
    console.error("archive-signed-resolution: unexpected error", err);
    return json(
      {
        ok: false,
        error:
          err instanceof Error ? err.message : "Unexpected error in function.",
      },
      500,
    );
  }
});
