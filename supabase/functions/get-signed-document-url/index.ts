// supabase/functions/get-signed-document-url/index.ts
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
    const bucket: string | undefined = body.bucket;
    const storage_path: string | undefined =
      body.storage_path ?? body.storagePath;

    if (!bucket || !storage_path) {
      return json(
        {
          ok: false,
          error: "bucket and storage_path are required in the request body.",
        },
        400,
      );
    }

    const { data, error } = await supabase.storage
      .from(bucket)
      .createSignedUrl(storage_path, 60 * 60); // 1 hour

    if (error) {
      console.error("get-signed-document-url: storage error", error);
      return json(
        { ok: false, error: "Failed to create signed URL for this document." },
        500,
      );
    }

    if (!data?.signedUrl) {
      return json(
        { ok: false, error: "No signed URL returned from storage API." },
        500,
      );
    }

    return json({ ok: true, signed_url: data.signedUrl });
  } catch (err) {
    console.error("get-signed-document-url: unexpected error", err);
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
