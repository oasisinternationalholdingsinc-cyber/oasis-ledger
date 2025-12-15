import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
function j(d, s = 200) {
  return new Response(JSON.stringify(d), {
    status: s,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, content-type, apikey",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    }
  });
}
serve(async (req)=>{
  if (req.method === "OPTIONS") return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, content-type, apikey",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    }
  });
  if (req.method !== "POST") return j({
    ok: false,
    error: "Use POST"
  }, 405);
  try {
    const origin = new URL(req.url).origin; // https://<ref>.supabase.co
    const url = `${origin}/rest/v1/v_ai_sentinel_status?select=*`;
    const apikey = req.headers.get("apikey") || Deno.env.get("SUPABASE_ANON_KEY") || "";
    const r = await fetch(url, {
      headers: {
        apikey,
        Authorization: `Bearer ${apikey}`
      }
    });
    if (!r.ok) return j({
      ok: false,
      error: `status query ${r.status}`
    }, 200);
    const rows = await r.json();
    const row = Array.isArray(rows) && rows.length ? rows[0] : null;
    if (!row) return j({
      ok: true,
      status: "unknown",
      data: null
    });
    return j({
      ok: true,
      status: row.status,
      now_utc: row.now_utc,
      last_beat_utc: row.last_beat_utc,
      hours_since_last_beat: row.hours_since_last_beat
    });
  } catch (e) {
    return j({
      ok: false,
      error: "status_query_failed"
    });
  }
});
