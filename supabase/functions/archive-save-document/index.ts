import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  ledger_id?: string;
  record_id?: string; // legacy compatibility
  actor_id?: string; // optional override (operator/debug only)
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
};

const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    s,
  );

/**
 * Surgical repair:
 * - Ensure minute_book_entries.storage_path == supporting_documents.file_path
 * - Ensure EXACT match to a real storage.objects key in bucket 'minute_book'
 * - Ensure ONLY ONE supporting_documents row is registry_visible=true per entry_id
 * - Ensure section is consistent (prefer lowercase enum label if available)
 */
async function ensureMinuteBookEvidence(opts: {
  supabaseAdmin: ReturnType<typeof createClient>;
  ledgerId: string;
  actorId: string;
  minuteBookEntryId: string | null;
}) {
  const { supabaseAdmin, ledgerId, actorId, minuteBookEntryId } = opts;
  if (!minuteBookEntryId) return { ok: true, repaired: false, reason: "no_minute_book_entry_id" };

  // 1) Load minute_book_entries row (source of truth for hash + expected path)
  const { data: mbe, error: mbeErr } = await supabaseAdmin
    .from("minute_book_entries")
    .select("id, entity_key, domain_key, title, storage_path, pdf_hash, is_test")
    .eq("id", minuteBookEntryId)
    .maybeSingle();

  if (mbeErr) throw new Error(`minute_book_entries lookup failed: ${mbeErr.message}`);
  if (!mbe) return { ok: true, repaired: false, reason: "minute_book_entry_missing" };

  // 2) Find the REAL storage object key in bucket minute_book for this ledger id
  //    Prefer the hashed canonical key if it exists.
  const likeNeedle = `%${ledgerId}%`;
  const { data: objs, error: objErr } = await supabaseAdmin
    .from("storage.objects")
    .select("bucket_id, name, created_at")
    .eq("bucket_id", "minute_book")
    .ilike("name", likeNeedle)
    .order("created_at", { ascending: false });

  if (objErr) throw new Error(`storage.objects lookup failed: ${objErr.message}`);

  // Choose canonical:
  //  - Prefer name that includes ledgerId + '-' (hash suffix pattern) AND uses "/resolutions/" lowercase
  //  - Otherwise fall back to newest match
  let canonicalName: string | null = null;

  if (objs && objs.length) {
    const preferred = objs.find((o) =>
      typeof o.name === "string" &&
      o.name.includes(`/${ledgerId}-`) &&
      o.name.includes("/resolutions/") // lowercase canonical
    );
    canonicalName = preferred?.name ?? (objs[0]?.name ?? null);
  }

  // If we couldn't find any object, we can't repair pointers (but we don't crash the archive).
  if (!canonicalName) {
    return {
      ok: true,
      repaired: false,
      reason: "minute_book_object_not_found",
      minute_book_entry_id: minuteBookEntryId,
      expected_storage_path: mbe.storage_path ?? null,
    };
  }

  // 3) Force minute_book_entries.storage_path to EXACT canonicalName (prevents mismatch forever)
  if (mbe.storage_path !== canonicalName) {
    const { error: upMbeErr } = await supabaseAdmin
      .from("minute_book_entries")
      .update({ storage_path: canonicalName })
      .eq("id", minuteBookEntryId);

    if (upMbeErr) throw new Error(`minute_book_entries update failed: ${upMbeErr.message}`);
  }

  // 4) Fetch supporting_documents rows for this entry_id
  const { data: docs, error: docsErr } = await supabaseAdmin
    .from("supporting_documents")
    .select("id, entry_id, file_path, registry_visible, uploaded_at, section")
    .eq("entry_id", minuteBookEntryId)
    .order("uploaded_at", { ascending: false });

  if (docsErr) throw new Error(`supporting_documents lookup failed: ${docsErr.message}`);

  // Helper: try setting section to lowercase enum label first; if enum rejects, fallback to Title Case.
  const setSectionValue = async (payload: Record<string, unknown>) => {
    // Prefer lowercase enum label ("resolutions") since UI frequently filters that way.
    // If it fails, fallback to "Resolutions".
    const tryLower = { ...payload, section: "resolutions" };
    const tryUpper = { ...payload, section: "Resolutions" };
    return { tryLower, tryUpper };
  };

  const nowIso = new Date().toISOString();

  // 5) Ensure exactly one row is registry_visible=true and has correct file_path
  if (!docs || docs.length === 0) {
    // Insert brand new primary evidence pointer
    const base = {
      entry_id: minuteBookEntryId,
      entity_key: mbe.entity_key,
      // section set via try helper
      file_path: canonicalName,
      file_name: mbe.title ? `${mbe.title}.pdf` : `${ledgerId}.pdf`,
      doc_type: "resolution",
      version: 1,
      uploaded_by: actorId,
      uploaded_at: nowIso,
      owner_id: actorId,
      file_hash: mbe.pdf_hash ?? null,
      mime_type: "application/pdf",
      file_size: null,
      verified: true,
      registry_visible: true,
    };

    const { tryLower, tryUpper } = await setSectionValue(base);

    // Try lowercase, fallback
    let insErr = (await supabaseAdmin.from("supporting_documents").insert(tryLower)).error;
    if (insErr) {
      insErr = (await supabaseAdmin.from("supporting_documents").insert(tryUpper)).error;
      if (insErr) throw new Error(`supporting_documents insert failed: ${insErr.message}`);
    }

    return {
      ok: true,
      repaired: true,
      minute_book_entry_id: minuteBookEntryId,
      canonical_storage_path: canonicalName,
    };
  }

  // We have existing docs. We will:
  //  - pick the newest row as the "winner"
  //  - set all others registry_visible=false
  //  - update winner.file_path = canonicalName, registry_visible=true, (optionally normalize section)
  const winner = docs[0];

  // Hide all other rows (if any)
  const loserIds = docs.slice(1).map((d) => d.id).filter(Boolean);
  if (loserIds.length) {
    const { error: hideErr } = await supabaseAdmin
      .from("supporting_documents")
      .update({ registry_visible: false })
      .in("id", loserIds);
    if (hideErr) throw new Error(`supporting_documents dedupe failed: ${hideErr.message}`);
  }

  // Update winner to canonical path + visible
  const baseUpdate: Record<string, unknown> = {
    file_path: canonicalName,
    registry_visible: true,
    // keep hash aligned if present
    file_hash: mbe.pdf_hash ?? null,
    owner_id: actorId, // ensures non-null ownership if legacy rows were missing it
  };

  const { tryLower: updLower, tryUpper: updUpper } = await setSectionValue(baseUpdate);

  // Try lowercase section first; if enum rejects, fallback
  let upErr = (await supabaseAdmin.from("supporting_documents").update(updLower).eq("id", winner.id))
    .error;
  if (upErr) {
    upErr = (await supabaseAdmin.from("supporting_documents").update(updUpper).eq("id", winner.id))
      .error;
    if (upErr) throw new Error(`supporting_documents winner update failed: ${upErr.message}`);
  }

  return {
    ok: true,
    repaired: true,
    minute_book_entry_id: minuteBookEntryId,
    canonical_storage_path: canonicalName,
    supporting_document_id: winner.id,
    deduped_hidden_count: loserIds.length,
  };
}

serve(async (req) => {
  const reqId = req.headers.get("x-sb-request-id") ?? null;

  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

    const authHeader = req.headers.get("authorization") ?? req.headers.get("Authorization");
    const jwt = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    const body = (await req.json().catch(() => ({}))) as ReqBody;

    const ledgerId = (body.ledger_id ?? body.record_id)?.trim();
    if (!ledgerId) return json({ ok: false, error: "ledger_id required" }, 400);
    if (!isUuid(ledgerId)) return json({ ok: false, error: "ledger_id must be a uuid" }, 400);

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { fetch },
      auth: { persistSession: false },
    });

    // Resolve actor
    let actorId = body.actor_id?.trim() ?? null;
    if (actorId && !isUuid(actorId)) return json({ ok: false, error: "actor_id must be a uuid" }, 400);

    if (!actorId) {
      if (!jwt) return json({ ok: false, error: "Auth session missing" }, 401);

      const { data: userRes, error: userErr } = await supabaseAdmin.auth.getUser(jwt);
      if (userErr || !userRes?.user?.id) {
        return json(
          { ok: false, error: "Unable to resolve actor", details: userErr, request_id: reqId },
          401,
        );
      }
      actorId = userRes.user.id;
    }

    // --- Canonical enterprise sealer call ---
    const { data, error } = await supabaseAdmin.rpc("seal_governance_record_for_archive", {
      p_actor_id: actorId,
      p_ledger_id: ledgerId,
    });

    if (error) {
      return json(
        {
          ok: false,
          error: error.message ?? "seal failed",
          details: error,
          request_id: reqId,
        },
        500,
      );
    }

    const row = Array.isArray(data) ? data[0] : data;

    // --- Surgical repair: ensure Minute Book evidence pointers are consistent + exact ---
    const repair = await ensureMinuteBookEvidence({
      supabaseAdmin,
      ledgerId,
      actorId,
      minuteBookEntryId: row?.minute_book_entry_id ?? null,
    });

    return json({
      ok: true,
      ledger_id: ledgerId,
      actor_id: actorId,
      storage_bucket: row?.storage_bucket ?? null,
      storage_path: row?.storage_path ?? null,
      file_hash: row?.file_hash ?? null,
      verified_document_id: row?.verified_document_id ?? null,
      minute_book_entry_id: row?.minute_book_entry_id ?? null,
      minute_book_repair: repair ?? null,
      request_id: reqId,
    });
  } catch (e) {
    return json(
      {
        ok: false,
        error: "archive-save-document failed",
        details: String(e),
        request_id: reqId,
      },
      500,
    );
  }
});
