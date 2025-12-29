import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false }, 405);

  const {
    source_record_id,
    pdf_base64,
    title,
    entity_id,
    entity_key,
    is_test,
    domain_key,
    section_name,
    bucket,
  } = await req.json();

  if (!pdf_base64 || !entity_id || !entity_key) {
    return json(
      { ok: false, error: "Missing required fields" },
      400
    );
  }

  const bytes = Uint8Array.from(atob(pdf_base64), (c) =>
    c.charCodeAt(0)
  );

  const hashBuf = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const date = new Date().toISOString().slice(0, 10);
  const storage_path = `${entity_key}/${domain_key}/resolution/${date}/${hash}.pdf`;

  const { error: uploadErr } = await supabase.storage
    .from(bucket)
    .upload(storage_path, bytes, {
      contentType: "application/pdf",
      upsert: false,
    });

  if (uploadErr) {
    return json(
      { ok: false, error: "Storage upload failed", details: uploadErr.message },
      500
    );
  }

  const { data: entry, error: entryErr } = await supabase
    .from("minute_book_entries")
    .insert({
      entity_id,
      entity_key,
      domain_key,
      section_name,
      title,
      source_record_id,
      is_test,
    })
    .select("id")
    .maybeSingle();

  if (entryErr || !entry) {
    return json(
      { ok: false, error: "Failed to create minute book entry" },
      500
    );
  }

  return json({
    ok: true,
    entry_id: entry.id,
    storage_path,
    file_hash: hash,
    file_size: bytes.length,
  });
});
