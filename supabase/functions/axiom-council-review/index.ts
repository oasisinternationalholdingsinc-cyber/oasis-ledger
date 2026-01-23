// supabase/functions/axiom-council-review/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import OpenAI from "https://esm.sh/openai@4";

type ReqBody = {
  record_id: string; // governance_ledger.id
};

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-requested-with",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function mustEnv(name: string) {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function safeStr(s: unknown) {
  return String(s ?? "").trim();
}

function normalizeAdvisory(md: string) {
  let s = String(md ?? "").replace(/\r/g, "").trim();

  // Normalize bullet glyphs and double-dash artifacts
  s = s.replace(/^\s*•\s+/gm, "- ");
  s = s.replace(/^\s*-\s*-\s+/gm, "- ");

  // Hard-stop any accidental extra top-level title repeats inside bullets
  // (Keeps headings intact but prevents weird "## Executive..." leaking into a bullet line.)
  s = s.replace(/^\s*-\s*#+\s+/gm, "- ");

  // Remove accidental empty bullets
  s = s.replace(/^\s*-\s*$/gm, "");

  // Clamp excessive blank lines
  s = s.replace(/\n{4,}/g, "\n\n\n").trim();

  return s;
}

// Keep compatible with your chk_note_type constraint
const NOTE_TYPE_FOR_COUNCIL = "summary";
// ai_notes.scope_type enum: document/section/book/entity
const SCOPE_TYPE_FOR_LEDGER = "document";

/**
 * Memo-friendly fallback (enterprise, court-style, stable)
 * - Bullet-only sections (no paragraphs)
 * - No pasted source text (prevents ugly PDF + overflow)
 * - Authority-aligned: AXIOM never competes with governance
 *
 * IMPORTANT: We keep the top metadata lines because your memo renderer
 * parses sections and strips markdown — but we label them in an
 * authority-safe way so they don't fight the ledger.
 */
function fallbackTemplate(rec: {
  id: string;
  title: string | null;
  status: string | null;
  is_test: boolean | null;
  body: string | null;
}) {
  const title = rec.title ?? "(untitled)";
  const lane = rec.is_test ? "SANDBOX" : "RoT";
  const status = safeStr(rec.status) || "—";

  return [
    `# Council Advisory — Evidence-based Analysis`,
    ``,
    `**Source record:** ${title}`,
    `**Ledger status:** ${status}`,
    `**Lane:** ${lane}`,
    ``,
    `## Executive summary`,
    `- Advisory only; this memorandum does not approve, reject, or modify the governance record.`,
    `- State the purpose (“why this exists”) in one sentence.`,
    `- Summarize the decision context in plain language (1–2 bullets).`,
    `- Identify minimum conditions for Council comfort (e.g., approvals, attachments, confirmations).`,
    ``,
    `## Risks / clarity checks`,
    `- [GREEN] The text appears internally consistent based on the provided content.`,
    `- [YELLOW] Evidence/attachments are not explicitly referenced; confirm required supporting materials are filed.`,
    `- [YELLOW] Timelines, responsible parties, and success criteria should be explicit for audit clarity.`,
    `- [RED] If any required authority, dependency, consent, or condition is missing, return for correction before signature.`,
    ``,
    `## Recommendations`,
    `- Confirm scope, timeline, and responsible parties are stated unambiguously.`,
    `- Attach required evidence (contracts, approvals, budgets, policies) before execution.`,
    `- Clarify any wording that could be disputed later (dates, thresholds, responsibilities).`,
    `- Approve only if the above conditions are satisfied; otherwise send back with a short correction note.`,
    ``,
    `## Questions to confirm`,
    `1. What specific evidence/attachments should be referenced for this decision?`,
    `2. Are responsible parties and timelines explicitly stated and reviewable?`,
    `3. Are any external approvals/consents required before execution?`,
    `4. Are measurable success/acceptance criteria stated where appropriate?`,
    `5. Are operational, privacy, or security safeguards required and documented?`,
    ``,
    `<!-- memo_ready:v1 -->`,
  ].join("\n");
}

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

    // Caller must be authenticated so we can attribute created_by properly
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) {
      return json({ ok: false, error: "Missing Authorization Bearer token" }, 401);
    }

    const body = (await req.json().catch(() => ({}))) as ReqBody;
    const record_id = safeStr(body?.record_id);
    if (!record_id) return json({ ok: false, error: "record_id is required" }, 400);

    const supabaseUrl = mustEnv("SUPABASE_URL");
    const serviceKey = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
    const anonKey = mustEnv("SUPABASE_ANON_KEY");

    // Admin client (reliable reads/writes even if RLS is strict)
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    // User client (resolve caller user id from JWT)
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });

    const { data: userRes, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userRes?.user?.id) return json({ ok: false, error: "Invalid session" }, 401);
    const userId = userRes.user.id;

    // 1) Load ledger record (keep selection minimal + stable)
    const { data: rec, error: recErr } = await admin
      .from("governance_ledger")
      .select("id,title,body,status,entity_id,is_test,created_at,record_type")
      .eq("id", record_id)
      .single();

    if (recErr || !rec) return json({ ok: false, error: recErr?.message ?? "Record not found" }, 404);

    const title = rec.title ?? "(untitled)";
    const bodyText = safeStr(rec.body);
    const lane = rec.is_test ? "SANDBOX" : "RoT";
    const recordType = safeStr((rec as any).record_type) || "resolution";

    // 2) Generate advisory (preferred) with OpenAI, else fallback template
    let advisory = "";
    let modelName = "axiom-review-council:template";

    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (openaiKey) {
      const openai = new OpenAI({ apiKey: openaiKey });

      const prompt = `
You are AXIOM inside Oasis Digital Parliament.
You are advisory-only and non-binding.
You do NOT approve or reject; Council is the authority.

OUTPUT RULES (critical):
- Output MUST be valid Markdown.
- Use EXACT section headings below. Do not add extra headings.
- Under each heading, write ONLY bullet points using "-" (dash + space). No paragraphs.
- Executive summary: 3–6 bullets max.
- Risks / clarity checks: bullets only, EACH bullet MUST start with [GREEN] or [YELLOW] or [RED].
- Recommendations: 4–8 bullets max, EACH bullet MUST start with a verb ("Confirm...", "Attach...", "Clarify...").
- Questions to confirm: numbered list 1–5 (only if needed).
- Do NOT include a "Source text" section or paste the resolution text.
- Do NOT restate governance authority. This is commentary only.
- Do NOT include any "Record/Status/Lane" lines except in the header area.

Return Markdown with EXACTLY this structure:

# Council Advisory — Evidence-based Analysis
**Source record:** <title>
**Ledger status:** <status>
**Lane:** <RoT|SANDBOX>

## Executive summary
- ...

## Risks / clarity checks
- [GREEN] ...
- [YELLOW] ...
- [RED] ...

## Recommendations
- ...

## Questions to confirm
1. ...

Context:
- Lane: ${lane}
- Record type: ${recordType}
- Title: ${title}

Resolution text (for analysis only; do NOT paste it in output):
${bodyText.slice(0, 14000)}
`.trim();

      const completion = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [
          { role: "system", content: "You are AXIOM. Advisory-only. Council-grade review." },
          { role: "user", content: prompt },
        ],
        temperature: 0.2,
      });

      advisory = completion.choices?.[0]?.message?.content?.trim() ?? "";
      if (!advisory) advisory = fallbackTemplate(rec);

      advisory = normalizeAdvisory(advisory);

      // Ensure sentinel marker exactly once
      if (!advisory.includes("<!-- memo_ready:v1 -->")) {
        advisory = `${advisory}\n\n<!-- memo_ready:v1 -->`;
      }

      modelName = "axiom-review-council:v3";
    } else {
      advisory = fallbackTemplate(rec);
      advisory = normalizeAdvisory(advisory);
    }

    // 3) Insert ai_notes (ledger-scoped, lane-safe)
    const { data: noteRow, error: noteErr } = await admin
      .from("ai_notes")
      .insert({
        scope_type: SCOPE_TYPE_FOR_LEDGER,
        scope_id: rec.id,
        note_type: NOTE_TYPE_FOR_COUNCIL,
        // Keep title clean (avoid duplicating record title; memo PDF shows it in header)
        title: `Council Advisory — Evidence-based Analysis`,
        content: advisory,
        model: modelName,
        tokens_used: null,
        created_by: userId,
      })
      .select("id, created_at")
      .single();

    if (noteErr || !noteRow?.id) {
      return json({ ok: false, error: noteErr?.message ?? "Failed to write ai_notes" }, 500);
    }

    return json({
      ok: true,
      note_id: noteRow.id,
      record_id: rec.id,
      model: modelName,
      created_at: noteRow.created_at,
    });
  } catch (e: any) {
    return json({ ok: false, error: e?.message ?? "Unhandled error" }, 500);
  }
});
