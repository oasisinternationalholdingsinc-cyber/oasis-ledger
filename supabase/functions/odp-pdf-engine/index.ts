// supabase/functions/odp-pdf-engine/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  PDFDocument,
  StandardFonts,
  rgb,
} from "https://esm.sh/pdf-lib@1.17.1";

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
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
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

// Word-wrap helper for pdf-lib with basic page-break support.
// IMPORTANT: returns updated page + y so caller can continue drawing.
function drawWrappedText(
  pdfDoc: PDFDocument,
  text: string,
  opts: DrawOptions,
  addPageFn: () => { page: any; startY: number },
): { page: any; y: number } {
  let { page, font, margin, maxWidth, startY, lineHeight } = opts;
  let y = startY;

  const safeBottom = 92; // keep clear of footer/signature zones
  const paragraphs = String(text ?? "").split(/\n\s*\n/);

  for (const para of paragraphs) {
    // Preserve intentional blank lines lightly
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
        // flush current line
        flushLine();

        // page break if needed
        if (y < safeBottom) {
          const next = addPageFn();
          page = next.page;
          y = next.startY;
        }

        // start new line with word
        line = word;
      } else {
        line = testLine;
      }

      // page break guard (if we are at bottom mid-paragraph)
      if (y < safeBottom) {
        flushLine();
        const next = addPageFn();
        page = next.page;
        y = next.startY;
      }
    }

    // flush any remaining line
    flushLine();

    // paragraph spacing
    y -= lineHeight * 0.35;

    // page break guard after paragraph gap
    if (y < safeBottom) {
      const next = addPageFn();
      page = next.page;
      y = next.startY;
    }
  }

  return { page, y };
}

// Enterprise header: clean, minimal, print-safe (no heavy bands).
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

  // top rule + brand
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

  // right meta: date
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

  // divider line
  page.drawLine({
    start: { x: margin, y: height - 80 },
    end: { x: width - margin, y: height - 80 },
    thickness: 0.6,
    color: rgb(0.82, 0.84, 0.88),
  });

  // Title block (centered but restrained)
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

  // return body start Y
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

// ---------------------------------------------------------------------------
// HANDLER
// ---------------------------------------------------------------------------
serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
      },
    });
  }

  if (req.method !== "POST") {
    return json({ ok: false, error: "Use POST" }, 405);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const { record_id, envelope_id } = body ?? {};
  if (!record_id || !envelope_id) {
    return json(
      { ok: false, error: "record_id and envelope_id are required" },
      400,
    );
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
      return json(
        { ok: false, error: "Ledger record not found", details: recErr },
        404,
      );
    }

    // 2) Load entity
    const { data: entity, error: entErr } = await supabase
      .from("entities")
      .select("id, slug, name")
      .eq("id", record.entity_id)
      .single();

    if (entErr || !entity) {
      console.error("Entity fetch error", entErr);
      return json(
        { ok: false, error: "Entity not found for record", details: entErr },
        404,
      );
    }

    // 3) Load envelope so we can merge metadata
    const { data: envelope, error: envErr } = await supabase
      .from("signature_envelopes")
      .select("id, metadata")
      .eq("id", envelope_id)
      .single();

    if (envErr || !envelope) {
      console.error("Envelope fetch error", envErr);
      return json(
        { ok: false, error: "Envelope not found", details: envErr },
        404,
      );
    }

    // 4) Build enterprise, print-safe PDF (no layout overlap, correct pagination)
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const entityName = entity?.name ?? entity?.slug ?? "Entity";
    const title = record.title ?? "Corporate Resolution";
    const createdAt = record.created_at ?? null;

    // helper to create a fully framed page (header+footer) and return body start Y
    const newFramedPage = () => {
      const p = pdfDoc.addPage(); // default size (letter-ish) – consistent with your current behavior
      const startY = addOasisHeader(p, font, fontBold, entityName, title, createdAt);
      addFooter(p, font);
      return { page: p, startY };
    };

    // First page
    let { page: currPage, startY } = newFramedPage();

    const margin = 50;
    const maxWidth = currPage.getWidth() - margin * 2;
    const lineHeight = 16;

    const bodyText =
      record.body ||
      "No resolution body found. This is a placeholder generated by Oasis Digital Parliament.";

    // Draw body with page breaks
    const out = drawWrappedText(
      pdfDoc,
      bodyText,
      {
        page: currPage,
        font,
        fontBold,
        margin,
        maxWidth,
        startY,
        lineHeight,
      },
      () => newFramedPage(),
    );

    currPage = out.page;

    // Always place signature block on a clean final page if we're too low.
    // (enterprise: never crowd signatures into the last lines of body)
    const yAfter = out.y;
    const needSigPage = yAfter < 200;

    if (needSigPage) {
      const next = newFramedPage();
      currPage = next.page;
    }

    addSignatureBlock(currPage, font, fontBold);

    // 5) Save + upload base PDF
    const pdfBytes = await pdfDoc.save();
    const fileName = `${record.id}.pdf`;
    const storagePath = `${entity.slug}/Resolutions/${fileName}`; // KEEP EXACT PATH (no wiring change)

    const { error: uploadErr } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, new Blob([pdfBytes], { type: "application/pdf" }), {
        upsert: true,
      });

    if (uploadErr) {
      console.error("Error uploading base Forge PDF:", uploadErr);
      return json(
        {
          ok: false,
          error: "Failed to upload base resolution PDF",
          details: uploadErr,
        },
        500,
      );
    }

    // 6) Attach path onto envelope (so complete-signature can use it)
    const existingMeta = envelope.metadata ?? {};
    const newMetadata = {
      ...existingMeta,
      record_id: record.id,
      entity_id: entity.id,
      entity_slug: entity.slug,
      entity_name: entity.name,
      storage_path: storagePath,
    };

    const { error: envUpdateErr } = await supabase
      .from("signature_envelopes")
      .update({
        supporting_document_path: storagePath,
        storage_path: storagePath,
        metadata: newMetadata,
      })
      .eq("id", envelope_id);

    if (envUpdateErr) {
      console.error("Envelope update error (attach storage_path)", envUpdateErr);
      // non-fatal, but report it
    }

    return json({
      ok: true,
      record_id: record.id,
      envelope_id,
      storage_bucket: BUCKET,
      storage_path: storagePath,
      entity_slug: entity.slug,
    });
  } catch (e) {
    console.error("Unexpected error in odp-pdf-engine", e);
    return json(
      { ok: false, error: "Unexpected server error", details: String(e) },
      500,
    );
  }
});
