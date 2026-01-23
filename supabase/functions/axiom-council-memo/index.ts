import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

type ReqBody = {
  record_id: string; // governance_ledger.id
  memo?: {
    title?: string;
    executive_summary?: string;
    findings?: Array<{
      severity?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
      blocking?: boolean;
      category?: string;
      title: string;
      evidence?: string;
      recommendation?: string;
    }>;
    notes?: string;
  };
};

// ---- CORS ----
const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-requested-with",
  "Access-Control-Max-Age": "86400",
};

function json(resBody: unknown, status = 200) {
  return new Response(JSON.stringify(resBody), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function wrapText(text: string, maxChars: number) {
  const words = (text || "").replace(/\r/g, "").split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length > maxChars) {
      if (line) lines.push(line);
      line = w;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function safeStr(s?: string) {
  return (s ?? "").toString().trim();
}

async function sha256Hex(bytes: Uint8Array) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

    const body = (await req.json()) as ReqBody;
    const record_id = safeStr(body?.record_id);
    if (!record_id) return json({ ok: false, error: "Missing record_id" }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) {
      return json({ ok: false, error: "Missing SUPABASE_URL or SERVICE_ROLE key" }, 500);
    }

    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });

    // ---- Load ledger (lane is SOURCE OF TRUTH) ----
    const { data: ledger, error: ledgerErr } = await supabase
      .from("governance_ledger")
      .select("id,title,entity_id,created_at,status,is_test")
      .eq("id", record_id)
      .single();

    if (ledgerErr || !ledger) {
      return json({ ok: false, error: `Ledger fetch failed: ${ledgerErr?.message ?? "not found"}` }, 400);
    }

    const is_test = !!ledger.is_test;

    const memo = body.memo ?? {
      title: "AXIOM Council Memo",
      executive_summary:
        "No memo payload was provided by the client. This memo was generated as a placeholder attachment.",
      findings: [],
      notes: "",
    };

    // ==== PDF RENDER ====
    const pdf = await PDFDocument.create();
    const fontRegular = await pdf.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

    const page = pdf.addPage([612, 792]);
    const { width, height } = page.getSize();

    const marginX = 48;
    let y = height - 56;

    const drawLine = () => {
      page.drawLine({
        start: { x: marginX, y },
        end: { x: width - marginX, y },
        thickness: 1,
        color: rgb(0.85, 0.85, 0.85),
      });
      y -= 14;
    };

    const drawTextBlock = (label: string, text: string, maxChars = 92) => {
      const val = safeStr(text);
      if (!val) return;

      page.drawText(label, { x: marginX, y, size: 11, font: fontBold });
      y -= 14;

      for (const line of wrapText(val, maxChars)) {
        if (y < 70) throw new Error("Memo too long (pagination not enabled).");
        page.drawText(line, { x: marginX, y, size: 10.5, font: fontRegular });
        y -= 13;
      }
      y -= 6;
    };

    page.drawText(safeStr(memo.title) || "AXIOM Council Memo", {
      x: marginX,
      y,
      size: 18,
      font: fontBold,
    });
    y -= 20;

    page.drawText(`Record: ${ledger.title ?? record_id}`, {
      x: marginX,
      y,
      size: 10.5,
      font: fontRegular,
    });
    y -= 14;

    page.drawText(`Status: ${ledger.status ?? ""}   Lane: ${is_test ? "SANDBOX" : "RoT"}`, {
      x: marginX,
      y,
      size: 10.5,
      font: fontRegular,
    });
    y -= 10;

    drawLine();
    drawTextBlock("Executive summary", memo.executive_summary || "", 98);

    if (memo.findings?.length) {
      page.drawText("Findings", { x: marginX, y, size: 12.5, font: fontBold });
      y -= 16;

      let i = 1;
      for (const f of memo.findings) {
        const hdr =
          `${i}. ${f.severity ? `(${f.severity}) ` : ""}${safeStr(f.title)}` +
          `${f.blocking ? " [BLOCKING]" : ""}` +
          `${f.category ? ` — ${f.category}` : ""}`;

        drawTextBlock(hdr, "", 98);
        drawTextBlock("Evidence", f.evidence || "", 98);
        drawTextBlock("Recommendation", f.recommendation || "", 98);
        y -= 4;
        i++;
      }
    }

    drawTextBlock("Additional notes", memo.notes || "", 98);

    page.drawText(`Generated ${new Date().toISOString()}`, {
      x: marginX,
      y: 32,
      size: 9,
      font: fontRegular,
    });

    const pdfBytes = await pdf.save();
    const pdfU8 = new Uint8Array(pdfBytes);
    const fileHash = await sha256Hex(pdfU8);

    // ==== STORAGE (CANONICAL BUCKETS) ====
    const bucket = is_test ? "governance_sandbox" : "governance_truth";
    const storagePath = `${is_test ? "sandbox" : "rot"}/axiom-memos/${record_id}-${Date.now()}.pdf`;

    const up = await supabase.storage.from(bucket).upload(storagePath, pdfU8, {
      contentType: "application/pdf",
      upsert: false,
    });

    if (up.error) return json({ ok: false, error: up.error.message }, 500);

    let supporting_document_id: string | null = null;
    try {
      const { data } = await supabase
        .from("supporting_documents")
        .insert({
          entity_id: ledger.entity_id,
          record_id,
          storage_bucket: bucket,
          storage_path: storagePath,
          mime_type: "application/pdf",
          file_hash: fileHash,
          document_class: "axiom_memo",
          verification_level: "unverified",
        })
        .select("id")
        .single();

      supporting_document_id = data?.id ?? null;
    } catch {
      // best effort, no regression
    }

    return json({
      ok: true,
      supporting_document_id,
      storage_bucket: bucket,
      storage_path: storagePath,
      file_hash: fileHash,
      file_size: pdfU8.length,
      mime_type: "application/pdf",
    });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
