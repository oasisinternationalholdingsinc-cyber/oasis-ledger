// supabase/functions/certify-governance-record/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument, rgb, StandardFonts } from "https://esm.sh/pdf-lib@1.17.1";

// ✅ Server-safe QR → SVG (NO canvas)
import QRCode from "https://esm.sh/qrcode-svg@1.1.0";

// ✅ SVG → PNG in Deno (NO canvas)
import { initialize, svg2png } from "https://esm.sh/svg2png-wasm@1.4.1";

type ReqBody = {
  ledger_id?: string;
  record_id?: string; // alias
  actor_id?: string;

  force?: boolean;
  verify_base_url?: string;
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
  details?: unknown;
  request_id?: string | null;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");

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

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const arr = new Uint8Array(digest);
  let hex = "";
  for (const b of arr) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function buildVerifyUrl(base: string, verifiedId: string, ledgerId: string) {
  const u = new URL(base);
  u.searchParams.set("verified_id", verifiedId);
  u.searchParams.set("ledger_id", ledgerId);
  return u.toString();
}

async function resolveActorIdFromJwt(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("authorization") ?? req.headers.get("Authorization");
  const jwt = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) return null;

  const { data, error } = await supabaseAdmin.auth.getUser(jwt);
  if (error) return null;

  const id = data?.user?.id ?? null;
  return id && isUuid(id) ? id : null;
}

/**
 * ✅ Resolve minute_book PDF WITHOUT storage.objects (PostgREST blocks it)
 * 1) signature_envelopes paths
 * 2) supporting_documents primary pointer
 */
async function resolveMinuteBookSourcePdf(ledgerId: string): Promise<string | null> {
  const env = await supabaseAdmin
    .from("signature_envelopes")
    .select("status,storage_path,supporting_document_path,certificate_path,created_at")
    .eq("record_id", ledgerId)
    .order("created_at", { ascending: false })
    .limit(10);

  if (env.error) throw env.error;

  const envRows = (env.data ?? []) as any[];
  const completed = envRows.find((r) => String(r.status) === "completed") ?? envRows[0];

  const candidates = [
    safeText(completed?.supporting_document_path),
    safeText(completed?.storage_path),
    safeText(completed?.certificate_path),
  ].filter(Boolean) as string[];

  const pdfFromEnv = candidates.find((p) => p.toLowerCase().endsWith(".pdf"));
  if (pdfFromEnv) return pdfFromEnv;

  const sd = await supabaseAdmin
    .from("supporting_documents")
    .select("storage_bucket,storage_path,is_primary,created_at,source_table,source_record_id")
    .eq("storage_bucket", "minute_book")
    .eq("source_table", "governance_ledger")
    .eq("source_record_id", ledgerId)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(25);

  if (sd.error) throw sd.error;

  const sdRows = (sd.data ?? []) as any[];
  const pick =
    sdRows.find((r) => r.is_primary === true && safeText(r.storage_path)?.toLowerCase().endsWith(".pdf")) ??
    sdRows.find((r) => safeText(r.storage_path)?.toLowerCase().includes("-signed.pdf")) ??
    sdRows.find((r) => safeText(r.storage_path)?.toLowerCase().endsWith(".pdf")) ??
    sdRows[0];

  return safeText(pick?.storage_path);
}

// -----------------------------------------------------------------------------
// ✅ QR generation (Edge-safe): URL → SVG → PNG bytes
// -----------------------------------------------------------------------------
let svgWasmReady = false;

async function qrPngBytes(verifyUrl: string, sizePx: number): Promise<Uint8Array> {
  // qrcode-svg returns an SVG string
  const qr = new QRCode({
    content: verifyUrl,
    padding: 0,
    width: sizePx,
    height: sizePx,
    ecl: "M",
    color: "#000000",
    background: "#ffffff",
  });

  const svg = qr.svg(); // string

  // Initialize wasm once
  if (!svgWasmReady) {
    // svg2png-wasm fetches its wasm internally; initialize once per isolate
    await initialize(fetch);
    svgWasmReady = true;
  }

  const png = await svg2png(svg, { width: sizePx, height: sizePx });
  return new Uint8Array(png);
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

    let actorId = safeText(body.actor_id);
    if (actorId && !isUuid(actorId)) {
      return json({ ok: false, error: "actor_id must be uuid", request_id: reqId }, 400);
    }
    if (!actorId) actorId = await resolveActorIdFromJwt(req);
    if (!actorId) return json({ ok: false, error: "ACTOR_REQUIRED", request_id: reqId }, 401);

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

    // 2) entity slug
    const ent = await supabaseAdmin.from("entities").select("id, slug").eq("id", entity_id).maybeSingle();
    if (ent.error) return json({ ok: false, error: ent.error.message, request_id: reqId }, 400);
    if (!ent.data?.id) return json({ ok: false, error: "ENTITY_NOT_FOUND", request_id: reqId }, 404);
    const entity_slug = String((ent.data as any).slug);

    // 3) Existing verified doc
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

    const certified_bucket = is_test ? "governance_sandbox" : "governance_truth";
    const certified_path = is_test ? `sandbox/archive/${ledgerId}.pdf` : `truth/archive/${ledgerId}.pdf`;

    if (!force && existingId && existingHash && (existingLevel ?? "").toLowerCase() === "certified") {
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
          certified: { bucket: certified_bucket, path: certified_path, file_hash: existingHash, file_size: 0 },
          request_id: reqId,
        });
      }
    }

    // 4) Resolve source PDF in minute_book
    const source_bucket = "minute_book";
    const source_path = await resolveMinuteBookSourcePdf(ledgerId);

    if (!source_path) {
      return json(
        {
          ok: false,
          error: "SOURCE_PDF_NOT_FOUND",
          details:
            "No minute_book PDF pointer found. If this was a signing flow, the envelope likely completed without ensure_pdf=true. Re-run start-signature-envelope with ensure_pdf=true to generate the base PDF.",
          request_id: reqId,
        },
        404,
      );
    }

    // 5) Ensure verified_documents row exists (need id for QR)
    let verified_id = existingId;

    if (!verified_id) {
      // ✅ DO NOT write generated columns (source_storage_bucket/source_storage_path)
      const ins = await supabaseAdmin
        .from("verified_documents")
        .insert({
          entity_id,
          entity_slug,
          document_class: "resolution",
          title,
          source_table: "governance_ledger",
          source_record_id: ledgerId,
          storage_bucket: certified_bucket,
          storage_path: certified_path,
          file_hash: null,
          mime_type: "application/pdf",
          verification_level: "certified",
          is_archived: true,
          created_by: actorId,
          updated_by: actorId,
        } as any)
        .select("id")
        .single();

      if (ins.error) return json({ ok: false, error: "VERIFIED_DOC_INSERT_FAILED", details: ins.error, request_id: reqId }, 500);
      verified_id = String(ins.data.id);
    }

    // 6) Download source PDF
    const dl = await supabaseAdmin.storage.from(source_bucket).download(source_path);
    if (dl.error || !dl.data) {
      return json({ ok: false, error: "SOURCE_PDF_DOWNLOAD_FAILED", details: dl.error, request_id: reqId }, 500);
    }
    const sourceBytes = new Uint8Array(await dl.data.arrayBuffer());

    // 7) QR URL
    const verifyBase =
      safeText(body.verify_base_url) ??
      Deno.env.get("VERIFY_BASE_URL") ??
      "https://portal.oasisintlholdings.com/verify";

    const verifyUrl = buildVerifyUrl(verifyBase, verified_id!, ledgerId);

    // ✅ Generate PNG bytes (NO canvas)
    const qrPng = await qrPngBytes(verifyUrl, 256);

    // 8) Stamp QR bottom-right on last page (wet signature preserved)
    const pdfDoc = await PDFDocument.load(sourceBytes);
    const pages = pdfDoc.getPages();
    const last = pages[pages.length - 1];

    const qrImage = await pdfDoc.embedPng(qrPng);

    const qrSize = 92;
    const margin = 50;
    const x = last.getWidth() - margin - qrSize;
    const y = margin + 24;

    last.drawImage(qrImage, { x, y, width: qrSize, height: qrSize });

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

    // 9) Upload certified PDF
    const up = await supabaseAdmin.storage
      .from(certified_bucket)
      .upload(certified_path, new Blob([certifiedBytes], { type: "application/pdf" }), {
        upsert: true,
        contentType: "application/pdf",
      });

    if (up.error) return json({ ok: false, error: "CERTIFIED_PDF_UPLOAD_FAILED", details: up.error, request_id: reqId }, 500);

    // 10) Update verified_documents canonical pointer + hash
    // ✅ DO NOT update generated columns
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
        updated_at: new Date().toISOString(),
        updated_by: actorId,
      } as any)
      .eq("id", verified_id);

    if (upd.error) return json({ ok: false, error: "VERIFIED_DOC_UPDATE_FAILED", details: upd.error, request_id: reqId }, 500);

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
      request_id: reqId,
    });
  } catch (e: any) {
    console.error("certify-governance-record fatal:", e);
    return json(
      {
        ok: false,
        error: "CERTIFY_FATAL",
        details: String(e?.message ?? e),
        request_id: req.headers.get("x-sb-request-id") ?? null,
      } satisfies Resp,
      500,
    );
  }
});
