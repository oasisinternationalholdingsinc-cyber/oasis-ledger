// supabase/functions/certify-governance-record/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * CERTIFY (Governance) — PRODUCTION — NO REGRESSION
 *
 * GOAL (your ask):
 * ✅ DO NOT append an extra certification page (NO PDF mutation beyond optional QR overlay)
 * ✅ NO wiring changes (Forge/Archive can keep sending same payload)
 * ✅ DOES NOT query storage.objects (not exposed to PostgREST)
 * ✅ Resolves the REAL minute_book PDF pointer via:
 *    1) public.minute_book_entries.storage_path (canonical)
 *    2) signature_envelopes.storage_path/supporting_document_path/certificate_path (fallback)
 * ✅ Bucket always minute_book (canonical archive-grade store)
 * ✅ Computes SHA-256 from FINAL BYTES (the exact bytes uploaded)
 * ✅ Upserts public.verified_documents with file_hash populated (passes constraint)
 * ✅ Uses mime_type (not content_type)
 * ✅ On conflict: (source_table, source_record_id)
 *
 * NEW (enterprise enhancement — no contract drift):
 * ✅ Calls axiom-extract-resolution-facts AFTER successful verified_documents upsert
 *    - best-effort (never blocks certification)
 *    - idempotent (force=false) so it never double-writes
 *
 * Court-grade boundary:
 * ✅ Requires governance_ledger.status='ARCHIVED' before certifying
 */

type ReqBody = {
  ledger_id?: string;
  record_id?: string; // alias
  actor_id?: string;

  // optional
  force?: boolean;
  verify_base_url?: string;

  // tolerated (Forge sends these sometimes)
  envelope_id?: string;
  is_test?: boolean;
  entity_slug?: string;
  trigger?: string;
};

type Resp = {
  ok: boolean;
  ledger_id?: string;
  actor_id?: string | null;

  storage_bucket?: string;
  storage_path?: string;

  file_hash?: string;
  verify_url?: string;

  verified_document_id?: string;
  reused?: boolean;

  // best-effort add-on (never blocks)
  extraction?: {
    ok: boolean;
    status?: number;
    code?: string;
    details?: unknown;
  };

  error?: string;
  details?: unknown;
  request_id?: string | null;
};

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
};

const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
}

const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    s,
  );

const safeText = (v: unknown) => {
  if (v == null) return null;
  const t = String(v).trim();
  return t.length ? t : null;
};

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function resolveActorIdBestEffort(
  supabaseAdmin: ReturnType<typeof createClient>,
  req: Request,
  bodyActorId?: string | null,
): Promise<string | null> {
  const actorId = safeText(bodyActorId);
  if (actorId) return isUuid(actorId) ? actorId : null;

  const authHeader =
    req.headers.get("authorization") ?? req.headers.get("Authorization");
  const jwt = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  // If called internally with service_role, there may be no user JWT.
  if (!jwt || jwt === SERVICE_ROLE_KEY) return null;

  const { data, error } = await supabaseAdmin.auth.getUser(jwt);
  if (error) return null;

  const id = data?.user?.id ?? null;
  return id && isUuid(id) ? id : null;
}

/**
 * ✅ Resolve canonical minute_book pointer WITHOUT querying storage.objects.
 * Priority:
 *  1) minute_book_entries.storage_path for this ledger_id
 *  2) signature_envelopes.storage_path / supporting_document_path / certificate_path (latest)
 */
async function resolveMinuteBookPath(
  supabaseAdmin: ReturnType<typeof createClient>,
  ledgerId: string,
): Promise<{ path: string | null; source: string }> {
  // 1) minute_book_entries
  const mbe = await supabaseAdmin
    .from("minute_book_entries")
    .select("id, storage_path, created_at")
    .eq("source_record_id", ledgerId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const mbePath = safeText((mbe.data as any)?.storage_path);
  if (mbePath) {
    return { path: mbePath, source: "minute_book_entries.storage_path" };
  }

  // 2) signature_envelopes fallbacks
  const env = await supabaseAdmin
    .from("signature_envelopes")
    .select("id, storage_path, supporting_document_path, certificate_path, created_at")
    .eq("record_id", ledgerId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const envPath =
    safeText((env.data as any)?.storage_path) ??
    safeText((env.data as any)?.supporting_document_path) ??
    safeText((env.data as any)?.certificate_path);

  if (envPath) return { path: envPath, source: "signature_envelopes.*_path" };

  return { path: null, source: "none" };
}

/**
 * ✅ Best-effort, idempotent extraction call.
 * - force=false => never overwrites / never double-writes
 * - does not block certify if AXIOM is down
 */
async function invokeAxiomExtractFactsBestEffort(ledgerId: string) {
  const url = `${SUPABASE_URL}/functions/v1/axiom-extract-resolution-facts`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: SERVICE_ROLE_KEY,
        authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        ledger_id: ledgerId,
        force: false,
      }),
    });

    const payload = await res.json().catch(() => null);

    // normalize “code” if present
    const code =
      safeText((payload as any)?.code) ??
      safeText((payload as any)?.error) ??
      (res.ok ? "OK" : "FAILED");

    return {
      ok: res.ok,
      status: res.status,
      code,
      details: payload,
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      code: "FACTS_INVOKE_THROW",
      details: String((e as any)?.message ?? e),
    };
  }
}

serve(async (req) => {
  const reqId = req.headers.get("x-sb-request-id") ?? null;

  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") {
      return json({ ok: false, error: "POST only", request_id: reqId }, 405);
    }

    const body = (await req.json().catch(() => ({}))) as ReqBody;
    const ledgerId = safeText(body.ledger_id ?? body.record_id);

    if (!ledgerId || !isUuid(ledgerId)) {
      return json<Resp>(
        { ok: false, error: "ledger_id must be uuid", request_id: reqId },
        400,
      );
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { fetch },
      auth: { persistSession: false },
    });

    const actorId = await resolveActorIdBestEffort(
      supabaseAdmin,
      req,
      body.actor_id ?? null,
    );

    const force = !!body.force;

    // ✅ Load ledger (NO entity_slug column) + require ARCHIVED for court-grade
    const gl = await supabaseAdmin
      .from("governance_ledger")
      .select("id, title, entity_id, is_test, status")
      .eq("id", ledgerId)
      .maybeSingle();

    if (gl.error) {
      return json<Resp>(
        {
          ok: false,
          error: "LEDGER_LOAD_FAILED",
          details: gl.error,
          request_id: reqId,
        },
        500,
      );
    }
    if (!gl.data?.id) {
      return json<Resp>(
        { ok: false, error: "LEDGER_NOT_FOUND", request_id: reqId },
        404,
      );
    }

    const status = safeText((gl.data as any)?.status);
    if (status !== "ARCHIVED") {
      return json<Resp>(
        {
          ok: false,
          error: "NOT_ARCHIVED",
          details: {
            message:
              "Certify requires governance_ledger.status='ARCHIVED' (court-grade boundary).",
            ledger_id: ledgerId,
            status,
          },
          request_id: reqId,
        },
        409,
      );
    }

    // ✅ Resolve entity_slug from entities table (canonical)
    const ent = await supabaseAdmin
      .from("entities")
      .select("id, slug")
      .eq("id", String((gl.data as any).entity_id))
      .maybeSingle();

    if (ent.error) {
      return json<Resp>(
        { ok: false, error: "ENTITY_LOAD_FAILED", details: ent.error, request_id: reqId },
        500,
      );
    }

    // ✅ contamination-safe fallback (never corp-specific)
    const entity_slug = safeText((ent.data as any)?.slug) ?? "entity";

    const base =
      safeText(body.verify_base_url) ??
      "https://sign.oasisintlholdings.com/verify.html";

    // ✅ Reuse if already certified + has pointers + hash (idempotent)
    const existing = await supabaseAdmin
      .from("verified_documents")
      .select("id, file_hash, verification_level, storage_bucket, storage_path, created_at")
      .eq("source_table", "governance_ledger")
      .eq("source_record_id", ledgerId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const existingHash = safeText((existing.data as any)?.file_hash);
    const existingLevel = safeText((existing.data as any)?.verification_level);
    const existingBucket = safeText((existing.data as any)?.storage_bucket);
    const existingPath = safeText((existing.data as any)?.storage_path);

    if (
      !force &&
      existing.data?.id &&
      existingHash &&
      (existingLevel ?? "").toLowerCase() === "certified" &&
      existingBucket &&
      existingPath
    ) {
      // ✅ Best-effort extraction even on reuse (safe + idempotent)
      const extraction = await invokeAxiomExtractFactsBestEffort(ledgerId);

      return json<Resp>({
        ok: true,
        reused: true,
        ledger_id: ledgerId,
        actor_id: actorId,
        storage_bucket: existingBucket,
        storage_path: existingPath,
        file_hash: existingHash,
        verify_url: `${base}?hash=${existingHash}`,
        verified_document_id: String((existing.data as any).id),
        extraction,
        request_id: reqId,
      });
    }

    // ✅ Resolve minute_book pointer (NO storage.objects)
    const bucket = "minute_book";
    const resolved = await resolveMinuteBookPath(supabaseAdmin, ledgerId);

    if (!resolved.path) {
      return json<Resp>(
        {
          ok: false,
          error: "SOURCE_POINTER_MISSING",
          details: {
            message:
              "No minute_book_entries.storage_path and no signature_envelopes path found. Archive/seal must run first to establish a minute_book pointer.",
            ledger_id: ledgerId,
            resolver_source: resolved.source,
          },
          request_id: reqId,
        },
        409,
      );
    }

    const path = resolved.path;

    // ✅ Download the existing minute_book PDF
    const dl = await supabaseAdmin.storage.from(bucket).download(path);
    if (dl.error || !dl.data) {
      return json<Resp>(
        {
          ok: false,
          error: "SOURCE_PDF_NOT_FOUND",
          details: dl.error,
          storage_bucket: bucket,
          storage_path: path,
          request_id: reqId,
        },
        404,
      );
    }

    const sourceBytes = new Uint8Array(await dl.data.arrayBuffer());

    /**
     * ✅ NO EXTRA PAGE / NO MUTATION:
     * We do NOT modify the PDF bytes at all.
     * We certify by:
     *   - hashing the existing bytes
     *   - writing verified_documents pointers + file_hash
     */
    const finalBytes = sourceBytes;
    const file_hash = await sha256Hex(finalBytes);

    // Keep upload upsert for consistent behavior (no wiring changes)
    const up = await supabaseAdmin.storage.from(bucket).upload(path, finalBytes, {
      contentType: "application/pdf",
      upsert: true,
    });

    if (up.error) {
      return json<Resp>(
        { ok: false, error: "UPLOAD_FAILED", details: up.error, request_id: reqId },
        500,
      );
    }

    // ✅ Upsert verified_documents with required fields
    const nowIso = new Date().toISOString();

    const vdPayload: Record<string, unknown> = {
      entity_id: String((gl.data as any).entity_id),
      entity_slug,
      document_class: "resolution",
      title: safeText((gl.data as any).title) ?? "Untitled Resolution",
      source_table: "governance_ledger",
      source_record_id: ledgerId,
      storage_bucket: bucket,
      storage_path: path,
      file_hash, // ✅ REQUIRED
      mime_type: "application/pdf",
      verification_level: "certified",
      is_archived: true,
      updated_by: actorId,
      updated_at: nowIso,
    };

    const vd = await supabaseAdmin
      .from("verified_documents")
      .upsert(vdPayload, { onConflict: "source_table,source_record_id" })
      .select("id")
      .maybeSingle();

    if (vd.error) {
      return json<Resp>(
        {
          ok: false,
          error: "VERIFIED_DOC_UPSERT_FAILED",
          details: vd.error,
          request_id: reqId,
        },
        500,
      );
    }

    // ✅ NEW: Best-effort AXIOM extraction (idempotent, never blocks)
    const extraction = await invokeAxiomExtractFactsBestEffort(ledgerId);

    return json<Resp>({
      ok: true,
      ledger_id: ledgerId,
      actor_id: actorId,
      storage_bucket: bucket,
      storage_path: path,
      file_hash,
      verify_url: `${base}?hash=${file_hash}`, // hash-first
      verified_document_id: vd.data?.id ? String((vd.data as any).id) : undefined,
      extraction,
      request_id: reqId,
    });
  } catch (e) {
    console.error("certify-governance-record fatal:", e);
    return json<Resp>(
      {
        ok: false,
        error: "CERTIFY_FATAL",
        details: String((e as any)?.message ?? e),
        request_id: req.headers.get("x-sb-request-id") ?? null,
      },
      500,
    );
  }
});
