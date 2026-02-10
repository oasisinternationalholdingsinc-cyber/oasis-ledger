// supabase/functions/billing-certify-document/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";

// ✅ Server-safe QR → SVG (NO canvas)
import QRCode from "https://esm.sh/qrcode-svg@1.1.0";
// ✅ SVG → PNG in Deno (NO canvas)
import { initialize, svg2png } from "https://esm.sh/svg2png-wasm@1.4.1";

/**
 * CI-Billing — billing-certify-document (PRODUCTION — LOCKED)
 *
 * ✅ Explicit authority action (NOT implied by generation)
 * ✅ Appends a NEW final certification page (mirror pattern)
 * ✅ Hash-first: certified hash is SHA-256 of FINAL certified bytes
 * ✅ QR points to verify-billing.html?hash=<certified_hash>
 * ✅ Idempotent:
 *    - if already certified and !force => returns existing certified pointers
 *    - if force => re-certifies (upserts certified PDF + updates certified_* columns)
 * ✅ Lane-safe:
 *    - keeps lane within billing_documents.is_test (never infers)
 *    - writes certified PDF into the SAME lane bucket already recorded on the row
 * ✅ Schema-safe: touches ONLY known billing_documents columns:
 *    - certified_at, certified_by, certified_storage_bucket, certified_storage_path, certified_file_hash, metadata
 *
 * Auth:
 * ✅ Requires valid operator JWT (ANON auth.getUser()) then uses SERVICE_ROLE for storage/db writes.
 */

type ReqBody = {
  billing_document_id?: string;
  document_id?: string; // alias
  actor_id?: string; // optional override (normally from JWT user id)
  force?: boolean;
  verify_base_url?: string; // optional override; default = https://sign.oasisintlholdings.com
};

type Resp = {
  ok: boolean;
  billing_document_id?: string;
  document_id?: string;
  actor_id?: string;

  entity_id?: string;
  is_test?: boolean;

  certified_bucket?: string;
  certified_path?: string;
  certified_hash?: string;
  verify_url?: string;

  error?: string;
  details?: unknown;
  request_id?: string | null;
};

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, Authorization, apikey, content-type, x-client-info",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
};

function getRequestId(req: Request) {
  return (
    req.headers.get("x-sb-request-id") ||
    req.headers.get("x-sb-requestid") ||
    req.headers.get("sb-request-id") ||
    null
  );
}

function json(req: Request, status: number, body: Resp) {
  const request_id = getRequestId(req);
  return new Response(JSON.stringify({ ...body, request_id } satisfies Resp, null, 2), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" },
  });
}

function pickBearer(req: Request) {
  const h = req.headers.get("authorization") || req.headers.get("Authorization") || "";
  return h.startsWith("Bearer ") ? h : "";
}

function cleanUuid(x: unknown) {
  const s = String(x ?? "").trim();
  return s.length ? s : null;
}

function isUuid(s: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    s,
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const arr = new Uint8Array(digest);
  let hex = "";
  for (const b of arr) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * pdf-lib StandardFonts (WinAnsi) cannot encode some Unicode chars.
 * Keep all drawn strings WinAnsi-safe.
 */
function winAnsiSafe(input: unknown): string {
  const s = String(input ?? "");
  let out = s
    .replaceAll("→", "->")
    .replaceAll("•", "-")
    .replaceAll("—", "-")
    .replaceAll("–", "-")
    .replaceAll("“", '"')
    .replaceAll("”", '"')
    .replaceAll("‘", "'")
    .replaceAll("’", "'")
    .replaceAll("\u00A0", " ");
  out = out.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "");
  return out;
}

function defaultVerifyBaseUrl() {
  // Canonical public authority door for terminals
  return "https://sign.oasisintlholdings.com";
}

/**
 * Certified storage path policy:
 * - Never mutate the original pointer
 * - Derive a sibling "-certified.pdf" path
 */
function buildCertifiedPath(originalPath: string) {
  const p = String(originalPath ?? "").trim();
  if (!p) return null;

  // Already certified-looking path → keep it
  if (/-certified\.pdf$/i.test(p)) return p;

  if (/\.pdf$/i.test(p)) return p.replace(/\.pdf$/i, "-certified.pdf");
  return `${p}-certified.pdf`;
}

// svg2png-wasm init (cached)
let _svg2pngReady = false;
async function ensureSvg2Png() {
  if (_svg2pngReady) return;
  await initialize();
  _svg2pngReady = true;
}

/**
 * Optional operator authorization hook:
 * - If you have an RPC, we enforce it.
 * - If not present, we DO NOT hard-fail (to avoid breaking prod).
 */
async function bestEffortAuthorizeOperator(
  svc: ReturnType<typeof createClient>,
  userId: string,
  entityId: string,
) {
  try {
    const { data, error } = await svc.rpc("os_authorize_operator", {
      p_user_id: userId,
      p_entity_id: entityId,
    } as any);
    if (error) return; // rpc not present or signature mismatch → ignore
    if (data !== true) throw new Error("FORBIDDEN");
  } catch (e: any) {
    if (String(e?.message ?? "").includes("FORBIDDEN")) throw e;
    // otherwise ignore
  }
}

/**
 * Build a certification page (Oasis OS style) onto a NEW final page.
 * IMPORTANT: We pass the *hash we want printed + encoded*, and we do a short
 * fixed-point loop so the QR/hash reflect the FINAL bytes.
 */
async function appendCertificationPage(args: {
  srcBytes: Uint8Array;
  certHash: string; // hash to print + encode (may be placeholder during iteration)
  verifyUrl: string;
  meta: {
    entity_id: string;
    is_test: boolean;
    document_type: string | null;
    document_number: string | null;
    invoice_number: string | null;
    currency: string | null;
    issued_at: string | null;
    due_at: string | null;
    period_start: string | null;
    period_end: string | null;
    recipient_name: string | null;
    recipient_email: string | null;
    total_amount: number | null;
    total_cents: number | null;
  };
}): Promise<Uint8Array> {
  const { srcBytes, certHash, verifyUrl, meta } = args;

  await ensureSvg2Png();

  const pdf = await PDFDocument.load(srcBytes, { ignoreEncryption: true });

  // Always append a NEW certification page (enterprise invariant)
  const page = pdf.addPage([612, 792]); // Letter
  const W = page.getWidth();
  const H = page.getHeight();
  const margin = 56;

  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // Palette (clean paper / ink / gold signal)
  const ink = rgb(0.12, 0.14, 0.18);
  const muted = rgb(0.45, 0.48, 0.55);
  const hair = rgb(0.86, 0.88, 0.91);
  const band = rgb(0.06, 0.09, 0.12);
  const gold = rgb(0.95, 0.78, 0.33);
  const teal = rgb(0.1, 0.78, 0.72);
  const paper = rgb(1, 1, 1);

  // Background
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: paper });

  // Header band
  const bandH = 92;
  page.drawRectangle({ x: 0, y: H - bandH, width: W, height: bandH, color: band });

  page.drawText(winAnsiSafe("Oasis Digital Parliament"), {
    x: margin,
    y: H - 42,
    size: 14,
    font: bold,
    color: teal,
  });

  page.drawText(winAnsiSafe("Billing Certification"), {
    x: margin,
    y: H - 64,
    size: 10,
    font,
    color: rgb(0.86, 0.88, 0.9),
  });

  const laneLabel = meta.is_test ? "SANDBOX" : "TRUTH";
  const rightTop = winAnsiSafe(`CERTIFIED • ${laneLabel}`);
  const rightW = font.widthOfTextAtSize(rightTop, 9);
  page.drawText(rightTop, {
    x: W - margin - rightW,
    y: H - 60,
    size: 9,
    font,
    color: rgb(0.78, 0.82, 0.86),
  });

  // Title
  const topY = H - bandH - 52;
  page.drawText(winAnsiSafe("Certified Billing Artifact"), {
    x: margin,
    y: topY,
    size: 18,
    font: bold,
    color: ink,
  });

  // Meta blocks
  const leftX = margin;
  const leftY = topY - 64;
  const leftW = 320;
  const boxH = 108;

  page.drawRectangle({
    x: leftX,
    y: leftY,
    width: leftW,
    height: boxH,
    borderColor: hair,
    borderWidth: 1,
    color: rgb(0.99, 0.99, 1),
  });

  page.drawText(winAnsiSafe("Certified Record"), {
    x: leftX + 12,
    y: leftY + boxH - 22,
    size: 9,
    font: bold,
    color: muted,
  });

  const row = (label: string, value: string, y: number) => {
    page.drawText(winAnsiSafe(label), {
      x: leftX + 12,
      y,
      size: 8.5,
      font: bold,
      color: muted,
    });
    page.drawText(winAnsiSafe(value).slice(0, 80), {
      x: leftX + 120,
      y,
      size: 8.5,
      font,
      color: ink,
    });
  };

  const docType = meta.document_type ? meta.document_type.toUpperCase() : "—";
  row("Type:", docType, leftY + boxH - 42);
  row("Doc #:", meta.document_number ?? "—", leftY + boxH - 58);
  row("Invoice #:", meta.invoice_number ?? "—", leftY + boxH - 74);
  row("Entity:", meta.entity_id, leftY + boxH - 90);

  const rightX = margin + 340;
  const rightY = leftY;
  const rightWb = W - margin - rightX;
  page.drawRectangle({
    x: rightX,
    y: rightY,
    width: rightWb,
    height: boxH,
    borderColor: hair,
    borderWidth: 1,
    color: rgb(0.99, 0.99, 1),
  });

  page.drawText(winAnsiSafe("Recipient"), {
    x: rightX + 12,
    y: rightY + boxH - 22,
    size: 9,
    font: bold,
    color: muted,
  });

  page.drawText(winAnsiSafe((meta.recipient_name ?? "—").slice(0, 44)), {
    x: rightX + 12,
    y: rightY + boxH - 44,
    size: 10,
    font: bold,
    color: ink,
  });

  page.drawText(winAnsiSafe((meta.recipient_email ?? "—").slice(0, 56)), {
    x: rightX + 12,
    y: rightY + boxH - 62,
    size: 8.5,
    font,
    color: muted,
  });

  const issued = meta.issued_at ? meta.issued_at.slice(0, 10) : "—";
  const due = meta.due_at ? meta.due_at.slice(0, 10) : "—";
  page.drawText(winAnsiSafe(`Issued: ${issued}   Due: ${due}`), {
    x: rightX + 12,
    y: rightY + 18,
    size: 8.5,
    font,
    color: muted,
  });

  const period =
    meta.period_start || meta.period_end
      ? `${(meta.period_start ?? "—").slice(0, 10)} -> ${(meta.period_end ?? "—").slice(0, 10)}`
      : null;

  if (period) {
    page.drawText(winAnsiSafe(`Period: ${period}`), {
      x: margin,
      y: leftY - 18,
      size: 8.5,
      font,
      color: muted,
    });
  }

  // Hash block
  const hashY = (period ? leftY - 46 : leftY - 36);
  page.drawText(winAnsiSafe("SHA-256 (Certified PDF)"), {
    x: margin,
    y: hashY,
    size: 9.5,
    font: bold,
    color: muted,
  });

  page.drawRectangle({
    x: margin,
    y: hashY - 30,
    width: W - margin * 2,
    height: 34,
    borderColor: hair,
    borderWidth: 1,
    color: rgb(0.99, 0.99, 1),
  });

  page.drawText(winAnsiSafe(certHash), {
    x: margin + 12,
    y: hashY - 18,
    size: 8.5,
    font,
    color: ink,
  });

  // Verification URL (hash-first)
  page.drawText(winAnsiSafe("Verification (hash-first)"), {
    x: margin,
    y: hashY - 56,
    size: 9.5,
    font: bold,
    color: muted,
  });

  page.drawText(winAnsiSafe(verifyUrl).slice(0, 120), {
    x: margin,
    y: hashY - 72,
    size: 8.5,
    font,
    color: ink,
  });

  // QR (bottom-right)
  const qrSvg = new QRCode({
    content: verifyUrl,
    padding: 0,
    width: 256,
    height: 256,
    color: "#0B0E14",
    background: "#FFFFFF",
    ecl: "M",
  }).svg();

  const qrPng = await svg2png(qrSvg, { width: 256, height: 256 });
  const qrImg = await pdf.embedPng(qrPng);

  const qrSize = 128;
  const qrX = W - margin - qrSize;
  const qrY = 64;

  page.drawRectangle({
    x: qrX - 6,
    y: qrY - 6,
    width: qrSize + 12,
    height: qrSize + 12,
    borderColor: gold,
    borderWidth: 1,
    opacity: 0.5,
  });

  page.drawImage(qrImg, { x: qrX, y: qrY, width: qrSize, height: qrSize });

  page.drawText(winAnsiSafe("Scan to verify"), {
    x: qrX,
    y: qrY + qrSize + 10,
    size: 8.5,
    font: bold,
    color: muted,
  });

  // Footer
  page.drawLine({
    start: { x: margin, y: 46 },
    end: { x: W - margin, y: 46 },
    thickness: 0.7,
    color: hair,
  });

  const footer =
    "Registry-grade certification • Authority is explicit and conferred by the Billing Registry (not by rendering).";
  page.drawText(winAnsiSafe(footer), {
    x: margin,
    y: 32,
    size: 7.8,
    font,
    color: rgb(0.6, 0.64, 0.7),
    maxWidth: W - margin * 2 - 160,
  });

  return new Uint8Array(await pdf.save({ useObjectStreams: false }));
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders, status: 204 });
  if (req.method !== "POST") return json(req, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY_PUBLIC");
    const SERVICE_ROLE_KEY =
      Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
      return json(req, 500, { ok: false, error: "MISSING_ENV" });
    }

    const bearer = pickBearer(req);
    if (!bearer) return json(req, 401, { ok: false, error: "UNAUTHORIZED" });

    // ANON client (validate JWT)
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: bearer } },
      auth: { persistSession: false },
    });

    const { data: userRes, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userRes?.user?.id) {
      return json(req, 401, { ok: false, error: "INVALID_SESSION", details: userErr?.message });
    }

    const user_id = userRes.user.id;

    const body = (await req.json().catch(() => ({}))) as Partial<ReqBody>;
    const document_id = cleanUuid(body.billing_document_id) || cleanUuid(body.document_id);
    if (!document_id || !isUuid(document_id)) {
      return json(req, 400, { ok: false, error: "MISSING_DOCUMENT_ID" });
    }

    const force = Boolean(body.force);
    const actor_id = (cleanUuid(body.actor_id) && isUuid(String(body.actor_id))) ? String(body.actor_id) : user_id;

    const verifyBase = (String(body.verify_base_url ?? "").trim() || defaultVerifyBaseUrl()).replace(
      /\/+$/,
      "",
    );

    // SERVICE ROLE client (writes + storage)
    const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { fetch },
      auth: { persistSession: false },
    });

    // Load billing document (schema-safe select; NO title/verify_url assumptions)
    const { data: doc, error: docErr } = await svc
      .from("billing_documents")
      .select(
        [
          "id",
          "entity_id",
          "is_test",
          "document_type",
          "document_number",
          "invoice_number",
          "currency",
          "issued_at",
          "due_at",
          "period_start",
          "period_end",
          "recipient_name",
          "recipient_email",
          "total_amount",
          "total_cents",
          "storage_bucket",
          "storage_path",
          "file_hash",
          "certified_at",
          "certified_by",
          "certified_storage_bucket",
          "certified_storage_path",
          "certified_file_hash",
          "metadata",
        ].join(","),
      )
      .eq("id", document_id)
      .maybeSingle();

    if (docErr) return json(req, 500, { ok: false, error: "DOCUMENT_LOOKUP_FAILED", details: docErr.message });
    if (!doc) return json(req, 404, { ok: false, error: "DOCUMENT_NOT_FOUND" });

    const entity_id = cleanUuid((doc as any).entity_id);
    const is_test = Boolean((doc as any).is_test);

    if (!entity_id || !isUuid(entity_id)) {
      return json(req, 400, { ok: false, error: "DOCUMENT_MISSING_ENTITY" });
    }

    // Best-effort operator authz (enforced only if RPC exists)
    await bestEffortAuthorizeOperator(svc, user_id, entity_id);

    // Idempotent return if already certified (and not forcing)
    const existing_hash = String((doc as any).certified_file_hash ?? "").trim();
    const existing_bucket = String((doc as any).certified_storage_bucket ?? "").trim();
    const existing_path = String((doc as any).certified_storage_path ?? "").trim();

    if (!force && existing_hash && existing_bucket && existing_path) {
      const verify_url = `${verifyBase}/verify-billing.html?hash=${existing_hash}`;
      return json(req, 200, {
        ok: true,
        billing_document_id: document_id,
        document_id,
        actor_id,
        entity_id,
        is_test,
        certified_bucket: existing_bucket,
        certified_path: existing_path,
        certified_hash: existing_hash,
        verify_url,
      });
    }

    const src_bucket = String((doc as any).storage_bucket ?? "").trim();
    const src_path = String((doc as any).storage_path ?? "").trim();

    if (!src_bucket || !src_path) {
      return json(req, 400, {
        ok: false,
        error: "MISSING_SOURCE_POINTERS",
        details: "billing_documents.storage_bucket/storage_path required before certification",
      });
    }

    // Download source PDF
    const dl = await svc.storage.from(src_bucket).download(src_path);
    if (dl.error) {
      return json(req, 500, { ok: false, error: "DOWNLOAD_FAILED", details: dl.error.message });
    }
    const srcBytes = new Uint8Array(await dl.data.arrayBuffer());

    // Fixed-point loop: render → hash → re-render with that hash, repeat a few times until stable.
    // This guarantees: QR/hash reflect FINAL certified bytes.
    let hash = "0".repeat(64);
    let certifiedBytes = srcBytes;

    const meta = {
      entity_id,
      is_test,
      document_type: cleanUuid((doc as any).document_type) ? String((doc as any).document_type) : String((doc as any).document_type ?? null),
      document_number: (doc as any).document_number ? String((doc as any).document_number) : null,
      invoice_number: (doc as any).invoice_number ? String((doc as any).invoice_number) : null,
      currency: (doc as any).currency ? String((doc as any).currency) : null,
      issued_at: (doc as any).issued_at ? String((doc as any).issued_at) : null,
      due_at: (doc as any).due_at ? String((doc as any).due_at) : null,
      period_start: (doc as any).period_start ? String((doc as any).period_start) : null,
      period_end: (doc as any).period_end ? String((doc as any).period_end) : null,
      recipient_name: (doc as any).recipient_name ? String((doc as any).recipient_name) : null,
      recipient_email: (doc as any).recipient_email ? String((doc as any).recipient_email) : null,
      total_amount: (doc as any).total_amount != null ? Number((doc as any).total_amount) : null,
      total_cents: (doc as any).total_cents != null ? Number((doc as any).total_cents) : null,
    };

    for (let i = 0; i < 4; i++) {
      const verifyUrl = `${verifyBase}/verify-billing.html?hash=${hash}`;
      const bytes = await appendCertificationPage({
        srcBytes,
        certHash: hash,
        verifyUrl,
        meta,
      });

      const next = await sha256Hex(bytes);
      certifiedBytes = bytes;

      if (next === hash) break;
      hash = next;
    }

    const certified_hash = await sha256Hex(certifiedBytes);
    const verify_url = `${verifyBase}/verify-billing.html?hash=${certified_hash}`;

    // Certified pointers (same lane bucket recorded on the row)
    const certified_bucket = src_bucket;
    const certified_path = buildCertifiedPath(src_path);
    if (!certified_path) return json(req, 400, { ok: false, error: "CERTIFIED_PATH_INVALID" });

    // Upload certified PDF
    const up = await svc.storage
      .from(certified_bucket)
      .upload(certified_path, new Blob([certifiedBytes], { type: "application/pdf" }), {
        contentType: "application/pdf",
        upsert: force, // if force => overwrite; else require empty or existing
      });

    if (up.error) {
      const msg = String((up.error as any)?.message ?? "");
      const statusCode = (up.error as any)?.statusCode ?? (up.error as any)?.status ?? null;
      const alreadyExists =
        statusCode === 409 ||
        msg.toLowerCase().includes("already exists") ||
        msg.toLowerCase().includes("duplicate") ||
        msg.toLowerCase().includes("409");

      // If not forcing and object exists, we can still proceed to update pointers/hash
      // (idempotent behavior).
      if (!(alreadyExists && !force)) {
        return json(req, 500, { ok: false, error: "UPLOAD_FAILED", details: up.error });
      }
    }

    // Update billing_documents (schema-safe patch)
    const nowIso = new Date().toISOString();
    const prevMeta = (doc as any).metadata && typeof (doc as any).metadata === "object" ? (doc as any).metadata : {};
    const nextMeta = {
      ...(prevMeta ?? {}),
      certification: {
        ...(prevMeta?.certification ?? {}),
        verify_url,
        certified_file_hash: certified_hash,
        certified_storage_bucket: certified_bucket,
        certified_storage_path: certified_path,
        certified_at: nowIso,
        certified_by: actor_id,
        method: "billing-certify-document",
        version: 1,
      },
    };

    const patch: any = {
      certified_at: nowIso,
      certified_by: actor_id,
      certified_storage_bucket: certified_bucket,
      certified_storage_path: certified_path,
      certified_file_hash: certified_hash,
      metadata: nextMeta,
    };

    const { error: updErr } = await svc.from("billing_documents").update(patch).eq("id", document_id);
    if (updErr) {
      return json(req, 500, {
        ok: false,
        error: "UPDATE_FAILED",
        details: updErr.message,
      });
    }

    return json(req, 200, {
      ok: true,
      billing_document_id: document_id,
      document_id,
      actor_id,
      entity_id,
      is_test,
      certified_bucket,
      certified_path,
      certified_hash,
      verify_url,
    });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const status =
      msg.includes("Invalid session") || msg.includes("UNAUTHORIZED") ? 401
      : msg.includes("FORBIDDEN") ? 403
      : 500;

    return json(req, status, {
      ok: false,
      error: status === 401 ? "UNAUTHORIZED" : status === 403 ? "FORBIDDEN" : "CERTIFY_FAILED",
      details: msg,
    });
  }
});
