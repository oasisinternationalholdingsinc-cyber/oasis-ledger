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
async function ai(system, user) {
  const key = Deno.env.get("OPENAI_KEY");
  if (!key) return {
    ok: false,
    error: "Missing OPENAI_KEY"
  };
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
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
  if (!r.ok) return {
    ok: false,
    error: `OpenAI ${r.status}`
  };
  const j = await r.json();
  return {
    ok: true,
    content: j?.choices?.[0]?.message?.content ?? ""
  };
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
  let b = {};
  try {
    b = await req.json();
  } catch  {}
  const role = b.role ?? "analyst";
  const text = (b.text ?? "").toString().slice(0, 200_000);
  const prompt = b.prompt ?? "";
  const systems = {
    analyst: "You are an incisive corporate analyst. Output: Key Points, Risks, Decisions, Actions.",
    advisor: "You are a pragmatic startup advisor. Output crisp next steps and priorities.",
    secretary: "You draft clean meeting minutes and resolutions. Be formal and precise.",
    clerk: "You maintain registers and logs. Extract structured data fields accurately."
  };
  const sys = systems[role];
  const usr = `${prompt ? `Instruction: ${prompt}\n\n` : ""}Text:\n${text}`;
  const r = await ai(sys, usr);
  return j({
    ok: r.ok,
    role,
    result: r.content ?? null,
    error: r.error ?? null
  });
});
