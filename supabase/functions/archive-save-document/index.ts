import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  // canonical
  ledger_id?: string;

  // legacy callers (some parts of UI used record_id)
  record_id?: string;

  // optional override (normally we derive from JWT)
  actor_id?: string;
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
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

serve(async (req) => {
  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

    // We NEED auth to resolve actor id for supporting_documents owner/uploaded_by.
    const authHeader = req.headers.get("authorization") ?? req.headers.get("Authorization");
    const jwt = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!jwt) return json({ ok: false, error: "Auth session missing!" }, 401);

    const body = (await req.json().catch(() => ({}))) as ReqBody;

    // ✅ accept BOTH ledger_id and legacy record_id
    const ledgerId = (body.ledger_id ?? body.record_id)?.trim();
    if (!ledgerId) return json({ ok: false, error: "ledger_id required" }, 400);

    // Admin client (bypasses RLS), but we still use JWT to resolve the actor.
    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { fetch },
      auth: { persistSession: false },
    });

    let actorId = body.actor_id?.trim() ?? null;

    if (!actorId) {
      const { data: userRes, error: userErr } = await supabaseAdmin.auth.getUser(jwt);
      if (userErr || !userRes?.user?.id) {
        return json(
          { ok: false, error: "Auth session missing!", details: userErr ?? null },
          401,
        );
      }
      actorId = userRes.user.id;
    }

    // ✅ Call the new overload we created: (p_actor_id, p_ledger_id)
    const { data, error } = await supabaseAdmin.rpc(
      "seal_governance_record_for_archive",
      {
        p_actor_id: actorId,
        p_ledger_id: ledgerId,
      },
    );

    if (error) {
      return json(
        {
          ok: false,
          error: error.message ?? "seal rpc failed",
          details: error,
        },
        500,
      );
    }

    // data is a TABLE(...) rowset; return first row for convenience
    const row = Array.isArray(data) ? data[0] : data;

    return json({
      ok: true,
      ledger_id: ledgerId,
      actor_id: actorId,
      storage_bucket: row?.storage_bucket ?? null,
      storage_path: row?.storage_path ?? null,
      file_hash: row?.file_hash ?? null,
      verified_document_id: row?.verified_document_id ?? null,
      minute_book_entry_id: row?.minute_book_entry_id ?? null,
      raw: data ?? null,
    });
  } catch (e) {
    return json(
      { ok: false, error: "archive-save-document failed", details: String(e) },
      500,
    );
  }
});
