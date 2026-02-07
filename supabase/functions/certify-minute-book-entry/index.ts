// supabase/functions/certify-minute-book-entry/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument, rgb, StandardFonts } from "https://esm.sh/pdf-lib@1.17.1";

// ✅ Edge-safe QR (NO canvas / NO wasm)
import QRGen from "npm:qrcode-generator@1.4.4";
import { PNG } from "npm:pngjs@7.0.0";

type ReqBody = {
  entry_id?: string; // minute_book_entries.id (required)
  actor_id?: string; // optional; resolved from JWT if missing
  is_test?: boolean; // optional; infer lane from source_record_id -> governance_ledger.is_test
  force?: boolean; // optional (reissue/overwrite)
  verify_base_url?: string; // optional override (defaults to VERIFY_BASE_URL or verify.html)
};

type Resp = {
  ok: boolean;
  entry_id?: string;
  actor_id?: string;
  actor_email?: string | null;

  is_test?: boolean;
  verified_document_id?: string;
  reused?: boolean;

  // ✅ verify terminal URL (hash-first)
  verify_url?: string;

  source?: { bucket: string; path: string; file_hash?: string | null };
  certified?: { bucket: string; path: string; file_hash: string; file_size: number };

  error?: string;
  details?: unknown;
  request_id?: string | null;
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

const cors: Record<string, string> = {
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

/**
 * ✅ HASH-FIRST verify terminal URL.
 * Keep verify.html untouched. Resolver prioritizes hash.
 */
function buildVerifyUrl(base: string, sha256: string) {
  const u = new URL(base);
  u.searchParams.set("hash", sha256);
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

async function resolveActorEmail(actorId: string): Promise<string | null> {
  try {
    const { data, error } = await (supabaseAdmin as any).auth.admin.getUserById(actorId);
    if (error) return null;
    return (data?.user?.email as string) ?? null;
  } catch {
    return null;
  }
}

/**
 * ✅ Resolve a PDF pointer for a minute_book entry
 * - contract: supporting_documents contains entry_id + file_path/hash/etc
 * - choose registry_visible first, then latest version/uploaded_at
 *
 * NOTE: This does NOT assume storage bucket column exists. We treat file_path as a bucket path in minute_book.
 */
async function resolveEntryPrimaryPdf(entryId: string) {
  const { data, error } = await supabaseAdmin
    .from("supporting_documents")
    .select(
      "id,entry_id,file_path,file_name,file_hash,file_size,mime_type,registry_visible,version,uploaded_at",
    )
    .eq("entry_id", entryId)
    .order("registry_visible", { ascending: false })
    .order("version", { ascending: false })
    .order("uploaded_at", { ascending: false })
    .limit(25);

  if (error) throw error;

  const rows = (data ?? []) as any[];

  const pick =
    rows.find(
      (r) => r.registry_visible === true && safeText(r.file_path)?.toLowerCase().endsWith(".pdf"),
    ) ??
    rows.find((r) => safeText(r.file_path)?.toLowerCase().endsWith(".pdf")) ??
    rows[0];

  const file_path = safeText(pick?.file_path);
  if (!file_path || !file_path.toLowerCase().endsWith(".pdf")) return null;

  return {
    file_path,
    file_name: safeText(pick?.file_name),
    file_hash: safeText(pick?.file_hash),
    file_size: Number.isFinite(Number(pick?.file_size)) ? Number(pick?.file_size) : null,
    mime_type: safeText(pick?.mime_type) ?? "application/pdf",
  };
}

// -----------------------------------------------------------------------------
// ✅ QR generation (Edge-safe): URL → PNG bytes (NO wasm / NO canvas)
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

  // white background
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

/**
 * If caller doesn't pass is_test, infer from:
 * minute_book_entries.source_record_id -> governance_ledger.is_test
 * (prevents lane mistakes, no schema changes)
 */
async function inferLaneIsTestFromEntrySource(entrySourceRecordId: string | null): Promise<boolean | null> {
  const id = safeText(entrySourceRecordId);
  if (!id || !isUuid(id)) return null;

  const { data, error } = await supabaseAdmin
    .from("governance_ledger")
    .select("id,is_test")
    .eq("id", id)
    .limit(1);

  if (error) return null;
  const v = (data ?? [])[0] as any;
  if (!v) return null;
  return typeof v.is_test === "boolean" ? (v.is_test as boolean) : null;
}

/**
 * ✅ Map minute book entry signals into the EXISTING verified_documents.document_class enum.
 * Allowed: resolution | invoice | certificate | report | minutes | tax_filing | other
 *
 * NO schema changes. NO enum changes.
 */
function mapDocumentClass(entryType?: string | null, domainKey?: string | null) {
  const t = (entryType ?? "").toLowerCase().trim();
  const d = (domainKey ?? "").toLowerCase().trim();

  if (t === "resolution" || d.includes("resolution")) return "resolution";
  if (t === "minutes" || d.includes("minutes")) return "minutes";
  if (d.includes("tax")) return "tax_filing";
  if (d.includes("invoice")) return "invoice";
  if (d.includes("certificate")) return "certificate";

  // Corporate profiles / formation / filings default best to "report"
  return "report";
}

// -----------------------------------------------------------------------------
// ✅ ENTERPRISE: Append an OS-style certification page (matches Execution Certificate aesthetic)
// - Dark header band
// - Structured 2-column facts
// - Large whitespace
// - QR as bottom-right seal
// - Prints hash + shows hash-first terminal line
// -----------------------------------------------------------------------------
async function buildCertifiedWithAppendedPage(args: {
  sourceBytes: Uint8Array;
  verifyUrl: string;
  finalHashText: string;
  title: string;
  entityName: string; // display name (nice)
  entitySlug: string; // slug (canonical)
  laneLabel: string; // "SANDBOX" or "TRUTH"
  documentClassLabel: string; // "Report" / "Minutes" etc (human display)
}): Promise<Uint8Array> {
  const {
    sourceBytes,
    verifyUrl,
    finalHashText,
    title,
    entityName,
    entitySlug,
    laneLabel,
    documentClassLabel,
  } = args;

  const srcDoc = await PDFDocument.load(sourceBytes);
  const outDoc = await PDFDocument.create();

  // Copy all existing pages untouched
  const copiedPages = await outDoc.copyPages(srcDoc, srcDoc.getPageIndices());
  for (const p of copiedPages) outDoc.addPage(p);

  // Append our certification page as the guaranteed NEW LAST page
  const page = outDoc.addPage([612, 792]); // US Letter portrait

  const font = await outDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await outDoc.embedFont(StandardFonts.HelveticaBold);

  const W = page.getWidth();
  const H = page.getHeight();
  const M = 50;

  // Palette (matches your certificate vibe)
  const ink = rgb(0.10, 0.12, 0.16);
  const muted = rgb(0.45, 0.48, 0.55);
  const rule = rgb(0.86, 0.88, 0.91);
  const band = rgb(0.06, 0.08, 0.11);
  const accent = rgb(0.06, 0.70, 0.62); // teal/green headline like your example

  // Outer frame (subtle)
  page.drawRectangle({
    x: 36,
    y: 36,
    width: W - 72,
    height: H - 72,
    borderColor: rgb(0.88, 0.90, 0.93),
    borderWidth: 1,
    color: rgb(1, 1, 1),
  });

  // Top authority band
  page.drawRectangle({
    x: 36,
    y: H - 36 - 72,
    width: W - 72,
    height: 72,
    color: band,
  });

  page.drawText("Oasis Digital Parliament", {
    x: M,
    y: H - 36 - 32,
    size: 14,
    font: fontBold,
    color: accent,
  });

  page.drawText("Certification Record", {
    x: M,
    y: H - 36 - 54,
    size: 10,
    font,
    color: rgb(0.78, 0.82, 0.86),
  });

  const issuedBy = "Issued by the Oasis Verified Registry";
  const issuedW = font.widthOfTextAtSize(issuedBy, 9);
  page.drawText(issuedBy, {
    x: W - M - issuedW,
    y: H - 36 - 52,
    size: 9,
    font,
    color: rgb(0.78, 0.82, 0.86),
  });

  // Intro
  page.drawText("This certification confirms the archival integrity of the following document:", {
    x: M,
    y: H - 36 - 118,
    size: 9,
    font,
    color: muted,
  });

  // Title block
  const safeTitle = (title ?? "Minute Book Filing").slice(0, 140);
  page.drawText(safeTitle, {
    x: M,
    y: H - 36 - 150,
    size: 14,
    font: fontBold,
    color: ink,
  });

  page.drawText(entityName || entitySlug, {
    x: M,
    y: H - 36 - 170,
    size: 9,
    font,
    color: muted,
  });

  // Two-column facts (matches the certificate layout)
  const leftX = M;
  const rightX = 315;
  let y = H - 36 - 220;

  const row = (label: string, value: string, col: "L" | "R") => {
    const x = col === "L" ? leftX : rightX;
    page.drawText(label, { x, y, size: 9, font: fontBold, color: ink });
    page.drawText(value, { x: x + 105, y, size: 9, font, color: muted });
    y -= 16;
  };

  // Left column
  row("Entity:", entityName || entitySlug, "L");
  row("Entity Slug:", entitySlug, "L");
  row("Lane:", laneLabel, "L");
  row("Document:", documentClassLabel, "L");

  // Right column (hash + terminal)
  y = H - 36 - 220;
  row("Hash (SHA-256):", finalHashText.slice(0, 18) + "…", "R");
  row("Verification:", "Scan QR / open terminal", "R");

  // Divider rule
  page.drawLine({
    start: { x: M, y: H - 36 - 295 },
    end: { x: W - M, y: H - 36 - 295 },
    thickness: 0.6,
    color: rule,
  });

  // Verification section text
  page.drawText("Verification", {
    x: M,
    y: H - 36 - 330,
    size: 10,
    font: fontBold,
    color: ink,
  });

  page.drawText(
    "To verify cryptographic truth (hash, certification, registry status), scan the QR code or open the verification terminal.",
    {
      x: M,
      y: H - 36 - 350,
      size: 8.5,
      font,
      color: muted,
      maxWidth: W - M * 2 - 160,
      lineHeight: 11,
    },
  );

  page.drawText("Authority is conferred exclusively by the Oasis Verified Registry.", {
    x: M,
    y: H - 36 - 375,
    size: 8.5,
    font,
    color: muted,
  });

  // Hash box (clean, not “form input”)
  const boxY = 260;
  page.drawText("Certificate Hash (SHA-256)", {
    x: M,
    y: boxY + 66,
    size: 9,
    font: fontBold,
    color: ink,
  });

  page.drawRectangle({
    x: M,
    y: boxY + 38,
    width: W - M * 2 - 160,
    height: 24,
    borderColor: rule,
    borderWidth: 1,
    color: rgb(0.98, 0.98, 0.99),
  });

  page.drawText(finalHashText, {
    x: M + 10,
    y: boxY + 46,
    size: 8.5,
    font,
    color: rgb(0.22, 0.24, 0.30),
  });

  // Terminal line
  page.drawText("Verification Terminal (hash-first)", {
    x: M,
    y: boxY + 18,
    size: 9,
    font: fontBold,
    color: ink,
  });

  const terminalLine =
    verifyUrl.length > 92 ? `${verifyUrl.slice(0, 92)}…` : verifyUrl;

  page.drawText(terminalLine, {
    x: M,
    y: boxY + 4,
    size: 7.8,
    font,
    color: muted,
  });

  // QR seal bottom-right (like your example)
  const qrPng = qrPngBytes(verifyUrl, { size: 256, margin: 2, ecc: "M" });
  const qrImg = await outDoc.embedPng(qrPng);

  const qrSize = 120;
  const qrX = W - M - qrSize;
  const qrY = 80;

  page.drawRectangle({
    x: qrX - 10,
    y: qrY - 10,
    width: qrSize + 20,
    height: qrSize + 28,
    borderColor: rule,
    borderWidth: 1,
    color: rgb(0.99, 0.99, 1),
  });

  page.drawImage(qrImg, { x: qrX, y: qrY, width: qrSize, height: qrSize });

  const scan = "Scan to verify";
  const scanW = font.widthOfTextAtSize(scan, 8);
  page.drawText(scan, {
    x: qrX + (qrSize - scanW) / 2,
    y: qrY - 14,
    size: 8,
    font,
    color: muted,
  });

  // Footer
  page.drawLine({
    start: { x: M, y: 64 },
    end: { x: W - M, y: 64 },
    thickness: 0.6,
    color: rule,
  });

  page.drawText(
    "This certification page was appended to preserve original document pages. Verification resolves by hash (QR).",
    {
      x: M,
      y: 44,
      size: 8,
      font,
      color: muted,
    },
  );

  return new Uint8Array(await outDoc.save());
}

serve(async (req) => {
  const reqId = req.headers.get("x-sb-request-id") ?? null;

  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return json({ ok: false, error: "POST only", request_id: reqId }, 405);

    const body = (await req.json().catch(() => ({}))) as ReqBody;

    const entryId = safeText(body.entry_id);
    if (!entryId || !isUuid(entryId)) {
      return json({ ok: false, error: "entry_id must be uuid", request_id: reqId }, 400);
    }

    let actorId = safeText(body.actor_id);
    if (actorId && !isUuid(actorId)) {
      return json({ ok: false, error: "actor_id must be uuid", request_id: reqId }, 400);
    }
    if (!actorId) actorId = await resolveActorIdFromJwt(req);
    if (!actorId) return json({ ok: false, error: "ACTOR_REQUIRED", request_id: reqId }, 401);

    const force = !!body.force;

    // 1) Load minute_book entry (include source_record_id for lane inference)
    const entry = await supabaseAdmin
      .from("minute_book_entries")
      .select("id,entity_key,domain_key,entry_type,title,notes,created_at,created_by,source_record_id")
      .eq("id", entryId)
      .maybeSingle();

    if (entry.error) return json({ ok: false, error: entry.error.message, request_id: reqId }, 400);
    if (!entry.data?.id) return json({ ok: false, error: "ENTRY_NOT_FOUND", request_id: reqId }, 404);

    const entity_key = String((entry.data as any).entity_key ?? "");
    const domain_key = safeText((entry.data as any).domain_key);
    const entry_type = safeText((entry.data as any).entry_type) ?? "filing";
    const title = safeText((entry.data as any).title) ?? "Minute Book Filing";
    const source_record_id = safeText((entry.data as any).source_record_id);

    // 1b) Lane resolution (caller override wins; otherwise infer; otherwise default false)
    let is_test: boolean;
    if (typeof body.is_test === "boolean") {
      is_test = body.is_test;
    } else {
      const inferred = await inferLaneIsTestFromEntrySource(source_record_id);
      is_test = typeof inferred === "boolean" ? inferred : false;
    }

    // 2) Map entity_key -> entities (no hardcoding)
    const ent = await supabaseAdmin
      .from("entities")
      .select("id, slug, name")
      .eq("slug", entity_key)
      .maybeSingle();

    if (ent.error) return json({ ok: false, error: ent.error.message, request_id: reqId }, 400);
    if (!ent.data?.id) {
      return json(
        {
          ok: false,
          error: "ENTITY_NOT_FOUND",
          details: `No entities row found for slug=${entity_key}`,
          request_id: reqId,
        },
        404,
      );
    }

    const entity_id = String((ent.data as any).id);
    const entity_slug = String((ent.data as any).slug);
    const entity_name = safeText((ent.data as any).name) ?? entity_slug;

    // 3) Resolve source PDF from minute_book (primary supporting doc)
    const source_bucket = "minute_book";
    const src = await resolveEntryPrimaryPdf(entryId);

    if (!src?.file_path) {
      return json(
        {
          ok: false,
          error: "SOURCE_PDF_NOT_FOUND",
          details: "No primary supporting_documents PDF pointer found for this entry_id (file_path missing).",
          request_id: reqId,
        } satisfies Resp,
        404,
      );
    }

    const source_path = src.file_path;

    // 4) Certified destination pointer (separate buckets; no schema changes)
    const certified_bucket = is_test ? "governance_sandbox" : "governance_truth";
    const certified_path = is_test ? `sandbox/uploads/${entryId}.pdf` : `truth/uploads/${entryId}.pdf`;

    // 5) Find existing verified_documents row
    const existingVd = await supabaseAdmin
      .from("verified_documents")
      .select("id, storage_bucket, storage_path, file_hash, verification_level, created_at")
      .eq("source_table", "minute_book_entries")
      .eq("source_record_id", entryId)
      .maybeSingle();

    const existingId = existingVd.data?.id ? String(existingVd.data.id) : null;
    const existingHash = safeText((existingVd.data as any)?.file_hash);
    const existingLevel = safeText((existingVd.data as any)?.verification_level);
    const existingBucket = safeText((existingVd.data as any)?.storage_bucket);
    const existingPath = safeText((existingVd.data as any)?.storage_path);

    // 5b) Strict reuse
    if (!force && existingId && existingHash && (existingLevel ?? "").toLowerCase() === "certified") {
      if (existingBucket === certified_bucket && existingPath === certified_path) {
        const verifyBase =
          safeText(body.verify_base_url) ??
          Deno.env.get("VERIFY_BASE_URL") ??
          "https://sign.oasisintlholdings.com/verify.html";

        return json<Resp>({
          ok: true,
          reused: true,
          entry_id: entryId,
          actor_id: actorId,
          actor_email: await resolveActorEmail(actorId),
          is_test,
          verified_document_id: existingId,
          verify_url: buildVerifyUrl(verifyBase, existingHash),
          source: { bucket: source_bucket, path: source_path, file_hash: src.file_hash },
          certified: { bucket: certified_bucket, path: certified_path, file_hash: existingHash, file_size: 0 },
          request_id: reqId,
        });
      }
    }

    // 6) Ensure verified_documents row exists (UPDATE if exists, else INSERT)
    const document_class = mapDocumentClass(entry_type, domain_key);

    let verified_id: string;

    if (existingId) {
      verified_id = existingId;

      const preUpd = await supabaseAdmin
        .from("verified_documents")
        .update({
          entity_id,
          entity_slug,
          document_class,
          title,
          storage_bucket: certified_bucket,
          storage_path: certified_path,
          mime_type: "application/pdf",
          verification_level: "certified",
          is_archived: true,
          updated_at: new Date().toISOString(),
          updated_by: actorId,
        } as any)
        .eq("id", verified_id);

      if (preUpd.error) {
        return json(
          { ok: false, error: "VERIFIED_DOC_PREUPDATE_FAILED", details: preUpd.error, request_id: reqId } satisfies Resp,
          500,
        );
      }
    } else {
      const ins = await supabaseAdmin
        .from("verified_documents")
        .insert({
          entity_id,
          entity_slug,
          document_class,
          title,
          source_table: "minute_book_entries",
          source_record_id: entryId,
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

      if (ins.error) {
        return json(
          { ok: false, error: "VERIFIED_DOC_INSERT_FAILED", details: ins.error, request_id: reqId } satisfies Resp,
          500,
        );
      }

      verified_id = String(ins.data.id);
    }

    // 7) Download source PDF bytes
    const dl = await supabaseAdmin.storage.from(source_bucket).download(source_path);
    if (dl.error || !dl.data) {
      return json({ ok: false, error: "SOURCE_PDF_DOWNLOAD_FAILED", details: dl.error, request_id: reqId }, 500);
    }
    const sourceBytes = new Uint8Array(await dl.data.arrayBuffer());

    // 8) Build certification page as the NEW FINAL PAGE (2-pass stabilization)
    const verifyBase =
      safeText(body.verify_base_url) ??
      Deno.env.get("VERIFY_BASE_URL") ??
      "https://sign.oasisintlholdings.com/verify.html";

    const laneLabel = is_test ? "SANDBOX" : "TRUTH";

    const docLabel =
      document_class === "minutes" ? "Minutes" :
      document_class === "resolution" ? "Resolution" :
      document_class === "tax_filing" ? "Tax Filing" :
      document_class === "invoice" ? "Invoice" :
      document_class === "certificate" ? "Certificate" :
      document_class === "report" ? "Report" : "Document";

    // Pass A: placeholder
    const passA_bytes = await buildCertifiedWithAppendedPage({
      sourceBytes,
      verifyUrl: buildVerifyUrl(verifyBase, "pending"),
      finalHashText: "pending",
      title,
      entityName: entity_name,
      entitySlug: entity_slug,
      laneLabel,
      documentClassLabel: docLabel,
    });
    const passA_hash = await sha256Hex(passA_bytes);

    // Pass B: embed passA hash
    const passB_bytes = await buildCertifiedWithAppendedPage({
      sourceBytes,
      verifyUrl: buildVerifyUrl(verifyBase, passA_hash),
      finalHashText: passA_hash,
      title,
      entityName: entity_name,
      entitySlug: entity_slug,
      laneLabel,
      documentClassLabel: docLabel,
    });
    const passB_hash = await sha256Hex(passB_bytes);

    let finalBytes = passB_bytes;
    let finalHash = passB_hash;

    // Stabilization pass (so QR + printed hash match final bytes)
    if (passB_hash !== passA_hash) {
      const passC_bytes = await buildCertifiedWithAppendedPage({
        sourceBytes,
        verifyUrl: buildVerifyUrl(verifyBase, passB_hash),
        finalHashText: passB_hash,
        title,
        entityName: entity_name,
        entitySlug: entity_slug,
        laneLabel,
        documentClassLabel: docLabel,
      });
      const passC_hash = await sha256Hex(passC_bytes);
      finalBytes = passC_bytes;
      finalHash = passC_hash;
    }

    const finalVerifyUrl = buildVerifyUrl(verifyBase, finalHash);

    // 9) Upload certified PDF
    const up = await supabaseAdmin.storage
      .from(certified_bucket)
      .upload(certified_path, new Blob([finalBytes], { type: "application/pdf" }), {
        upsert: true,
        contentType: "application/pdf",
      });

    if (up.error) {
      return json({ ok: false, error: "CERTIFIED_PDF_UPLOAD_FAILED", details: up.error, request_id: reqId }, 500);
    }

    // 10) Finalize verified_documents hash + canonical pointer
    const upd = await supabaseAdmin
      .from("verified_documents")
      .update({
        entity_id,
        entity_slug,
        document_class,
        title,
        storage_bucket: certified_bucket,
        storage_path: certified_path,
        file_hash: finalHash,
        mime_type: "application/pdf",
        verification_level: "certified",
        is_archived: true,
        updated_at: new Date().toISOString(),
        updated_by: actorId,
      } as any)
      .eq("id", verified_id);

    if (upd.error) {
      return json({ ok: false, error: "VERIFIED_DOC_UPDATE_FAILED", details: upd.error, request_id: reqId }, 500);
    }

    return json<Resp>({
      ok: true,
      entry_id: entryId,
      actor_id: actorId,
      actor_email: await resolveActorEmail(actorId),
      is_test,
      verified_document_id: verified_id,
      verify_url: finalVerifyUrl,
      source: { bucket: source_bucket, path: source_path, file_hash: src.file_hash },
      certified: {
        bucket: certified_bucket,
        path: certified_path,
        file_hash: finalHash,
        file_size: finalBytes.length,
      },
      request_id: reqId,
    });
  } catch (e: any) {
    console.error("certify-minute-book-entry fatal:", e);
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
