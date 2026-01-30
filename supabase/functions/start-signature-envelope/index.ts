// supabase/functions/start-signature-envelope/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
}

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

function safeText(s: unknown): string | null {
  if (s == null) return null;
  const t = String(s).trim();
  return t.length ? t : null;
}

type PartyInput = {
  name?: string | null;
  email?: string | null;
  role?: string | null;
};

type ReqBody = {
  record_id?: string;
  entity_slug?: string;
  is_test?: boolean;
  actor_id?: string;

  // NEW (optional, additive)
  force_new?: boolean;   // allow new envelope even if latest is completed
  ensure_pdf?: boolean;  // call odp-pdf-engine after create/reuse (safe)

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
  ensured_pdf?: boolean;
  error?: string;
};

serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true }, 200);
  if (req.method !== "POST") return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);

  try {
    const body = (await req.json().catch(() => ({}))) as ReqBody;

    const record_id = safeText(body.record_id);
    const entity_slug = safeText(body.entity_slug);
    const is_test = !!body.is_test;
    const actor_id = safeText(body.actor_id);

    const force_new = !!body.force_new;
    const ensure_pdf = !!body.ensure_pdf;

    if (!record_id) return json<Resp>({ ok: false, error: "RECORD_ID_REQUIRED" }, 400);
    if (!entity_slug) return json<Resp>({ ok: false, error: "ENTITY_SLUG_REQUIRED" }, 400);

    // Resolve entity
    const ent = await supabase
      .from("entities")
      .select("id, slug, name")
      .eq("slug", entity_slug)
      .maybeSingle();

    if (ent.error) return json<Resp>({ ok: false, error: ent.error.message }, 400);
    if (!ent.data?.id) return json<Resp>({ ok: false, error: "ENTITY_NOT_FOUND" }, 404);

    const entity_id = ent.data.id as string;

    // Validate ledger row matches entity + lane
    const gl = await supabase
      .from("governance_ledger")
      .select("id, entity_id, is_test, status, title")
      .eq("id", record_id)
      .maybeSingle();

    if (gl.error) return json<Resp>({ ok: false, error: gl.error.message }, 400);
    if (!gl.data?.id) return json<Resp>({ ok: false, error: "LEDGER_NOT_FOUND" }, 404);

    if (gl.data.entity_id !== entity_id) return json<Resp>({ ok: false, error: "ENTITY_MISMATCH" }, 403);
    if (!!gl.data.is_test !== is_test) return json<Resp>({ ok: false, error: "LANE_MISMATCH" }, 409);

    const ledgerTitle = safeText((gl.data as any)?.title);
    const envelopeTitle = ledgerTitle ?? `Signature Envelope — ${record_id}`;

    // Reuse latest envelope unless force_new
    const existing = await supabase
      .from("signature_envelopes")
      .select("id, status, is_test, record_id")
      .eq("record_id", record_id)
      .eq("is_test", is_test)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing.error) return json<Resp>({ ok: false, error: existing.error.message }, 400);

    const existingId = existing.data?.id ? String(existing.data.id) : null;
    const existingStatus = safeText(existing.data?.status) ?? "";

    if (existingId && !(force_new && existingStatus.toLowerCase() === "completed")) {
      const created_parties = await maybeCreateParties({
        envelope_id: existingId,
        body,
      });

      const ensured = ensure_pdf
        ? await ensurePdfForEnvelope(record_id, existingId)
        : false;

      return json<Resp>({
        ok: true,
        reused: true,
        envelope_id: existingId,
        record_id,
        entity_slug,
        created_parties: created_parties || 0,
        ensured_pdf: ensured,
      });
    }

    // Create new envelope
    const ins = await supabase
      .from("signature_envelopes")
      .insert({
        record_id,
        entity_id,
        is_test,
        title: envelopeTitle,
        status: "draft",
        created_by: actor_id, // nullable
      } as any)
      .select("id")
      .single();

    if (ins.error) return json<Resp>({ ok: false, error: ins.error.message }, 400);

    const envelope_id = String(ins.data.id);

    // Best-effort: move ledger into SIGNING
    await supabase.from("governance_ledger").update({ status: "SIGNING" } as any).eq("id", record_id);

    const created_parties = await maybeCreateParties({
      envelope_id,
      body,
    });

    const ensured = ensure_pdf
      ? await ensurePdfForEnvelope(record_id, envelope_id)
      : false;

    return json<Resp>({
      ok: true,
      reused: false,
      envelope_id,
      record_id,
      entity_slug,
      created_parties: created_parties || 0,
      ensured_pdf: ensured,
    });
  } catch (e: any) {
    return json<Resp>({ ok: false, error: e?.message || "UNHANDLED" }, 500);
  }
});

// Legacy compatibility: optional parties creation
async function maybeCreateParties(args: { envelope_id: string; body: ReqBody }): Promise<number> {
  const { envelope_id, body } = args;

  let parties: PartyInput[] = Array.isArray(body.parties) ? body.parties : [];

  if (!parties.length && body.signer_email) {
    parties = [{ name: body.signer_name ?? null, email: body.signer_email ?? null, role: "primary" }];
  }

  parties = parties
    .map((p) => ({
      name: safeText(p.name),
      email: p.email ? normEmail(String(p.email)) : null,
      role: safeText(p.role),
    }))
    .filter((p) => !!p.email);

  if (!parties.length) return 0;

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
      // party_token should be generated by default/trigger if your schema has it.
    }));

  if (!rows.length) return 0;

  const ins = await supabase.from("signature_parties").insert(rows as any);
  if (ins.error) return 0;

  return rows.length;
}

// Safe helper: ensure base PDF exists + envelope pointers are written.
// Calls odp-pdf-engine using service role (internal).
async function ensurePdfForEnvelope(record_id: string, envelope_id: string): Promise<boolean> {
  try {
    const edgeBase = (SUPABASE_URL ?? "").replace(/\/rest\/v1$/, "");
    const res = await fetch(`${edgeBase}/functions/v1/odp-pdf-engine`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_ROLE_KEY!,
        Authorization: `Bearer ${SERVICE_ROLE_KEY!}`,
      },
      body: JSON.stringify({ record_id, envelope_id }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("ensurePdfForEnvelope failed", res.status, text);
      return false;
    }

    return true;
  } catch (e) {
    console.error("ensurePdfForEnvelope threw", e);
    return false;
  }
}
