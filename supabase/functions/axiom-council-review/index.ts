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

// Keep compatible with your chk_note_type constraint
const NOTE_TYPE_FOR_COUNCIL = "summary";
// ai_notes.scope_type enum: document/section/book/entity
const SCOPE_TYPE_FOR_LEDGER = "document";

/**
 * OPTION A (LOCKED): AXIOM produces CONTENT ONLY (no meta lines).
 * The memo renderer is sole authority for:
 * - title/header
 * - Source record / Ledger status / Lane / Entity
 * - disclaimer
 *
 * Therefore this fallback MUST NOT include those meta lines either.
 */
function fallbackTemplate(_rec: {
  id: string;
  title: string | null;
  status: string | null;
  is_test: boolean | null;
  body: string | null;
}) {
  return [
    `## Executive summary`,
    `- Advisory only; this memorandum does not approve, reject, or modify the governance record.`,
    `- Summarize the decision in plain language (1–2 bullets).`,
    `- State the purpose (“why this exists”) in one sentence.`,
    `- Identify the minimum conditions for Council comfort (approvals, attachments, confirmations).`,
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
    `- Approve only if conditions are satisfied; otherwise send back with a short correction note.`,
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

function normalizeAdvisory(md: string) {
  // Ensure sentinel marker exactly once
  let s = safeStr(md);
  if (!s) return s;

  // Hard strip any accidental "meta lines" if model violates contract
  // (defensive, but does NOT change wiring — it only removes disallowed header junk)
  s = s.replace(/^\s*#\s+.*$/gm, ""); // remove any top-level title lines
  s = s.replace(/^\s*\*\*Source record:\*\*.*$/gim, "");
  s = s.replace(/^\s*\*\*Ledger status:\*\*.*$/gim, "");
  s = s.replace(/^\s*\*\*Lane:\*\*.*$/gim, "");
  s = s.replace(/^\s*\*\*Record:\*\*.*$/gim, "");
  s = s.replace(/^\s*\*\*Status:\*\*.*$/gim, "");

  // Trim excess blank lines after stripping
  s = s.replace(/\n{3,}/g, "\n\n").trim();

  if (!s.includes("<!-- memo_ready:v1 -->")) {
    s = `${s}\n\n<!-- memo_ready:v1 -->`;
  } else {
    // keep only first occurrence
    const idx = s.indexOf("<!-- memo_ready:v1 -->");
    s =
      s.slice(0, idx + "<!-- memo_ready:v1 -->".length) +
      s.slice(idx + "<!-- memo_ready:v1 -->".length).replace(/<!--\s*memo_ready:v1\s*-->/g, "");
    s = s.trim();
  }

  return s;
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
    const status = safeStr(rec.status) || "—";

    // 2) Generate advisory (preferred) with OpenAI, else fallback template
    let advisory = "";
    let modelName = "axiom-review-council:template";

    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (openaiKey) {
      const openai = new OpenAI({ apiKey: openaiKey });

      // OPTION A: CONTENT ONLY — NO META LINES, NO TITLE
      const prompt = `
You are AXIOM inside Oasis Digital Parliament.
You are advisory-only and non-binding.
You do NOT approve or reject; Council is the authority.

CRITICAL OUTPUT CONTRACT (must follow exactly):
- Output MUST start with "## Executive summary" (no leading title, no "#" heading, no metadata lines).
- Under each section heading, write ONLY bullet points (no paragraphs).
- "Risks / clarity checks": each bullet MUST start with [GREEN] or [YELLOW] or [RED].
- "Recommendations": 4–8 bullets max, EACH bullet must start with a verb (Confirm/Attach/Clarify/Ensure/Require/etc).
- "Questions to confirm": numbered list 1–5 ONLY if needed.
- Do NOT paste or quote the resolution text.
- Do NOT include any record metadata such as Source record / Ledger status / Lane / Record ID.

Return Markdown with EXACTLY these sections, in this exact order:

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

Context (for analysis only):
- Lane: ${lane}
- Ledger status: ${status}
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
      modelName = "axiom-review-council:v4";
    } else {
      advisory = normalizeAdvisory(fallbackTemplate(rec));
    }

    // 3) Insert ai_notes (ledger-scoped, lane-safe)
    const { data: noteRow, error: noteErr } = await admin
      .from("ai_notes")
      .insert({
        scope_type: SCOPE_TYPE_FOR_LEDGER,
        scope_id: rec.id,
        note_type: NOTE_TYPE_FOR_COUNCIL,
        // Keep title clean; memo PDF is authoritative for header/meta
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
