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
  force?: boolean; // optional (reissue)
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

  // ✅ Now points to entry_id (stable), not self-hash
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
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
};

const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    s,
  );

function safeText(v: unknown): string | null {
  if (v == null) return null;
  const t = String(v).trim();
  return t.length ? t : null;
}

function utcStampISO(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const arr = new Uint8Array(digest);
  let hex = "";
  for (const b of arr) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * ✅ Stable verify URL: resolve by entry_id (NOT by hash inside same file)
 */
function buildVerifyUrlByEntry(base: string, entryId: string) {
  const u = new URL(base);
  u.searchParams.set("entry_id", entryId);
  return u.toString();
}

async function resolveActorIdFromJwt(req: Request): Promise<string | null> {
  const authHeader =
    req.headers.get("authorization") ?? req.headers.get("Authorization");
  const jwt = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) return null;

  const { data, error } = await supabaseAdmin.auth.getUser(jwt);
  if (error) return null;

  const id = data?.user?.id ?? null;
  return id && isUuid(id) ? id : null;
}

async function resolveActorEmail(actorId: string): Promise<string | null> {
  try {
    const { data, error } = await (supabaseAdmin as any).auth.admin.getUserById(
      actorId,
    );
    if (error) return null;
    return (data?.user?.email as string) ?? null;
  } catch {
    return null;
  }
}

/**
 * ✅ Best-effort audit log (never blocks)
 */
async function bestEffortActionsLog(args: {
  actor_uid: string;
  action: string;
  target_table: string;
  target_id: string;
  details_json?: Record<string, unknown>;
}) {
  try {
    await supabaseAdmin.from("actions_log").insert({
      actor_uid: args.actor_uid,
      action: args.action as any,
      target_table: args.target_table,
      target_id: args.target_id,
      details_json: args.details_json ?? {},
    } as any);
  } catch {
    // non-fatal
  }
}

/**
 * ✅ Resolve primary PDF pointer for entry from supporting_documents
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
      (r) =>
        r.registry_visible === true &&
        safeText(r.file_path)?.toLowerCase().endsWith(".pdf"),
    ) ??
    rows.find((r) => safeText(r.file_path)?.toLowerCase().endsWith(".pdf")) ??
    rows[0];

  const file_path = safeText(pick?.file_path);
  if (!file_path || !file_path.toLowerCase().endsWith(".pdf")) return null;

  return {
    file_path,
    file_name: safeText(pick?.file_name),
    file_hash: safeText(pick?.file_hash),
    file_size: Number.isFinite(Number(pick?.file_size))
      ? Number(pick?.file_size)
      : null,
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
 * Infer is_test from minute_book_entries.source_record_id -> governance_ledger.is_test
 */
async function inferLaneIsTestFromEntrySource(
  entrySourceRecordId: string | null,
): Promise<boolean | null> {
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
 * Map minute book entry -> verified_documents.document_class enum (NO changes)
 */
function mapDocumentClass(entryType?: string | null, domainKey?: string | null) {
  const t = (entryType ?? "").toLowerCase().trim();
  const d = (domainKey ?? "").toLowerCase().trim();

  if (t === "resolution" || d.includes("resolution")) return "resolution";
  if (t === "minutes" || d.includes("minutes")) return "minutes";
  if (d.includes("tax")) return "tax_filing";
  if (d.includes("invoice")) return "invoice";
  if (d.includes("certificate")) return "certificate";
  return "report";
}

// -----------------------------------------------------------------------------
// ✅ APPEND NEW FINAL CERTIFICATION PAGE (NO self-hash)
// -----------------------------------------------------------------------------
async function buildCertifiedWithAppendedPage(args: {
  sourceBytes: Uint8Array;
  verifyUrl: string; // ✅ now stable (entry_id)
  title: string;
  entitySlug: string;
  laneLabel: string;
  documentClass: string;
  operatorLabel: string;
  certifiedAtUtc: string;
  entryId: string; // ✅ stable identifier printed
}): Promise<Uint8Array> {
  const {
    sourceBytes,
    verifyUrl,
    title,
    entitySlug,
    laneLabel,
    documentClass,
    operatorLabel,
    certifiedAtUtc,
    entryId,
  } = args;

  const srcDoc = await PDFDocument.load(sourceBytes);
  const outDoc = await PDFDocument.create();

  const copiedPages = await outDoc.copyPages(srcDoc, srcDoc.getPageIndices());
  for (const p of copiedPages) outDoc.addPage(p);

  const page = outDoc.addPage([612, 792]); // Letter
  const font = await outDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await outDoc.embedFont(StandardFonts.HelveticaBold);

  const ink = rgb(0.12, 0.14, 0.18);
  const muted = rgb(0.45, 0.48, 0.55);
  const hair = rgb(0.86, 0.88, 0.91);
  const band = rgb(0.06, 0.09, 0.12);
  const teal = rgb(0.10, 0.78, 0.72);
  const paper = rgb(1, 1, 1);

  const margin = 56;
  const W = page.getWidth();
  const H = page.getHeight();

  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: paper });

  const bandH = 92;
  page.drawRectangle({ x: 0, y: H - bandH, width: W, height: bandH, color: band });

  page.drawText("Oasis Digital Parliament", {
    x: margin,
    y: H - 42,
    size: 14,
    font: fontBold,
    color: teal,
  });

  page.drawText("Certification Record", {
    x: margin,
    y: H - 64,
    size: 10,
    font,
    color: rgb(0.86, 0.88, 0.90),
  });

  const issuerText = "Issued by the Oasis Verified Registry";
  const issuerW = font.widthOfTextAtSize(issuerText, 9);
  page.drawText(issuerText, {
    x: W - margin - issuerW,
    y: H - 60,
    size: 9,
    font,
    color: rgb(0.78, 0.82, 0.86),
  });

  const introY = H - bandH - 48;
  page.drawText(
    "This certification confirms the archival integrity of the following document:",
    { x: margin, y: introY, size: 9.5, font, color: muted },
  );

  const safeTitle = (title ?? "Minute Book Entry").slice(0, 120);
  page.drawText(safeTitle, {
    x: margin,
    y: introY - 34,
    size: 14,
    font: fontBold,
    color: ink,
  });

  page.drawText(`${entitySlug}`, {
    x: margin,
    y: introY - 54,
    size: 10,
    font,
    color: muted,
  });

  const gridTop = introY - 96;
  const leftX = margin;
  const midX = margin + 250;

  const row = (label: string, value: string, x: number, y: number) => {
    page.drawText(label, { x, y, size: 9, font: fontBold, color: ink });
    page.drawText(value, { x: x + 110, y, size: 9, font, color: muted });
  };

  row("Entity Slug:", entitySlug, leftX, gridTop);
  row("Lane:", laneLabel, leftX, gridTop - 16);
  row("Document:", documentClass, leftX, gridTop - 32);

  // ✅ Stable identifier printed (not self-hash)
  const entryShort = entryId.length > 18 ? `${entryId.slice(0, 8)}…${entryId.slice(-8)}` : entryId;
  row("Entry ID:", entryShort, midX, gridTop);
  row("Verification:", "Scan QR / open terminal", midX, gridTop - 16);

  page.drawLine({
    start: { x: margin, y: gridTop - 58 },
    end: { x: W - margin, y: gridTop - 58 },
    thickness: 0.7,
    color: hair,
  });

  const vTop = gridTop - 98;
  page.drawText("Verification", {
    x: margin,
    y: vTop,
    size: 11,
    font: fontBold,
    color: ink,
  });

  page.drawText(
    "To verify cryptographic truth (registry status, certified hash, signed URLs), scan the QR code or open the verification terminal.",
    {
      x: margin,
      y: vTop - 18,
      size: 8.5,
      font,
      color: muted,
      maxWidth: W - margin * 2,
      lineHeight: 11,
    },
  );

  page.drawText("Authority is conferred exclusively by the Oasis Verified Registry.", {
    x: margin,
    y: vTop - 34,
    size: 8.5,
    font,
    color: muted,
  });

  const boxY = vTop - 90;
  page.drawText("Registry Reference (Entry ID)", {
    x: margin,
    y: boxY + 44,
    size: 9,
    font: fontBold,
    color: ink,
  });

  page.drawRectangle({
    x: margin,
    y: boxY,
    width: W - margin * 2,
    height: 34,
    borderColor: hair,
    borderWidth: 1,
    color: rgb(0.97, 0.97, 0.98),
  });

  page.drawText(entryId, {
    x: margin + 12,
    y: boxY + 12,
    size: 8.2,
    font,
    color: ink,
  });

  const urlY = boxY - 54;
  page.drawText("Verification Terminal", {
    x: margin,
    y: urlY + 20,
    size: 9,
    font: fontBold,
    color: ink,
  });

  const urlLine = verifyUrl.length > 108 ? `${verifyUrl.slice(0, 108)}…` : verifyUrl;
  page.drawText(urlLine, { x: margin, y: urlY, size: 8, font, color: muted });

  const qrPng = qrPngBytes(verifyUrl, { size: 256, margin: 2, ecc: "M" });
  const qrImg = await outDoc.embedPng(qrPng);

  const qrSize = 112;
  const qrX = W - margin - qrSize;
  const qrY = 92;

  page.drawRectangle({
    x: qrX - 12,
    y: qrY - 18,
    width: qrSize + 24,
    height: qrSize + 36,
    borderColor: hair,
    borderWidth: 1,
    color: rgb(0.99, 0.99, 1),
  });

  page.drawImage(qrImg, { x: qrX, y: qrY, width: qrSize, height: qrSize });

  const scanText = "Scan to verify";
  const scanW = font.widthOfTextAtSize(scanText, 8);
  page.drawText(scanText, {
    x: qrX + (qrSize - scanW) / 2,
    y: qrY - 10,
    size: 8,
    font,
    color: muted,
  });

  const attX = margin;
  const attY = 92;
  const attW = 300;
  const attH = 72;

  page.drawRectangle({
    x: attX,
    y: attY,
    width: attW,
    height: attH,
    borderColor: hair,
    borderWidth: 1,
    color: rgb(0.99, 0.99, 1),
  });

  page.drawText("Registry Attestation", {
    x: attX + 12,
    y: attY + attH - 20,
    size: 8.5,
    font: fontBold,
    color: muted,
  });

  const opLine = `Operator: ${operatorLabel}`.slice(0, 64);
  const tsLine = `Certified At (UTC): ${certifiedAtUtc}`.slice(0, 64);

  page.drawText(opLine, {
    x: attX + 12,
    y: attY + 34,
    size: 8.2,
    font,
    color: ink,
  });

  page.drawText(tsLine, {
    x: attX + 12,
    y: attY + 20,
    size: 8.2,
    font,
    color: ink,
  });

  const foot =
    "This certification page was appended to preserve original pages. The certified hash is resolved by the registry.";
  page.drawText(foot, {
    x: margin,
    y: 44,
    size: 7.5,
    font,
    color: rgb(0.60, 0.64, 0.70),
    maxWidth: W - margin * 2,
  });

  return new Uint8Array(await outDoc.save());
}

/**
 * ✅ Fetch existing verified pointer for this entry (prefer v_verified_latest)
 */
async function fetchLatestVerifiedPointer(entryId: string) {
  try {
    const { data, error } = await supabaseAdmin
      .from("v_verified_latest")
      .select("id, storage_bucket, storage_path, file_hash, verification_level, created_at")
      .eq("source_record_id", entryId)
      .maybeSingle();

    if (!error && data) return { data, via: "view" as const };
  } catch {
    // ignore
  }

  const { data, error } = await supabaseAdmin
    .from("verified_documents")
    .select("id, storage_bucket, storage_path, file_hash, verification_level, created_at")
    .eq("source_table", "minute_book_entries")
    .eq("source_record_id", entryId)
    .order("created_at", { ascending: false })
    .limit(25);

  if (error) return { data: null, via: "none" as const, error };

  const rows = (data ?? []) as any[];
  const pick =
    rows.find((r) => String(r?.verification_level ?? "").toLowerCase() === "certified") ??
    rows[0] ??
    null;

  return { data: pick, via: "fallback" as const };
}

serve(async (req) => {
  const reqId = req.headers.get("x-sb-request-id") ?? null;

  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") {
      return json({ ok: false, error: "POST only", request_id: reqId }, 405);
    }

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

    const actorEmail = await resolveActorEmail(actorId);
    const force = !!body.force;

    // 1) Load entry
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

    // lane
    let is_test: boolean;
    if (typeof body.is_test === "boolean") {
      is_test = body.is_test;
    } else {
      const inferred = await inferLaneIsTestFromEntrySource(source_record_id);
      is_test = typeof inferred === "boolean" ? inferred : false;
    }

    // 2) entities lookup
    const ent = await supabaseAdmin
      .from("entities")
      .select("id, slug")
      .eq("slug", entity_key)
      .maybeSingle();

    if (ent.error) return json({ ok: false, error: ent.error.message, request_id: reqId }, 400);
    if (!ent.data?.id) {
      return json(
        { ok: false, error: "ENTITY_NOT_FOUND", details: `No entities row found for slug=${entity_key}`, request_id: reqId },
        404,
      );
    }

    const entity_id = String((ent.data as any).id);
    const entity_slug = String((ent.data as any).slug);

    // 3) source pdf pointer
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
    const source_pathc = src.file_path;

    // 4) destination
    const certified_bucket = is_test ? "governance_sandbox" : "governance_truth";
    const certified_prefix = is_test ? "sandbox/uploads" : "truth/uploads";

    // 5) existing verified pointer
    const latest = await fetchLatestVerifiedPointer(entryId);
    const existingVd = latest.data as any | null;

    const existingId = existingVd?.id ? String(existingVd.id) : null;
    const existingHash = safeText(existingVd?.file_hash);
    const existingLevel = safeText(existingVd?.verification_level)?.toLowerCase() ?? null;
    const existingBucket = safeText(existingVd?.storage_bucket);
    const existingPath = safeText(existingVd?.storage_path);

    const hasCertified = !!(existingId && existingHash && existingLevel === "certified");
    const reissue = !!force && !!existingId;

    // ✅ strict reuse: return existing registry hash + stable entry resolver url
    if (!force && hasCertified) {
      const verifyBase =
        safeText(body.verify_base_url) ??
        Deno.env.get("VERIFY_BASE_URL") ??
        "https://sign.oasisintlholdings.com/verify.html";

      return json<Resp>({
        ok: true,
        reused: true,
        entry_id: entryId,
        actor_id: actorId,
        actor_email: actorEmail,
        is_test,
        verified_document_id: existingId!,
        verify_url: buildVerifyUrlByEntry(verifyBase, entryId),
        source: { bucket: source_bucket, path: sourceC, file_hash: src.file_hash },
        certified: {
          bucket: existingBucket ?? certified_bucket,
          path: existingPath ?? "",
          file_hash: existingHash!,
          file_size: 0,
        },
        request_id: reqId,
      });
    }

    // 6) doc class
    const document_class = mapDocumentClass(entry_type, domain_key);

    // 7) download source bytes
    const dl = await supabaseAdmin.storage.from(source_bucket).download(sourceC);
    if (dl.error || !dl.data) {
      return json(
        { ok: false, error: "SOURCE_PDF_DOWNLOAD_FAILED", details: dl.error, request_id: reqId },
        500,
      );
    }
    const sourceBytes = new Uint8Array(await dl.data.arrayBuffer());

    // 8) build certified pdf (QR resolves by entry_id)
    const verifyBase =
      safeText(body.verify_base_url) ??
      Deno.env.get("VERIFY_BASE_URL") ??
      "https://sign.oasisintlholdings.com/verify.html";

    const finalVerifyUrl = buildVerifyUrlByEntry(verifyBase, entryId);
    const laneLabel = is_test ? "SANDBOX" : "TRUTH";
    const certifiedAt = utcStampISO();
    const operatorLabel = safeText(actorEmail) ?? actorId;

    const finalBytes = await buildCertifiedWithAppendedPage({
      sourceBytes,
      verifyUrl: finalVerifyUrl,
      title,
      entitySlug: entity_slug,
      laneLabel,
      documentClass: document_class,
      operatorLabel,
      certifiedAtUtc: certifiedAt,
      entryId,
    });

    const finalHash = await sha256Hex(finalBytes);

    // 9) path by hash (still good)
    const certified_path = `${certified_prefix}/${entryId}-${finalHash.slice(0, 12)}.pdf`;

    const up = await supabaseAdmin.storage
      .from(certified_bucket)
      .upload(certified_path, new Blob([finalBytes], { type: "application/pdf" }), {
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
        return json(
          { ok: false, error: "CERTIFIED_PDF_UPLOAD_FAILED", details: up.error, request_id: reqId },
          500,
        );
      }
    }

    // 10) verified_documents write (INSERT if none, else UPDATE existing id)
    let verified_id: string;

    if (!existingId) {
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
          file_hash: finalHash,
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
    } else {
      verified_id = existingId;

      // ✅ certified rows: pointer refresh only (your SQL trigger allows service_role)
      const upd = await supabaseAdmin
        .from("verified_documents")
        .update({
          storage_bucket: certified_bucket,
          storage_path: certified_path,
          file_hash: finalHash,
        } as any)
        .eq("id", verified_id);

      if (upd.error) {
        return json(
          { ok: false, error: "VERIFIED_DOC_UPDATE_FAILED", details: upd.error, request_id: reqId } satisfies Resp,
          500,
        );
      }
    }

    await bestEffortActionsLog({
      actor_uid: actorId,
      action: "CERTIFY_MINUTE_BOOK_ENTRY",
      target_table: "minute_book_entries",
      target_id: entryId,
      details_json: {
        verified_document_id: verified_id,
        file_hash: finalHash,
        is_test,
        certified_bucket,
        certified_path,
        source_bucket,
        source_path: sourceC,
        reused: false,
        reissue,
      },
    });

    return json<Resp>({
      ok: true,
      entry_id: entryId,
      actor_id: actorId,
      actor_email: actorEmail,
      is_test,
      verified_document_id: verified_id,
      verify_url: finalVerifyUrl, // ✅ stable
      source: { bucket: source_bucket, path: sourceC, file_hash: src.file_hash },
      certified: {
        bucket: certified_bucket,
        path: certified_path,
        file_hash: finalHash, // ✅ canonical registry hash
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
