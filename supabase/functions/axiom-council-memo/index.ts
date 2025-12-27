import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

type ReqBody = {
  record_id: string;   // governance_ledger.id
  is_test?: boolean;   // lane flag
  memo: {
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

function json(resBody: unknown, status = 200) {
  return new Response(JSON.stringify(resBody), {
    status,
    headers: { "Content-Type": "application/json" },
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
    if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

    const url = new URL(req.url);
    const body = (await req.json()) as ReqBody;

    const record_id = safeStr(body?.record_id);
    if (!record_id) return json({ ok: false, error: "Missing record_id" }, 400);
    if (!body?.memo) return json({ ok: false, error: "Missing memo" }, 400);

    const is_test = !!body.is_test;

    // Service role for storage + DB writes
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });

    // Pull minimal ledger info for header context (optional but nice)
    const { data: ledger, error: ledgerErr } = await supabase
      .from("governance_ledger")
      .select("id,title,entity_id,created_at,status")
      .eq("id", record_id)
      .single();

    if (ledgerErr) {
      return json({ ok: false, error: `Ledger fetch failed: ${ledgerErr.message}` }, 400);
    }

    // ==== PDF RENDER (NO CUSTOM FONTS) ====
    const pdf = await PDFDocument.create();
    const fontRegular = await pdf.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

    const page = pdf.addPage([612, 792]); // US Letter
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
      const lbl = safeStr(label);
      const val = safeStr(text);
      if (!val) return;

      page.drawText(lbl, { x: marginX, y, size: 11, font: fontBold, color: rgb(0.1, 0.1, 0.1) });
      y -= 14;

      const lines = wrapText(val, maxChars);
      for (const line of lines) {
        if (y < 70) {
          // new page
          const p = pdf.addPage([612, 792]);
          y = 792 - 56;
          // rebind page var? easiest: throw for now or keep simple:
          // For enterprise stability, keep memo short or add multipage support later.
          // We'll just draw on the first page for now.
          // (If you want multipage now, I’ll send the fully paginated version.)
          throw new Error("Memo too long (pagination not enabled in this minimal version).");
        }
        page.drawText(line, { x: marginX, y, size: 10.5, font: fontRegular, color: rgb(0.15, 0.15, 0.15) });
        y -= 13;
      }
      y -= 6;
    };

    // Header
    const topTitle = safeStr(body.memo.title) || "AXIOM Council Memo";
    page.drawText(topTitle, { x: marginX, y, size: 18, font: fontBold, color: rgb(0.05, 0.05, 0.05) });
    y -= 20;

    page.drawText(`Record: ${ledger.title ?? record_id}`, {
      x: marginX,
      y,
      size: 10.5,
      font: fontRegular,
      color: rgb(0.25, 0.25, 0.25),
    });
    y -= 14;

    page.drawText(`Status: ${ledger.status ?? ""}   Lane: ${is_test ? "SANDBOX" : "RoT"}`, {
      x: marginX,
      y,
      size: 10.5,
      font: fontRegular,
      color: rgb(0.25, 0.25, 0.25),
    });
    y -= 10;

    drawLine();

    // Sections
    drawTextBlock("Executive summary", body.memo.executive_summary || "", 98);

    const findings = body.memo.findings ?? [];
    if (findings.length) {
      page.drawText("Findings", { x: marginX, y, size: 12.5, font: fontBold, color: rgb(0.1, 0.1, 0.1) });
      y -= 16;

      let i = 1;
      for (const f of findings) {
        const sev = f.severity ? `(${f.severity}) ` : "";
        const blk = f.blocking ? " [BLOCKING]" : "";
        const cat = f.category ? ` — ${f.category}` : "";
        drawTextBlock(`${i}. ${sev}${safeStr(f.title)}${blk}${cat}`, "", 98);
        drawTextBlock("Evidence", f.evidence || "", 98);
        drawTextBlock("Recommendation", f.recommendation || "", 98);
        y -= 4;
        i += 1;
      }
    }

    drawTextBlock("Additional notes", body.memo.notes || "", 98);

    // Footer
    page.drawText(`Generated ${new Date().toISOString()}`, {
      x: marginX,
      y: 32,
      size: 9,
      font: fontRegular,
      color: rgb(0.4, 0.4, 0.4),
    });

    const pdfBytes = await pdf.save();
    const pdfU8 = new Uint8Array(pdfBytes);
    const fileHash = await sha256Hex(pdfU8);

    // ==== STORAGE + SUPPORTING DOC REGISTRATION ====
    // Pick your existing bucket convention (keep it simple & lane-safe)
    const bucket = is_test ? "governance_sandbox" : "governance";
    const storagePath = `${is_test ? "sandbox" : "rot"}/axiom-memos/${record_id}-${Date.now()}.pdf`;

    const up = await supabase.storage.from(bucket).upload(storagePath, pdfU8, {
      contentType: "application/pdf",
      upsert: false,
    });

    if (up.error) {
      return json({ ok: false, error: `Upload failed: ${up.error.message}` }, 500);
    }

    // If you already have a supporting_documents pattern: insert a row.
    // If your schema differs, keep only storage return and wire UI to open the signed URL.
    const { data: sd, error: sdErr } = await supabase
      .from("supporting_documents")
      .insert({
        entity_id: ledger.entity_id,
        record_id: record_id,
        storage_bucket: bucket,
        storage_path: storagePath,
        mime_type: "application/pdf",
        file_hash: fileHash,
        document_class: "axiom_memo",
        verification_level: "unverified",
      })
      .select("id")
      .single();

    // Don’t fail the whole request if your supporting_documents columns differ:
    // just return the file + signed url anyway.
    const expiresIn = 60 * 10;
    const { data: signed, error: signedErr } = await supabase.storage
      .from(bucket)
      .createSignedUrl(storagePath, expiresIn);

    if (signedErr) {
      return json({
        ok: true,
        supporting_document_id: sd?.id ?? null,
        storage_bucket: bucket,
        storage_path: storagePath,
        file_hash: fileHash,
        signed_url: null,
        warning: `Signed URL failed: ${signedErr.message}`,
      });
    }

    return json({
      ok: true,
      supporting_document_id: sd?.id ?? null,
      storage_bucket: bucket,
      storage_path: storagePath,
      file_hash: fileHash,
      signed_url: signed.signedUrl,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ ok: false, error: msg }, 500);
  }
});
