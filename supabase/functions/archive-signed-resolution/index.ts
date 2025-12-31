import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  envelope_id: string; // signature_envelopes.id
  is_test?: boolean;
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

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

function asBool(v: unknown, fallback = false) {
  if (typeof v === "boolean") return v;
  return fallback;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  try {
    const body = (await req.json()) as ReqBody;
    const envelope_id = (body?.envelope_id ?? "").trim();
    const is_test = asBool(body?.is_test, false);

    if (!envelope_id) {
      return json({ ok: false, error: "envelope_id is required" }, 400);
    }

    /* ------------------------------------------------------------------
     * 1) Load envelope (authoritative for completion)
     * ------------------------------------------------------------------ */
    const envRes = await supabase
      .from("signature_envelopes")
      .select("id, record_id, status")
      .eq("id", envelope_id)
      .maybeSingle();

    if (envRes.error || !envRes.data) {
      return json(
        {
          ok: false,
          error: "signature_envelopes row not found",
          details: envRes.error ?? null,
        },
        404,
      );
    }

    const record_id = envRes.data.record_id as string;
    const status = envRes.data.status as string | null;

    if (status !== "completed") {
      return json(
        {
          ok: false,
          error: "Envelope is not completed",
          envelope_status: status,
        },
        400,
      );
    }

    /* ------------------------------------------------------------------
     * 2) Delegate ALL archive logic to archive-save-document
     *     - idempotent
     *     - repair-capable
     *     - truth-lane safe
     * ------------------------------------------------------------------ */
    const { data, error } = await supabase.functions.invoke(
      "archive-save-document",
      {
        body: {
          record_id,
          envelope_id,
          is_test,
        },
      },
    );

    if (error) {
      return json(
        {
          ok: false,
          error: "archive-save-document invocation failed",
          details: error,
        },
        500,
      );
    }

    if (!data?.ok) {
      return json(
        {
          ok: false,
          error: data?.error ?? "archive-save-document failed",
          details: data ?? null,
        },
        500,
      );
    }

    /* ------------------------------------------------------------------
     * 3) Return clean enterprise response
     * ------------------------------------------------------------------ */
    return json({
      ok: true,
      record_id,
      envelope_id,
      minute_book_entry_id: data.minute_book_entry_id ?? null,
      already_archived: data.already_archived ?? false,
      seal: data.seal ?? null,
      verified_document: data.verified_document ?? null,
    });
  } catch (e: any) {
    return json(
      {
        ok: false,
        error: e?.message ?? "Unhandled error",
      },
      500,
    );
  }
});
