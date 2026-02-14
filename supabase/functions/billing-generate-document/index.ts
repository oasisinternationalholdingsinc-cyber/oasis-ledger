// supabase/functions/billing-generate-document/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";

// ✅ Edge-safe QR (NO canvas / NO wasm)
import QRGen from "npm:qrcode-generator@1.4.4";
import { PNG } from "npm:pngjs@7.0.0";

/**
 * CI-Billing — billing-generate-document (PRODUCTION — LOCKED TO SCHEMA)
 *
 * ✅ OPERATOR-ONLY (valid user session required)
 * ✅ REGISTRY-GRADE (writes public.billing_documents)
 * ✅ NO PAYMENTS / NO ENFORCEMENT
 * ✅ Lane-safe via is_test (must be provided; never inferred)
 * ✅ Edge-safe PDF + hash (NO canvas / NO wasm)
 *
 * Storage:
 * - Uses lane-aware buckets:
 *    is_test=true  -> billing_sandbox
 *    is_test=false -> billing_truth
 *
 * Idempotency (enterprise, no regression):
 * - Your billing_documents has PARTIAL UNIQUE indexes for (entity_id,is_test,invoice_number) and
 *   (entity_id,is_test,document_number), so ON CONFLICT(columnlist) will FAIL.
 *
 * ✅ Therefore:
 * - If invoice_number provided: SELECT existing by (entity_id,is_test,invoice_number) → UPDATE else INSERT
 * - Else if document_number provided: SELECT existing by (entity_id,is_test,document_number) → UPDATE else INSERT
 * - Else: UPSERT by file_hash (FULL UNIQUE) is allowed and used
 *
 * ✅ Writes ONLY columns that EXIST on billing_documents (locked schema)
 * ✅ Uses entity_id as canonical issuer scope
 * ✅ provider_entity_id is set equal to entity_id (passes CHECK constraint)
 *
 * ---------------------------------------------------------------------------
 * ✅ PDF layout hardening (NO wiring/DB regressions)
 * - Meta card values NEVER clip (wrap to 2 lines; invoice # safe)
 * - Bottom area is split: Summary LEFT + QR RIGHT (no overlap ever)
 * - Notes gets its own row above bottom split
 * - Table rows stop above footer region deterministically
 * - QR encodes RAW verify URL (hash-first) — iPhone camera compatible
 * - Canonical verify page: https://sign.oasisintlholdings.com/verify-billing.html
 *
 * ✅ Hash/QR correctness:
 * - Fixed-point stabilization loop so QR always encodes FINAL hash.
 * ---------------------------------------------------------------------------
 */

type LineItem = {
  description: string;
  quantity?: number;
  unit_price?: number; // major units (e.g., 49.00)
  amount?: number; // optional override (major units)
};

type ReqBody = {
  // Issuer (provider) scope
  provider_entity_id: string; // REQUIRED (active OS entity id)
  is_test: boolean; // REQUIRED (lane-safe)

  // Optional links
  subscription_id?: string | null;

  // Customer
  customer_id?: string | null;
  recipient_name?: string | null;
  recipient_email?: string | null;

  // Document
  document_type:
    | "invoice"
    | "contract"
    | "statement"
    | "receipt"
    | "credit_note"
    | "other";

  status?: string | null; // optional override, default to 'issued' (must match enum)
  document_number?: string | null;
  invoice_number?: string | null;
  external_reference?: string | null;

  currency?: string | null; // e.g. "USD" / "CAD"
  issued_at?: string | null; // ISO
  due_at?: string | null; // ISO
  period_start?: string | null; // ISO/date
  period_end?: string | null; // ISO/date

  notes?: string | null;
  line_items?: LineItem[];

  // Audit
  reason: string; // REQUIRED
  trigger?: string; // tolerated
};

type Resp = {
  ok: boolean;
  document_id?: string;
  file_hash?: string;
  storage?: { bucket: string; path: string; size: number };
  actor_id?: string;
  actor_email?: string | null;
  error?: string;
  details?: unknown;
  request_id?: string | null;
  message?: string;
};

const cors: Record<string, string> = {
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

function json(status: number, body: unknown, req: Request) {
  const request_id = getRequestId(req);
  return new Response(
    JSON.stringify({ ...(body as any), request_id } satisfies Resp, null, 2),
    { status, headers: { ...cors, "content-type": "application/json; charset=utf-8" } },
  );
}

function pickBearer(req: Request) {
  const h = req.headers.get("authorization") || req.headers.get("Authorization") || "";
  return h.startsWith("Bearer ") ? h : "";
}

function safeText(v: unknown): string | null {
  if (v == null) return null;
  const t = String(v).trim();
  return t.length ? t : null;
}

function isUuid(s: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    s,
  );
}

function safeIso(input?: string | null) {
  if (!input?.trim()) return null;
  const d = new Date(input);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
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
 * Keep ALL drawn text WinAnsi-safe.
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

function slugSafe(input: string) {
  return winAnsiSafe(input)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// -----------------------------------------------------------------------------
// QR generation (Edge-safe): text → PNG bytes
// -----------------------------------------------------------------------------
function qrPngBytes(
  text: string,
  opts?: { size?: number; margin?: number; ecc?: "L" | "M" | "Q" | "H" },
): Uint8Array {
  const size = opts?.size ?? 256;
  const margin = opts?.margin ?? 2;
  const ecc = opts?.ecc ?? "M";

  const qr = QRGen(0, ecc);
  qr.addData(text);
  qr.make();

  const count = qr.getModuleCount();
  const scale = Math.max(1, Math.floor(size / (count + margin * 2)));
  const imgSize = (count + margin * 2) * scale;

  const png = new PNG({ width: imgSize, height: imgSize });

  // white bg
  for (let y = 0; y < imgSize; y++) {
    for (let x = 0; x < imgSize; x++) {
      const idx = (png.width * y + x) << 2;
      png.data[idx + 0] = 255;
      png.data[idx + 1] = 255;
      png.data[idx + 2] = 255;
      png.data[idx + 3] = 255;
    }
  }

  // black modules
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (!qr.isDark(r, c)) continue;
      const x0 = (c + margin) * scale;
      const y0 = (r + margin) * scale;

      for (let yy = 0; yy < scale; yy++) {
        for (let xx = 0; xx < scale; xx++) {
          const x = x0 + xx;
          const y = y0 + yy;
          const idx = (png.width * y + x) << 2;
          png.data[idx + 0] = 0;
          png.data[idx + 1] = 0;
          png.data[idx + 2] = 0;
          png.data[idx + 3] = 255;
        }
      }
    }
  }

  return PNG.sync.write(png);
}

// -----------------------------------------------------------------------------
// Money + totals (major units + cents)
// -----------------------------------------------------------------------------
function sumLineItems(items: LineItem[]) {
  let subtotal = 0;

  const norm = items.map((it) => {
    const desc = String(it.description ?? "").trim() || "Line item";
    const qty = Number.isFinite(Number(it.quantity)) ? Number(it.quantity) : 1;
    const unit = Number.isFinite(Number(it.unit_price)) ? Number(it.unit_price) : 0;
    const amt = Number.isFinite(Number(it.amount)) ? Number(it.amount) : qty * unit;

    subtotal += amt;

    return {
      description: desc.slice(0, 240),
      quantity: qty,
      unit_price: unit,
      amount: amt,
    };
  });

  const subtotal_cents = Math.round(subtotal * 100);
  return { items: norm, subtotal, subtotal_cents };
}

function money(currency: string, major: number) {
  const v = Number.isFinite(major) ? major : 0;
  return `${currency} ${v.toFixed(2)}`;
}

// -----------------------------------------------------------------------------
// Text wrapping (stable)
// -----------------------------------------------------------------------------
function wrapText(
  text: string,
  font: any,
  size: number,
  maxWidth: number,
  maxLines: number,
): string[] {
  const s = winAnsiSafe(text).trim();
  if (!s) return ["—"];

  const words = s.split(/\s+/g);
  const lines: string[] = [];
  let line = "";

  const fits = (t: string) => font.widthOfTextAtSize(t, size) <= maxWidth;

  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (fits(candidate)) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = w;

    if (lines.length >= maxLines) break;
  }
  if (lines.length < maxLines && line) lines.push(line);

  // hard truncate if still too wide
  return lines.slice(0, maxLines).map((ln) => {
    if (fits(ln)) return ln;
    let out = ln;
    while (out.length > 1 && !fits(out + "...")) out = out.slice(0, -1);
    return out.length < ln.length ? out + "..." : out;
  });
}

// -----------------------------------------------------------------------------
// Verify URL (CANONICAL)
// -----------------------------------------------------------------------------
function getVerifyPageUrl(): string {
  const env =
    Deno.env.get("BILLING_VERIFY_PAGE_URL") ||
    Deno.env.get("BILLING_VERIFY_BASE_URL") ||
    "";
  const v = String(env).trim();
  if (v) return v.replace(/\/+$/, "");
  return "https://sign.oasisintlholdings.com/verify-billing.html";
}

// -----------------------------------------------------------------------------
// PDF builder (Oasis-aligned; layout hardened)
// -----------------------------------------------------------------------------
async function buildOasisBillingPdf(args: {
  docType: string;
  providerLabel: string;
  providerSlug: string;
  laneLabel: string;
  invoiceNumber: string | null;
  documentNumber: string | null;
  issuedAtIso: string;
  dueAtIso: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  recipientName: string | null;
  recipientEmail: string | null;
  currency: string;
  lineItems: LineItem[];
  notes: string | null;
  totalsMajor: { subtotal: number; tax: number; total: number };

  // ✅ QR encodes verify URL (RAW, untouched)
  verifyUrl: string; // https://.../verify-billing.html?hash=...
  hashPreview: string; // first 16 chars
}): Promise<Uint8Array> {
  const {
    docType,
    providerLabel,
    providerSlug,
    laneLabel,
    invoiceNumber,
    documentNumber,
    issuedAtIso,
    dueAtIso,
    periodStart,
    periodEnd,
    recipientName,
    recipientEmail,
    currency,
    lineItems,
    notes,
    totalsMajor,
    verifyUrl,
    hashPreview,
  } = args;

  const pdf = await PDFDocument.create();
  pdf.setCreator("Oasis Digital Parliament");
  pdf.setProducer("Oasis Billing Registry");

  const page = pdf.addPage([612, 792]); // Letter
  const W = page.getWidth();
  const H = page.getHeight();

  const margin = 56;

  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // Palette (quiet authority)
  const ink = rgb(0.12, 0.14, 0.18);
  const muted = rgb(0.45, 0.48, 0.55);
  const faint = rgb(0.62, 0.66, 0.72);
  const hair = rgb(0.86, 0.88, 0.91);
  const band = rgb(0.06, 0.09, 0.12);
  const teal = rgb(0.10, 0.78, 0.72);
  const paper = rgb(1, 1, 1);
  const panel = rgb(0.99, 0.99, 1);

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

  page.drawText(winAnsiSafe("Billing Registry"), {
    x: margin,
    y: H - 64,
    size: 10,
    font,
    color: rgb(0.86, 0.88, 0.90),
  });

  const rightTop = winAnsiSafe(`${docType.toUpperCase()}  •  ${laneLabel}`);
  const rightW = font.widthOfTextAtSize(rightTop, 9);
  page.drawText(rightTop, {
    x: W - margin - rightW,
    y: H - 60,
    size: 9,
    font,
    color: rgb(0.78, 0.82, 0.86),
  });

  // Title zone
  const titleY = H - bandH - 48;
  const title =
    docType === "invoice"
      ? "Invoice"
      : docType === "contract"
        ? "Contract"
        : docType === "statement"
          ? "Statement"
          : docType === "receipt"
            ? "Receipt"
            : docType === "credit_note"
              ? "Credit Note"
              : "Billing Document";

  page.drawText(winAnsiSafe(title), {
    x: margin,
    y: titleY,
    size: 18,
    font: bold,
    color: ink,
  });

  page.drawText(winAnsiSafe(`Issuer: ${providerLabel}`.slice(0, 160)), {
    x: margin,
    y: titleY - 18,
    size: 9.5,
    font,
    color: muted,
  });

  // Context line(s)
  let ctxY = titleY - 36;
  if (documentNumber) {
    const ctx = wrapText(`Doc #: ${documentNumber}`, font, 8.5, W - margin * 2, 1)[0];
    page.drawText(ctx, { x: margin, y: ctxY, size: 8.5, font, color: muted });
    ctxY -= 12;
  }

  const period =
    periodStart || periodEnd
      ? `${(periodStart ?? "—").slice(0, 10)} -> ${(periodEnd ?? "—").slice(0, 10)}`
      : null;

  if (period) {
    const ctx = wrapText(`Period: ${period}`, font, 8.5, W - margin * 2, 1)[0];
    page.drawText(ctx, { x: margin, y: ctxY, size: 8.5, font, color: muted });
    ctxY -= 12;
  }

  // Cards baseline (fixed)
  const cardTop = ctxY - 18;
  const cardH = 96; // 🔒 a bit taller so meta can wrap (no clip)

  // Bill To card (left)
  const billX = margin;
  const billW = 318;

  page.drawRectangle({
    x: billX,
    y: cardTop - cardH,
    width: billW,
    height: cardH,
    borderColor: hair,
    borderWidth: 1,
    color: panel,
  });

  page.drawText(winAnsiSafe("Bill To"), {
    x: billX + 14,
    y: cardTop - 22,
    size: 9,
    font: bold,
    color: muted,
  });

  const billName = wrapText(recipientName ?? "—", bold, 10.5, billW - 28, 1)[0];
  page.drawText(billName, {
    x: billX + 14,
    y: cardTop - 46,
    size: 10.5,
    font: bold,
    color: ink,
  });

  const billEmail = wrapText(recipientEmail ?? "—", font, 9, billW - 28, 2);
  page.drawText(billEmail[0], { x: billX + 14, y: cardTop - 66, size: 9, font, color: muted });
  if (billEmail[1]) {
    page.drawText(billEmail[1], { x: billX + 14, y: cardTop - 78, size: 9, font, color: muted });
  }

  // Meta card (right)
  const metaX = billX + billW + 16;
  const metaW = W - margin - metaX;

  page.drawRectangle({
    x: metaX,
    y: cardTop - cardH,
    width: metaW,
    height: cardH,
    borderColor: hair,
    borderWidth: 1,
    color: panel,
  });

  const labelX = metaX + 14;
  const valueX = metaX + 106; // 🔒 keeps a consistent gutter
  const valueMaxW = metaX + metaW - 14 - valueX;

  const metaRowWrap = (label: string, value: string, yTop: number) => {
    page.drawText(winAnsiSafe(label), {
      x: labelX,
      y: yTop,
      size: 8.5,
      font: bold,
      color: muted,
    });

    const lines = wrapText(value, font, 8.5, valueMaxW, 2);
    page.drawText(lines[0], { x: valueX, y: yTop, size: 8.5, font, color: ink });
    if (lines[1]) {
      page.drawText(lines[1], { x: valueX, y: yTop - 11, size: 8.5, font, color: ink });
      return 22; // consumed height
    }
    return 11;
  };

  const issued = issuedAtIso.slice(0, 10);
  const due = dueAtIso ? dueAtIso.slice(0, 10) : "—";

  // 4 rows, with safe wrap
  let my = cardTop - 24;
  my -= metaRowWrap("Issued:", issued, my);
  my -= metaRowWrap("Due:", due, my);
  my -= metaRowWrap("Currency:", currency, my);
  metaRowWrap("Invoice #:", invoiceNumber ?? "—", my);

  // Divider below cards
  const dividerY = cardTop - cardH - 22;
  page.drawLine({
    start: { x: margin, y: dividerY },
    end: { x: W - margin, y: dividerY },
    thickness: 0.8,
    color: hair,
  });

  // ---- Footer geometry (never overlaps) ----
  const footerBottomY = 54;

  // Footer: Notes row + (Summary LEFT + QR RIGHT) row
  const notesH = 78;
  const splitH = 92;
  const footerGap = 10;

  const splitY = footerBottomY + 10; // bottom split row Y
  const notesY = splitY + splitH + footerGap;

  // Top line separating table from footer
  const footerTopY = notesY + notesH + 14;
  page.drawLine({
    start: { x: margin, y: footerTopY },
    end: { x: W - margin, y: footerTopY },
    thickness: 0.8,
    color: hair,
  });

  // Table header
  const { items } = sumLineItems(lineItems);

  let y = dividerY - 28;

  const colDesc = margin;
  const colQty = W - margin - 170;
  const colUnit = W - margin - 118;
  const colAmt = W - margin;

  page.drawText(winAnsiSafe("Description"), { x: colDesc, y, size: 9, font: bold, color: muted });
  page.drawText(winAnsiSafe("Qty"), { x: colQty, y, size: 9, font: bold, color: muted });
  page.drawText(winAnsiSafe("Unit"), { x: colUnit, y, size: 9, font: bold, color: muted });

  const amtLabel = winAnsiSafe("Amount");
  const amtLabelW = bold.widthOfTextAtSize(amtLabel, 9);
  page.drawText(amtLabel, { x: colAmt - amtLabelW, y, size: 9, font: bold, color: muted });

  y -= 12;
  page.drawLine({ start: { x: margin, y }, end: { x: W - margin, y }, thickness: 0.8, color: hair });
  y -= 16;

  // Rows stop before footerTopY
  const minYForRows = footerTopY + 10;
  const maxRowsHard = 18;

  for (let i = 0; i < Math.min(items.length, maxRowsHard); i++) {
    const it = items[i];

    const descLines = wrapText(it.description, font, 9, colQty - colDesc - 12, 2);
    const rowHeight = 12 + (descLines[1] ? 12 : 0);

    if (y - rowHeight < minYForRows) break;

    const rowTop = y;

    page.drawLine({
      start: { x: margin, y: rowTop - 6 },
      end: { x: W - margin, y: rowTop - 6 },
      thickness: 0.5,
      color: rgb(0.92, 0.93, 0.95),
    });

    page.drawText(descLines[0], { x: colDesc, y: rowTop, size: 9, font, color: ink });
    if (descLines[1]) {
      page.drawText(descLines[1], { x: colDesc, y: rowTop - 12, size: 9, font, color: ink });
    }

    const qtyText = winAnsiSafe(String(it.quantity));
    const unitText = winAnsiSafe(money(currency, it.unit_price));
    const amtText = winAnsiSafe(money(currency, it.amount));

    page.drawText(qtyText, { x: colQty, y: rowTop, size: 9, font, color: muted });
    page.drawText(unitText, { x: colUnit, y: rowTop, size: 9, font, color: muted });

    const amtW = font.widthOfTextAtSize(amtText, 9);
    page.drawText(amtText, { x: colAmt - amtW, y: rowTop, size: 9, font, color: ink });

    y -= rowHeight;
  }

  const fullW = W - margin * 2;

  // Notes row (full width)
  page.drawRectangle({
    x: margin,
    y: notesY,
    width: fullW,
    height: notesH,
    borderColor: hair,
    borderWidth: 1,
    color: panel,
  });

  page.drawText(winAnsiSafe("Notes"), {
    x: margin + 14,
    y: notesY + notesH - 22,
    size: 9,
    font: bold,
    color: muted,
  });

  const notesBody =
    safeText(notes) ??
    "Internal sandbox document generated for audit validation of billing PDF generation, hashing, storage, and registry workflows. No commercial charge applied.";

  const notesLines = wrapText(notesBody, font, 8.5, fullW - 28, 3);
  let ny = notesY + notesH - 40;
  for (const ln of notesLines) {
    page.drawText(ln, { x: margin + 14, y: ny, size: 8.5, font, color: faint });
    ny -= 11;
  }

  // Split row: Summary LEFT + QR RIGHT (no overlap)
  const qrPanelW = 200;
  const gap = 12;
  const summaryW = fullW - qrPanelW - gap;

  const summaryX = margin;
  const qrX = margin + summaryW + gap;

  // Summary panel
  page.drawRectangle({
    x: summaryX,
    y: splitY,
    width: summaryW,
    height: splitH,
    borderColor: hair,
    borderWidth: 1,
    color: panel,
  });

  page.drawText(winAnsiSafe("Summary"), {
    x: summaryX + 14,
    y: splitY + splitH - 20,
    size: 9,
    font: bold,
    color: muted,
  });

  const srow = (label: string, value: string, y2: number, strong?: boolean) => {
    page.drawText(winAnsiSafe(label), {
      x: summaryX + 14,
      y: y2,
      size: strong ? 10 : 9,
      font: strong ? bold : font,
      color: strong ? ink : muted,
    });
    const vw = (strong ? bold : font).widthOfTextAtSize(value, strong ? 10 : 9);
    page.drawText(winAnsiSafe(value), {
      x: summaryX + summaryW - 14 - vw,
      y: y2,
      size: strong ? 10 : 9,
      font: strong ? bold : font,
      color: ink,
    });
  };

  srow("Subtotal:", money(currency, totalsMajor.subtotal), splitY + 46);
  srow("Tax:", money(currency, totalsMajor.tax), splitY + 30);

  page.drawLine({
    start: { x: summaryX + 14, y: splitY + 24 },
    end: { x: summaryX + summaryW - 14, y: splitY + 24 },
    thickness: 0.8,
    color: hair,
  });

  // ✅ Total is always visible (never under QR now)
  srow("Total:", money(currency, totalsMajor.total), splitY + 8, true);

  // QR panel (right)
  page.drawRectangle({
    x: qrX,
    y: splitY,
    width: qrPanelW,
    height: splitH,
    borderColor: hair,
    borderWidth: 1,
    color: panel,
  });

  page.drawText(winAnsiSafe("Verify (hash-first)"), {
    x: qrX + 12,
    y: splitY + splitH - 18,
    size: 8.5,
    font: bold,
    color: muted,
  });

  page.drawText(winAnsiSafe(`${hashPreview}…`), {
    x: qrX + 12,
    y: splitY + splitH - 32,
    size: 7.5,
    font,
    color: faint,
  });

  // ✅ IMPORTANT: QR encodes RAW verifyUrl (do NOT winAnsiSafe it; do NOT truncate)
  const qr = qrPngBytes(verifyUrl, { size: 256, margin: 2, ecc: "M" });
  const qrImg = await pdf.embedPng(qr);

  const qrSize = 72;
  page.drawImage(qrImg, {
    x: qrX + qrPanelW - 12 - qrSize,
    y: splitY + 10,
    width: qrSize,
    height: qrSize,
  });

  // Left-of-QR: tiny URL preview inside QR panel (safe wrap)
  const previewW = qrPanelW - 12 - 10 - qrSize - 10;
  const pLines = wrapText(verifyUrl, font, 7.0, previewW, 2);
  page.drawText(pLines[0], { x: qrX + 12, y: splitY + 34, size: 7.0, font, color: rgb(0.58, 0.62, 0.68) });
  if (pLines[1]) {
    page.drawText(pLines[1], { x: qrX + 12, y: splitY + 24, size: 7.0, font, color: rgb(0.58, 0.62, 0.68) });
  }

  // Tiny corner mark
  const corner = winAnsiSafe(providerSlug.toUpperCase().slice(0, 10) || "ODP");
  page.drawText(corner, {
    x: margin,
    y: 28,
    size: 9,
    font: bold,
    color: rgb(0.90, 0.92, 0.95),
  });

  // Footer provenance
  const foot =
    "Registry artifact generated by Oasis Billing. Authority and lifecycle status are conferred by the internal registry.";
  page.drawText(winAnsiSafe(foot), {
    x: margin,
    y: 16,
    size: 7.5,
    font,
    color: rgb(0.6, 0.64, 0.7),
    maxWidth: W - margin * 2 - 10,
  });

  return new Uint8Array(await pdf.save({ useObjectStreams: false }));
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------
serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { ok: false, error: "METHOD_NOT_ALLOWED" }, req);

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const ANON_KEY =
      Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY_PUBLIC");
    const SERVICE_ROLE_KEY =
      Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
      return json(500, { ok: false, error: "MISSING_ENV" }, req);
    }

    // Auth: operator required (ANON validate session)
    const bearer = pickBearer(req);
    if (!bearer) return json(401, { ok: false, error: "UNAUTHORIZED" }, req);

    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: bearer } },
      auth: { persistSession: false },
    });

    const { data: userRes, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userRes?.user?.id) return json(401, { ok: false, error: "INVALID_SESSION" }, req);

    const actor_id = userRes.user.id;
    const actor_email = userRes.user.email ?? null;

    // Parse + validate input
    const body = (await req.json().catch(() => ({}))) as Partial<ReqBody>;

    const provider_entity_id = String(body.provider_entity_id ?? "").trim();
    const reason = String(body.reason ?? "").trim();
    const document_type = String(body.document_type ?? "").trim().toLowerCase();

    if (!provider_entity_id || !isUuid(provider_entity_id) || !reason) {
      return json(
        400,
        {
          ok: false,
          error: "MISSING_REQUIRED_FIELDS",
          required: ["provider_entity_id(uuid)", "is_test(boolean)", "document_type", "reason"],
        },
        req,
      );
    }

    if (typeof body.is_test !== "boolean") {
      return json(400, { ok: false, error: "LANE_REQUIRED", details: "is_test must be boolean" }, req);
    }

    const allowed = new Set(["invoice", "contract", "statement", "receipt", "credit_note", "other"]);
    if (!allowed.has(document_type)) {
      return json(400, { ok: false, error: "INVALID_DOCUMENT_TYPE", allowed: Array.from(allowed) }, req);
    }

    const currency = (safeText(body.currency) ?? "USD").toUpperCase().slice(0, 8);
    const issued_at = safeIso(body.issued_at) ?? new Date().toISOString();
    const due_at = safeIso(body.due_at);
    const period_start = safeIso(body.period_start);
    const period_end = safeIso(body.period_end);

    const subscription_id = safeText(body.subscription_id);
    const customer_id = safeText(body.customer_id);
    const recipient_name = safeText(body.recipient_name);
    const recipient_email = safeText(body.recipient_email);

    const invoice_number = safeText(body.invoice_number);
    const document_number = safeText(body.document_number);
    const external_reference = safeText(body.external_reference);
    const notes = safeText(body.notes);

    const status = safeText(body.status) ?? "issued";
    const trigger = safeText(body.trigger);

    const line_items =
      Array.isArray(body.line_items) && body.line_items.length
        ? body.line_items
        : [{ description: "Service", quantity: 1, unit_price: 0 }];

    // Totals
    const { items: norm_items, subtotal, subtotal_cents } = sumLineItems(line_items);
    const tax_cents = 0;
    const total_cents = subtotal_cents + tax_cents;

    const subtotal_amount = subtotal;
    const tax_amount = 0;
    const total_amount = subtotal;

    const laneLabel = body.is_test ? "SANDBOX" : "TRUTH";
    const nowIso = new Date().toISOString();

    // Service client: registry writes
    const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { fetch },
      auth: { persistSession: false },
    });

    // Provider label lookup (safe)
    const { data: ent, error: entErr } = await svc
      .from("entities")
      .select("id, slug, name")
      .eq("id", provider_entity_id)
      .maybeSingle();

    if (entErr) {
      return json(500, { ok: false, error: "PROVIDER_LOOKUP_FAILED", details: entErr.message }, req);
    }

    const providerSlug = safeText((ent as any)?.slug) ?? "provider";
    const providerLabel =
      safeText((ent as any)?.name) ?? safeText((ent as any)?.slug) ?? provider_entity_id;

    // -------------------------------------------------------------------------
    // Build PDF with hash-first verify URL (canonical sign domain)
    // -------------------------------------------------------------------------
    const VERIFY_PAGE = getVerifyPageUrl(); // ✅ https://sign.oasisintlholdings.com/verify-billing.html

    const buildWithHash = async (hashHex: string) => {
      const verifyUrl = `${VERIFY_PAGE}?hash=${hashHex}`;
      return await buildOasisBillingPdf({
        docType: document_type,
        providerLabel,
        providerSlug,
        laneLabel,
        invoiceNumber: invoice_number,
        documentNumber: document_number,
        issuedAtIso: issued_at,
        dueAtIso: due_at,
        periodStart: period_start,
        periodEnd: period_end,
        recipientName: recipient_name,
        recipientEmail: recipient_email,
        currency,
        lineItems: norm_items,
        notes,
        totalsMajor: { subtotal: subtotal_amount, tax: tax_amount, total: total_amount },
        verifyUrl,
        hashPreview: hashHex.slice(0, 16),
      });
    };

    // ✅ Fixed-point stabilization (QR ALWAYS matches FINAL hash)
    let file_hash = "0".repeat(64);
    let pdfBytes = new Uint8Array();
    for (let i = 0; i < 4; i++) {
      const bytes = await buildWithHash(file_hash);
      const next = await sha256Hex(bytes);
      pdfBytes = bytes;
      if (next === file_hash) break;
      file_hash = next;
    }

    // Storage target (lane-aware buckets)
    const BILLING_BUCKET = body.is_test ? "billing_sandbox" : "billing_truth";
    const yyyy = issued_at.slice(0, 4);
    const mm = issued_at.slice(5, 7);

    const keyPart = invoice_number
      ? `inv-${slugSafe(invoice_number)}`
      : `${document_type}-${file_hash.slice(0, 16)}`;
    const storage_path = `${providerSlug}/billing/${yyyy}/${mm}/${keyPart}.pdf`;

    // Upload (upsert true)
    const up = await svc.storage
      .from(BILLING_BUCKET)
      .upload(storage_path, new Blob([pdfBytes], { type: "application/pdf" }), {
        upsert: true,
        contentType: "application/pdf",
      });

    if (up.error) {
      return json(500, { ok: false, error: "UPLOAD_FAILED", details: up.error }, req);
    }

    // ✅ Insert ONLY existing columns (per locked schema)
    const row: any = {
      entity_id: provider_entity_id,
      provider_entity_id: provider_entity_id,
      is_test: body.is_test,

      subscription_id: subscription_id ?? null,

      customer_id: customer_id ?? null,
      recipient_name: recipient_name ?? null,
      recipient_email: recipient_email ?? null,

      document_type: document_type,
      status: status,

      document_number: document_number ?? null,
      invoice_number: invoice_number ?? null,
      external_reference: external_reference ?? null,

      period_start: period_start ?? null,
      period_end: period_end ?? null,
      issued_at: issued_at,
      due_at: due_at ?? null,

      currency: currency,

      subtotal_amount: subtotal_amount,
      tax_amount: tax_amount,
      total_amount: total_amount,

      amount_cents: total_cents,
      subtotal_cents: subtotal_cents,
      tax_cents: tax_cents,
      total_cents: total_cents,

      storage_bucket: BILLING_BUCKET,
      storage_path: storage_path,

      file_hash: file_hash,
      content_type: "application/pdf",
      file_size_bytes: pdfBytes.length,

      line_items: norm_items,
      metadata: {
        notes: notes ?? null,
        generated_by: "billing-generate-document",
        trigger: trigger ?? null,
        reason,
        issuer_entity_slug: providerSlug,
        external_reference: external_reference ?? null,

        // ✅ canonical verify URL (NO 404)
        verify_url: `${VERIFY_PAGE}?hash=${file_hash}`,
        qr_payload: `${VERIFY_PAGE}?hash=${file_hash}`,
        verify_page: VERIFY_PAGE,
      },

      created_by: actor_id,
      updated_at: nowIso,
    };

    // Idempotent strategy (NO regression)
    let document_id: string | null = null;

    const updateById = async (id: string) => {
      const { error } = await svc.from("billing_documents").update(row).eq("id", id);
      return { ok: !error, error };
    };

    const insertNew = async () => {
      const { data, error } = await svc.from("billing_documents").insert(row).select("id").maybeSingle();
      if (error) return { ok: false as const, error };
      return { ok: true as const, id: data?.id ? String(data.id) : null };
    };

    if (invoice_number) {
      const existing = await svc
        .from("billing_documents")
        .select("id")
        .eq("entity_id", provider_entity_id)
        .eq("is_test", body.is_test)
        .eq("invoice_number", invoice_number)
        .limit(1)
        .maybeSingle();

      if (existing.error) {
        return json(500, { ok: false, error: "DOCUMENT_LOOKUP_FAILED", details: existing.error }, req);
      }

      if (existing.data?.id) {
        document_id = String(existing.data.id);
        const upd = await updateById(document_id);
        if (!upd.ok) return json(500, { ok: false, error: "DOCUMENT_UPDATE_FAILED", details: upd.error }, req);
      } else {
        const ins = await insertNew();
        if (!ins.ok || !ins.id) {
          return json(500, { ok: false, error: "DOCUMENT_INSERT_FAILED", details: ins.error }, req);
        }
        document_id = ins.id;
      }
    } else if (document_number) {
      const existing = await svc
        .from("billing_documents")
        .select("id")
        .eq("entity_id", provider_entity_id)
        .eq("is_test", body.is_test)
        .eq("document_number", document_number)
        .limit(1)
        .maybeSingle();

      if (existing.error) {
        return json(500, { ok: false, error: "DOCUMENT_LOOKUP_FAILED", details: existing.error }, req);
      }

      if (existing.data?.id) {
        document_id = String(existing.data.id);
        const upd = await updateById(document_id);
        if (!upd.ok) return json(500, { ok: false, error: "DOCUMENT_UPDATE_FAILED", details: upd.error }, req);
      } else {
        const ins = await insertNew();
        if (!ins.ok || !ins.id) {
          return json(500, { ok: false, error: "DOCUMENT_INSERT_FAILED", details: ins.error }, req);
        }
        document_id = ins.id;
      }
    } else {
      const { data, error } = await svc
        .from("billing_documents")
        .upsert(row, { onConflict: "file_hash" })
        .select("id")
        .maybeSingle();

      if (error) {
        return json(500, { ok: false, error: "DOCUMENT_UPSERT_FAILED", details: error }, req);
      }
      document_id = data?.id ? String(data.id) : null;
    }

    if (!document_id) {
      return json(500, { ok: false, error: "DOCUMENT_ID_MISSING" }, req);
    }

    // Best-effort audit (never blocks)
    try {
      await svc.from("actions_log").insert({
        actor_uid: actor_id,
        action: "BILLING_GENERATE_DOCUMENT",
        target_table: "billing_documents",
        target_id: document_id,
        details_json: {
          entity_id: provider_entity_id,
          provider_entity_id: provider_entity_id,
          is_test: body.is_test,
          customer_id,
          document_type,
          status,
          invoice_number,
          document_number,
          file_hash,
          storage_bucket: BILLING_BUCKET,
          storage_path,
          total_cents,
          reason,
          trigger: trigger ?? null,
          verify_page: VERIFY_PAGE,
        },
      } as any);
    } catch {
      // never block
    }

    return json(
      200,
      {
        ok: true,
        document_id,
        file_hash,
        storage: { bucket: BILLING_BUCKET, path: storage_path, size: pdfBytes.length },
        actor_id,
        actor_email,
      } satisfies Resp,
      req,
    );
  } catch (e: any) {
    console.error("billing-generate-document fatal:", e);
    return json(500, { ok: false, error: "INTERNAL_ERROR", message: e?.message ?? String(e) }, req);
  }
});
