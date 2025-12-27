import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";
import fontkit from "npm:@pdf-lib/fontkit@1.1.1";

/* ============================
   TYPES
============================ */
type ReqBody = {
  record_id: string;
  is_test?: boolean;
  memo?: {
    executive_summary?: string;
    findings?: Array<{
      severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
      blocking?: boolean;
      category?: string;
      title: string;
      evidence?: string;
      impact?: string;
      recommendation?: string;
      confidence?: "LOW" | "MEDIUM" | "HIGH";
    }>;
    conditions?: { pre?: string[]; during?: string[]; post?: string[] };
    decision_record?: {
      recommended_disposition?: "APPROVE" | "APPROVE_WITH_CONDITIONS" | "REJECT" | "DEFER";
      rationale?: string;
      followups?: string[];
      suggested_execution_mode?: "FORGE_SIGNATURE" | "DIRECT_ARCHIVE";
    };
    diff_suggestions?: string[];
  };
};

/* ============================
   HELPERS
============================ */
function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") ?? "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}

function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(req) },
  });
}

async function sha256Hex(bytes: Uint8Array) {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function ymdhm(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function computeSeverity(findings: any[]) {
  const list = Array.isArray(findings) ? findings : [];
  const hi = list.filter((f) => ["HIGH", "CRITICAL"].includes(f?.severity));
  if (hi.some((f) => !!f?.blocking)) return { pill: "RED", emoji: "🔴", rationale: "Blocking high-severity findings." };
  if (hi.length >= 2) return { pill: "RED", emoji: "🔴", rationale: "Multiple high-severity findings." };
  if (list.some((f) => f?.severity === "MEDIUM")) return { pill: "YELLOW", emoji: "🟡", rationale: "Moderate concerns present." };
  return { pill: "GREEN", emoji: "🟢", rationale: "No material concerns detected." };
}

function safeStr(x: unknown, fallback = ""): string {
  return typeof x === "string" ? x : fallback;
}

/* ============================
   PDF RENDERER (INTER)
============================ */
async function renderMemoPdf(opts: {
  title: string;
  entityName: string;
  lane: "SANDBOX" | "ROT";
  recordId: string;
  generatedBy: string;
  generatedAtISO: string;
  severity: { pill: string; emoji: string; rationale: string };
  memo: Required<NonNullable<ReqBody["memo"]>>;
}) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);

  // Correct global shared paths (IMPORTANT)
  const interRegularUrl = new URL("../_shared/fonts/Inter-Regular.ttf", import.meta.url);
  const interSemiUrl = new URL("../_shared/fonts/Inter-SemiBold.ttf", import.meta.url);

  let font: any;
  let fontBold: any;

  try {
    const interRegular = await Deno.readFile(interRegularUrl);
    const interSemi = await Deno.readFile(interSemiUrl);
    font = await pdf.embedFont(interRegular, { subset: true });
    fontBold = await pdf.embedFont(interSemi, { subset: true });
  } catch (_e) {
    // fail-safe: never brick prod if fonts go missing
    font = await pdf.embedFont(StandardFonts.Helvetica);
    fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  }

  const pageW = 612;
  const pageH = 792;
  const page = pdf.addPage([pageW, pageH]);

  const margin = 48;
  let y = 740;

  // simple OS-styled header band
  page.drawRectangle({ x: 0, y: pageH - 64, width: pageW, height: 64, color: rgb(0.03, 0.05, 0.10) });

  page.drawText("OASIS DIGITAL PARLIAMENT", {
    x: margin,
    y: pageH - 34,
    size: 11,
    font: fontBold,
    color: rgb(0.95, 0.95, 0.95),
  });

  page.drawText("AXIOM MEMORANDUM (ADVISORY)", {
    x: margin,
    y: pageH - 50,
    size: 9,
    font,
    color: rgb(0.75, 0.80, 0.95),
  });

  const right = `${opts.entityName} • ${opts.lane}`;
  const rightWidth = font.widthOfTextAtSize(right, 9);
  page.drawText(right, {
    x: pageW - margin - rightWidth,
    y: pageH - 50,
    size: 9,
    font,
    color: rgb(0.90, 0.80, 0.35),
  });

  // Title
  y -= 40;
  page.drawText(safeStr(opts.title, "Untitled Resolution"), {
    x: margin,
    y,
    size: 16,
    font: fontBold,
    color: rgb(0.95, 0.95, 0.95),
  });

  y -= 18;
  page.drawText(`Record: ${opts.recordId} • Generated: ${opts.generatedAtISO} • By: ${opts.generatedBy}`, {
    x: margin,
    y,
    size: 9,
    font,
    color: rgb(0.65, 0.70, 0.85),
  });

  // Severity box
  y -= 28;
  page.drawRectangle({
    x: margin,
    y: y - 54,
    width: pageW - margin * 2,
    height: 54,
    borderColor: rgb(0.20, 0.25, 0.35),
    borderWidth: 1,
    color: rgb(0, 0, 0),
    opacity: 0.35,
  });

  page.drawText(`${opts.severity.emoji}  SEVERITY: ${opts.severity.pill}`, {
    x: margin + 14,
    y: y - 28,
    size: 12,
    font: fontBold,
    color: rgb(0.90, 0.80, 0.35),
  });

  page.drawText(opts.severity.rationale, {
    x: margin + 14,
    y: y - 44,
    size: 9,
    font,
    color: rgb(0.80, 0.80, 0.80),
  });

  y -= 76;

  // Executive summary
  page.drawText("Executive Summary", { x: margin, y, size: 12, font: fontBold, color: rgb(0.95, 0.95, 0.95) });
  y -= 14;

  const wrap = (text: string, maxWidth: number, size: number) => {
    const words = (text ?? "").split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = "";
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(test, size) <= maxWidth) line = test;
      else {
        if (line) lines.push(line);
        line = w;
      }
    }
    if (line) lines.push(line);
    return lines;
  };

  const summary = safeStr(opts.memo.executive_summary, "AXIOM advisory memo generated for Council review. Advisory only.");
  const sumLines = wrap(summary, pageW - margin * 2, 10);

  for (const line of sumLines.slice(0, 28)) {
    page.drawText(line, { x: margin, y, size: 10, font, color: rgb(0.88, 0.88, 0.88) });
    y -= 14;
    if (y < 70) break;
  }

  // Footer
  page.drawText(
    `AXIOM is advisory. Council is the authority. • ${opts.recordId.slice(0, 8)}…${opts.recordId.slice(-6)}`,
    { x: margin, y: 24, size: 8, font, color: rgb(0.6, 0.6, 0.6) }
  );

  return pdf.save();
}

/* ============================
   MAIN
============================ */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { ok: false, error: "POST only" }, 405);

  try {
    const auth = req.headers.get("Authorization") ?? "";
    if (!auth.toLowerCase().startsWith("bearer "))
      return json(req, { ok: false, error: "Missing Authorization Bearer JWT" }, 401);

    const token = auth.slice(7).trim();
    const body = (await req.json()) as ReqBody;

    const recordId = safeStr(body.record_id);
    if (!recordId) return json(req, { ok: false, error: "record_id required" }, 400);

    const isTest = !!body.is_test;
    const lane: "SANDBOX" | "ROT" = isTest ? "SANDBOX" : "ROT";

    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } }
    );

    const { data: userData, error: userErr } = await sb.auth.getUser(token);
    if (userErr || !userData?.user?.id) return json(req, { ok: false, error: "Invalid session" }, 401);
    const userId = userData.user.id;

    const { data: gl, error: glErr } = await sb
      .from("governance_ledger")
      .select("id,title,entity_id,is_test")
      .eq("id", recordId)
      .single();

    if (glErr || !gl) return json(req, { ok: false, error: glErr?.message ?? "Ledger record not found" }, 404);
    if (typeof gl.is_test === "boolean" && gl.is_test !== isTest)
      return json(req, { ok: false, error: "Lane mismatch (is_test)." }, 400);

    const { data: ent, error: entErr } = await sb.from("entities").select("name,slug").eq("id", gl.entity_id).single();
    if (entErr || !ent) return json(req, { ok: false, error: entErr?.message ?? "Entity not found" }, 404);

    const memo = {
      executive_summary: body.memo?.executive_summary ?? "AXIOM advisory memo generated for Council review. Advisory only.",
      findings: body.memo?.findings ?? [],
      conditions: {
        pre: body.memo?.conditions?.pre ?? [],
        during: body.memo?.conditions?.during ?? [],
        post: body.memo?.conditions?.post ?? [],
      },
      decision_record: {
        recommended_disposition: body.memo?.decision_record?.recommended_disposition ?? "APPROVE_WITH_CONDITIONS",
        rationale: body.memo?.decision_record?.rationale ?? "Council remains the authority. AXIOM is advisory only.",
        followups: body.memo?.decision_record?.followups ?? [],
        suggested_execution_mode: body.memo?.decision_record?.suggested_execution_mode ?? "FORGE_SIGNATURE",
      },
      diff_suggestions: body.memo?.diff_suggestions ?? [],
    } as Required<NonNullable<ReqBody["memo"]>>;

    const severity = computeSeverity(memo.findings);

    const pdfBytes = await renderMemoPdf({
      title: safeStr(gl.title, "Untitled Resolution"),
      entityName: safeStr(ent.name, ent.slug ?? "Entity"),
      lane,
      recordId: gl.id,
      generatedBy: `CI-Council:${userId.slice(0, 8)}`,
      generatedAtISO: new Date().toISOString(),
      severity,
      memo,
    });

    const hash = await sha256Hex(pdfBytes);
    const bucket = isTest ? "governance_sandbox" : "governance_truth";
    const path = `${isTest ? "sandbox" : "rot"}/axiom/memos/${gl.id}/AXIOM_MEMO_${ymdhm()}.pdf`;

    const { error: upErr } = await sb.storage.from(bucket).upload(path, pdfBytes, {
      contentType: "application/pdf",
      upsert: true,
    });
    if (upErr) return json(req, { ok: false, error: upErr.message }, 500);

    const { error: docErr } = await sb.from("governance_documents").insert({
      record_id: gl.id,
      storage_path: path,
      doc_type: "axiom_memo",
      mime_type: "application/pdf",
      file_hash: hash,
      file_size: pdfBytes.length,
      file_name: path.split("/").pop(),
    });
    if (docErr) return json(req, { ok: false, error: docErr.message }, 500);

    // Note: if your chk_note_type blocks "memo", switch this to "summary"
    const { error: noteErr } = await sb.from("ai_notes").insert({
      scope_type: "document",
      scope_id: gl.id,
      note_type: "memo",
      title: `AXIOM Council Memo • ${severity.emoji} ${severity.pill}`,
      content: memo.executive_summary,
      model: "axiom-council-memo",
      created_by: userId,
    });

    return json(req, {
      ok: true,
      record_id: gl.id,
      lane,
      storage_bucket: bucket,
      storage_path: path,
      file_hash: hash,
      severity: severity.pill,
      warning: noteErr ? `ai_notes insert failed: ${noteErr.message}` : null,
    });
  } catch (e: any) {
    return json(req, { ok: false, error: e?.message ?? "Unknown error" }, 500);
  }
});
