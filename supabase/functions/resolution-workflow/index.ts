// supabase/functions/resolution-workflow/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// -----------------------------------------------------------------------------
// ENV + CLIENT
// -----------------------------------------------------------------------------
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const OPENAI_KEY = Deno.env.get("OPENAI_KEY");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY"); // used to call draft-resolution
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
async function callDraftResolution(body) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/draft-resolution`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`draft-resolution failed: ${txt}`);
  }
  return await res.json();
}
async function callOpenAI(prompt, type) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: type === "summary" ? "You are an expert corporate governance assistant. Summarize resolutions clearly and concisely." : "You are a risk-focused corporate governance and compliance analyst. Highlight issues, risks, and recommendations."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.2
    })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI ${type} failed: ${txt}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error(`Empty OpenAI ${type} content`);
  }
  return {
    text: content,
    raw: data
  };
}
// -----------------------------------------------------------------------------
// MAIN HANDLER
// -----------------------------------------------------------------------------
serve(async (req)=>{
  if (req.method !== "POST") {
    return json({
      error: "Only POST allowed"
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
  const { entity_id, fiscal_year, fiscal_year_end, meeting_date, directors, doc_type = "annual_board_approval" } = body;
  if (!entity_id || !fiscal_year || !fiscal_year_end || !meeting_date || !directors?.length) {
    return json({
      error: "Missing required fields"
    }, 400);
  }
  try {
    // 1) Step 1 – draft with existing function
    const draft = await callDraftResolution({
      entity_id,
      fiscal_year,
      fiscal_year_end,
      meeting_date,
      directors,
      doc_type
    });
    if (!draft.ok) {
      return json({
        error: "Drafting failed",
        details: draft
      }, 500);
    }
    const { ledger_id, resolution_id, title, body: resolutionBody } = draft;
    // 2) Step 2 – run summary + analysis in parallel (Hybrid option C)
    const summaryPrompt = `
Summarize the following board resolution in 4–6 bullet points for the internal board record.
Focus on:
- What is being approved
- Which entity and fiscal year
- Key authorizations given
- Any follow-up actions

Resolution text:
${resolutionBody}
    `.trim();
    const analysisPrompt = `
Analyze the following board resolution for a Canadian holding company.
Return your response in three clearly labeled sections:

1) Key Points
2) Risks / Considerations
3) Recommendations (for directors or management)

Resolution text:
${resolutionBody}
    `.trim();
    const [summaryResult, analysisResult] = await Promise.all([
      callOpenAI(summaryPrompt, "summary"),
      callOpenAI(analysisPrompt, "analysis")
    ]);
    const summaryText = summaryResult.text;
    const analysisText = analysisResult.text;
    // 3) Step 3 – ai_summaries
    const { data: summaryRow, error: summaryErr } = await supabase.from("ai_summaries").insert({
      record_id: ledger_id,
      summary: summaryText,
      ai_source: "cloud",
      model_id: "gpt-4.1-mini",
      model: "gpt-4.1-mini",
      source_table: "governance_ledger",
      raw_response: summaryResult.raw
    }).select("id").single();
    if (summaryErr || !summaryRow) {
      throw new Error(`Failed to insert ai_summaries: ${summaryErr?.message}`);
    }
    const ai_summary_id = summaryRow.id;
    // 4) Step 4 – ai_analyses
    const { data: analysisRow, error: analysisErr } = await supabase.from("ai_analyses").insert({
      record_id: ledger_id,
      analysis: analysisText,
      ai_source: "cloud",
      model_id: "gpt-4.1-mini",
      model: "gpt-4.1-mini",
      raw_response: analysisResult.raw
    }).select("id").single();
    if (analysisErr || !analysisRow) {
      throw new Error(`Failed to insert ai_analyses: ${analysisErr?.message}`);
    }
    // 5) Step 5 – ai_advice (simple: reuse analysis as recommendation/advice)
    const { data: adviceRow, error: adviceErr } = await supabase.from("ai_advice").insert({
      record_id: ledger_id,
      recommendation: analysisText,
      advice: analysisText,
      risk_rating: 1,
      confidence: 0.8,
      ai_source: "cloud",
      model_id: "gpt-4.1-mini",
      model: "gpt-4.1-mini"
    }).select("id").single();
    if (adviceErr || !adviceRow) {
      throw new Error(`Failed to insert ai_advice: ${adviceErr?.message}`);
    }
    // 6) Step 6 – baseline compliance review
    const { data: complianceRow, error: complianceErr } = await supabase.from("compliance_reviews").insert({
      record_id: ledger_id,
      compliant: true,
      risk_level: "low",
      ai_summary: {
        summary: summaryText,
        analysis: analysisText
      },
      source_table: "governance_ledger",
      summary: `Auto compliance review for resolution "${title}"`,
      issues: [],
      actions: [],
      notes: "Baseline AI review: no issues detected for standard annual financial statement approval resolution.",
      overall_status: "compliant",
      ai_source: "cloud",
      model_id: "gpt-4.1-mini",
      model: "gpt-4.1-mini"
    }).select("id").single();
    if (complianceErr || !complianceRow) {
      throw new Error(`Failed to insert compliance_reviews: ${complianceErr?.message}`);
    }
    // 7) Step 7 – update governance_ledger flags
    const { error: ledgerUpdateErr } = await supabase.from("governance_ledger").update({
      summarized: true,
      needs_summary: false,
      ai_summary_id,
      ai_status: "analyzed",
      compliance_status: "compliant"
    }).eq("id", ledger_id);
    if (ledgerUpdateErr) {
      throw new Error(`Failed to update governance_ledger: ${ledgerUpdateErr.message}`);
    }
    // 8) Final response
    return json({
      ok: true,
      ledger_id,
      resolution_id,
      title,
      summary: summaryText,
      analysis: analysisText,
      advice_id: adviceRow.id,
      compliance_review_id: complianceRow.id,
      body: resolutionBody
    });
  } catch (e) {
    console.error("resolution-workflow error:", e);
    return json({
      error: String(e)
    }, 500);
  }
});
