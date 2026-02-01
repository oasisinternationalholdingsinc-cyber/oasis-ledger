// supabase/functions/certify-governance-record/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument, rgb, StandardFonts } from "https://esm.sh/pdf-lib@1.17.1";
import QRCode from "https://esm.sh/qrcode@1.5.3";

/**
 * certify-governance-record (Option A — enterprise)
 *
 * Purpose:
 *  - Explicitly creates/refreshes the *certified* PDF (with QR) and writes the canonical SHA-256 hash
 *    into verified_documents.
 *  - Lane-safe: writes certified PDF to governance_sandbox or governance_truth.
 *  - NO "public.storage.objects" bug: storage scan uses schema("storage").from("objects")
 *
 * Inputs:
 *  - ledger_id (or record_id alias)
 *  - actor_id optional (otherwise resolved from JWT)
 *  - force optional (regen even if already certified)
 *  - verify_base_url optional (otherwise env VERIFY_BASE_URL; fallback to portal verify)
 *
 * Output:
 *  - ok, verified_document_id, source pointer, certified pointer + hash
 */

type ReqBody = {
  ledger_id?: string;
  record_id?: string; // tolerated alias
  actor_id?: string;

  // Optional controls
  force?: boolean; // regenerate even if already certified
  verify_base_url?: string; // override per-call (otherwise env)
};

type Resp = {
  ok: boolean;
  ledger_id?: string;
  actor_id?: string;
  is_test?: boolean;

  source?: { bucket: string; path: string };
  certified?: { bucket: string; path: string; file_hash: string; file_size: number };

  verified_document_id?: string;
  reused?: boolean;

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

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const m = dataUrl.match(/^data:.*?;base64,(.*)$/);
  const b64 = m?.[1] ?? "";
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const arr = new Uint8Array(digest);
  let hex = "";
  for (const b of arr) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function buildVerifyUrl(base: string, verifiedId: string, ledgerId: string) {
  const u = new URL(base);
  // Prefer verified_id as the canonical public resolver key
  u.searchParams.set("verified_id", verifiedId);
  // Include ledger_id as a helpful secondary hint (optional)
  u.searchParams.set("ledger_id", ledgerId);
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

async function pickMinuteBookSourcePdf(ledgerId: string): Promise<string | null> {
  // ✅ KEY FIX: query storage schema correctly (NO public.storage.objects)
  const { data, error } = await supabaseAdmin
    .schema("storage")
    .from("objects")
    .select("name, updated_at")
    .eq("bucket_id", "minute_book")
    .ilike("name", `%${ledgerId}%`)
    .ilike("name", "%.pdf")
    .order("updated_at", { ascending: false })
    .limit(50);

  if (error) throw error;

  const candidates = (data ?? []) as Array<{ name: string }>;
  if (!candidates.length) return null;

  // Prefer "-signed.pdf" if present (your enterprise convention)
  const signed = candidates.find((o) => String(o.name).toLowerCase().includes("-signed.pdf"));
  return String((signed ?? candidates[0]).name);
}

serve(async (req) => {
  const reqId = req.headers.get("x-sb-request-id") ?? null;

  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return json({ ok: false, error: "POST only", request_id: reqId }, 405);

    const body = (await req.json().catch(() => ({}))) as ReqBody;

    const ledgerId = safeText(body.ledger_id ?? body.record_id);
    if (!ledgerId || !isUuid(ledgerId)) {
      return json({ ok: false, error: "ledger_id must be uuid", request_id: reqId }, 400);
    }

    let actorId = safeText(body.actor_id);
    if (actorId && !isUuid(actorId)) {
      return json({ ok: false, error: "actor_id must be uuid", request_id: reqId }, 400);
    }

    if (!actorId) actorId = await resolveActorIdFromJwt(req);
    if (!actorId) {
      return json({ ok: false, error: "ACTOR_REQUIRED", request_id: reqId }, 401);
    }

    const force = !!body.force;

    // 1) Load ledger (minimal, stable)
    const gl = await supabaseAdmin
      .from("governance_ledger")
      .select("id, entity_id, title, is_test")
      .eq("id", ledgerId)
      .maybeSingle();

    if (gl.error) return json({ ok: false, error: gl.error.message, request_id: reqId }, 400);
    if (!gl.data?.id) return json({ ok: false, error: "LEDGER_NOT_FOUND", request_id: reqId }, 404);

    const is_test = !!(gl.data as any).is_test;
    const entity_id = String((gl.data as any).entity_id);
    const title = String((gl.data as any).title ?? "Untitled Resolution");

    // 2) Load entity
    const ent = await supabaseAdmin
      .from("entities")
      .select("id, slug, name")
      .eq("id", entity_id)
      .maybeSingle();

    if (ent.error) return json({ ok: false, error: ent.error.message, request_id: reqId }, 400);
    if (!ent.data?.id) return json({ ok: false, error: "ENTITY_NOT_FOUND", request_id: reqId }, 404);

    const entity_slug = String((ent.data as any).slug);
    // NOTE: entity_name not embedded in PDF here to avoid template drift; QR is the authoritative bridge.

    // 3) Existing verified doc (latest)
    const existingVd = await supabaseAdmin
      .from("verified_documents")
      .select("id, storage_bucket, storage_path, file_hash, verification_level, is_archived")
      .eq("source_table", "governance_ledger")
      .eq("source_record_id", ledgerId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const existingId = existingVd.data?.id ? String(existingVd.data.id) : null;
    const existingHash = safeText((existingVd.data as any)?.file_hash);
    const existingLevel = safeText((existingVd.data as any)?.verification_level);

    // Certified destination (lane-safe, deterministic)
    const certified_bucket = is_test ? "governance_sandbox" : "governance_truth";
    const certified_path = is_test ? `sandbox/archive/${ledgerId}.pdf` : `truth/archive/${ledgerId}.pdf`;

    // Fast path: already certified and already pointing where we expect
    if (!force && existingId && existingHash && (existingLevel ?? "").toLowerCase() === "certified") {
      const sb = safeText((existingVd.data as any)?.storage_bucket);
      const sp = safeText((existingVd.data as any)?.storage_path);
      if (sb === certified_bucket && sp === certified_path) {
        return json<Resp>({
          ok: true,
          reused: true,
          ledger_id: ledgerId,
          actor_id: actorId,
          is_test,
          verified_document_id: existingId,
          certified: {
            bucket: certified_bucket,
            path: certified_path,
            file_hash: existingHash,
            file_size: 0, // unknown without re-download; intentionally omitted
          },
          request_id: reqId,
        });
      }
    }

    // 4) Resolve source PDF from minute_book
    const source_bucket = "minute_book";
    let source_path: string;
    try {
      const picked = await pickMinuteBookSourcePdf(ledgerId);
      if (!picked) {
        return json(
          { ok: false, error: "SOURCE_PDF_NOT_FOUND_IN_MINUTE_BOOK", request_id: reqId },
          404,
        );
      }
      source_path = picked;
    } catch (e) {
      console.error("minute_book source scan failed:", e);
      return json(
        { ok: false, error: "SOURCE_SCAN_FAILED", details: String((e as any)?.message ?? e), request_id: reqId },
        500,
      );
    }

    // 5) Ensure we have a verified_documents id BEFORE we build QR
    let verified_id = existingId;

    if (!verified_id) {
      const ins = await supabaseAdmin
        .from("verified_documents")
        .insert({
          entity_id,
          entity_slug,
          document_class: "resolution",
          title,
          source_table: "governance_ledger",
          source_record_id: ledgerId,

          // certified target (will be true after upload)
          storage_bucket: certified_bucket,
          storage_path: certified_path,
          file_hash: null,
          mime_type: "application/pdf",
          verification_level: "certified",
          is_archived: true,

          // provenance pointers (useful for audits)
          source_storage_bucket: source_bucket,
          source_storage_path: source_path,

          created_by: actorId,
          updated_by: actorId,
        } as any)
        .select("id")
        .single();

      if (ins.error) {
        return json({ ok: false, error: "VERIFIED_DOC_INSERT_FAILED", details: ins.error, request_id: reqId }, 500);
      }
      verified_id = String(ins.data.id);
    }

    // 6) Download source PDF
    const dl = await supabaseAdmin.storage.from(source_bucket).download(source_path);
    if (dl.error || !dl.data) {
      return json(
        { ok: false, error: "SOURCE_PDF_DOWNLOAD_FAILED", details: dl.error, request_id: reqId },
        500,
      );
    }

    const sourceBytes = new Uint8Array(await dl.data.arrayBuffer());

    // 7) Build verify URL + QR
    const verifyBase =
      safeText(body.verify_base_url) ??
      Deno.env.get("VERIFY_BASE_URL") ??
      "https://portal.oasisintlholdings.com/verify";

    const verifyUrl = buildVerifyUrl(verifyBase, verified_id!, ledgerId);

    const qrDataUrl = await QRCode.toDataURL(verifyUrl, {
      errorCorrectionLevel: "M",
      margin: 0,
      width: 256,
    });

    const qrBytes = dataUrlToBytes(qrDataUrl);

    // 8) Stamp QR onto the last page (bottom-right), minimal + classy
    const pdfDoc = await PDFDocument.load(sourceBytes);
    const pages = pdfDoc.getPages();
    const last = pages[pages.length - 1];

    const qrImage = await pdfDoc.embedPng(qrBytes);

    const qrSize = 92;   // matches your old “bottom-right QR” feel
    const margin = 50;   // consistent margin
    const x = last.getWidth() - margin - qrSize;
    const y = margin + 24;

    last.drawImage(qrImage, { x, y, width: qrSize, height: qrSize });

    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    last.drawText("Verify", {
      x: x + 24,
      y: y - 12,
      size: 8,
      font,
      color: rgb(0.35, 0.38, 0.45),
    });

    // Save certified PDF bytes
    const certifiedBytes = new Uint8Array(await pdfDoc.save());
    const hashHex = await sha256Hex(certifiedBytes);

    // 9) Upload certified PDF (lane-safe bucket)
    const up = await supabaseAdmin.storage
      .from(certified_bucket)
      .upload(certified_path, new Blob([certifiedBytes], { type: "application/pdf" }), {
        upsert: true,
        contentType: "application/pdf",
        // Helpful metadata for future diagnostics (optional)
        metadata: {
          sha256: hashHex,
          verified_id: verified_id!,
          ledger_id: ledgerId,
          entity_slug,
          source_bucket,
          source_path,
        } as any,
      });

    if (up.error) {
      return json(
        { ok: false, error: "CERTIFIED_PDF_UPLOAD_FAILED", details: up.error, request_id: reqId },
        500,
      );
    }

    // 10) Update verified_documents as the canonical hash + certified pointer
    const upd = await supabaseAdmin
      .from("verified_documents")
      .update({
        entity_id,
        entity_slug,
        title,
        storage_bucket: certified_bucket,
        storage_path: certified_path,
        file_hash: hashHex,
        mime_type: "application/pdf",
        verification_level: "certified",
        is_archived: true,
        source_storage_bucket: source_bucket,
        source_storage_path: source_path,
        updated_at: new Date().toISOString(),
        updated_by: actorId,
      } as any)
      .eq("id", verified_id);

    if (upd.error) {
      return json({ ok: false, error: "VERIFIED_DOC_UPDATE_FAILED", details: upd.error, request_id: reqId }, 500);
    }

    return json<Resp>({
      ok: true,
      ledger_id: ledgerId,
      actor_id: actorId,
      is_test,
      verified_document_id: verified_id!,
      source: { bucket: source_bucket, path: source_path },
      certified: {
        bucket: certified_bucket,
        path: certified_path,
        file_hash: hashHex,
        file_size: certifiedBytes.length,
      },
      request_id: reqId,
    });
  } catch (e: any) {
    console.error("certify-governance-record fatal:", e);
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
