// supabase/functions/axiom-council-memo/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

type ReqBody = {
  record_id: string; // governance_ledger.id
  memo?: {
    // OPTIONAL override payload (if client wants to provide structured memo)
    title?: string;
    executive_summary?: string;
    risks?: string;
    recommendations?: string;
    questions?: string;
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

function safeStr(v: unknown) {
  return String(v ?? "").trim();
}

function isEmptyText(v: unknown) {
  return safeStr(v).length === 0;
}

async function sha256Hex(bytes: Uint8Array) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Remove markdown artifacts so the PDF reads like a professional memo.
 * We keep bullets/newlines but strip headings and emphasis markers.
 */
function stripMarkdown(md: string) {
  let s = (md ?? "").replace(/\r/g, "");

  // Remove fenced code blocks entirely (rare but safer)
  s = s.replace(/```[\s\S]*?```/g, "");

  // Remove inline code backticks
  s = s.replace(/`([^`]+)`/g, "$1");

  // Remove markdown bold/italic markers
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/\*([^*]+)\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/_([^_]+)_/g, "$1");

  // Remove heading markers like #, ##, ###
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, "");

  // Collapse extra spaces
  s = s.replace(/[ \t]+/g, " ");

  // Keep intentional blank lines but avoid huge gaps
  s = s.replace(/\n{4,}/g, "\n\n\n");

  return s.trim();
}

/**
 * Parse AXIOM advisory markdown into stable sections.
 * Supports headings like:
 * ## Executive summary
 * ## Risks / clarity checks
 * ## Recommendations
 * ## Questions to confirm
 *
 * OPTION A: advisory content contains NO meta lines.
 */
function parseAdvisory(md: string) {
  const raw = (md ?? "").replace(/\r/g, "");
  const lines = raw.split("\n");

  type Key = "executive" | "risks" | "recommendations" | "questions" | "other";
  const out: Record<Key, string[]> = {
    executive: [],
    risks: [],
    recommendations: [],
    questions: [],
    other: [],
  };

  let section: Key = "other";

  const norm = (h: string) =>
    h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  const pickSection = (heading: string): Key => {
    const h = norm(heading);
    if (h.includes("executive summary")) return "executive";
    if (h.includes("risks") || h.includes("clarity")) return "risks";
    if (h.includes("recommendations")) return "recommendations";
    if (h.includes("questions")) return "questions";
    return "other";
  };

  for (const ln of lines) {
    const m = ln.match(/^\s{0,3}#{2,6}\s+(.*)$/); // ## Heading
    if (m?.[1]) {
      section = pickSection(m[1]);
      continue;
    }

    // ignore any accidental top title "# ..."
    if (/^\s{0,3}#\s+/.test(ln)) continue;

    // ignore memo_ready marker
    if (/<!--\s*memo_ready:v1\s*-->/.test(ln)) continue;

    out[section].push(ln);
  }

  const joinClean = (arr: string[]) => stripMarkdown(arr.join("\n")).trim();

  return {
    executive_summary: joinClean(out.executive),
    risks: joinClean(out.risks),
    recommendations: joinClean(out.recommendations),
    questions: joinClean(out.questions),
    other: joinClean(out.other),
  };
}

/**
 * Wrap text into lines by measuring font width (real PDF wrapping).
 */
function wrapByWidth(text: string, font: any, size: number, maxWidth: number) {
  const words = (text ?? "").replace(/\r/g, "").split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";

  const widthOf = (t: string) => font.widthOfTextAtSize(t, size);

  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (widthOf(next) > maxWidth) {
      if (line) lines.push(line);
      line = w;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Normalize bullets while keeping governance-safe typography:
 * - NO bold in body bullets (regulator/lawyer safe)
 * - Removes markdown headings that accidentally appear as bullet content
 */
function normalizeBulletItems(text: string) {
  const t = safeStr(text);
  if (!t) return [];

  const rawLines = t.split("\n").map((l) => l.trim()).filter(Boolean);

  const items: string[] = [];
  let buffer: string[] = [];

  const flushBuffer = () => {
    if (buffer.length) {
      const paragraph = buffer.join(" ").trim();
      if (paragraph) items.push(paragraph);
      buffer = [];
    }
  };

  for (const ln of rawLines) {
    if (/^[-•]\s+/.test(ln)) {
      flushBuffer();
      items.push(ln.replace(/^[-•]\s+/, ""));
      continue;
    }
    buffer.push(ln);
  }
  flushBuffer();

  // Clean, drop heading artifacts (e.g. "## Recommendations") if they leaked in
  const cleaned = items
    .map((s) => stripMarkdown(safeStr(s)))
    .map((s) => s.replace(/^\s*#{1,6}\s+/, "").trim())
    .filter((s) => s.length > 0);

  return cleaned;
}

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (req.method !== "POST") {
      return json({ ok: false, error: "POST only" }, 405);
    }

    const body = (await req.json().catch(() => ({}))) as ReqBody;
    const record_id = safeStr(body?.record_id);
    if (!record_id) return json({ ok: false, error: "Missing record_id" }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) {
      return json(
        { ok: false, error: "Missing SUPABASE_URL or SERVICE_ROLE key" },
        500,
      );
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
      return json(
        { ok: false, error: `Ledger fetch failed: ${ledgerErr?.message ?? "not found"}` },
        400,
      );
    }

    const is_test = !!ledger.is_test;

    // ---- Try to load entity slug/name for header (best effort, no regression) ----
    let entitySlug = "";
    try {
      const { data: ent } = await supabase
        .from("entities")
        .select("slug,name")
        .eq("id", ledger.entity_id)
        .maybeSingle();
      entitySlug = safeStr(ent?.slug || ent?.name);
    } catch {
      entitySlug = "";
    }

    // ---- Determine memo content source ----
    // Priority:
    // 1) body.memo (if provided and has meaningful content)
    // 2) latest ai_notes advisory for this record
    const clientMemo = body.memo ?? null;

    const hasClientContent =
      !!clientMemo &&
      (!isEmptyText(clientMemo.executive_summary) ||
        !isEmptyText(clientMemo.risks) ||
        !isEmptyText(clientMemo.recommendations) ||
        !isEmptyText(clientMemo.questions) ||
        (clientMemo.findings?.length ?? 0) > 0 ||
        !isEmptyText(clientMemo.notes));

    let memoTitle =
      safeStr(clientMemo?.title) || "Council Advisory — Evidence-based Analysis";

    let executive_summary = safeStr(clientMemo?.executive_summary);
    let risks = safeStr(clientMemo?.risks);
    let recommendations = safeStr(clientMemo?.recommendations);
    let questions = safeStr(clientMemo?.questions);
    let notes = safeStr(clientMemo?.notes);
    const findings = clientMemo?.findings ?? [];

    let sourceNoteId: string | null = null;
    let sourceModel: string | null = null;

    if (!hasClientContent) {
      const { data: note } = await supabase
        .from("ai_notes")
        .select("id, title, content, model, created_at")
        .eq("scope_type", "document")
        .eq("scope_id", record_id)
        .eq("note_type", "summary")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (note?.content) {
        sourceNoteId = note.id;
        sourceModel = safeStr(note.model);
        memoTitle = "Council Advisory — Evidence-based Analysis";

        const parsed = parseAdvisory(note.content);
        executive_summary = parsed.executive_summary || "";
        risks = parsed.risks || "";
        recommendations = parsed.recommendations || "";
        questions = parsed.questions || "";
        notes = ""; // reserved for provenance line below
      } else {
        executive_summary =
          "No advisory content was available at generation time. Generate an advisory in Council and retry.";
      }
    }

    if (
      isEmptyText(executive_summary) &&
      isEmptyText(risks) &&
      isEmptyText(recommendations) &&
      isEmptyText(questions) &&
      (findings?.length ?? 0) === 0 &&
      isEmptyText(notes)
    ) {
      executive_summary =
        "No advisory content was available at generation time. Generate an advisory in Council and retry.";
    }

    // ==== PDF RENDER (enterprise layout + pagination) ====
    const pdf = await PDFDocument.create();
    const fontRegular = await pdf.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

    const pageSize: [number, number] = [612, 792]; // US Letter

    const marginX = 54;
    const marginTop = 62;
    const marginBottom = 54;

    let page = pdf.addPage(pageSize);
    let { width, height } = page.getSize();
    let y = height - marginTop;

    const maxWidth = width - marginX * 2;

    const gray = rgb(0.35, 0.35, 0.35);
    const lightGray = rgb(0.85, 0.85, 0.85);
    const black = rgb(0.08, 0.08, 0.08);

    const newPage = () => {
      page = pdf.addPage(pageSize);
      ({ width, height } = page.getSize());
      y = height - marginTop;
    };

    const ensureSpace = (needed: number) => {
      if (y - needed < marginBottom) newPage();
    };

    const drawHLine = (gapTop = 10, gapBottom = 14) => {
      ensureSpace(gapTop + gapBottom + 2);
      y -= gapTop;
      page.drawLine({
        start: { x: marginX, y },
        end: { x: width - marginX, y },
        thickness: 1,
        color: lightGray,
      });
      y -= gapBottom;
    };

    const drawTextLines = (
      lines: string[],
      size: number,
      font: any,
      color = black,
      lineGap = 3,
    ) => {
      for (const ln of lines) {
        ensureSpace(size + lineGap + 1);
        page.drawText(ln, { x: marginX, y, size, font, color });
        y -= size + lineGap;
      }
    };

    const drawParagraph = (text: string, size = 11, color = black) => {
      const t = safeStr(text);
      if (!t) return;
      const lines = wrapByWidth(t, fontRegular, size, maxWidth);
      drawTextLines(lines, size, fontRegular, color, 3);
      y -= 6;
    };

    /**
     * Governance-safe bullets:
     * - NO bold in body bullets
     * - Bullet dot bold is fine (tiny typographic anchor)
     */
    const drawBullets = (text: string, size = 11) => {
      const items = normalizeBulletItems(text);
      if (items.length === 0) return;

      // If it reads like a single paragraph, render as paragraph
      if (items.length === 1 && items[0].length > 180) {
        drawParagraph(items[0], size, black);
        return;
      }

      const bulletX = marginX;
      const textX = marginX + 14;
      const innerWidth = maxWidth - 14;

      for (const item of items) {
        const lines = wrapByWidth(item, fontRegular, size, innerWidth);

        ensureSpace(size + 4);
        page.drawText("•", {
          x: bulletX,
          y,
          size,
          font: fontBold,
          color: black,
        });

        for (const l of lines) {
          ensureSpace(size + 4);
          page.drawText(l, {
            x: textX,
            y,
            size,
            font: fontRegular,
            color: black,
          });
          y -= size + 3;
        }

        y -= 4; // item gap
      }
    };

    const drawSection = (title: string) => {
      ensureSpace(28);
      page.drawText(title, { x: marginX, y, size: 13, font: fontBold, color: black });
      y -= 8;
      page.drawLine({
        start: { x: marginX, y },
        end: { x: width - marginX, y },
        thickness: 1,
        color: lightGray,
      });
      y -= 14;
    };

    // ---- Header ----
    page.drawText(memoTitle, { x: marginX, y, size: 18, font: fontBold, color: black });
    y -= 22;

    const recordTitle = safeStr(ledger.title) || record_id;
    const laneLabel = is_test ? "SANDBOX" : "RoT";
    const ledgerStatus = safeStr(ledger.status) || "—";

    const metaLeft: Array<[string, string]> = [
      ["Source record", recordTitle],
      ["Ledger status", ledgerStatus],
      ...(entitySlug ? ([["Entity", entitySlug]] as Array<[string, string]>) : []),
    ];

    const metaRight: Array<[string, string]> = [
      ["Record ID", record_id],
      ["Lane", laneLabel],
    ];

    const rowFontSize = 10.5;
    const colGap = 18;
    const colWidth = (maxWidth - colGap) / 2;

    const labelColor = gray;
    const valueColor = black;

    const labelMaxWidth = (rows: Array<[string, string]>) => {
      let w = 0;
      for (const [label] of rows) {
        const ww = fontBold.widthOfTextAtSize(`${label}:`, rowFontSize);
        if (ww > w) w = ww;
      }
      return w;
    };

    const leftLabelW = labelMaxWidth(metaLeft);
    const rightLabelW = labelMaxWidth(metaRight);

    const drawMetaBlock = (
      x: number,
      rows: Array<[string, string]>,
      labelW: number,
      blockWidth: number,
      startY: number,
    ) => {
      let yy = startY;
      const pad = 10;
      const valueX = x + labelW + pad;
      const valueW = blockWidth - (labelW + pad);

      for (const [label, value] of rows) {
        page.drawText(`${label}:`, {
          x,
          y: yy,
          size: rowFontSize,
          font: fontBold,
          color: labelColor,
        });

        const vLines = wrapByWidth(value, fontRegular, rowFontSize, valueW);
        for (const v of vLines) {
          page.drawText(v, {
            x: valueX,
            y: yy,
            size: rowFontSize,
            font: fontRegular,
            color: valueColor,
          });
          yy -= 14;
        }
        yy -= 2;
      }
      return yy;
    };

    ensureSpace(80);
    const startY = y;

    const leftBottom = drawMetaBlock(marginX, metaLeft, leftLabelW, colWidth, startY);
    const rightX = marginX + colWidth + colGap;
    const rightBottom = drawMetaBlock(rightX, metaRight, rightLabelW, colWidth, startY);

    y = Math.min(leftBottom, rightBottom) - 2;

    const disclaimer =
      "Advisory only. Evidence-based analysis to support Council review; not an approval or decision.";
    ensureSpace(20);
    page.drawText(disclaimer, { x: marginX, y, size: 9.5, font: fontRegular, color: gray });
    y -= 6;

    drawHLine(10, 12);

    // ---- Sections ----
    drawSection("Executive Summary");
    drawBullets(executive_summary, 11);

    if (!isEmptyText(risks)) {
      drawSection("Risks / Clarity Checks");
      drawBullets(risks, 11);
    }

    if (!isEmptyText(recommendations)) {
      drawSection("Recommendations");
      drawBullets(recommendations, 11);
    }

    if (!isEmptyText(questions)) {
      drawSection("Questions to Confirm");
      drawBullets(questions, 11);
    }

    if ((findings?.length ?? 0) > 0) {
      drawSection("Findings (Structured)");
      let idx = 1;
      for (const f of findings) {
        const head =
          `${idx}. ` +
          `${f.severity ? `[${f.severity}] ` : ""}` +
          `${safeStr(f.title)}` +
          `${f.blocking ? " (BLOCKING)" : ""}` +
          `${f.category ? ` — ${safeStr(f.category)}` : ""}`;

        ensureSpace(18);
        page.drawText(head, { x: marginX, y, size: 11, font: fontBold, color: black });
        y -= 14;

        if (!isEmptyText(f.evidence)) {
          page.drawText("Evidence:", { x: marginX, y, size: 10.5, font: fontBold, color: gray });
          y -= 12;
          drawParagraph(stripMarkdown(safeStr(f.evidence)), 10.5, black);
        }

        if (!isEmptyText(f.recommendation)) {
          page.drawText("Recommendation:", {
            x: marginX,
            y,
            size: 10.5,
            font: fontBold,
            color: gray,
          });
          y -= 12;
          drawParagraph(stripMarkdown(safeStr(f.recommendation)), 10.5, black);
        }

        y -= 6;
        idx++;
      }
    }

    drawSection("Additional Notes");

    const provenanceBits: string[] = [];
    if (entitySlug) provenanceBits.push(`Entity: ${entitySlug}`);
    provenanceBits.push(`Lane: ${laneLabel}`);
    if (sourceNoteId) provenanceBits.push(`Source note: ${sourceNoteId}`);
    if (sourceModel) provenanceBits.push(`Model: ${sourceModel}`);

    const provenance = provenanceBits.join(" • ");
    drawParagraph(provenance || "Generated from Council.", 10.5, gray);

    if (!isEmptyText(notes)) {
      drawParagraph(stripMarkdown(notes), 10.5, black);
    }

    // Footer (generated time)
    const generatedAt = new Date().toISOString();
    ensureSpace(20);
    page.drawLine({
      start: { x: marginX, y: marginBottom - 6 },
      end: { x: width - marginX, y: marginBottom - 6 },
      thickness: 1,
      color: lightGray,
    });
    page.drawText(`Generated: ${generatedAt}`, {
      x: marginX,
      y: marginBottom - 22,
      size: 9,
      font: fontRegular,
      color: gray,
    });

    const pdfBytes = await pdf.save();
    const pdfU8 = new Uint8Array(pdfBytes);
    const fileHash = await sha256Hex(pdfU8);

    // ==== STORAGE (CANONICAL BUCKETS) ====
    const bucket = is_test ? "governance_sandbox" : "governance_truth";
    const lanePrefix = is_test ? "sandbox" : "rot";
    const storagePath = `${lanePrefix}/axiom-memos/${record_id}-${Date.now()}.pdf`;

    const up = await supabase.storage.from(bucket).upload(storagePath, pdfU8, {
      contentType: "application/pdf",
      upsert: false,
    });

    if (up.error) return json({ ok: false, error: up.error.message }, 500);

    // Insert supporting_documents (best effort, no regressions)
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
      // ignore schema mismatch / enum mismatch (best effort only)
    }

    return json({
      ok: true,
      supporting_document_id,
      storage_bucket: bucket,
      storage_path: storagePath,
      file_hash: fileHash,
      file_size: pdfU8.length,
      mime_type: "application/pdf",
      source_note_id: sourceNoteId,
      source_model: sourceModel,
    });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
