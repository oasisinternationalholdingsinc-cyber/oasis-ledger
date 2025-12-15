// supabase/functions/ai-advisor/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// -----------------------------------------------------------------------------
// ENV + CLIENTS
// -----------------------------------------------------------------------------
const SUPABASE_URL = Deno.env.get("PROJECT_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY");
const OPENAI_KEY = Deno.env.get("OPENAI_KEY");
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing PROJECT_URL or SERVICE_ROLE_KEY");
}
if (!OPENAI_KEY) {
  throw new Error("Missing OPENAI_KEY");
}
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: {
    fetch
  }
});
// small JSON helper with CORS
function jsonResponse(data, status = 200) {
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
// -----------------------------------------------------------------------------
// OpenAI helper
// -----------------------------------------------------------------------------
async function callOpenAI(system, user) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: system
        },
        {
          role: "user",
          content: user
        }
      ],
      temperature: 0.2
    })
  });
  if (!r.ok) {
    return {
      ok: false,
      content: null,
      error: `OpenAI ${r.status}`
    };
  }
  const body = await r.json();
  const content = body?.choices?.[0]?.message?.content ?? "";
  return {
    ok: true,
    content,
    error: null
  };
}
// -----------------------------------------------------------------------------
// MAIN HANDLER
// -----------------------------------------------------------------------------
serve(async (req)=>{
  // CORS preflight
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
  if (req.method !== "POST") {
    return jsonResponse({
      ok: false,
      error: "Use POST"
    }, 405);
  }
  // ---------------- Parse body safely ----------------
  let body = {};
  try {
    body = await req.json();
  } catch  {
  // ignore, handled below
  }
  const recordId = body?.record_id ?? body?.resolution_id ?? body?.id;
  const text = (body?.text ?? "").toString();
  const goal = body?.goal ?? "Advise next steps for this board resolution for Oasis Digital Parliament Ledger.";
  if (!recordId || !text) {
    return jsonResponse({
      ok: false,
      error: "record_id and text are required"
    }, 400);
  }
  // ---------------- Call OpenAI ----------------
  const systemPrompt = "You are a pragmatic founder / board advisor. " + "Given a corporate resolution or context, you return:\n" + "### 1) Priorities (short bullet list)\n" + "### Steps (concrete next actions with owners and rough timelines)\n" + "### Risks/Mitigations (brief bullets)\n" + "Avoid fluff. Be concise and practical.";
  const userPrompt = `Resolution / context:\n${text}\n\n` + `Goal: ${goal}\n\n` + "Return markdown with the exact headings:\n" + "### 1) Priorities...\n" + "### Steps...\n" + "### Risks/Mitigations...\n";
  const aiResult = await callOpenAI(systemPrompt, userPrompt);
  if (!aiResult.ok || !aiResult.content) {
    console.error("OpenAI error:", aiResult.error);
    return jsonResponse({
      ok: false,
      error: aiResult.error ?? "OpenAI error"
    }, 500);
  }
  const adviceText = aiResult.content;
  // ---------------- Write to ai_advice ----------------
  // NOTE: Only use columns that actually exist in your table:
  // record_id, risk_rating (numeric), confidence (numeric),
  // advice, recommendation, ai_source, model_id, model_hash, generated_at (default)
  const { data: adviceRow, error: adviceError } = await supabase.from("ai_advice").insert({
    record_id: recordId,
    risk_rating: 1,
    confidence: 0.9,
    advice: adviceText,
    recommendation: adviceText,
    ai_source: "cloud",
    model_id: "gpt-4o-mini",
    model_hash: "v1"
  }).select("id").single();
  if (adviceError) {
    console.error("ai_advice insert error:", adviceError);
    return jsonResponse({
      ok: false,
      error: "DB insert error (ai_advice)"
    }, 500);
  }
  const aiAdviceId = adviceRow?.id ?? null;
  // ---------------- Optional debug logging ----------------
  // This SHOULD NOT throw even if ai_status_debug schema is a bit different.
  try {
    const { error: debugErr } = await supabase.from("ai_status_debug").insert({
      record_id: recordId,
      event: "ai-advisor-complete",
      details: `ai_advice_id=${aiAdviceId ?? "unknown"}`
    });
    if (debugErr) {
      console.error("ai_status_debug insert error:", debugErr);
    }
  } catch (e) {
    console.error("ai_status_debug logging threw:", e);
  }
  // ---------------- Final HTTP response ----------------
  return jsonResponse({
    ok: true,
    record_id: recordId,
    ai_advice_id: aiAdviceId,
    advice: adviceText
  });
});
