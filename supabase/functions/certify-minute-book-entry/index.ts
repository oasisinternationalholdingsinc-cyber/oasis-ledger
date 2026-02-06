// supabase/functions/certify-minute-book-entry/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument, rgb, StandardFonts } from "https://esm.sh/pdf-lib@1.17.1";

// ✅ Edge-safe QR (NO canvas / NO wasm)
import QRGen from "npm:qrcode-generator@1.4.4";
import { PNG } from "npm:pngjs@7.0.0";

type ReqBody = {
  entry_id?: string;        // minute_book_entries.id (required)
  actor_id?: string;        // optional; resolved from JWT if missing
  is_test?: boolean;        // optional; if missing, we infer lane from source_record_id -> governance_ledger.is_test
  force?: boolean;          // optional
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

  // ✅ important: verify terminal URL (hash-first)
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
 * ✅ Resolve primary PDF pointer for a minute_book entry
 * - contract: supporting_documents contains entry_id + file_path/hash/etc
 * - choose registry_visible first, then latest version/uploaded_at
 */
async function resolveEntryPrimaryPdf(entryId: string) {
  const { data, error } = await supabaseAdmin
    .from("supporting_documents")
    .select("id,entry_id,file_path,file_name,file_hash,file_size,mime_type,registry_visible,version,uploaded_at")
    .eq("entry_id", entryId)
    .order("registry_visible", { ascending: false })
    .order("version", { ascending: false })
    .order("uploaded_at", { ascending: false })
    .limit(25);

  if (error) throw error;

  const rows = (data ?? []) as any[];

  const pick =
    rows.find((r) => r.registry_visible === true && safeText(r.file_path)?.toLowerCase().endsWith(".pdf")) ??
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

function fmtIsoDate(iso?: string | null) {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const d = new Date(t);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
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
    const created_at = safeText((entry.data as any).created_at);
    const source_record_id = safeText((entry.data as any).source_record_id);

    // 1b) Lane resolution (caller override wins; otherwise infer; otherwise default false)
    let is_test: boolean;
    if (typeof body.is_test === "boolean") {
      is_test = body.is_test;
    } else {
      const inferred = await inferLaneIsTestFromEntrySource(source_record_id);
      is_test = typeof inferred === "boolean" ? inferred : false;
    }

    // 2) Map entity_key -> entities.id via entities.slug (no hardcoding)
    const ent = await supabaseAdmin
      .from("entities")
      .select("id, slug, name")
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
    const source_hash = src.file_hash;

    // 4) Certified destination pointer (separate bucket; no schema changes)
    const certified_bucket = is_test ? "governance_sandbox" : "governance_truth";
    const certified_path = is_test ? `sandbox/uploads/${entryId}.pdf` : `truth/uploads/${entryId}.pdf`;

    // 5) Idempotency: reuse existing verified_documents if already certified (unless force)
    const existingVd = await supabaseAdmin
      .from("verified_documents")
      .select("id, storage_bucket, storage_path, file_hash, verification_level, created_at")
      .eq("source_table", "minute_book_entries")
      .eq("source_record_id", entryId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const existingId = existingVd.data?.id ? String(existingVd.data.id) : null;
    const existingHash = safeText((existingVd.data as any)?.file_hash);
    const existingLevel = safeText((existingVd.data as any)?.verification_level);
    const existingBucket = safeText((existingVd.data as any)?.storage_bucket);
    const existingPath = safeText((existingVd.data as any)?.storage_path);

    // If we already have a certified doc at the same pointer and a hash, we can return and build verify_url hash-first.
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
          source: { bucket: source_bucket, path: source_path, file_hash: source_hash },
          certified: { bucket: certified_bucket, path: certified_path, file_hash: existingHash, file_size: 0 },
          request_id: reqId,
        });
      }
    }

    // 6) Ensure verified_documents row exists (need id for registry linkage; QR will be hash-based)
    let verified_id = existingId;

    if (!verified_id) {
      const ins = await supabaseAdmin
        .from("verified_documents")
        .insert({
          entity_id,
          entity_slug,
          document_class: "minute_book",
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

    // 8) Build certified PDF = COVER PAGE + original PDF (unchanged pages)
    //    IMPORTANT: QR must point to verify.html?hash=<sha256>. That sha256 is for the final certified PDF,
    //    so we build, hash, then build again with QR (2-pass) to avoid verify.html changes.
    const srcPdf = await PDFDocument.load(sourceBytes);
    const srcPages = srcPdf.getPages();

    const w = srcPages[0]?.getWidth?.() ?? 612;
    const h = srcPages[0]?.getHeight?.() ?? 792;

    async function buildCertifiedPdfBytes(verifyUrl: string) {
      const out = await PDFDocument.create();
      const cover = out.addPage([w, h]);

      const font = await out.embedFont(StandardFonts.Helvetica);
      const fontBold = await out.embedFont(StandardFonts.HelveticaBold);

      const pad = 42;
      cover.drawRectangle({
        x: pad,
        y: pad,
        width: w - pad * 2,
        height: h - pad * 2,
        borderColor: rgb(0.78, 0.65, 0.38),
        borderWidth: 1.2,
        color: rgb(0.04, 0.05, 0.07),
        opacity: 0.98,
      });

      cover.drawText("OASIS DIGITAL PARLIAMENT", {
        x: pad + 18,
        y: h - pad - 38,
        size: 12,
        font: fontBold,
        color: rgb(0.92, 0.86, 0.72),
      });

      cover.drawText("Certified Filing • Minute Book", {
        x: pad + 18,
        y: h - pad - 60,
        size: 10,
        font,
        color: rgb(0.72, 0.75, 0.80),
      });

      const leftX = pad + 18;
      let y = h - pad - 110;

      const line = (label: string, value: string) => {
        cover.drawText(label.toUpperCase(), {
          x: leftX,
          y,
          size: 8,
          font: fontBold,
          color: rgb(0.55, 0.58, 0.64),
        });
        cover.drawText(value, {
          x: leftX,
          y: y - 16,
          size: 11,
          font,
          color: rgb(0.93, 0.93, 0.94),
        });
        y -= 44;
      };

      line("Entity", entity_name);
      line("Title", title);
      line("Domain", domain_key ?? "—");
      line("Entry Type", entry_type);
      line("Filed Date", fmtIsoDate(created_at));
      line("Entry ID", entryId);

      const actorEmail = await resolveActorEmail(actorId);
      const operatorLine = actorEmail ? `${actorEmail} • ${actorId}` : actorId;

      cover.drawText("REGISTERED BY (OPERATOR)", {
        x: leftX,
        y: y - 4,
        size: 8,
        font: fontBold,
        color: rgb(0.55, 0.58, 0.64),
      });
      cover.drawText(operatorLine, {
        x: leftX,
        y: y - 22,
        size: 10,
        font,
        color: rgb(0.93, 0.93, 0.94),
      });
      y -= 58;

      cover.drawText("SOURCE EVIDENCE HASH (SHA-256)", {
        x: leftX,
        y: y - 4,
        size: 8,
        font: fontBold,
        color: rgb(0.55, 0.58, 0.64),
      });
      cover.drawText(source_hash ?? "—", {
        x: leftX,
        y: y - 22,
        size: 9,
        font,
        color: rgb(0.86, 0.87, 0.88),
        maxWidth: w - leftX - 170,
      });

      // QR bottom-right (hash-first verify URL)
      const qrPng = qrPngBytes(verifyUrl, { size: 256, margin: 2, ecc: "M" });
      const qrImg = await out.embedPng(qrPng);

      const qrSize = 110;
      const qrX = w - pad - qrSize - 18;
      const qrY = pad + 24;

      cover.drawImage(qrImg, { x: qrX, y: qrY, width: qrSize, height: qrSize });
      cover.drawText("Verify", {
        x: qrX + 30,
        y: qrY - 12,
        size: 8,
        font,
        color: rgb(0.55, 0.58, 0.64),
      });

      const copied = await out.copyPages(srcPdf, srcPdf.getPageIndices());
      for (const p of copied) out.addPage(p);

      return new Uint8Array(await out.save());
    }

    // Build pass 1 with temporary URL (we’ll replace once we know final hash)
    const verifyBase =
      safeText(body.verify_base_url) ??
      Deno.env.get("VERIFY_BASE_URL") ??
      "https://sign.oasisintlholdings.com/verify.html";

    const tempUrl = buildVerifyUrl(verifyBase, "pending");
    const pass1 = await buildCertifiedPdfBytes(tempUrl);
    const pass1Hash = await sha256Hex(pass1);

    // Build pass 2 with real hash URL (final bytes/hash)
    const verifyUrl = buildVerifyUrl(verifyBase, pass1Hash);
    const certifiedBytes = await buildCertifiedPdfBytes(verifyUrl);
    const certifiedHash = await sha256Hex(certifiedBytes);

    // (tiny possibility hash changes between pass1 and pass2 because URL changed)
    // If it did change, rebuild once more using the new hash so QR matches final hash.
    let finalBytes = certifiedBytes;
    let finalHash = certifiedHash;
    let finalVerifyUrl = buildVerifyUrl(verifyBase, finalHash);

    if (certifiedHash !== pass1Hash) {
      finalVerifyUrl = buildVerifyUrl(verifyBase, certifiedHash);
      const pass3 = await buildCertifiedPdfBytes(finalVerifyUrl);
      finalBytes = pass3;
      finalHash = await sha256Hex(pass3);
      finalVerifyUrl = buildVerifyUrl(verifyBase, finalHash);
    }

    // 10) Upload certified PDF
    const up = await supabaseAdmin.storage
      .from(certified_bucket)
      .upload(certified_path, new Blob([finalBytes], { type: "application/pdf" }), {
        upsert: true,
        contentType: "application/pdf",
      });

    if (up.error) {
      return json({ ok: false, error: "CERTIFIED_PDF_UPLOAD_FAILED", details: up.error, request_id: reqId }, 500);
    }

    // 11) Update verified_documents canonical pointer + hash
    const upd = await supabaseAdmin
      .from("verified_documents")
      .update({
        entity_id,
        entity_slug,
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

    const actorEmail = await resolveActorEmail(actorId);

    return json<Resp>({
      ok: true,
      entry_id: entryId,
      actor_id: actorId,
      actor_email: actorEmail,
      is_test,
      verified_document_id: verified_id!,
      verify_url: finalVerifyUrl,
      source: { bucket: source_bucket, path: source_path, file_hash: source_hash },
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
