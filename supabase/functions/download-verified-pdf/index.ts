// supabase/functions/download-verified-pdf/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization,apikey,content-type,x-client-info",
  "Access-Control-Expose-Headers": "content-type,x-sb-request-id,content-disposition",
};

const bad = (status: number, error: string, extra: any = {}) =>
  new Response(JSON.stringify({ ok: false, error, ...extra }, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "GET") return bad(405, "METHOD_NOT_ALLOWED");

  try {
    const url = new URL(req.url);
    const verified_document_id = url.searchParams.get("verified_document_id");
    const hash = url.searchParams.get("hash");

    if (!verified_document_id && !hash) {
      return bad(400, "Provide verified_document_id or hash");
    }

    let q = supabase.from("verified_documents").select(
      "id, storage_bucket, storage_path, mime_type, title, file_hash"
    );

    if (verified_document_id) q = q.eq("id", verified_document_id);
    else q = q.eq("file_hash", hash!);

    const { data: vd, error } = await q.maybeSingle();
    if (error) return bad(500, "DB_ERROR", { details: error });
    if (!vd) return bad(404, "NOT_FOUND");

    const { data: file, error: dlErr } = await supabase.storage
      .from(vd.storage_bucket)
      .download(vd.storage_path);

    if (dlErr || !file) return bad(404, "OBJECT_NOT_FOUND", { details: dlErr });

    const filename =
      (vd.storage_path?.split("/").pop() ?? "verified.pdf").replace(/"/g, "");

    return new Response(file.stream(), {
      status: 200,
      headers: {
        ...cors,
        "Content-Type": vd.mime_type || "application/pdf",
        "Content-Disposition": `inline; filename="${filename}"`,
        "X-Verified-Hash": vd.file_hash ?? "",
      },
    });
  } catch (e) {
    console.error(e);
    return bad(500, "UNEXPECTED");
  }
});
