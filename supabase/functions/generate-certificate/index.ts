// supabase/functions/generate-certificate/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  PDFDocument,
  StandardFonts,
} from "https://esm.sh/pdf-lib@1.17.1?target=deno";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
    },
  });
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "N/A";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "N/A";
  return d.toISOString().split("T")[0];
}

serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });

  try {
    const url = new URL(req.url);
    const hashParam = url.searchParams.get("hash");

    if (!hashParam) {
      return json(
        {
          ok: false,
          error: "MISSING_HASH",
          message: "Expected ?hash=<sha256> in query string.",
        },
        400,
      );
    }

    const requestedHash = hashParam.toLowerCase();

    // basic metadata lookup (no need to recompute hash here; verify-certificate already does that)
    const { data: verifiedDoc, error: vdError } = await supabase
      .from("verified_documents")
      .select("*")
      .eq("file_hash", requestedHash)
      .eq("is_archived", false)
      .maybeSingle();

    if (vdError) {
      console.error("verified_documents query error", vdError);
      return json(
        {
          ok: false,
          error: "VERIFIED_DOCUMENTS_QUERY_FAILED",
          message: vdError.message,
        },
        500,
      );
    }

    if (!verifiedDoc) {
      return json(
        {
          ok: false,
          error: "NOT_REGISTERED",
          message: "No verified document found for this hash.",
        },
        404,
      );
    }

    // entity name
    let entityName = verifiedDoc.entity_slug ?? "Oasis International Holdings Inc.";
    if (verifiedDoc.entity_id) {
      const { data: entity, error: entError } = await supabase
        .from("entities")
        .select("name")
        .eq("id", verifiedDoc.entity_id)
        .maybeSingle();

      if (!entError && entity?.name) {
        entityName = entity.name;
      }
    }

    // signer info (optional)
    let signerName = "Primary Signer";
    let signerEmail = "";
    let signedAt = verifiedDoc.signed_at ?? null;

    if (verifiedDoc.envelope_id) {
      const { data: party, error: partyError } = await supabase
        .from("signature_parties")
        .select("display_name, email, signed_at")
        .eq("envelope_id", verifiedDoc.envelope_id)
        .eq("role", "primary_signer")
        .maybeSingle();

      if (!partyError && party) {
        signerName = party.display_name ?? signerName;
        signerEmail = party.email ?? "";
        signedAt = signedAt ?? party.signed_at ?? null;
      }
    }

    // create PDF
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595.28, 841.89]); // A4
    const width = page.getWidth();
    const height = page.getHeight();

    const titleFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const bodyFont = await pdfDoc.embedFont(StandardFonts.Helvetica);

    const gold = [0.85, 0.70, 0.25] as const;
    const white = [1, 1, 1] as const;
    const grey = [0.4, 0.4, 0.45] as const;

    // background frame
    page.drawRectangle({
      x: 40,
      y: 40,
      width: width - 80,
      height: height - 80,
      borderWidth: 2,
      borderColor: gold,
      color: [0.03, 0.03, 0.07],
    });

    // header
    const headerText = "Oasis Digital Parliament";
    const headerSize = 18;
    const headerWidth = titleFont.widthOfTextAtSize(headerText, headerSize);
    page.drawText(headerText, {
      x: (width - headerWidth) / 2,
      y: height - 80,
      size: headerSize,
      font: titleFont,
      color: gold,
    });

    // subheader
    const subText = "Certificate of Ledger Verification";
    const subSize = 14;
    const subWidth = bodyFont.widthOfTextAtSize(subText, subSize);
    page.drawText(subText, {
      x: (width - subWidth) / 2,
      y: height - 110,
      size: subSize,
      font: bodyFont,
      color: white,
    });

    let cursorY = height - 150;
    const lineHeight = 18;

    function drawLabelValue(label: string, value: string) {
      const labelSize = 10;
      const valueSize = 11;
      page.drawText(label, {
        x: 70,
        y: cursorY,
        size: labelSize,
        font: bodyFont,
        color: grey,
      });
      cursorY -= lineHeight;
      page.drawText(value, {
        x: 70,
        y: cursorY,
        size: valueSize,
        font: bodyFont,
        color: white,
      });
      cursorY -= lineHeight * 1.3;
    }

    drawLabelValue("ENTITY", entityName);
    drawLabelValue("DOCUMENT TITLE", verifiedDoc.title ?? "Resolution");
    drawLabelValue("DOCUMENT CLASS", verifiedDoc.document_class ?? "resolution");
    drawLabelValue("SIGNER", signerEmail ? `${signerName} <${signerEmail}>` : signerName);
    drawLabelValue("SIGNED AT", formatDate(signedAt as string | null));
    drawLabelValue("LEDGER HASH (SHA-256)", requestedHash);
    drawLabelValue("VERIFICATION LEVEL", verifiedDoc.verification_level ?? "signed_verified");

    cursorY -= 10;
    const footer = "This certificate confirms that the associated PDF is registered in the Oasis Digital Parliament ledger and its SHA-256 hash matches the stored record.";
    page.drawText(footer, {
      x: 70,
      y: cursorY,
      size: 9,
      font: bodyFont,
      color: grey,
      maxWidth: width - 140,
      lineHeight: 12,
    });

    const pdfBytes = await pdfDoc.save();

    return new Response(pdfBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition":
          'attachment; filename="Oasis-Ledger-Certificate.pdf"',
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    console.error("generate-certificate fatal error", err);
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
