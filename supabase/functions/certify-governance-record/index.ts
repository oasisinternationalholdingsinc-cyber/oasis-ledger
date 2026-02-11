// supabase/functions/certify-governance-record/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";

// ✅ Edge-safe QR (NO canvas / NO wasm)
import QRGen from "npm:qrcode-generator@1.4.4";
import { PNG } from "npm:pngjs@7.0.0";

/**
 * CERTIFY (Governance) — PRODUCTION (NO REGRESSION)
 *
 * ✅ Registry-first: resolves storage pointer from verified_documents (no hardcoded path)
 * ✅ Lane-safe: uses ledger.is_test only for metadata (NOT for guessing paths)
 * ✅ Hash computed from FINAL uploaded bytes
 * ✅ verified_documents file_hash always written (required for certified)
 * ✅ Upsert uses UNIQUE(source_table, source_record_id)
 *
 * QR RULE (no circular hash):
 * - QR encodes a resolver-friendly URL using ledger_id (NOT the final hash).
 * - Response returns hash-first verify_url for copy/share.
 */

type ReqBody = {
  ledger_id?: string;
  record_id?: string; // alias
  actor_id?: string | null;

  force?: boolean;
  verify_base_url?: string | null;
};

type Resp = {
  ok: boolean;
  ledger_id?: string;
  actor_id?: string | null;
  is_test?: boolean;

  storage_bucket?: string;
  storage_path?: string;

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
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    s,
  );

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

  // Internal service_role calls usually have no user JWT.
  if (!jwt || jwt === SERVICE_ROLE_KEY) return null;

  const { data, error } = await supabaseAdmin.auth.getUser(jwt);
  if (error) return null;

  const id = data?.user?.id ?? null;
  return id && isUuid(id) ? id : null;
}

function makeQrPng(url: string): Uint8Array {
  // qrcode-generator returns a matrix; we paint pixels into a PNG
  const qr = QRGen(0, "M");
  qr.addData(url);
  qr.make();

  const count = qr.getModuleCount();
  const scale = 6; // good scan density
  const quiet = 4; // quiet zone modules

  const size = (count + quiet * 2) * scale;
  const png = new PNG({ width: size, height: size });

  // Fill white
  png.data.fill(0xff);

  const setPixel = (x: number, y: number, r: number, g: number, b: number) => {
    const idx = (png.width * y + x) << 2;
    png.data[idx] = r;
    png.data[idx + 1] = g;
    png.data[idx + 2] = b;
    png.data[idx + 3] = 0xff;
  };

  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      const dark = qr.isDark(r, c);
      if (!dark) continue;

      const x0 = (c + quiet) * scale;
      const y0 = (r + quiet) * scale;

      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          setPixel(x0 + dx, y0 + dy, 0x0b, 0x0f, 0x18); // dark ink
        }
      }
    }
  }

  return PNG.sync.write(png);
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
      return json({ ok: false, error: "ledger_id must be uuid", request_id: reqId }, 400);
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

    // Load ledger (NO entity_slug)
    const { data: ledger, error: ledErr } = await supabaseAdmin
      .from("governance_ledger")
      .select("id,title,entity_id,is_test")
      .eq("id", ledgerId)
      .maybeSingle();

    if (ledErr) {
      return json({ ok: false, error: "LEDGER_LOAD_FAILED", details: ledErr, request_id: reqId } satisfies Resp, 500);
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
      return json({ ok: false, error: "ENTITY_LOAD_FAILED", details: ent.error, request_id: reqId } satisfies Resp, 500);
    }
    const entity_slug = safeText((ent.data as any)?.slug) ?? "holdings";

    // ✅ Registry-first: resolve current stored PDF pointer from verified_documents
    // We expect archive-save-document to have already written a row pointing to the archive artifact.
    const vdExisting = await supabaseAdmin
      .from("verified_documents")
      .select("id,file_hash,verification_level,storage_bucket,storage_path,created_at")
      .eq("source_table", "governance_ledger")
      .eq("source_record_id", ledgerId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const existing = vdExisting.data as any;

    // If already certified and not force, reuse
    if (!force && existing?.id) {
      const existingHash = safeText(existing?.file_hash);
      const existingLevel = safeText(existing?.verification_level);
      const existingBucket = safeText(existing?.storage_bucket);
      const existingPath = safeText(existing?.storage_path);

      if (existingHash && (existingLevel ?? "").toLowerCase() === "certified" && existingBucket && existingPath) {
        const base =
          safeText(body.verify_base_url) ??
          "https://sign.oasisintlholdings.com/verify.html";
        return json<Resp>({
          ok: true,
          reused: true,
          ledger_id: ledgerId,
          actor_id: actorId,
          is_test,
          storage_bucket: existingBucket,
          storage_path: existingPath,
          file_hash: existingHash,
          verify_url: `${base}?hash=${existingHash}`,
          verified_document_id: String(existing.id),
          request_id: reqId,
        });
      }
    }

    const storage_bucket = safeText(existing?.storage_bucket);
    const storage_path = safeText(existing?.storage_path);

    if (!storage_bucket || !storage_path) {
      return json(
        {
          ok: false,
          error: "SOURCE_POINTER_MISSING",
          details: {
            message:
              "verified_documents has no storage_bucket/storage_path for this governance record. Archive must run first and write the pointer.",
            source_table: "governance_ledger",
            source_record_id: ledgerId,
          },
          request_id: reqId,
        } satisfies Resp,
        409,
      );
    }

    // Download the current archive artifact PDF
    const dl = await supabaseAdmin.storage.from(storage_bucket).download(storage_path);
    if (dl.error || !dl.data) {
      return json(
        {
          ok: false,
          error: "SOURCE_PDF_NOT_FOUND",
          details: dl.error,
          storage_bucket,
          storage_path,
          request_id: reqId,
        } satisfies Resp,
        404,
      );
    }

    const sourceBytes = new Uint8Array(await dl.data.arrayBuffer());

    const base =
      safeText(body.verify_base_url) ??
      "https://sign.oasisintlholdings.com/verify.html";

    // ✅ QR uses ledger_id (resolver-friendly; no hash circularity)
    const qrUrl = (() => {
      const u = new URL(base);
      u.searchParams.set("ledger_id", ledgerId);
      return u.toString();
    })();

    // Append certification page
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
      color: rgb(0.06, 0.07, 0.09),
    });

    page.drawText("This document is digitally certified.", {
      x: 48,
      y: height - 110,
      size: 11,
      font,
      color: rgb(0.12, 0.13, 0.16),
    });

    page.drawText("Scan the QR to open the verification terminal.", {
      x: 48,
      y: height - 140,
      size: 11,
      font,
      color: rgb(0.12, 0.13, 0.16),
    });

    const qrSize = 124;
    const qrX = width - 48 - qrSize;
    const qrY = 72;

    const qrPng = makeQrPng(qrUrl);
    const qrImg = await pdf.embedPng(qrPng);
    page.drawImage(qrImg, { x: qrX, y: qrY, width: qrSize, height: qrSize });

    page.drawText("Verification Terminal:", {
      x: 48,
      y: qrY + 48,
      size: 10,
      font: fontBold,
      color: rgb(0.12, 0.13, 0.16),
    });

    page.drawText(base, {
      x: 48,
      y: qrY + 32,
      size: 9,
      font,
      color: rgb(0.25, 0.27, 0.32),
    });

    page.drawText(`Ledger ID: ${ledgerId}`, {
      x: 48,
      y: qrY + 16,
      size: 9,
      font,
      color: rgb(0.25, 0.27, 0.32),
    });

    // Final bytes + hash (authoritative)
    const finalBytes = new Uint8Array(await pdf.save());
    const file_hash = await sha256Hex(finalBytes);

    // Overwrite the SAME artifact pointer (no drift)
    const up = await supabaseAdmin.storage.from(storage_bucket).upload(storage_path, finalBytes, {
      contentType: "application/pdf",
      upsert: true,
    });

    if (up.error) {
      return json(
        { ok: false, error: "UPLOAD_FAILED", details: up.error, request_id: reqId } satisfies Resp,
        500,
      );
    }

    // Upsert verified_documents — ONLY schema-safe columns
    // (Do NOT write generated columns; do NOT invent content_type/certified_by/certified_at, etc.)
    const vdPayload: Record<string, unknown> = {
      entity_id,
      entity_slug,
      title: safeText((ledger as any).title) ?? "Certified Document",
      document_class: "resolution",
      source_table: "governance_ledger",
      source_record_id: ledgerId,
      storage_bucket,
      storage_path,
      file_hash, // REQUIRED for certified
      mime_type: "application/pdf",
      verification_level: "certified",
      is_archived: true,
    };

    const vd = await supabaseAdmin
      .from("verified_documents")
      .upsert(vdPayload, { onConflict: "source_table,source_record_id" })
      .select("id")
      .maybeSingle();

    if (vd.error) {
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
      storage_bucket,
      storage_path,
      file_hash,
      verify_url: `${base}?hash=${file_hash}`,
      verified_document_id: vd.data?.id ? String((vd.data as any).id) : undefined,
      request_id: reqId,
    });
  } catch (e) {
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
