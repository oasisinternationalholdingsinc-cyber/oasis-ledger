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
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY)
      return { actor_id: null, actor_email: null };
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
    if (error)
      console.error("governance_draft_events insert failed (non-fatal)", error);
  } catch (e) {
    console.error("governance_draft_events insert threw (non-fatal)", e);
  }
}

function normalizeType(type: unknown): "meeting" | "decision" | "resolution" {
  const t = String(type ?? "").toLowerCase().trim();
  if (t === "meeting_minutes" || t === "meeting") return "meeting";
  if (t === "decision" || t === "decision_memo") return "decision";
  return "resolution";
}

/* -------------------------------------------------------------------------- */
/* Jurisdiction / Authority Hint (ACTIVATES ONLY WHEN EXPLICITLY MENTIONED)   */
/* -------------------------------------------------------------------------- */

function detectJurisdictionAuthority(instructionsRaw: string): {
  jurisdiction: string | null;
  authority_basis: string | null; // short authority name only
} {
  const s = String(instructionsRaw ?? "").toLowerCase();

  // Canada / Ontario
  if (/\bobca\b/.test(s) || /\bontario\b/.test(s)) {
    return {
      jurisdiction: "Ontario, Canada",
      authority_basis: "Business Corporations Act (Ontario)",
    };
  }

  if (/\bcbca\b/.test(s) || /\bcanada\b/.test(s)) {
    return {
      jurisdiction: "Canada",
      authority_basis: "Canada Business Corporations Act",
    };
  }

  // USA / Delaware
  if (/\bdgcl\b/.test(s) || /\bdelaware\b/.test(s)) {
    return {
      jurisdiction: "Delaware, USA",
      authority_basis: "Delaware General Corporation Law",
    };
  }

  // UK
  if (
    /\bcompanies act\b/.test(s) ||
    /\buk\b/.test(s) ||
    /\bunited kingdom\b/.test(s)
  ) {
    return {
      jurisdiction: "United Kingdom",
      authority_basis: "Companies Act 2006",
    };
  }

  // If user explicitly says "jurisdiction:" / "governing law:" but we can't confidently map, we do NOT invent.
  if (/\bjurisdiction\s*:\b/.test(s) || /\bgoverning law\s*:\b/.test(s)) {
    return { jurisdiction: "As specified in instructions", authority_basis: null };
  }

  return { jurisdiction: null, authority_basis: null };
}

/* -------------------------------------------------------------------------- */
/* OpenAI Helpers (NO WIRING CHANGE)                                          */
/* -------------------------------------------------------------------------- */

async function openaiChat(args: {
  model: string;
  temperature: number;
  system: string;
  user: string;
}): Promise<{ ok: boolean; text: string; error?: any }> {
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: args.model,
        temperature: args.temperature,
        messages: [
          { role: "system", content: args.system },
          { role: "user", content: args.user },
        ],
      }),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => null);
      return { ok: false, text: "", error: { status: res.status, body: txt } };
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim() ?? "";
    return { ok: true, text };
  } catch (e) {
    return { ok: false, text: "", error: String(e) };
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

    // ✅ actor attribution (fail-soft, no regression)
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
    /* RECORD TYPE                                                            */
    /* ---------------------------------------------------------------------- */

    const recordType = normalizeType(type);

    /* ---------------------------------------------------------------------- */
    /* ENTERPRISE DOCTRINE (NEW — NO REWIRING)                                */
    /* ---------------------------------------------------------------------- */

    const { jurisdiction, authority_basis } =
      detectJurisdictionAuthority(trimmedInstructions);

    const systemDoctrine = `
You are Oasis Scribe — enterprise governance drafting AI.

Non-negotiables:
- Produce a board-ready ${recordType} document appropriate for a corporate minute book.
- Be litigation-grade: precise language, clean structure, no fluff.
- Avoid overstatement: do NOT claim registry certification unless explicitly instructed.
- Use clear modal verbs: "shall" for obligations, "may" for permissions.
- Avoid redundancy; each WHEREAS or RESOLVED clause must add unique meaning.
- Include an effective timing clause when applicable (e.g., "effective as of").
- Avoid signature blocks (no signature lines, no director names line items).
- Use neutral, professional tone (not combative, not defensive).
- If sandbox/testing is stated, keep it to ONE tight clause that limits effect.

Jurisdiction / authority basis rule (STRICT):
- ONLY if the user explicitly mentions a jurisdiction or statute in the Instructions, you may add ONE short authority reference.
- Do NOT invent statutes, sections, or legal citations.
- If a statute name is available (e.g., "OBCA", "CBCA", "DGCL"), you may expand it to its plain name.
- Keep it to a single clause like: "pursuant to the Corporation's constating documents and applicable corporate statute" or name the statute if provided.

Output format:
- Header line(s)
- WHEREAS clauses (when suitable)
- NOW, THEREFORE, BE IT RESOLVED THAT:
- Numbered resolutions
- Adoption line with blank date line (no signatures)
`.trim();

    // ✅ This remains the single "prompt" string for hashing & traceability (no regression)
    // ✅ NEW (conditional): jurisdiction hint only when instructions explicitly include it.
    const jurisdictionHintBlock =
      jurisdiction || authority_basis
        ? `
Jurisdiction Hint (use ONLY because it was explicitly mentioned in Instructions):
- Jurisdiction: ${jurisdiction ?? "as specified"}
- Authority basis: ${
            authority_basis ??
            "do not name a statute; use generic 'applicable corporate statute'"
          }
- Rule: include at most ONE brief authority clause; do NOT cite sections unless the user provided them.
`.trim()
        : "";

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
${jurisdictionHintBlock ? `\n\n${jurisdictionHintBlock}\n` : ""}

Draft a legally clean, board-ready document.
Include WHEREAS clauses if suitable.
Include clear RESOLVED THAT section.
Do not include signature blocks.
`.trim();

    const model = "gpt-4.1-mini";
    const temperature = 0.25;

    /* ---------------------------------------------------------------------- */
    /* OPENAI GENERATION (PASS 1)                                             */
    /* ---------------------------------------------------------------------- */

    const gen1 = await openaiChat({
      model,
      temperature,
      system: systemDoctrine,
      user: prompt,
    });

    if (!gen1.ok) {
      return json({
        ok: false,
        stage: "openai_http",
        status: gen1.error?.status ?? 500,
        body: gen1.error?.body ?? String(gen1.error ?? "OpenAI error"),
      });
    }

    let draftText = gen1.text?.trim() || "No draft returned.";

    const descriptionPreview =
      draftText.length > 240 ? draftText.slice(0, 240) + "…" : draftText;

    /* ---------------------------------------------------------------------- */
    /* OPTIONAL STRUCTURAL AUDIT (PASS 2) — FAIL-SOFT, NO REGRESSION           */
    /* ---------------------------------------------------------------------- */
    try {
      const auditUser = `
Perform a structural audit ONLY (do not add new ideas):

Check:
- Redundancy / duplicated clauses
- Modal ambiguity ("may" vs "shall")
- Missing effective timing clause (if relevant)
- Overstatement of registry authority
- Missing clarity about sandbox/testing limitation (if stated)
- Jurisdiction/authority rule: do NOT add a statute unless explicitly present in the document/instructions; if present, keep it to ONE brief clause with no sections unless provided.

If improvements are needed, return the revised full document.
If already strong, return the original unchanged.

Document:
${draftText}
`.trim();

      const gen2 = await openaiChat({
        model,
        temperature: 0.15,
        system: "You are a governance document auditor. Structural corrections only.",
        user: auditUser,
      });

      if (gen2.ok && gen2.text && gen2.text.trim().length > 50) {
        draftText = gen2.text.trim();
      }
    } catch {
      // fail-soft
    }

    /* ---------------------------------------------------------------------- */
    /* TRACEABILITY (NO REGRESSION)                                           */
    /* ---------------------------------------------------------------------- */

    const prompt_hash = await sha256Hex(prompt);
    const instructions_hash = await sha256Hex(trimmedInstructions);

    /* ---------------------------------------------------------------------- */
    /* UPDATE OR INSERT (LANE SAFE — NO REWIRING)                             */
    /* ---------------------------------------------------------------------- */

    let draftRow: any;

    if (existingDraft) {
      const { data, error } = await supabase
        .from("governance_drafts")
        .update({
          draft_text: draftText,
          updated_at: new Date().toISOString(),
          updated_by: actor_id ?? null,
        })
        .eq("id", draft_id)
        .select(
          "id, status, updated_at, entity_id, entity_slug, entity_name, title, record_type, is_test",
        )
        .single();

      if (error || !data) {
        return json({
          ok: false,
          stage: "update_draft",
          error: "Failed to update draft",
        });
      }

      draftRow = data;

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
          is_test: !!is_test,

          created_by: actor_id ?? null,
          updated_by: actor_id ?? null,

          created_at: now,
          updated_at: now,
        })
        .select(
          "id, status, created_at, entity_id, entity_slug, entity_name, title, record_type, is_test",
        )
        .single();

      if (error || !data) {
        return json({
          ok: false,
          stage: "insert_draft",
          error: "Failed to insert draft",
        });
      }

      draftRow = data;

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
    /* SUCCESS (NO RESPONSE SHAPE REGRESSION)                                 */
    /* ---------------------------------------------------------------------- */

    return json({
      ok: true,
      stage: "draft_saved",
      role: "scribe",
      engine: model,

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
