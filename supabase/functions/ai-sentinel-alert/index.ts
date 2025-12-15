// supabase/functions/ai-sentinel-alert/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
/** small helpers */ function j(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, content-type, apikey",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    }
  });
}
function htmlEmail(params) {
  const { statusText, ageMin, thresholdMin, lastHeartbeatAt, reason } = params;
  const ts = new Date().toISOString();
  return `
  <div style="font-family:Arial,Helvetica,sans-serif; background:#f8f9fa; padding:24px; color:#1d232a;">
    <h2 style="margin:0 0 8px; color:#0c6b30;">Oasis Digital Parliament — AI Sentinel</h2>
    <p style="margin:0 0 16px;">${statusText}</p>

    <table style="border-collapse:collapse; width:100%; max-width:620px;">
      <tbody>
        <tr><td style="padding:8px 12px; border:1px solid #e5e7eb; background:#fff;"><strong>Heartbeat age</strong></td>
            <td style="padding:8px 12px; border:1px solid #e5e7eb; background:#fff;">${ageMin.toFixed(1)} min</td></tr>
        <tr><td style="padding:8px 12px; border:1px solid #e5e7eb; background:#fff;"><strong>Threshold</strong></td>
            <td style="padding:8px 12px; border:1px solid #e5e7eb; background:#fff;">${thresholdMin} min</td></tr>
        <tr><td style="padding:8px 12px; border:1px solid #e5e7eb; background:#fff;"><strong>Last heartbeat (UTC)</strong></td>
            <td style="padding:8px 12px; border:1px solid #e5e7eb; background:#fff;">${lastHeartbeatAt ?? "unknown"}</td></tr>
        <tr><td style="padding:8px 12px; border:1px solid #e5e7eb; background:#fff;"><strong>Reason</strong></td>
            <td style="padding:8px 12px; border:1px solid #e5e7eb; background:#fff;">${reason}</td></tr>
        <tr><td style="padding:8px 12px; border:1px solid #e5e7eb; background:#fff;"><strong>Timestamp (UTC)</strong></td>
            <td style="padding:8px 12px; border:1px solid #e5e7eb; background:#fff;">${ts}</td></tr>
      </tbody>
    </table>

    <p style="margin:16px 0 0; font-size:12px; color:#6b7280;">
      Sent automatically by Oasis AI Sentinel from the Digital Parliament Ledger.<br/>
      © Oasis International Holdings Inc.
    </p>
  </div>`;
}
serve(async (req)=>{
  // --- CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, content-type, apikey",
        "Access-Control-Allow-Methods": "POST, OPTIONS"
      }
    });
  }
  if (req.method !== "POST") return j({
    ok: false,
    error: "Use POST"
  }, 405);
  // --- Parse body
  let body = {};
  try {
    body = await req.json();
  } catch  {
    body = {};
  }
  const force = body?.force === true;
  const dryRun = body?.dry_run === true || body?.dryRun === true;
  const thresholdMinutes = Number(body?.threshold_minutes ?? 36 * 60); // default 36h
  // --- Read heartbeat from your view
  let ageMin = 0;
  let lastHeartbeatAt = null;
  let reason = "ok";
  try {
    const origin = new URL(req.url).origin;
    const url = `${origin}/rest/v1/v_ai_sentinel_status?select=*`;
    const apikey = req.headers.get("apikey") || Deno.env.get("SUPABASE_ANON_KEY") || "";
    const r = await fetch(url, {
      headers: {
        apikey,
        Authorization: `Bearer ${apikey}`
      }
    });
    if (!r.ok) throw new Error(`status query ${r.status}`);
    const rows = await r.json();
    if (Array.isArray(rows) && rows.length > 0) {
      const row = rows[0];
      // match your actual view columns
      lastHeartbeatAt = row?.last_beat_utc ?? null;
      const ageHours = Number(row?.hours_since_last_beat) || 0;
      ageMin = ageHours * 60;
      reason = row?.status || "ok";
    } else reason = "no_status_row";
  } catch  {
    reason = "status_query_failed";
  }
  // --- Decide action
  const shouldAlert = force || ageMin > thresholdMinutes;
  // --- Send email via Resend (only when alerting and not dry run)
  if (shouldAlert && !dryRun) {
    try {
      const resendKey = Deno.env.get("RESEND_API_KEY");
      const toRaw = Deno.env.get("ALERT_TO");
      const fromEmail = Deno.env.get("ALERT_FROM") || "alerts@oasisintlholdings.com";
      if (resendKey && toRaw) {
        const to = toRaw.split(",").map((s)=>s.trim()).filter(Boolean);
        const isForced = force && !(ageMin > thresholdMinutes);
        const subject = isForced ? "⚠️ AI Sentinel — Manual alert (forced)" : `🚨 AI Sentinel — Heartbeat stale (${ageMin.toFixed(1)} min)`;
        const text = [
          isForced ? "Manual alert (forced)." : "AI Sentinel detected a stale/missing heartbeat.",
          `Age: ${ageMin.toFixed(1)} min`,
          `Threshold: ${thresholdMinutes} min`,
          `Reason: ${reason}`,
          `Last heartbeat: ${lastHeartbeatAt ?? "unknown"}`,
          "",
          "Logged automatically in the Digital Parliament Ledger."
        ].join("\n");
        const html = htmlEmail({
          statusText: isForced ? "Manual alert (forced)." : "AI Sentinel detected a stale/missing heartbeat.",
          ageMin,
          thresholdMin: thresholdMinutes,
          lastHeartbeatAt,
          reason
        });
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resendKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            from: fromEmail,
            to,
            subject,
            text,
            html
          })
        });
      } else console.warn("Missing RESEND_API_KEY or ALERT_TO; skipping email");
    } catch (e) {
      console.error("Email send failed:", e);
    }
  }
  // --- Final response
  return j({
    ok: true,
    status: shouldAlert ? "alerted" : "ok",
    action: shouldAlert ? "alerted" : "noop",
    last_heartbeat_at: lastHeartbeatAt,
    heartbeat_age_min: Number(ageMin.toFixed(3)),
    threshold_minutes: thresholdMinutes,
    reason,
    dry_run: dryRun
  });
});
