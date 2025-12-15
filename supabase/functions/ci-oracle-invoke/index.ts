// supabase/functions/ci-oracle-invoke/index.ts
//
// CI-ORACLE INVOKE FUNCTION
// -------------------------
// Purpose:
//   - Accept an "Ask the Oracle" invocation.
//   - Call OpenAI for a structured analysis.
//   - Insert into ci_oracle_analysis.
//   - Update ci_oracle_summary (total_events, insights).
//   - Drive ci_orb_state between NŪR (rest) and RŪḤ (thinking).
//   - Log a ci_orb_events row.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("[ci-oracle-invoke] Missing SUPABASE_URL or SERVICE_ROLE_KEY");
}

if (!OPENAI_API_KEY) {
  console.warn(
    "[ci-oracle-invoke] WARNING: OPENAI_API_KEY not set. Analysis calls will fail.",
  );
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

async function setOrbState(opts: {
  mode: "nur" | "ruh";
  activity: string;
  source: string;
  alert?: boolean;
}) {
  const { data: current, error: fetchError } = await supabase
    .from("ci_orb_state")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let targetId = current?.id;

  if (fetchError) {
    console.error("[ci-oracle-invoke] setOrbState fetch error", fetchError);
    return;
  }

  if (!current) {
    const { data: inserted, error: insertError } = await supabase
      .from("ci_orb_state")
      .insert({
        mode: "nur",
        activity: "Initialized by ci-oracle-invoke",
        alert: false,
      })
      .select("*")
      .single();

    if (insertError || !inserted) {
      console.error("[ci-oracle-invoke] setOrbState seed error", insertError);
      return;
    }
    targetId = inserted.id;
  }

  const { error: updateError } = await supabase
    .from("ci_orb_state")
    .update({
      mode: opts.mode,
      activity: opts.activity,
      alert: opts.alert ?? false,
      updated_at: new Date().toISOString(),
      source: opts.source,
    })
    .eq("id", targetId!);

  if (updateError) {
    console.error("[ci-oracle-invoke] setOrbState update error", updateError);
  }

  try {
    await supabase.from("ci_orb_logs").insert({
      mode: opts.mode,
      activity: opts.activity,
      source: opts.source,
    });
  } catch (e) {
    console.warn("[ci-oracle-invoke] ci_orb_logs insert warn", e);
  }

  try {
    await supabase.from("ci_orb_events").insert({
      event_type: "oracle_orb_state",
      payload: {
        mode: opts.mode,
        activity: opts.activity,
        alert: opts.alert ?? false,
        source: opts.source,
      },
    });
  } catch (e) {
    console.warn("[ci-oracle-invoke] ci_orb_events insert warn", e);
  }
}

async function callOpenAI(prompt: string) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not set");
  }

  const systemPrompt = `
You are the CI-Oracle for the Oasis Digital Parliament.

Return your answer as STRICT JSON with this shape:

{
  "summary": "one-sentence headline",
  "insights": [
    "bullet insight 1",
    "bullet insight 2"
  ],
  "risk_level": "low" | "medium" | "high",
  "recommendations": [
    "action 1",
    "action 2"
  ]
}

Do not include any text outside JSON.
`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[ci-oracle-invoke] OpenAI error: ${res.status} ${res.statusText} ${text}`,
    );
  }

  const data = await res.json();
  const content: string | null = data.choices?.[0]?.message?.content ?? null;

  if (!content) {
    throw new Error("[ci-oracle-invoke] OpenAI returned empty content");
  }

  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = {
      summary: content,
      insights: [],
      risk_level: "medium",
      recommendations: [],
    };
  }

  return {
    raw: data,
    parsed,
  };
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const prompt = (body.prompt ?? "").toString().trim();
  const source = (body.source ?? "ci-oracle-ui").toString();
  const tags = (body.tags ?? []) as string[];
  const severity = (body.severity ?? null) as string | null;
  const horizonOverride = (body.horizon ?? null) as string | null;

  if (!prompt) {
    return json({ ok: false, error: "Missing 'prompt' in body" }, 400);
  }

  const nowIso = new Date().toISOString();

  try {
    // 1) Orb → RŪḤ (thinking)
    await setOrbState({
      mode: "ruh",
      activity: "ORACLE ANALYSIS IN PROGRESS",
      source,
      alert: false,
    });

    // 2) Call OpenAI
    const ai = await callOpenAI(prompt);
    const parsed = ai.parsed ?? {};
    const summaryText = (parsed.summary ?? "").toString();
    const riskLevel = (parsed.risk_level ?? severity ?? "medium").toString();

    // 3) Insert analysis row
    const { data: analysisRow, error: analysisError } = await supabase
      .from("ci_oracle_analysis")
      .insert({
        request_text: prompt,
        analysis: parsed,
        tags,
        severity: riskLevel,
      })
      .select("*")
      .single();

    if (analysisError || !analysisRow) {
      console.error(
        "[ci-oracle-invoke] ci_oracle_analysis insert error",
        analysisError,
      );
      throw new Error(
        analysisError?.message ?? "Failed to insert ci_oracle_analysis",
      );
    }

    // 4) Update summary
    const { data: currentSummary, error: summaryFetchError } = await supabase
      .from("ci_oracle_summary")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (summaryFetchError) {
      console.error(
        "[ci-oracle-invoke] ci_oracle_summary fetch error",
        summaryFetchError,
      );
      throw new Error(summaryFetchError.message);
    }

    const baseInsights = Array.isArray(currentSummary?.insights)
      ? (currentSummary!.insights as any[])
      : [];

    const newInsightEntry = {
      id: analysisRow.id,
      summary: summaryText || "Oracle insight",
      risk_level: riskLevel,
      tags,
      created_at: nowIso,
    };

    const insights = [...baseInsights, newInsightEntry].slice(-20);

    if (currentSummary) {
      const { error: summaryUpdateError } = await supabase
        .from("ci_oracle_summary")
        .update({
          horizon:
            horizonOverride ??
            currentSummary.horizon ??
            "Oasis organism baseline",
          total_events: (currentSummary.total_events ?? 0) + 1,
          alerts_24h: currentSummary.alerts_24h ?? 0,
          insights,
          updated_at: nowIso,
        })
        .eq("id", currentSummary.id);

      if (summaryUpdateError) {
        console.error(
          "[ci-oracle-invoke] ci_oracle_summary update error",
          summaryUpdateError,
        );
        throw new Error(summaryUpdateError.message);
      }
    } else {
      const { error: summaryInsertError } = await supabase
        .from("ci_oracle_summary")
        .insert({
          horizon: horizonOverride ?? "Oasis organism baseline",
          total_events: 1,
          alerts_24h: 0,
          insights,
          updated_at: nowIso,
        });

      if (summaryInsertError) {
        console.error(
          "[ci-oracle-invoke] ci_oracle_summary insert error",
          summaryInsertError,
        );
        throw new Error(summaryInsertError.message);
      }
    }

    // 5) Log event
    try {
      await supabase.from("ci_orb_events").insert({
        event_type: "oracle_invoke",
        payload: {
          analysis_id: analysisRow.id,
          source,
          risk_level: riskLevel,
          tags,
        },
      });
    } catch (e) {
      console.warn("[ci-oracle-invoke] ci_orb_events insert warn", e);
    }

    // 6) Orb → back to NŪR
    await setOrbState({
      mode: "nur",
      activity: "POST-ANALYSIS COOLDOWN",
      source,
      alert: false,
    });

    return json({
      ok: true,
      analysis: analysisRow,
      oracle_insight: newInsightEntry,
    });
  } catch (err) {
    console.error("[ci-oracle-invoke] error", err);

    try {
      await setOrbState({
        mode: "nur",
        activity: "ORACLE ERROR – RETURN TO REST",
        source: "ci-oracle-invoke",
        alert: true,
      });
    } catch {
      // ignore
    }

    return json(
      {
        ok: false,
        error:
          err instanceof Error
            ? err.message
            : "Unexpected error in ci-oracle-invoke",
      },
      500,
    );
  }
});
