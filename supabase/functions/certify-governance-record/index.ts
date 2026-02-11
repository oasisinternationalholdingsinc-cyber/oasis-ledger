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
 * CERTIFY (Governance)
 * - ✅ NO governance_ledger.entity_slug (does not exist in prod)
 * - ✅ Lane-safe archive pointers: governance_sandbox vs governance_archive
 * - ✅ Hash is computed from FINAL bytes (the file you upload)
 * - ✅ verified_documents: always writes file_hash when verification_level='certified'
 * - ✅ Upsert uses UNIQUE(source_table, source_record_id)
 *
 * IMPORTANT NOTE (hash circularity):
 * - A QR that encodes the *final* file hash is circular (hash depends on QR).
 * - To stay correct + stable, QR encodes ledger_id (resolver-friendly), while
 *   verify_url returned is hash-first for sharing/copy.
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

const cors = {
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

  // If called internally with service_role, there may be no user JWT.
  if (!jwt || jwt === SERVICE_ROLE_KEY) return null;

  const { data, error } = await supabaseAdmin.auth.getUser(jwt);
  if (error) return null;

  const id = data?.user?.id ?? null;
  return id && isUuid(id) ? id : null;
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
        { ok: false, error: "ledger_id must be uuid", request_id: reqId },
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
        { ok: false, error: "LEDGER_LOAD_FAILED", details: ledErr, request_id: reqId },
        500,
      );
    }
    if (!ledger?.id) {
      return json({ ok: false, error: "LEDGER_NOT_FOUND", request_id: reqId }, 404);
    }

    const is_test = !!(ledger as any).is_test;

    // ✅ Lane-safe destination pointers (your current convention)
    const bucket = is_test ? "governance_sandbox" : "governance_archive";
    const path = is_test ? `sandbox/archive/${ledgerId}.pdf` : `archive/${ledgerId}.pdf`;

    // ✅ Idempotency: if already certified + hash exists + pointers match, reuse unless force
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
        existingBucket === bucket &&
        existingPath === path
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
          storage_bucket: bucket,
          storage_path: path,
          file_hash: existingHash,
          verify_url: `${base}?hash=${existingHash}`,
          verified_document_id: String((existing.data as any).id),
          request_id: reqId,
        });
      }
    }

    // Download existing archived PDF (must exist before cert)
    const dl = await supabaseAdmin.storage.from(bucket).download(path);
    if (dl.error || !dl.data) {
      console.error("certify-governance-record download error:", dl.error);
      return json(
        {
          ok: false,
          error: "SOURCE_PDF_NOT_FOUND",
          details: dl.error,
          storage_bucket: bucket,
          storage_path: path,
          request_id: reqId,
        } satisfies Resp,
        404,
      );
    }

    const sourceBytes = new Uint8Array(await dl.data.arrayBuffer());

    // Verify terminal base (hash-first sharing)
    const base =
      safeText(body.verify_base_url) ??
      "https://sign.oasisintlholdings.com/verify.html";

    // ✅ QR content uses ledger_id to avoid hash circularity
    // (Your resolver/verify terminal should support ledger_id lookups.)
    const qrUrl = (() => {
      const u = new URL(base);
      u.searchParams.set("ledger_id", ledgerId);
      return u.toString();
    })();

    // Init svg2png wasm once per runtime
    await initialize();

    const makeQrPng = async (url: string) => {
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
    };

    // Load PDF and append certification page (stable, no fancy glyphs)
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
    });

    page.drawText("This document is digitally certified.", {
      x: 48,
      y: height - 110,
      size: 11,
      font,
    });

    page.drawText("Scan the QR to open the verification terminal.", {
      x: 48,
      y: height - 140,
      size: 11,
      font,
    });

    const qrSize = 120;
    const qrX = width - 48 - qrSize;
    const qrY = 72;

    const qrPng = await makeQrPng(qrUrl);
    const qrImg = await pdf.embedPng(qrPng);

    page.drawImage(qrImg, {
      x: qrX,
      y: qrY,
      width: qrSize,
      height: qrSize,
    });

    page.drawText("Verification Terminal:", {
      x: 48,
      y: qrY + 48,
      size: 10,
      font: fontBold,
    });
    page.drawText(base, {
      x: 48,
      y: qrY + 32,
      size: 9,
      font,
      color: rgb(0.85, 0.85, 0.88),
    });

    // Save final bytes and compute authoritative hash
    const finalBytes = new Uint8Array(await pdf.save());
    const file_hash = await sha256Hex(finalBytes);

    // Upload final PDF back to same pointer (no drift)
    const up = await supabaseAdmin.storage.from(bucket).upload(path, finalBytes, {
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

    // Resolve entity_slug from entities (canonical)
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

    // Upsert verified_documents
    // ✅ DO NOT write generated columns
    // ✅ MUST include file_hash when verification_level='certified'
    const vdPayload: Record<string, unknown> = {
      entity_id,
      entity_slug, // if your table has it; harmless if present in your prod schema
      title: safeText((ledger as any).title) ?? "Certified Document",
      document_class: "resolution",
      source_table: "governance_ledger",
      source_record_id: ledgerId,
      storage_bucket: bucket,
      storage_path: path,
      file_hash, // ✅ REQUIRED by CHECK when certified
      content_type: "application/pdf",
      verification_level: "certified",
      is_archived: true,
      certified_by: actorId, // can be null if service-call without user JWT
      certified_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
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
      storage_bucket: bucket,
      storage_path: path,
      file_hash,
      verify_url: `${base}?hash=${file_hash}`, // hash-first for copy/share
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
