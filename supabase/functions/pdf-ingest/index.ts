// supabase/functions/pdf-ingest/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { crypto } from "https://deno.land/std@0.224.0/crypto/mod.ts";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
serve(async (req)=>{
  let body = {};
  try {
    body = await req.json();
  } catch  {}
  const { source = "governance_document", document_id } = body ?? {};
  if (!document_id) {
    return new Response(JSON.stringify({
      error: "document_id required"
    }), {
      status: 400
    });
  }
  // 1) fetch row
  const table = source === "minute_book_supporting" ? "supporting_documents" : "governance_documents";
  const { data: doc, error } = await client.from(table).select("id, storage_path, file_size, file_hash").eq("id", document_id).single();
  if (error || !doc) {
    return new Response(JSON.stringify({
      error: "not found",
      details: error
    }), {
      status: 404
    });
  }
  // 2) download from storage
  const bucket = Deno.env.get("LEDGER_FILES_BUCKET") ?? "minute_book";
  const { data: file, error: downloadError } = await client.storage.from(bucket).download(doc.storage_path);
  if (downloadError || !file) {
    return new Response(JSON.stringify({
      error: "download_failed",
      details: downloadError
    }), {
      status: 500
    });
  }
  const buf = await file.arrayBuffer();
  const size = buf.byteLength;
  // 3) hash
  const hashBuffer = await crypto.subtle.digest("SHA-256", buf);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b)=>b.toString(16).padStart(2, "0")).join("");
  // 4) update row
  const { error: updateError } = await client.from(table).update({
    file_hash: hashHex,
    file_size: size
  }).eq("id", document_id);
  if (updateError) {
    return new Response(JSON.stringify({
      error: "update_failed",
      details: updateError
    }), {
      status: 500
    });
  }
  return new Response(JSON.stringify({
    ok: true,
    size,
    hash: hashHex
  }), {
    status: 200
  });
});
