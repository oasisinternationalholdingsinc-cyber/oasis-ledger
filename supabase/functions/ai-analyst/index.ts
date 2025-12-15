// supabase/functions/ai-analyst/index.ts
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
  if (req.method !== "POST") {
    return json({
      error: "Method not allowed"
    }, 405);
  }
  let body;
  try {
    body = await req.json();
  } catch  {
    return json({
      error: "Invalid JSON body"
    }, 400);
  }
  const { record_id, text } = body;
  if (!record_id || !text) {
    return json({
      error: "record_id and text are required"
    }, 400);
  }
  // -------- OpenAI: Deep governance / risk analysis --------
  const prompt = `
You are an AI governance and compliance analyst for an Ontario corporate minute book.

Analyze the following resolution or governance record.
Return your answer as clear sections with headings:

1. Plain-language summary (2–4 sentences)
2. Key decisions and approvals
3. Parties and entities involved
4. Compliance & filing obligations (CRA, OBCA, ServiceOntario, lenders, contracts, etc.)
5. Timing & deadlines (effective dates, filing windows)
6. Risks & red flags
7. Recommended follow-up actions and documentation (very concrete)

Text:
${text}
`.trim();
  const aiRes = await fetch("https://api.openai.com/v1/responses", {
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
  if (!aiRes.ok) {
    const errText = await aiRes.text();
    console.error("OpenAI error (ai-analyst):", errText);
    return json({
      error: "OpenAI request failed",
      details: errText
    }, 502);
  }
  const aiJson = await aiRes.json();
  const analysisText = aiJson?.output?.[0]?.content?.[0]?.text ?? aiJson?.choices?.[0]?.message?.content ?? JSON.stringify(aiJson);
  // -------- Insert into ai_analyses --------
  // We'll start with the most likely columns:
  //   record_id      uuid  (FK to governance_ledger.id)
  //   analysis       text  (main analysis text)
  //   ai_source      text  (with same constraint pattern as ai_summaries)
  //   model          text
  //   raw_response   jsonb
  //
  // If any column name doesn't match, the error log will tell us and we'll adjust.
  const { data, error } = await supabase.from("ai_analyses").insert({
    record_id,
    analysis: analysisText,
    ai_source: "cloud",
    model: "gpt-4.1-mini",
    raw_response: aiJson
  }).select().single();
  if (error) {
    console.error("DB insert error (ai-analyst):", error);
    return json({
      error: "Failed to insert analysis",
      details: error
    }, 500);
  }
  return json({
    ok: true,
    analysis: data
  });
});
