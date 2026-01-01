import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  envelope_id: string;
  is_test?: boolean;
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};

const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

serve(async (req) => {
  // ------------------------
  // CORS / Preflight
  // ------------------------
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  try {
    // ------------------------
    // Parse request
    // ------------------------
    const body = (await req.json()) as ReqBody;
    const { envelope_id, is_test = false } = body ?? {};

    if (!envelope_id) {
      return json({ ok: false, error: "Missing envelope_id" }, 400);
    }

    // ------------------------
    // Supabase client (service role)
    // ------------------------
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
      Deno.env.get("SERVICE_ROLE_KEY")!;

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      global: { headers: { Authorization: req.headers.get("authorization")! } },
    });

    // ------------------------
    // Load envelope (source of truth)
    // ------------------------
    const { data: envelope, error: envErr } = await supabase
      .from("signature_envelopes")
      .select("id, record_id, status, completed_at")
      .eq("id", envelope_id)
      .maybeSingle();

    if (envErr || !envelope) {
      return json({ ok: false, error: "Envelope not found" }, 404);
    }

    if (envelope.status !== "completed") {
      return json(
        { ok: false, error: "Envelope not completed" },
        400,
      );
    }

    const ledgerId = envelope.record_id;

    if (!ledgerId) {
      return json(
        { ok: false, error: "Envelope missing record_id" },
        500,
      );
    }

    // ------------------------
    // Delegate ALL sealing to SQL (canonical)
    // ------------------------
    const { data: seal, error: sealErr } = await supabase.rpc(
      "seal_governance_record_for_archive",
      {
        p_ledger_id: ledgerId,
        p_is_test: is_test,
      },
    );

    if (sealErr) {
      console.error("seal_governance_record_for_archive failed", sealErr);
      return json(
        { ok: false, error: "Archive seal failed" },
        500,
      );
    }

    /**
     * seal_governance_record_for_archive is responsible for:
     * - generating archive-grade PDF
     * - writing minute_book_entries
     * - inserting/upserting verified_documents
     * - locking governance_ledger
     * - returning storage pointers
     */

    return json({
      ok: true,
      already_archived: seal?.already_archived ?? false,
      minute_book_entry_id: seal?.minute_book_entry_id ?? null,
      verified_document_id: seal?.verified_document_id ?? null,
    });
  } catch (err) {
    console.error("archive-signed-resolution fatal error", err);
    return json(
      { ok: false, error: "Unexpected archive error" },
      500,
    );
  }
});
