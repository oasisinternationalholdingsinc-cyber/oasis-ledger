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

// simple word-wrap helper for pdf-lib
function drawWrappedText(
  text: string,
  opts: DrawOptions,
): { page: any; y: number } {
  let { page, font, margin, maxWidth, startY, lineHeight } = opts;
  let y = startY;

  const paragraphs = text.split(/\n\s*\n/);

  for (const para of paragraphs) {
    const words = para.split(/\s+/);
    let line = "";

    for (const word of words) {
      const testLine = line ? `${line} ${word}` : word;
      const width = font.widthOfTextAtSize(testLine, 11);

      if (width > maxWidth) {
        page.drawText(line, {
          x: margin,
          y,
          size: 11,
          font,
          color: rgb(0.16, 0.18, 0.22),
        });
        y -= lineHeight;
        line = word;
      } else {
        line = testLine;
      }
    }

    if (line) {
      page.drawText(line, {
        x: margin,
        y,
        size: 11,
        font,
        color: rgb(0.16, 0.18, 0.22),
      });
      y -= lineHeight;
    }

    // small gap between paragraphs
    y -= lineHeight * 0.3;
  }

  return { page, y };
}

async function addOasisHeader(
  pdfDoc: PDFDocument,
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
  const headerHeight = 70;

  const accent = rgb(0.11, 0.77, 0.55); // emerald
  const textMuted = rgb(0.7, 0.75, 0.82);
  const textSoft = rgb(0.8, 0.84, 0.9);

  // dark header band
  page.drawRectangle({
    x: 0,
    y: height - headerHeight,
    width,
    height: headerHeight,
    color: rgb(0.04, 0.08, 0.12),
  });

  // left header
  page.drawText("Oasis Digital Parliament", {
    x: margin,
    y: height - headerHeight + 32,
    size: 16,
    font: fontBold,
    color: accent,
  });

  page.drawText(entityName, {
    x: margin,
    y: height - headerHeight + 14,
    size: 10,
    font,
    color: textSoft,
  });

  // right meta pill
  const pillText = "Resolution · Generated via CI-Alchemy / CI-Forge";
  const pillWidth = font.widthOfTextAtSize(pillText, 9) + 24;
  const pillHeight = 22;
  const pillX = width - margin - pillWidth;
  const pillY = height - headerHeight + 28;

  page.drawRectangle({
    x: pillX,
    y: pillY,
    width: pillWidth,
    height: pillHeight,
    color: rgb(0.07, 0.11, 0.18),
  });

  page.drawText(pillText, {
    x: pillX + 12,
    y: pillY + 7,
    size: 9,
    font,
    color: textMuted,
  });

  // tiny date under pill
  const dateText = createdAt
    ? `Created: ${new Date(createdAt).toISOString().slice(0, 10)}`
    : "";
  if (dateText) {
    const dateWidth = font.widthOfTextAtSize(dateText, 8);
    page.drawText(dateText, {
      x: width - margin - dateWidth,
      y: height - headerHeight + 10,
      size: 8,
      font,
      color: textMuted,
    });
  }

  // title block under header
  let y = height - headerHeight - 40;

  const titleWidth = fontBold.widthOfTextAtSize(title, 15);
  const titleX = Math.max(margin, (width - titleWidth) / 2);

  page.drawText(title, {
    x: titleX,
    y,
    size: 15,
    font: fontBold,
    color: rgb(0.96, 0.8, 0.3), // gold
  });

  y -= 26;

  page.drawText("Corporate Resolution", {
    x: titleX,
    y,
    size: 10,
    font,
    color: rgb(0.5, 0.55, 0.6),
  });

  return y - 30; // starting Y for body
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

    // 4) Build Oasis OS–styled PDF
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const margin = 50;
    const width = page.getWidth();
    const maxWidth = width - margin * 2;
    const lineHeight = 16;

    const entityName = entity.name ?? "Oasis International Holdings Inc.";
    const title = record.title ?? "Corporate Resolution";
    const createdAt = record.created_at ?? null;

    let bodyStartY = await addOasisHeader(
      pdfDoc,
      page,
      font,
      fontBold,
      entityName,
      title,
      createdAt,
    );

    const bodyText =
      record.body ||
      "No resolution body found. This is a placeholder generated by Oasis Digital Parliament.";

    const { y: afterBodyY } = drawWrappedText(bodyText, {
      page,
      font,
      fontBold,
      margin,
      maxWidth,
      startY: bodyStartY,
      lineHeight,
    });

    let y = afterBodyY - 24;

    // simple signature block
    if (y < 120) {
      const sigPage = pdfDoc.addPage();
      y = await addOasisHeader(
        pdfDoc,
        sigPage,
        font,
        fontBold,
        entityName,
        title,
        createdAt,
      );
      y -= 40;
    }

    page.drawText("Authorized Signatory", {
      x: margin,
      y,
      size: 10,
      font: fontBold,
      color: rgb(0.16, 0.18, 0.22),
    });
    y -= 18;

    page.drawLine({
      start: { x: margin, y },
      end: { x: margin + 260, y },
      thickness: 0.8,
      color: rgb(0.25, 0.28, 0.32),
    });
    y -= 12;

    page.drawText("Name / Title", {
      x: margin,
      y,
      size: 9,
      font,
      color: rgb(0.45, 0.48, 0.55),
    });

    // footer
    page.drawText(
      "Generated by Oasis Digital Parliament – CI-Alchemy / CI-Forge",
      {
        x: margin,
        y: 40,
        size: 8,
        font,
        color: rgb(0.5, 0.55, 0.6),
      },
    );

    // 5) Save + upload base PDF
    const pdfBytes = await pdfDoc.save();
    const fileName = `${record.id}.pdf`;
    const storagePath = `${entity.slug}/Resolutions/${fileName}`;

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
