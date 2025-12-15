"use client";

import { useEffect, useState } from "react";
import { useEntity } from "@/components/OsEntityContext";
import { OasisOrb, OrbMode } from "@/components/oracle/OasisOrb";

// Read from NEXT_PUBLIC_* so it's safe on the client
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const FUNCTIONS_BASE = `${SUPABASE_URL}/functions/v1`;

type OrbState = {
  id: string;
  mode: OrbMode;
  source: string | null;
  activity: string | null;
  updated_at: string;
  alert?: boolean | null;
};

type OracleInsight = {
  id: string;
  summary: string;
  risk_level: string;
  tags: string[];
  created_at: string;
};

type OracleInvokeResponse = {
  ok: boolean;
  analysis?: any;
  oracle_insight?: OracleInsight;
  error?: string;
};

async function callEdgeFunction<T>(name: string, body: unknown): Promise<T> {
  const res = await fetch(`${FUNCTIONS_BASE}/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(body ?? {}),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Edge function ${name} failed: ${res.status} ${res.statusText} – ${text}`,
    );
  }

  return (await res.json()) as T;
}

export default function CiOraclePage() {
  const { activeEntity } = useEntity();

  const [orbState, setOrbState] = useState<OrbState | null>(null);
  const [orbLoading, setOrbLoading] = useState<boolean>(false);
  const [orbError, setOrbError] = useState<string | null>(null);

  const [question, setQuestion] = useState<string>("");
  const [status, setStatus] = useState<
    "idle" | "sending-signal" | "invoking" | "ok" | "error"
  >("idle");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const [lastInsight, setLastInsight] = useState<OracleInsight | null>(null);
  const [lastAnalysisId, setLastAnalysisId] = useState<string | null>(null);

  // 🔁 Load current orb state on mount using the signal function
  useEffect(() => {
    let cancelled = false;

    const loadOrbState = async () => {
      setOrbLoading(true);
      setOrbError(null);
      try {
        // We use the signal function as a read + gentle warmup
        const data = await callEdgeFunction<{ ok: boolean; state?: OrbState }>(
          "ci-oracle-signal",
          {
            source: "ci-oracle-ui",
            activity: null,
            alert: false,
          },
        );

        if (cancelled) return;

        if (!data.ok || !data.state) {
          setOrbError("No orb state returned. Did you seed ci_orb_state?");
          return;
        }

        setOrbState(data.state);
      } catch (err: any) {
        if (cancelled) return;
        console.error("[ci-oracle-ui] loadOrbState error", err);
        setOrbError(
          err?.message ?? "Failed to reach ci-oracle-signal from the browser.",
        );
      } finally {
        if (!cancelled) {
          setOrbLoading(false);
        }
      }
    };

    loadOrbState();

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSendSignal() {
    if (!question.trim()) {
      setStatus("error");
      setStatusMessage("Ask Oracle something first before sending a signal.");
      return;
    }

    setStatus("sending-signal");
    setStatusMessage("Sending lightweight Oracle signal…");

    try {
      const data = await callEdgeFunction<{ ok: boolean; state?: OrbState }>(
        "ci-oracle-signal",
        {
          source: "ci-oracle-ui",
          activity: question.trim(),
          alert: false,
        },
      );

      if (!data.ok) {
        throw new Error("Oracle signal returned ok=false.");
      }

      if (data.state) {
        setOrbState(data.state);
      }

      setStatus("ok");
      setStatusMessage("Oracle received your signal.");
    } catch (err: any) {
      console.error("[ci-oracle-ui] sendSignal error", err);
      setStatus("error");
      setStatusMessage(
        err?.message ?? "Unexpected error while sending Oracle signal.",
      );
    }
  }

  async function handleInvoke() {
    if (!question.trim()) {
      setStatus("error");
      setStatusMessage("Ask Oracle something first before invoking analysis.");
      return;
    }

    setStatus("invoking");
    setStatusMessage("Oracle analysis in progress…");

    try {
      const tags: string[] = [];
      // ✅ activeEntity is an EntityKey (string), not an object with .slug
      if (activeEntity) tags.push(activeEntity);
      tags.push("oracle-ui");

      const data = await callEdgeFunction<OracleInvokeResponse>(
        "ci-oracle-invoke",
        {
          prompt: question.trim(),
          source: "ci-oracle-ui",
          tags,
          severity: "medium",
        },
      );

      if (!data.ok) {
        throw new Error(data.error ?? "Oracle reported a failure.");
      }

      if (data.oracle_insight) {
        setLastInsight(data.oracle_insight);
        setLastAnalysisId(data.oracle_insight.id);
      }

      // Refresh orb state into a cooldown line
      try {
        const stateData =
          await callEdgeFunction<{ ok: boolean; state?: OrbState }>(
            "ci-oracle-signal",
            {
              source: "ci-oracle-ui",
              activity: "POST-ANALYSIS COOLDOWN",
              alert: false,
            },
          );

        if (stateData.ok && stateData.state) {
          setOrbState(stateData.state);
        }
      } catch (stateErr) {
        console.warn(
          "[ci-oracle-ui] failed to refresh orb state after invoke",
          stateErr,
        );
      }

      setStatus("ok");
      setStatusMessage("Oracle analysis complete.");
    } catch (err: any) {
      console.error("[ci-oracle-ui] invoke error", err);
      setStatus("error");
      setStatusMessage(
        err?.message ?? "Unexpected error during Oracle analysis.",
      );
    }
  }

  const orbModeLabel =
    orbState?.mode === "ruh"
      ? "RŪḤ · Thinking"
      : orbState?.mode === "nur"
        ? "NŪR · Rest"
        : "Unknown";

  const riskColor =
    lastInsight?.risk_level === "high"
      ? "text-red-400 border-red-500/40"
      : lastInsight?.risk_level === "medium"
        ? "text-amber-300 border-amber-500/40"
        : "text-emerald-300 border-emerald-500/40";

  return (
    <div className="flex h-full flex-col gap-4">
      {/* Top: HUD row */}
      <div className="grid gap-4 md:grid-cols-3">
        {/* Orb status card (text HUD, not the big orb) */}
        <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                CI-ORACLE ORB
              </div>
              <div className="text-sm text-zinc-300">
                Live state of the governance Oracle.
              </div>
            </div>
            <div className="flex flex-col items-end gap-1">
              <span className="text-[11px] text-zinc-400">{orbModeLabel}</span>
              {orbState?.alert && (
                <span className="rounded-full border border-red-500/60 bg-red-500/10 px-2 py-0.5 text-[9px] uppercase tracking-[0.16em] text-red-300">
                  Alert
                </span>
              )}
            </div>
          </div>

          <div className="mt-1 text-[11px] text-zinc-400">
            {orbLoading && <span>Loading orb state…</span>}
            {!orbLoading && orbState?.activity && (
              <span>
                <span className="text-zinc-500">Activity:</span>{" "}
                <span className="text-zinc-200">{orbState.activity}</span>
              </span>
            )}
            {!orbLoading && !orbState && !orbError && (
              <span>No orb state yet. First analysis will seed activity.</span>
            )}
            {orbError && (
              <span className="text-red-400">
                Orb state error: {orbError}
              </span>
            )}
          </div>

          {orbState?.updated_at && (
            <div className="mt-1 text-[10px] text-zinc-500">
              Updated at:{" "}
              <span className="text-zinc-300">
                {new Date(orbState.updated_at).toLocaleString()}
              </span>
            </div>
          )}
        </div>

        {/* Entity context */}
        <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4 flex flex-col justify-between gap-2">
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">
              ACTIVE ENTITY
            </div>
            <div className="mt-1 text-sm text-zinc-200">
              {activeEntity ?? "No entity selected"}
            </div>
          </div>
          <div className="text-[11px] text-zinc-500">
            Oracle tags each analysis with the current entity slug so you can
            slice risks per organism later.
          </div>
        </div>

        {/* Status summary */}
        <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4 flex flex-col justify-between gap-2">
          <div className="flex items-center justify-between">
            <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">
              ORACLE STATUS
            </div>
            <div
              className={`text-[10px] px-3 py-1 rounded-full border ${
                status === "ok"
                  ? "border-emerald-500/60 text-emerald-400"
                  : status === "error"
                    ? "border-red-500/60 text-red-400"
                    : status === "sending-signal" || status === "invoking"
                      ? "border-amber-500/60 text-amber-300"
                      : "border-zinc-700 text-zinc-400"
              }`}
            >
              {status === "idle" && "Idle"}
              {status === "sending-signal" && "Sending signal…"}
              {status === "invoking" && "Oracle thinking…"}
              {status === "ok" && "Complete"}
              {status === "error" && "Error"}
            </div>
          </div>
          <div className="text-[11px] text-zinc-400 mt-1">
            {statusMessage ?? "Awaiting your next question."}
          </div>
        </div>
      </div>

      {/* Middle: Orb chamber + console */}
      <div className="rounded-3xl border border-zinc-800 bg-gradient-to-br from-zinc-950 via-zinc-950/90 to-black/95 p-5 md:p-6">
        <div className="grid gap-6 md:grid-cols-[minmax(240px,260px)_minmax(0,1fr)] items-center">
          {/* Big Orb chamber */}
          <div className="relative flex items-center justify-center">
            {/* Aura */}
            <div className="pointer-events-none absolute inset-0 rounded-full bg-[radial-gradient(circle_at_30%_0%,rgba(34,197,94,0.35),transparent_60%),radial-gradient(circle_at_70%_120%,rgba(250,204,21,0.28),transparent_55%)] opacity-80 blur-3xl" />
            <div className="relative flex h-56 w-56 items-center justify-center md:h-64 md:w-64">
              <OasisOrb
                mode={(orbState?.mode ?? "nur") as OrbMode}
                alert={Boolean(orbState?.alert)}
              />
            </div>
            <div className="pointer-events-none absolute -bottom-3 left-1/2 w-[140%] -translate-x-1/2 rounded-full border border-emerald-500/20 bg-black/50 px-4 py-1.5 text-center text-[10px] text-zinc-300 shadow-[0_0_40px_rgba(34,197,94,0.35)]">
              <span className="font-medium text-emerald-300">{orbModeLabel}</span>
              <span className="mx-1 text-zinc-500">·</span>
              <span className="text-[10px] text-zinc-300">
                {orbState?.activity ??
                  (orbLoading
                    ? "Syncing with governance ledger…"
                    : "Awaiting your first question.")}
              </span>
            </div>
          </div>

          {/* Console */}
          <div className="flex flex-col gap-3 md:pl-4">
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                CI-ORACLE CONSOLE
              </div>
              <div className="text-sm text-zinc-300">
                Ask about governance, risk, and compliance. The orb will respond
                with structured insights.
              </div>
            </div>

            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Ask Oracle: e.g. 'What are the top compliance risks for Oasis International Holdings this quarter?'"
              className="w-full mt-1 min-h-[120px] rounded-2xl bg-black/40 border border-zinc-800 px-3.5 py-2.5 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500/70 focus:ring-1 focus:ring-emerald-500/50"
            />

            <div className="flex flex-col gap-2 mt-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-[11px] text-zinc-500">
                Entity:{" "}
                <span className="text-zinc-300">
                  {activeEntity ?? "No entity selected"}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={handleSendSignal}
                  disabled={status === "sending-signal" || status === "invoking"}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:opacity-60 disabled:cursor-not-allowed transition"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  Send Signal
                </button>

                <button
                  onClick={handleInvoke}
                  disabled={status === "invoking"}
                  className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/70 bg-emerald-500/10 px-3.5 py-1.5 text-[11px] font-medium text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-60 disabled:cursor-not-allowed transition"
                >
                  <span className="h-2 w-2 rounded-full bg-emerald-400 animate-ping" />
                  Run Full Oracle Analysis
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom: Latest Oracle insight + notes */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">
              LATEST ORACLE INSIGHT
            </div>
            {lastInsight && (
              <div
                className={`text-[10px] px-3 py-1 rounded-full border ${riskColor}`}
              >
                Risk: {lastInsight.risk_level ?? "unknown"}
              </div>
            )}
          </div>

          {!lastInsight && (
            <div className="text-[11px] text-zinc-500 mt-1">
              No Oracle insight yet. Run a full analysis to see summarized
              findings here.
            </div>
          )}

          {lastInsight && (
            <>
              <div className="mt-1 text-sm text-zinc-200">{lastInsight.summary}</div>
              <div className="mt-1 text-[11px] text-zinc-500 flex flex-wrap gap-1">
                {lastInsight.tags?.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full border border-zinc-700 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-zinc-400"
                  >
                    {tag}
                  </span>
                ))}
              </div>
              <div className="mt-2 text-[10px] text-zinc-500">
                Insight ID:{" "}
                <span className="text-zinc-300">{lastAnalysisId ?? lastInsight.id}</span>
              </div>
            </>
          )}
        </div>

        {/* Notes */}
        <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4 flex flex-col gap-2">
          <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">
            ORB + ORACLE NOTES
          </div>
          <div className="text-[11px] text-zinc-400">
            Each full analysis updates:
            <ul className="mt-1 list-disc list-inside space-y-0.5">
              <li>
                <span className="text-zinc-200">ci_oracle_analysis</span> — full
                reasoning JSON
              </li>
              <li>
                <span className="text-zinc-200">ci_oracle_summary</span> — rolling
                insights + counters
              </li>
              <li>
                <span className="text-zinc-200">ci_orb_state</span> — NŪR/RŪḤ +
                activity line
              </li>
              <li>
                <span className="text-zinc-200">ci_orb_events</span> — event trail
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
