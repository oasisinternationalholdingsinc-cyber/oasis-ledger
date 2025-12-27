import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { PDFDocument, rgb } from "npm:pdf-lib@1.17.1";
import fontkit from "npm:@pdf-lib/fontkit@1.1.1";

/* ============================
   TYPES
============================ */
type ReqBody = {
  record_id: string;          // governance_ledger.id
  is_test?: boolean;          // lane flag
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
    conditions?: {
      pre?: string[];
      during?: string[];
      post?: string[];
    };
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

function safeStr(x: unknown, fallback = ""): string {
  return typeof x === "string" ? x : fallback;
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

/**
 * PDF-safe sanitizer:
 * - Inter supports lots of Unicode, but NOT emoji.
 * - Also keeps the PDF deterministic and stable.
 */
function pdfSafe(text: string) {
  // remove non-ASCII control chars + emoji etc
  return (text ?? "").replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "");
}

function computeSeverity(findings: any[]) {
  const list = Array.isArray(findings) ? findings : [];
  const hi = list.filter((f) => ["HIGH", "CRITICAL"].includes(f?.severity));
  if (hi.some((f) => !!f?.blocking)) return { pill: "RED" as const, rationale: "Blocking high-severity findings." };
  if (hi.length >= 2) return { pill: "RED" as const, rationale: "Multiple high-severity findings." };
  if (list.some((f) => f?.severity === "MEDIUM")) return { pill: "YELLOW" as const, rationale: "Moderate concerns present." };
  return { pill: "GREEN" as const, rationale: "No material concerns detected." };
}

/* ============================
   PDF RENDERER (INTER)
   - Uses global _shared fonts
   - fontkit enabled
   - no emoji in PDF
============================ */
async function renderMemoPdf(opts: {
  title: string;
  entityName: string;
  lane: "SANDBOX" | "ROT";
  recordId: string;
  generatedBy: string;
  generatedAtISO: string;
  severity: { pill: "GREEN" | "YELLOW" | "RED"; rationale: string };
  memo: Required<NonNullable<ReqBody["memo"]>>;
}) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);

  // ✅ Load fonts relative to this file so bundling works
  const interRegular = await Deno.readFile(
  new URL("../_shared/fonts/Inter-Regular.ttf", import.meta.url)
);

const interSemi = await Deno.readFile(
  new URL("../_shared/fonts/Inter-SemiBold.ttf", import.meta.url)
);

  const font = await pdf.embedFont(interRegular, { subset: true });
  const fontBold = await pdf.embedFont(interSemi, { subset: true });

  const pageW = 612;
  const pageH = 792;
  const margin = 48;

  const page = pdf.addPage([pageW, pageH]);

  // Header bar
  page.drawRectangle({ x: 0, y: pageH - 64, width: pageW, height: 64, color: rgb(0.03, 0.05, 0.10) });

  page.drawText("OASIS DIGITAL PARLIAMENT", {
    x: margin,
    y: pageH - 38,
    size: 11,
    font: fontBold,
    color: rgb(0.95, 0.95, 0.95),
  });

  page.drawText("AXIOM MEMORANDUM (ADVISORY)", {
    x: margin,
    y: pageH - 54,
    size: 9,
    font,
    color: rgb(0.75, 0.80, 0.95),
  });

  const right = pdfSafe(`${opts.entityName} • ${opts.lane}`);
  const rightWidth = font.widthOfTextAtSize(right, 9);
  page.drawText(right, {
    x: pageW - margin - rightWidth,
    y: pageH - 54,
    size: 9,
    font,
    color: rgb(0.90, 0.80, 0.35),
  });

  let y = pageH - 98;

  page.drawText(pdfSafe(opts.title || "Untitled Resolution"), {
    x: margin,
    y,
    size: 16,
    font: fontBold,
    color: rgb(0.98, 0.98, 0.98),
  });
  y -= 20;

  page.drawText(
    pdfSafe(`Record ID: ${opts.recordId} • Generated: ${opts.generatedAtISO} • By: ${opts.generatedBy}`),
    { x: margin, y, size: 9, font, color: rgb(0.65, 0.70, 0.85) }
  );
  y -= 22;

  // Severity pill (NO emoji)
  page.drawRectangle({
    x: margin,
    y: y - 42,
    width: pageW - margin * 2,
    height: 42,
    borderColor: rgb(0.20, 0.25, 0.35),
    borderWidth: 1,
    color: rgb(0, 0, 0),
    opacity: 0.35,
  });

  page.drawText(pdfSafe(`SEVERITY: ${opts.severity.pill}`), {
    x: margin + 14,
    y: y - 18,
    size: 12,
    font: fontBold,
    color: rgb(0.90, 0.80, 0.35),
  });

  page.drawText(pdfSafe(opts.severity.rationale), {
    x: margin + 14,
    y: y - 34,
    size: 9,
    font,
    color: rgb(0.80, 0.80, 0.80),
  });

  y -= 62;

  page.drawText("Executive Summary", { x: margin, y, size: 12, font: fontBold, color: rgb(0.95, 0.95, 0.95) });
  y -= 14;

  const summary = pdfSafe(opts.memo.executive_summary ?? "");
  page.drawText(summary, {
    x: margin,
    y,
    size: 10,
    font,
    color: rgb(0.90, 0.90, 0.90),
    maxWidth: pageW - margin * 2,
    lineHeight: 14,
  });

  // Footer
  const footer = pdfSafe(
    `AXIOM is advisory. Council is the authority. • Record ${opts.recordId.slice(0, 8)}…${opts.recordId.slice(-6)}`
  );
  page.drawText(footer, { x: margin, y: 24, size: 8, font, color: rgb(0.6, 0.6, 0.6) });

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

    // Resolve real user (ai_notes.created_by is NOT NULL)
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
      return json(req, { ok: false, error: "Lane mismatch: record.is_test does not match request is_test" }, 400);

    const { data: ent, error: entErr } = await sb
      .from("entities")
      .select("name,slug")
      .eq("id", gl.entity_id)
      .single();

    if (entErr || !ent) return json(req, { ok: false, error: entErr?.message ?? "Entity not found" }, 404);

    const memo = {
      executive_summary:
        body.memo?.executive_summary ??
        "AXIOM advisory memo generated for Council review. Advisory only.",
      findings: body.memo?.findings ?? [],
      conditions: body.memo?.conditions ?? { pre: [], during: [], post: [] },
      decision_record: body.memo?.decision_record ?? {
        recommended_disposition: "APPROVE_WITH_CONDITIONS",
        rationale: "Council remains authority.",
        followups: [],
        suggested_execution_mode: "FORGE_SIGNATURE",
      },
      diff_suggestions: body.memo?.diff_suggestions ?? [],
    } as Required<NonNullable<ReqBody["memo"]>>;

    const severity = computeSeverity(memo.findings);
    const generatedAtISO = new Date().toISOString();
    const generatedBy = `CI-Council:${userId.slice(0, 8)}`;

    const pdfBytes = await renderMemoPdf({
      title: gl.title ?? "Untitled Resolution",
      entityName: ent.name ?? ent.slug ?? "Entity",
      lane,
      recordId: gl.id,
      generatedBy,
      generatedAtISO,
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

    const { data: docRow, error: docErr } = await sb
      .from("governance_documents")
      .insert({
        record_id: gl.id,
        storage_path: path,
        doc_type: "axiom_memo",
        mime_type: "application/pdf",
        file_hash: hash,
        file_size: pdfBytes.length,
      })
      .select("id")
      .single();

    if (docErr || !docRow) return json(req, { ok: false, error: docErr?.message ?? "Failed to register governance_documents" }, 500);

    // ai_notes can contain emoji/markdown — that's fine (web UI), but keep note_type valid for your constraints
    // If your chk_note_type rejects "memo", change note_type to "summary".
    const noteType = "summary";

    const { data: noteRow, error: noteErr } = await sb
      .from("ai_notes")
      .insert({
        scope_type: "document",
        scope_id: gl.id,
        note_type: noteType,
        title: `AXIOM Council Memo • ${severity.pill}`,
        content: memo.executive_summary,
        model: "axiom-council-memo",
        created_by: userId,
      })
      .select("id")
      .single();

    return json(req, {
      ok: true,
      record_id: gl.id,
      lane,
      storage_bucket: bucket,
      storage_path: path,
      file_hash: hash,
      severity: severity.pill,
      memo_id: docRow.id,
      note_id: noteRow?.id ?? null,
      warning: noteErr ? `ai_notes insert failed: ${noteErr.message}` : undefined,
    });
  } catch (e: any) {
    return json(req, { ok: false, error: e?.message ?? "Unknown error" }, 500);
  }
});
