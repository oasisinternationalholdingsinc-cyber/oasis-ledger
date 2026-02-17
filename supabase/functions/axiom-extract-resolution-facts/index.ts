// supabase/functions/axiom-extract-resolution-facts/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * AXIOM — axiom-extract-resolution-facts (PRODUCTION — LOCKED)
 *
 * CONTRACT
 * ✅ governance_ledger.status MUST be 'ARCHIVED'
 * ✅ verified_documents.source_record_id MUST exist (certified hash row)
 * ✅ Writes ONLY to: public.governance_resolution_facts
 * ✅ NEVER mutates authority_registry
 * ✅ Idempotent by ledger_id (UPSERT on ledger_id)
 * ✅ Operator-authenticated (JWT required)
 * ✅ Service-role writes
 *
 * NOTE:
 * - UI should call via supabase.functions.invoke WITHOUT overriding headers.
 * - This function validates JWT using anon client, then uses service_role for DB writes.
 */

type ReqBody = {
  ledger_id?: string | null;
  record_id?: string | null;
  id?: string | null;

  // compatibility
  p_ledger_id?: string | null;

  // options
  force?: boolean | null;
  model?: string | null;
};

type ExtractedFacts = {
  grants: Array<{
    type?: string;
    subject: string;
    action: string;
    scope?: string;
    limit_amount?: number | null;
    limit_currency?: string | null;
    conditions?: string[];
    effective_at?: string | null;
    expires_at?: string | null;
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
  conditions: string[];
  effective_date?: string | null;
};

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};

function json(status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
}

function getLedgerId(body: ReqBody): string | null {
  return body.ledger_id ?? body.p_ledger_id ?? body.record_id ?? body.id ?? null;
}

function safeString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function toNumberOrNull(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/,/g, "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function clampModel(m?: string | null): string {
  const fallback = "gpt-4.1-mini";
  const t = (m ?? "").trim();
  return t || fallback;
}

function normalizeFacts(raw: any): ExtractedFacts {
  const out: ExtractedFacts = {
    grants: [],
    revokes: [],
    modifies: [],
    conditions: [],
    effective_date: null,
  };

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
      limit_amount: toNumberOrNull(g?.limit_amount),
      limit_currency: safeString(g?.limit_currency).trim() || null,
      conditions: Array.isArray(g?.conditions)
        ? g.conditions.map((c: any) => safeString(c).trim()).filter(Boolean)
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
      limit_amount: toNumberOrNull(r?.limit_amount),
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
      from_limit_amount: toNumberOrNull(m?.from_limit_amount),
      to_limit_amount: toNumberOrNull(m?.to_limit_amount),
      from_limit_currency: safeString(m?.from_limit_currency).trim() || null,
      to_limit_currency: safeString(m?.to_limit_currency).trim() || null,
      notes: safeString(m?.notes).trim() || null,
    });
  }

  out.conditions = conditions.map((c: any) => safeString(c).trim()).filter(Boolean);
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
}) {
  const { apiKey, model, title, body, entityName, entitySlug, isTest } = args;

  const system = [
    "You are AXIOM, a governance fact-extraction engine.",
    "",
    "Extract structured authority facts from a FINAL corporate resolution.",
    "Be conservative.",
    "Do not guess.",
    "Output strictly valid JSON.",
    "",
    `Entity: ${entityName ?? "unknown"} (${entitySlug ?? "unknown"})`,
    `Lane: ${isTest ? "SANDBOX" : "RoT"}`,
  ].join("\n");

  const user = [
    "TITLE:",
    title,
    "",
    "BODY:",
    body,
    "",
    "Return JSON:",
    "",
    "{",
    '  "grants": [],',
    '  "revokes": [],',
    '  "modifies": [],',
    '  "conditions": [],',
    '  "effective_date": null',
    "}",
  ].join("\n");

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
    return { ok: false as const, error: raw?.error?.message ?? "OpenAI error" };
  }

  const outText =
    raw?.output_text ??
    raw?.output?.[0]?.content?.[0]?.text ??
    null;

  if (!outText) return { ok: false as const, error: "MODEL_NO_OUTPUT" };

  try {
    const parsed = JSON.parse(outText);
    return { ok: true as const, facts: parsed };
  } catch {
    return { ok: false as const, error: "MODEL_OUTPUT_NOT_JSON" };
  }
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
    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY || !OPENAI_API_KEY) {
      return json(500, { ok: false, code: "MISSING_ENV", request_id });
    }

    // ✅ Robust: require Authorization header (JWT)
    const authHeader = req.headers.get("authorization") ?? "";
    if (!authHeader) {
      return json(401, { ok: false, code: "MISSING_AUTH", request_id });
    }

    // ✅ Validate user via anon client (operator-auth)
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
      global: {
        headers: {
          // ensure the JWT is used for auth.getUser()
          Authorization: authHeader,
          // ensure apikey exists even if caller forgot it
          apikey: SUPABASE_ANON_KEY,
        },
      },
    });

    const { data: userData, error: userErr } = await anon.auth.getUser();
    if (userErr || !userData?.user) {
      return json(401, { ok: false, code: "UNAUTHORIZED", request_id });
    }

    // ✅ Service role for DB reads/writes
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // 1) Load ledger record
    const { data: gl, error: glErr } = await admin
      .from("governance_ledger")
      .select("id, entity_id, title, body, status, is_test")
      .eq("id", ledger_id)
      .maybeSingle();

    if (glErr) {
      return json(500, { ok: false, code: "LEDGER_READ_FAILED", request_id, error: glErr.message });
    }

    if (!gl) {
      return json(404, { ok: false, code: "LEDGER_NOT_FOUND", request_id });
    }

    if (String(gl.status) !== "ARCHIVED") {
      return json(409, { ok: false, code: "NOT_ARCHIVED", request_id, ledger_id });
    }

    // 2) Must have certified verified_documents row (hash-first)
    const { data: vd, error: vdErr } = await admin
      .from("verified_documents")
      .select("id, created_at, file_hash, verification_level")
      .eq("source_record_id", ledger_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (vdErr) {
      return json(500, { ok: false, code: "VERIFIED_READ_FAILED", request_id, error: vdErr.message });
    }

    if (!vd) {
      return json(409, { ok: false, code: "NOT_CERTIFIED_YET", request_id, ledger_id });
    }

    // Strong gate: certified requires file_hash (matches your schema invariant)
    if (String(vd.verification_level) === "certified" && !vd.file_hash) {
      return json(409, { ok: false, code: "CERTIFIED_HASH_MISSING", request_id, ledger_id });
    }

    // 3) Existing facts?
    const { data: existing, error: exErr } = await admin
      .from("governance_resolution_facts")
      .select("id, facts_json, extracted_at")
      .eq("ledger_id", ledger_id)
      .maybeSingle();

    if (exErr) {
      return json(500, { ok: false, code: "FACTS_READ_FAILED", request_id, error: exErr.message });
    }

    const hasFacts =
      existing?.facts_json &&
      typeof existing.facts_json === "object" &&
      Object.keys(existing.facts_json as Record<string, unknown>).length > 0;

    if (existing && hasFacts && !force) {
      return json(200, {
        ok: true,
        code: "FACTS_ALREADY_EXIST",
        request_id,
        ledger_id,
        facts_id: existing.id,
      });
    }

    // Optional entity context (safe, no hardcode)
    const { data: ent } = await admin
      .from("entities")
      .select("name,slug")
      .eq("id", gl.entity_id)
      .maybeSingle();

    // 4) Call OpenAI
    const ai = await callOpenAIExtract({
      apiKey: OPENAI_API_KEY,
      model: clampModel(body.model),
      title: safeString(gl.title) || "Untitled Resolution",
      body: safeString(gl.body),
      entityName: ent?.name ?? null,
      entitySlug: ent?.slug ?? null,
      isTest: Boolean(gl.is_test),
    });

    if (!ai.ok || !("facts" in ai)) {
      return json(502, {
        ok: false,
        code: "EXTRACTION_FAILED",
        request_id,
        error: (ai as any).error ?? "OpenAI extraction failed",
      });
    }

    const normalized = normalizeFacts((ai as any).facts);

    const facts_json = {
      grants: normalized.grants,
      revokes: normalized.revokes,
      modifies: normalized.modifies,
      conditions: normalized.conditions,
      effective_date: normalized.effective_date,
      scope: { entity_id: gl.entity_id, is_test: Boolean(gl.is_test) },
    };

    // 5) Upsert idempotently (ledger_id unique)
    const { data: up, error: upErr } = await admin
      .from("governance_resolution_facts")
      .upsert(
        {
          ledger_id,
          entity_id: gl.entity_id,
          is_test: Boolean(gl.is_test),
          verified_document_id: vd.id,
          facts_json,
          model: clampModel(body.model),
          extracted_at: new Date().toISOString(),
        },
        { onConflict: "ledger_id" },
      )
      .select("id")
      .maybeSingle();

    if (upErr) {
      return json(500, { ok: false, code: "FACTS_UPSERT_FAILED", request_id, error: upErr.message });
    }

    return json(200, {
      ok: true,
      code: "EXTRACTED",
      request_id,
      ledger_id,
      facts_id: up?.id ?? null,
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
