// supabase/functions/certify-governance-record/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";

// ✅ Server-safe QR → SVG (NO canvas)
import QRCode from "https://esm.sh/qrcode-svg@1.1.0";
// ✅ SVG → PNG in Deno (NO canvas)
import { initialize, svg2png } from "https://esm.sh/svg2png-wasm@1.4.1";

/**
 * CERTIFY (Governance) — PRODUCTION (NO REGRESSION)
 *
 * ✅ Reads source PDF from minute_book storage pointer (bucket/path)
 * ✅ Lane-safe (only uses governance_ledger.is_test for metadata; does NOT guess archive buckets)
 * ✅ Computes SHA-256 from FINAL bytes (the actual uploaded certified file)
 * ✅ Appends a NEW final certification page (not stamping last)
 * ✅ Writes Verified Registry:
 *    - public.verified_documents (schema-safe: mime_type, file_hash REQUIRED for certified)
 *    - upsert on (source_table, source_record_id)
 * ✅ NO governance_ledger.entity_slug (does not exist)
 * ✅ DOES NOT write generated columns (source_storage_*)
 *
 * QR / hash circularity:
 * - QR encodes ledger_id (resolver-friendly) to avoid hash circularity.
 * - Response includes verify_url hash-first for copy/share.
 */

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
  actor_id?: string | null;
  is_test?: boolean;

  source?: {
    bucket: string;
    path: string;
  };

  file_hash?: string;
  verify_url?: string;

  verified_document_id?: string;
  reused?: boolean;

  error?: string;
  details?: unknown;
  request_id?: string | null;
};

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

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
}

const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(s);

const safeText = (v: unknown) => {
  if (v == null) return null;
  const t = String(v).trim();
  return t.length ? t : null;
};

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function resolveActorIdBestEffort(
  supabaseAdmin: ReturnType<typeof createClient>,
  req: Request,
  bodyActorId?: string | null,
): Promise<string | null> {
  const actorId = safeText(bodyActorId);
  if (actorId) return isUuid(actorId) ? actorId : null;

  const authHeader =
    req.headers.get("authorization") ?? req.headers.get("Authorization");
  const jwt = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  // If called internally with service_role, there may be no user JWT.
  if (!jwt || jwt === SERVICE_ROLE_KEY) return null;

  const { data, error } = await supabaseAdmin.auth.getUser(jwt);
  if (error) return null;

  const id = data?.user?.id ?? null;
  return id && isUuid(id) ? id : null;
}

/**
 * svg2png-wasm init is expensive; do it once per runtime.
 * If QR conversion fails, certification still proceeds (QR omitted).
 */
let _svg2pngInit: Promise<void> | null = null;
const ensureSvg2PngReady = async () => {
  if (!_svg2pngInit) _svg2pngInit = initialize();
  await _svg2pngInit;
};

async function makeQrPngBestEffort(url: string): Promise<Uint8Array | null> {
  try {
    await ensureSvg2PngReady();

    const svg = new QRCode({
      content: url,
      padding: 0,
      width: 256,
      height: 256,
      color: "#0b0f18",
      background: "#ffffff",
      ecl: "M",
    }).svg();

    const png = await svg2png(svg, { width: 256, height: 256 });
    return new Uint8Array(png);
  } catch (e) {
    console.error("certify-governance-record QR generation failed (non-fatal):", e);
    return null;
  }
}

/**
 * ✅ Enterprise pointer resolver:
 * - Reads the source PDF from minute_book bucket by searching storage.objects
 * - Prefers "*-signed.pdf" then latest updated
 * - Refuses archive-looking paths
 *
 * We do NOT assume "holdings/resolutions/<id>-signed.pdf" because case drift exists.
 */
async function resolveMinuteBookPointer(
  supabaseAdmin: ReturnType<typeof createClient>,
  ledgerId: string,
): Promise<{ bucket: string; path: string }> {
  const bucket = "minute_book";

  // Query storage.objects through PostgREST (works; table is in "storage" schema)
  const q = await supabaseAdmin
    .schema("storage")
    .from("objects")
    .select("name, updated_at")
    .eq("bucket_id", bucket)
    .ilike("name", `%${ledgerId}%`)
    .ilike("name", "%.pdf")
    .order("updated_at", { ascending: false })
    .limit(25);

  if (q.error) {
    throw new Error(`STORAGE_OBJECTS_QUERY_FAILED: ${q.error.message}`);
  }

  const rows = (q.data ?? []) as Array<{ name: string; updated_at: string }>;

  if (!rows.length) {
    throw new Error(`MINUTE_BOOK_PDF_NOT_FOUND: ${ledgerId}`);
  }

  // Prefer *-signed.pdf (case-insensitive)
  const signed =
    rows.find((r) => r.name.toLowerCase().includes("-signed.pdf")) ?? rows[0];

  const path = signed.name;

  const p = path.toLowerCase();
  if (p.startsWith("sandbox/archive/") || p.includes("/archive/")) {
    throw new Error(`FORBIDDEN_ARCHIVE_PATH_RESOLVED: ${path}`);
  }

  return { bucket, path };
}

serve(async (req) => {
  const reqId = req.headers.get("x-sb-request-id") ?? null;

  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") {
      return json({ ok: false, error: "POST only", request_id: reqId }, 405);
    }

    const body = (await req.json().catch(() => ({}))) as ReqBody;
    const ledgerId = safeText(body.ledger_id ?? body.record_id);

    if (!ledgerId || !isUuid(ledgerId)) {
      return json(
        { ok: false, error: "ledger_id must be uuid", request_id: reqId } satisfies Resp,
        400,
      );
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { fetch },
      auth: { persistSession: false },
    });

    const actorId = await resolveActorIdBestEffort(
      supabaseAdmin,
      req,
      body.actor_id ?? null,
    );

    const force = !!body.force;

    // ✅ Load ledger (NO entity_slug)
    const { data: ledger, error: ledErr } = await supabaseAdmin
      .from("governance_ledger")
      .select("id,title,entity_id,is_test,archived")
      .eq("id", ledgerId)
      .maybeSingle();

    if (ledErr) {
      console.error("certify-governance-record ledger load error:", ledErr);
      return json(
        { ok: false, error: "LEDGER_LOAD_FAILED", details: ledErr, request_id: reqId } satisfies Resp,
        500,
      );
    }
    if (!ledger?.id) {
      return json({ ok: false, error: "LEDGER_NOT_FOUND", request_id: reqId } satisfies Resp, 404);
    }

    const is_test = !!(ledger as any).is_test;

    // ✅ Resolve entity_slug from entities (canonical)
    const entity_id = String((ledger as any).entity_id);
    const ent = await supabaseAdmin
      .from("entities")
      .select("id, slug")
      .eq("id", entity_id)
      .maybeSingle();

    if (ent.error) {
      return json(
        { ok: false, error: "ENTITY_LOAD_FAILED", details: ent.error, request_id: reqId } satisfies Resp,
        500,
      );
    }
    const entity_slug = safeText((ent.data as any)?.slug) ?? "holdings";

    // ✅ Resolve minute_book pointer (bucket/path)
    const src = await resolveMinuteBookPointer(supabaseAdmin, ledgerId);

    // ✅ Idempotency: if verified already matches same pointer + has hash, reuse unless force
    const existing = await supabaseAdmin
      .from("verified_documents")
      .select("id,file_hash,verification_level,storage_bucket,storage_path,created_at")
      .eq("source_table", "governance_ledger")
      .eq("source_record_id", ledgerId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!force && existing.data?.id) {
      const existingHash = safeText((existing.data as any)?.file_hash);
      const existingLevel = safeText((existing.data as any)?.verification_level);
      const existingBucket = safeText((existing.data as any)?.storage_bucket);
      const existingPath = safeText((existing.data as any)?.storage_path);

      if (
        existingHash &&
        (existingLevel ?? "").toLowerCase() === "certified" &&
        existingBucket === src.bucket &&
        existingPath === src.path
      ) {
        const base =
          safeText(body.verify_base_url) ??
          "https://sign.oasisintlholdings.com/verify.html";

        return json<Resp>({
          ok: true,
          reused: true,
          ledger_id: ledgerId,
          actor_id: actorId,
          is_test,
          source: { bucket: src.bucket, path: src.path },
          file_hash: existingHash,
          verify_url: `${base}?hash=${existingHash}`,
          verified_document_id: String((existing.data as any).id),
          request_id: reqId,
        });
      }
    }

    // ✅ Download existing PDF from minute_book pointer
    const dl = await supabaseAdmin.storage.from(src.bucket).download(src.path);
    if (dl.error || !dl.data) {
      console.error("certify-governance-record download error:", dl.error);
      return json(
        {
          ok: false,
          error: "SOURCE_PDF_NOT_FOUND",
          details: dl.error,
          request_id: reqId,
          source: { bucket: src.bucket, path: src.path },
        } satisfies Resp,
        404,
      );
    }

    const sourceBytes = new Uint8Array(await dl.data.arrayBuffer());

    // Verify terminal base (hash-first sharing)
    const base =
      safeText(body.verify_base_url) ??
      "https://sign.oasisintlholdings.com/verify.html";

    // ✅ QR content uses ledger_id (resolver-friendly) to avoid hash circularity
    const qrUrl = (() => {
      const u = new URL(base);
      u.searchParams.set("ledger_id", ledgerId);
      return u.toString();
    })();

    // Append certification page (stable, no risky glyphs)
    const pdf = await PDFDocument.load(sourceBytes, { ignoreEncryption: true });
    const page = pdf.addPage();
    const { width, height } = page.getSize();

    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

    page.drawText("Oasis Digital Parliament — Certification", {
      x: 48,
      y: height - 72,
      size: 18,
      font: fontBold,
      color: rgb(0.95, 0.95, 0.96),
    });

    page.drawText("This document is digitally certified.", {
      x: 48,
      y: height - 110,
      size: 11,
      font,
      color: rgb(0.92, 0.92, 0.94),
    });

    page.drawText("Scan the QR to open the verification terminal.", {
      x: 48,
      y: height - 140,
      size: 11,
      font,
      color: rgb(0.92, 0.92, 0.94),
    });

    const qrSize = 120;
    const qrX = width - 48 - qrSize;
    const qrY = 72;

    const qrPng = await makeQrPngBestEffort(qrUrl);
    if (qrPng) {
      const qrImg = await pdf.embedPng(qrPng);
      page.drawImage(qrImg, {
        x: qrX,
        y: qrY,
        width: qrSize,
        height: qrSize,
      });
    } else {
      page.drawText("[QR unavailable]", {
        x: qrX,
        y: qrY + qrSize / 2,
        size: 9,
        font,
        color: rgb(0.75, 0.75, 0.78),
      });
    }

    page.drawText("Verification Terminal:", {
      x: 48,
      y: qrY + 48,
      size: 10,
      font: fontBold,
      color: rgb(0.92, 0.92, 0.94),
    });

    page.drawText(base, {
      x: 48,
      y: qrY + 32,
      size: 9,
      font,
      color: rgb(0.78, 0.78, 0.82),
    });

    page.drawText(`Ledger ID: ${ledgerId}`, {
      x: 48,
      y: qrY + 16,
      size: 9,
      font,
      color: rgb(0.78, 0.78, 0.82),
    });

    // Save final bytes + authoritative hash
    const finalBytes = new Uint8Array(await pdf.save());
    const file_hash = await sha256Hex(finalBytes);

    // Upload certified PDF back to SAME minute_book pointer (no drift)
    const up = await supabaseAdmin.storage.from(src.bucket).upload(src.path, finalBytes, {
      contentType: "application/pdf",
      upsert: true,
    });

    if (up.error) {
      console.error("certify-governance-record upload error:", up.error);
      return json(
        { ok: false, error: "UPLOAD_FAILED", details: up.error, request_id: reqId } satisfies Resp,
        500,
      );
    }

    // ✅ Upsert Verified Registry (schema-safe)
    // - mime_type (not content_type)
    // - file_hash REQUIRED for certified
    // - upsert by (source_table,source_record_id)
    const nowIso = new Date().toISOString();

    const vdPayload: Record<string, unknown> = {
      entity_id,
      entity_slug,
      title: safeText((ledger as any).title) ?? "Certified Document",
      document_class: "resolution",
      source_table: "governance_ledger",
      source_record_id: ledgerId,
      storage_bucket: src.bucket,
      storage_path: src.path,
      file_hash,
      mime_type: "application/pdf",
      verification_level: "certified",
      is_archived: true,
      updated_by: actorId,
      updated_at: nowIso,
    };

    const vd = await supabaseAdmin
      .from("verified_documents")
      .upsert(vdPayload, { onConflict: "source_table,source_record_id" })
      .select("id")
      .maybeSingle();

    if (vd.error) {
      console.error("verified_documents upsert error:", vd.error);
      return json(
        { ok: false, error: "VERIFIED_DOC_UPSERT_FAILED", details: vd.error, request_id: reqId } satisfies Resp,
        500,
      );
    }

    return json<Resp>({
      ok: true,
      ledger_id: ledgerId,
      actor_id: actorId,
      is_test,
      source: { bucket: src.bucket, path: src.path },
      file_hash,
      verify_url: `${base}?hash=${file_hash}`,
      verified_document_id: vd.data?.id ? String((vd.data as any).id) : undefined,
      request_id: reqId,
    });
  } catch (e) {
    console.error("certify-governance-record fatal:", e);
    return json(
      {
        ok: false,
        error: "CERTIFY_FATAL",
        details: String((e as any)?.message ?? e),
        request_id: req.headers.get("x-sb-request-id") ?? null,
      } satisfies Resp,
      500,
    );
  }
});
