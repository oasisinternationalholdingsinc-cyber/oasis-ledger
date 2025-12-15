// supabase/functions/draft-resolution/index.ts
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
  const { entity_id, doc_type = "annual_board_approval", fiscal_year, fiscal_year_end, meeting_date, directors } = body;
  if (!entity_id || !fiscal_year || !fiscal_year_end || !meeting_date || !directors?.length) {
    return json({
      error: "Missing required fields"
    }, 400);
  }
  // 1) Load entity + template
  const { data: entity, error: entityErr } = await supabase.from("entities").select("id, name, slug").eq("id", entity_id).single();
  if (entityErr || !entity) {
    return json({
      error: "Entity not found",
      details: entityErr
    }, 400);
  }
  const { data: template, error: tplErr } = await supabase.from("governance_templates").select("schema_json, required_fields").eq("doc_type", doc_type).order("created_at", {
    ascending: false
  }).limit(1).single();
  if (tplErr || !template) {
    return json({
      error: "Template not found for doc_type",
      details: tplErr
    }, 400);
  }
  const schema = template.schema_json;
  // 2) Build a base draft from the template (simple placeholder replacement)
  const baseTitle = (schema.title || "").replace("{{entity_name}}", entity.name).replace("{{fiscal_year}}", fiscal_year).replace("{{fiscal_year_end}}", fiscal_year_end);
  const baseWhereas = (schema.whereas || []).map((w)=>w.replace("{{entity_name}}", entity.name).replace("{{fiscal_year}}", fiscal_year).replace("{{fiscal_year_end}}", fiscal_year_end));
  const baseResolved = (schema.resolved || []).map((r)=>r.replace("{{entity_name}}", entity.name).replace("{{fiscal_year}}", fiscal_year).replace("{{fiscal_year_end}}", fiscal_year_end));
  // 3) Ask OpenAI to polish / structure the resolution into JSON
  const prompt = `
You are a corporate law assistant helping draft board resolutions for a Canadian holding company.

Draft a clean, professional board resolution approving the annual financial statements for the company.

Company: ${entity.name}
Fiscal year: ${fiscal_year}
Fiscal year end: ${fiscal_year_end}
Meeting date: ${meeting_date}
Directors: ${directors.join(", ")}

You are given a base template:

TITLE:
${baseTitle}

WHEREAS clauses:
${baseWhereas.map((w, i)=>`${i + 1}. ${w}`).join("\n")}

RESOLVED clauses:
${baseResolved.map((r, i)=>`${i + 1}. ${r}`).join("\n")}

Return a STRICT JSON object with this shape:

{
  "title": "string",
  "whereas": ["clause 1", "clause 2", "..."],
  "resolved": ["clause 1", "clause 2", "..."],
  "body": "full formatted resolution text combining all the above, ready for a minute book"
}

Do NOT include any backticks or commentary. Only return valid JSON.
  `.trim();
  const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: "You are a precise legal drafting assistant for corporate governance."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.2
    })
  });
  if (!aiRes.ok) {
    const txt = await aiRes.text();
    return json({
      error: "OpenAI request failed",
      details: txt
    }, 500);
  }
  const aiJson = await aiRes.json();
  const content = aiJson.choices?.[0]?.message?.content;
  if (!content) {
    return json({
      error: "No content from OpenAI"
    }, 500);
  }
  let draft;
  try {
    draft = JSON.parse(content);
  } catch (e) {
    return json({
      error: "Failed to parse AI JSON",
      raw: content,
      details: String(e)
    }, 500);
  }
  const finalTitle = draft.title || baseTitle;
  const finalWhereas = draft.whereas || baseWhereas;
  const finalResolved = draft.resolved || baseResolved;
  const bodyText = draft.body || `${baseWhereas.join("\n")}\n\n${baseResolved.join("\n")}`;
  // 4) Find a section for this entity
  const { data: section, error: sectionErr } = await supabase.from("sections").select("id").eq("entity_id", entity_id).order("created_at", {
    ascending: true
  }).limit(1).single();
  if (sectionErr || !section) {
    return json({
      error: "No section found for entity",
      details: sectionErr
    }, 400);
  }
  // 5) Insert governance_ledger
  const { data: ledgerInsert, error: ledgerErr } = await supabase.from("governance_ledger").insert({
    entity_id,
    title: finalTitle,
    description: "AI-drafted annual board approval resolution.",
    record_type: "resolution",
    provisional: true,
    needs_summary: true,
    ai_status: "pending",
    compliance_status: "pending"
  }).select("id").single();
  if (ledgerErr || !ledgerInsert) {
    return json({
      error: "Failed to insert governance_ledger",
      details: ledgerErr
    }, 500);
  }
  const ledger_id = ledgerInsert.id;
  // 6) Insert resolution
  const { data: resInsert, error: resErr } = await supabase.from("resolutions").insert({
    section_id: section.id,
    title: finalTitle,
    whereas_json: finalWhereas,
    resolve_json: finalResolved,
    status: "draft",
    entity_id,
    body: bodyText,
    body_json: {
      entity_name: entity.name,
      fiscal_year,
      fiscal_year_end,
      meeting_date,
      directors,
      ledger_id
    }
  }).select("id").single();
  if (resErr || !resInsert) {
    return json({
      error: "Failed to insert resolution",
      details: resErr
    }, 500);
  }
  const resolution_id = resInsert.id;
  return json({
    ok: true,
    ledger_id,
    resolution_id,
    title: finalTitle,
    whereas: finalWhereas,
    resolved: finalResolved,
    body: bodyText
  });
});
