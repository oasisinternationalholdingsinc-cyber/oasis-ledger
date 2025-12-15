// supabase/functions/summarize/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const OPENAI_KEY = Deno.env.get("OPENAI_KEY");
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: {
    fetch
  }
});
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}
serve(async (req)=>{
  // Only allow POST
  if (req.method !== "POST") {
    return json({
      error: "Method not allowed"
    }, 405);
  }
  // Parse body
  let body;
  try {
    body = await req.json();
  } catch  {
    return json({
      error: "Invalid JSON body"
    }, 400);
  }
  const { record_id, text, source_table = "resolutions" } = body;
  if (!record_id || !text) {
    return json({
      error: "record_id and text are required"
    }, 400);
  }
  // ---------- Call OpenAI (Responses API) ----------
  const prompt = `
You are an AI corporate clerk for an Ontario corporate minute book.

Summarize the following text in 3–6 concise bullet points, plus 1 short risk/compliance note.
Focus on:
- Purpose of the resolution
- Key decisions
- Parties involved
- Any deadlines or filings

Text:
${text}
`.trim();
  const openaiRes = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input: prompt
    })
  });
  if (!openaiRes.ok) {
    const errText = await openaiRes.text();
    console.error("OpenAI error:", errText);
    return json({
      error: "OpenAI request failed",
      details: errText
    }, 502);
  }
  const openaiJson = await openaiRes.json();
  // Try Responses API shape first, then fall back
  const summaryText = openaiJson?.output?.[0]?.content?.[0]?.text ?? openaiJson?.choices?.[0]?.message?.content ?? JSON.stringify(openaiJson);
  // ---------- Insert into ai_summaries ----------
  // Matches your production schema + constraints:
  //   record_id      uuid (required)
  //   summary        text
  //   ai_source      text CHECK (e.g. 'cloud')
  //   model          text
  //   source_table   text
  //   raw_response   jsonb
  const { data, error } = await supabase.from("ai_summaries").insert({
    record_id,
    summary: summaryText,
    ai_source: "cloud",
    model: "gpt-4.1-mini",
    source_table,
    raw_response: openaiJson
  }).select().single();
  if (error) {
    console.error("DB insert error:", error);
    return json({
      error: "Failed to insert summary",
      details: error
    }, 500);
  }
  return json({
    ok: true,
    summary: data
  });
});
