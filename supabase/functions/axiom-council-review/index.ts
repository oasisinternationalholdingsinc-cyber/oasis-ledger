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

function fallbackTemplate(rec: {
  id: string;
  title: string | null;
  status: string | null;
  is_test: boolean | null;
  body: string | null;
}) {
  const title = rec.title ?? "(untitled)";
  const bodyText = safeStr(rec.body);

  return [
    `# AXIOM Council Advisory`,
    ``,
    `**Record:** ${title}`,
    `**Status:** ${safeStr(rec.status) || "—"}`,
    `**Lane:** ${rec.is_test ? "SANDBOX" : "RoT"}`,
    ``,
    `## Executive summary`,
    `- What this resolution does (in plain language)`,
    `- Why the Board would approve it`,
    `- Top risks / unknowns`,
    ``,
    `## Risks / clarity checks`,
    `- [GREEN] Consistency: …`,
    `- [YELLOW] Evidence gaps: …`,
    `- [RED] Blocking issues (if any): …`,
    ``,
    `## Recommendations`,
    `- Approve / Reject rationale`,
    `- Attachments required before signature`,
    `- Wording fixes before sealing`,
    ``,
    `---`,
    `### Source text (truncated)`,
    bodyText.slice(0, 12000),
  ].join("\n");
}

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
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
Your job is to explain: what this record does, WHY, risks, and recommended next steps before signature/archive.

Return Markdown with EXACTLY these sections (keep concise, practical):
# AXIOM Council Advisory
**Record:** <title>
**Status:** <status>
**Lane:** <RoT|SANDBOX>

## Executive summary
- 3–6 bullets explaining the decision and why it exists.

## Risks / clarity checks
- Bullets grouped by severity tags: [GREEN], [YELLOW], [RED]
- Include the “why” and the risk in plain language.
- If something is missing, say what evidence/attachment would close the gap.

## Recommendations
- 4–8 bullets, action-oriented.
- Include “Approve if…” and/or “Reject/Send back if…” conditions.
- Include wording fixes if any.

## Questions to confirm
- Up to 5 short questions, only if needed.

Context:
- Lane: ${lane}
- Record type: ${recordType}
- Title: ${title}

Source text:
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
      modelName = "axiom-review-council:v2";
    } else {
      advisory = fallbackTemplate(rec);
    }

    // 3) Insert ai_notes (ledger-scoped, lane-safe)
    const { data: noteRow, error: noteErr } = await admin
      .from("ai_notes")
      .insert({
        scope_type: SCOPE_TYPE_FOR_LEDGER,
        scope_id: rec.id,
        note_type: NOTE_TYPE_FOR_COUNCIL,
        title: `AXIOM Council Advisory — ${title}`,
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
