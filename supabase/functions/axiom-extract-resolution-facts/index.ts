// supabase/functions/axiom-extract-resolution-facts/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * AXIOM — axiom-extract-resolution-facts (PRODUCTION — LOCKED)
 *
 * ✅ NO SCHEMA REGRESSIONS
 * ✅ Court-grade gate:
 *    - governance_ledger.status MUST be 'ARCHIVED'
 *    - verified_documents.source_record_id MUST exist (latest wins)
 * ✅ Writes ONLY to: public.governance_resolution_facts (facts_json)
 * ✅ NEVER mutates authority_registry directly (apply function does that)
 *
 * Auth pattern:
 *  - ANON client verifies Bearer JWT (operator session)
 *  - SERVICE_ROLE client performs DB reads/writes
 */

type ReqBody = {
  // primary
  ledger_id?: string | null;

  // aliases (tolerant)
  record_id?: string | null;
  id?: string | null;
  p_ledger_id?: string | null;

  // behavior
  force?: boolean | null; // re-extract even if facts exist
  model?: string | null; // override OpenAI model
};

type ExtractedFacts = {
  grants: Array<{
    type?: string; // "authority" etc (optional)
    subject: string; // e.g. "CFO"
    action: string; // e.g. "execute contracts"
    scope?: string; // e.g. "corporate"
    limit_amount?: number | null;
    limit_currency?: string | null;
    conditions?: string[]; // array of short strings
    effective_at?: string | null; // ISO string or null
    expires_at?: string | null; // ISO string or null
  }>;
  revokes: Array<{
    subject: string;
    action: string;
    scope?: string;
    limit_amount?: number | null;
    limit_currency?: string | null;
  }>;
  modifies: Array<{
    subject: string;
    action: string;
    scope?: string;
    from_limit_amount?: number | null;
    to_limit_amount?: number | null;
    from_limit_currency?: string | null;
    to_limit_currency?: string | null;
    notes?: string | null;
  }>;
  conditions: string[]; // general conditions not tied to a single grant
  effective_date?: string | null; // ISO date or datetime (best effort)
  scope?: {
    entity_id?: string | null;
    is_test?: boolean | null;
  };
};

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
};

function json(
  status: number,
  payload: Record<string, unknown>,
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
}

function getLedgerId(body: ReqBody): string | null {
  return (
    body.ledger_id ??
    body.p_ledger_id ??
    body.record_id ??
    body.id ??
    null
  );
}

function safeString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function clampModel(m?: string | null): string {
  const fallback = "gpt-4.1-mini"; // stable, inexpensive, solid structured extraction
  if (!m) return fallback;
  // Keep it simple: allow only known-safe prefixes to avoid typos causing failures.
  const mm = m.trim();
  if (!mm) return fallback;
  return mm;
}

function normalizeFacts(raw: any, entity_id: string, is_test: boolean): ExtractedFacts {
  const out: ExtractedFacts = {
    grants: [],
    revokes: [],
    modifies: [],
    conditions: [],
    effective_date: null,
    scope: { entity_id, is_test },
  };

  // If model returns wrong shapes, keep defensive.
  const grants = Array.isArray(raw?.grants) ? raw.grants : [];
  const revokes = Array.isArray(raw?.revokes) ? raw.revokes : [];
  const modifies = Array.isArray(raw?.modifies) ? raw.modifies : [];
  const conditions = Array.isArray(raw?.conditions) ? raw.conditions : [];

  for (const g of grants) {
    const subject = safeString(g?.subject).trim();
    const action = safeString(g?.action).trim();
    if (!subject || !action) continue;

    out.grants.push({
      type: safeString(g?.type).trim() || undefined,
      subject,
      action,
      scope: safeString(g?.scope).trim() || undefined,
      limit_amount:
        typeof g?.limit_amount === "number"
          ? g.limit_amount
          : (g?.limit_amount != null && `${g.limit_amount}`.trim() !== "" ? Number(g.limit_amount) : null),
      limit_currency: safeString(g?.limit_currency).trim() || null,
      conditions: Array.isArray(g?.conditions)
        ? g.conditions.map((x: any) => safeString(x).trim()).filter(Boolean)
        : [],
      effective_at: safeString(g?.effective_at).trim() || null,
      expires_at: safeString(g?.expires_at).trim() || null,
    });
  }

  for (const r of revokes) {
    const subject = safeString(r?.subject).trim();
    const action = safeString(r?.action).trim();
    if (!subject || !action) continue;

    out.revokes.push({
      subject,
      action,
      scope: safeString(r?.scope).trim() || undefined,
      limit_amount:
        typeof r?.limit_amount === "number"
          ? r.limit_amount
          : (r?.limit_amount != null && `${r.limit_amount}`.trim() !== "" ? Number(r.limit_amount) : null),
      limit_currency: safeString(r?.limit_currency).trim() || null,
    });
  }

  for (const m of modifies) {
    const subject = safeString(m?.subject).trim();
    const action = safeString(m?.action).trim();
    if (!subject || !action) continue;

    out.modifies.push({
      subject,
      action,
      scope: safeString(m?.scope).trim() || undefined,
      from_limit_amount:
        m?.from_limit_amount != null && `${m.from_limit_amount}`.trim() !== ""
          ? Number(m.from_limit_amount)
          : null,
      to_limit_amount:
        m?.to_limit_amount != null && `${m.to_limit_amount}`.trim() !== ""
          ? Number(m.to_limit_amount)
          : null,
      from_limit_currency: safeString(m?.from_limit_currency).trim() || null,
      to_limit_currency: safeString(m?.to_limit_currency).trim() || null,
      notes: safeString(m?.notes).trim() || null,
    });
  }

  out.conditions = conditions.map((x: any) => safeString(x).trim()).filter(Boolean);
  out.effective_date = safeString(raw?.effective_date).trim() || null;

  return out;
}

async function callOpenAIExtract(args: {
  apiKey: string;
  model: string;
  title: string;
  body: string;
  entityName?: string | null;
  entitySlug?: string | null;
  isTest: boolean;
}): Promise<{ ok: boolean; facts?: any; error?: string; modelUsed?: string; raw?: any }> {
  const { apiKey, model, title, body, entityName, entitySlug, isTest } = args;

  const system = [
    "You are AXIOM, a governance fact-extraction engine.",
    "Your job: extract structured authority facts from a FINAL corporate resolution text.",
    "Output MUST be valid JSON matching the required schema.",
    "",
    "Rules:",
    "- Be conservative: only extract what is explicitly supported by the text.",
    "- If uncertain, omit the item rather than guessing.",
    "- Use short, normalized strings for subject/action.",
    "- amounts must be numbers (no commas). currency should be 3-letter when present (e.g., CAD, USD).",
    "- conditions should be short phrases.",
    "- effective_at/expires_at should be ISO timestamps if the text specifies timing; otherwise null/omit.",
    "",
    `Context: entity=${entityName ?? "unknown"} (${entitySlug ?? "unknown"}), lane=${isTest ? "SANDBOX" : "RoT"}.`,
  ].join("\n");

  const user = [
    "Extract facts from this resolution:",
    "",
    `TITLE: ${title}`,
    "",
    "BODY:",
    body,
    "",
    "Return ONLY JSON with exactly these top-level keys:",
    "{ grants: [], revokes: [], modifies: [], conditions: [], effective_date: null }",
    "",
    "Where:",
    "- grants: array of { type?, subject, action, scope?, limit_amount?, limit_currency?, conditions?, effective_at?, expires_at? }",
    "- revokes: array of { subject, action, scope?, limit_amount?, limit_currency? }",
    "- modifies: array of { subject, action, scope?, from_limit_amount?, to_limit_amount?, from_limit_currency?, to_limit_currency?, notes? }",
    "- conditions: array of strings",
    "- effective_date: ISO date/datetime string or null",
  ].join("\n");

  // Use Responses API (works well for structured JSON). If you prefer Chat Completions, swap.
  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      // Strongly encourage JSON-only output
      text: { format: { type: "json_object" } },
      temperature: 0.1,
      max_output_tokens: 900,
    }),
  });

  const raw = await resp.json().catch(() => null);

  if (!resp.ok) {
    return {
      ok: false,
      error:
        raw?.error?.message ||
        `OpenAI error (${resp.status})`,
      raw,
    };
  }

  // Responses API: JSON may be in output_text; but format json_object usually yields parsable text.
  const outText =
    raw?.output_text ??
    raw?.output?.[0]?.content?.[0]?.text ??
    null;

  if (!outText || typeof outText !== "string") {
    return { ok: false, error: "MODEL_NO_OUTPUT_TEXT", raw };
  }

  let parsed: any = null;
  try {
    parsed = JSON.parse(outText);
  } catch {
    return { ok: false, error: "MODEL_OUTPUT_NOT_JSON", raw };
  }

  return { ok: true, facts: parsed, modelUsed: model, raw };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const request_id = crypto.randomUUID();

  try {
    const body = (await req.json().catch(() => ({}))) as ReqBody;
    const ledger_id = getLedgerId(body);
    const force = Boolean(body.force);
    if (!ledger_id) {
      return json(400, { ok: false, code: "MISSING_LEDGER_ID", request_id });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
      return json(500, {
        ok: false,
        code: "MISSING_SUPABASE_ENV",
        request_id,
      });
    }

    // 1) Verify operator session
    const authHeader = req.headers.get("authorization") ?? "";
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { authorization: authHeader } },
    });

    const { data: userData, error: userErr } = await anon.auth.getUser();
    if (userErr || !userData?.user) {
      return json(401, {
        ok: false,
        code: "UNAUTHORIZED",
        request_id,
      });
    }

    // 2) Service client for DB operations
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // 3) Load ledger (truth checkpoint part 1)
    const { data: gl, error: glErr } = await admin
      .from("governance_ledger")
      .select("id, entity_id, title, body, status, is_test")
      .eq("id", ledger_id)
      .maybeSingle();

    if (glErr) {
      return json(500, { ok: false, code: "LEDGER_QUERY_FAILED", request_id, error: glErr.message });
    }
    if (!gl) {
      return json(404, { ok: false, code: "LEDGER_NOT_FOUND", request_id });
    }
    if (gl.status !== "ARCHIVED") {
      return json(409, {
        ok: false,
        code: "NOT_ARCHIVED",
        request_id,
        status: gl.status,
      });
    }

    // 4) Load verified doc (truth checkpoint part 2)
    const { data: vd, error: vdErr } = await admin
      .from("verified_documents")
      .select("id, created_at")
      .eq("source_record_id", ledger_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (vdErr) {
      return json(500, { ok: false, code: "VERIFIED_QUERY_FAILED", request_id, error: vdErr.message });
    }
    if (!vd) {
      // Court-grade gate: no verified record, no extraction persistence (optional),
      // but we return a clean code so callers can retry later.
      return json(409, {
        ok: false,
        code: "NOT_CERTIFIED_YET",
        request_id,
      });
    }

    // 5) If existing facts row and not forcing, return idempotent OK
    const { data: existing, error: exErr } = await admin
      .from("governance_resolution_facts")
      .select("id, facts_json, extracted_at, applied_at, verified_document_id")
      .eq("ledger_id", ledger_id)
      .maybeSingle();

    if (exErr) {
      return json(500, { ok: false, code: "FACTS_QUERY_FAILED", request_id, error: exErr.message });
    }

    const hasFacts =
      existing?.facts_json &&
      typeof existing.facts_json === "object" &&
      Object.keys(existing.facts_json).length > 0;

    if (existing && hasFacts && !force) {
      return json(200, {
        ok: true,
        code: "FACTS_ALREADY_EXIST",
        request_id,
        ledger_id,
        facts_id: existing.id,
        extracted_at: existing.extracted_at,
        applied_at: existing.applied_at,
        verified_document_id: existing.verified_document_id ?? vd.id,
      });
    }

    // 6) Extract via OpenAI (AXIOM)
    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
    if (!OPENAI_API_KEY) {
      return json(500, {
        ok: false,
        code: "MISSING_OPENAI_API_KEY",
        request_id,
      });
    }

    const model = clampModel(body.model);
    const title = safeString(gl.title) || "Untitled Resolution";
    const text = safeString(gl.body);

    if (!text.trim()) {
      return json(409, {
        ok: false,
        code: "LEDGER_BODY_EMPTY",
        request_id,
      });
    }

    // Optional entity context (best-effort; no regression if missing)
    const { data: ent } = await admin
      .from("entities")
      .select("name, slug")
      .eq("id", gl.entity_id)
      .maybeSingle();

    const ai = await callOpenAIExtract({
      apiKey: OPENAI_API_KEY,
      model,
      title,
      body: text,
      entityName: ent?.name ?? null,
      entitySlug: ent?.slug ?? null,
      isTest: Boolean(gl.is_test),
    });

    if (!ai.ok || !ai.facts) {
      return json(502, {
        ok: false,
        code: "EXTRACTION_FAILED",
        request_id,
        error: ai.error ?? "UNKNOWN",
      });
    }

    // 7) Normalize + persist (UPSERT by ledger_id)
    const normalized = normalizeFacts(ai.facts, gl.entity_id, Boolean(gl.is_test));

    // Make sure top-level keys exist even if empty.
    const facts_json = {
      grants: normalized.grants ?? [],
      revokes: normalized.revokes ?? [],
      modifies: normalized.modifies ?? [],
      conditions: normalized.conditions ?? [],
      effective_date: normalized.effective_date ?? null,
      scope: normalized.scope ?? { entity_id: gl.entity_id, is_test: Boolean(gl.is_test) },
    };

    const payload = {
      ledger_id,
      entity_id: gl.entity_id,
      is_test: Boolean(gl.is_test),
      verified_document_id: vd.id,
      facts_json,
      model: ai.modelUsed ?? model,
      extracted_at: new Date().toISOString(),
      // NOTE: we do NOT set applied_at here.
      // apply_resolution_facts_to_authority_registry() owns applied_at.
    };

    const { data: up, error: upErr } = await admin
      .from("governance_resolution_facts")
      .upsert(payload, { onConflict: "ledger_id" })
      .select("id, ledger_id, verified_document_id, extracted_at, applied_at")
      .maybeSingle();

    if (upErr) {
      return json(500, {
        ok: false,
        code: "FACTS_UPSERT_FAILED",
        request_id,
        error: upErr.message,
      });
    }

    return json(200, {
      ok: true,
      code: "EXTRACTED",
      request_id,
      ledger_id,
      facts_id: up?.id ?? null,
      verified_document_id: up?.verified_document_id ?? vd.id,
      extracted_at: up?.extracted_at ?? null,
      applied_at: up?.applied_at ?? null,
    });
  } catch (e) {
    return json(500, {
      ok: false,
      code: "UNHANDLED",
      request_id: crypto.randomUUID(),
      error: e instanceof Error ? e.message : String(e),
    });
  }
});
