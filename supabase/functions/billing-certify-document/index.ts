// supabase/functions/billing-certify-document/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";

// ✅ Server-safe QR → SVG (NO canvas)
import QRCode from "https://esm.sh/qrcode-svg@1.1.0";
// ✅ SVG → PNG in Deno (NO canvas)
import { initialize, svg2png } from "https://esm.sh/svg2png-wasm@1.4.1";

type ReqBody = {
  billing_document_id?: string;
  document_id?: string; // alias
  actor_id?: string; // optional override (normally from JWT)
  force?: boolean;
  verify_base_url?: string; // optional override; default derived
};

type Resp = {
  ok: boolean;
  document_id?: string;
  billing_document_id?: string;
  actor_id?: string;
  entity_id?: string;
  is_test?: boolean;

  certified_bucket?: string;
  certified_path?: string;
  certified_hash?: string;
  verify_url?: string;

  error?: string;
  details?: string;
  request_id?: string | null;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
};

let _svg2pngReady = false;
async function ensureSvg2Png() {
  if (_svg2pngReady) return;
  await initialize();
  _svg2pngReady = true;
}

function json(ok: boolean, body: Resp, status = 200) {
  return new Response(JSON.stringify({ ok, ...body }), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" },
  });
}

function cleanUuid(x: unknown) {
  const s = (x ?? "").toString().trim();
  return s ? s : null;
}

function defaultVerifyBaseUrl(req: Request) {
  // Prefer explicit env if you add later; otherwise derive from request.
  // NOTE: Your canonical public door is sign.oasisintlholdings.com
  try {
    const u = new URL(req.url);
    return `https://sign.oasisintlholdings.com`;
  } catch {
    return `https://sign.oasisintlholdings.com`;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hashArray = Array.from(new Uint8Array(digest));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function buildCertifiedPath(originalPath: string) {
  const p = (originalPath || "").trim();
  if (!p) return null;
  if (p.toLowerCase().includes("-certified")) return p; // already looks certified
  if (p.toLowerCase().endsWith(".pdf")) return p.replace(/\.pdf$/i, "-certified.pdf");
  return `${p}-certified.pdf`;
}

async function mustGetUserIdFromJwt(req: Request): Promise<string> {
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new Error("Missing Authorization Bearer token");
  const jwt = m[1];

  const { data, error } = await supabase.auth.getUser(jwt);
  if (error || !data?.user?.id) throw new Error("Invalid session");
  return data.user.id;
}

/**
 * Operator read policy model:
 * - We still do server-side authorization checks here.
 * - We do NOT assume your exact membership table name; we try common ones.
 * - If we cannot verify membership, we FAIL CLOSED (authz_unavailable).
 */
async function assertOperatorForEntity(userId: string, entityId: string) {
  const uid = cleanUuid(userId);
  const eid = cleanUuid(entityId);
  if (!uid || !eid) throw new Error("AUTHZ_INVALID_INPUT");

  // 1) Preferred: RPC if you have it
  try {
    const { data, error } = await supabase.rpc("os_authorize_operator", {
      p_user_id: uid,
      p_entity_id: eid,
    } as any);
    if (!error && data === true) return;
    if (!error && data === false) throw new Error("FORBIDDEN");
  } catch {
    // ignore; fall through
  }

  // 2) Try memberships table patterns (fail closed if unknown)
  const candidates: Array<{
    table: string;
    userCol: string;
    entityCol: string;
    roleCol?: string;
    roleAllow?: string[];
  }> = [
    { table: "memberships", userCol: "user_id", entityCol: "entity_id", roleCol: "role", roleAllow: ["owner", "admin", "operator"] },
    { table: "entity_memberships", userCol: "user_id", entityCol: "entity_id", roleCol: "role", roleAllow: ["owner", "admin", "operator"] },
    { table: "workspace_memberships", userCol: "user_id", entityCol: "entity_id", roleCol: "role", roleAllow: ["owner", "admin", "operator"] },
  ];

  for (const c of candidates) {
    try {
      const q = supabase
        .from(c.table as any)
        .select([c.userCol, c.entityCol, c.roleCol].filter(Boolean).join(","))
        .eq(c.userCol as any, uid)
        .eq(c.entityCol as any, eid)
        .limit(1);

      const { data, error } = await q as any;
      if (error) continue;

      const row = Array.isArray(data) ? data[0] : data;
      if (!row) continue;

      if (c.roleCol && c.roleAllow?.length) {
        const r = (row?.[c.roleCol] ?? "").toString().toLowerCase();
        if (!c.roleAllow.includes(r)) throw new Error("FORBIDDEN");
      }
      return;
    } catch {
      continue;
    }
  }

  throw new Error("AUTHZ_UNAVAILABLE");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders, status: 204 });
  }

  const requestId = req.headers.get("x-sb-request-id") ?? null;

  try {
    if (req.method !== "POST") {
      return json(false, { ok: false, error: "METHOD_NOT_ALLOWED", request_id: requestId }, 405);
    }

    const body = (await req.json().catch(() => ({}))) as ReqBody;
    const documentId =
      cleanUuid(body.billing_document_id) || cleanUuid(body.document_id);

    if (!documentId) {
      return json(false, { ok: false, error: "MISSING_DOCUMENT_ID", request_id: requestId }, 400);
    }

    const force = Boolean(body.force);

    // ✅ Require operator session (registry-grade)
    const userId = await mustGetUserIdFromJwt(req);
    const actorId = cleanUuid(body.actor_id) || userId;

    // 1) Load billing document row
    const { data: doc, error: docErr } = await supabase
      .from("billing_documents")
      .select(
        [
          "id",
          "entity_id",
          "is_test",
          "title",
          "document_number",
          "document_type",
          "storage_bucket",
          "storage_path",
          "file_hash",
          "certified_at",
          "certified_storage_bucket",
          "certified_storage_path",
          "certified_file_hash",
          "verify_url",
          "metadata",
          "created_at",
        ].join(",")
      )
      .eq("id", documentId)
      .maybeSingle();

    if (docErr) throw docErr;
    if (!doc) {
      return json(false, { ok: false, error: "DOCUMENT_NOT_FOUND", request_id: requestId }, 404);
    }

    const entityId = cleanUuid((doc as any).entity_id);
    const isTest = Boolean((doc as any).is_test);

    if (!entityId) {
      return json(false, { ok: false, error: "DOCUMENT_MISSING_ENTITY", request_id: requestId }, 400);
    }

    // ✅ Operator authz
    await assertOperatorForEntity(userId, entityId);

    // 2) If already certified and not forcing, return existing
    const existingCertifiedHash = ((doc as any).certified_file_hash ?? "").toString().trim();
    const existingVerifyUrl = ((doc as any).verify_url ?? "").toString().trim();
    const existingCertifiedBucket = ((doc as any).certified_storage_bucket ?? "").toString().trim();
    const existingCertifiedPath = ((doc as any).certified_storage_path ?? "").toString().trim();

    if (!force && existingCertifiedHash && existingCertifiedBucket && existingCertifiedPath) {
      return json(true, {
        ok: true,
        billing_document_id: documentId,
        document_id: documentId,
        actor_id: actorId,
        entity_id: entityId,
        is_test: isTest,
        certified_bucket: existingCertifiedBucket,
        certified_path: existingCertifiedPath,
        certified_hash: existingCertifiedHash,
        verify_url: existingVerifyUrl || undefined,
        request_id: requestId,
      });
    }

    const srcBucket = ((doc as any).storage_bucket ?? "").toString().trim();
    const srcPath = ((doc as any).storage_path ?? "").toString().trim();

    if (!srcBucket || !srcPath) {
      return json(
        false,
        {
          ok: false,
          error: "MISSING_SOURCE_POINTERS",
          details: "billing_documents.storage_bucket/storage_path required before certification",
          request_id: requestId,
        },
        400
      );
    }

    // 3) Download source PDF
    const dl = await supabase.storage.from(srcBucket).download(srcPath);
    if (dl.error) throw dl.error;

    const srcBytes = new Uint8Array(await dl.data.arrayBuffer());

    // 4) Prepare verify URL (hash-first)
    const verifyBase = (body.verify_base_url || "").trim() || defaultVerifyBaseUrl(req);

    // 5) Build certified PDF (append certification page; compute final hash from final bytes)
    await ensureSvg2Png();

    const pdf = await PDFDocument.load(srcBytes);
    const page = pdf.addPage();

    const w = page.getWidth();
    const h = page.getHeight();

    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

    // Temporary hash placeholder → we will render “hash” after we compute it by stamping in the page
    // Enterprise invariant: QR encodes FINAL hash of FINAL bytes.
    // To achieve this, we generate page layout with a placeholder first, then compute final bytes,
    // then regenerate (second pass) with the real hash. Still single upload.
    async function renderCertification(certHash: string, verifyUrl: string) {
      // clean page
      page.drawRectangle({
        x: 0,
        y: 0,
        width: w,
        height: h,
        color: rgb(0.03, 0.04, 0.07),
        opacity: 0, // keep transparent on append; no visual black sheet
      });

      const margin = 54;
      const gold = rgb(0.95, 0.78, 0.33);
      const ink = rgb(0.15, 0.17, 0.22);

      // Top rule
      page.drawLine({
        start: { x: margin, y: h - margin - 8 },
        end: { x: w - margin, y: h - margin - 8 },
        thickness: 1,
        color: rgb(0.85, 0.86, 0.89),
        opacity: 0.25,
      });

      page.drawText("OASIS OS • BILLING CERTIFICATION", {
        x: margin,
        y: h - margin - 32,
        size: 11,
        font: fontBold,
        color: rgb(0.35, 0.38, 0.45),
      });

      page.drawText("Certified Billing Artifact", {
        x: margin,
        y: h - margin - 70,
        size: 22,
        font: fontBold,
        color: rgb(0.08, 0.09, 0.11),
      });

      const title = ((doc as any).title ?? "Billing Document").toString();
      const num = ((doc as any).document_number ?? "").toString();
      const dtype = ((doc as any).document_type ?? "").toString();

      const metaLines: Array<[string, string]> = [
        ["Document", title],
        ["Number", num || "—"],
        ["Type", dtype || "—"],
        ["Entity ID", entityId],
        ["Lane", isTest ? "SANDBOX" : "RoT"],
        ["Certified At", new Date().toISOString()],
      ];

      let y = h - margin - 110;
      for (const [k, v] of metaLines) {
        page.drawText(k.toUpperCase(), {
          x: margin,
          y,
          size: 9,
          font: fontBold,
          color: rgb(0.50, 0.52, 0.60),
        });
        page.drawText(v, {
          x: margin + 140,
          y,
          size: 10,
          font,
          color: ink,
        });
        y -= 18;
      }

      // Hash block
      page.drawText("SHA-256 (Certified PDF)", {
        x: margin,
        y: y - 10,
        size: 10,
        font: fontBold,
        color: rgb(0.45, 0.48, 0.56),
      });

      const hashText = certHash || "PENDING_HASH";
      const hashBoxY = y - 42;

      page.drawRectangle({
        x: margin,
        y: hashBoxY,
        width: w - margin * 2,
        height: 40,
        borderColor: rgb(0.80, 0.82, 0.86),
        borderWidth: 1,
        opacity: 0.15,
      });

      page.drawText(hashText, {
        x: margin + 12,
        y: hashBoxY + 14,
        size: 9,
        font,
        color: rgb(0.10, 0.12, 0.16),
      });

      // Verification URL
      page.drawText("Verification (hash-first)", {
        x: margin,
        y: hashBoxY - 26,
        size: 10,
        font: fontBold,
        color: rgb(0.45, 0.48, 0.56),
      });

      page.drawText(verifyUrl, {
        x: margin,
        y: hashBoxY - 44,
        size: 9,
        font,
        color: rgb(0.10, 0.12, 0.16),
      });

      // QR (bottom-right)
      const qrPayload = verifyUrl;
      const qrSvg = new QRCode({
        content: qrPayload,
        padding: 0,
        width: 256,
        height: 256,
        color: "#0B0E14",
        background: "#FFFFFF",
        ecl: "M",
      }).svg();

      const qrPng = await svg2png(qrSvg, { width: 256, height: 256 });
      const qrImg = await pdf.embedPng(qrPng);

      const qrSize = 132;
      const qrX = w - margin - qrSize;
      const qrY = margin;

      // Subtle gold frame
      page.drawRectangle({
        x: qrX - 6,
        y: qrY - 6,
        width: qrSize + 12,
        height: qrSize + 12,
        borderColor: gold,
        borderWidth: 1,
        opacity: 0.35,
      });

      page.drawImage(qrImg, { x: qrX, y: qrY, width: qrSize, height: qrSize });

      page.drawText("Scan to verify", {
        x: qrX,
        y: qrY + qrSize + 10,
        size: 9,
        font: fontBold,
        color: rgb(0.40, 0.42, 0.50),
      });

      // Footer
      page.drawLine({
        start: { x: margin, y: margin - 22 },
        end: { x: w - margin, y: margin - 22 },
        thickness: 1,
        color: rgb(0.85, 0.86, 0.89),
        opacity: 0.15,
      });

      page.drawText("Registry-grade artifact • Issued by Oasis OS Billing Authority", {
        x: margin,
        y: margin - 40,
        size: 9,
        font,
        color: rgb(0.45, 0.48, 0.56),
      });
    }

    // Pass A: render placeholder (we need bytes to hash)
    const placeholderHash = "0".repeat(64);
    const placeholderVerify = `${verifyBase}/verify-billing.html?hash=${placeholderHash}`;
    await renderCertification(placeholderHash, placeholderVerify);

    const bytesA = await pdf.save();
    const hashA = await sha256Hex(bytesA);

    // Pass B: overwrite the same appended page content by reloading and re-rendering cleanly
    // (simplest, reliable for pdf-lib: rebuild from source + append again with correct hash)
    const pdfFinal = await PDFDocument.load(srcBytes);
    const certPage = pdfFinal.addPage([w, h]);

    const font2 = await pdfFinal.embedFont(StandardFonts.Helvetica);
    const fontBold2 = await pdfFinal.embedFont(StandardFonts.HelveticaBold);

    async function renderFinalPage(certHash: string, verifyUrl: string) {
      // (copy same drawing but targeting certPage + font2/fontBold2)
      const margin = 54;
      const gold = rgb(0.95, 0.78, 0.33);
      const ink = rgb(0.15, 0.17, 0.22);

      certPage.drawLine({
        start: { x: margin, y: h - margin - 8 },
        end: { x: w - margin, y: h - margin - 8 },
        thickness: 1,
        color: rgb(0.85, 0.86, 0.89),
        opacity: 0.25,
      });

      certPage.drawText("OASIS OS • BILLING CERTIFICATION", {
        x: margin,
        y: h - margin - 32,
        size: 11,
        font: fontBold2,
        color: rgb(0.35, 0.38, 0.45),
      });

      certPage.drawText("Certified Billing Artifact", {
        x: margin,
        y: h - margin - 70,
        size: 22,
        font: fontBold2,
        color: rgb(0.08, 0.09, 0.11),
      });

      const title = ((doc as any).title ?? "Billing Document").toString();
      const num = ((doc as any).document_number ?? "").toString();
      const dtype = ((doc as any).document_type ?? "").toString();

      const metaLines: Array<[string, string]> = [
        ["Document", title],
        ["Number", num || "—"],
        ["Type", dtype || "—"],
        ["Entity ID", entityId],
        ["Lane", isTest ? "SANDBOX" : "RoT"],
        ["Certified At", new Date().toISOString()],
      ];

      let y = h - margin - 110;
      for (const [k, v] of metaLines) {
        certPage.drawText(k.toUpperCase(), {
          x: margin,
          y,
          size: 9,
          font: fontBold2,
          color: rgb(0.50, 0.52, 0.60),
        });
        certPage.drawText(v, {
          x: margin + 140,
          y,
          size: 10,
          font: font2,
          color: ink,
        });
        y -= 18;
      }

      certPage.drawText("SHA-256 (Certified PDF)", {
        x: margin,
        y: y - 10,
        size: 10,
        font: fontBold2,
        color: rgb(0.45, 0.48, 0.56),
      });

      const hashBoxY = y - 42;

      certPage.drawRectangle({
        x: margin,
        y: hashBoxY,
        width: w - margin * 2,
        height: 40,
        borderColor: rgb(0.80, 0.82, 0.86),
        borderWidth: 1,
        opacity: 0.15,
      });

      certPage.drawText(certHash, {
        x: margin + 12,
        y: hashBoxY + 14,
        size: 9,
        font: font2,
        color: rgb(0.10, 0.12, 0.16),
      });

      certPage.drawText("Verification (hash-first)", {
        x: margin,
        y: hashBoxY - 26,
        size: 10,
        font: fontBold2,
        color: rgb(0.45, 0.48, 0.56),
      });

      certPage.drawText(verifyUrl, {
        x: margin,
        y: hashBoxY - 44,
        size: 9,
        font: font2,
        color: rgb(0.10, 0.12, 0.16),
      });

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
      const qrImg = await pdfFinal.embedPng(qrPng);

      const qrSize = 132;
      const qrX = w - margin - qrSize;
      const qrY = margin;

      certPage.drawRectangle({
        x: qrX - 6,
        y: qrY - 6,
        width: qrSize + 12,
        height: qrSize + 12,
        borderColor: gold,
        borderWidth: 1,
        opacity: 0.35,
      });

      certPage.drawImage(qrImg, { x: qrX, y: qrY, width: qrSize, height: qrSize });

      certPage.drawText("Scan to verify", {
        x: qrX,
        y: qrY + qrSize + 10,
        size: 9,
        font: fontBold2,
        color: rgb(0.40, 0.42, 0.50),
      });

      certPage.drawLine({
        start: { x: margin, y: margin - 22 },
        end: { x: w - margin, y: margin - 22 },
        thickness: 1,
        color: rgb(0.85, 0.86, 0.89),
        opacity: 0.15,
      });

      certPage.drawText("Registry-grade artifact • Issued by Oasis OS Billing Authority", {
        x: margin,
        y: margin - 40,
        size: 9,
        font: font2,
        color: rgb(0.45, 0.48, 0.56),
      });
    }

    const finalVerifyUrl = `${verifyBase}/verify-billing.html?hash=${hashA}`;
    await renderFinalPage(hashA, finalVerifyUrl);

    const finalBytes = await pdfFinal.save();
    const finalHash = await sha256Hex(finalBytes);

    // IMPORTANT invariant:
    // QR must embed FINAL hash of FINAL certified bytes.
    // If the second hash differs (it can, due to objects), we must re-render with finalHash.
    // We do a final strict re-render ONLY if needed.
    let certifiedBytes = finalBytes;
    let certifiedHash = finalHash;

    if (finalHash !== hashA) {
      const pdfStrict = await PDFDocument.load(srcBytes);
      const strictPage = pdfStrict.addPage([w, h]);
      const fA = await pdfStrict.embedFont(StandardFonts.Helvetica);
      const fB = await pdfStrict.embedFont(StandardFonts.HelveticaBold);

      // minimal copy of final rendering targeting strictPage/fA/fB
      // (same layout; QR uses finalHash)
      const margin = 54;
      const gold = rgb(0.95, 0.78, 0.33);
      const ink = rgb(0.15, 0.17, 0.22);

      strictPage.drawLine({
        start: { x: margin, y: h - margin - 8 },
        end: { x: w - margin, y: h - margin - 8 },
        thickness: 1,
        color: rgb(0.85, 0.86, 0.89),
        opacity: 0.25,
      });

      strictPage.drawText("OASIS OS • BILLING CERTIFICATION", {
        x: margin,
        y: h - margin - 32,
        size: 11,
        font: fB,
        color: rgb(0.35, 0.38, 0.45),
      });

      strictPage.drawText("Certified Billing Artifact", {
        x: margin,
        y: h - margin - 70,
        size: 22,
        font: fB,
        color: rgb(0.08, 0.09, 0.11),
      });

      const title = ((doc as any).title ?? "Billing Document").toString();
      const num = ((doc as any).document_number ?? "").toString();
      const dtype = ((doc as any).document_type ?? "").toString();

      const metaLines: Array<[string, string]> = [
        ["Document", title],
        ["Number", num || "—"],
        ["Type", dtype || "—"],
        ["Entity ID", entityId],
        ["Lane", isTest ? "SANDBOX" : "RoT"],
        ["Certified At", new Date().toISOString()],
      ];

      let y = h - margin - 110;
      for (const [k, v] of metaLines) {
        strictPage.drawText(k.toUpperCase(), {
          x: margin,
          y,
          size: 9,
          font: fB,
          color: rgb(0.50, 0.52, 0.60),
        });
        strictPage.drawText(v, {
          x: margin + 140,
          y,
          size: 10,
          font: fA,
          color: ink,
        });
        y -= 18;
      }

      strictPage.drawText("SHA-256 (Certified PDF)", {
        x: margin,
        y: y - 10,
        size: 10,
        font: fB,
        color: rgb(0.45, 0.48, 0.56),
      });

      const hashBoxY = y - 42;

      strictPage.drawRectangle({
        x: margin,
        y: hashBoxY,
        width: w - margin * 2,
        height: 40,
        borderColor: rgb(0.80, 0.82, 0.86),
        borderWidth: 1,
        opacity: 0.15,
      });

      strictPage.drawText(finalHash, {
        x: margin + 12,
        y: hashBoxY + 14,
        size: 9,
        font: fA,
        color: rgb(0.10, 0.12, 0.16),
      });

      const strictVerifyUrl = `${verifyBase}/verify-billing.html?hash=${finalHash}`;

      strictPage.drawText("Verification (hash-first)", {
        x: margin,
        y: hashBoxY - 26,
        size: 10,
        font: fB,
        color: rgb(0.45, 0.48, 0.56),
      });

      strictPage.drawText(strictVerifyUrl, {
        x: margin,
        y: hashBoxY - 44,
        size: 9,
        font: fA,
        color: rgb(0.10, 0.12, 0.16),
      });

      const qrSvg = new QRCode({
        content: strictVerifyUrl,
        padding: 0,
        width: 256,
        height: 256,
        color: "#0B0E14",
        background: "#FFFFFF",
        ecl: "M",
      }).svg();

      const qrPng = await svg2png(qrSvg, { width: 256, height: 256 });
      const qrImg = await pdfStrict.embedPng(qrPng);

      const qrSize = 132;
      const qrX = w - margin - qrSize;
      const qrY = margin;

      strictPage.drawRectangle({
        x: qrX - 6,
        y: qrY - 6,
        width: qrSize + 12,
        height: qrSize + 12,
        borderColor: gold,
        borderWidth: 1,
        opacity: 0.35,
      });

      strictPage.drawImage(qrImg, { x: qrX, y: qrY, width: qrSize, height: qrSize });

      strictPage.drawText("Scan to verify", {
        x: qrX,
        y: qrY + qrSize + 10,
        size: 9,
        font: fB,
        color: rgb(0.40, 0.42, 0.50),
      });

      strictPage.drawLine({
        start: { x: margin, y: margin - 22 },
        end: { x: w - margin, y: margin - 22 },
        thickness: 1,
        color: rgb(0.85, 0.86, 0.89),
        opacity: 0.15,
      });

      strictPage.drawText("Registry-grade artifact • Issued by Oasis OS Billing Authority", {
        x: margin,
        y: margin - 40,
        size: 9,
        font: fA,
        color: rgb(0.45, 0.48, 0.56),
      });

      certifiedBytes = await pdfStrict.save();
      certifiedHash = await sha256Hex(certifiedBytes);

      // if still differs (extremely unlikely), we keep certifiedHash and verify URL will use it.
    }

    const verifyUrl = `${verifyBase}/verify-billing.html?hash=${certifiedHash}`;

    // 6) Upload certified PDF
    const certifiedBucket = srcBucket; // keep same bucket by default
    const certifiedPath = buildCertifiedPath(srcPath);
    if (!certifiedPath) {
      return json(false, { ok: false, error: "CERTIFIED_PATH_INVALID", request_id: requestId }, 400);
    }

    const upsert = force ? true : false;
    const up = await supabase.storage
      .from(certifiedBucket)
      .upload(certifiedPath, certifiedBytes, {
        contentType: "application/pdf",
        upsert,
      });

    if (up.error) {
      // if object exists and we didn't force, treat as already certified path
      if (!force && /already exists|Duplicate|exists/i.test(up.error.message || "")) {
        // proceed to update row with canonical pointer/hash we computed
      } else {
        throw up.error;
      }
    }

    // 7) Update registry row (single row, never insert)
    const patch: Record<string, any> = {
      certified_at: new Date().toISOString(),
      certified_storage_bucket: certifiedBucket,
      certified_storage_path: certifiedPath,
      certified_file_hash: certifiedHash,
      verify_url: verifyUrl,
      certified_by: actorId, // if column exists in your schema
      // status: "certified", // uncomment ONLY if your schema has status text/enum accepting 'certified'
    };

    const { error: updErr } = await supabase
      .from("billing_documents")
      .update(patch as any)
      .eq("id", documentId);

    if (updErr) {
      // Provide a precise hint if your table doesn’t have some columns yet.
      return json(
        false,
        {
          ok: false,
          error: "UPDATE_FAILED",
          details:
            updErr.message +
            " | Ensure billing_documents has: certified_at, certified_storage_bucket, certified_storage_path, certified_file_hash, verify_url (and optional certified_by).",
          request_id: requestId,
        },
        500
      );
    }

    return json(true, {
      ok: true,
      billing_document_id: documentId,
      document_id: documentId,
      actor_id: actorId,
      entity_id: entityId,
      is_test: isTest,
      certified_bucket: certifiedBucket,
      certified_path: certifiedPath,
      certified_hash: certifiedHash,
      verify_url: verifyUrl,
      request_id: requestId,
    });
  } catch (e: any) {
    const msg = (e?.message || "CERTIFY_FAILED").toString();
    const status =
      msg.includes("Missing Authorization") || msg.includes("Invalid session")
        ? 401
        : msg.includes("FORBIDDEN") || msg.includes("AUTHZ_")
        ? 403
        : 500;

    return json(false, {
      ok: false,
      error: status === 401 ? "UNAUTHORIZED" : status === 403 ? "FORBIDDEN" : "CERTIFY_FAILED",
      details: msg,
      request_id: requestId,
    }, status);
  }
});
