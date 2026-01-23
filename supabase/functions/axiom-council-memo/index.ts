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

function safeStr(s: unknown) {
  return String(s ?? "").trim();
}

function wrapText(text: string, maxChars: number) {
  const words = safeStr(text).replace(/\r/g, "").split(/\s+/).filter(Boolean);
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

async function sha256Hex(bytes: Uint8Array) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

    const body = (await req.json().catch(() => ({}))) as ReqBody;
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

    // ---- Memo payload (NEVER ALLOW BLANK DOCS) ----
    const inputMemo = body.memo ?? {};
    const memoTitle = safeStr(inputMemo.title) || "Council Advisory — Evidence-based Analysis";
    const execSummary =
      safeStr(inputMemo.executive_summary) ||
      "No executive summary was provided. (This memo was generated without structured content from the client.)";

    const findings = Array.isArray(inputMemo.findings) ? inputMemo.findings : [];
    const notes =
      safeStr(inputMemo.notes) || "No additional notes were provided.";

    // ==== PDF RENDER (enterprise spacing) ====
    const pdf = await PDFDocument.create();
    const fontRegular = await pdf.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

    const page = pdf.addPage([612, 792]); // Letter
    const { width, height } = page.getSize();

    const marginX = 56; // tighter + more “court” margin
    const rightX = width - marginX;
    let y = height - 64;

    const line = (gap = 14) => {
      page.drawLine({
        start: { x: marginX, y },
        end: { x: rightX, y },
        thickness: 1,
        color: rgb(0.86, 0.86, 0.86),
      });
      y -= gap;
    };

    const h1 = (text: string) => {
      page.drawText(text, { x: marginX, y, size: 18, font: fontBold, color: rgb(0.05, 0.05, 0.05) });
      y -= 22;
    };

    const h2 = (text: string) => {
      page.drawText(text, { x: marginX, y, size: 12.5, font: fontBold, color: rgb(0.08, 0.08, 0.08) });
      y -= 16;
    };

    const metaRow = (label: string, value: string, x: number, y0: number) => {
      page.drawText(label, { x, y: y0, size: 9.5, font: fontBold, color: rgb(0.25, 0.25, 0.25) });
      page.drawText(value, { x: x + 64, y: y0, size: 9.5, font: fontRegular, color: rgb(0.25, 0.25, 0.25) });
    };

    const para = (text: string, maxChars = 98) => {
      for (const l of wrapText(text, maxChars)) {
        if (y < 84) throw new Error("Memo too long (pagination not enabled).");
        page.drawText(l, { x: marginX, y, size: 10.5, font: fontRegular, color: rgb(0.12, 0.12, 0.12) });
        y -= 13;
      }
      y -= 6;
    };

    const small = (text: string) => {
      for (const l of wrapText(text, 110)) {
        page.drawText(l, { x: marginX, y, size: 9, font: fontRegular, color: rgb(0.35, 0.35, 0.35) });
        y -= 11;
      }
      y -= 4;
    };

    // Header
    h1(`${memoTitle} — holdings`);

    const yMeta = y;
    metaRow("Record:", safeStr(ledger.title) || record_id, marginX, yMeta);
    metaRow("Record ID:", record_id, marginX + 300, yMeta);
    y -= 16;
    metaRow("Status:", safeStr(ledger.status) || "—", marginX, y);
    metaRow("Lane:", is_test ? "SANDBOX" : "RoT", marginX + 300, y);
    y -= 18;

    small("Advisory only. Evidence-based analysis to support Council review; not an approval or decision.");
    line(16);

    // Sections
    h2("Executive Summary");
    para(execSummary, 98);
    line(12);

    h2("Findings");
    if (!findings.length) {
      para("No structured findings were provided.", 98);
    } else {
      let i = 1;
      for (const f of findings) {
        const sev = f.severity ? `(${f.severity}) ` : "";
        const blk = f.blocking ? " [BLOCKING]" : "";
        const cat = f.category ? ` — ${safeStr(f.category)}` : "";
        const title = `${i}. ${sev}${safeStr(f.title)}${blk}${cat}`;

        page.drawText(title, { x: marginX, y, size: 10.8, font: fontBold, color: rgb(0.1, 0.1, 0.1) });
        y -= 14;

        if (safeStr(f.evidence)) {
          page.drawText("Evidence:", { x: marginX, y, size: 9.5, font: fontBold, color: rgb(0.25, 0.25, 0.25) });
          y -= 12;
          para(safeStr(f.evidence), 100);
        }

        if (safeStr(f.recommendation)) {
          page.drawText("Recommendation:", { x: marginX, y, size: 9.5, font: fontBold, color: rgb(0.25, 0.25, 0.25) });
          y -= 12;
          para(safeStr(f.recommendation), 100);
        }

        y -= 2;
        i++;
      }
    }

    line(12);
    h2("Additional Notes");
    para(notes, 98);

    // Footer
    page.drawLine({
      start: { x: marginX, y: 56 },
      end: { x: rightX, y: 56 },
      thickness: 1,
      color: rgb(0.9, 0.9, 0.9),
    });

    page.drawText(`Generated: ${new Date().toISOString()}`, {
      x: marginX,
      y: 38,
      size: 9,
      font: fontRegular,
      color: rgb(0.45, 0.45, 0.45),
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

    // Insert supporting_documents (best effort)
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
      // best effort only
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
