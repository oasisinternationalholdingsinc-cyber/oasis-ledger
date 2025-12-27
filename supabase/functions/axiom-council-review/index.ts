import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  record_id: string; // governance_ledger.id
  is_test?: boolean; // optional; record is source of truth
};

// ---- CORS (so browser invoke is clean) ----
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

    // Admin client (for reliable reads/writes even if RLS is strict)
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    // User client (to resolve caller user id from JWT)
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });

    const { data: userRes, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userRes?.user?.id) return json({ ok: false, error: "Invalid session" }, 401);
    const userId = userRes.user.id;

    // 1) Load ledger record
    const { data: rec, error: recErr } = await admin
      .from("governance_ledger")
      .select("id,title,body,status,entity_id,is_test,created_at,record_type")
      .eq("id", record_id)
      .single();

    if (recErr || !rec) return json({ ok: false, error: recErr?.message ?? "Record not found" }, 404);

    // 2) Create council-grade advisory (template baseline)
    // NOTE: later you can swap this block with your “more intelligent” AXIOM model pipeline.
    const title = rec.title ?? "(untitled)";
    const bodyText = safeStr(rec.body);

    const advisory = [
      `# AXIOM Council Advisory`,
      ``,
      `**Record:** ${title}`,
      `**Status:** ${safeStr(rec.status) || "—"}`,
      `**Lane:** ${rec.is_test ? "SANDBOX" : "RoT"}`,
      ``,
      `## Executive summary`,
      `- What this resolution does (in plain language)`,
      `- What could go wrong (governance/compliance/reputation/execution)`,
      ``,
      `## Findings`,
      `- [GREEN] Consistency: …`,
      `- [YELLOW] Evidence gaps: …`,
      `- [RED] Blocking issues (if any): …`,
      ``,
      `## Recommendations`,
      `- Approve/Reject rationale`,
      `- Attachments required before signature`,
      `- Any wording fixes before sealing`,
      ``,
      `---`,
      `### Source text`,
      bodyText.slice(0, 12000),
    ].join("\n");

    // 3) Insert ai_notes (ledger-scoped)
    const { data: noteRow, error: noteErr } = await admin
      .from("ai_notes")
      .insert({
        scope_type: SCOPE_TYPE_FOR_LEDGER,
        scope_id: rec.id,
        note_type: NOTE_TYPE_FOR_COUNCIL,
        title: `AXIOM Council Advisory — ${title}`,
        content: advisory,
        model: "axiom-review-council:v1",
        tokens_used: null,
        created_by: userId,
      })
      .select("id")
      .single();

    if (noteErr || !noteRow?.id) {
      return json({ ok: false, error: noteErr?.message ?? "Failed to write ai_notes" }, 500);
    }

    return json({ ok: true, note_id: noteRow.id, record_id: rec.id });
  } catch (e: any) {
    return json({ ok: false, error: e?.message ?? "Unhandled error" }, 500);
  }
});
