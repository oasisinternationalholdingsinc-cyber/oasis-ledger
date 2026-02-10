// supabase/functions/billing-generate-document/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";

// ✅ Edge-safe QR (NO canvas / NO wasm)
import QRGen from "npm:qrcode-generator@1.4.4";
import { PNG } from "npm:pngjs@7.0.0";

/**
 * CI-Billing — billing-generate-document (PRODUCTION — LOCKED)
 *
 * ✅ OPERATOR-ONLY (valid user session required)
 * ✅ REGISTRY-GRADE (writes billing_documents)
 * ✅ NO PAYMENTS / NO ENFORCEMENT
 * ✅ Lane-safe via is_test (must be provided; never inferred)
 * ✅ Edge-safe PDF + hash (NO canvas / NO wasm)
 *
 * Purpose:
 * - Generate invoice/contract/statement PDFs in Oasis enterprise style
 * - Upload to Storage (lane-safe path)
 * - Register pointers + file_hash in billing_documents
 *
 * Compatibility (NO REGRESSION):
 * - Writes tolerant alias fields when present in schema:
 *   - entity_id (alias for provider_entity_id)
 *   - document_kind/kind (alias for document_type)
 *   - amount_cents/total_cents (computed from line_items subtotal)
 *
 * Idempotence:
 * - Storage upload is content-addressed-ish (hash in path). If upload exists -> continue.
 * - billing_documents insert:
 *   - If insert fails (likely unique constraint), we fetch existing by file_hash and return it.
 *
 * IMPORTANT:
 * - This function does NOT certify billing docs publicly; it is a registry artifact generator.
 * - Public verification/certification is a separate authority action (later: billing-certify-document).
 */

type LineItem = {
  description: string;
  quantity?: number;
  unit_price?: number; // in "major units" (e.g., 49.00)
  amount?: number; // optional override (major units)
};

type ReqBody = {
  // Provider scope (issuer)
  provider_entity_id: string; // REQUIRED (active OS entity id)
  is_test: boolean; // REQUIRED (lane-safe)

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
  title?: string | null;

  // Invoice fields
  invoice_number?: string | null; // optional (if you have your own numbering)
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
};

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, Authorization, apikey, content-type, x-client-info",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
};

function json(status: number, body: unknown, req: Request) {
  const request_id =
    req.headers.get("x-sb-request-id") ||
    req.headers.get("x-sb-requestid") ||
    null;

  return new Response(
    JSON.stringify({ ...(body as any), request_id } satisfies Resp, null, 2),
    {
      status,
      headers: { ...cors, "content-type": "application/json; charset=utf-8" },
    },
  );
}

function pickBearer(req: Request) {
  const h =
    req.headers.get("authorization") ||
    req.headers.get("Authorization") ||
    "";
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

// -----------------------------------------------------------------------------
// ✅ QR generation (Edge-safe): text → PNG bytes (NO wasm / NO canvas)
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
// ✅ Oasis enterprise invoice math + formatting
// -----------------------------------------------------------------------------
function money(n: number, currency: string) {
  const v = Number.isFinite(n) ? n : 0;
  return `${currency} ${v.toFixed(2)}`;
}

function sumLineItems(items: LineItem[], currency: string) {
  let subtotal = 0;

  const norm = items.map((it) => {
    const desc = String(it.description ?? "").trim() || "Line item";
    const qty = Number.isFinite(Number(it.quantity)) ? Number(it.quantity) : 1;
    const unit = Number.isFinite(Number(it.unit_price)) ? Number(it.unit_price) : 0;
    const amt = Number.isFinite(Number(it.amount)) ? Number(it.amount) : qty * unit;

    subtotal += amt;

    return {
      description: desc.slice(0, 120),
      quantity: qty,
      unit_price: unit,
      amount: amt,
      currency,
    };
  });

  return { subtotal, items: norm };
}

// -----------------------------------------------------------------------------
// ✅ Oasis enterprise billing PDF (single doc)
// -----------------------------------------------------------------------------
async function buildOasisBillingPdf(args: {
  docType: string;
  title: string;
  providerLabel: string;
  laneLabel: string;
  invoiceNumber: string | null;
  issuedAtIso: string;
  dueAtIso: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  recipientName: string | null;
  recipientEmail: string | null;
  currency: string;
  lineItems: LineItem[];
  notes: string | null;
  internalRef: string; // used for QR (internal only)
}): Promise<Uint8Array> {
  const {
    docType,
    title,
    providerLabel,
    laneLabel,
    invoiceNumber,
    issuedAtIso,
    dueAtIso,
    periodStart,
    periodEnd,
    recipientName,
    recipientEmail,
    currency,
    lineItems,
    notes,
    internalRef,
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

  // palette (aligned with certify style)
  const ink = rgb(0.12, 0.14, 0.18);
  const muted = rgb(0.45, 0.48, 0.55);
  const hair = rgb(0.86, 0.88, 0.91);
  const band = rgb(0.06, 0.09, 0.12);
  const teal = rgb(0.10, 0.78, 0.72);
  const paper = rgb(1, 1, 1);

  // background
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: paper });

  // header band
  const bandH = 92;
  page.drawRectangle({ x: 0, y: H - bandH, width: W, height: bandH, color: band });

  page.drawText("Oasis Digital Parliament", {
    x: margin,
    y: H - 42,
    size: 14,
    font: bold,
    color: teal,
  });

  page.drawText("Billing Registry", {
    x: margin,
    y: H - 64,
    size: 10,
    font,
    color: rgb(0.86, 0.88, 0.9),
  });

  const rightTop = `${docType.toUpperCase()} • ${laneLabel}`;
  const rightW = font.widthOfTextAtSize(rightTop, 9);
  page.drawText(rightTop, {
    x: W - margin - rightW,
    y: H - 60,
    size: 9,
    font,
    color: rgb(0.78, 0.82, 0.86),
  });

  // Title block
  const topY = H - bandH - 48;
  page.drawText(title.slice(0, 96), {
    x: margin,
    y: topY,
    size: 16,
    font: bold,
    color: ink,
  });

  page.drawText(`Issuer: ${providerLabel}`.slice(0, 120), {
    x: margin,
    y: topY - 18,
    size: 9.5,
    font,
    color: muted,
  });

  // Recipient block
  const rx = margin;
  const ry = topY - 70;
  const rw = 300;
  const rh = 78;
  page.drawRectangle({
    x: rx,
    y: ry,
    width: rw,
    height: rh,
    borderColor: hair,
    borderWidth: 1,
    color: rgb(0.99, 0.99, 1),
  });

  page.drawText("Bill To", {
    x: rx + 12,
    y: ry + rh - 22,
    size: 9,
    font: bold,
    color: muted,
  });

  page.drawText((recipientName ?? "—").slice(0, 64), {
    x: rx + 12,
    y: ry + 36,
    size: 10,
    font: bold,
    color: ink,
  });

  page.drawText((recipientEmail ?? "—").slice(0, 64), {
    x: rx + 12,
    y: ry + 20,
    size: 9,
    font,
    color: muted,
  });

  // Meta block (right)
  const mx = margin + 320;
  const my = ry;
  const mw = W - margin - mx;
  const mh = rh;
  page.drawRectangle({
    x: mx,
    y: my,
    width: mw,
    height: mh,
    borderColor: hair,
    borderWidth: 1,
    color: rgb(0.99, 0.99, 1),
  });

  const metaRow = (label: string, value: string, y: number) => {
    page.drawText(label, { x: mx + 12, y, size: 8.5, font: bold, color: muted });
    page.drawText(value.slice(0, 40), { x: mx + 110, y, size: 8.5, font, color: ink });
  };

  const issued = issuedAtIso.slice(0, 10);
  const due = dueAtIso ? dueAtIso.slice(0, 10) : "—";
  metaRow("Issued:", issued, my + mh - 22);
  metaRow("Due:", due, my + mh - 38);
  metaRow("Currency:", currency, my + mh - 54);
  metaRow("Invoice #:", invoiceNumber ?? "—", my + mh - 70);

  // Period (optional)
  const period =
    periodStart || periodEnd
      ? `${(periodStart ?? "—").slice(0, 10)} → ${(periodEnd ?? "—").slice(0, 10)}`
      : null;

  if (period) {
    page.drawText(`Period: ${period}`.slice(0, 64), {
      x: margin,
      y: ry - 18,
      size: 8.5,
      font,
      color: muted,
    });
  }

  // Divider
  const lineY = ry - 34;
  page.drawLine({
    start: { x: margin, y: lineY },
    end: { x: W - margin, y: lineY },
    thickness: 0.7,
    color: hair,
  });

  // Items table
  const { subtotal, items } = sumLineItems(lineItems, currency);

  let y = lineY - 26;

  const colDesc = margin;
  const colQty = W - margin - 160;
  const colUnit = W - margin - 110;
  const colAmt = W - margin;

  page.drawText("Description", { x: colDesc, y, size: 9, font: bold, color: muted });
  page.drawText("Qty", { x: colQty, y, size: 9, font: bold, color: muted });
  page.drawText("Unit", { x: colUnit, y, size: 9, font: bold, color: muted });
  page.drawText("Amount", { x: colAmt - 44, y, size: 9, font: bold, color: muted });

  y -= 14;

  page.drawLine({
    start: { x: margin, y },
    end: { x: W - margin, y },
    thickness: 0.7,
    color: hair,
  });

  y -= 14;

  const lineHeight = 14;
  const maxRows = 18;

  for (let i = 0; i < Math.min(items.length, maxRows); i++) {
    const it = items[i];

    page.drawText(it.description, { x: colDesc, y, size: 9, font, color: ink });

    const qtyText = String(it.quantity);
    const unitText = money(it.unit_price, currency);
    const amtText = money(it.amount, currency);

    page.drawText(qtyText, { x: colQty, y, size: 9, font, color: muted });
    page.drawText(unitText, { x: colUnit, y, size: 9, font, color: muted });

    const amtW = font.widthOfTextAtSize(amtText, 9);
    page.drawText(amtText, { x: colAmt - amtW, y, size: 9, font, color: ink });

    y -= lineHeight;
  }

  // Totals box
  const tx = W - margin - 240;
  const ty = 110;
  const tw = 240;
  const th = 78;

  page.drawRectangle({
    x: tx,
    y: ty,
    width: tw,
    height: th,
    borderColor: hair,
    borderWidth: 1,
    color: rgb(0.99, 0.99, 1),
  });

  page.drawText("Summary", { x: tx + 12, y: ty + th - 22, size: 9, font: bold, color: muted });

  const subtotalText = money(subtotal, currency);
  page.drawText("Subtotal:", { x: tx + 12, y: ty + 34, size: 9, font: bold, color: muted });

  const subW = font.widthOfTextAtSize(subtotalText, 9);
  page.drawText(subtotalText, { x: tx + tw - 12 - subW, y: ty + 34, size: 9, font, color: ink });

  page.drawLine({
    start: { x: tx + 12, y: ty + 24 },
    end: { x: tx + tw - 12, y: ty + 24 },
    thickness: 0.7,
    color: hair,
  });

  page.drawText("Total:", { x: tx + 12, y: ty + 10, size: 10, font: bold, color: ink });
  const totalText = money(subtotal, currency);
  const totalW = bold.widthOfTextAtSize(totalText, 10);
  page.drawText(totalText, { x: tx + tw - 12 - totalW, y: ty + 10, size: 10, font: bold, color: ink });

  // Notes block (optional)
  if (notes?.trim()) {
    const nx = margin;
    const ny = 110;
    const nw = 320;
    const nh = 78;

    page.drawRectangle({
      x: nx,
      y: ny,
      width: nw,
      height: nh,
      borderColor: hair,
      borderWidth: 1,
      color: rgb(0.99, 0.99, 1),
    });

    page.drawText("Notes", { x: nx + 12, y: ny + nh - 22, size: 9, font: bold, color: muted });
    page.drawText(notes.trim().slice(0, 220), {
      x: nx + 12,
      y: ny + 42,
      size: 8.5,
      font,
      color: muted,
      maxWidth: nw - 24,
      lineHeight: 11,
    });
  }

  // Optional internal QR (bottom-right) — NOT a public verification claim.
  const qr = qrPngBytes(internalRef, { size: 256, margin: 2, ecc: "M" });
  const qrImg = await pdf.embedPng(qr);
  const qrSize = 92;
  const qrX = W - margin - qrSize;
  const qrY = 36;

  page.drawRectangle({
    x: qrX - 10,
    y: qrY - 10,
    width: qrSize + 20,
    height: qrSize + 20,
    borderColor: hair,
    borderWidth: 1,
    color: rgb(0.99, 0.99, 1),
  });
  page.drawImage(qrImg, { x: qrX, y: qrY, width: qrSize, height: qrSize });

  // Footer
  const foot =
    "Registry artifact generated by Oasis Billing. Authority and lifecycle status are conferred by the internal registry.";
  page.drawText(foot, {
    x: margin,
    y: 44,
    size: 7.5,
    font,
    color: rgb(0.6, 0.64, 0.7),
    maxWidth: W - margin * 2 - 110,
  });

  return new Uint8Array(await pdf.save({ useObjectStreams: false }));
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------
serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") {
    return json(405, { ok: false, error: "METHOD_NOT_ALLOWED" }, req);
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const ANON_KEY =
      Deno.env.get("SUPABASE_ANON_KEY") ??
      Deno.env.get("SUPABASE_ANON_KEY_PUBLIC");
    const SERVICE_ROLE_KEY =
      Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
      return json(500, { ok: false, error: "MISSING_ENV" }, req);
    }

    // -----------------------------
    // Auth: operator required (ANON validate session)
    // -----------------------------
    const bearer = pickBearer(req);
    if (!bearer) return json(401, { ok: false, error: "UNAUTHORIZED" }, req);

    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: bearer } },
      auth: { persistSession: false },
    });

    const { data: userRes, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userRes?.user?.id) {
      return json(401, { ok: false, error: "INVALID_SESSION" }, req);
    }

    const actor_id = userRes.user.id;
    const actor_email = userRes.user.email ?? null;

    // -----------------------------
    // Parse + validate input
    // -----------------------------
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
      return json(
        400,
        { ok: false, error: "INVALID_DOCUMENT_TYPE", allowed: Array.from(allowed) },
        req,
      );
    }

    const currency = (safeText(body.currency) ?? "USD").toUpperCase().slice(0, 8);
    const issued_at = safeIso(body.issued_at) ?? new Date().toISOString();
    const due_at = safeIso(body.due_at);

    const period_start = safeIso(body.period_start);
    const period_end = safeIso(body.period_end);

    const customer_id = safeText(body.customer_id);
    const recipient_name = safeText(body.recipient_name);
    const recipient_email = safeText(body.recipient_email);
    const notes = safeText(body.notes);

    const invoice_number = safeText(body.invoice_number);

    const line_items =
      Array.isArray(body.line_items) && body.line_items.length
        ? body.line_items
        : [{ description: "Service", quantity: 1, unit_price: 0 }];

    const title =
      safeText(body.title) ??
      (document_type === "invoice"
        ? "Invoice"
        : document_type === "contract"
          ? "Contract"
          : document_type === "statement"
            ? "Statement"
            : document_type === "receipt"
              ? "Receipt"
              : document_type === "credit_note"
                ? "Credit Note"
                : "Billing Document");

    const now = new Date().toISOString();
    const laneLabel = body.is_test ? "SANDBOX" : "TRUTH";

    // -----------------------------
    // Service client: registry writes
    // -----------------------------
    const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { fetch },
      auth: { persistSession: false },
    });

    // Provider label (best-effort)
    const { data: ent, error: entErr } = await svc
      .from("entities")
      .select("id, slug, legal_name, name")
      .eq("id", provider_entity_id)
      .maybeSingle();

    if (entErr) {
      return json(500, { ok: false, error: "PROVIDER_LOOKUP_FAILED", details: entErr.message }, req);
    }

    const providerLabel =
      safeText((ent as any)?.legal_name) ??
      safeText((ent as any)?.name) ??
      safeText((ent as any)?.slug) ??
      provider_entity_id;

    // Generate PDF
    const internalRef = `billing:${document_type}:${provider_entity_id}:${now}`;
    const pdfBytes = await buildOasisBillingPdf({
      docType: document_type,
      title,
      providerLabel,
      laneLabel,
      invoiceNumber: invoice_number,
      issuedAtIso: issued_at,
      dueAtIso: due_at,
      periodStart: period_start,
      periodEnd: period_end,
      recipientName: recipient_name,
      recipientEmail: recipient_email,
      currency,
      lineItems: line_items,
      notes,
      internalRef,
    });

    // Hash
    const file_hash = await sha256Hex(pdfBytes);

    // ✅ amount_cents (subtotal only; taxes/discounts later)
    const { subtotal } = sumLineItems(line_items, currency);
    const amount_cents = Math.round(subtotal * 100);

    // Storage target (lane-safe)
    const BILLING_BUCKET = Deno.env.get("BILLING_BUCKET") ?? "billing_documents";

    const providerSlug = safeText((ent as any)?.slug) ?? "provider";
    const prefix = body.is_test ? "sandbox" : "truth";
    const yyyy = issued_at.slice(0, 4);
    const mm = issued_at.slice(5, 7);

    // content-addressed-ish, stable and collision-resistant
    const storage_path = `${prefix}/${providerSlug}/billing/${yyyy}/${mm}/${document_type}-${file_hash.slice(0, 16)}.pdf`;

    // Upload (no upsert; idempotence via same path hash)
    const up = await svc.storage
      .from(BILLING_BUCKET)
      .upload(storage_path, new Blob([pdfBytes], { type: "application/pdf" }), {
        upsert: false,
        contentType: "application/pdf",
      });

    if (up.error) {
      const msg = String((up.error as any)?.message ?? "");
      const alreadyExists =
        msg.toLowerCase().includes("already exists") ||
        msg.toLowerCase().includes("duplicate") ||
        msg.toLowerCase().includes("409");

      if (!alreadyExists) {
        return json(500, { ok: false, error: "UPLOAD_FAILED", details: up.error }, req);
      }
      // else safe: same hash/path already present
    }

    // Register billing_documents row (tolerant insert)
    // IMPORTANT: Keep provider_entity_id canonical. Add compatibility aliases.
    const docRow: any = {
      // ✅ canonical scope
      provider_entity_id,
      is_test: body.is_test,

      // ✅ compatibility aliases (helps resolver/UI)
      entity_id: provider_entity_id, // if schema has it
      document_kind: document_type, // if schema has it
      kind: document_type, // extra tolerance
      amount_cents, // if schema has it
      total_cents: amount_cents, // extra tolerance

      customer_id: customer_id ?? null,
      recipient_name: recipient_name ?? null,
      recipient_email: recipient_email ?? null,

      document_type,
      title,

      invoice_number: invoice_number ?? null,
      currency,
      issued_at,
      due_at: due_at ?? null,
      period_start: period_start ?? null,
      period_end: period_end ?? null,

      storage_bucket: BILLING_BUCKET,
      storage_path,
      file_hash,
      mime_type: "application/pdf",

      metadata: {
        line_items,
        notes: notes ?? null,
        generated_by: "billing-generate-document",
        trigger: body.trigger ?? null,
        reason,
      },

      created_by: actor_id,
      created_at: now,
      updated_at: now,
    };

    // ✅ Idempotent insert: if insert fails (unique constraint), fetch existing by file_hash
    let document_id: string | null = null;

    const { data: ins, error: insErr } = await svc
      .from("billing_documents")
      .insert(docRow)
      .select("id")
      .maybeSingle();

    if (!insErr && ins?.id) {
      document_id = String(ins.id);
    } else {
      const { data: existing, error: exErr } = await svc
        .from("billing_documents")
        .select("id")
        .eq("file_hash", file_hash)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (exErr || !existing?.id) {
        return json(
          500,
          {
            ok: false,
            error: "DOCUMENT_INSERT_FAILED",
            details: insErr?.message ?? "Insert failed and existing lookup failed.",
          },
          req,
        );
      }

      document_id = String(existing.id);
    }

    // Best-effort audit (never blocks)
    await svc
      .from("actions_log")
      .insert({
        actor_uid: actor_id,
        action: "BILLING_GENERATE_DOCUMENT",
        target_table: "billing_documents",
        target_id: document_id,
        details_json: {
          provider_entity_id,
          is_test: body.is_test,
          customer_id,
          document_type,
          file_hash,
          storage_bucket: BILLING_BUCKET,
          storage_path,
          amount_cents,
          reason,
          trigger: body.trigger ?? null,
        },
      } as any)
      .throwOnError()
      .catch(() => {});

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
    return json(
      500,
      { ok: false, error: "INTERNAL_ERROR", message: e?.message ?? String(e) },
      req,
    );
  }
});
