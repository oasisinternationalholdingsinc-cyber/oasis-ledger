// supabase/functions/scribe/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// ENV
// ---------------------------------------------------------------------------
const OPENAI_KEY =
  Deno.env.get("OPENAI_KEY") ??
  Deno.env.get("OPENAI_API_KEY") ??
  ""; // final fallback = empty string so we can debug

const SUPABASE_URL =
  Deno.env.get("SUPABASE_URL") ??
  Deno.env.get("SUPABASE_URL_INTERNAL") ??
  ""; // CLI usually injects SUPABASE_URL

const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  "";

// Central env debug block so we always know what runtime we're in
const ENV_DEBUG_BASE = {
  has_OPENAI_KEY: !!Deno.env.get("OPENAI_KEY"),
  has_OPENAI_API_KEY: !!Deno.env.get("OPENAI_API_KEY"),
  runtime: {
    SUPABASE_URL: SUPABASE_URL || null,
    has_SERVICE_ROLE_KEY: !!SERVICE_ROLE_KEY,
  },
};

// Log once to Supabase function logs so you can see it
console.log("SCRIBE ENV DEBUG (startup):", ENV_DEBUG_BASE);

// Supabase client (service role – backend only, bypasses RLS safely)
const supabase =
  SUPABASE_URL && SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
        global: { fetch },
      })
    : null;

// Simple JSON helper with CORS
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
    },
  });
}

// ---------------------------------------------------------------------------
// HTTP HANDLER
// ---------------------------------------------------------------------------
serve(async (req: Request): Promise<Response> => {
  try {
    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response("ok", {
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type, Authorization, apikey",
        },
      });
    }

    if (req.method !== "POST") {
      return json(
        { ok: false, stage: "method_check", error: "Use POST" },
        200,
      );
    }

    // Env checks (with debug)
    if (!OPENAI_KEY) {
      return json(
        {
          ok: false,
          stage: "env_openai",
          error: "Missing OPENAI_KEY / OPENAI_API_KEY in Supabase env",
          envDebug: ENV_DEBUG_BASE,
        },
        200,
      );
    }

    if (!supabase) {
      return json(
        {
          ok: false,
          stage: "env_supabase",
          error:
            "Missing SUPABASE_URL or SERVICE_ROLE_KEY / SUPABASE_SERVICE_ROLE_KEY in Supabase env",
          envDebug: ENV_DEBUG_BASE,
        },
        200,
      );
    }

    // Parse body
    let body: any;
    try {
      body = await req.json();
    } catch {
      return json(
        { ok: false, stage: "parse_body", error: "Invalid JSON body" },
        200,
      );
    }

    const {
      entity_slug,
      entity_name,
      title,
      type,
      instructions,
      tone = "formal",
      language = "English",
    } = body ?? {};

    const trimmedTitle = (title ?? "").trim();
    const trimmedInstructions = (instructions ?? "").trim();

    // -----------------------------------------------------------------------
    // INPUT VALIDATION
    // -----------------------------------------------------------------------
    if (!trimmedTitle || trimmedTitle.length < 5) {
      return json(
        {
          ok: false,
          stage: "validate",
          error:
            "Missing or invalid title. Please provide a meaningful title (at least 5 characters).",
          received: { title },
        },
        200,
      );
    }

    if (!type) {
      return json(
        {
          ok: false,
          stage: "validate",
          error: "Missing required field: type",
          received: { type },
        },
        200,
      );
    }

    if (!entity_slug) {
      return json(
        {
          ok: false,
          stage: "validate",
          error: "entity_slug is required for drafting",
        },
        200,
      );
    }

    if (!trimmedInstructions || trimmedInstructions.length < 30) {
      return json(
        {
          ok: false,
          stage: "validate",
          error:
            "Please describe what to draft (at least a few sentences of instructions).",
        },
        200,
      );
    }

    // -----------------------------------------------------------------------
    // STEP 1: Draft with OpenAI
    // -----------------------------------------------------------------------
    const prompt = `
You are **Oasis Scribe**, the drafting console of the Oasis Digital Parliament Ledger.

Context:
- Entity slug: ${entity_slug ?? "n/a"}
- Entity name: ${entity_name ?? "n/a"}
- Resolution type: ${type}
- Resolution title: ${trimmedTitle}
- Tone: ${tone}
- Language: ${language}

Task:
Draft a complete, clean, board-ready resolution text that a human director could sign.

Additional drafting instructions from the user:
"${trimmedInstructions}"

Output requirements:
- Write in ${language}.
- Use headings and numbered clauses where appropriate.
- Include "WHEREAS" clauses if suitable.
- Include a clear "RESOLVED THAT:" section with numbered resolutions.
- Do **not** include the signature lines; the signing system will attach those.
- Assume this will be stored in a digital governance ledger and read by lawyers.
`.trim();

    const oaRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0.25,
        messages: [
          {
            role: "system",
            content:
              "You are Oasis Scribe, an AI governance drafter for a digital corporate minute book. Draft precise, legally clean resolutions.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    });

    if (!oaRes.ok) {
      const txt = await oaRes.text().catch(() => null);
      return json(
        {
          ok: false,
          stage: "openai_http",
          error: "OpenAI call failed",
          status: oaRes.status,
          body: txt,
        },
        200,
      );
    }

    const oaData = await oaRes.json().catch(() => null);
    const draftText =
      oaData?.choices?.[0]?.message?.content?.trim() ??
      "No draft text returned from OpenAI.";
    const descriptionPreview =
      draftText.length > 240 ? draftText.slice(0, 240) + "…" : draftText;

    // -----------------------------------------------------------------------
    // STEP 2: Entity lookup
    // -----------------------------------------------------------------------
    const { data: entity, error: entityErr } = await supabase
      .from("entities")
      .select("id, slug, name")
      .eq("slug", entity_slug)
      .single();

    if (entityErr || !entity) {
      return json(
        {
          ok: false,
          stage: "entity_lookup",
          error: "Entity not found for given entity_slug",
          entity_slug,
          details: entityErr,
        },
        200,
      );
    }

    const entityId = (entity as any).id as string;
    const entityName = entity_name ?? (entity as any).name ?? "Unknown Entity";

    // -----------------------------------------------------------------------
    // STEP 3: Map type → record_type
    // -----------------------------------------------------------------------
    let recordType: string;
    switch (type) {
      case "meeting_minutes":
      case "meeting":
        recordType = "meeting";
        break;
      case "decision":
      case "decision_memo":
        recordType = "decision";
        break;
      case "board_resolution":
      default:
        recordType = "resolution";
        break;
    }

    // -----------------------------------------------------------------------
    // STEP 4: Insert into governance_drafts
    // -----------------------------------------------------------------------
    const { data: draftRow, error: draftErr } = await supabase
      .from("governance_drafts")
      .insert({
        entity_id: entityId,
        entity_slug: entity.slug,
        entity_name: entityName,
        title: trimmedTitle,
        record_type: recordType,
        draft_text: draftText,
        status: "draft",
      })
      .select("id, status, created_at")
      .single();

    if (draftErr || !draftRow) {
      return json(
        {
          ok: false,
          stage: "insert_draft",
          error: "Failed to insert into governance_drafts",
          details: draftErr,
        },
        200,
      );
    }

    // -----------------------------------------------------------------------
    // SUCCESS
    // -----------------------------------------------------------------------
    return json(
      {
        ok: true,
        stage: "draft_saved",
        role: "scribe",
        engine: "gpt-4.1-mini",
        entity_slug: entity.slug,
        entity_id: entityId,
        entity_name: entityName,
        draft_id: draftRow.id,
        draft_status: draftRow.status,
        draft_created_at: draftRow.created_at,
        title: trimmedTitle,
        record_type: recordType,
        type,
        tone,
        language,
        description_preview: descriptionPreview,
        draft: draftText,
      },
      200,
    );
  } catch (e: any) {
    console.error("Scribe exception:", e);
    return json(
      {
        ok: false,
        stage: "exception",
        error: String(e?.message ?? e),
        stack: e?.stack ?? null,
        envDebug: ENV_DEBUG_BASE,
      },
      200,
    );
  }
});
