import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  ledger_id?: string;
  record_id?: string;
  actor_id?: string;
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
 * STORAGE API helper — authoritative existence probe
 * (NO PostgREST, NO storage.objects, NO schema cache)
 */
async function storageObjectExists(
  supabaseAdmin: ReturnType<typeof createClient>,
  bucket: string,
  path: string,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .storage
    .from(bucket)
    .createSignedUrl(path, 60);

  if (!error && data?.signedUrl) return true;

  const msg = (error as any)?.message ?? "";
  const status = (error as any)?.statusCode ?? null;

  if (status === 404 || /not found/i.test(msg)) return false;

  throw new Error(`Storage API failure: ${msg || JSON.stringify(error)}`);
}

/**
 * Enterprise-grade pointer repair (Storage API based)
 */
async function ensureMinuteBookEvidence(opts: {
  supabaseAdmin: ReturnType<typeof createClient>;
  ledgerId: string;
  actorId: string;
  minuteBookEntryId: string | null;
}) {
  const { supabaseAdmin, ledgerId, actorId, minuteBookEntryId } = opts;
  if (!minuteBookEntryId) return { ok: true, repaired: false };

  const { data: mbe, error: mbeErr } = await supabaseAdmin
    .from("minute_book_entries")
    .select("id, entity_key, title, storage_path, pdf_hash")
    .eq("id", minuteBookEntryId)
    .maybeSingle();

  if (mbeErr) throw new Error(mbeErr.message);
  if (!mbe?.storage_path) return { ok: true, repaired: false };

  const exists = await storageObjectExists(
    supabaseAdmin,
    "minute_book",
    mbe.storage_path,
  );

  if (!exists) {
    return {
      ok: true,
      repaired: false,
      reason: "storage_object_missing",
      expected_path: mbe.storage_path,
    };
  }

  const { data: docs } = await supabaseAdmin
    .from("supporting_documents")
    .select("id")
    .eq("entry_id", minuteBookEntryId)
    .order("uploaded_at", { ascending: false });

  const now = new Date().toISOString();

  if (!docs || docs.length === 0) {
    await supabaseAdmin.from("supporting_documents").insert({
      entry_id: minuteBookEntryId,
      entity_key: mbe.entity_key,
      file_path: mbe.storage_path,
      file_name: mbe.title ? `${mbe.title}.pdf` : `${ledgerId}.pdf`,
      doc_type: "resolution",
      uploaded_by: actorId,
      uploaded_at: now,
      owner_id: actorId,
      file_hash: mbe.pdf_hash ?? null,
      mime_type: "application/pdf",
      registry_visible: true,
      verified: true,
      section: "resolutions",
    });

    return { ok: true, repaired: true };
  }

  const winnerId = docs[0].id;
  const loserIds = docs.slice(1).map((d) => d.id);

  if (loserIds.length) {
    await supabaseAdmin
      .from("supporting_documents")
      .update({ registry_visible: false })
      .in("id", loserIds);
  }

  await supabaseAdmin
    .from("supporting_documents")
    .update({
      file_path: mbe.storage_path,
      registry_visible: true,
      owner_id: actorId,
      section: "resolutions",
    })
    .eq("id", winnerId);

  return { ok: true, repaired: true };
}

serve(async (req) => {
  const reqId = req.headers.get("x-sb-request-id");

  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

    const body = (await req.json().catch(() => ({}))) as ReqBody;
    const ledgerId = (body.ledger_id ?? body.record_id)?.trim();
    if (!ledgerId || !isUuid(ledgerId)) {
      return json({ ok: false, error: "ledger_id must be uuid" }, 400);
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { fetch },
      auth: { persistSession: false },
    });

    let actorId = body.actor_id ?? null;

    if (!actorId) {
      const auth = req.headers.get("authorization");
      if (!auth?.startsWith("Bearer ")) {
        return json({ ok: false, error: "Auth missing" }, 401);
      }

      const { data } = await supabaseAdmin.auth.getUser(auth.slice(7));
      actorId = data?.user?.id ?? null;
      if (!actorId) return json({ ok: false, error: "Actor unresolved" }, 401);
    }

    const { data, error } = await supabaseAdmin.rpc(
      "seal_governance_record_for_archive",
      { p_actor_id: actorId, p_ledger_id: ledgerId },
    );

    if (error) {
      return json({ ok: false, error: error.message }, 500);
    }

    const row = Array.isArray(data) ? data[0] : data;

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
      verified_document_id: row?.verified_document_id ?? null,
      minute_book_entry_id: row?.minute_book_entry_id ?? null,
      repair,
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
