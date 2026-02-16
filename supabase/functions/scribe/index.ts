// supabase/functions/scribe/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/* -------------------------------------------------------------------------- */
/* ENV                                                                        */
/* -------------------------------------------------------------------------- */

const OPENAI_KEY = Deno.env.get("OPENAI_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");

const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

// OPTIONAL (for actor attribution via JWT)
const SUPABASE_ANON_KEY =
  Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("ANON_KEY") ?? null;

const supabase =
  SUPABASE_URL && SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
        global: { fetch },
      })
    : null;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
  };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input ?? "");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const arr = Array.from(new Uint8Array(digest));
  return arr.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeText(v: unknown): string | null {
  if (v == null) return null;
  const t = String(v).trim();
  return t.length ? t : null;
}

/**
 * Resolve authenticated actor from request JWT (NO REGRESSION):
 * - If ANON key or Authorization header is missing, returns null actor.
 * - Does NOT block drafting (fail-soft).
 */
async function resolveActor(req: Request): Promise<{
  actor_id: string | null;
  actor_email: string | null;
}> {
  try {
    const authHeader = req.headers.get("Authorization");
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return { actor_id: null, actor_email: null };
    if (!authHeader) return { actor_id: null, actor_email: null };

    const authed = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: {
        fetch,
        headers: { Authorization: authHeader },
      },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data, error } = await authed.auth.getUser();
    if (error || !data?.user) return { actor_id: null, actor_email: null };

    return {
      actor_id: data.user.id ?? null,
      actor_email: (data.user.email as string) ?? null,
    };
  } catch {
    return { actor_id: null, actor_email: null };
  }
}

async function insertDraftEventFailSoft(row: Record<string, unknown>) {
  try {
    if (!supabase) return;
    const { error } = await supabase.from("governance_draft_events").insert(row);
    if (error) console.error("governance_draft_events insert failed (non-fatal)", error);
  } catch (e) {
    console.error("governance_draft_events insert threw (non-fatal)", e);
  }
}

/* -------------------------------------------------------------------------- */
/* Handler                                                                    */
/* -------------------------------------------------------------------------- */

serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { status: 200, headers: corsHeaders() });
    }

    if (req.method !== "POST") {
      return json({ ok: false, stage: "method_check", error: "Use POST" });
    }

    if (!OPENAI_KEY) {
      return json({ ok: false, stage: "env_openai", error: "Missing OPENAI_KEY" });
    }

    if (!supabase) {
      return json({
        ok: false,
        stage: "env_supabase",
        error: "Missing SUPABASE_URL or SERVICE_ROLE_KEY",
      });
    }

    const body = await req.json().catch(() => null);
    if (!body) {
      return json({ ok: false, stage: "parse_body", error: "Invalid JSON body" });
    }

    const {
      draft_id, // optional (update mode)
      entity_slug,
      entity_name,
      title,
      type,
      instructions,
      tone = "formal",
      language = "English",
      is_test, // 🔒 lane passed explicitly from UI
    } = body ?? {};

    const trimmedTitle = (title ?? "").trim();
    const trimmedInstructions = (instructions ?? "").trim();

    if (!trimmedInstructions || trimmedInstructions.length < 30) {
      return json({
        ok: false,
        stage: "validate",
        error: "Provide meaningful drafting instructions (min 30 chars).",
      });
    }

    // ✅ NEW: actor attribution (fail-soft, no regression)
    const { actor_id, actor_email } = await resolveActor(req);

    /* ---------------------------------------------------------------------- */
    /* LOAD EXISTING DRAFT IF draft_id PROVIDED                               */
    /* ---------------------------------------------------------------------- */

    let existingDraft: any = null;

    if (draft_id) {
      const { data, error } = await supabase
        .from("governance_drafts")
        .select("*")
        .eq("id", draft_id)
        .single();

      if (error || !data) {
        return json({
          ok: false,
          stage: "load_draft",
          error: "Draft not found. Refusing to create duplicate.",
        });
      }

      existingDraft = data;
    }

    /* ---------------------------------------------------------------------- */
    /* ENTITY LOOKUP (only needed if creating new draft)                      */
    /* ---------------------------------------------------------------------- */

    let entityId: string | null = null;
    let resolvedEntitySlug = entity_slug;
    let resolvedEntityName = entity_name;

    if (!existingDraft) {
      if (!entity_slug || !trimmedTitle || !type) {
        return json({
          ok: false,
          stage: "validate",
          error: "entity_slug, title, and type are required for new drafts.",
        });
      }

      const { data: entity, error: entityErr } = await supabase
        .from("entities")
        .select("id, slug, name")
        .eq("slug", entity_slug)
        .single();

      if (entityErr || !entity) {
        return json({
          ok: false,
          stage: "entity_lookup",
          error: "Entity not found",
        });
      }

      entityId = entity.id;
      resolvedEntitySlug = entity.slug;
      resolvedEntityName = entity_name ?? entity.name;
    } else {
      entityId = existingDraft.entity_id;
      resolvedEntitySlug = existingDraft.entity_slug;
      resolvedEntityName = existingDraft.entity_name;
    }

    /* ---------------------------------------------------------------------- */
    /* RECORD TYPE MAPPING                                                    */
    /* ---------------------------------------------------------------------- */

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
      default:
        recordType = "resolution";
        break;
    }

    /* ---------------------------------------------------------------------- */
    /* OPENAI GENERATION                                                      */
    /* ---------------------------------------------------------------------- */

    const prompt = `
You are Oasis Scribe, governance drafting AI.

Entity: ${resolvedEntityName}
Slug: ${resolvedEntitySlug}
Title: ${trimmedTitle ?? existingDraft?.title}
Type: ${recordType}
Tone: ${tone}
Language: ${language}

Instructions:
"${trimmedInstructions}"

Draft a legally clean, board-ready document.
Include WHEREAS clauses if suitable.
Include clear RESOLVED THAT section.
Do not include signature blocks.
`.trim();

    const model = "gpt-4.1-mini";
    const temperature = 0.25;

    const oaRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature,
        messages: [
          {
            role: "system",
            content: "You draft precise corporate governance resolutions for digital minute books.",
          },
          { role: "user", content: prompt },
        ],
      }),
    });

    if (!oaRes.ok) {
      const txt = await oaRes.text().catch(() => null);
      return json({
        ok: false,
        stage: "openai_http",
        status: oaRes.status,
        body: txt,
      });
    }

    const oaData = await oaRes.json();
    const draftText =
      oaData?.choices?.[0]?.message?.content?.trim() ?? "No draft returned.";

    const descriptionPreview =
      draftText.length > 240 ? draftText.slice(0, 240) + "…" : draftText;

    /* ---------------------------------------------------------------------- */
    /* TRACEABILITY (NEW, NO REGRESSION)                                      */
    /* ---------------------------------------------------------------------- */

    const prompt_hash = await sha256Hex(prompt);
    const instructions_hash = await sha256Hex(trimmedInstructions);

    /* ---------------------------------------------------------------------- */
    /* UPDATE OR INSERT (LANE SAFE)                                           */
    /* ---------------------------------------------------------------------- */

    let draftRow: any;

    if (existingDraft) {
      const { data, error } = await supabase
        .from("governance_drafts")
        .update({
          draft_text: draftText,

          // keep prior behavior (no regression)
          updated_at: new Date().toISOString(),

          // ✅ NEW: attribution
          updated_by: actor_id ?? null,
        })
        .eq("id", draft_id)
        .select("id, status, updated_at, entity_id, entity_slug, entity_name, title, record_type, is_test")
        .single();

      if (error || !data) {
        return json({
          ok: false,
          stage: "update_draft",
          error: "Failed to update draft",
        });
      }

      draftRow = data;

      // ✅ NEW: append event (fail-soft, no regression)
      await insertDraftEventFailSoft({
        draft_id: draftRow.id,
        actor_id: actor_id ?? null,
        actor_email: actor_email ?? null,
        is_test: !!draftRow.is_test,
        entity_id: draftRow.entity_id ?? null,
        entity_slug: draftRow.entity_slug ?? null,
        title: draftRow.title ?? null,
        model,
        temperature,
        prompt_hash,
        instructions_hash,
        created_at: new Date().toISOString(),
      });
    } else {
      const now = new Date().toISOString();

      const { data, error } = await supabase
        .from("governance_drafts")
        .insert({
          entity_id: entityId,
          entity_slug: resolvedEntitySlug,
          entity_name: resolvedEntityName,
          title: trimmedTitle,
          record_type: recordType,
          draft_text: draftText,
          status: "draft",
          is_test: !!is_test, // 🔒 explicit lane stamp

          // ✅ NEW: attribution
          created_by: actor_id ?? null,
          updated_by: actor_id ?? null,

          // keep prior behavior (no regression)
          created_at: now,
          updated_at: now,
        })
        .select("id, status, created_at, entity_id, entity_slug, entity_name, title, record_type, is_test")
        .single();

      if (error || !data) {
        return json({
          ok: false,
          stage: "insert_draft",
          error: "Failed to insert draft",
        });
      }

      draftRow = data;

      // ✅ NEW: append event (fail-soft, no regression)
      await insertDraftEventFailSoft({
        draft_id: draftRow.id,
        actor_id: actor_id ?? null,
        actor_email: actor_email ?? null,
        is_test: !!draftRow.is_test,
        entity_id: draftRow.entity_id ?? null,
        entity_slug: draftRow.entity_slug ?? null,
        title: draftRow.title ?? null,
        model,
        temperature,
        prompt_hash,
        instructions_hash,
        created_at: new Date().toISOString(),
      });
    }

    /* ---------------------------------------------------------------------- */
    /* SUCCESS                                                                */
    /* ---------------------------------------------------------------------- */

    return json({
      ok: true,
      stage: "draft_saved",
      role: "scribe",
      engine: model,

      // ✅ NEW: traceability surfaced (read-only)
      actor_id,
      actor_email,
      prompt_hash,
      instructions_hash,

      entity_slug: resolvedEntitySlug,
      entity_id: entityId,
      entity_name: resolvedEntityName,
      draft_id: draftRow.id,
      draft_status: draftRow.status,
      title: trimmedTitle ?? existingDraft?.title,
      record_type: recordType,
      tone,
      language,
      description_preview: descriptionPreview,
      draft: draftText,
    });
  } catch (e: any) {
    return json({
      ok: false,
      stage: "exception",
      error: String(e?.message ?? e),
      stack: e?.stack ?? null,
    });
  }
});
