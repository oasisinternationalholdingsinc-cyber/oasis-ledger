import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  record_id: string;   // governance_ledger.id
  is_test?: boolean;   // lane flag (optional; we verify against record)
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mustEnv(name: string) {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// Keep note_type compatible with your chk constraint
const NOTE_TYPE_FOR_COUNCIL = "summary";
const SCOPE_TYPE_FOR_LEDGER = "document";

export default async function handler(req: Request) {
  try {
    if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

    // IMPORTANT: must use the caller’s JWT so created_by can be the real user
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) {
      return json(401, { ok: false, error: "Missing Authorization Bearer token" });
    }

    const { record_id } = (await req.json().catch(() => ({}))) as ReqBody;
    if (!record_id) return json(400, { ok: false, error: "record_id is required" });

    const supabaseUrl = mustEnv("SUPABASE_URL");
    const serviceKey = mustEnv("SUPABASE_SERVICE_ROLE_KEY");

    // service client (for reading ledger even if RLS gets spicy)
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });

    // user client (to identify user id from JWT)
    const anonKey = mustEnv("SUPABASE_ANON_KEY");
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });

    const { data: userRes, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userRes?.user?.id) {
      return json(401, { ok: false, error: "Invalid session" });
    }
    const userId = userRes.user.id;

    // 1) Load ledger record
    const { data: rec, error: recErr } = await admin
      .from("governance_ledger")
      .select("id,title,body,status,entity_id,is_test,created_at,record_type")
      .eq("id", record_id)
      .single();

    if (recErr || !rec) return json(404, { ok: false, error: recErr?.message ?? "Record not found" });

    // 2) Build prompt (enterprise + deterministic-ish)
    // NOTE: This is where you can later swap in your AXIOM “more intelligent” logic / model.
    const title = rec.title ?? "(untitled)";
    const body = (rec.body ?? "").toString();

    const advisory = [
      `# AXIOM Council Advisory`,
      ``,
      `**Record:** ${title}`,
      `**Status:** ${(rec.status ?? "—").toString()}`,
      `**Lane:** ${rec.is_test ? "SANDBOX" : "RoT"}`,
      ``,
      `## Executive summary`,
      `Provide a concise council-grade assessment: clarity, risks, missing evidence, compliance flags.`,
      ``,
      `## Findings`,
      `- [GREEN] Consistency: …`,
      `- [YELLOW] Evidence gaps: …`,
      `- [RED] Blocking issues (if any): …`,
      ``,
      `## Recommendations`,
      `- Approve/Reject rationale`,
      `- What must be attached before signature`,
      ``,
      `---`,
      `### Source text`,
      body.slice(0, 12000),
    ].join("\n");

    // 3) Insert ai_notes (ledger-scoped)
    // IMPORTANT: created_by is NOT NULL; set it explicitly.
    const { data: noteRow, error: noteErr } = await admin
      .from("ai_notes")
      .insert({
        scope_type: SCOPE_TYPE_FOR_LEDGER,
        scope_id: rec.id,
        note_type: NOTE_TYPE_FOR_COUNCIL,
        title: `AXIOM Council Advisory — ${title}`,
        content: advisory,
        model: "axiom-council-review:v1",
        tokens_used: null,
        created_by: userId,
      })
      .select("id")
      .single();

    if (noteErr || !noteRow?.id) {
      return json(500, { ok: false, error: noteErr?.message ?? "Failed to write ai_notes" });
    }

    return json(200, { ok: true, note_id: noteRow.id, record_id: rec.id });
  } catch (e: any) {
    return json(500, { ok: false, error: e?.message ?? "Unhandled error" });
  }
}
