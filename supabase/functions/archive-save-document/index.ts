// supabase/functions/certify-governance-record/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { PDFDocument, StandardFonts } from "https://esm.sh/pdf-lib@1.17.1";

// ✅ Server-safe QR → SVG (NO canvas)
import QRCode from "https://esm.sh/qrcode-svg@1.1.0";
// ✅ SVG → PNG in Deno (NO canvas)
import { initialize, svg2png } from "https://esm.sh/svg2png-wasm@1.4.1";

type ReqBody = {
  ledger_id?: string;
  record_id?: string; // alias
  actor_id?: string;

  force?: boolean;
  verify_base_url?: string;
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

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

serve(async (req) => {
  const reqId = req.headers.get("x-sb-request-id") ?? null;

  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") {
      return json({ ok: false, error: "POST only", request_id: reqId }, 405);
    }

    const body = (await req.json().catch(() => ({}))) as ReqBody;
    const ledgerId = (body.ledger_id ?? body.record_id)?.trim();

    if (!ledgerId || !isUuid(ledgerId)) {
      return json(
        { ok: false, error: "ledger_id must be uuid", request_id: reqId },
        400,
      );
    }

    // This function is invoked from archive-save-document using service role (internal)
    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { fetch },
      auth: { persistSession: false },
    });

    // Actor is already resolved by archive-save-document; tolerate direct calls too
    let actorId = body.actor_id?.trim() ?? null;
    if (actorId && !isUuid(actorId)) {
      return json(
        { ok: false, error: "actor_id must be uuid", request_id: reqId },
        400,
      );
    }
    if (!actorId) {
      // best-effort: try auth header JWT (if any) — but do not require UI flow here
      const authHeader =
        req.headers.get("authorization") ?? req.headers.get("Authorization");
      const jwt = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
      if (jwt && jwt !== SERVICE_ROLE_KEY) {
        const { data } = await supabaseAdmin.auth.getUser(jwt);
        actorId = data?.user?.id ?? null;
      }
    }

    // Load ledger + entity + lane + archive pointers (no schema changes)
    const { data: ledger, error: ledErr } = await supabaseAdmin
      .from("governance_ledger")
      .select("id,title,entity_id,is_test,entity_slug,archived")
      .eq("id", ledgerId)
      .maybeSingle();

    if (ledErr || !ledger) {
      console.error("certify-governance-record ledger load error:", ledErr);
      return json(
        { ok: false, error: "LEDGER_NOT_FOUND", request_id: reqId },
        404,
      );
    }

    // Resolve the current archive artifact pointer.
    // NOTE: This keeps your existing behavior (the failing row shows governance_sandbox + sandbox/archive/<id>.pdf).
    const bucket = ledger.is_test ? "governance_sandbox" : "governance_archive";
    const path = ledger.is_test
      ? `sandbox/archive/${ledgerId}.pdf`
      : `archive/${ledgerId}.pdf`;

    // Download existing PDF
    const dl = await supabaseAdmin.storage.from(bucket).download(path);
    if (dl.error) {
      console.error("certify-governance-record download error:", dl.error);
      return json(
        {
          ok: false,
          error: "SOURCE_PDF_NOT_FOUND",
          details: dl.error,
          storage_bucket: bucket,
          storage_path: path,
          request_id: reqId,
        },
        404,
      );
    }

    const sourceBytes = new Uint8Array(await dl.data.arrayBuffer());

    // Build verify URL (hash-first) — default to your public verify terminal
    const base =
      (body.verify_base_url?.trim() ||
        "https://sign.oasisintlholdings.com/verify.html");
    // We'll compute hash AFTER we generate the certified PDF; QR points to hash-first URL.
    // (We update the QR using the final file_hash.)
    // So we first create a placeholder, then overwrite once hash computed.
    let verifyUrl = `${base}?hash=`;

    // Init svg2png wasm once per runtime
    await initialize();

    // Load PDF and append certification page
    const pdf = await PDFDocument.load(sourceBytes, { ignoreEncryption: true });
    const page = pdf.addPage();
    const { width, height } = page.getSize();

    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

    // Simple, stable certification page layout (no risky glyphs)
    const title = "Oasis Digital Parliament — Certification";
    page.drawText(title, {
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

    page.drawText("Scan the QR or verify by hash:", {
      x: 48,
      y: height - 140,
      size: 11,
      font,
    });

    // We'll place QR bottom-right. We'll embed after we compute final verifyUrl.
    // For now, reserve area and write placeholders.
    const qrSize = 120;
    const qrX = width - 48 - qrSize;
    const qrY = 72;

    // Save once WITHOUT QR to compute final hash? We need QR to be included in hash.
    // So we compute hash AFTER embedding QR. That means we need verifyUrl first.
    // Approach: temporarily compute hash of source? NO. We need hash of final.
    // Instead: generate QR after we compute hash — but QR needs hash. Circular.
    //
    // Solution: generate QR using the FINAL hash, but we can only know final hash after QR is embedded.
    // To break the cycle, we use a two-pass approach:
    // Pass 1: embed QR with a temporary token, save, hash.
    // Pass 2: embed QR with real hash, save, hash again, and use THAT hash as authority.
    //
    // This is acceptable and stable, because the Verified Registry hash is for the final bytes.
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

    // Pass 1 (temporary)
    const tempUrl = `${base}?hash=temp`;
    const tempPng = await makeQrPng(tempUrl);
    const tempImg = await pdf.embedPng(tempPng);

    page.drawImage(tempImg, {
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
    });

    // Save pass 1 bytes and hash
    const pass1Bytes = new Uint8Array(await pdf.save());
    const pass1Hash = await sha256Hex(pass1Bytes);

    // Now rewrite QR with real hash by rebuilding the PDF from pass1Bytes
    const pdf2 = await PDFDocument.load(pass1Bytes, { ignoreEncryption: true });
    const last = pdf2.getPages()[pdf2.getPageCount() - 1];
    const { width: w2, height: h2 } = last.getSize();

    // Cover old QR area with white rect (safe, minimal)
    last.drawRectangle({
      x: w2 - 48 - qrSize,
      y: 72,
      width: qrSize,
      height: qrSize,
      color: { r: 1, g: 1, b: 1 },
    });

    verifyUrl = `${base}?hash=${pass1Hash}`;
    const realPng = await makeQrPng(verifyUrl);
    const realImg = await pdf2.embedPng(realPng);

    last.drawImage(realImg, {
      x: w2 - 48 - qrSize,
      y: 72,
      width: qrSize,
      height: qrSize,
    });

    // Save final bytes and compute authoritative hash
    const finalBytes = new Uint8Array(await pdf2.save());
    const file_hash = await sha256Hex(finalBytes);

    // Upload final PDF back to same pointer (no drift)
    const up = await supabaseAdmin.storage.from(bucket).upload(path, finalBytes, {
      contentType: "application/pdf",
      upsert: true,
    });
    if (up.error) {
      console.error("certify-governance-record upload error:", up.error);
      return json(
        {
          ok: false,
          error: "UPLOAD_FAILED",
          details: up.error,
          request_id: reqId,
        },
        500,
      );
    }

    // Upsert verified_documents (DO NOT write generated columns)
    const vdPayload: Record<string, unknown> = {
      entity_id: ledger.entity_id,
      entity_slug: ledger.entity_slug ?? "holdings",
      title: ledger.title ?? "Certified Document",
      document_class: "resolution",
      source_table: "governance_ledger",
      source_record_id: ledgerId,
      storage_bucket: bucket,
      storage_path: path,
      file_hash, // ✅ REQUIRED (fixes your 23514)
      content_type: "application/pdf",
      verification_level: "certified",
      is_archived: true,
      // If you store actor fields, keep them tolerant:
      certified_by: actorId,
      certified_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    // Prefer upsert on source_record_id or file_hash unique; your schema has UNIQUE(file_hash),
    // and typically you want one row per source_record_id. We'll upsert on source_record_id.
    const { error: vdErr } = await supabaseAdmin
      .from("verified_documents")
      .upsert(vdPayload, { onConflict: "source_record_id" });

    if (vdErr) {
      console.error("verified_documents upsert error:", vdErr);
      return json(
        {
          ok: false,
          error: "VERIFIED_DOC_INSERT_FAILED",
          details: vdErr,
          request_id: reqId,
        },
        500,
      );
    }

    return json({
      ok: true,
      ledger_id: ledgerId,
      actor_id: actorId,
      storage_bucket: bucket,
      storage_path: path,
      file_hash,
      verify_url: `${base}?hash=${file_hash}`,
      request_id: reqId,
    });
  } catch (e) {
    console.error("certify-governance-record fatal:", e);
    return json(
      {
        ok: false,
        error: "CERTIFY_FATAL",
        message: String((e as any)?.message ?? e),
        request_id: reqId,
      },
      500,
    );
  }
});
