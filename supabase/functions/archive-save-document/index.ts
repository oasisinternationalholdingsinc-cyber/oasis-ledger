import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json, getServiceClient } from "../_shared/archive.ts";

type ReqBody = {
  record_id: string; // governance_ledger.id
  is_test?: boolean; // optional; SQL is source-of-truth
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  try {
    const { record_id }: ReqBody = await req.json();
    if (!record_id) return json({ ok: false, error: "Missing record_id" }, 400);

    const supabase = getServiceClient();

    // ✅ Single source of truth: SQL does deterministic render + hash + verified_documents + ledger lock
    const { data, error } = await supabase.rpc("seal_governance_record_for_archive", {
      p_ledger_id: record_id,
    });

    if (error) {
      return json(
        {
          ok: false,
          step: "seal_governance_record_for_archive",
          error: error.message,
          details: error,
        },
        500,
      );
    }

    // NOTE:
    // Minute Book registration + supporting_documents primary pointers
    // should remain inside your existing enterprise SQL/edge pipeline.
    // (Per your “no rewiring” rule.)
    return json(
      {
        ok: true,
        step: "archive-save-document",
        record_id,
        sealed: data,
      },
      200,
    );
  } catch (e) {
    return json(
      {
        ok: false,
        step: "archive-save-document",
        error: e instanceof Error ? e.message : String(e),
      },
      500,
    );
  }
});
