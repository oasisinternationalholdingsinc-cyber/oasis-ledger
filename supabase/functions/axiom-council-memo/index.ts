import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { PDFDocument, rgb } from "npm:pdf-lib@1.17.1";

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
  const hi = findings.filter((f) => ["HIGH", "CRITICAL"].includes(f.severity));
  if (hi.some((f) => f.blocking)) return { pill: "RED", emoji: "🔴", rationale: "Blocking high-severity findings." };
  if (hi.length >= 2) return { pill: "RED", emoji: "🔴", rationale: "Multiple high-severity findings." };
  if (findings.some((f) => f.severity === "MEDIUM"))
    return { pill: "YELLOW", emoji: "🟡", rationale: "Moderate concerns present." };
  return { pill: "GREEN", emoji: "🟢", rationale: "No material concerns detected." };
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

  const interRegular = await Deno.readFile("../_shared/fonts/Inter-Regular.ttf");
  const interSemi = await Deno.readFile("../_shared/fonts/Inter-SemiBold.ttf");

  const font = await pdf.embedFont(interRegular, { subset: true });
  const fontBold = await pdf.embedFont(interSemi, { subset: true });

  const page = pdf.addPage([612, 792]);
  const margin = 48;
  let y = 740;

  page.drawText("OASIS DIGITAL PARLIAMENT", {
    x: margin,
    y,
    size: 12,
    font: fontBold,
    color: rgb(0.95, 0.95, 0.95),
  });

  y -= 24;

  page.drawText(opts.title, {
    x: margin,
    y,
    size: 16,
    font: fontBold,
    color: rgb(1, 1, 1),
  });

  y -= 18;

  page.drawText(
    `${opts.severity.emoji} ${opts.severity.pill} — ${opts.severity.rationale}`,
    { x: margin, y, size: 11, font, color: rgb(0.9, 0.8, 0.3) }
  );

  y -= 28;

  page.drawText("Executive Summary", { x: margin, y, size: 12, font: fontBold });
  y -= 14;

  page.drawText(opts.memo.executive_summary ?? "", {
    x: margin,
    y,
    size: 10,
    font,
    maxWidth: 612 - margin * 2,
    lineHeight: 14,
  });

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

    const token = auth.slice(7);
    const body = (await req.json()) as ReqBody;
    if (!body.record_id) return json(req, { ok: false, error: "record_id required" }, 400);

    const isTest = !!body.is_test;
    const lane = isTest ? "SANDBOX" : "ROT";

    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } }
    );

    const { data: user } = await sb.auth.getUser(token);
    if (!user?.user?.id) return json(req, { ok: false, error: "Invalid session" }, 401);

    const { data: gl } = await sb
      .from("governance_ledger")
      .select("id,title,entity_id,is_test")
      .eq("id", body.record_id)
      .single();

    const { data: ent } = await sb.from("entities").select("name").eq("id", gl.entity_id).single();

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
      diff_suggestions: [],
    };

    const severity = computeSeverity(memo.findings);
    const pdfBytes = await renderMemoPdf({
      title: gl.title,
      entityName: ent.name,
      lane,
      recordId: gl.id,
      generatedBy: user.user.id,
      generatedAtISO: new Date().toISOString(),
      severity,
      memo,
    });

    const hash = await sha256Hex(pdfBytes);
    const bucket = isTest ? "governance_sandbox" : "governance_truth";
    const path = `${isTest ? "sandbox" : "rot"}/axiom/memos/${gl.id}/AXIOM_MEMO_${ymdhm()}.pdf`;

    await sb.storage.from(bucket).upload(path, pdfBytes, { contentType: "application/pdf", upsert: true });

    await sb.from("governance_documents").insert({
      record_id: gl.id,
      storage_path: path,
      doc_type: "axiom_memo",
      mime_type: "application/pdf",
      file_hash: hash,
      file_size: pdfBytes.length,
    });

    await sb.from("ai_notes").insert({
      scope_type: "document",
      scope_id: gl.id,
      note_type: "memo",
      title: `AXIOM Council Memo • ${severity.emoji} ${severity.pill}`,
      content: memo.executive_summary,
      model: "axiom-council-memo",
      created_by: user.user.id,
    });

    return json(req, {
      ok: true,
      record_id: gl.id,
      lane,
      storage_bucket: bucket,
      storage_path: path,
      file_hash: hash,
      severity: severity.pill,
    });
  } catch (e: any) {
    return json(req, { ok: false, error: e.message }, 500);
  }
});
