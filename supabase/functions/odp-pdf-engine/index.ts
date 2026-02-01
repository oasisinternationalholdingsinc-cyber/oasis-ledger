import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";

// ---------------------------------------------------------------------------
// ENV + CLIENT
// ---------------------------------------------------------------------------
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

const BUCKET = "minute_book";

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

type DrawOptions = {
  page: any;
  font: any;
  fontBold: any;
  margin: number;
  maxWidth: number;
  startY: number;
  lineHeight: number;
};

function safeText(s: unknown): string | null {
  if (s == null) return null;
  const t = String(s).trim();
  return t.length ? t : null;
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(data: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}

// Word-wrap helper with basic page-break support.
function drawWrappedText(
  pdfDoc: PDFDocument,
  text: string,
  opts: DrawOptions,
  addPageFn: () => { page: any; startY: number },
): { page: any; y: number } {
  let { page, font, margin, maxWidth, startY, lineHeight } = opts;
  let y = startY;

  const safeBottom = 92;
  const paragraphs = String(text ?? "").split(/\n\s*\n/);

  for (const para of paragraphs) {
    const words = para.trim().length ? para.split(/\s+/) : [];
    let line = "";

    const flushLine = () => {
      if (!line) return;
      page.drawText(line, {
        x: margin,
        y,
        size: 11,
        font,
        color: rgb(0.16, 0.18, 0.22),
      });
      y -= lineHeight;
      line = "";
    };

    for (const word of words) {
      const testLine = line ? `${line} ${word}` : word;
      const width = font.widthOfTextAtSize(testLine, 11);

      if (width > maxWidth) {
        flushLine();
        if (y < safeBottom) {
          const next = addPageFn();
          page = next.page;
          y = next.startY;
        }
        line = word;
      } else {
        line = testLine;
      }

      if (y < safeBottom) {
        flushLine();
        const next = addPageFn();
        page = next.page;
        y = next.startY;
      }
    }

    flushLine();
    y -= lineHeight * 0.35;

    if (y < safeBottom) {
      const next = addPageFn();
      page = next.page;
      y = next.startY;
    }
  }

  return { page, y };
}

function addOasisHeader(
  page: any,
  font: any,
  fontBold: any,
  entityName: string,
  title: string,
  createdAt?: string | null,
) {
  const width = page.getWidth();
  const height = page.getHeight();
  const margin = 50;

  page.drawText("Oasis Digital Parliament", {
    x: margin,
    y: height - 52,
    size: 12,
    font: fontBold,
    color: rgb(0.12, 0.14, 0.18),
  });

  page.drawText(entityName, {
    x: margin,
    y: height - 68,
    size: 9,
    font,
    color: rgb(0.38, 0.42, 0.5),
  });

  const dateText = createdAt
    ? `Created ${new Date(createdAt).toISOString().slice(0, 10)}`
    : "";
  if (dateText) {
    const dateW = font.widthOfTextAtSize(dateText, 9);
    page.drawText(dateText, {
      x: width - margin - dateW,
      y: height - 52,
      size: 9,
      font,
      color: rgb(0.38, 0.42, 0.5),
    });
  }

  page.drawLine({
    start: { x: margin, y: height - 80 },
    end: { x: width - margin, y: height - 80 },
    thickness: 0.6,
    color: rgb(0.82, 0.84, 0.88),
  });

  const titleText = title || "Corporate Resolution";
  const titleSize = 14;
  const titleW = fontBold.widthOfTextAtSize(titleText, titleSize);
  const titleX = Math.max(margin, (width - titleW) / 2);

  page.drawText(titleText, {
    x: titleX,
    y: height - 112,
    size: titleSize,
    font: fontBold,
    color: rgb(0.12, 0.14, 0.18),
  });

  page.drawText("Corporate Resolution", {
    x: titleX,
    y: height - 130,
    size: 9,
    font,
    color: rgb(0.45, 0.48, 0.55),
  });

  return height - 165;
}

function addFooter(page: any, font: any) {
  const width = page.getWidth();
  const margin = 50;

  page.drawLine({
    start: { x: margin, y: 64 },
    end: { x: width - margin, y: 64 },
    thickness: 0.6,
    color: rgb(0.88, 0.9, 0.93),
  });

  page.drawText("Generated by Oasis Digital Parliament · CI-Alchemy / CI-Forge", {
    x: margin,
    y: 44,
    size: 8,
    font,
    color: rgb(0.5, 0.55, 0.6),
  });
}

function addSignatureBlock(page: any, font: any, fontBold: any) {
  const margin = 50;

  page.drawText("Authorized Signatory", {
    x: margin,
    y: 150,
    size: 10,
    font: fontBold,
    color: rgb(0.16, 0.18, 0.22),
  });

  page.drawLine({
    start: { x: margin, y: 128 },
    end: { x: margin + 280, y: 128 },
    thickness: 0.8,
    color: rgb(0.25, 0.28, 0.32),
  });

  page.drawText("Name / Title", {
    x: margin,
    y: 110,
    size: 9,
    font,
    color: rgb(0.45, 0.48, 0.55),
  });
}

async function objectExists(bucket: string, path: string): Promise<boolean> {
  // Storage list requires a folder + limit; we do best-effort.
  const parts = path.split("/");
  const file = parts.pop()!;
  const folder = parts.join("/");

  const { data, error } = await supabase.storage
    .from(bucket)
    .list(folder, { limit: 1000, search: file });

  if (error) return false;
  return Array.isArray(data) && data.some((o) => o?.name === file);
}

// ---------------------------------------------------------------------------
// HANDLER
// ---------------------------------------------------------------------------
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const record_id = safeText(body?.record_id);
  const envelope_id = safeText(body?.envelope_id);
  if (!record_id || !envelope_id) {
    return json({ ok: false, error: "record_id and envelope_id are required" }, 400);
  }

  try {
    // 1) Load ledger record
    const { data: record, error: recErr } = await supabase
      .from("governance_ledger")
      .select("id, entity_id, title, body, created_at")
      .eq("id", record_id)
      .single();

    if (recErr || !record) {
      console.error("Ledger fetch error", recErr);
      return json({ ok: false, error: "Ledger record not found" }, 404);
    }

    // 2) Load entity
    const { data: entity, error: entErr } = await supabase
      .from("entities")
      .select("id, slug, name")
      .eq("id", record.entity_id)
      .single();

    if (entErr || !entity) {
      console.error("Entity fetch error", entErr);
      return json({ ok: false, error: "Entity not found for record" }, 404);
    }

    // 3) Load envelope so we can merge metadata
    const { data: envelope, error: envErr } = await supabase
      .from("signature_envelopes")
      .select("id, metadata")
      .eq("id", envelope_id)
      .single();

    if (envErr || !envelope) {
      console.error("Envelope fetch error", envErr);
      return json({ ok: false, error: "Envelope not found" }, 404);
    }

    // 4) Build base (unsigned) PDF
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const entityName = entity?.name ?? entity?.slug ?? "Entity";
    const title = record.title ?? "Corporate Resolution";
    const createdAt = record.created_at ?? null;

    const newFramedPage = () => {
      const p = pdfDoc.addPage();
      const startY = addOasisHeader(p, font, fontBold, entityName, title, createdAt);
      addFooter(p, font);
      return { page: p, startY };
    };

    let { page: currPage, startY } = newFramedPage();

    const margin = 50;
    const maxWidth = currPage.getWidth() - margin * 2;
    const lineHeight = 16;

    const bodyText =
      record.body ||
      "No resolution body found. This is a placeholder generated by Oasis Digital Parliament.";

    const out = drawWrappedText(
      pdfDoc,
      bodyText,
      { page: currPage, font, fontBold, margin, maxWidth, startY, lineHeight },
      () => newFramedPage(),
    );

    currPage = out.page;

    if (out.y < 200) {
      const next = newFramedPage();
      currPage = next.page;
    }

    addSignatureBlock(currPage, font, fontBold);

    // 5) Bytes + draft hash (NOT certification)
    const pdfBytes = await pdfDoc.save();
    const pdfU8 = new Uint8Array(pdfBytes);
    const draft_sha256 = await sha256Hex(pdfU8);

    const fileName = `${record.id}.pdf`;

    // ✅ canonical is the source of truth going forward
    const canonicalPath = `${entity.slug}/resolutions/${fileName}`;

    // ✅ legacy path preserved (NO regression)
    const legacyPath = `${entity.slug}/Resolutions/${fileName}`;

    // 6) Upload canonical (idempotent upsert)
    const { error: upCanonErr } = await supabase.storage
      .from(BUCKET)
      .upload(
        canonicalPath,
        new Blob([pdfBytes], { type: "application/pdf" }),
        { upsert: true, contentType: "application/pdf" },
      );

    if (upCanonErr) {
      console.error("Canonical upload failed:", upCanonErr);
      return json({ ok: false, error: "Failed to upload canonical PDF" }, 500);
    }

    // 7) Legacy copy ONLY if missing (prevents permanent duplication churn)
    let legacy_written = false;
    const legacyExists = await objectExists(BUCKET, legacyPath);

    if (!legacyExists) {
      const { error: upLegacyErr } = await supabase.storage
        .from(BUCKET)
        .upload(
          legacyPath,
          new Blob([pdfBytes], { type: "application/pdf" }),
          { upsert: true, contentType: "application/pdf" },
        );

      if (upLegacyErr) {
        console.error("Legacy upload failed (non-fatal):", upLegacyErr);
      } else {
        legacy_written = true;
      }
    }

    // 8) Update envelope pointers + metadata (same envelope — no duplicates)
    const existingMeta = (envelope as any)?.metadata ?? {};
    const newMetadata = {
      ...existingMeta,
      record_id: record.id,
      entity_id: entity.id,
      entity_slug: entity.slug,
      entity_name: entity.name,

      // pointers
      storage_bucket: BUCKET,
      storage_path: canonicalPath,
      legacy_storage_path: legacyPath,

      // draft integrity (NOT "certified")
      draft_pdf_sha256: draft_sha256,
      draft_pdf_generated_at: new Date().toISOString(),
    };

    const { error: envUpdateErr } = await supabase
      .from("signature_envelopes")
      .update({
        supporting_document_path: canonicalPath,
        storage_path: canonicalPath,
        metadata: newMetadata,
      } as any)
      .eq("id", envelope_id);

    if (envUpdateErr) {
      console.error("Envelope update error:", envUpdateErr);
      // Still return success because PDF exists; envelope pointers can be repaired
    }

    return json({
      ok: true,
      record_id: record.id,
      envelope_id,
      storage_bucket: BUCKET,
      storage_path: canonicalPath,
      legacy_storage_path: legacyPath,
      legacy_written,
      draft_sha256,
      entity_slug: entity.slug,
    });
  } catch (e) {
    console.error("Unexpected error in odp-pdf-engine:", e);
    return json({ ok: false, error: "Unexpected server error", details: String(e) }, 500);
  }
});
