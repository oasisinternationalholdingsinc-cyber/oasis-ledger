import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * AXIOM — axiom-extract-draft-facts
 *
 * PHASE 3 — Draft Advisory Extraction
 *
 * ─────────────────────────────────────────────────────────────
 * CONTRACT
 * ─────────────────────────────────────────────────────────────
 * ✅ Reads from public.governance_drafts
 * ✅ Writes ONLY to public.governance_draft_facts
 * ✅ Idempotent by draft_id
 * ✅ Operator-authenticated (JWT required)
 * ✅ Service-role writes
 * ✅ NEVER mutates authority_registry
 * ✅ Lane-safe (entity_id + is_test)
 */

type ReqBody = {
  draft_id?: string | null;
  id?: string | null;
  p_draft_id?: string | null;
  force?: boolean | null;
  model?: string | null;
};

type ExtractedFacts = {
  grants: any[];
  revokes: any[];
  modifies: any[];
  conditions: string[];
  effective_date?: string | null;
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
};

function json(status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
}

function getDraftId(body: ReqBody): string | null {
  return body.draft_id ?? body.p_draft_id ?? body.id ?? null;
}

function clampModel(m?: string | null): string {
  const fallback = "gpt-4.1-mini";
  if (!m) return fallback;
  const t = m.trim();
  return t || fallback;
}

async function callOpenAIExtract(args: {
  apiKey: string;
  model: string;
  title: string;
  draft_text: string;
  entity_name?: string | null;
  entity_slug?: string | null;
  is_test: boolean;
}) {
  const { apiKey, model, title, draft_text, entity_name, entity_slug, is_test } = args;

  const system = `
You are AXIOM, a governance fact-extraction engine.

Extract structured authority facts from a DRAFT corporate resolution.

Be conservative.
Do not infer intent not explicitly stated.
Output STRICT valid JSON.

Entity: ${entity_name ?? "unknown"} (${entity_slug ?? "unknown"})
Lane: ${is_test ? "SANDBOX" : "RoT"}

Return JSON format:

{
  "grants": [],
  "revokes": [],
  "modifies": [],
  "conditions": [],
  "effective_date": null
}
`;

  const user = `
TITLE:
${title}

DRAFT BODY:
${draft_text}
`;

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      text: { format: { type: "json_object" } },
      temperature: 0.1,
      max_output_tokens: 900,
    }),
  });

  const raw = await resp.json().catch(() => null);

  if (!resp.ok) {
    return { ok: false, error: raw?.error?.message ?? "OpenAI error" };
  }

  const outText =
    raw?.output_text ??
    raw?.output?.[0]?.content?.[0]?.text ??
    null;

  if (!outText) return { ok: false, error: "MODEL_NO_OUTPUT" };

  try {
    return { ok: true, facts: JSON.parse(outText) };
  } catch {
    return { ok: false, error: "MODEL_OUTPUT_NOT_JSON" };
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  const request_id = crypto.randomUUID();

  try {
    const body = (await req.json().catch(() => ({}))) as ReqBody;
    const draft_id = getDraftId(body);
    const force = Boolean(body.force);

    if (!draft_id) {
      return json(400, {
        ok: false,
        code: "MISSING_DRAFT_ID",
        request_id,
      });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY || !OPENAI_API_KEY) {
      return json(500, {
        ok: false,
        code: "MISSING_ENV",
        request_id,
      });
    }

    const authHeader = req.headers.get("authorization") ?? "";

    const anon = createClient(
      SUPABASE_URL,
      SUPABASE_ANON_KEY,
      { global: { headers: { authorization: authHeader } } }
    );

    const { data: userData } = await anon.auth.getUser();
    if (!userData?.user) {
      return json(401, {
        ok: false,
        code: "UNAUTHORIZED",
        request_id,
      });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: draft } = await admin
      .from("governance_drafts")
      .select("*")
      .eq("id", draft_id)
      .maybeSingle();

    if (!draft) {
      return json(404, {
        ok: false,
        code: "DRAFT_NOT_FOUND",
        request_id,
      });
    }

    if (draft.deleted_at) {
      return json(409, {
        ok: false,
        code: "DRAFT_DELETED",
        request_id,
      });
    }

    if (!["draft", "review"].includes(draft.status)) {
      return json(409, {
        ok: false,
        code: "INVALID_DRAFT_STATUS",
        request_id,
      });
    }

    const { data: existing } = await admin
      .from("governance_draft_facts")
      .select("id, facts_json")
      .eq("draft_id", draft_id)
      .maybeSingle();

    if (existing && !force) {
      return json(200, {
        ok: true,
        code: "FACTS_ALREADY_EXIST",
        draft_id,
        request_id,
      });
    }

    const ai = await callOpenAIExtract({
      apiKey: OPENAI_API_KEY,
      model: clampModel(body.model),
      title: draft.title,
      draft_text: draft.draft_text,
      entity_name: draft.entity_name,
      entity_slug: draft.entity_slug,
      is_test: draft.is_test,
    });

    if (!ai.ok || !ai.facts) {
      return json(502, {
        ok: false,
        code: "EXTRACTION_FAILED",
        request_id,
        error: ai.error,
      });
    }

    const { data: up } = await admin
      .from("governance_draft_facts")
      .upsert(
        {
          draft_id,
          entity_id: draft.entity_id,
          is_test: draft.is_test,
          facts_json: ai.facts,
          model: clampModel(body.model),
          extracted_at: new Date().toISOString(),
          created_by: userData.user.id,
        },
        { onConflict: "draft_id" }
      )
      .select("id")
      .maybeSingle();

    return json(200, {
      ok: true,
      code: "DRAFT_FACTS_EXTRACTED",
      draft_id,
      facts_id: up?.id ?? null,
      request_id,
    });
  } catch (e) {
    return json(500, {
      ok: false,
      code: "UNHANDLED",
      request_id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
});
