import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  ledger_id?: string;
  record_id?: string; // legacy compatibility
  actor_id?: string;  // optional override (operator/debug only)
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

const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(s);

serve(async (req) => {
  const reqId = req.headers.get("x-sb-request-id") ?? null;

  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

    // --- Auth required (actor resolution is mandatory) ---
    const authHeader =
      req.headers.get("authorization") ?? req.headers.get("Authorization");

    const jwt =
      authHeader && authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : null;

    const body = (await req.json().catch(() => ({}))) as ReqBody;

    // Accept both ledger_id and legacy record_id
    const ledgerId = (body.ledger_id ?? body.record_id)?.trim();
    if (!ledgerId) return json({ ok: false, error: "ledger_id required" }, 400);
    if (!isUuid(ledgerId)) {
      return json({ ok: false, error: "ledger_id must be a uuid" }, 400);
    }

    // Service-role client for RPC + auth.getUser
    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { fetch },
      auth: { persistSession: false },
    });

    // Resolve actor
    let actorId = body.actor_id?.trim() ?? null;
    if (actorId && !isUuid(actorId)) {
      return json({ ok: false, error: "actor_id must be a uuid" }, 400);
    }

    if (!actorId) {
      if (!jwt) {
        return json({ ok: false, error: "Auth session missing" }, 401);
      }

      const { data: userRes, error: userErr } =
        await supabaseAdmin.auth.getUser(jwt);

      if (userErr || !userRes?.user?.id) {
        return json(
          { ok: false, error: "Unable to resolve actor", details: userErr },
          401,
        );
      }

      actorId = userRes.user.id;
    }

    // --- Canonical enterprise sealer call ---
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
          error: error.message ?? "seal failed",
          details: error,
          request_id: reqId,
        },
        500,
      );
    }

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
