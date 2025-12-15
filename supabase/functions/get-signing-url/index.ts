import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// ----------------------------------------------------------------------------
// SUPABASE CLIENT
// ----------------------------------------------------------------------------
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: {
    fetch
  }
});
// JSON helper with CORS
function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey"
    }
  });
}
// ----------------------------------------------------------------------------
// HTTP HANDLER
// ----------------------------------------------------------------------------
serve(async (req)=>{
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey"
      }
    });
  }
  // Only allow POST
  if (req.method !== "POST") {
    return json({
      ok: false,
      error: "Use POST"
    }, 405);
  }
  // Parse body
  let body;
  try {
    body = await req.json();
  } catch  {
    return json({
      ok: false,
      error: "Invalid JSON body"
    }, 400);
  }
  const { envelope_id, party_id } = body ?? {};
  if (!envelope_id || !party_id) {
    return json({
      ok: false,
      error: "envelope_id and party_id are required"
    }, 400);
  }
  // Look up the party and make sure it belongs to this envelope
  const { data: party, error: partyErr } = await supabase.from("signature_parties").select("id, envelope_id, status, display_name").eq("id", party_id).eq("envelope_id", envelope_id).single();
  if (partyErr || !party) {
    return json({
      ok: false,
      error: "Party not found on this envelope",
      details: partyErr
    }, 404);
  }
  // ----------------------------------------------------------------------------
  // BUILD SIGNING URL TO YOUR NEW LANDING PAGE
  // ----------------------------------------------------------------------------
  // You can override this in Supabase env vars if you want:
  //   SIGN_BASE_URL = https://sign.oasisintlholdings.com
  const SIGN_BASE_URL = Deno.env.get("SIGN_BASE_URL") ?? Deno.env.get("SIGNING_APP_URL") ?? // backwards-compat
  "https://sign.oasisintlholdings.com";
  const base = SIGN_BASE_URL.replace(/\/$/, ""); // strip trailing /
  const signerName = party.display_name || "Signer";
  const qs = new URLSearchParams({
    party_id: String(party_id),
    envelope_id: String(envelope_id),
    name: signerName
  });
  // Final link that goes into emails / frontend
  const signing_url = `${base}/sign.html?${qs.toString()}`;
  return json({
    ok: true,
    signing_url,
    party: {
      id: party.id,
      status: party.status,
      display_name: party.display_name
    }
  });
});
