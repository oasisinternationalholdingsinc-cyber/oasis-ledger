"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";
import {
  ArrowLeft,
  Search,
  Shield,
  CheckCircle2,
  X,
  Copy,
  ExternalLink,
  Activity as ActivityIcon,
  Radar,
} from "lucide-react";

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

type Tab = "ALL" | "RISK" | "OK";

function cx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function safeCopy(text: string) {
  try {
    navigator.clipboard?.writeText(text);
  } catch {}
}

function isRiskyRow(row: ActivityRow) {
  const newStatus = (row.new_status ?? row.status ?? row.new_state ?? "")
    .toString()
    .toLowerCase();
  return newStatus.includes("risk") || newStatus.includes("escalated") || newStatus.includes("critical");
}

function prettyJson(obj: any) {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

export default function CISentinelPage() {
  const { activeEntity } = useEntity(); // OS entity slug/key (display only — no wiring changes)
  const { env } = useOsEnv();
  const laneIsTest = env === "SANDBOX";

  const [heartbeat, setHeartbeat] = useState<HeartbeatRow | null>(null);
  const [entities, setEntities] = useState<EntityRow[]>([]);
  const [obligations, setObligations] = useState<ObligationRow[]>([]);
  const [activity, setActivity] = useState<ActivityRow[]>([]);

  const [activeEntityId, setActiveEntityId] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // UI filters (NO backend wiring changes)
  const [tab, setTab] = useState<Tab>("ALL");
  const [q, setQ] = useState("");

  // Modals
  const [entityModalOpen, setEntityModalOpen] = useState(false);
  const [selectedEntity, setSelectedEntity] = useState<EntityRow | null>(null);

  const [eventModalOpen, setEventModalOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<ActivityRow | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setErrorMessage(null);

      // ✅ NO WIRING CHANGE — identical queries
      const [hbRes, entRes, oblRes, actRes] = await Promise.all([
        supabase.from("ai_sentinel_overview").select("*").limit(1),
        supabase.from("v_entity_violation_overview").select("*"),
        supabase.from("v_iso_obligations_dashboard").select("*").order("next_review_date", { ascending: true }),
        supabase.from("v_compliance_audit_feed").select("*").order("changed_at", { ascending: false }).limit(40),
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
            hours_since_last_beat: row.hours_since_last_beat != null ? Number(row.hours_since_last_beat) : null,
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
        setErrorMessage("Failed to load some CI-Sentinel data. Check browser console and Supabase logs for details.");
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
    const critical = entities.reduce((sum, e) => sum + (e.open_critical_violations ?? 0), 0);
    const pastDue = entities.reduce((sum, e) => sum + (e.past_due_actions ?? 0), 0);
    return { total, critical, pastDue };
  }, [entities]);

  const filteredObligations = useMemo(() => {
    if (!activeEntityId) return obligations;
    return obligations.filter((o) => o.entity_id === activeEntityId);
  }, [obligations, activeEntityId]);

  const filteredActivity = useMemo(() => {
    const qq = q.trim().toLowerCase();

    return (activity ?? []).filter((row) => {
      const risky = isRiskyRow(row);
      if (tab === "RISK" && !risky) return false;
      if (tab === "OK" && risky) return false;

      if (!qq) return true;

      const ts = row.changed_at ?? row.occurred_at ?? row.created_at ?? "";
      const entity = row.entity_name ?? row.entity_slug ?? "";
      const title = row.resolution_title ?? row.record_title ?? row.headline ?? "Status change";
      const oldStatus = row.old_status ?? row.prev_status ?? row.old_state ?? "";
      const newStatus = row.new_status ?? row.status ?? row.new_state ?? "";

      const hay = `${ts} ${entity} ${title} ${oldStatus} ${newStatus}`.toLowerCase();
      return hay.includes(qq);
    });
  }, [activity, tab, q]);

  // OS shell/header/body pattern (MATCH Verified Registry)
  const shell =
    "rounded-3xl border border-white/10 bg-black/20 shadow-[0_28px_120px_rgba(0,0,0,0.55)] overflow-hidden";
  const header =
    "border-b border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent px-4 sm:px-6 py-4 sm:py-5";
  const body = "px-4 sm:px-6 py-5 sm:py-6";

  return (
    <>
      {/* ECG + heartbeat animations (kept, only moved into OS shell) */}
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

      <div className="w-full">
        <div className="mx-auto w-full max-w-[1200px] px-4 pb-10 pt-4 sm:pt-6">
          <div className={shell}>
            {/* OS-aligned header */}
            <div className={header}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[10px] sm:text-xs tracking-[0.3em] uppercase text-slate-500">CI • Sentinel</div>
                  <h1 className="mt-1 text-lg sm:text-xl font-semibold text-slate-50">Watchtower</h1>
                  <p className="mt-1 max-w-3xl text-[11px] sm:text-xs text-slate-400 leading-relaxed">
                    Live heartbeat, entity radar, obligation health, and audit activity. Read-only surface. Use Council/Forge/Archive
                    for lifecycle actions.
                  </p>

                  <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-400">
                    <span className="inline-flex items-center gap-2">
                      <Shield className="h-4 w-4 text-emerald-300" />
                      <span>Monitor surface • No destructive actions</span>
                    </span>
                    <span className="text-slate-700">•</span>
                    <span>
                      Lane:{" "}
                      <span className={cx("font-semibold", laneIsTest ? "text-amber-300" : "text-sky-300")}>
                        {laneIsTest ? "SANDBOX" : "RoT"}
                      </span>
                    </span>
                    <span className="text-slate-700">•</span>
                    <span>
                      Entity: <span className="text-emerald-300 font-medium">{String(activeEntity ?? "—")}</span>
                    </span>
                  </div>
                </div>

                <div className="shrink-0 flex items-center gap-2">
                  <Link
                    href="/"
                    className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7 inline-flex items-center gap-2"
                    title="Back to OS"
                  >
                    <ArrowLeft className="h-4 w-4" />
                    OS
                  </Link>
                </div>
              </div>

              {/* Status strip (now inside header area, OS-consistent) */}
              <div className="mt-4 rounded-3xl border border-white/10 bg-black/20 px-4 sm:px-5 py-3 shadow-[0_18px_80px_rgba(0,0,0,0.45)]">
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
                      <span>System:</span>
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
                        <span className="font-mono text-[11px] text-slate-200">{heartbeat?.last_beat_utc ?? "—"}</span>
                      </span>
                      {heartbeat?.hours_since_last_beat != null && (
                        <span className="text-[11px] text-slate-500">
                          {heartbeat.hours_since_last_beat.toFixed(1)}h since last beat
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Summary stats on right */}
                  <div className="flex flex-wrap gap-4 text-xs text-slate-400">
                    <span>
                      Entities: <span className="font-semibold text-slate-100">{entitiesSummary.total}</span>
                    </span>
                    <span>
                      Critical: <span className="font-semibold text-rose-300">{entitiesSummary.critical}</span>
                    </span>
                    <span>
                      Past-due: <span className="font-semibold text-amber-300">{entitiesSummary.pastDue}</span>
                    </span>
                    <span>
                      Obligations: <span className="font-semibold text-slate-100">{obligations.length}</span>
                    </span>
                  </div>
                </div>

                {/* ECG rail */}
                <div className="relative mt-2 h-6 w-full overflow-hidden">
                  <div className={`absolute inset-y-2 left-0 right-0 border-t border-dashed ${ecgLineClass} opacity-70`} />
                  <div
                    className="absolute inset-y-0 left-0 flex items-center"
                    style={{ animation: "sentinel-ecg-travel 3.2s linear infinite" }}
                  >
                    <div className="h-full flex items-center">
                      <div
                        className={`w-[3px] origin-bottom rounded-full ${spikeColorClass} shadow-[0_0_16px_rgba(52,211,153,0.95)]`}
                        style={{ animation: "sentinel-ecg-spike 1.6s ease-in-out infinite" }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className={body}>
              {/* iPhone-first surface: stacks; desktop: 3 columns */}
              <div className="grid grid-cols-12 gap-4">
                {/* LEFT: Filters */}
                <section className="col-span-12 lg:col-span-3">
                  <div className="rounded-3xl border border-white/10 bg-black/20 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-200">Filters</div>
                        <div className="text-[11px] text-slate-500">View + search</div>
                      </div>
                      <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[10px] tracking-[0.18em] uppercase text-slate-200">
                        filters
                      </span>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      {(["ALL", "RISK", "OK"] as Tab[]).map((t) => (
                        <button
                          key={t}
                          onClick={() => setTab(t)}
                          className={cx(
                            "rounded-full border px-3 py-1 text-xs transition",
                            tab === t
                              ? "border-amber-400/40 bg-amber-400/10 text-amber-100"
                              : "border-white/10 bg-white/5 text-slate-200/80 hover:bg-white/7"
                          )}
                        >
                          {t}
                        </button>
                      ))}
                    </div>

                    <div className="mt-4">
                      <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">Search</div>
                      <div className="mt-2 relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                        <input
                          value={q}
                          onChange={(e) => setQ(e.target.value)}
                          placeholder="entity, status, title..."
                          className="w-full rounded-2xl border border-white/10 bg-white/5 pl-10 pr-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-500 focus:border-amber-400/30"
                        />
                      </div>
                    </div>

                    <div className="mt-4 text-xs text-slate-400">{loading ? "Loading…" : `${filteredActivity.length} event(s)`}</div>

                    <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 p-3 text-xs text-slate-400">
                      Entity scope: click an entity in Radar to focus obligations. Activity is a global feed from{" "}
                      <span className="text-slate-200 font-mono text-[11px]">v_compliance_audit_feed</span>.
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setActiveEntityId(null)}
                        className={cx(
                          "rounded-full border px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase inline-flex items-center gap-2",
                          activeEntityId
                            ? "border-white/10 bg-white/5 text-slate-200 hover:bg-white/7"
                            : "border-emerald-400/20 bg-emerald-400/10 text-emerald-100"
                        )}
                        title="Clear entity focus"
                      >
                        <Radar className="h-4 w-4" />
                        All entities
                      </button>

                      <Link
                        href="/ci-archive/verified"
                        className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7 inline-flex items-center gap-2"
                        title="Verified Registry"
                      >
                        <CheckCircle2 className="h-4 w-4" />
                        Verified
                      </Link>
                    </div>
                  </div>
                </section>

                {/* MIDDLE: Radar + Obligations */}
                <section className="col-span-12 lg:col-span-6">
                  <div className="rounded-3xl border border-white/10 bg-black/20 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-200">Radar</div>
                        <div className="text-[11px] text-slate-500">Entities + obligation health</div>
                      </div>
                      <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[10px] tracking-[0.18em] uppercase text-slate-200">
                        watchtower
                      </span>
                    </div>

                    {/* Entity Radar list */}
                    <div className="mt-3 space-y-2">
                      {loading && entities.length === 0 && (
                        <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-slate-400">
                          Loading entities…
                        </div>
                      )}

                      {!loading && entities.length === 0 && (
                        <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-slate-400">
                          No rows in <span className="font-mono text-[11px]">v_entity_violation_overview</span>.
                        </div>
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
                              : "bg-black/20";

                          const borderClass = selected ? "border-emerald-500/60" : "border-white/10";

                          return (
                            <div
                              key={e.entity_id}
                              className={cx(
                                "rounded-3xl border p-3 bg-black/20 hover:bg-black/25 transition",
                                borderClass
                              )}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <button
                                  type="button"
                                  onClick={() => setActiveEntityId(selected ? null : e.entity_id)}
                                  className="min-w-0 text-left"
                                  title="Focus obligations to this entity"
                                >
                                  <div className="flex items-center gap-2">
                                    <span className="text-sm font-medium text-slate-100 truncate">{e.entity_name}</span>
                                    {e.entity_slug && (
                                      <span className="text-[10px] uppercase tracking-[0.18em] text-slate-500">
                                        {e.entity_slug}
                                      </span>
                                    )}
                                  </div>
                                  <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-slate-500">
                                    <span>
                                      <span className="text-slate-200">{e.open_violations ?? 0}</span> open
                                    </span>
                                    <span className="text-rose-300">
                                      <span className="text-rose-200">{e.open_critical_violations ?? 0}</span> critical
                                    </span>
                                    <span className="text-amber-300">
                                      <span className="text-amber-200">{e.past_due_actions ?? 0}</span> past-due
                                    </span>
                                  </div>
                                </button>

                                <div className="flex flex-col items-end gap-2 shrink-0">
                                  <div className="flex items-center gap-2">
                                    <span className="h-3 w-3 rounded-full overflow-hidden border border-white/10 bg-black/30">
                                      <span className={cx("block h-full w-full bg-gradient-to-b opacity-90", leftBarClass)} />
                                    </span>
                                    <span
                                      className={cx(
                                        "rounded-full border px-2 py-1 text-[11px]",
                                        color === "green"
                                          ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100"
                                          : color === "yellow"
                                          ? "border-amber-400/30 bg-amber-400/10 text-amber-100"
                                          : color === "red"
                                          ? "border-rose-400/30 bg-rose-400/10 text-rose-100"
                                          : "border-white/10 bg-white/5 text-slate-400"
                                      )}
                                    >
                                      {color ? color.toUpperCase() : "UNKNOWN"}
                                    </span>
                                  </div>

                                  <button
                                    type="button"
                                    onClick={() => {
                                      setSelectedEntity(e);
                                      setEntityModalOpen(true);
                                    }}
                                    className="rounded-full border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-amber-100 hover:bg-amber-400/15 inline-flex items-center gap-2"
                                  >
                                    Details <ExternalLink className="h-4 w-4" />
                                  </button>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                    </div>

                    {/* Obligations table */}
                    <div className="mt-4 rounded-3xl border border-white/10 bg-black/20 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-slate-200">Obligations</div>
                          <div className="text-[11px] text-slate-500">
                            {activeEntityId ? "Scoped to selected entity." : "Clause-level view across all entities."}
                          </div>
                        </div>
                        <span className="text-xs text-slate-500">{filteredObligations.length} rows</span>
                      </div>

                      <div className="mt-3 max-h-[360px] overflow-auto">
                        {loading && filteredObligations.length === 0 && (
                          <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-slate-400">
                            Loading obligations…
                          </div>
                        )}

                        {!loading && filteredObligations.length === 0 && (
                          <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-slate-400">
                            No rows in <span className="font-mono text-[11px]">v_iso_obligations_dashboard</span>
                            {activeEntityId ? " for this entity." : "."}
                          </div>
                        )}

                        {filteredObligations.length > 0 && (
                          <table className="min-w-full text-xs border-separate border-spacing-y-1">
                            <thead className="text-[11px] uppercase tracking-[0.18em] text-slate-500">
                              <tr>
                                <th className="text-left px-2 py-1.5">Obligation</th>
                                {!activeEntityId && <th className="text-left px-2 py-1.5">Entity</th>}
                                <th className="text-left px-2 py-1.5">Next</th>
                                <th className="text-left px-2 py-1.5">Last</th>
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
                                    : "bg-white/5 text-slate-200 border-white/10";

                                const statusClass =
                                  status === "compliant"
                                    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
                                    : status === "at_risk"
                                    ? "bg-amber-500/15 text-amber-300 border-amber-500/40"
                                    : status === "pending"
                                    ? "bg-white/5 text-slate-200 border-white/10"
                                    : status === "approved"
                                    ? "bg-sky-500/15 text-sky-300 border-sky-500/40"
                                    : "bg-white/5 text-slate-200 border-white/10";

                                const urgentBg =
                                  risk === "high" || status === "at_risk"
                                    ? "bg-gradient-to-r from-rose-500/10 via-transparent to-transparent"
                                    : risk === "medium"
                                    ? "bg-gradient-to-r from-amber-500/10 via-transparent to-transparent"
                                    : "";

                                return (
                                  <tr key={o.obligation_id} className={cx("rounded-xl bg-black/20 hover:bg-black/25", urgentBg)}>
                                    <td className="px-2 py-1.5 text-slate-100 max-w-xs">
                                      <div className="line-clamp-2">{o.obligation_description || "—"}</div>
                                    </td>
                                    {!activeEntityId && (
                                      <td className="px-2 py-1.5 text-slate-200">
                                        <div className="flex flex-col">
                                          <span>{o.entity_name ?? "—"}</span>
                                          {o.entity_slug && (
                                            <span className="text-[10px] uppercase tracking-[0.18em] text-slate-500">
                                              {o.entity_slug}
                                            </span>
                                          )}
                                        </div>
                                      </td>
                                    )}
                                    <td className="px-2 py-1.5 text-slate-200">{formatDate(o.next_review_date)}</td>
                                    <td className="px-2 py-1.5 text-slate-200">{formatDate(o.review_date)}</td>
                                    <td className="px-2 py-1.5">
                                      <span className={cx("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium", riskClass)}>
                                        {o.risk_level ?? "unknown"}
                                      </span>
                                    </td>
                                    <td className="px-2 py-1.5">
                                      <span className={cx("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium", statusClass)}>
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
                  </div>
                </section>

                {/* RIGHT: Activity feed + Guidance */}
                <section className="col-span-12 lg:col-span-3">
                  <div className="rounded-3xl border border-white/10 bg-black/20 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-200">Sentinel activity</div>
                        <div className="text-[11px] text-slate-500">Latest audit feed</div>
                      </div>
                      <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[10px] tracking-[0.18em] uppercase text-slate-200">
                        feed
                      </span>
                    </div>

                    <div className="mt-3 space-y-2 max-h-[520px] overflow-y-auto pr-1">
                      {loading && activity.length === 0 && (
                        <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-slate-400">
                          Loading activity feed…
                        </div>
                      )}

                      {!loading && activity.length === 0 && (
                        <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-slate-400">
                          No rows in <span className="font-mono text-[11px]">v_compliance_audit_feed</span>.
                        </div>
                      )}

                      {filteredActivity.map((row) => {
                        const id = (row.id ?? row.audit_id ?? row.log_id) as string;
                        const ts = row.changed_at ?? row.occurred_at ?? row.created_at ?? null;
                        const entity = row.entity_name ?? row.entity_slug ?? "—";
                        const title =
                          row.resolution_title ?? row.record_title ?? row.headline ?? "Status change";
                        const oldStatus = row.old_status ?? row.prev_status ?? row.old_state ?? null;
                        const newStatus = row.new_status ?? row.status ?? row.new_state ?? null;
                        const actor = row.reviewer ?? row.actor ?? row.actor_type ?? "system";

                        const risky = isRiskyRow(row);

                        return (
                          <button
                            key={id}
                            type="button"
                            onClick={() => {
                              setSelectedEvent(row);
                              setEventModalOpen(true);
                            }}
                            className={cx(
                              "w-full text-left rounded-3xl border p-3 transition",
                              risky
                                ? "border-rose-400/25 bg-rose-400/5 hover:bg-rose-400/10"
                                : "border-white/10 bg-black/20 hover:bg-black/25"
                            )}
                          >
                            <div className="text-[11px] text-slate-500">{formatDate(ts)} · {entity}</div>
                            <div className="mt-1 text-sm text-slate-50">{title}</div>
                            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                              {oldStatus && (
                                <span className="inline-flex items-center gap-1">
                                  from <span className="font-mono text-[10px] text-slate-300">{String(oldStatus)}</span>
                                </span>
                              )}
                              {newStatus && (
                                <span className="inline-flex items-center gap-1">
                                  {risky ? "⚠️" : "✅"} to{" "}
                                  <span className={cx("font-mono text-[10px]", risky ? "text-rose-200" : "text-emerald-300")}>
                                    {String(newStatus)}
                                  </span>
                                </span>
                              )}
                              <span className="inline-flex items-center gap-1">
                                • actor: <span className="font-mono text-[10px] text-slate-300">{String(actor)}</span>
                              </span>
                            </div>
                          </button>
                        );
                      })}

                      {errorMessage && <div className="text-[11px] text-rose-400">{errorMessage}</div>}
                    </div>

                    <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-3 text-xs text-slate-400">
                      Tip: click an event to open a safe JSON inspector modal (copy only).
                    </div>
                  </div>

                  <div className="mt-4 rounded-3xl border border-white/10 bg-black/20 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-200">Guidance</div>
                        <div className="text-[11px] text-slate-500">Operational interpretation</div>
                      </div>
                      <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[10px] tracking-[0.18em] uppercase text-slate-200">
                        guide
                      </span>
                    </div>

                    <div className="mt-3 space-y-3 text-sm text-slate-300">
                      <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                        1) Healthy heartbeat means Sentinel is processing checks and emitting audit feed.
                      </div>
                      <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                        2) Use <span className="text-slate-200">Entity Radar</span> to focus obligations before taking action elsewhere.
                      </div>
                      <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                        3) Use Council/Forge/Archive to execute lifecycle — Sentinel is watchtower only.
                      </div>
                    </div>

                    <div className="mt-4 text-[11px] text-slate-500 leading-relaxed">
                      This surface is read-only by design. It reports drift; it does not mutate the ledger.
                    </div>
                  </div>
                </section>
              </div>

              {/* OS behavior footnote */}
              <div className="mt-5 rounded-3xl border border-white/10 bg-black/20 px-4 py-3 text-[11px] text-slate-400">
                <div className="font-semibold text-slate-200">OS behavior</div>
                <div className="mt-1 leading-relaxed text-slate-400">
                  CI-Sentinel inherits the OS shell. iPhone-first stacking, 12-col grid on desktop, modal overlays for details. No wiring changes.
                </div>
              </div>

              <div className="mt-5 flex items-center justify-between text-[10px] text-slate-600">
                <span>CI-Sentinel · Oasis Digital Parliament</span>
                <span>ODP.AI · Governance Firmware</span>
              </div>
            </div>
          </div>

          {/* optional quick links row (matches your other modules) */}
          <div className="mt-4 flex flex-wrap gap-2">
            <Link
              href="/ci-archive"
              className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7"
            >
              CI-Archive
            </Link>
            <Link
              href="/ci-council"
              className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7"
            >
              Council
            </Link>
            <Link
              href="/ci-forge"
              className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7"
            >
              Forge
            </Link>
            <Link
              href="/ci-archive/verified"
              className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7"
            >
              Verified
            </Link>
          </div>
        </div>
      </div>

      {/* ENTITY DETAILS MODAL */}
      {entityModalOpen && selectedEntity && (
        <div className="fixed inset-0 z-[80]">
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => {
              setEntityModalOpen(false);
              setSelectedEntity(null);
            }}
          />
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <div className="w-full max-w-[860px] rounded-3xl border border-white/10 bg-black/60 shadow-[0_40px_140px_rgba(0,0,0,0.65)] overflow-hidden">
              <div className="border-b border-white/10 bg-gradient-to-b from-white/[0.08] to-transparent px-5 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">Entity</div>
                    <div className="mt-1 text-lg font-semibold text-slate-50 truncate">{selectedEntity.entity_name}</div>
                    <div className="mt-1 text-xs text-slate-400">
                      slug: <span className="text-slate-200">{selectedEntity.entity_slug ?? "—"}</span> · id:{" "}
                      <span className="font-mono text-slate-200">{selectedEntity.entity_id}</span>
                    </div>
                  </div>

                  <button
                    onClick={() => {
                      setEntityModalOpen(false);
                      setSelectedEntity(null);
                    }}
                    className="rounded-full border border-white/10 bg-white/5 p-2 hover:bg-white/7"
                    aria-label="Close"
                  >
                    <X className="h-4 w-4 text-slate-200" />
                  </button>
                </div>
              </div>

              <div className="px-5 py-5">
                <div className="grid grid-cols-12 gap-4">
                  <div className="col-span-12 lg:col-span-7">
                    <div className="rounded-3xl border border-white/10 bg-black/30 p-4">
                      <div className="text-sm font-semibold text-slate-200">Health snapshot</div>
                      <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                        <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                          <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">Open violations</div>
                          <div className="mt-1 text-lg font-semibold text-slate-50">{selectedEntity.open_violations ?? 0}</div>
                        </div>
                        <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                          <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">Critical</div>
                          <div className="mt-1 text-lg font-semibold text-rose-200">{selectedEntity.open_critical_violations ?? 0}</div>
                        </div>
                        <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                          <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">Past-due actions</div>
                          <div className="mt-1 text-lg font-semibold text-amber-200">{selectedEntity.past_due_actions ?? 0}</div>
                        </div>
                        <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                          <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">Compliance score</div>
                          <div className="mt-1 text-lg font-semibold text-slate-50">{selectedEntity.compliance_score ?? "—"}</div>
                        </div>
                      </div>

                      <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-3 text-xs text-slate-400">
                        This modal is informational + copy only. No mutations.
                      </div>
                    </div>
                  </div>

                  <div className="col-span-12 lg:col-span-5">
                    <div className="rounded-3xl border border-white/10 bg-black/30 p-4">
                      <div className="text-sm font-semibold text-slate-200">Safe actions</div>
                      <div className="mt-3 space-y-2">
                        <button
                          type="button"
                          onClick={() => safeCopy(selectedEntity.entity_id)}
                          className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-200 hover:bg-white/7 inline-flex items-center justify-between"
                        >
                          <span className="inline-flex items-center gap-2">
                            <Copy className="h-4 w-4" />
                            Copy entity_id
                          </span>
                          <ExternalLink className="h-4 w-4 opacity-60" />
                        </button>

                        {selectedEntity.entity_slug && (
                          <button
                            type="button"
                            onClick={() => safeCopy(String(selectedEntity.entity_slug))}
                            className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-200 hover:bg-white/7 inline-flex items-center justify-between"
                          >
                            <span className="inline-flex items-center gap-2">
                              <Copy className="h-4 w-4" />
                              Copy slug
                            </span>
                            <ExternalLink className="h-4 w-4 opacity-60" />
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={() => {
                            // focus obligations (UI-only)
                            setActiveEntityId(selectedEntity.entity_id);
                            setEntityModalOpen(false);
                            setSelectedEntity(null);
                          }}
                          className="w-full rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-100 hover:bg-amber-400/15 inline-flex items-center justify-between"
                        >
                          <span className="inline-flex items-center gap-2">
                            <Radar className="h-4 w-4" />
                            Focus obligations
                          </span>
                          <ExternalLink className="h-4 w-4 opacity-60" />
                        </button>
                      </div>

                      <div className="mt-4 text-[11px] text-slate-500 leading-relaxed">
                        If you need to act, go to Council/Forge/Archive. Sentinel is reporting only.
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="border-t border-white/10 bg-black/30 px-5 py-4 flex items-center justify-between gap-2">
                <div className="text-[11px] text-slate-500">CI-Sentinel · Watchtower modal</div>
                <button
                  onClick={() => {
                    setEntityModalOpen(false);
                    setSelectedEntity(null);
                  }}
                  className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* EVENT JSON MODAL */}
      {eventModalOpen && selectedEvent && (
        <div className="fixed inset-0 z-[80]">
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => {
              setEventModalOpen(false);
              setSelectedEvent(null);
            }}
          />
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <div className="w-full max-w-[900px] rounded-3xl border border-white/10 bg-black/60 shadow-[0_40px_140px_rgba(0,0,0,0.65)] overflow-hidden">
              <div className="border-b border-white/10 bg-gradient-to-b from-white/[0.08] to-transparent px-5 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">Audit event</div>
                    <div className="mt-1 text-lg font-semibold text-slate-50 truncate">
                      {String(
                        selectedEvent.resolution_title ??
                          selectedEvent.record_title ??
                          selectedEvent.headline ??
                          "Compliance event"
                      )}
                    </div>
                    <div className="mt-1 text-xs text-slate-400">
                      <span className="inline-flex items-center gap-2">
                        <ActivityIcon className="h-4 w-4 text-sky-300" />
                        <span>JSON inspector (copy-only)</span>
                      </span>
                    </div>
                  </div>

                  <button
                    onClick={() => {
                      setEventModalOpen(false);
                      setSelectedEvent(null);
                    }}
                    className="rounded-full border border-white/10 bg-white/5 p-2 hover:bg-white/7"
                    aria-label="Close"
                  >
                    <X className="h-4 w-4 text-slate-200" />
                  </button>
                </div>
              </div>

              <div className="px-5 py-5">
                <div className="rounded-3xl border border-white/10 bg-black/30 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-semibold text-slate-200">Raw payload</div>
                    <button
                      type="button"
                      onClick={() => safeCopy(prettyJson(selectedEvent))}
                      className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7 inline-flex items-center gap-2"
                    >
                      <Copy className="h-4 w-4" />
                      Copy JSON
                    </button>
                  </div>

                  <pre className="mt-3 max-h-[520px] overflow-auto rounded-2xl border border-white/10 bg-black/20 p-3 text-[11px] text-slate-200">
                    {prettyJson(selectedEvent)}
                  </pre>

                  <div className="mt-3 text-[11px] text-slate-500">
                    Source: <span className="font-mono text-slate-200">v_compliance_audit_feed</span>
                  </div>
                </div>
              </div>

              <div className="border-t border-white/10 bg-black/30 px-5 py-4 flex items-center justify-between gap-2">
                <div className="text-[11px] text-slate-500">CI-Sentinel · Audit event modal</div>
                <button
                  onClick={() => {
                    setEventModalOpen(false);
                    setSelectedEvent(null);
                  }}
                  className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
