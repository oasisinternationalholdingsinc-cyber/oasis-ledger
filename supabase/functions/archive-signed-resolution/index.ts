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

// Bucket that stores the signed PDFs produced by Forge
// (keep your default as minute_book if that’s where Forge writes)
const SIGNED_PDF_BUCKET = Deno.env.get("MINUTE_BOOK_BUCKET") ?? "minute_book";

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
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const envelope_id: string | undefined = body.envelope_id;

    if (!envelope_id) {
      return json({ ok: false, error: "Missing envelope_id in request body." }, 400);
    }

    // 1) Envelope lookup
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
    const record_id: string | null = envelope.record_id ?? null;
    if (!record_id) {
      return json(
        { ok: false, error: "Envelope is missing record_id (ledger link). Cannot archive." },
        400,
      );
    }

    // 2) Governance record lookup (LANE SOURCE OF TRUTH)
    const { data: ledger, error: glErr } = await supabase
      .from("governance_ledger")
      .select("id, is_test, entity_id, status, approved_by_council, title")
      .eq("id", record_id)
      .maybeSingle();

    if (glErr) {
      console.error("archive-signed-resolution: governance_ledger lookup error", glErr);
      return json({ ok: false, error: "Failed to look up governance record for envelope." }, 500);
    }
    if (!ledger) {
      return json(
        { ok: false, error: "No governance_ledger record found for envelope.record_id." },
        404,
      );
    }

    const lane_is_test = !!ledger.is_test;

    // IMPORTANT: envelope.is_test may be wrong/immutable after completion.
    // We DO NOT use it for lane decisions.
    if (envelope.is_test !== null && envelope.is_test !== undefined) {
      if (Boolean(envelope.is_test) !== lane_is_test) {
        console.warn(
          "archive-signed-resolution: lane mismatch detected. Using governance_ledger.is_test as canonical.",
          {
            envelope_id: envelope.id,
            envelope_is_test: envelope.is_test,
            ledger_id: ledger.id,
            ledger_is_test: ledger.is_test,
          },
        );
      }
    }

    // 3) Download signed PDF
    const { data: file, error: downloadErr } = await supabase.storage
      .from(SIGNED_PDF_BUCKET)
      .download(envelope.storage_path);

    if (downloadErr || !file) {
      console.error("archive-signed-resolution: failed to download PDF", downloadErr);
      return json(
        {
          ok: false,
          error:
            "Failed to download signed PDF from storage. Check bucket + storage_path.",
          bucket: SIGNED_PDF_BUCKET,
          storage_path: envelope.storage_path,
        },
        500,
      );
    }

    const pdf_base64 = arrayBufferToBase64(await file.arrayBuffer());

    // 4) Invoke archive-save-document with LANE CONTEXT FROM LEDGER
    const { data: archiveData, error: archiveErr } =
      await supabase.functions.invoke<ArchiveSaveDocumentResponse>(
        "archive-save-document",
        {
          body: {
            source_record_id: ledger.id,
            pdf_base64,

            // Lane-safe context (THIS is the missing piece)
            is_test: lane_is_test,
            entity_id: ledger.entity_id,

            // Helpful forensic context
            envelope_id: envelope.id,
            signed_bucket: SIGNED_PDF_BUCKET,
            signed_storage_path: envelope.storage_path,
            ledger_status: ledger.status,
            approved_by_council: ledger.approved_by_council ?? null,
            title: ledger.title ?? null,
          },
        },
      );

    if (archiveErr) {
      // Better error surfacing: try read JSON from downstream
      let extra: any = null;
      try {
        const resp = (archiveErr as any).context as Response | undefined;
        if (resp) {
          try {
            extra = await resp.clone().json();
          } catch {
            extra = await resp.clone().text();
          }
        }
      } catch {
        // ignore
      }

      console.error("archive-signed-resolution: archive-save-document error", archiveErr, extra);

      return json(
        {
          ok: false,
          error:
            (typeof extra === "object" && extra?.error) ||
            (typeof extra === "string" && extra) ||
            archiveErr.message ||
            "archive-save-document failed while archiving the signed PDF.",
          details: extra ?? null,
        },
        400,
      );
    }

    if (!archiveData?.ok) {
      console.error("archive-signed-resolution: archive-save-document ok=false", archiveData);
      return json(
        {
          ok: false,
          error: archiveData?.error ?? "archive-save-document returned ok=false.",
        },
        400,
      );
    }

    return json({
      ok: true,
      minute_book_entry_id: archiveData.minute_book_entry_id ?? null,
      already_archived: archiveData.already_archived ?? false,
      lane: lane_is_test ? "SANDBOX" : "RoT",
    });
  } catch (err) {
    console.error("archive-signed-resolution: unexpected error", err);
    return json(
      { ok: false, error: err instanceof Error ? err.message : "Unexpected error." },
      500,
    );
  }
});
