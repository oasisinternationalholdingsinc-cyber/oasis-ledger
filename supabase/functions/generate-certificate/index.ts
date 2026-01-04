// supabase/functions/generate-certificate/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  PDFDocument,
  StandardFonts,
  rgb,
} from "https://esm.sh/pdf-lib@1.17.1?target=deno";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
};

const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

function fmtDate(value: string | null | undefined): string {
  if (!value) return "N/A";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "N/A";
  // nice ISO date
  return d.toISOString().replace("T", " ").replace("Z", " UTC").slice(0, 20);
}

function safeStr(v: unknown, fallback = "—") {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : fallback;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });

  try {
    // NOTE: This function is "public callable" (anon) but uses service_role internally.
    // We do NOT rely on caller JWT.
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { fetch },
      auth: { persistSession: false },
    });

    const url = new URL(req.url);

    // Accept identifiers from query string or JSON body (enterprise-friendly).
    let hash = url.searchParams.get("hash");
    let envelope_id = url.searchParams.get("envelope_id");
    let ledger_id = url.searchParams.get("ledger_id");

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      hash = hash ?? body.hash ?? null;
      envelope_id = envelope_id ?? body.envelope_id ?? null;
      ledger_id = ledger_id ?? body.ledger_id ?? null;
    }

    hash = typeof hash === "string" ? hash.trim().toLowerCase() : null;
    envelope_id = typeof envelope_id === "string" ? envelope_id.trim() : null;
    ledger_id = typeof ledger_id === "string" ? ledger_id.trim() : null;

    if (!hash && !envelope_id && !ledger_id) {
      return json(
        {
          ok: false,
          error: "MISSING_IDENTIFIER",
          message:
            "Provide one of: ?ledger_id=<uuid> OR ?envelope_id=<uuid> OR ?hash=<sha256>.",
        },
        400,
      );
    }

    // Canonical: resolve via SQL function you already locked in memory.
    const { data: resolved, error: rErr } = await supabase.rpc(
      "resolve_verified_record",
      {
        p_hash: hash,
        p_envelope_id: envelope_id,
        p_ledger_id: ledger_id,
      },
    );

    if (rErr) {
      console.error("resolve_verified_record rpc error", rErr);
      return json(
        {
          ok: false,
          error: "RESOLVER_RPC_FAILED",
          message: rErr.message,
        },
        500,
      );
    }

    // resolve_verified_record returns jsonb (an object)
    const payload = resolved as any;

    if (!payload || payload.ok !== true) {
      return json(
        {
          ok: false,
          error: payload?.error ?? "NOT_RESOLVED",
          message:
            payload?.error === "NOT_REGISTERED"
              ? "No verified record is registered for this identifier."
              : "Unable to resolve a certified record.",
          details: payload ?? null,
        },
        payload?.error === "NOT_REGISTERED" ? 404 : 400,
      );
    }

    const ent = payload.entity || {};
    const led = payload.ledger || {};
    const ver = payload.verified || {};
    const best = payload.best_pdf || {};
    const publicPdf = payload.public_pdf || {};

    const outLedgerId = safeStr(payload.ledger_id || led.id, "");
    const outHash = safeStr(payload.hash || ver.file_hash, "");
    const lane = led.is_test ? "SANDBOX" : "RoT";
    const level = safeStr(ver.verification_level, "certified").toUpperCase();

    const entityName = safeStr(ent.name, "Oasis Entity");
    const entitySlug = safeStr(ent.slug, "—");
    const title = safeStr(led.title, "Resolution");
    const status = safeStr(led.status, "—");

    const verifiedDocId = safeStr(payload.verified_document_id, "—");
    const verifiedBucket = safeStr(ver.storage_bucket, "—");
    const verifiedPath = safeStr(ver.storage_path, "—");
    const verifiedAt = fmtDate(ver.created_at);

    const evidenceKind = safeStr(best.kind, "—");
    const evidenceBucket = safeStr(publicPdf.storage_bucket || best.storage_bucket, "—");
    const evidencePath = safeStr(publicPdf.storage_path || best.storage_path, "—");

    const issuedAt = fmtDate(new Date().toISOString());

    // --- Build branded PDF ---
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595.28, 841.89]); // A4
    const width = page.getWidth();
    const height = page.getHeight();

    const titleFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const bodyFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const monoFont = await pdfDoc.embedFont(StandardFonts.Courier);

    // Colors (IMPORTANT: rgb(), not arrays)
    const GOLD = rgb(0.85, 0.70, 0.25);
    const INK = rgb(0.03, 0.04, 0.07);
    const WHITE = rgb(1, 1, 1);
    const GREY = rgb(0.45, 0.47, 0.52);
    const FAINT = rgb(0.18, 0.20, 0.24);

    // background panel
    page.drawRectangle({
      x: 36,
      y: 36,
      width: width - 72,
      height: height - 72,
      borderWidth: 2,
      borderColor: GOLD,
      color: INK,
    });

    // watermark (subtle)
    page.drawText("OASIS DIGITAL PARLIAMENT", {
      x: 60,
      y: 440,
      size: 42,
      font: titleFont,
      color: FAINT,
      rotate: { type: "degrees", angle: 18 },
      opacity: 0.12,
    });

    // header
    const headerText = "Oasis Digital Parliament";
    const headerSize = 18;
    const headerWidth = titleFont.widthOfTextAtSize(headerText, headerSize);
    page.drawText(headerText, {
      x: (width - headerWidth) / 2,
      y: height - 86,
      size: headerSize,
      font: titleFont,
      color: GOLD,
    });

    const subText = "Certificate of Verification";
    const subSize = 13;
    const subWidth = bodyFont.widthOfTextAtSize(subText, subSize);
    page.drawText(subText, {
      x: (width - subWidth) / 2,
      y: height - 112,
      size: subSize,
      font: bodyFont,
      color: WHITE,
    });

    // small lane badge
    const badge = `LANE: ${lane} • LEVEL: ${level}`;
    page.drawText(badge, {
      x: 70,
      y: height - 142,
      size: 10,
      font: bodyFont,
      color: GREY,
    });

    let cursorY = height - 175;
    const lineH = 16;

    const drawKV = (k: string, v: string, isMono = false) => {
      page.drawText(k, { x: 70, y: cursorY, size: 9, font: bodyFont, color: GREY });
      cursorY -= lineH;
      page.drawText(v, {
        x: 70,
        y: cursorY,
        size: 10,
        font: isMono ? monoFont : bodyFont,
        color: WHITE,
        maxWidth: width - 140,
      });
      cursorY -= lineH * 1.35;
    };

    drawKV("ENTITY", `${entityName} (${entitySlug})`);
    drawKV("DOCUMENT TITLE", title);
    drawKV("LEDGER", `id: ${outLedgerId} • status: ${status}`);
    drawKV("VERIFIED REGISTRY", `id: ${verifiedDocId} • at: ${verifiedAt}`);
    drawKV("ARCHIVE POINTER", `${verifiedBucket}:${verifiedPath}`, true);

    drawKV("EVIDENCE (best_pdf)", `${evidenceKind}`, false);
    drawKV("MINUTE BOOK POINTER", `${evidenceBucket}:${evidencePath}`, true);

    drawKV("SHA-256", outHash || "—", true);
    drawKV("ISSUED", issuedAt);

    // footer
    const footer =
      "This certificate affirms that the referenced record is registered in the Oasis Digital Parliament registry and that the SHA-256 hash matches the canonical stored value at the time of issuance.";
    page.drawText(footer, {
      x: 70,
      y: 92,
      size: 9,
      font: bodyFont,
      color: GREY,
      maxWidth: width - 140,
      lineHeight: 12,
    });

    page.drawText("ODP.AI • Certified Verification Receipt", {
      x: 70,
      y: 66,
      size: 9,
      font: bodyFont,
      color: GOLD,
    });

    const pdfBytes = await pdfDoc.save();

    const filename = outLedgerId
      ? `Oasis-Certificate-${outLedgerId}.pdf`
      : "Oasis-Certificate.pdf";

    return new Response(pdfBytes, {
      status: 200,
      headers: {
        ...cors,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    console.error("generate-certificate fatal", err);
    return json(
      {
        ok: false,
        error: "UNEXPECTED_ERROR",
        message: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});
