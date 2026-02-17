// supabase/functions/axiom-pre-draft-review/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import OpenAI from "https://esm.sh/openai@4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function safeJsonParse<T = any>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function normalizeUuid(s: unknown): string | null {
  const v = String(s ?? "").trim();
  if (!v) return null;
  // basic guard; DB will still validate
  return v;
}

function fmtSeverity(sev: unknown) {
  const s = String(sev ?? "").toLowerCase();
  if (s === "critical") return "CRITICAL";
  if (s === "warning") return "WARNING";
  return "INFO";
}

function buildAuthorityAdvisoryBlock(conflictsResult: any): string {
  const ok = Boolean(conflictsResult?.ok);
  if (!ok) {
    const code = conflictsResult?.code ? String(conflictsResult.code) : "UNKNOWN";
    return [
      `## Authority Conflict Advisory (Phase 3)`,
      ``,
      `Status: UNAVAILABLE`,
      `Code: ${code}`,
    ].join("\n");
  }

  const severity = fmtSeverity(conflictsResult?.severity);
  const conflicts = Array.isArray(conflictsResult?.conflicts)
    ? conflictsResult.conflicts
    : [];

  const lines: string[] = [];
  lines.push(`## Authority Conflict Advisory (Phase 3)`);
  lines.push(``);
  lines.push(`Severity: **${severity}**`);
  lines.push(`Conflicts: **${conflicts.length}**`);
  lines.push(``);

  if (conflicts.length === 0) {
    lines.push(`- None detected against current authority_registry baseline.`);
    return lines.join("\n");
  }

  for (const c of conflicts) {
    const type = c?.type ? String(c.type) : "conflict";
    const subject = c?.subject ? String(c.subject) : "";
    const action = c?.action ? String(c.action) : "";
    const scope = c?.scope ? String(c.scope) : "";

    const existingLimit =
      c?.existing_limit !== undefined && c?.existing_limit !== null
        ? String(c.existing_limit)
        : null;
    const draftLimit =
      c?.draft_limit !== undefined && c?.draft_limit !== null
        ? String(c.draft_limit)
        : null;

    const extra: string[] = [];
    if (existingLimit || draftLimit) {
      extra.push(
        `existing=${existingLimit ?? "—"} • draft=${draftLimit ?? "—"}`
      );
    }

    const grantedBy =
      c?.existing_granted_by !== undefined && c?.existing_granted_by !== null
        ? String(c.existing_granted_by)
        : null;
    if (grantedBy) extra.push(`granted_by=${grantedBy}`);

    const head = `- **${type}** — ${[subject, action, scope]
      .filter(Boolean)
      .join(" / ")}`;

    if (extra.length) {
      lines.push(`${head} (${extra.join(" • ")})`);
    } else {
      lines.push(head);
    }
  }

  lines.push(``);
  lines.push(
    `> Advisory-only. This does not approve, reject, or execute anything. Validate against Council/Forge/Archive as required.`
  );

  return lines.join("\n");
}

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    if (req.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const openaiKey = Deno.env.get("OPENAI_API_KEY");

    if (!supabaseUrl || !anonKey || !serviceKey) {
      return json({ ok: false, error: "Missing Supabase env vars" }, 500);
    }
    if (!openaiKey) {
      return json({ ok: false, error: "Missing OPENAI_API_KEY" }, 500);
    }

    const authHeader = req.headers.get("authorization");
    if (!authHeader?.toLowerCase().startsWith("bearer ")) {
      return json({ ok: false, error: "Missing authorization header" }, 401);
    }

    // 1) Identify the user from the JWT (anon client w/ Authorization passthrough)
    const supabaseAuth = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userErr } = await supabaseAuth.auth.getUser();
    if (userErr || !userData?.user) {
      return json({ ok: false, error: "Invalid session" }, 401);
    }
    const userId = userData.user.id;

    // 2) Parse input
    const body = await req.json().catch(() => ({}));
    const draft_id = normalizeUuid(body?.draft_id);
    const trigger: string = body?.trigger ?? "alchemy-pre-finalize";

    if (!draft_id) {
      return json({ ok: false, error: "Missing draft_id" }, 400);
    }

    // 3) Service role client for DB operations (bypass RLS) but we still set created_by=userId
    const supabaseSrv = createClient(supabaseUrl, serviceKey);

    // 4) Load the draft (NO schema drift — align to your current governance_drafts columns)
    const { data: draft, error: draftErr } = await supabaseSrv
      .from("governance_drafts")
      .select("id, title, record_type, draft_text, entity_slug, entity_id, is_test")
      .eq("id", draft_id)
      .maybeSingle();

    if (draftErr) return json({ ok: false, error: draftErr.message }, 500);
    if (!draft) return json({ ok: false, error: "Draft not found" }, 404);

    const draftTitle = draft.title ?? "Untitled draft";
    const recordType = draft.record_type ?? "resolution";
    const entitySlug = draft.entity_slug ?? "unknown";
    const lane = draft.is_test ? "SANDBOX" : "RoT";

    /* =========================================================
       A) Ensure / refresh structured facts (Edge Function)
       - MUST be called with operator JWT (Authorization) + apikey
       - This is advisory-only sidecar write: governance_draft_facts
    ========================================================= */
    let extractFactsOk = false;
    let extractedFactsId: string | null = null;
    let extractFactsErr: string | null = null;

    try {
      const resp = await fetch(
        `${supabaseUrl}/functions/v1/axiom-extract-draft-facts`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: authHeader,
            apikey: anonKey,
          },
          body: JSON.stringify({
            draft_id,
            trigger: trigger ?? "alchemy-pre-finalize",
          }),
        }
      );

      const txt = await resp.text();
      const j = safeJsonParse<any>(txt) ?? { raw: txt };

      if (!resp.ok) {
        extractFactsErr =
          j?.error ? String(j.error) : `axiom-extract-draft-facts failed (${resp.status})`;
      } else {
        extractFactsOk = Boolean(j?.ok ?? true);
        extractedFactsId =
          (j?.facts_id ? String(j.facts_id) : null) ??
          (j?.id ? String(j.id) : null);
      }
    } catch (e) {
      extractFactsErr = String((e as any)?.message ?? e);
    }

    /* =========================================================
       B) Run Authority Conflict Check (SECURITY DEFINER RPC)
       - Runs under service_role but function enforces auth.uid()
       - So we must SET request.jwt claims for this session
       - (keeps SQL locked; no DB changes)
    ========================================================= */
    let conflictsResult: any = null;
    try {
      // Set request.jwt claims so SECURITY DEFINER function sees auth.uid()
      // (Supabase auth helpers read from these settings)
      await supabaseSrv.rpc("set_config" as any, {
        setting_name: "request.jwt.claim.sub",
        new_value: String(userId),
        is_local: true,
      } as any).catch(() => {});

      await supabaseSrv.rpc("set_config" as any, {
        setting_name: "request.jwt.claim.role",
        new_value: "authenticated",
        is_local: true,
      } as any).catch(() => {});

      const { data: conflictsData, error: conflictsErr } = await supabaseSrv.rpc(
        "check_draft_authority_conflicts",
        { p_draft_id: draft_id }
      );

      if (conflictsErr) {
        conflictsResult = { ok: false, code: "CONFLICT_CHECK_FAILED", error: conflictsErr.message };
      } else {
        conflictsResult = conflictsData ?? { ok: false, code: "NO_RESULT" };
      }
    } catch (e) {
      conflictsResult = { ok: false, code: "CONFLICT_CHECK_THROW", error: String((e as any)?.message ?? e) };
    }

    const authorityBlock = buildAuthorityAdvisoryBlock(conflictsResult);

    const prompt = `
You are AXIOM inside Oasis Digital Parliament.
You are advisory-only (non-binding). Do not claim approvals or execution.
Draft stage: you must not modify files or create ledger records; only produce a review.

Return in Markdown with these sections:
1) Executive summary (3-6 bullets)
2) Risk / clarity checks (bullets)
3) Suggested edits (non-binding) (bullets)
4) Questions to confirm (optional, max 5)

Context:
- Entity: ${entitySlug}
- Lane: ${lane}
- Record type: ${recordType}
- Draft title: ${draftTitle}

Draft text:
${draft.draft_text ?? ""}
`.trim();

    // 5) Run OpenAI (NO CHANGE)
    const openai = new OpenAI({ apiKey: openaiKey });

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: "You are AXIOM. Advisory-only. Draft-stage review." },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
    });

    const content = completion.choices?.[0]?.message?.content?.trim() ?? "";
    const tokensUsed = completion.usage?.total_tokens ?? null;

    // 6) Insert ai_notes (KEEP EXACT schema/filters; append advisory block)
    const noteTitle = `AXIOM • ${draftTitle}`;
    const modelName = "axiom-pre-draft-review:v1";

    const advisoryMetaLines: string[] = [];
    advisoryMetaLines.push(``);
    advisoryMetaLines.push(`---`);
    advisoryMetaLines.push(`Trigger: ${trigger}`);
    advisoryMetaLines.push(
      `Facts extraction: ${extractFactsOk ? "ok" : "failed"}${
        extractedFactsId ? ` (facts_id=${extractedFactsId})` : ""
      }${extractFactsErr ? ` • error=${extractFactsErr}` : ""}`
    );

    const finalNoteContent = [
      `AXIOM DRAFT REVIEW (Advisory-only)`,
      ``,
      `Entity: ${entitySlug}`,
      `Lane: ${lane}`,
      `Draft: ${draftTitle}`,
      `Record type: ${recordType}`,
      ``,
      content,
      ``,
      authorityBlock,
      ...advisoryMetaLines,
    ].join("\n");

    const { data: noteRow, error: noteErr } = await supabaseSrv
      .from("ai_notes")
      .insert({
        scope_type: "document", // enum note_scope_type
        scope_id: draft_id,
        note_type: "summary", // keep exactly what Alchemy filters for
        title: noteTitle,
        content: finalNoteContent,
        model: modelName,
        tokens_used: tokensUsed,
        created_by: userId,
      })
      .select("id, created_at")
      .single();

    if (noteErr) return json({ ok: false, error: noteErr.message }, 500);

    return json({
      ok: true,
      note_id: noteRow.id,
      created_at: noteRow.created_at,
      scope_type: "document",
      scope_id: draft_id,
      note_type: "summary",
      model: modelName,
      tokens_used: tokensUsed,

      // extra observability (non-breaking)
      facts_extraction: {
        ok: extractFactsOk,
        facts_id: extractedFactsId,
        error: extractFactsErr,
      },
      authority_conflicts: {
        ok: Boolean(conflictsResult?.ok),
        severity: conflictsResult?.severity ?? "info",
        conflicts_count: Array.isArray(conflictsResult?.conflicts)
          ? conflictsResult.conflicts.length
          : 0,
      },
    });
  } catch (e) {
    return json({ ok: false, error: String((e as any)?.message ?? e) }, 500);
  }
});
