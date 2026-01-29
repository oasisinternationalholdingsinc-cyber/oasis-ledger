// supabase/functions/start-signature-envelope/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { global: { fetch } });

// -----------------------------
// CORS + helpers
// -----------------------------
const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function normEmail(s: string) {
  return s.trim().toLowerCase();
}

type PartyInput = {
  name?: string | null;
  email?: string | null;
  role?: string | null; // optional label (primary/cc/etc)
};

type ReqBody = {
  record_id?: string;
  entity_slug?: string;
  is_test?: boolean;
  actor_id?: string;

  // legacy / optional:
  parties?: PartyInput[];
  signer_name?: string | null;
  signer_email?: string | null;
};

type Resp = {
  ok: boolean;
  envelope_id?: string;
  record_id?: string;
  entity_slug?: string;
  reused?: boolean;
  created_parties?: number;
  error?: string;
};

serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true }, 200);
  if (req.method !== "POST") return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);

  try {
    const body = (await req.json().catch(() => ({}))) as ReqBody;

    const record_id = (body.record_id ?? "").trim();
    const entity_slug = (body.entity_slug ?? "").trim();
    const is_test = !!body.is_test;
    const actor_id = (body.actor_id ?? "").trim() || null;

    if (!record_id) return json<Resp>({ ok: false, error: "RECORD_ID_REQUIRED" }, 400);
    if (!entity_slug) return json<Resp>({ ok: false, error: "ENTITY_SLUG_REQUIRED" }, 400);

    // -----------------------------
    // Resolve entity + validate ledger record is in-scope
    // -----------------------------
    const ent = await supabase
      .from("entities")
      .select("id, slug")
      .eq("slug", entity_slug)
      .maybeSingle();

    if (ent.error) return json<Resp>({ ok: false, error: ent.error.message }, 400);
    if (!ent.data?.id) return json<Resp>({ ok: false, error: "ENTITY_NOT_FOUND" }, 404);

    const entity_id = ent.data.id as string;

    // Ledger row must exist and match entity + lane
    const gl = await supabase
      .from("governance_ledger")
      .select("id, entity_id, is_test, status")
      .eq("id", record_id)
      .maybeSingle();

    if (gl.error) return json<Resp>({ ok: false, error: gl.error.message }, 400);
    if (!gl.data?.id) return json<Resp>({ ok: false, error: "LEDGER_NOT_FOUND" }, 404);

    if (gl.data.entity_id !== entity_id) {
      return json<Resp>({ ok: false, error: "ENTITY_MISMATCH" }, 403);
    }
    if (!!gl.data.is_test !== is_test) {
      return json<Resp>({ ok: false, error: "LANE_MISMATCH" }, 409);
    }

    // -----------------------------
    // Reuse existing envelope in same lane
    // -----------------------------
    const existing = await supabase
      .from("signature_envelopes")
      .select("id, status, is_test, record_id")
      .eq("record_id", record_id)
      .eq("is_test", is_test)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing.error) return json<Resp>({ ok: false, error: existing.error.message }, 400);

    // If found, reuse it (Forge expects this)
    if (existing.data?.id) {
      // Optional: if legacy caller sent parties and none exist yet, you may add them
      const created_parties = await maybeCreateParties({
        envelope_id: existing.data.id,
        record_id,
        entity_id,
        is_test,
        actor_id,
        body,
      });

      return json<Resp>({
        ok: true,
        reused: true,
        envelope_id: existing.data.id,
        record_id,
        entity_slug,
        created_parties: created_parties || 0,
      });
    }

    // -----------------------------
    // Create new envelope (NO signer required)
    // -----------------------------
    const ins = await supabase
      .from("signature_envelopes")
      .insert({
        record_id,
        entity_id,
        is_test,
        status: "draft", // keep neutral; send-signature-invite can move to pending/sent
        created_by: actor_id, // ok if null depending on schema; if NOT NULL, actor_id must be present
      } as any)
      .select("id")
      .single();

    if (ins.error) return json<Resp>({ ok: false, error: ins.error.message }, 400);

    const envelope_id = ins.data.id as string;

    // Best effort: move ledger into SIGNING (do not hard-fail)
    await supabase
      .from("governance_ledger")
      .update({ status: "SIGNING" } as any)
      .eq("id", record_id);

    const created_parties = await maybeCreateParties({
      envelope_id,
      record_id,
      entity_id,
      is_test,
      actor_id,
      body,
    });

    return json<Resp>({
      ok: true,
      reused: false,
      envelope_id,
      record_id,
      entity_slug,
      created_parties: created_parties || 0,
    });
  } catch (e: any) {
    return json<Resp>({ ok: false, error: e?.message || "UNHANDLED" }, 500);
  }
});

// -----------------------------
// Legacy compatibility: optional parties creation
// - If body.parties is present, create parties.
// - Else if signer_email present, create a single party.
// - Otherwise: do nothing (Forge path).
// -----------------------------
async function maybeCreateParties(args: {
  envelope_id: string;
  record_id: string;
  entity_id: string;
  is_test: boolean;
  actor_id: string | null;
  body: ReqBody;
}): Promise<number> {
  const { envelope_id, body } = args;

  // Normalize legacy inputs into parties array
  let parties: PartyInput[] = Array.isArray(body.parties) ? body.parties : [];

  if (!parties.length && body.signer_email) {
    parties = [
      {
        name: body.signer_name ?? null,
        email: body.signer_email ?? null,
        role: "primary",
      },
    ];
  }

  parties = parties
    .map((p) => ({
      name: (p.name ?? null) ? String(p.name).trim() : null,
      email: (p.email ?? null) ? normEmail(String(p.email)) : null,
      role: (p.role ?? null) ? String(p.role).trim() : null,
    }))
    .filter((p) => !!p.email);

  if (!parties.length) return 0;

  // Check if parties already exist (avoid duplicates)
  const existing = await supabase
    .from("signature_parties")
    .select("id, email")
    .eq("envelope_id", envelope_id);

  if (existing.error) return 0;

  const existingEmails = new Set(((existing.data ?? []) as any[]).map((r) => String(r.email || "").toLowerCase()));

  const rows = parties
    .filter((p) => p.email && !existingEmails.has(String(p.email).toLowerCase()))
    .map((p, idx) => ({
      envelope_id,
      name: p.name,
      email: p.email,
      role: p.role ?? (idx === 0 ? "primary" : "cc"),
      status: "pending",
      // party_token should be generated server-side if your schema uses a default/trigger.
      // If NOT, do it here and store it.
    }));

  if (!rows.length) return 0;

  const ins = await supabase.from("signature_parties").insert(rows as any);
  if (ins.error) return 0;

  return rows.length;
}
