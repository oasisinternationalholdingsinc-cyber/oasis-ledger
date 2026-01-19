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
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
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

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
}

const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(s);

function splitPath(p: string) {
  const norm = p.replace(/^\/+/, "");
  const idx = norm.lastIndexOf("/");
  if (idx === -1) return { dir: "", name: norm };
  return { dir: norm.slice(0, idx), name: norm.slice(idx + 1) };
}

async function storageExists(
  supabaseAdmin: ReturnType<typeof createClient>,
  bucket: string,
  fullPath: string,
) {
  const { dir, name } = splitPath(fullPath);
  const { data, error } = await supabaseAdmin.storage.from(bucket).list(dir, {
    limit: 100,
    search: name,
  });
  if (error) throw new Error(`Storage list failed (${bucket}): ${error.message}`);
  return !!(data ?? []).find((o) => o.name === name);
}

async function storageCopy(
  supabaseAdmin: ReturnType<typeof createClient>,
  src: { bucket: string; path: string },
  dst: { bucket: string; path: string },
) {
  const { data: dl, error: dlErr } = await supabaseAdmin.storage
    .from(src.bucket)
    .download(src.path);
  if (dlErr) throw new Error(`Storage download failed (${src.bucket}): ${dlErr.message}`);
  if (!dl) throw new Error(`Storage download returned empty for ${src.bucket}:${src.path}`);

  // Re-upload into destination bucket/path (idempotent)
  const { error: upErr } = await supabaseAdmin.storage.from(dst.bucket).upload(dst.path, dl, {
    contentType: "application/pdf",
    upsert: true,
  });
  if (upErr) throw new Error(`Storage upload failed (${dst.bucket}): ${upErr.message}`);

  return { ok: true };
}

/**
 * Enterprise repair:
 * - Ensures Minute Book Reader can open evidence:
 *   supporting_documents.primary.file_path must point to an object in bucket 'minute_book'
 * - If minute_book object missing, copy from sealed artifact bucket/path into minute_book path.
 * - Dedupe: exactly one registry_visible=true supporting_documents row per entry.
 */
async function ensureMinuteBookEvidence(opts: {
  supabaseAdmin: ReturnType<typeof createClient>;
  ledgerId: string;
  actorId: string;
  minuteBookEntryId: string | null;
  // The sealed artifact returned by seal_governance_record_for_archive (often governance_sandbox / governance_rot)
  sealedArtifact: { bucket: string | null; path: string | null };
}) {
  const { supabaseAdmin, ledgerId, actorId, minuteBookEntryId, sealedArtifact } = opts;

  if (!minuteBookEntryId) {
    return { ok: true, repaired: false, reason: "no_minute_book_entry_id" };
  }

  // 1) Load minute_book entry (contains the canonical minute_book storage_path that Reader must use)
  const { data: mbe, error: mbeErr } = await supabaseAdmin
    .from("minute_book_entries")
    .select("id, entity_key, domain_key, title, storage_path, pdf_hash, is_test, source_record_id")
    .eq("id", minuteBookEntryId)
    .maybeSingle();

  if (mbeErr) throw new Error(`minute_book_entries lookup failed: ${mbeErr.message}`);
  if (!mbe) return { ok: true, repaired: false, reason: "minute_book_entry_missing" };

  const minuteBookBucket = "minute_book";
  const minuteBookPath = (mbe.storage_path ?? "").trim();
  if (!minuteBookPath) {
    return {
      ok: true,
      repaired: false,
      reason: "minute_book_entry_missing_storage_path",
      minute_book_entry_id: minuteBookEntryId,
    };
  }

  // 2) Ensure the PDF actually exists in minute_book bucket at minuteBookPath
  const existsInMinuteBook = await storageExists(supabaseAdmin, minuteBookBucket, minuteBookPath);

  // If missing, copy from sealed artifact (governance_sandbox/governance_rot) → minute_book
  if (!existsInMinuteBook) {
    const srcBucket = sealedArtifact.bucket?.trim() ?? null;
    const srcPath = sealedArtifact.path?.trim() ?? null;

    if (!srcBucket || !srcPath) {
      return {
        ok: true,
        repaired: false,
        reason: "minute_book_object_missing_and_no_sealed_artifact",
        minute_book_entry_id: minuteBookEntryId,
        minute_book_path: minuteBookPath,
      };
    }

    // Verify source exists (avoid copying ghosts)
    const srcExists = await storageExists(supabaseAdmin, srcBucket, srcPath);
    if (!srcExists) {
      return {
        ok: true,
        repaired: false,
        reason: "sealed_artifact_missing_in_storage",
        source_bucket: srcBucket,
        source_path: srcPath,
        minute_book_path: minuteBookPath,
      };
    }

    await storageCopy(
      supabaseAdmin,
      { bucket: srcBucket, path: srcPath },
      { bucket: minuteBookBucket, path: minuteBookPath },
    );
  }

  // 3) Load supporting docs for the entry and enforce PRIMARY pointer
  const { data: docs, error: docsErr } = await supabaseAdmin
    .from("supporting_documents")
    .select("id, entry_id, file_path, registry_visible, uploaded_at, section, file_hash, owner_id")
    .eq("entry_id", minuteBookEntryId)
    .order("uploaded_at", { ascending: false });

  if (docsErr) throw new Error(`supporting_documents lookup failed: ${docsErr.message}`);

  const nowIso = new Date().toISOString();

  // Helper: attempt lowercase section label first; fallback to Title Case if enum demands it.
  const withSectionVariants = (payload: Record<string, unknown>) => ({
    lower: { ...payload, section: "resolutions" },
    upper: { ...payload, section: "Resolutions" },
  });

  // 4) If none exist, insert a primary row
  if (!docs || docs.length === 0) {
    const base = {
      entry_id: minuteBookEntryId,
      entity_key: mbe.entity_key,
      file_path: minuteBookPath,
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

    const v = withSectionVariants(base);

    let insErr = (await supabaseAdmin.from("supporting_documents").insert(v.lower)).error;
    if (insErr) {
      insErr = (await supabaseAdmin.from("supporting_documents").insert(v.upper)).error;
      if (insErr) throw new Error(`supporting_documents insert failed: ${insErr.message}`);
    }

    return {
      ok: true,
      repaired: true,
      minute_book_entry_id: minuteBookEntryId,
      minute_book_bucket: minuteBookBucket,
      minute_book_path: minuteBookPath,
      created_primary: true,
      copied_from_sealed_artifact: !existsInMinuteBook,
    };
  }

  // 5) Dedupe: newest row wins as primary, all others hidden
  const winner = docs[0];
  const loserIds = docs.slice(1).map((d) => d.id).filter(Boolean);

  if (loserIds.length) {
    const { error: hideErr } = await supabaseAdmin
      .from("supporting_documents")
      .update({ registry_visible: false })
      .in("id", loserIds);

    if (hideErr) throw new Error(`supporting_documents dedupe failed: ${hideErr.message}`);
  }

  // 6) Ensure winner points to minute_book path + visible
  const updBase: Record<string, unknown> = {
    file_path: minuteBookPath,
    registry_visible: true,
    file_hash: mbe.pdf_hash ?? null,
    owner_id: winner.owner_id ?? actorId, // keep non-null ownership
  };

  const upd = withSectionVariants(updBase);

  let upErr = (await supabaseAdmin.from("supporting_documents").update(upd.lower).eq("id", winner.id))
    .error;
  if (upErr) {
    upErr = (await supabaseAdmin.from("supporting_documents").update(upd.upper).eq("id", winner.id))
      .error;
    if (upErr) throw new Error(`supporting_documents update failed: ${upErr.message}`);
  }

  return {
    ok: true,
    repaired: true,
    minute_book_entry_id: minuteBookEntryId,
    minute_book_bucket: minuteBookBucket,
    minute_book_path: minuteBookPath,
    supporting_document_id: winner.id,
    deduped_hidden_count: loserIds.length,
    copied_from_sealed_artifact: !existsInMinuteBook,
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
          {
            ok: false,
            error: "Unable to resolve actor",
            details: userErr?.message ?? userErr,
            request_id: reqId,
          },
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
        { ok: false, error: error.message ?? "seal failed", details: error, request_id: reqId },
        500,
      );
    }

    const row = Array.isArray(data) ? data[0] : data;

    // --- Enterprise repair: ensure Minute Book Reader opens via minute_book bucket pointer ---
    const repair = await ensureMinuteBookEvidence({
      supabaseAdmin,
      ledgerId,
      actorId,
      minuteBookEntryId: row?.minute_book_entry_id ?? null,
      sealedArtifact: {
        bucket: row?.storage_bucket ?? null,
        path: row?.storage_path ?? null,
      },
    });

    // ✅ No-wiring regression: always surface Minute Book pointers as primary output.
    const minuteBookBucket = "minute_book";
    const minuteBookPath =
      (repair && typeof repair === "object" && "minute_book_path" in repair
        ? (repair as { minute_book_path?: string | null }).minute_book_path
        : null) ?? null;

    return json({
      ok: true,
      ledger_id: ledgerId,
      actor_id: actorId,

      // ✅ PRIMARY POINTERS (UI must use these)
      storage_bucket: minuteBookBucket,
      storage_path: minuteBookPath,

      // Hash + ids unchanged
      file_hash: row?.file_hash ?? null,
      verified_document_id: row?.verified_document_id ?? null,
      minute_book_entry_id: row?.minute_book_entry_id ?? null,

      // Optional debug (does not affect UI)
      sealed_artifact: {
        storage_bucket: row?.storage_bucket ?? null,
        storage_path: row?.storage_path ?? null,
      },

      // Repair details
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
