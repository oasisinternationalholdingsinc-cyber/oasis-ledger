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
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
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

const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    s,
  );

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

  // ✅ NEW (additive, no regression)
  storage_bucket?: string;
  storage_path?: string | null;

  error?: string;
};

function edgeBaseFromSupabaseUrl(url: string) {
  // SUPABASE_URL is normally https://<ref>.supabase.co
  // but in some setups it may be .../rest/v1
  return url.replace(/\/rest\/v1\/?$/, "");
}

/**
 * Ensure the base PDF exists and envelope pointers are populated.
 * This fixes the exact failure you’re seeing:
 * - archive/seal refuses if there is no minute_book object for that ledger_id
 */
async function ensureBasePdfAndAttach(args: {
  envelope_id: string;
  record_id: string;
}): Promise<{ storage_path: string | null }> {
  const { envelope_id, record_id } = args;

  // Reload envelope pointers
  const env = await supabase
    .from("signature_envelopes")
    .select("id, storage_path, supporting_document_path, metadata")
    .eq("id", envelope_id)
    .maybeSingle();

  if (env.error) return { storage_path: null };

  const existingPath =
    (env.data as any)?.supporting_document_path ??
    (env.data as any)?.storage_path ??
    (env.data as any)?.metadata?.storage_path ??
    null;

  // If already attached, we’re done.
  if (existingPath) return { storage_path: String(existingPath) };

  // Call odp-pdf-engine to generate + upload base PDF + attach metadata
  const base = edgeBaseFromSupabaseUrl(SUPABASE_URL);
  const url = `${base}/functions/v1/odp-pdf-engine`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({
      record_id,
      envelope_id,
    }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.error("odp-pdf-engine failed", res.status, txt);
    return { storage_path: null };
  }

  const out = (await res.json().catch(() => null)) as any;
  const storage_path = safeText(out?.storage_path) ?? null;

  // Best-effort: hard-attach pointers (even if pdf-engine already did)
  if (storage_path) {
    const meta = (env.data as any)?.metadata ?? {};
    const newMeta = { ...meta, storage_path };

    const up = await supabase
      .from("signature_envelopes")
      .update({
        storage_path,
        supporting_document_path: storage_path,
        metadata: newMeta,
      } as any)
      .eq("id", envelope_id);

    if (up.error) {
      console.error("Failed to attach envelope storage_path (non-fatal)", up.error);
    }
  }

  return { storage_path };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true }, 200);
  if (req.method !== "POST") {
    return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
  }

  try {
    const body = (await req.json().catch(() => ({}))) as ReqBody;

    const record_id = safeText(body.record_id);
    const entity_slug = safeText(body.entity_slug);
    const is_test = !!body.is_test;

    if (!record_id) return json<Resp>({ ok: false, error: "RECORD_ID_REQUIRED" }, 400);
    if (!isUuid(record_id)) return json<Resp>({ ok: false, error: "RECORD_ID_INVALID" }, 400);
    if (!entity_slug) return json<Resp>({ ok: false, error: "ENTITY_SLUG_REQUIRED" }, 400);

    // ✅ Resolve actor from JWT unless explicitly provided
    const authHeader =
      req.headers.get("authorization") ?? req.headers.get("Authorization");
    const jwt = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

    let actor_id = safeText(body.actor_id);

    if (!actor_id && jwt) {
      const { data } = await supabase.auth.getUser(jwt);
      actor_id = (data as any)?.user?.id ?? null;
    }

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
      .select("id, entity_id, is_test, status, title")
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

    // Canonical envelope title (enterprise-safe; NOT NULL)
    const ledgerTitle = safeText((gl.data as any)?.title);
    const envelopeTitle = ledgerTitle ?? `Signature Envelope — ${record_id}`;

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

    if (existing.error) {
      return json<Resp>({ ok: false, error: existing.error.message }, 400);
    }

    if (existing.data?.id) {
      const envelope_id = existing.data.id as string;

      // ✅ CRITICAL: ensure base PDF exists + attach storage_path (fixes archive)
      const ensured = await ensureBasePdfAndAttach({
        envelope_id,
        record_id,
      });

      const created_parties = await maybeCreateParties({
        envelope_id,
        body,
      });

      return json<Resp>({
        ok: true,
        reused: true,
        envelope_id,
        record_id,
        entity_slug,
        created_parties: created_parties || 0,
        storage_bucket: "minute_book",
        storage_path: ensured.storage_path ?? null,
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
        title: envelopeTitle,
        status: "draft",
        created_by: actor_id, // nullable in your schema
      } as any)
      .select("id")
      .single();

    if (ins.error) return json<Resp>({ ok: false, error: ins.error.message }, 400);

    const envelope_id = ins.data.id as string;

    // Best effort: move ledger into SIGNING (do not hard-fail)
    await supabase.from("governance_ledger").update({ status: "SIGNING" } as any).eq("id", record_id);

    // ✅ CRITICAL: ensure base PDF exists + attach storage_path (fixes archive)
    const ensured = await ensureBasePdfAndAttach({
      envelope_id,
      record_id,
    });

    const created_parties = await maybeCreateParties({
      envelope_id,
      body,
    });

    return json<Resp>({
      ok: true,
      reused: false,
      envelope_id,
      record_id,
      entity_slug,
      created_parties: created_parties || 0,
      storage_bucket: "minute_book",
      storage_path: ensured.storage_path ?? null,
    });
  } catch (e: any) {
    return json<Resp>({ ok: false, error: e?.message || "UNHANDLED" }, 500);
  }
});

// -----------------------------
// Legacy compatibility: optional parties creation
// -----------------------------
async function maybeCreateParties(args: {
  envelope_id: string;
  body: ReqBody;
}): Promise<number> {
  const { envelope_id, body } = args;

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

  const existingEmails = new Set(
    ((existing.data ?? []) as any[]).map((r) => String(r.email || "").toLowerCase()),
  );

  const rows = parties
    .filter((p) => p.email && !existingEmails.has(String(p.email).toLowerCase()))
    .map((p, idx) => ({
      envelope_id,
      name: p.name,
      email: p.email,
      role: p.role ?? (idx === 0 ? "primary" : "cc"),
      status: "pending",
    }));

  if (!rows.length) return 0;

  const ins = await supabase.from("signature_parties").insert(rows as any);
  if (ins.error) return 0;

  return rows.length;
}
