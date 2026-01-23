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

function safeStr(s?: string) {
  return (s ?? "").toString().trim();
}

// Presentation-only cleanup (keeps logic unchanged; just makes the PDF look court/enterprise)
function cleanForPdf(input?: string) {
  let t = safeStr(input);
  if (!t) return t;

  // strip some common markdown noise without changing meaning
  t = t.replace(/\r/g, "");
  t = t.replace(/```[\s\S]*?```/g, ""); // remove fenced blocks if present
  t = t.replace(/^#{1,6}\s+/gm, ""); // headings
  t = t.replace(/\*\*(.*?)\*\*/g, "$1"); // bold
  t = t.replace(/\*(.*?)\*/g, "$1"); // italic
  t = t.replace(/^\s*[-•]\s+/gm, "• "); // bullets
  t = t.replace(/\n{3,}/g, "\n\n"); // collapse huge gaps
  return t.trim();
}

function wrapTextToWidth(
  text: string,
  maxWidth: number,
  font: any,
  fontSize: number
) {
  const words = (text || "").split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";

  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    const width = font.widthOfTextAtSize(candidate, fontSize);
    if (width > maxWidth) {
      if (line) lines.push(line);
      line = w;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
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
      title: "Council Advisory — AXIOM Evidence-based Analysis",
      executive_summary:
        "No memo payload was provided by the client. This memo was generated as a placeholder attachment.",
      findings: [],
      notes: "",
    };

    // ==== PDF RENDER (layout polish only) ====
    const pdf = await PDFDocument.create();
    const fontRegular = await pdf.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

    const page = pdf.addPage([612, 792]); // US Letter
    const { width, height } = page.getSize();

    // Typographic system (neutral, court-friendly)
    const marginX = 54;
    const topY = height - 56;
    const bodyWidth = width - marginX * 2;

    const cText = rgb(0.08, 0.08, 0.08);
    const cMuted = rgb(0.35, 0.35, 0.35);
    const cRule = rgb(0.82, 0.82, 0.82);
    const cShade = rgb(0.96, 0.96, 0.96);

    const sTitle = 18;
    const sSub = 10.5;
    const sH = 12.5;
    const sLabel = 10.5;
    const sBody = 10.5;
    const lh = 13.5; // line height for body

    let y = topY;

    const requireSpace = (need: number) => {
      if (y < 72 + need) throw new Error("Memo too long (pagination not enabled).");
    };

    const hr = (gapBefore = 10, gapAfter = 12) => {
      y -= gapBefore;
      page.drawLine({
        start: { x: marginX, y },
        end: { x: width - marginX, y },
        thickness: 1,
        color: cRule,
      });
      y -= gapAfter;
    };

    const drawKVPairs = (pairs: Array<[string, string]>) => {
      const colGap = 18;
      const colW = (bodyWidth - colGap) / 2;
      const leftX = marginX;
      const rightX = marginX + colW + colGap;

      let rowY = y;

      for (let i = 0; i < pairs.length; i += 2) {
        requireSpace(18);

        const [k1, v1] = pairs[i] ?? ["", ""];
        const [k2, v2] = pairs[i + 1] ?? ["", ""];

        // subtle row banding (very light)
        page.drawRectangle({
          x: marginX,
          y: rowY - 14,
          width: bodyWidth,
          height: 18,
          color: i % 4 === 0 ? cShade : rgb(1, 1, 1),
        });

        page.drawText(`${k1}:`, { x: leftX, y: rowY, size: 9.5, font: fontBold, color: cMuted });
        page.drawText(v1, { x: leftX + 54, y: rowY, size: 9.5, font: fontRegular, color: cText });

        if (k2) {
          page.drawText(`${k2}:`, { x: rightX, y: rowY, size: 9.5, font: fontBold, color: cMuted });
          page.drawText(v2, { x: rightX + 54, y: rowY, size: 9.5, font: fontRegular, color: cText });
        }

        rowY -= 20;
      }

      y = rowY + 2;
    };

    const heading = (text: string) => {
      requireSpace(22);
      page.drawText(text, { x: marginX, y, size: sH, font: fontBold, color: cText });
      y -= 10;
      page.drawLine({
        start: { x: marginX, y },
        end: { x: width - marginX, y },
        thickness: 1,
        color: cRule,
      });
      y -= 14;
    };

    const paragraph = (text: string) => {
      const val = cleanForPdf(text);
      if (!val) return;
      const lines = wrapTextToWidth(val, bodyWidth, fontRegular, sBody);
      for (const line of lines) {
        requireSpace(lh + 2);
        page.drawText(line, { x: marginX, y, size: sBody, font: fontRegular, color: cText });
        y -= lh;
      }
      y -= 6;
    };

    const labelBlock = (label: string, text: string) => {
      const val = cleanForPdf(text);
      if (!val) return;
      requireSpace(18);
      page.drawText(label, { x: marginX, y, size: sLabel, font: fontBold, color: cText });
      y -= 14;
      paragraph(val);
    };

    // ---- Title ----
    const title = safeStr(memo.title) || "Council Advisory — AXIOM Evidence-based Analysis";
    page.drawText(title, { x: marginX, y, size: sTitle, font: fontBold, color: cText });
    y -= 24;

    // ---- Metadata block ----
    const recordTitle = safeStr(ledger.title) || record_id;
    const laneLabel = is_test ? "SANDBOX" : "RoT";
    const statusLabel = safeStr(ledger.status) || "—";

    drawKVPairs([
      ["Record", recordTitle],
      ["Record ID", record_id],
      ["Status", statusLabel],
      ["Lane", laneLabel],
    ]);

    // Disclaimer (small, muted)
    requireSpace(20);
    page.drawText(
      "Advisory only. Evidence-based analysis to support Council review; not an approval or decision.",
      { x: marginX, y, size: 9.5, font: fontRegular, color: cMuted }
    );
    y -= 12;

    hr(10, 14);

    // ---- Sections ----
    heading("Executive Summary");
    paragraph(memo.executive_summary || "");

    const findings = memo.findings ?? [];
    if (findings.length) {
      heading("Risk & Clarity Assessment");

      let i = 1;
      for (const f of findings) {
        const sev = f.severity ? `${f.severity}` : "";
        const blk = f.blocking ? " • BLOCKING" : "";
        const cat = f.category ? ` • ${safeStr(f.category)}` : "";

        const header = `${i}. ${safeStr(f.title)}${sev ? ` (${sev})` : ""}${blk}${cat}`;
        requireSpace(20);
        page.drawText(header, { x: marginX, y, size: 10.75, font: fontBold, color: cText });
        y -= 14;

        if (safeStr(f.evidence)) labelBlock("Evidence", f.evidence || "");
        if (safeStr(f.recommendation)) labelBlock("Recommendation", f.recommendation || "");

        // item divider
        hr(6, 10);
        i++;
      }
    }

    if (safeStr(memo.notes)) {
      heading("Additional Notes");
      paragraph(memo.notes || "");
    }

    // ---- Footer ----
    const generatedAt = new Date().toISOString();
    const footerY = 34;

    page.drawLine({
      start: { x: marginX, y: footerY + 18 },
      end: { x: width - marginX, y: footerY + 18 },
      thickness: 1,
      color: cRule,
    });

    page.drawText(`Generated: ${generatedAt}`, {
      x: marginX,
      y: footerY,
      size: 9,
      font: fontRegular,
      color: cMuted,
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
