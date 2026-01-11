// src/app/(os)/page.tsx
"use client";
export const dynamic = "force-dynamic";

/**
 * Oasis OS → Governance Console (Dashboard)
 * - This is the *dashboard* only (not the Dock component).
 * - Rule A: One canonical object shape for docket items.
 * - Wired to: public.v_governance_docket_v2 (read-only view)
 *
 * Expected minimal columns on v_governance_docket_v2:
 *  - docket_key (text)          e.g. "drafts:<uuid>" | "ledger:<uuid>" | "admissions:<uuid>"
 *  - module (text)              "admissions" | "drafts" | "council" | "forge" | "archive" | "verified"
 *  - title (text)
 *  - status_label (text)        display label (e.g. "PENDING", "IN_REVIEW", "EXCEPTION")
 *  - is_test (bool)             lane safety (SANDBOX vs RoT)
 *  - sort_rank (int)            higher = more urgent
 *  - updated_at (timestamptz)   for tie-break ordering
 *
 * Optional (future): entity_id, entity_slug, deep_link, severity, age_minutes, meta_json
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";
import { cx } from "@/lib/utils";

type ModuleKey = "admissions" | "drafts" | "council" | "forge" | "archive" | "verified";

type DocketItem = {
  docket_key: string;
  module: ModuleKey | string;
  title: string | null;
  status_label: string | null;
  is_test: boolean | null;
  sort_rank: number | null;
  updated_at: string | null;

  // optional (do not assume present)
  entity_slug?: string | null;
  deep_link?: string | null;
  severity?: "green" | "yellow" | "red" | "neutral" | null;
};

type ModuleCounts = Record<ModuleKey, number>;

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function formatLane(isTest: boolean | null | undefined) {
  return isTest ? "SANDBOX" : "TRUTH";
}

function deriveDot(item: DocketItem): string {
  const s = (item.status_label || "").toUpperCase();

  if (item.severity === "red") return "bg-red-400/80";
  if (item.severity === "yellow") return "bg-amber-300/80";
  if (item.severity === "green") return "bg-emerald-300/80";

  if (s.includes("EXCEPTION") || s.includes("ERROR") || s.includes("FAILED")) return "bg-red-400/80";
  if (s.includes("PENDING") || s.includes("IN_REVIEW") || s.includes("NEEDS")) return "bg-amber-300/80";
  return "bg-slate-500/70";
}

function toModuleKey(m: string): ModuleKey | null {
  const x = (m || "").toLowerCase();
  if (x === "admissions") return "admissions";
  if (x === "drafts") return "drafts";
  if (x === "council") return "council";
  if (x === "forge") return "forge";
  if (x === "archive") return "archive";
  if (x === "verified") return "verified";
  return null;
}

function safeTitle(s: string | null | undefined) {
  const t = (s || "").trim();
  return t.length ? t : "Untitled";
}

export default function DashboardPlaceholder() {
  const { entityKey } = useEntity();
  const { env } = useOsEnv(); // "SANDBOX" | "ROT" in your OS
  const laneIsTest = env === "SANDBOX";

  const [loading, setLoading] = useState(false);
  const [docket, setDocket] = useState<DocketItem[]>([]);
  const [counts, setCounts] = useState<ModuleCounts>({
    admissions: 0,
    drafts: 0,
    council: 0,
    forge: 0,
    archive: 0,
    verified: 0,
  });

  // --- WIRING (read-only) ---
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        // IMPORTANT: keep this lane-safe and entity-safe.
        // If your view already scopes by entity+lane, this will just work.
        // If not, you can add filters here *without changing the canonical object shape*.
        const q = supabase
          .from("v_governance_docket_v2")
          .select("docket_key,module,title,status_label,is_test,sort_rank,updated_at")
          .order("sort_rank", { ascending: false })
          .order("updated_at", { ascending: false })
          .limit(50);

        // Optional filters if the view is not already scoped:
        // @ts-expect-error (view may not have entity_key)
        if (entityKey) q.eq("entity_key", entityKey);
        q.eq("is_test", laneIsTest);

        const { data, error } = await q;
        if (error) throw error;

        const rows = (data || []) as DocketItem[];

        if (!cancelled) {
          setDocket(rows);

          const next: ModuleCounts = {
            admissions: 0,
            drafts: 0,
            council: 0,
            forge: 0,
            archive: 0,
            verified: 0,
          };

          for (const r of rows) {
            const mk = toModuleKey(String(r.module || ""));
            if (mk) next[mk] += 1;
          }

          setCounts(next);
        }
      } catch {
        // If the view isn't present yet or errors, we keep the console pristine (placeholders).
        if (!cancelled) {
          setDocket([]);
          setCounts({
            admissions: 0,
            drafts: 0,
            council: 0,
            forge: 0,
            archive: 0,
            verified: 0,
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [entityKey, laneIsTest]);

  const topDocket = useMemo(() => docket.slice(0, 8), [docket]);

  return (
    <div className="w-full h-full flex flex-col gap-6">
      {/* HEADER */}
      <div className="max-w-3xl">
        <div className="text-[11px] uppercase tracking-[0.28em] text-slate-500">
          Operator Console
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-slate-100">
            Oasis OS • Governance Console
          </h1>

          <span
            className={cx(
              "rounded-full border px-3 py-1 text-[10px] uppercase tracking-[0.22em]",
              laneIsTest
                ? "border-amber-300/25 bg-amber-950/10 text-amber-200"
                : "border-slate-800 bg-slate-950/60 text-slate-400"
            )}
          >
            {laneIsTest ? "SANDBOX" : "TRUTH LANE"}
          </span>

          {loading ? (
            <span className="text-xs text-slate-500">Refreshing…</span>
          ) : null}
        </div>

        <p className="mt-3 text-sm leading-relaxed text-slate-400">
          Authority flow across Admissions, Drafts, Council, Forge, Archive, and Verified surfaces.
          This is a docket console — instrumentation first, action second.
        </p>
      </div>

      {/* INSTRUMENTATION BAND */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        {(
          [
            { k: "Admissions", key: "admissions", v: counts.admissions, sub: "Inbox" },
            { k: "Drafts", key: "drafts", v: counts.drafts, sub: "Needs work" },
            { k: "Council", key: "council", v: counts.council, sub: "Pending" },
            { k: "Forge", key: "forge", v: counts.forge, sub: "Active" },
            { k: "Archive", key: "archive", v: counts.archive, sub: "Exceptions" },
            { k: "Verified", key: "verified", v: counts.verified, sub: "Today" },
          ] as const
        ).map((x) => (
          <div
            key={x.k}
            className="rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-3"
          >
            <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">
              {x.k}
            </div>
            <div className="mt-2 flex items-baseline justify-between gap-3">
              <div className="text-lg font-semibold text-slate-100">
                {x.v ? String(x.v) : "—"}
              </div>
              <div className="text-[11px] text-slate-500">{x.sub}</div>
            </div>
          </div>
        ))}
      </div>

      {/* MAIN DOCKET SURFACE */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* LEFT: PRIORITY QUEUE */}
        <section className="lg:col-span-5">
          <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">
                  Priority Queue
                </div>
                <div className="mt-2 text-sm text-slate-300">
                  Top items requiring authority attention. Cross-module docket.
                </div>
              </div>

              <div className="rounded-full border border-slate-800 bg-slate-950/70 px-3 py-1 text-[10px] uppercase tracking-[0.22em] text-slate-500">
                {topDocket.length ? "Live" : "Placeholder"}
              </div>
            </div>

            <div className="mt-4 space-y-3">
              {(topDocket.length
                ? topDocket
                : ([
                    {
                      docket_key: "admissions:placeholder",
                      module: "admissions",
                      title: "Oasis Custodial Registry",
                      status_label: "IN_REVIEW",
                      is_test: laneIsTest,
                      sort_rank: 900,
                      updated_at: null,
                      severity: "yellow",
                    },
                    {
                      docket_key: "council:placeholder",
                      module: "council",
                      title: "Resolution awaiting decision",
                      status_label: "PENDING",
                      is_test: laneIsTest,
                      sort_rank: 850,
                      updated_at: null,
                      severity: "yellow",
                    },
                    {
                      docket_key: "forge:placeholder",
                      module: "forge",
                      title: "Envelope signing in progress",
                      status_label: "ACTIVE",
                      is_test: laneIsTest,
                      sort_rank: 700,
                      updated_at: null,
                      severity: "neutral",
                    },
                    {
                      docket_key: "archive:placeholder",
                      module: "archive",
                      title: "Missing primary pointer",
                      status_label: "EXCEPTION",
                      is_test: laneIsTest,
                      sort_rank: 950,
                      updated_at: null,
                      severity: "red",
                    },
                    {
                      docket_key: "drafts:placeholder",
                      module: "drafts",
                      title: "Draft requires edits before finalize",
                      status_label: "NEEDS_WORK",
                      is_test: laneIsTest,
                      sort_rank: 650,
                      updated_at: null,
                      severity: "neutral",
                    },
                  ] as DocketItem[]))
              ).map((r) => {
                const lane = formatLane(r.is_test);
                const dot = deriveDot(r);
                const status = (r.status_label || "—").toUpperCase();
                const mod = String(r.module || "—").toUpperCase();

                return (
                  <div
                    key={r.docket_key}
                    className="group rounded-2xl border border-slate-800 bg-slate-950/70 p-4 transition hover:border-amber-300/25 hover:bg-slate-950"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={cx("h-2 w-2 rounded-full", dot)} />
                          <span className="text-[10px] uppercase tracking-[0.22em] text-slate-500">
                            {mod}
                          </span>
                          <span className="rounded-full border border-slate-800 bg-slate-950/60 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-slate-400">
                            {status}
                          </span>
                          <span className="rounded-full border border-slate-800 bg-slate-950/60 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-slate-500">
                            {lane}
                          </span>
                        </div>

                        <div className="mt-2 text-sm font-semibold text-slate-100">
                          {safeTitle(r.title)}
                        </div>

                        <div className="mt-1 text-xs text-slate-500">
                          {/* Age is derived later (server-side preferred). */}
                          Age: — • Click to focus (wired later)
                        </div>
                      </div>

                      <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-1.5 text-xs font-semibold text-slate-200 opacity-80 transition group-hover:border-amber-300/25 group-hover:opacity-100">
                        Open
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-4 text-xs text-slate-500">
              Rule A: one canonical object shape (docket_key/module/title/status_label/is_test/sort_rank/updated_at).
              This surface simply renders that shape.
            </div>
          </div>
        </section>

        {/* CENTER: FOCUS PANE */}
        <section className="lg:col-span-4">
          <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
            <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">
              Focus
            </div>
            <div className="mt-2 text-sm text-slate-300">
              Select an item in the docket to view the case file, state, and primary action.
            </div>

            <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
              <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">
                No item selected
              </div>
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

              <div className="mt-4 text-xs text-slate-500">
                Wired later: actions become context-aware based on module + state (Admissions, Drafts, Council,
                Forge, Archive) — no bespoke logic per screen.
              </div>
            </div>
          </div>
        </section>

        {/* RIGHT: AXIOM BRIEF */}
        <section className="lg:col-span-3">
          <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[10px] uppercase tracking-[0.22em] text-amber-300/85">
                  AXIOM Brief
                </div>
                <div className="mt-2 text-sm text-slate-300">
                  Quiet advisory signals. Non-blocking. Links to docket items once wired.
                </div>
              </div>

              <div className="rounded-full border border-slate-800 bg-slate-950/70 px-3 py-1 text-[10px] uppercase tracking-[0.22em] text-slate-500">
                Read-only
              </div>
            </div>

            <div className="mt-4 space-y-3">
              {[
                { s: "🟢", t: "System stable. No authority backlog detected." },
                { s: "🟡", t: "3 items exceed expected dwell time (review recommended)." },
                { s: "🔴", t: "1 archive exception requires repair before verification." },
              ].map((x, i) => (
                <div key={i} className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
                  <div className="flex items-start gap-3">
                    <div className="text-sm">{x.s}</div>
                    <div className="text-sm text-slate-200">{x.t}</div>
                  </div>
                  <div className="mt-2 text-xs text-slate-500">
                    Wired later: each signal becomes a deep link into the docket.
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 rounded-2xl border border-amber-300/20 bg-amber-950/10 p-4">
              <div className="text-[10px] uppercase tracking-[0.22em] text-amber-200">
                Discipline
              </div>
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
            <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">
              Recent Activity
            </div>
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

        <div className="mt-4 text-xs text-slate-500">
          Wired later: a single activity feed (last 20) with lane + entity + deep links.
        </div>
      </section>

      {/* FOOTNOTE (tiny) */}
      <div className="text-[11px] text-slate-600">
        Powered by a single docket view:{" "}
        <code className="text-slate-400">public.v_governance_docket_v2</code> • Lane-safe via{" "}
        <code className="text-slate-400">is_test</code>
      </div>
    </div>
  );
}
