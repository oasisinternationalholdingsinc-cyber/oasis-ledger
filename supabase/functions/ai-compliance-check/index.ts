// supabase/functions/ai-compliance-check/index.ts
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
  const { record_id, text, source_table = "governance_ledger" } = body;
  if (!record_id || !text) {
    return json({
      error: "record_id and text are required"
    }, 400);
  }
  // ---------- OpenAI compliance check ----------
  const prompt = `
You are an AI compliance officer for an Ontario corporate minute book.

Analyze the following resolution/governance text for legal, regulatory, and governance compliance.
Focus especially on: OBCA/CBCA, CRA, ServiceOntario filings, lender covenants, shareholder agreements,
and basic fiduciary duties of directors.

Return ONLY a JSON object with this exact shape:

{
  "summary": "2-4 sentence plain-language compliance summary",
  "risk_level": "low" | "medium" | "high",
  "compliant": true | false,
  "issues": ["list of key issues or risks"],
  "actions": ["list of concrete follow-up actions or filings"]
}

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
    console.error("OpenAI error (ai-compliance-check):", errText);
    return json({
      error: "OpenAI request failed",
      details: errText
    }, 502);
  }
  const aiJson = await aiRes.json();
  const rawText = aiJson?.output?.[0]?.content?.[0]?.text ?? aiJson?.choices?.[0]?.message?.content ?? JSON.stringify(aiJson);
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch  {
    // If it didn't return valid JSON, wrap as best-effort
    parsed = {
      summary: rawText,
      risk_level: "medium",
      compliant: false,
      issues: [
        "Model did not return strict JSON; review manually."
      ],
      actions: []
    };
  }
  const summary = parsed.summary ?? rawText;
  const risk_level = parsed.risk_level ?? "medium";
  const compliant = parsed.compliant ?? false;
  const issues = parsed.issues ?? [];
  const actions = parsed.actions ?? [];
  // ---------- Insert into compliance_reviews ----------
  // We'll start with generic columns; the error log will tell us
  // if any column names differ.
  const { data: review, error: reviewErr } = await supabase.from("compliance_reviews").insert({
    record_id,
    source_table,
    summary,
    risk_level,
    compliant,
    issues,
    actions,
    ai_source: "cloud",
    model: "gpt-4.1-mini",
    raw_response: aiJson
  }).select().single();
  if (reviewErr) {
    console.error("DB insert error (compliance_reviews):", reviewErr);
    return json({
      error: "Failed to insert compliance review",
      details: reviewErr
    }, 500);
  }
  // ---------- Optional: insert into compliance_audit_log ----------
  // If column names differ, we'll see it in the logs and adjust.
  const { error: auditErr } = await supabase.from("compliance_audit_log").insert({
    record_id,
    action: "ai_compliance_check",
    source_table,
    details: summary,
    context: {
      risk_level,
      compliant,
      issues,
      actions,
      review_id: review?.id ?? null
    },
    ai_source: "cloud"
  });
  if (auditErr) {
    console.error("DB insert error (compliance_audit_log):", auditErr);
  // Do not fail the whole request – audit log is secondary
  }
  return json({
    ok: true,
    review,
    parsed
  });
});
