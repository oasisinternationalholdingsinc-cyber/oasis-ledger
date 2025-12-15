// supabase/functions/download-signed-pdf/index.ts
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

const DEFAULT_BUCKET =
  Deno.env.get("MINUTE_BOOK_BUCKET") ?? "minute_book";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
    },
  });
}

function safeFileName(title: string | null | undefined): string {
  if (!title) return "Oasis-Signed-Document.pdf";
  return (
    title
      .replace(/["']/g, "")
      .replace(/[^a-zA-Z0-9\- ]/g, "")
      .trim()
      .replace(/\s+/g, "-") + ".pdf"
  );
}

serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });

  try {
    const url = new URL(req.url);
    const hashParam = url.searchParams.get("hash");

    if (!hashParam) {
      return json(
        {
          ok: false,
          error: "MISSING_HASH",
          message: "Expected ?hash=<sha256> in query string.",
        },
        400,
      );
    }

    const requestedHash = hashParam.toLowerCase();

    const { data: verifiedDoc, error: vdError } = await supabase
      .from("verified_documents")
      .select("*")
      .eq("file_hash", requestedHash)
      .eq("is_archived", false)
      .maybeSingle();

    if (vdError) {
      console.error("verified_documents query error", vdError);
      return json(
        {
          ok: false,
          error: "VERIFIED_DOCUMENTS_QUERY_FAILED",
          message: vdError.message,
        },
        500,
      );
    }

    if (!verifiedDoc) {
      return json(
        {
          ok: false,
          error: "NOT_REGISTERED",
          message: "No verified document found for this hash.",
        },
        404,
      );
    }

    const bucket: string = verifiedDoc.storage_bucket ?? DEFAULT_BUCKET;
    const storagePath: string = verifiedDoc.storage_path;

    const { data: file, error: downloadError } = await supabase.storage
      .from(bucket)
      .download(storagePath);

    if (downloadError) {
      console.error("storage download error", downloadError);
      return json(
        {
          ok: false,
          error: "STORAGE_DOWNLOAD_FAILED",
          message: downloadError.message,
          bucket,
          storage_path: storagePath,
        },
        500,
      );
    }

    const pdfBytes = await file.arrayBuffer();
    const filename = safeFileName(verifiedDoc.title);

    return new Response(pdfBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    console.error("download-signed-pdf fatal error", err);
    return json(
      {
        ok: false,
        error: "UNEXPECTED_ERROR",
        message: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});
