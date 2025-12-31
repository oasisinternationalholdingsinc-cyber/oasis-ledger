import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json, getServiceClient, invokeEdgeFunction } from "../_shared/archive.ts";

type ReqBody = {
  envelope_id: string; // signature_envelopes.id
  is_test?: boolean;   // informational; ledger row is source of truth
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  try {
    const { envelope_id, is_test }: ReqBody = await req.json();
    if (!envelope_id) return json({ ok: false, error: "Missing envelope_id" }, 400);

    const supabase = getServiceClient();

    // ✅ Only trust real schema columns
    const { data: envRow, error: envErr } = await supabase
      .from("signature_envelopes")
      .select("id, record_id, status, completed_at")
      .eq("id", envelope_id)
      .maybeSingle();

    if (envErr) {
      return json(
        { ok: false, step: "load_signature_envelope", error: envErr.message, details: envErr },
        500,
      );
    }
    if (!envRow) return json({ ok: false, error: "Envelope not found" }, 404);

    const ledgerId = (envRow as any).record_id as string | null;
    if (!ledgerId) return json({ ok: false, error: "Envelope missing record_id" }, 500);

    if ((envRow as any).status !== "completed") {
      return json(
        { ok: false, error: "Envelope is not completed yet", envelope_status: (envRow as any).status },
        400,
      );
    }

    // ✅ Delegate to canonical archive-save-document (service_role -> service_role)
    const r = await invokeEdgeFunction("archive-save-document", {
      record_id: ledgerId,
      is_test: !!is_test,
    });

    if (!r.ok) {
      return json(
        {
          ok: false,
          step: "archive-signed-resolution",
          ledger_id: ledgerId,
          envelope_id,
          error: `invoke_archive_save_document: non-2xx`,
          archive_save_document: {
            status: r.status,
            body: r.json ?? r.text,
          },
        },
        500,
      );
    }

    return json(
      {
        ok: true,
        step: "archive-signed-resolution",
        ledger_id: ledgerId,
        envelope_id,
        is_test: !!is_test,
        archive_save_document: r.json ?? r.text,
      },
      200,
    );
  } catch (e) {
    return json(
      {
        ok: false,
        step: "archive-signed-resolution",
        error: e instanceof Error ? e.message : String(e),
      },
      500,
    );
  }
});
