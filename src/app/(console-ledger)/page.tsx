// src/app/(os)/page.tsx
"use client";
export const dynamic = "force-dynamic";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";

// Local cx helper (avoid utils import mismatch)
function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

type ModuleKey = "all" | "admissions" | "drafts" | "council" | "forge" | "archive" | "verified";

type DocketRow = {
  docket_id: string;
  docket_key: string;
  module: string;
  source_table: string | null;
  source_id: string | null;

  entity_id: string | null;
  entity_slug: string | null;

  is_test: boolean;

  title: string;
  subtitle: string | null;
  status_label: string | null;
  state: string | null;
  severity: string | null;

  created_at: string | null;
  updated_at: string | null;

  due_at: string | null;
  sort_rank: number | null;

  primary_action?: any;
  deep_links?: any;
  tags?: any;
  meta?: any;
};

function pillTone(module: string) {
  const m = (module || "").toLowerCase();
  if (m === "admissions") return "border-emerald-300/20 bg-emerald-950/15 text-emerald-200";
  if (m === "drafts") return "border-slate-700 bg-slate-950/60 text-slate-200";
  if (m === "council") return "border-amber-300/20 bg-amber-950/10 text-amber-200";
  if (m === "forge") return "border-sky-300/20 bg-sky-950/10 text-sky-200";
  if (m === "archive") return "border-fuchsia-300/20 bg-fuchsia-950/10 text-fuchsia-200";
  if (m === "verified") return "border-amber-300/20 bg-amber-950/10 text-amber-200";
  return "border-slate-800 bg-slate-950/60 text-slate-300";
}

function dotTone(module: string) {
  const m = (module || "").toLowerCase();
  if (m === "admissions") return "bg-emerald-300/80";
  if (m === "council") return "bg-amber-300/80";
  if (m === "forge") return "bg-sky-300/80";
  if (m === "archive") return "bg-fuchsia-300/80";
  if (m === "verified") return "bg-amber-300/80";
  return "bg-slate-500/70";
}

function laneLabel(isTest: boolean) {
  return isTest ? "SANDBOX" : "ROT";
}

function formatAge(updatedAt?: string | null) {
  if (!updatedAt) return "—";
  const t = new Date(updatedAt).getTime();
  if (!Number.isFinite(t)) return "—";
  const ms = Date.now() - t;
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function resolveDeepLink(row: DocketRow): string {
  // Prefer deep_links.open if present
  const open = row?.deep_links?.open;
  if (typeof open === "string" && open.startsWith("/")) return open;

  const key = row.docket_key || "";
  const prefix = key.split(":")[0];

  const mod = (row.module || "").toLowerCase();
  if (mod === "drafts" || prefix === "drafts") return "/ci-alchemy";
  if (mod === "council" || prefix === "ledger") return "/ci-council";
  if (mod === "forge" || prefix === "envelope") return "/ci-forge";
  if (mod === "archive" || prefix === "archive") return "/ci-archive/minute-book";
  if (mod === "verified" || prefix === "verified") return "/ci-archive/verified";
  if (mod === "admissions" || prefix === "admissions") return "/ci-admissions";

  return "/ci-council";
}

function modKey(m: string): ModuleKey {
  const x = (m || "").toLowerCase();
  if (x === "admissions") return "admissions";
  if (x === "drafts") return "drafts";
  if (x === "council") return "council";
  if (x === "forge") return "forge";
  if (x === "archive") return "archive";
  if (x === "verified") return "verified";
  return "all";
}

export default function Dashboard() {
  const { entityKey } = useEntity() as unknown as { entityKey: string };
  const { env } = useOsEnv(); // "ROT" | "SANDBOX"

  // ✅ FIX: lane semantics are canonical:
  // SANDBOX => is_test = true
  // ROT     => is_test = false
  const laneIsTest = env === "SANDBOX";

  // ✅ Congestion killer: only show records on/after Jan 1, 2026
  // Using created_at because v_governance_docket_v2 has created_at + updated_at.
  const cutoffISO = "2026-01-01T00:00:00Z";

  const [rows, setRows] = useState<DocketRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [tab, setTab] = useState<ModuleKey>("all");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setErr(null);

      const select =
        "docket_id,docket_key,module,source_table,source_id,entity_id,entity_slug,is_test,title,subtitle,status_label,state,severity,created_at,updated_at,due_at,sort_rank,primary_action,deep_links,tags,meta";

      const q = supabase
        .from("v_governance_docket_v2")
        .select(select)
        .eq("entity_slug", entityKey)
        .eq("is_test", laneIsTest)
        .gte("created_at", cutoffISO)
        .order("sort_rank", { ascending: false })
        .order("updated_at", { ascending: false })
        .limit(200);

      const res = await q;

      if (cancelled) return;

      if (res.error) {
        setErr(res.error.message || "Failed to load docket.");
        setRows([]);
        setLoading(false);
        return;
      }

      setRows((res.data as DocketRow[]) || []);
      setLoading(false);
    }

    if (entityKey) load();
    return () => {
      cancelled = true;
    };
  }, [entityKey, laneIsTest]);

  const counts = useMemo(() => {
    const base = { admissions: 0, drafts: 0, council: 0, forge: 0, archive: 0, verified: 0 };
    for (const r of rows) {
      const k = modKey(r.module);
      if (k !== "all") (base as any)[k] += 1;
    }
    return base;
  }, [rows]);

  const filtered = useMemo(() => {
    if (tab === "all") return rows;
    return rows.filter((r) => modKey(r.module) === tab);
  }, [rows, tab]);

  const top = useMemo(() => filtered.slice(0, 50), [filtered]);

  return (
    <div className="w-full h-full flex flex-col gap-6">
      {/* HEADER */}
      <div className="max-w-4xl">
        <div className="text-[11px] uppercase tracking-[0.28em] text-slate-500">Operator Console</div>
        <h1 className="mt-2 text-2xl font-semibold text-slate-100">Oasis OS • Governance Console</h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-400">
          Authority flow across Admissions, Drafts, Council, Forge, Archive, and Verified surfaces. This dashboard is a
          docket — instrumentation first, action second.
        </p>

        <div className="mt-3 text-xs text-slate-500">
          Toggle shows: <span className="text-slate-300">{env}</span> • Entity:{" "}
          <span className="text-slate-300">{entityKey}</span> • Dashboard query lane:{" "}
          <span className="text-slate-300">is_test = {String(laneIsTest)}</span> • Cutoff:{" "}
          <span className="text-slate-300">{cutoffISO}</span>
        </div>
      </div>

      {/* INSTRUMENTATION BAND */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        {[
          { k: "Admissions", v: counts.admissions, sub: "Inbox" },
          { k: "Drafts", v: counts.drafts, sub: "Needs work" },
          { k: "Council", v: counts.council, sub: "Pending" },
          { k: "Forge", v: counts.forge, sub: "Active" },
          { k: "Archive", v: counts.archive, sub: "Exceptions" },
          { k: "Verified", v: counts.verified, sub: "Registered" },
        ].map((x) => (
          <div key={x.k} className="rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-3">
            <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">{x.k}</div>
            <div className="mt-2 flex items-baseline justify-between gap-3">
              <div className="text-lg font-semibold text-slate-100">{loading ? "—" : String(x.v)}</div>
              <div className="text-[11px] text-slate-500">{x.sub}</div>
            </div>
          </div>
        ))}
      </div>

      {/* MAIN DOCKET SURFACE */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* LEFT: PRIORITY QUEUE */}
        <section className="lg:col-span-6">
          <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Priority Queue</div>
                <div className="mt-2 text-sm text-slate-300">
                  Tabbed docket. Fixed-height list. Calm operator flow.
                </div>
              </div>

              <div className="rounded-full border border-slate-800 bg-slate-950/70 px-3 py-1 text-[10px] uppercase tracking-[0.22em] text-slate-500">
                {loading ? "Loading" : "Live"}
              </div>
            </div>

            {/* Tabs */}
            <div className="mt-4 flex flex-wrap gap-2">
              {(
                [
                  ["all", "All", rows.length],
                  ["admissions", "Admissions", counts.admissions],
                  ["drafts", "Drafts", counts.drafts],
                  ["council", "Council", counts.council],
                  ["forge", "Forge", counts.forge],
                  ["archive", "Archive", counts.archive],
                  ["verified", "Verified", counts.verified],
                ] as Array<[ModuleKey, string, number]>
              ).map(([k, label, n]) => (
                <button
                  key={k}
                  onClick={() => setTab(k)}
                  className={cx(
                    "rounded-full border px-3 py-1 text-[10px] uppercase tracking-[0.22em] transition",
                    tab === k
                      ? "border-amber-300/30 bg-amber-950/15 text-amber-200"
                      : "border-slate-800 bg-slate-950/60 text-slate-400 hover:text-slate-200"
                  )}
                >
                  {label} <span className="opacity-70">{n}</span>
                </button>
              ))}
            </div>

            {/* Fixed-height list */}
            <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/50">
              <div className="flex items-center justify-between px-4 py-2">
                <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">
                  Showing: <span className="text-slate-300">{tab.toUpperCase()}</span>
                </div>
                <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">
                  Count: <span className="text-slate-300">{loading ? "—" : String(filtered.length)}</span>
                </div>
              </div>

              <div className="max-h-[520px] overflow-auto px-3 pb-3">
                {err ? (
                  <div className="mt-3 rounded-2xl border border-red-400/30 bg-red-950/20 p-4 text-sm text-red-200">
                    {err}
                  </div>
                ) : loading ? (
                  <div className="mt-3 rounded-2xl border border-slate-800 bg-slate-950/70 p-4 text-sm text-slate-400">
                    Loading docket…
                  </div>
                ) : top.length === 0 ? (
                  <div className="mt-3 rounded-2xl border border-slate-800 bg-slate-950/70 p-4 text-sm text-slate-400">
                    No docket items after Jan 1 for this entity/lane.
                  </div>
                ) : (
                  <div className="mt-3 space-y-3">
                    {top.map((r) => {
                      const href = resolveDeepLink(r);
                      const age = formatAge(r.updated_at);
                      return (
                        <Link
                          key={r.docket_key}
                          href={href}
                          className="group block rounded-2xl border border-slate-800 bg-slate-950/70 p-4 transition hover:border-amber-300/25 hover:bg-slate-950"
                        >
                          <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className={cx("h-2 w-2 rounded-full", dotTone(r.module))} />
                                <span className="text-[10px] uppercase tracking-[0.22em] text-slate-500">
                                  {(r.module || "unknown").toUpperCase()}
                                </span>
                                <span
                                  className={cx(
                                    "rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.18em]",
                                    pillTone(r.module)
                                  )}
                                >
                                  {(r.status_label || "—").toUpperCase()}
                                </span>
                                <span className="rounded-full border border-slate-800 bg-slate-950/60 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-slate-500">
                                  {laneLabel(r.is_test)}
                                </span>
                              </div>

                              <div className="mt-2 text-sm font-semibold text-slate-100">{r.title}</div>
                              <div className="mt-1 text-xs text-slate-500">
                                Age: {age} • {r.docket_key}
                              </div>
                            </div>

                            <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-1.5 text-xs font-semibold text-slate-200 opacity-80 transition group-hover:border-amber-300/25 group-hover:opacity-100">
                              Open
                            </div>
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="mt-4 text-xs text-slate-500">
              Source: <span className="text-slate-300">public.v_governance_docket_v2</span> • Lane-safe query:{" "}
              <span className="text-slate-300">is_test = {String(laneIsTest)}</span> • Cutoff:{" "}
              <span className="text-slate-300">{cutoffISO}</span>
            </div>
          </div>
        </section>

        {/* CENTER: FOCUS PANE */}
        <section className="lg:col-span-4">
          <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
            <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Focus</div>
            <div className="mt-2 text-sm text-slate-300">
              Select an item in the docket to view the case file, state, and primary action.
            </div>

            <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
              <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">No item selected</div>
              <div className="mt-2 text-sm text-slate-400">
                Single-case operation: one record in focus, actions deliberate, audit implied.
              </div>

              <div className="mt-4 grid grid-cols-1 gap-2">
                {["Begin Review", "Request Info", "Approve / Route", "Reject / Archive"].map((x) => (
                  <div
                    key={x}
                    className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs font-semibold text-slate-400"
                  >
                    {x} (disabled)
                  </div>
                ))}
              </div>

              <div className="mt-4 text-xs text-slate-500">Wired later: focus state + context actions (RPC-only).</div>
            </div>
          </div>
        </section>

        {/* RIGHT: AXIOM BRIEF */}
        <section className="lg:col-span-2">
          <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[10px] uppercase tracking-[0.22em] text-amber-300/85">AXIOM Brief</div>
                <div className="mt-2 text-sm text-slate-300">Quiet advisory signals. Non-blocking.</div>
              </div>

              <div className="rounded-full border border-slate-800 bg-slate-950/70 px-3 py-1 text-[10px] uppercase tracking-[0.22em] text-slate-500">
                Read-only
              </div>
            </div>

            <div className="mt-4 space-y-3">
              {[
                { s: "🟢", t: "System stable. No authority backlog detected." },
                { s: "🟡", t: "Review recommended for items exceeding dwell-time thresholds." },
                { s: "🔴", t: "Archive exceptions must be repaired before verification." },
              ].map((x, i) => (
                <div key={i} className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
                  <div className="flex items-start gap-3">
                    <div className="text-sm">{x.s}</div>
                    <div className="text-sm text-slate-200">{x.t}</div>
                  </div>
                  <div className="mt-2 text-xs text-slate-500">Wired later: deep links into docket.</div>
                </div>
              ))}
            </div>

            <div className="mt-4 rounded-2xl border border-amber-300/20 bg-amber-950/10 p-4">
              <div className="text-[10px] uppercase tracking-[0.22em] text-amber-200">Discipline</div>
              <div className="mt-2 text-sm text-slate-300">AXIOM advises. Authority decides. Nothing blocks execution.</div>
            </div>
          </div>
        </section>
      </div>

      {/* ACTIVITY FEED (placeholder) */}
      <section className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Recent Activity</div>
            <div className="mt-2 text-sm text-slate-300">Latest actions across the organism. Audit-style, calm, chronological.</div>
          </div>

          <div className="rounded-full border border-slate-800 bg-slate-950/70 px-3 py-1 text-[10px] uppercase tracking-[0.22em] text-slate-500">
            Placeholder
          </div>
        </div>

        <div className="mt-4 space-y-2">
          {[
            "Admissions: status changed → IN_REVIEW",
            "Council: decision recorded → APPROVED",
            "Forge: envelope completed → SIGNED",
            "Archive: record sealed → VERIFIED REGISTERED",
          ].map((x, i) => (
            <div key={i} className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-sm text-slate-300">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0 truncate">{x}</div>
                <div className="text-xs text-slate-500">—</div>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 text-xs text-slate-500">Wired later: a single activity feed with lane + entity + deep links.</div>
      </section>
    </div>
  );
}
