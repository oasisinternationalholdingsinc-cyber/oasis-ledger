// supabase/functions/generate-certificate/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { PDFDocument, StandardFonts } from "https://esm.sh/pdf-lib@1.17.1?target=deno";

type ResolveResp = {
  ok: boolean;
  error?: string;
  message?: string;

  ledger_id?: string;
  verified_document_id?: string;
  hash?: string;

  entity?: { id?: string; name?: string; slug?: string };
  ledger?: {
    id?: string;
    title?: string;
    status?: string;
    is_test?: boolean;
    created_at?: string;
  };

  best_pdf?: {
    kind?: string;
    storage_bucket?: string;
    storage_path?: string;
  };

  verified?: {
    file_hash?: string;
    created_at?: string;
    envelope_id?: string | null;
    is_archived?: boolean;
    storage_bucket?: string;
    storage_path?: string;
    verification_level?: string;
  };
};

type ReqBody = {
  hash?: string | null;
  envelope_id?: string | null;
  ledger_id?: string | null;
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Expose-Headers": "content-type, content-disposition, x-sb-request-id",
};

const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

const pad2 = (n: number) => String(n).padStart(2, "0");
const fmtDateUTC = (iso?: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
};
const fmtDateTimeUTC = (iso?: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(
    d.getUTCHours(),
  )}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} UTC`;
};

const safe = (s?: string | null, fallback = "—") => (s && String(s).trim() ? String(s) : fallback);

serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });

  try {
    // Accept either:
    // - GET ?hash=...&envelope_id=...&ledger_id=...
    // - POST { hash, envelope_id, ledger_id }
    const u = new URL(req.url);

    let hash = u.searchParams.get("hash");
    let envelope_id = u.searchParams.get("envelope_id");
    let ledger_id = u.searchParams.get("ledger_id");

    if (req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as ReqBody;
      hash = hash ?? (body.hash ?? null);
      envelope_id = envelope_id ?? (body.envelope_id ?? null);
      ledger_id = ledger_id ?? (body.ledger_id ?? null);
    }

    const h = (hash ?? "").trim().toLowerCase() || null;
    const e = (envelope_id ?? "").trim() || null;
    const l = (ledger_id ?? "").trim() || null;

    if (!h && !e && !l) {
      return json(
        {
          ok: false,
          error: "MISSING_IDENTIFIER",
          message: "Provide hash OR envelope_id OR ledger_id.",
        },
        400,
      );
    }

    // Canonical resolve (single source of truth)
    const { data: resolved, error: rErr } = await supabase.rpc("resolve_verified_record", {
      p_hash: h,
      p_envelope_id: e,
      p_ledger_id: l,
    });

    if (rErr) {
      return json(
        {
          ok: false,
          error: "RESOLVE_FAILED",
          message: rErr.message,
        },
        500,
      );
    }

    const data = resolved as ResolveResp;
    if (!data || data.ok !== true) {
      return json(
        {
          ok: false,
          error: data?.error ?? "NOT_OK",
          message: data?.message ?? "Record could not be resolved.",
        },
        404,
      );
    }

    // Canonical fields (resolver-driven)
    const entityName = safe(data.entity?.name);
    const entitySlug = safe(data.entity?.slug);
    const ledgerTitle = safe(data.ledger?.title, "Resolution");
    const ledgerId = safe(data.ledger_id ?? data.ledger?.id);
    const ledgerStatus = safe(data.ledger?.status);
    const lane = data.ledger?.is_test ? "SANDBOX" : "RoT";

    const issuedAt = fmtDateTimeUTC(new Date().toISOString());
    const verifiedAt = fmtDateTimeUTC(data.verified?.created_at ?? null);

    const verificationLevel = safe(data.verified?.verification_level, "certified").toUpperCase();
    const resolvedHash = safe(data.hash ?? data.verified?.file_hash);

    const verifiedDocumentId = safe(data.verified_document_id);
    const envelopeId = data.verified?.envelope_id ?? null;

    const preferredKind = safe(data.best_pdf?.kind, "best_pdf");
    const evidenceLine =
      preferredKind === "minute_book_signed"
        ? "Evidence Source: Minute Book (signed) — preferred artifact"
        : preferredKind === "minute_book"
          ? "Evidence Source: Minute Book — reader copy"
          : "Evidence Source: Certified Archive — registry copy";

    // Optional signer lookup (only if envelope present)
    let signerLine = "—";
    let signedAtLine = "—";
    if (envelopeId) {
      const { data: party, error: pErr } = await supabase
        .from("signature_parties")
        .select("display_name, email, signed_at")
        .eq("envelope_id", envelopeId)
        .eq("role", "primary_signer")
        .maybeSingle();

      if (!pErr && party) {
        const dn = party.display_name ? String(party.display_name) : "";
        const em = party.email ? String(party.email) : "";
        signerLine = dn && em ? `${dn} <${em}>` : dn || em || "—";
        signedAtLine = fmtDateUTC(party.signed_at ?? null);
      }
    }

    // Build PDF (enterprise-clean, minimal, gold frame)
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595.28, 841.89]); // A4 portrait
    const width = page.getWidth();
    const height = page.getHeight();

    const fontTitle = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontBody = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontMono = await pdfDoc.embedFont(StandardFonts.Courier);

    const gold = [0.85, 0.70, 0.25] as const;
    const white = [1, 1, 1] as const;
    const muted = [0.55, 0.55, 0.60] as const;
    const bg = [0.03, 0.04, 0.07] as const;

    // Outer frame
    page.drawRectangle({
      x: 42,
      y: 42,
      width: width - 84,
      height: height - 84,
      borderWidth: 2,
      borderColor: gold,
      color: bg,
    });

    // Header
    const top1 = "OASIS DIGITAL PARLIAMENT";
    const top2 = "CERTIFICATE OF VERIFICATION";

    const top1Size = 12;
    const top2Size = 18;

    const top1W = fontBody.widthOfTextAtSize(top1, top1Size);
    const top2W = fontTitle.widthOfTextAtSize(top2, top2Size);

    page.drawText(top1, {
      x: (width - top1W) / 2,
      y: height - 92,
      size: top1Size,
      font: fontBody,
      color: muted,
    });

    page.drawText(top2, {
      x: (width - top2W) / 2,
      y: height - 118,
      size: top2Size,
      font: fontTitle,
      color: gold,
    });

    // Divider
    page.drawRectangle({
      x: 70,
      y: height - 135,
      width: width - 140,
      height: 1,
      color: [1, 1, 1],
      opacity: 0.10,
    });

    let y = height - 168;

    const labelSize = 9;
    const valueSize = 11;
    const rowGap = 16;

    const drawKV = (label: string, value: string, mono = false) => {
      page.drawText(label, { x: 76, y, size: labelSize, font: fontBody, color: muted });
      y -= 14;
      page.drawText(value, {
        x: 76,
        y,
        size: valueSize,
        font: mono ? fontMono : fontBody,
        color: white,
        maxWidth: width - 152,
      });
      y -= rowGap;
    };

    drawKV("ENTITY", `${entityName} • ${entitySlug}`);
    drawKV("DOCUMENT", ledgerTitle);
    drawKV("LEDGER ID", ledgerId, true);
    drawKV("LANE", lane);
    drawKV("STATUS", ledgerStatus);

    // Hash block
    y -= 4;
    page.drawText("SHA-256", { x: 76, y, size: labelSize, font: fontBody, color: muted });
    y -= 16;

    const boxX = 72;
    const boxW = width - 144;
    const boxH = 64;

    page.drawRectangle({
      x: boxX,
      y: y - boxH + 10,
      width: boxW,
      height: boxH,
      borderWidth: 1,
      borderColor: [1, 1, 1],
      opacity: 0.10,
      color: [0, 0, 0],
      opacity: 0.18,
    });

    page.drawText(resolvedHash, {
      x: boxX + 12,
      y: y - 16,
      size: 10,
      font: fontMono,
      color: white,
      maxWidth: boxW - 24,
      lineHeight: 12,
    });

    y = y - boxH - 8;

    drawKV("VERIFICATION LEVEL", verificationLevel);
    drawKV("VERIFIED DOCUMENT ID", verifiedDocumentId, true);
    drawKV("VERIFIED AT", verifiedAt);
    drawKV("ISSUED AT", issuedAt);

    if (envelopeId) {
      drawKV("ENVELOPE ID", envelopeId, true);
      drawKV("PRIMARY SIGNER", signerLine);
      drawKV("SIGNED AT", signedAtLine);
    }

    y -= 6;
    page.drawText(evidenceLine, {
      x: 76,
      y,
      size: 9,
      font: fontBody,
      color: muted,
      maxWidth: width - 152,
    });

    // Footer attestation
    const attn =
      "This certificate attests that the referenced record is registered in the Oasis Digital Parliament registry and that the SHA-256 hash above matches the canonical stored value at issuance.";
    page.drawText(attn, {
      x: 76,
      y: 90,
      size: 9,
      font: fontBody,
      color: muted,
      maxWidth: width - 152,
      lineHeight: 12,
    });

    // Small seal ring (minimal)
    page.drawCircle({
      x: width - 120,
      y: 110,
      size: 34,
      borderWidth: 2,
      borderColor: gold,
      color: [0, 0, 0],
      opacity: 0.0,
    });
    page.drawText("ODP.AI", {
      x: width - 140,
      y: 104,
      size: 10,
      font: fontTitle,
      color: gold,
    });

    const pdfBytes = await pdfDoc.save();

    const fileName = `Oasis-Certificate-${ledgerId}.pdf`;

    return new Response(pdfBytes, {
      status: 200,
      headers: {
        ...cors,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${fileName}"`,
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
