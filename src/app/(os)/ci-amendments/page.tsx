"use client";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";

type AmendmentRow = {
  change_id: string;
  change_key: string | null;
  description: string | null;
  change_type: string | null;
  impact_scope: string | null;
  stage: "proposed" | "approved" | "applied" | "rejected" | string;
  is_constitutional: boolean | null;
  breaking_change: boolean | null;
  constitutional_object_id: string | null;
  constitutional_object_type: string | null;
  constitutional_object_name: string | null;
  proposed_at: string | null;
  approved_at: string | null;
  applied_at: string | null;
  rejected_at: string | null;
  metadata: any;
};

const STAGE_FILTERS = ["all", "proposed", "approved", "applied", "rejected"] as const;
type StageFilter = (typeof STAGE_FILTERS)[number];

function formatDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function CIAmendmentsPage() {
  const [rows, setRows] = useState<AmendmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [stageFilter, setStageFilter] = useState<StageFilter>("all");
  const [scopeFilter, setScopeFilter] = useState<string>("all");
  const [constitutionalOnly, setConstitutionalOnly] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function loadAmendments() {
      setLoading(true);
      setError(null);

      const { data, error } = await supabase
        .from("v_schema_amendments")
        .select("*")
        .order("proposed_at", { ascending: false, nullsFirst: false });

      if (cancelled) return;

      if (error) {
        console.error("Failed to load amendments", error);
        setError("Unable to load schema amendments.");
        setRows([]);
      } else {
        setRows((data || []) as AmendmentRow[]);
      }

      setLoading(false);
    }

    loadAmendments();

    return () => {
      cancelled = true;
    };
  }, []);

  const impactScopes = useMemo(() => {
    const unique = new Set<string>();
    rows.forEach((r) => {
      if (r.impact_scope) unique.add(r.impact_scope);
    });
    return Array.from(unique).sort();
  }, [rows]);

  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      if (stageFilter !== "all" && row.stage !== stageFilter) return false;
      if (scopeFilter !== "all" && row.impact_scope !== scopeFilter) return false;
      if (constitutionalOnly && !row.is_constitutional) return false;

      if (search.trim()) {
        const q = search.toLowerCase();
        const haystack = [
          row.change_key,
          row.description,
          row.change_type,
          row.impact_scope,
          row.constitutional_object_name,
          row.constitutional_object_type,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }

      return true;
    });
  }, [rows, stageFilter, scopeFilter, constitutionalOnly, search]);

  return (
    <main className="min-h-screen bg-[#020617] text-slate-100 flex flex-col items-center px-4 py-6">
      <div className="w-full max-w-6xl">
        {/* Header */}
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="text-xs tracking-[0.35em] uppercase text-slate-500 mb-1">
              Oasis Digital Parliament
            </div>
            <h1 className="text-2xl font-semibold text-slate-100">
              CI-Amendments · Schema Legislative Timeline
            </h1>
            <p className="text-sm text-slate-400 mt-1 max-w-2xl">
              Read-only record of every governed schema change: when it was proposed, how
              it was classified, and when it became active law in the ledger.
            </p>
          </div>

          <div className="flex flex-col items-start sm:items-end gap-1 text-xs text-slate-500">
            <span className="inline-flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
              <span>Governance core · internal console</span>
            </span>
            <span>
              Total amendments:{" "}
              <span className="text-slate-200 font-medium">{rows.length}</span>
            </span>
          </div>
        </div>

        {/* Frame */}
        <div className="rounded-3xl border border-slate-800 bg-black/60 shadow-2xl backdrop-blur-md px-4 py-4 sm:px-6 sm:py-5 flex flex-col gap-4">
          {/* Filters */}
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex flex-wrap gap-2">
              {/* Stage filter */}
              <div className="inline-flex items-center gap-1 bg-slate-900/70 border border-slate-800 rounded-full px-2 py-1">
                <span className="text-xs text-slate-400 mr-1">Stage</span>
                {STAGE_FILTERS.map((stage) => (
                  <button
                    key={stage}
                    onClick={() => setStageFilter(stage)}
                    className={`px-2 py-0.5 rounded-full text-xs transition ${
                      stageFilter === stage
                        ? "bg-emerald-500/90 text-black font-medium"
                        : "text-slate-400 hover:text-slate-100 hover:bg-slate-800/80"
                    }`}
                  >
                    {stage === "all"
                      ? "All"
                      : stage.charAt(0).toUpperCase() + stage.slice(1)}
                  </button>
                ))}
              </div>

              {/* Scope filter */}
              <div className="inline-flex items-center gap-1 bg-slate-900/70 border border-slate-800 rounded-full px-2 py-1">
                <span className="text-xs text-slate-400 mr-1">Scope</span>
                <select
                  className="bg-transparent text-xs text-slate-200 focus:outline-none"
                  value={scopeFilter}
                  onChange={(e) => setScopeFilter(e.target.value)}
                >
                  <option value="all">All</option>
                  {impactScopes.map((scope) => (
                    <option key={scope} value={scope}>
                      {scope}
                    </option>
                  ))}
                </select>
              </div>

              {/* Constitutional toggle */}
              <button
                type="button"
                onClick={() => setConstitutionalOnly((v) => !v)}
                className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs transition ${
                  constitutionalOnly
                    ? "border-amber-400/80 bg-amber-400/10 text-amber-200"
                    : "border-slate-700 bg-slate-900/60 text-slate-300 hover:border-amber-300/70 hover:text-amber-100"
                }`}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                Constitutional only
              </button>
            </div>

            {/* Search */}
            <div className="flex items-center gap-2 bg-slate-900/70 border border-slate-800 rounded-full px-3 py-1 w-full md:w-72">
              <span className="text-slate-500 text-xs">Search</span>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Key, description, object…"
                className="flex-1 bg-transparent border-none text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none"
              />
            </div>
          </div>

          {/* Content */}
          <div className="rounded-2xl border border-slate-800/80 bg-slate-950/60 overflow-hidden">
            {loading ? (
              <div className="py-16 flex items-center justify-center text-sm text-slate-400">
                Loading governed schema amendments…
              </div>
            ) : error ? (
              <div className="py-16 flex flex-col items-center justify-center text-sm text-rose-300">
                <span>{error}</span>
                <span className="text-slate-500 mt-1">
                  Check Supabase view <code className="text-xs">v_schema_amendments</code>.
                </span>
              </div>
            ) : filteredRows.length === 0 ? (
              <div className="py-16 flex flex-col items-center justify-center text-sm text-slate-400">
                <span>No amendments match the current filters.</span>
                <span className="text-slate-500 mt-1">
                  Try clearing the stage, scope, or search filters.
                </span>
              </div>
            ) : (
              <div className="max-h-[540px] overflow-auto text-xs">
                <table className="min-w-full border-collapse">
                  <thead className="bg-slate-900/90 sticky top-0 z-10">
                    <tr className="text-[11px] uppercase tracking-wide text-slate-400">
                      <th className="px-3 py-2 text-left border-b border-slate-800/80">
                        Stage
                      </th>
                      <th className="px-3 py-2 text-left border-b border-slate-800/80">
                        Change key
                      </th>
                      <th className="px-3 py-2 text-left border-b border-slate-800/80">
                        Description
                      </th>
                      <th className="px-3 py-2 text-left border-b border-slate-800/80">
                        Scope
                      </th>
                      <th className="px-3 py-2 text-left border-b border-slate-800/80">
                        Type
                      </th>
                      <th className="px-3 py-2 text-left border-b border-slate-800/80">
                        Constitutional object
                      </th>
                      <th className="px-3 py-2 text-left border-b border-slate-800/80">
                        Proposed
                      </th>
                      <th className="px-3 py-2 text-left border-b border-slate-800/80">
                        Approved
                      </th>
                      <th className="px-3 py-2 text-left border-b border-slate-800/80">
                        Applied
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.map((row) => {
                      const stageBadgeClasses =
                        row.stage === "applied"
                          ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/60"
                          : row.stage === "approved"
                          ? "bg-sky-500/10 text-sky-300 border-sky-500/60"
                          : row.stage === "rejected"
                          ? "bg-rose-500/10 text-rose-300 border-rose-500/60"
                          : row.stage === "proposed"
                          ? "bg-amber-500/10 text-amber-300 border-amber-500/60"
                          : "bg-slate-700/40 text-slate-200 border-slate-500/60";

                      return (
                        <tr
                          key={row.change_id}
                          className="border-b border-slate-900/60 hover:bg-slate-900/60 transition"
                        >
                          <td className="px-3 py-2 align-top">
                            <span
                              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${stageBadgeClasses}`}
                            >
                              <span className="h-1.5 w-1.5 rounded-full bg-current" />
                              {row.stage || "unknown"}
                            </span>
                            {row.breaking_change && (
                              <div className="mt-1 text-[10px] text-rose-300">
                                breaking change
                              </div>
                            )}
                            {row.is_constitutional && (
                              <div className="mt-0.5 text-[10px] text-amber-300">
                                constitutional
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2 align-top font-mono text-[11px] text-slate-200">
                            {row.change_key || "—"}
                          </td>
                          <td className="px-3 py-2 align-top text-[11px] text-slate-200 max-w-xs">
                            {row.description || (
                              <span className="text-slate-500">No description</span>
                            )}
                          </td>
                          <td className="px-3 py-2 align-top text-[11px] text-slate-300">
                            {row.impact_scope || "—"}
                          </td>
                          <td className="px-3 py-2 align-top text-[11px] text-slate-300">
                            {row.change_type || "—"}
                          </td>
                          <td className="px-3 py-2 align-top text-[11px] text-slate-300">
                            {row.constitutional_object_name ? (
                              <>
                                <div>{row.constitutional_object_name}</div>
                                <div className="text-[10px] text-slate-500">
                                  {row.constitutional_object_type}
                                </div>
                              </>
                            ) : (
                              <span className="text-slate-500">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2 align-top text-[11px] text-slate-300">
                            {formatDate(row.proposed_at)}
                          </td>
                          <td className="px-3 py-2 align-top text-[11px] text-slate-300">
                            {formatDate(row.approved_at)}
                          </td>
                          <td className="px-3 py-2 align-top text-[11px] text-slate-300">
                            {formatDate(row.applied_at)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <p className="text-[11px] text-slate-500">
            This console is read-only. All rows originate from{" "}
            <code className="text-[11px] text-slate-300">schema_change_log</code> and
            related constitutional mapping. To change schema, raise a new amendment via
            CI-Genesis and record approval in CI-Votes.
          </p>
        </div>
      </div>
    </main>
  );
}
