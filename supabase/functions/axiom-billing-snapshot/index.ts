// supabase/functions/axiom-billing-snapshot/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * AXIOM • Billing Snapshot (PRODUCTION — NO REGRESSION)
 * ✅ Advisory-only: reads billing registry state, produces a snapshot
 * ✅ Optional persistence to ai_notes (scope_type='entity', note_type='memo')
 * ✅ Entity-safe: requires entity_id (uuid) OR resolves via entities.slug
 * ✅ Lane-safe: filters by is_test when column exists (fallback if missing)
 * ✅ No enforcement. No payments. No mutations outside optional ai_notes insert.
 */

type ReqBody = {
  entity_id?: string;
  entity_slug?: string;

  // Optional lane override (normally comes from caller)
  is_test?: boolean;

  // Default true: writes an AXIOM memo to ai_notes (operator-auditable)
  persist_note?: boolean;

  // Optional: caller tag for audit/debug
  trigger?: string;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY_PUBLIC");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL / SUPABASE_ANON_KEY / SERVICE_ROLE_KEY");
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...cors, "content-type": "application/json; charset=utf-8" },
  });
}

function pickBearer(req: Request) {
  const h = req.headers.get("authorization") || req.headers.get("Authorization") || "";
  return h.startsWith("Bearer ") ? h : "";
}

function isUUID(v: string | null | undefined) {
  const s = (v || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

function safeStr(v: any) {
  const s = (v ?? "").toString().trim();
  return s ? s : "—";
}

function iso(v: any) {
  const s = (v ?? "").toString().trim();
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toISOString();
}

function laneLabel(isTest: boolean) {
  return isTest ? "SANDBOX" : "RoT";
}

async function resolveEntityIdBySlug(svc: any, slug: string) {
  const { data, error } = await svc.from("entities").select("id,slug,name").eq("slug", slug).maybeSingle();
  if (error) throw error;
  return data?.id ? (data as any) : null;
}

async function trySelectWithLane<T>(
  svc: any,
  table: string,
  selectCols: string,
  entityId: string,
  isTest: boolean,
  orderCol?: string,
  limit?: number,
) {
  // Attempt lane-filtered query first; fallback if column doesn't exist.
  try {
    let q = svc.from(table).select(selectCols).eq("entity_id", entityId).eq("is_test", isTest);
    if (orderCol) q = q.order(orderCol, { ascending: false });
    if (limit) q = q.limit(limit);
    const { data, error } = await q;
    if (error) {
      // If column doesn't exist, fallback
      if (/is_test|42703|undefined column/i.test(error.message)) throw error;
      throw error;
    }
    return { data: (data || []) as T[], laneApplied: true };
  } catch (_e) {
    let q = svc.from(table).select(selectCols).eq("entity_id", entityId);
    if (orderCol) q = q.order(orderCol, { ascending: false });
    if (limit) q = q.limit(limit);
    const { data, error } = await q;
    if (error) throw error;
    return { data: (data || []) as T[], laneApplied: false };
  }
}

type BillingSub = {
  id: string;
  entity_id: string;
  status: string | null;
  plan?: string | null;
  plan_key?: string | null;
  plan_id?: string | null;
  provider?: string | null;
  payment_provider?: string | null;
  provider_customer_id?: string | null;
  provider_subscription_id?: string | null;
  current_period_start?: string | null;
  current_period_end?: string | null;
  trial_ends_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  is_internal?: boolean | null;
  is_test?: boolean | null;
  metadata?: any | null;
};

type BillingDoc = {
  id: string;
  entity_id: string;
  doc_type?: string | null;
  title?: string | null;
  storage_bucket?: string | null;
  storage_path?: string | null;
  file_hash?: string | null;
  created_at?: string | null;
  is_test?: boolean | null;
  metadata?: any | null;
};

function buildMemo(snapshot: any) {
  const e = snapshot.entity;
  const lane = snapshot.lane;
  const subs = snapshot.subscriptions;
  const docs = snapshot.documents;

  const active = subs.active_subscription;
  const latestDoc = docs.latest_document;

  const lines: string[] = [];
  lines.push(`AXIOM • Billing Snapshot`);
  lines.push(`Entity: ${safeStr(e?.name)} (${safeStr(e?.slug)})`);
  lines.push(`Lane: ${lane}`);
  lines.push(`—`);

  lines.push(`Subscriptions: ${subs.total}`);
  lines.push(`Active: ${active ? `${active.status || "—"} • ${active.plan || "—"} • ${active.id}` : "—"}`);

  if (active) {
    if (active.trial_ends_at) lines.push(`Trial ends: ${active.trial_ends_at}`);
    if (active.current_period_end) lines.push(`Period end: ${active.current_period_end}`);
    if (active.provider) lines.push(`Provider: ${active.provider}`);
  }

  lines.push(`—`);
  lines.push(`Billing documents: ${docs.total}`);
  lines.push(
    `Latest: ${
      latestDoc
        ? `${latestDoc.doc_type || "document"} • ${latestDoc.title || "—"} • ${latestDoc.created_at || "—"}`
        : "—"
    }`,
  );

  lines.push(`—`);
  lines.push(`Advisory: visibility-only. No enforcement. No payment actions.`);
  return lines.join("\n");
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json(405, { ok: false, error: "METHOD_NOT_ALLOWED" });

  try {
    const body = (await req.json().catch(() => ({}))) as ReqBody;

    const bearer = pickBearer(req);
    if (!bearer) return json(401, { ok: false, error: "MISSING_AUTH" });

    // user-scoped client (to resolve actor)
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: bearer } },
    });

    const { data: userRes, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userRes?.user?.id) {
      return json(401, { ok: false, error: "INVALID_SESSION" });
    }
    const actor_id = userRes.user.id;

    // service client (registry reads + optional ai_notes write)
    const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { global: { fetch } });

    // entity resolution
    let entity_id = (body.entity_id || "").trim();
    const entity_slug = (body.entity_slug || "").trim();

    let entityRow: any = null;

    if (entity_id && !isUUID(entity_id)) {
      return json(400, { ok: false, error: "INVALID_ENTITY_ID" });
    }

    if (!entity_id) {
      if (!entity_slug) return json(400, { ok: false, error: "MISSING_ENTITY", details: "Provide entity_id or entity_slug" });
      const resolved = await resolveEntityIdBySlug(svc, entity_slug);
      if (!resolved?.id) return json(404, { ok: false, error: "ENTITY_NOT_FOUND", entity_slug });
      entity_id = resolved.id;
      entityRow = resolved;
    } else {
      // hydrate entity info (best-effort)
      const { data } = await svc.from("entities").select("id,slug,name").eq("id", entity_id).maybeSingle();
      entityRow = data || { id: entity_id, slug: entity_slug || null, name: null };
    }

    const is_test = Boolean(body.is_test);
    const persist_note = body.persist_note !== false; // default true

    // ---- Read subscriptions (lane safe) ----
    const subsRes = await trySelectWithLane<BillingSub>(
      svc,
      "billing_subscriptions",
      "*",
      entity_id,
      is_test,
      "created_at",
      50,
    );

    const subs = subsRes.data || [];
    const active = subs.find((s) => (s.status || "").toLowerCase() === "active") || null;

    const normalizeSub = (s: BillingSub) => ({
      id: s.id,
      status: s.status,
      plan: s.plan_key ?? s.plan_id ?? (s as any).plan ?? null,
      provider: s.payment_provider ?? (s as any).provider ?? null,
      provider_customer_id: s.provider_customer_id ?? null,
      provider_subscription_id: s.provider_subscription_id ?? null,
      current_period_start: iso(s.current_period_start),
      current_period_end: iso(s.current_period_end),
      trial_ends_at: iso(s.trial_ends_at),
      is_internal: Boolean(s.is_internal),
      created_at: iso(s.created_at),
      updated_at: iso(s.updated_at),
    });

    // ---- Read billing documents (lane safe) ----
    const docsRes = await trySelectWithLane<BillingDoc>(
      svc,
      "billing_documents",
      "*",
      entity_id,
      is_test,
      "created_at",
      50,
    );

    const docs = docsRes.data || [];
    const latestDoc = docs[0] || null;

    const normalizeDoc = (d: BillingDoc) => ({
      id: d.id,
      doc_type: (d as any).doc_type ?? (d as any).document_type ?? null,
      title: d.title ?? null,
      storage_bucket: d.storage_bucket ?? null,
      storage_path: d.storage_path ?? null,
      file_hash: d.file_hash ?? null,
      created_at: iso(d.created_at),
    });

    const snapshot = {
      ok: true,
      actor_id,
      entity: {
        id: entity_id,
        slug: entityRow?.slug ?? entity_slug ?? null,
        name: entityRow?.name ?? null,
      },
      lane: laneLabel(is_test),
      lane_applied: {
        billing_subscriptions: subsRes.laneApplied,
        billing_documents: docsRes.laneApplied,
      },
      subscriptions: {
        total: subs.length,
        active_subscription: active ? normalizeSub(active) : null,
        latest_5: subs.slice(0, 5).map(normalizeSub),
      },
      documents: {
        total: docs.length,
        latest_document: latestDoc ? normalizeDoc(latestDoc) : null,
        latest_5: docs.slice(0, 5).map(normalizeDoc),
      },
      meta: {
        persist_note,
        trigger: body.trigger ?? null,
        generated_at: new Date().toISOString(),
      },
    };

    let note_id: string | null = null;

    if (persist_note) {
      const memo = buildMemo(snapshot);

      // ai_notes contract (known-safe enums):
      // scope_type: 'entity' | 'document' | 'section' | 'book'
      // note_type must satisfy chk_note_type: 'note' | 'summary' | 'memo'
      const { data: ins, error: insErr } = await svc
        .from("ai_notes")
        .insert({
          scope_type: "entity",
          scope_id: entity_id,
          note_type: "memo",
          content: memo,
          created_by: actor_id,
          metadata: {
            kind: "axiom_billing_snapshot",
            lane: laneLabel(is_test),
            lane_applied: snapshot.lane_applied,
            snapshot,
          },
        })
        .select("id")
        .maybeSingle();

      if (insErr) {
        // Do not fail the whole request if note insert fails; snapshot is still valuable.
        return json(200, { ...snapshot, note_write: { ok: false, error: insErr.message } });
      }

      note_id = ins?.id ?? null;
    }

    return json(200, { ...snapshot, note_id });
  } catch (e: any) {
    return json(500, {
      ok: false,
      error: "AXIOM_BILLING_SNAPSHOT_FAILED",
      details: e?.message || String(e),
    });
  }
});
