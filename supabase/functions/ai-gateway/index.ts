import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
function j(data, status = 200) {
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
async function callOpenAI(system, user) {
  const key = Deno.env.get("OPENAI_KEY");
  if (!key) return {
    ok: false,
    error: "Missing OPENAI_KEY"
  };
  const body = {
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
  };
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) return {
    ok: false,
    error: `OpenAI ${r.status}`
  };
  const json = await r.json();
  const content = json?.choices?.[0]?.message?.content ?? "";
  return {
    ok: true,
    content
  };
}
serve(async (req)=>{
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
  let body = {};
  try {
    body = await req.json();
  } catch  {}
  const action = body.action ?? "summarize";
  const text = (body.text ?? "").toString().slice(0, 200_000);
  if (!text && action !== "advise") {
    return j({
      ok: false,
      error: "Missing text"
    }, 400);
  }
  if (action === "summarize") {
    const mode = body.mode ?? "executive";
    const sys = `You are a precise summarizer for a corporate governance ledger. Output concise ${mode === "bullets" ? "bulleted points" : "executive paragraphs"} with crisp headings. Avoid fluff.`;
    const usr = `Summarize this:\n\n${text}`;
    const r = await callOpenAI(sys, usr);
    return j({
      ok: r.ok,
      mode,
      summary: r.content ?? null,
      error: r.error ?? null
    });
  }
  if (action === "analyze") {
    const question = body.question ?? "What are the key risks, decisions, and actions?";
    const sys = `You are an analytical auditor for a corporate minute-book AI. 
Return a short, structured analysis: Key Points, Risks, Decisions, Required Actions.`;
    const usr = `Analyze the following and address: "${question}".\n\n${text}`;
    const r = await callOpenAI(sys, usr);
    return j({
      ok: r.ok,
      analysis: r.content ?? null,
      error: r.error ?? null
    });
  }
  if (action === "advise") {
    const goal = body.goal ?? "Provide practical next steps.";
    const sys = `You are a pragmatic advisor to a founder. Give clear, actionable steps. Avoid generic fluff.`;
    const usr = `Context:\n${text}\n\nGoal: ${goal}\nProvide prioritized steps.`;
    const r = await callOpenAI(sys, usr);
    return j({
      ok: r.ok,
      advice: r.content ?? null,
      error: r.error ?? null
    });
  }
  return j({
    ok: false,
    error: `Unknown action: ${action}`
  }, 400);
});
