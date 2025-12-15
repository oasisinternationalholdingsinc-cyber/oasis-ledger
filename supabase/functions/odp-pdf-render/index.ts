import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

// 🪣 matches your production bucket
const BUCKET = "minute_book";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed. Use POST." }, 405);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json(
      { ok: false, error: "Invalid JSON body. Expected envelope_id." },
      400,
    );
  }

  const envelopeId = body?.envelope_id as string | undefined;
  if (!envelopeId) {
    return json(
      { ok: false, error: "Missing envelope_id in request body." },
      400,
    );
  }

  // 1️⃣ Look up envelope metadata
  const { data: envelope, error: envelopeError } = await supabase
    .from("signature_envelopes")
    .select(
      `
        id,
        entity_id,
        entity_name,
        entity_slug,
        record_type,
        record_id,
        storage_path,
        storage_hash,
        created_at,
        updated_at
      `,
    )
    .eq("id", envelopeId)
    .single();

  if (envelopeError || !envelope) {
    return json(
      {
        ok: false,
        error: "Envelope not found.",
        details: envelopeError?.message ?? null,
      },
      404,
    );
  }

  const storagePath = (envelope as any).storage_path as string | null;
  if (!storagePath) {
    return json(
      {
        ok: false,
        error:
          "Envelope has no storage_path. Make sure the signed PDF has been downloaded and saved to Storage.",
      },
      400,
    );
  }

  const entitySlug =
    (envelope as any).entity_slug ??
    (envelope as any).entity_name ??
    "holdings";
  const recordType = (envelope as any).record_type ?? "Resolution";
  const recordId = (envelope as any).record_id ?? envelope.id;

  // 2️⃣ Ensure a minute_book_entries row exists (idempotent)
  //    We treat storage_path as the natural key
  const { data: existingRows, error: existingError } = await supabase
    .from("minute_book_entries")
    .select("id")
    .eq("storage_path", storagePath)
    .limit(1);

  if (existingError) {
    console.warn("minute_book_entries lookup error:", existingError.message);
  }

  if (!existingRows || existingRows.length === 0) {
    const today = new Date().toISOString().slice(0, 10);

    const { error: insertError } = await supabase
      .from("minute_book_entries")
      .insert([
        {
          entity_key: entitySlug,
          entry_date: today,
          title: `${recordType} – ${recordId}`,
          notes: "Auto-archived signed PDF from CI-Forge.",
          section_name: "Resolutions",
          storage_path: storagePath,
          source: "signature_envelope",
        },
      ]);

    if (insertError) {
      // Not fatal for the client – but we log it so you can see it in logs
      console.error(
        "Failed to insert minute_book_entries row:",
        insertError.message,
      );
    }
  }

  // 3️⃣ Create a signed URL to the PDF
  const { data: signedUrlData, error: signedUrlError } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, 60 * 10); // 10 minutes

  if (signedUrlError || !signedUrlData?.signedUrl) {
    return json(
      {
        ok: false,
        error: "Failed to create signed URL for PDF.",
        details: signedUrlError?.message ?? null,
        bucket: BUCKET,
        storage_path: storagePath,
      },
      500,
    );
  }

  return json({
    ok: true,
    message: "Signed PDF archived to minute book and ready.",
    envelope_id: envelope.id,
    entity_slug: entitySlug,
    record_id: recordId,
    storage_path: storagePath,
    signed_url: signedUrlData.signedUrl,
  });
});
