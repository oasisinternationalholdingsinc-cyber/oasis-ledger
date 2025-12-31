import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { corsHeaders, json, getServiceClient } from "../_shared/archive.ts";

type ReqBody = {
  record_id: string; // governance_ledger.id
  is_test?: boolean; // lane flag (informational; DB is source of truth)
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  try {
    const { record_id, is_test }: ReqBody = await req.json();
    if (!record_id) return json({ ok: false, error: "Missing record_id" }, 400);

    const supabase = getServiceClient();

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

    return json(
      {
        ok: true,
        step: "archive-save-document",
        record_id,
        is_test: !!is_test,
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
