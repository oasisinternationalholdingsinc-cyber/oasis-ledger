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
async function ai(sys, usr) {
  const k = Deno.env.get("OPENAI_KEY");
  if (!k) return {
    ok: false,
    error: "Missing OPENAI_KEY"
  };
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${k}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: sys
        },
        {
          role: "user",
          content: usr
        }
      ],
      temperature: 0.1
    })
  });
  if (!r.ok) return {
    ok: false,
    error: `OpenAI ${r.status}`
  };
  const jn = await r.json();
  return {
    ok: true,
    content: jn?.choices?.[0]?.message?.content ?? ""
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
  const text = (b?.text ?? "").toString().slice(0, 200_000);
  const mode = b?.mode ?? "executive";
  if (!text) return j({
    ok: false,
    error: "Missing text"
  }, 400);
  const sys = `Summarize for a corporate minute-book. Output ${mode === "bullets" ? "tight bullet points" : "an executive 1-2 paragraph summary"}.`;
  const usr = text;
  const r = await ai(sys, usr);
  return j({
    ok: r.ok,
    mode,
    summary: r.content ?? null,
    error: r.error ?? null
  });
});
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
async function ai(sys, usr) {
  const k = Deno.env.get("OPENAI_KEY");
  if (!k) return {
    ok: false,
    error: "Missing OPENAI_KEY"
  };
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${k}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: sys
        },
        {
          role: "user",
          content: usr
        }
      ],
      temperature: 0.1
    })
  });
  if (!r.ok) return {
    ok: false,
    error: `OpenAI ${r.status}`
  };
  const jn = await r.json();
  return {
    ok: true,
    content: jn?.choices?.[0]?.message?.content ?? ""
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
  const text = (b?.text ?? "").toString().slice(0, 200_000);
  const mode = b?.mode ?? "executive";
  if (!text) return j({
    ok: false,
    error: "Missing text"
  }, 400);
  const sys = `Summarize for a corporate minute-book. Output ${mode === "bullets" ? "tight bullet points" : "an executive 1-2 paragraph summary"}.`;
  const usr = text;
  const r = await ai(sys, usr);
  return j({
    ok: r.ok,
    mode,
    summary: r.content ?? null,
    error: r.error ?? null
  });
});
