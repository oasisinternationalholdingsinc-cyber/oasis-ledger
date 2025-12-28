import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing Supabase env");
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

const BUCKET = Deno.env.get("MINUTE_BOOK_BUCKET") ?? "minute_book";

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

function asString(v: unknown) {
  return typeof v === "string" ? v.trim() : "";
}

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return json({ ok: false, error: "POST required" }, 405);
  }

  const body = (await req.json().catch(() => null)) as {
    envelope_id?: string;
    domain_key?: string;
    section_name?: string;
  } | null;

  if (!body?.envelope_id) {
    return json({ ok: false, error: "Missing envelope_id" }, 400);
  }

  // ─────────────────────────────────────────────
  // Load envelope
  // ─────────────────────────────────────────────
  const { data: env, error: envErr } = await supabase
    .from("signature_envelopes")
    .select("id, status, record_id, storage_path")
    .eq("id", body.envelope_id)
    .maybeSingle();

  if (envErr || !env) {
    return json({ ok: false, error: "Envelope not found" }, 404);
  }

  if (env.status !== "completed") {
    return json({ ok: false, error: "Envelope not completed" }, 400);
  }

  if (!env.storage_path || !env.record_id) {
    return json({ ok: false, error: "Envelope missing required data" }, 400);
  }

  // ─────────────────────────────────────────────
  // Download signed PDF
  // ─────────────────────────────────────────────
  const { data: file, error: dlErr } = await supabase.storage
    .from(BUCKET)
    .download(env.storage_path);

  if (dlErr || !file) {
    return json({ ok: false, error: "Failed to download signed PDF" }, 500);
  }

  const pdf_base64 = bufferToBase64(await file.arrayBuffer());

  // ─────────────────────────────────────────────
  // Call archive-save-document (single source of truth)
  // ─────────────────────────────────────────────
  const { data, error } = await supabase.functions.invoke(
    "archive-save-document",
    {
      body: {
        source_record_id: env.record_id,
        pdf_base64,
        domain_key: body.domain_key,
        section_name: body.section_name,
        envelope_id: env.id,
      },
    },
  );

  if (error || !data?.ok) {
    return json(
      {
        ok: false,
        error: "Archive failed",
        details: data ?? error?.message ?? null,
      },
      400,
    );
  }

  return json({
    ok: true,
    minute_book_entry_id: data.minute_book_entry_id,
    already_archived: data.already_archived ?? false,
    envelope_id: env.id,
  });
});
