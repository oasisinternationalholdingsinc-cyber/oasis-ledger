"use client";

import { useEffect, useState, useMemo } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";

type HeartbeatRow = {
  now_utc?: string | null;
  last_beat_utc?: string | null;
  hours_since_last_beat?: number | null;
  status?: string | null;
};

type EntityRow = {
  entity_id: string;
  entity_slug: string | null;
  entity_name: string;
  open_violations?: number | null;
  open_critical_violations?: number | null;
  open_error_violations?: number | null;
  open_corrective_actions?: number | null;
  past_due_actions?: number | null;
  pending_ai_advice?: number | null;
  compliance_score?: number | null;
  status_color?: string | null;
};

type ObligationRow = {
  obligation_id: string;
  entity_id: string;
  entity_slug: string | null;
  entity_name?: string | null;
  obligation_description: string;
  next_review_date: string | null;
  review_date: string | null;
  risk_level: string | null;
  overall_status: string | null;
};

type ActivityRow = Record<string, any>;

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

export default function CISentinelPage() {
  const [heartbeat, setHeartbeat] = useState<HeartbeatRow | null>(null);
  const [entities, setEntities] = useState<EntityRow[]>([]);
  const [obligations, setObligations] = useState<ObligationRow[]>([]);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [activeEntityId, setActiveEntityId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setErrorMessage(null);

      const [hbRes, entRes, oblRes, actRes] = await Promise.all([
        supabase.from("ai_sentinel_overview").select("*").limit(1),
        supabase.from("v_entity_violation_overview").select("*"),
        supabase
          .from("v_iso_obligations_dashboard")
          .select("*")
          .order("next_review_date", { ascending: true }),
        supabase
          .from("v_compliance_audit_feed")
          .select("*")
          .order("changed_at", { ascending: false })
          .limit(40),
      ]);

      if (cancelled) return;

      if (hbRes.error) {
        console.error("Sentinel heartbeat error", hbRes.error);
      } else {
        const row = (hbRes.data as any[])?.[0];
        if (row) {
          setHeartbeat({
            now_utc: row.now_utc ?? row.now_ts ?? null,
            last_beat_utc: row.last_beat_utc ?? null,
            hours_since_last_beat:
              row.hours_since_last_beat != null
                ? Number(row.hours_since_last_beat)
                : null,
            status: row.status ?? null,
          });
        } else {
          setHeartbeat(null);
        }
      }

      if (entRes.error) {
        console.error("Sentinel entities error", entRes.error);
      } else {
        setEntities((entRes.data as EntityRow[]) ?? []);
      }

      if (oblRes.error) {
        console.error("Sentinel obligations error", oblRes.error);
      } else {
        setObligations((oblRes.data as ObligationRow[]) ?? []);
      }

      if (actRes.error) {
        console.error("Sentinel activity error", actRes.error);
      } else {
        setActivity((actRes.data as ActivityRow[]) ?? []);
      }

      if (hbRes.error || entRes.error || oblRes.error || actRes.error) {
        setErrorMessage(
          "Failed to load some CI-Sentinel data. Check browser console and Supabase logs for details."
        );
      }

      setLoading(false);
    }

    load();

    return () => {
      cancelled = true;
    };
  }, []);

  const hbStatus = (heartbeat?.status ?? "unknown").toLowerCase();

  const hbColor =
    hbStatus === "healthy"
      ? "text-emerald-400"
      : hbStatus === "degraded"
      ? "text-amber-300"
      : hbStatus === "down"
      ? "text-rose-400"
      : "text-slate-400";

  const ecgLineClass =
    hbStatus === "healthy"
      ? "border-emerald-400/60"
      : hbStatus === "degraded"
      ? "border-amber-300/60"
      : hbStatus === "down"
      ? "border-rose-400/60"
      : "border-slate-500/60";

  const spikeColorClass =
    hbStatus === "healthy"
      ? "bg-emerald-400"
      : hbStatus === "degraded"
      ? "bg-amber-300"
      : hbStatus === "down"
      ? "bg-rose-400"
      : "bg-slate-300";

  const entitiesSummary = useMemo(() => {
    const total = entities.length;
    const critical = entities.reduce(
      (sum, e) => sum + (e.open_critical_violations ?? 0),
      0
    );
    const pastDue = entities.reduce(
      (sum, e) => sum + (e.past_due_actions ?? 0),
      0
    );
    return { total, critical, pastDue };
  }, [entities]);

  const filteredObligations = useMemo(() => {
    if (!activeEntityId) return obligations;
    return obligations.filter((o) => o.entity_id === activeEntityId);
  }, [obligations, activeEntityId]);

  return (
    <>
      {/* ECG + heartbeat animations */}
      <style jsx global>{`
        @keyframes sentinel-ecg-travel {
          0% {
            transform: translateX(-10%);
          }
          100% {
            transform: translateX(110%);
          }
        }

        @keyframes sentinel-ecg-spike {
          0%,
          10% {
            transform: scaleY(0.25);
          }
          15% {
            transform: scaleY(1.8);
          }
          25% {
            transform: scaleY(0.5);
          }
          35% {
            transform: scaleY(1.3);
          }
          50%,
          100% {
            transform: scaleY(0.25);
          }
        }

        @keyframes sentinel-pulse {
          0% {
            transform: scale(1);
            opacity: 1;
          }
          70% {
            transform: scale(1.8);
            opacity: 0;
          }
          100% {
            transform: scale(1.8);
            opacity: 0;
          }
        }
      `}</style>

      <div className="flex h-[calc(100vh-120px)] flex-col px-8 pb-6 pt-6 space-y-5">
        {/* Title + intro */}
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 text-xs tracking-wide uppercase text-emerald-300/80">
            <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>CI-Sentinel · AI governance watchtower</span>
          </div>
          <h1 className="text-2xl font-semibold text-slate-50">CI-Sentinel</h1>
          <p className="max-w-2xl text-sm text-slate-400">
            Live heartbeat, entity radar, and obligation health across the Oasis
            governance stack. If anything drifts out of compliance, this panel
            sees it first.
          </p>
        </div>

        {/* STATUS STRIP WITH ECG SPIKE */}
        <div className="rounded-2xl border border-slate-800/70 bg-slate-950/80 px-5 py-3 shadow-lg shadow-black/40 flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              {/* System health chip */}
              <div
                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${hbColor} border-current bg-black/40`}
              >
                <div className="relative h-3 w-3">
                  <span
                    className="absolute inset-0 rounded-full bg-current"
                    style={{ animation: "sentinel-pulse 1.6s infinite ease-out" }}
                  />
                  <span className="absolute inset-0 rounded-full bg-current shadow-[0_0_12px_rgba(52,211,153,0.9)]" />
                </div>
                <span>System health:</span>
                <span className="uppercase">
                  {hbStatus === "healthy"
                    ? "Healthy"
                    : hbStatus === "degraded"
                    ? "Degraded"
                    : hbStatus === "down"
                    ? "Down"
                    : "Unknown"}
                </span>
              </div>

              {/* Last beat info */}
              <div className="flex flex-col text-xs text-slate-400">
                <span>
                  Last beat:{" "}
                  <span className="font-mono text-[11px] text-slate-200">
                    {heartbeat?.last_beat_utc ?? "—"}
                  </span>
                </span>
                {heartbeat?.hours_since_last_beat != null && (
                  <span className="text-[11px] text-slate-500">
                    {heartbeat.hours_since_last_beat.toFixed(1)}h since last beat
                  </span>
                )}
              </div>
            </div>

            {/* Summary stats on the right */}
            <div className="flex flex-wrap gap-4 text-xs text-slate-400">
              <span>
                Entities:{" "}
                <span className="font-semibold text-slate-100">
                  {entitiesSummary.total}
                </span>
              </span>
              <span>
                Critical violations:{" "}
                <span className="font-semibold text-rose-300">
                  {entitiesSummary.critical}
                </span>
              </span>
              <span>
                Past-due actions:{" "}
                <span className="font-semibold text-amber-300">
                  {entitiesSummary.pastDue}
                </span>
              </span>
              <span>
                Obligations tracked:{" "}
                <span className="font-semibold text-slate-100">
                  {obligations.length}
                </span>
              </span>
            </div>
          </div>

          {/* ECG rail running across the strip */}
          <div className="relative mt-1 h-6 w-full overflow-hidden">
            {/* baseline line */}
            <div
              className={`absolute inset-y-2 left-0 right-0 border-t border-dashed ${ecgLineClass} opacity-70`}
            />
            {/* moving spike */}
            <div
              className="absolute inset-y-0 left-0 flex items-center"
              style={{
                animation: "sentinel-ecg-travel 3.2s linear infinite",
              }}
            >
              <div className="h-full flex items-center">
                <div
                  className={`w-[3px] origin-bottom rounded-full ${spikeColorClass} shadow-[0_0_16px_rgba(52,211,153,0.95)]`}
                  style={{
                    animation: "sentinel-ecg-spike 1.6s ease-in-out infinite",
                  }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* 3-COLUMN WATCHTOWER */}
        <div className="flex-1 min-h-0 grid gap-6 lg:grid-cols-3">
          {/* ENTITY RADAR */}
          <div className="rounded-2xl bg-slate-900/80 border border-slate-800/70 shadow-lg shadow-black/40 flex flex-col min-h-0">
            <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-slate-800/70">
              <div className="space-y-0.5">
                <h2 className="text-sm font-semibold text-slate-100">
                  Entity radar
                </h2>
                <p className="text-xs text-slate-400">
                  Violations, actions, and traffic light per entity.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setActiveEntityId(null)}
                className={`text-[11px] rounded-full border px-3 py-1 ${
                  activeEntityId
                    ? "border-slate-600 text-slate-200 hover:border-emerald-400 hover:text-emerald-200"
                    : "border-emerald-400/60 bg-emerald-400/10 text-emerald-200"
                }`}
              >
                All entities
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-4 pt-2 space-y-2 text-xs">
              {loading && entities.length === 0 && (
                <p className="px-2 py-1 text-slate-500">Loading entities…</p>
              )}

              {!loading && entities.length === 0 && (
                <p className="px-2 py-1 text-slate-500">
                  No rows in{" "}
                  <span className="font-mono text-[11px]">
                    v_entity_violation_overview
                  </span>
                  .
                </p>
              )}

              {entities
                .slice()
                .sort((a, b) => {
                  const critA = a.open_critical_violations ?? 0;
                  const critB = b.open_critical_violations ?? 0;
                  if (critA !== critB) return critB - critA;
                  const pdA = a.past_due_actions ?? 0;
                  const pdB = b.past_due_actions ?? 0;
                  return pdB - pdA;
                })
                .map((e) => {
                  const color = (e.status_color ?? "").toLowerCase();
                  const selected = e.entity_id === activeEntityId;

                  const leftBarClass =
                    color === "green"
                      ? "from-emerald-400 to-emerald-500"
                      : color === "yellow"
                      ? "from-amber-300 to-amber-400"
                      : color === "red"
                      ? "from-rose-400 to-rose-500"
                      : "from-slate-500 to-slate-600";

                  const bgClass =
                    color === "green"
                      ? "bg-emerald-500/5"
                      : color === "yellow"
                      ? "bg-amber-500/5"
                      : color === "red"
                      ? "bg-rose-500/5"
                      : "bg-slate-900/80";

                  const borderClass = selected
                    ? "border-emerald-500/80"
                    : "border-slate-700/80";

                  return (
                    <button
                      key={e.entity_id}
                      type="button"
                      onClick={() =>
                        setActiveEntityId(selected ? null : e.entity_id)
                      }
                      className={`group relative w-full text-left rounded-xl border ${borderClass} ${bgClass} pl-4 pr-3 py-2.5 transition-colors hover:border-emerald-400/80`}
                    >
                      {/* left colour bar */}
                      <div className="pointer-events-none absolute inset-y-1 left-1 w-1 rounded-full overflow-hidden">
                        <div
                          className={`h-full w-full bg-gradient-to-b ${leftBarClass} opacity-80 group-hover:opacity-100`}
                        />
                      </div>

                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-slate-50">
                              {e.entity_name}
                            </span>
                            {e.entity_slug && (
                              <span className="text-[10px] uppercase tracking-wide text-slate-400">
                                {e.entity_slug}
                              </span>
                            )}
                          </div>
                          <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-slate-400">
                            <span>{e.open_violations ?? 0} open</span>
                            <span className="text-rose-300">
                              {e.open_critical_violations ?? 0} critical
                            </span>
                            <span className="text-amber-300">
                              {e.past_due_actions ?? 0} past-due
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          {e.compliance_score != null && (
                            <div className="text-right">
                              <div className="text-[10px] text-slate-400">
                                Score
                              </div>
                              <div className="text-sm font-semibold text-slate-50">
                                {e.compliance_score}
                              </div>
                            </div>
                          )}
                          <span
                            className={`h-3 w-3 rounded-full ${
                              color === "green"
                                ? "bg-emerald-400"
                                : color === "yellow"
                                ? "bg-amber-300"
                                : color === "red"
                                ? "bg-rose-400"
                                : "bg-slate-500"
                            } shadow-[0_0_8px_rgba(148,163,184,0.6)]`}
                          />
                        </div>
                      </div>
                    </button>
                  );
                })}
            </div>
          </div>

          {/* OBLIGATION HEALTH */}
          <div className="rounded-2xl bg-slate-900/80 border border-slate-800/70 shadow-lg shadow-black/40 flex flex-col min-h-0">
            <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-slate-800/70">
              <div className="space-y-0.5">
                <h2 className="text-sm font-semibold text-slate-100">
                  Obligation health
                </h2>
                <p className="text-xs text-slate-400">
                  {activeEntityId
                    ? "Obligations scoped to the selected entity."
                    : "Clause-level view across all entities."}
                </p>
              </div>
              <span className="text-xs text-slate-500">
                {filteredObligations.length}{" "}
                {filteredObligations.length === 1
                  ? "obligation"
                  : "obligations"}
              </span>
            </div>

            <div className="flex-1 min-h-0 overflow-auto px-3 pb-4 pt-2">
              {loading && filteredObligations.length === 0 && (
                <p className="px-2 py-1 text-xs text-slate-500">
                  Loading obligations…
                </p>
              )}

              {!loading && filteredObligations.length === 0 && (
                <p className="px-2 py-1 text-xs text-slate-500">
                  No obligations in{" "}
                  <span className="font-mono text-[11px]">
                    v_iso_obligations_dashboard
                  </span>
                  {activeEntityId ? " for the selected entity." : "."}
                </p>
              )}

              {filteredObligations.length > 0 && (
                <table className="min-w-full text-xs border-separate border-spacing-y-1">
                  <thead className="text-[11px] uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="text-left px-2 py-1.5">Obligation</th>
                      {!activeEntityId && (
                        <th className="text-left px-2 py-1.5">Entity</th>
                      )}
                      <th className="text-left px-2 py-1.5">Next review</th>
                      <th className="text-left px-2 py-1.5">Last review</th>
                      <th className="text-left px-2 py-1.5">Risk</th>
                      <th className="text-left px-2 py-1.5">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredObligations.map((o) => {
                      const risk = (o.risk_level ?? "").toLowerCase();
                      const status = (o.overall_status ?? "").toLowerCase();

                      const riskClass =
                        risk === "low"
                          ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
                          : risk === "medium"
                          ? "bg-amber-500/15 text-amber-300 border-amber-500/40"
                          : risk === "high"
                          ? "bg-rose-500/15 text-rose-300 border-rose-500/40"
                          : "bg-slate-800 text-slate-200 border-slate-700";

                      const statusClass =
                        status === "compliant"
                          ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
                          : status === "at_risk"
                          ? "bg-amber-500/15 text-amber-300 border-amber-500/40"
                          : status === "pending"
                          ? "bg-slate-800 text-slate-200 border-slate-700"
                          : status === "approved"
                          ? "bg-sky-500/15 text-sky-300 border-sky-500/40"
                          : "bg-slate-800 text-slate-200 border-slate-700";

                      const urgentBg =
                        risk === "high" || status === "at_risk"
                          ? "bg-gradient-to-r from-rose-500/15 via-transparent to-transparent"
                          : risk === "medium"
                          ? "bg-gradient-to-r from-amber-500/10 via-transparent to-transparent"
                          : "";

                      return (
                        <tr
                          key={o.obligation_id}
                          className={`rounded-xl bg-slate-900/95 hover:bg-slate-800/95 ${urgentBg}`}
                        >
                          <td className="px-2 py-1.5 text-slate-100 max-w-xs">
                            <div className="line-clamp-2">
                              {o.obligation_description || "—"}
                            </div>
                          </td>
                          {!activeEntityId && (
                            <td className="px-2 py-1.5 text-slate-200">
                              <div className="flex flex-col">
                                <span>{o.entity_name ?? "—"}</span>
                                {o.entity_slug && (
                                  <span className="text-[10px] uppercase tracking-wide text-slate-500">
                                    {o.entity_slug}
                                  </span>
                                )}
                              </div>
                            </td>
                          )}
                          <td className="px-2 py-1.5 text-slate-200">
                            {formatDate(o.next_review_date)}
                          </td>
                          <td className="px-2 py-1.5 text-slate-200">
                            {formatDate(o.review_date)}
                          </td>
                          <td className="px-2 py-1.5">
                            <span
                              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${riskClass}`}
                            >
                              {o.risk_level ?? "unknown"}
                            </span>
                          </td>
                          <td className="px-2 py-1.5">
                            <span
                              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${statusClass}`}
                            >
                              {o.overall_status ?? "pending"}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* SENTINEL ACTIVITY FEED */}
          <div className="rounded-2xl bg-slate-900/80 border border-slate-800/70 shadow-lg shadow-black/40 flex flex-col min-h-0">
            <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-slate-800/70">
              <div className="space-y-0.5">
                <h2 className="text-sm font-semibold text-slate-100">
                  Sentinel activity
                </h2>
                <p className="text-xs text-slate-400">
                  Latest compliance status changes and Sentinel actions.
                </p>
              </div>
              <span className="text-xs text-slate-500">
                {activity.length} events
              </span>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-4 pt-2 space-y-2 text-xs">
              {loading && activity.length === 0 && (
                <p className="px-2 py-1 text-slate-500">
                  Loading activity feed…
                </p>
              )}

              {!loading && activity.length === 0 && (
                <p className="px-2 py-1 text-slate-500">
                  No rows in{" "}
                  <span className="font-mono text-[11px]">
                    v_compliance_audit_feed
                  </span>
                  .
                </p>
              )}

              {activity.map((row) => {
                const id = (row.id ?? row.audit_id ?? row.log_id) as string;
                const ts =
                  row.changed_at ??
                  row.occurred_at ??
                  row.created_at ??
                  null;
                const entity = row.entity_name ?? row.entity_slug ?? "—";
                const title =
                  row.resolution_title ??
                  row.record_title ??
                  row.headline ??
                  "Status change";
                const oldStatus =
                  row.old_status ?? row.prev_status ?? row.old_state ?? null;
                const newStatus =
                  row.new_status ?? row.status ?? row.new_state ?? null;
                const actor =
                  row.reviewer ?? row.actor ?? row.actor_type ?? "system";

                const isRisky =
                  (newStatus ?? "").toString().toLowerCase().includes("risk") ||
                  (newStatus ?? "").toString().toLowerCase().includes("escalated");

                return (
                  <div
                    key={id}
                    className={`rounded-xl border px-3 py-2.5 ${
                      isRisky
                        ? "border-rose-500/70 bg-rose-950/60"
                        : "border-slate-800/80 bg-slate-950/80"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="text-[11px] text-slate-400">
                          {formatDate(ts)} · {entity}
                        </div>
                        <div className="mt-0.5 text-sm text-slate-50">
                          {title}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                          {oldStatus && (
                            <span className="inline-flex items-center gap-1">
                              from{" "}
                              <span className="font-mono text-[10px] text-slate-300">
                                {oldStatus}
                              </span>
                            </span>
                          )}
                          {newStatus && (
                            <span className="inline-flex items-center gap-1">
                              {isRisky ? "⚠️" : "✅"} to{" "}
                              <span className="font-mono text-[10px] text-emerald-300">
                                {newStatus}
                              </span>
                            </span>
                          )}
                          <span className="inline-flex items-center gap-1">
                            • actor:
                            <span className="font-mono text-[10px] text-slate-300">
                              {actor}
                            </span>
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}

              {errorMessage && (
                <p className="mt-2 text-[11px] text-rose-400">{errorMessage}</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
