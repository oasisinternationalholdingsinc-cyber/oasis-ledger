import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  envelope_id: string;   // signature_envelopes.id
  is_test?: boolean;     // optional (lane)
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
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY =
  Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("ANON_KEY") ?? "";

// Call the other function internally (single source of truth)
const ARCHIVE_SAVE_FN = "archive-save-document";

function getBearer(req: Request) {
  const h = req.headers.get("authorization") || req.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m?.[1] ?? null;
}

async function requireUserId(req: Request): Promise<string> {
  const token = getBearer(req);
  if (!token) throw new Error("Missing Authorization Bearer token");

  if (SUPABASE_ANON_KEY) {
    const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data, error } = await authClient.auth.getUser();
    if (error || !data?.user?.id) throw new Error("Invalid session");
    return data.user.id;
  }

  const parts = token.split(".");
  if (parts.length < 2) throw new Error("Invalid JWT");
  const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
  if (!payload?.sub) throw new Error("JWT missing sub");
  return String(payload.sub);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  try {
    // Validate session (and keep Authorization header intact for downstream)
    await requireUserId(req);

    const body = (await req.json()) as ReqBody;
    const envelope_id = String(body.envelope_id || "").trim();
    if (!envelope_id) return json({ ok: false, error: "envelope_id is required" }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { global: { fetch } });

    // 1) Load envelope and ensure completed; record_id is the governance_ledger.id
    const { data: envRow, error: envErr } = await admin
      .from("signature_envelopes")
      .select("id,status,record_id,is_test,completed_at")
      .eq("id", envelope_id)
      .maybeSingle();

    if (envErr) throw envErr;
    if (!envRow) return json({ ok: false, error: "signature_envelopes not found" }, 404);

    if (String(envRow.status) !== "completed") {
      return json(
        { ok: false, error: "Envelope not completed", status: envRow.status },
        400,
      );
    }

    const record_id = String(envRow.record_id || "");
    if (!record_id) throw new Error("Envelope missing record_id");

    const lane_is_test =
      typeof body.is_test === "boolean"
        ? body.is_test
        : typeof envRow.is_test === "boolean"
          ? !!envRow.is_test
          : false;

    // 2) Delegate to archive-save-document (canonical)
    const url = `${SUPABASE_URL}/functions/v1/${ARCHIVE_SAVE_FN}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Forward the caller’s auth so archive-save-document can attribute uploaded_by/owner_id
        Authorization: req.headers.get("Authorization") || req.headers.get("authorization") || "",
        apikey: req.headers.get("apikey") || "",
      },
      body: JSON.stringify({ record_id, is_test: lane_is_test }),
    });

    const out = await resp.json().catch(() => ({}));
    if (!resp.ok) return json({ ok: false, error: "archive-save-document failed", details: out }, 500);

    return json({
      ok: true,
      envelope_id,
      record_id,
      is_test: lane_is_test,
      result: out,
    });
  } catch (e) {
    console.error("archive-signed-resolution error", e);
    return json({ ok: false, error: (e as Error).message ?? String(e) }, 500);
  }
});
