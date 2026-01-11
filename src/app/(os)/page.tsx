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

type DocketRow = {
  docket_key: string;
  module: string;
  title: string;
  status_label: string | null;
  is_test: boolean;
  sort_rank: number | null;

  // optional (depends on view)
  updated_at?: string | null;
  created_at?: string | null;
  deep_link?: string | null;
  entity_slug?: string | null;
  entity_key?: string | null;
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

function formatAge(ts?: string | null) {
  if (!ts) return "—";
  const t = new Date(ts).getTime();
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
  if (row.deep_link && row.deep_link.startsWith("/")) return row.deep_link;

  const key = row.docket_key || "";
  const prefix = key.split(":")[0];

  if (row.module === "drafts" || prefix === "drafts") return "/ci-alchemy";
  if (row.module === "council" || prefix === "ledger") return "/ci-council";
  if (row.module === "forge" || prefix === "envelope") return "/ci-forge";
  if (row.module === "archive" || prefix === "archive") return "/ci-archive/minute-book";
  if (row.module === "verified" || prefix === "verified") return "/ci-archive/verified";
  if (row.module === "admissions" || prefix === "admissions") return "/ci-admissions";

  return "/ci-council";
}

function normalizeEnv(raw: unknown): "ROT" | "SANDBOX" {
  const s = String(raw ?? "").trim().toUpperCase();
  return s === "SANDBOX" ? "SANDBOX" : "ROT";
}

export default function DashboardPlaceholder() {
  // your OS context has entityKey (holdings/real-estate/lounge)
  const { entityKey } = useEntity() as unknown as { entityKey: string };

  // OsEnvContext is canonical (but we still normalize because other components write "RoT")
  const envCtx = useOsEnv() as unknown as { env?: unknown; isSandbox?: boolean };
  const envNorm = normalizeEnv(envCtx?.env);
  const isTest = typeof envCtx?.isSandbox === "boolean" ? envCtx.isSandbox : envNorm === "SANDBOX";

  const [rows, setRows] = useState<DocketRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // UI cutoff (you asked “only show after January”)
  const CUTOFF_ISO = "2026-01-01T00:00:00.000Z";

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setErr(null);

      // We try "rich" first. If the view doesn't expose these columns, Supabase errors.
      const richSelect =
        "docket_key,module,title,status_label,is_test,sort_rank,updated_at,created_at,deep_link,entity_slug,entity_key";
      const minimalSelect = "docket_key,module,title,status_label,is_test,sort_rank";

      // Helper: apply cutoff on whichever timestamp exists.
      const applyCutoff = (q: any) => {
        // We can only apply server-side cutoff if column exists.
        // We'll do it on updated_at first, then created_at fallback in memory if needed.
        return q.gte("updated_at", CUTOFF_ISO);
      };

      // 1) Rich query: lane + entity_slug + cutoff
      {
        let q = supabase
          .from("v_governance_docket_v2")
          .select(richSelect)
          .eq("is_test", isTest)
          .eq("entity_slug", entityKey)
          .order("sort_rank", { ascending: false })
          .limit(80);

        q = applyCutoff(q);

        const res = await q;

        if (!cancelled && !res.error) {
          let data = (res.data as DocketRow[]) || [];

          // If view uses created_at but not updated_at (rare), enforce cutoff in memory.
          data = data.filter((r) => {
            const ts = r.updated_at || r.created_at;
            if (!ts) return true;
            return new Date(ts).getTime() >= new Date(CUTOFF_ISO).getTime();
          });

          setRows(data);
          setLoading(false);
          return;
        }
      }

      // 2) Rich fallback: lane + entity_key + cutoff
      {
        let q = supabase
          .from("v_governance_docket_v2")
          .select(richSelect)
          .eq("is_test", isTest)
          .eq("entity_key", entityKey)
          .order("sort_rank", { ascending: false })
          .limit(80);

        q = applyCutoff(q);

        const res = await q;

        if (!cancelled && !res.error) {
          let data = (res.data as DocketRow[]) || [];
          data = data.filter((r) => {
            const ts = r.updated_at || r.created_at;
            if (!ts) return true;
            return new Date(ts).getTime() >= new Date(CUTOFF_ISO).getTime();
          });

          setRows(data);
          setLoading(false);
          return;
        }
      }

      // 3) Minimal fallback: lane only (no entity column assumptions) — still safe
      {
        const fallback = await supabase
          .from("v_governance_docket_v2")
          .select(minimalSelect)
          .eq("is_test", isTest)
          .order("sort_rank", { ascending: false })
          .limit(80);

        if (cancelled) return;

        if (fallback.error) {
          setErr(fallback.error.message || "Failed to load docket.");
          setRows([]);
          setLoading(false);
          return;
        }

        setRows((fallback.data as DocketRow[]) || []);
        setLoading(false);
      }
    }

    if (entityKey) load();
    return () => {
      cancelled = true;
    };
  }, [entityKey, isTest]);

  const counts = useMemo(() => {
    const base = { admissions: 0, drafts: 0, council: 0, forge: 0, archive: 0, verified: 0 };
    for (const r of rows) {
      const m = (r.module || "").toLowerCase();
      if (m in base) (base as any)[m] += 1;
    }
    return base;
  }, [rows]);

  const top = useMemo(() => rows.slice(0, 10), [rows]);

  return (
    <div className="w-full h-full flex flex-col gap-6">
      {/* HEADER */}
      <div className="max-w-3xl">
        <div className="text-[11px] uppercase tracking-[0.28em] text-slate-500">Operator Console</div>
        <h1 className="mt-2 text-2xl font-semibold text-slate-100">Oasis OS • Governance Console</h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-400">
          Authority flow across Admissions, Drafts, Council, Forge, Archive, and Verified surfaces. This dashboard is a
          docket — instrumentation first, action second.
        </p>
        <div className="mt-3 text-xs text-slate-500">
          Scope: <span className="text-slate-300">{envNorm}</span> • Entity:{" "}
          <span className="text-slate-300">{entityKey}</span>
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
          { k: "Verified", v: counts.verified, sub: "Today" },
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
        <section className="lg:col-span-7">
          <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Priority Queue</div>
                <div className="mt-2 text-sm text-slate-300">
                  Top items requiring authority attention. Cross-module docket.
                </div>
              </div>

              <div className="rounded-full border border-slate-800 bg-slate-950/70 px-3 py-1 text-[10px] uppercase tracking-[0.22em] text-slate-500">
                {loading ? "Loading" : "Live"}
              </div>
            </div>

            <div className="mt-4 space-y-3">
              {err ? (
                <div className="rounded-2xl border border-red-400/30 bg-red-950/20 p-4 text-sm text-red-200">
                  {err}
                </div>
              ) : loading ? (
                <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4 text-sm text-slate-400">
                  Loading docket…
                </div>
              ) : top.length === 0 ? (
                <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4 text-sm text-slate-400">
                  No docket items for this entity/lane (cutoff: 2026-01-01).
                </div>
              ) : (
                top.map((r) => {
                  const href = resolveDeepLink(r);
                  const age = formatAge(r.updated_at || r.created_at);
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
                })
              )}
            </div>

            <div className="mt-4 text-xs text-slate-500">
              Source: <span className="text-slate-300">public.v_governance_docket_v2</span> • Lane-safe:{" "}
              <span className="text-slate-300">is_test = {String(isTest)}</span> • Cutoff:{" "}
              <span className="text-slate-300">2026-01-01</span>
            </div>
          </div>
        </section>

        {/* RIGHT: AXIOM BRIEF */}
        <section className="lg:col-span-5">
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
              <div className="mt-2 text-sm text-slate-300">
                AXIOM advises. Authority decides. Nothing blocks execution.
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* ACTIVITY FEED */}
      <section className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Recent Activity</div>
            <div className="mt-2 text-sm text-slate-300">
              Latest actions across the organism. Audit-style, calm, chronological.
            </div>
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
            <div
              key={i}
              className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-sm text-slate-300"
            >
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
