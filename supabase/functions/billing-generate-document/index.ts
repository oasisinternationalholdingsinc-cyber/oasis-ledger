import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";

// -----------------------------
// Env
// -----------------------------
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing Supabase env");
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

// -----------------------------
// Types
// -----------------------------
type ReqBody = {
  entity_id: string;
  is_test: boolean;

  document_type: "invoice" | "receipt" | "credit_note";
  document_number?: string;

  currency?: "USD" | "CAD";
  period_start?: string;
  period_end?: string;

  subtotal_amount?: number;
  tax_amount?: number;
  total_amount?: number;

  line_items?: Array<{
    description: string;
    quantity?: number;
    unit_price?: number;
    amount?: number;
  }>;

  metadata?: Record<string, unknown>;
};

type Resp =
  | { ok: true; document_id: string; file_hash: string }
  | { ok: false; error: string };

// -----------------------------
// Helpers
// -----------------------------
function sha256Hex(bytes: Uint8Array): string {
  return crypto
    .subtle
    .digestSync("SHA-256", bytes)
    .reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
}

async function generatePdf(body: ReqBody): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  let y = 740;
  const draw = (text: string, size = 10) => {
    page.drawText(text, {
      x: 50,
      y,
      size,
      font,
      color: rgb(0.95, 0.95, 0.95),
    });
    y -= size + 6;
  };

  draw("OASIS DIGITAL PARLIAMENT", 14);
  draw("Billing Document", 12);
  y -= 10;

  draw(`Type: ${body.document_type.toUpperCase()}`);
  if (body.document_number) draw(`Document #: ${body.document_number}`);
  draw(`Entity ID: ${body.entity_id}`);
  draw(`Lane: ${body.is_test ? "SANDBOX" : "RoT"}`);
  draw(`Issued: ${new Date().toISOString()}`);

  y -= 12;

  draw(`Currency: ${body.currency ?? "USD"}`);
  if (body.subtotal_amount != null)
    draw(`Subtotal: ${body.subtotal_amount.toFixed(2)}`);
  if (body.tax_amount != null)
    draw(`Tax: ${body.tax_amount.toFixed(2)}`);
  if (body.total_amount != null)
    draw(`Total: ${body.total_amount.toFixed(2)}`);

  y -= 14;
  draw("Line Items:", 11);

  for (const item of body.line_items ?? []) {
    draw(
      `• ${item.description} — ${
        item.amount?.toFixed(2) ??
        (item.quantity && item.unit_price
          ? (item.quantity * item.unit_price).toFixed(2)
          : "—")
      }`
    );
  }

  y -= 20;
  draw("This document is registry-issued and verifiable.", 9);

  return await pdf.save();
}

// -----------------------------
// Handler
// -----------------------------
serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body: ReqBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.entity_id || body.is_test === undefined || !body.document_type) {
    return Response.json(
      { ok: false, error: "Missing required fields" },
      { status: 400 }
    );
  }

  try {
    // 1) Generate PDF
    const pdfBytes = await generatePdf(body);

    // 2) Hash
    const fileHash = sha256Hex(pdfBytes);

    // 3) Storage path (deterministic, registry-safe)
    const path = `billing/${body.entity_id}/${body.is_test ? "sandbox" : "rot"}/${fileHash}.pdf`;

    // 4) Upload
    const { error: uploadError } = await supabase.storage
      .from("minute_book")
      .upload(path, pdfBytes, {
        contentType: "application/pdf",
        upsert: false,
      });

    if (uploadError) throw uploadError;

    // 5) Insert registry row
    const { data, error } = await supabase
      .from("billing_documents")
      .insert({
        entity_id: body.entity_id,
        is_test: body.is_test,

        document_type: body.document_type,
        status: "issued",
        document_number: body.document_number ?? null,

        currency: body.currency ?? "USD",
        period_start: body.period_start ?? null,
        period_end: body.period_end ?? null,

        subtotal_amount: body.subtotal_amount ?? null,
        tax_amount: body.tax_amount ?? null,
        total_amount: body.total_amount ?? null,

        line_items: body.line_items ?? [],
        metadata: body.metadata ?? {},

        storage_bucket: "minute_book",
        storage_path: path,
        file_hash: fileHash,
        content_type: "application/pdf",
        file_size_bytes: pdfBytes.byteLength,
      })
      .select("id")
      .single();

    if (error) throw error;

    return Response.json({
      ok: true,
      document_id: data.id,
      file_hash: fileHash,
    });
  } catch (err) {
    return Response.json(
      { ok: false, error: String(err?.message ?? err) },
      { status: 500 }
    );
  }
});
