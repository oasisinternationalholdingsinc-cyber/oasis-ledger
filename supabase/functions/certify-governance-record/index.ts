// supabase/functions/certify-governance-record/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument, rgb, StandardFonts } from "https://esm.sh/pdf-lib@1.17.1";
import QRCode from "https://esm.sh/qrcode@1.5.3";

type ReqBody = {
  ledger_id?: string;
  record_id?: string; // tolerated alias
  actor_id?: string;

  // Optional controls
  force?: boolean; // regenerate even if already certified
  verify_base_url?: string; // override per-call (otherwise env)
};

type Resp = {
  ok: boolean;
  ledger_id?: string;
  actor_id?: string;
  is_test?: boolean;

  source?: { bucket: string; path: string };
  certified?: { bucket: string; path: string; file_hash: string; file_size: number };

  verified_document_id?: string;
  reused?: boolean;

  error?: string;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
}

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
  auth: { persistSession: false },
});

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
};

const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);

function safeText(v: unknown): string | null {
  if (v == null) return null;
  const t = String(v).trim();
  return t.length ? t : null;
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const m = dataUrl.match(/^data:.*?;base64,(.*)$/);
  const b64 = m?.[1] ?? "";
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const arr = new Uint8Array(digest);
  let hex = "";
  for (const b of arr) hex += b.toString(16).padStart(2, "0");
  return hex;
}

// Build a stable verify URL for QR.
// ✅ Enterprise approach: allow env override so you can change public gateway without rewiring PDFs.
function buildVerifyUrl(base: string, verifiedId: string, ledgerId: string) {
  // Use a conservative query that you can support in the public resolver.
  // You can choose to prioritize verified_id (best) while also including ledger_id.
  const u = new URL(base);
  u.searchParams.set("verified_id", verifiedId);
  u.searchParams.set("ledger_id", ledgerId);
  return u.toString();
}

serve(async (req) => {
  const reqId = req.headers.get("x-sb-request-id") ?? null;

  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return json({ ok: false, error: "POST only", request_id: reqId }, 405);

    const body = (await req.json().catch(() => ({}))) as ReqBody;

    const ledgerId = safeText(body.ledger_id ?? body.record_id);
    if (!ledgerId || !isUuid(ledgerId)) {
      return json({ ok: false, error: "ledger_id must be uuid", request_id: reqId }, 400);
    }

    // Actor: prefer body.actor_id; else resolve from user JWT if present.
    let actorId = safeText(body.actor_id);
    if (actorId && !isUuid(actorId)) {
      return json({ ok: false, error: "actor_id must be uuid", request_id: reqId }, 400);
    }

    if (!actorId) {
      const authHeader = req.headers.get("authorization") ?? req.headers.get("Authorization");
      const jwt = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

      if (jwt) {
        const { data, error } = await supabaseAdmin.auth.getUser(jwt);
        if (error) {
          return json({ ok: false, error: "Actor unresolved", request_id: reqId }, 401);
        }
        actorId = data?.user?.id ?? null;
      }
    }

    if (!actorId) {
      return json({ ok: false, error: "ACTOR_REQUIRED", request_id: reqId }, 401);
    }

    const force = !!body.force;

    // 1) Load ledger
    const gl = await supabaseAdmin
      .from("governance_ledger")
      .select("id, entity_id, title, is_test")
      .eq("id", ledgerId)
      .maybeSingle();

    if (gl.error) return json({ ok: false, error: gl.error.message, request_id: reqId }, 400);
    if (!gl.data?.id) return json({ ok: false, error: "LEDGER_NOT_FOUND", request_id: reqId }, 404);

    const is_test = !!(gl.data as any).is_test;
    const entity_id = String((gl.data as any).entity_id);
    const title = String((gl.data as any).title ?? "Untitled Resolution");

    // 2) Load entity
    const ent = await supabaseAdmin.from("entities").select("id, slug, name").eq("id", entity_id).maybeSingle();
    if (ent.error) return json({ ok: false, error: ent.error.message, request_id: reqId }, 400);
    if (!ent.data?.id) return json({ ok: false, error: "ENTITY_NOT_FOUND", request_id: reqId }, 404);

    const entity_slug = String((ent.data as any).slug);
    const entity_name = String((ent.data as any).name ?? entity_slug);

    // 3) Check if a verified row already exists and is already certified with file_hash
    const existingVd = await supabaseAdmin
      .from("verified_documents")
      .select("id, storage_bucket, storage_path, file_hash, verification_level")
      .eq("source_table", "governance_ledger")
      .eq("source_record_id", ledgerId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const existingId = existingVd.data?.id ? String(existingVd.data.id) : null;
    const existingHash = safeText((existingVd.data as any)?.file_hash);
    const existingLevel = safeText((existingVd.data as any)?.verification_level);

    // Our target certified location (lane-safe)
    const certified_bucket = is_test ? "governance_sandbox" : "governance_truth";
    const certified_path = is_test ? `sandbox/archive/${ledgerId}.pdf` : `truth/archive/${ledgerId}.pdf`;

    if (!force && existingId && existingHash && (existingLevel ?? "").toLowerCase() === "certified") {
      // If it already points to our certified location, we can short-circuit.
      const sb = safeText((existingVd.data as any)?.storage_bucket);
      const sp = safeText((existingVd.data as any)?.storage_path);
      if (sb === certified_bucket && sp === certified_path) {
        return json<Resp>({
          ok: true,
          reused: true,
          ledger_id: ledgerId,
          actor_id: actorId,
          is_test,
          verified_document_id: existingId,
          certified: {
            bucket: certified_bucket,
            path: certified_path,
            file_hash: existingHash,
            file_size: 0,
          },
        });
      }
    }

    // 4) Resolve source PDF from minute_book (prefer signed)
    const source_bucket = "minute_book";

    const src = await supabaseAdmin.rpc("resolve_minute_book_pdf_path", {
      // If you have this RPC; if not, we fallback to storage.objects query below.
      // Your screenshot shows resolve_minute_book_pdf_path(entity_key_enum, uuid) exists.
      // We cannot call it without knowing entity_key_enum type, so we do the safer storage.objects scan.
    } as any);

    // Fallback: storage.objects scan for this ledgerId
    const srcObj = await supabaseAdmin
      .from("storage.objects")
      .select("name, updated_at")
      .eq("bucket_id", source_bucket)
      .ilike("name", `%${ledgerId}%`)
      .ilike("name", `%.pdf%`)
      .order("updated_at", { ascending: false })
      .limit(25);

    if (srcObj.error) return json({ ok: false, error: srcObj.error.message, request_id: reqId }, 500);

    const candidates = (srcObj.data ?? []) as any[];
    const pick =
      candidates.find((o) => String(o.name).toLowerCase().includes("-signed.pdf")) ??
      candidates[0];

    if (!pick?.name) {
      return json(
        {
          ok: false,
          error: "SOURCE_PDF_NOT_FOUND_IN_MINUTE_BOOK",
          request_id: reqId,
        },
        404,
      );
    }

    const source_path = String(pick.name);

    // 5) Ensure we have a verified_documents row id BEFORE QR (so QR can encode verified_id)
    let verified_id = existingId;

    if (!verified_id) {
      const ins = await supabaseAdmin
        .from("verified_documents")
        .insert({
          entity_id,
          entity_slug,
          document_class: "resolution",
          title,
          source_table: "governance_ledger",
          source_record_id: ledgerId,
          // provisional — will be overwritten after upload
          storage_bucket: certified_bucket,
          storage_path: certified_path,
          file_hash: null,
          mime_type: "application/pdf",
          verification_level: "certified",
          is_archived: true,
          source_storage_bucket: source_bucket,
          source_storage_path: source_path,
          created_by: actorId,
          updated_by: actorId,
        } as any)
        .select("id")
        .single();

      if (ins.error) return json({ ok: false, error: ins.error.message, request_id: reqId }, 500);
      verified_id = String(ins.data.id);
    }

    // 6) Download source PDF
    const dl = await supabaseAdmin.storage.from(source_bucket).download(source_path);
    if (dl.error || !dl.data) {
      return json(
        { ok: false, error: "SOURCE_PDF_DOWNLOAD_FAILED", details: dl.error, request_id: reqId },
        500,
      );
    }

    const sourceBytes = new Uint8Array(await dl.data.arrayBuffer());

    // 7) Stamp QR into PDF (bottom-right)
    const verifyBase =
      safeText(body.verify_base_url) ??
      Deno.env.get("VERIFY_BASE_URL") ??
      // safe default (you can change later via env without changing PDF engine):
      "https://portal.oasisintlholdings.com/verify";

    const verifyUrl = buildVerifyUrl(verifyBase, verified_id!, ledgerId);

    const qrDataUrl = await QRCode.toDataURL(verifyUrl, {
      errorCorrectionLevel: "M",
      margin: 0,
      width: 256,
    });

    const qrBytes = dataUrlToBytes(qrDataUrl);

    const pdfDoc = await PDFDocument.load(sourceBytes);
    const pages = pdfDoc.getPages();
    const last = pages[pages.length - 1];

    const qrImage = await pdfDoc.embedPng(qrBytes);
    const qrSize = 92; // matches your old “bottom-right QR” feel
    const margin = 50;

    const w = last.getWidth();
    const h = last.getHeight();

    const x = w - margin - qrSize;
    const y = margin + 24; // lift slightly above bottom margin

    last.drawImage(qrImage, {
      x,
      y,
      width: qrSize,
      height: qrSize,
    });

    // Optional tiny label under QR (clean, not noisy)
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    last.drawText("Verify", {
      x: x + 24,
      y: y - 12,
      size: 8,
      font,
      color: rgb(0.35, 0.38, 0.45),
    });

    const certifiedBytes = new Uint8Array(await pdfDoc.save());
    const hashHex = await sha256Hex(certifiedBytes);

    // 8) Upload certified PDF (lane-safe bucket)
    const up = await supabaseAdmin.storage
      .from(certified_bucket)
      .upload(certified_path, new Blob([certifiedBytes], { type: "application/pdf" }), {
        upsert: true,
        contentType: "application/pdf",
      });

    if (up.error) {
      return json(
        { ok: false, error: "CERTIFIED_PDF_UPLOAD_FAILED", details: up.error, request_id: reqId },
        500,
      );
    }

    // 9) Update verified_documents with canonical hash + certified location
    const upd = await supabaseAdmin
      .from("verified_documents")
      .update({
        entity_id,
        entity_slug,
        title,
        storage_bucket: certified_bucket,
        storage_path: certified_path,
        file_hash: hashHex,
        mime_type: "application/pdf",
        verification_level: "certified",
        is_archived: true,
        source_storage_bucket: source_bucket,
        source_storage_path: source_path,
        updated_at: new Date().toISOString(),
        updated_by: actorId,
      } as any)
      .eq("id", verified_id);

    if (upd.error) {
      return json({ ok: false, error: "VERIFIED_DOC_UPDATE_FAILED", details: upd.error, request_id: reqId }, 500);
    }

    return json<Resp>({
      ok: true,
      ledger_id: ledgerId,
      actor_id: actorId,
      is_test,
      verified_document_id: verified_id!,
      source: { bucket: source_bucket, path: source_path },
      certified: {
        bucket: certified_bucket,
        path: certified_path,
        file_hash: hashHex,
        file_size: certifiedBytes.length,
      },
    });
  } catch (e: any) {
    console.error("certify-governance-record fatal:", e);
    return json(
      {
        ok: false,
        error: "CERTIFY_FATAL",
        message: String(e?.message ?? e),
      },
      500,
    );
  }
});
