"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { ArrowLeft, Search, ShieldCheck, CheckCircle2, X, Copy } from "lucide-react";

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

function cx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

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

function shortJson(obj: any) {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

function safeCopy(text: string) {
  try {
    navigator.clipboard?.writeText(text);
  } catch {}
}

export default function CIAmendmentsPage() {
  const [rows, setRows] = useState<AmendmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [stageFilter, setStageFilter] = useState<StageFilter>("all");
  const [scopeFilter, setScopeFilter] = useState<string>("all");
  const [constitutionalOnly, setConstitutionalOnly] = useState(false);
  const [search, setSearch] = useState("");

  const [selected, setSelected] = useState<AmendmentRow | null>(null);
  const [openModal, setOpenModal] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadAmendments() {
      setLoading(true);
      setError(null);

      // NO WIRING CHANGE
      const { data, error } = await supabase
        .from("v_schema_amendments")
        .select("*")
        .order("proposed_at", { ascending: false, nullsFirst: false });

      if (cancelled) return;

      if (error) {
        console.error("Failed to load amendments", error);
        setError("Unable to load schema amendments.");
        setRows([]);
        setSelected(null);
      } else {
        const r = (data || []) as AmendmentRow[];
        setRows(r);
        setSelected(r[0] ?? null);
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

  // OS shell/header/body pattern (MATCH Verified Registry)
  const shell =
    "rounded-3xl border border-white/10 bg-black/20 shadow-[0_28px_120px_rgba(0,0,0,0.55)] overflow-hidden";
  const header =
    "border-b border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent px-4 sm:px-6 py-4 sm:py-5";
  const body = "px-4 sm:px-6 py-5 sm:py-6";

  function stagePill(stage: string) {
    const s = (stage || "").toLowerCase();
    if (s === "applied") return "border-emerald-400/30 bg-emerald-400/10 text-emerald-100";
    if (s === "approved") return "border-sky-400/30 bg-sky-400/10 text-sky-100";
    if (s === "rejected") return "border-rose-400/30 bg-rose-400/10 text-rose-100";
    if (s === "proposed") return "border-amber-400/30 bg-amber-400/10 text-amber-100";
    return "border-white/10 bg-white/5 text-slate-300";
  }

  return (
    <>
      <div className="w-full">
        <div className="mx-auto w-full max-w-[1200px] px-4 pb-10 pt-4 sm:pt-6">
          <div className={shell}>
            {/* OS-aligned header */}
            <div className={header}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[10px] sm:text-xs tracking-[0.3em] uppercase text-slate-500">
                    CI • Amendments
                  </div>
                  <h1 className="mt-1 text-lg sm:text-xl font-semibold text-slate-50">
                    Schema Legislative Timeline
                  </h1>
                  <p className="mt-1 max-w-3xl text-[11px] sm:text-xs text-slate-400 leading-relaxed">
                    Read-only record of governed schema changes: proposed → approved → applied (or rejected).
                  </p>

                  <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-400">
                    <span className="inline-flex items-center gap-2">
                      <ShieldCheck className="h-4 w-4 text-emerald-300" />
                      <span>Governance record • No destructive actions</span>
                    </span>
                    <span className="text-slate-700">•</span>
                    <span>
                      Source: <span className="font-mono text-[11px] text-slate-200">v_schema_amendments</span>
                    </span>
                    <span className="text-slate-700">•</span>
                    <span>
                      Total: <span className="text-emerald-300 font-medium">{rows.length}</span>
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
                        <div className="text-[11px] text-slate-500">Stage + scope + search</div>
                      </div>
                      <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[10px] tracking-[0.18em] uppercase text-slate-200">
                        filters
                      </span>
                    </div>

                    <div className="mt-3">
                      <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">Stage</div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {STAGE_FILTERS.map((s) => (
                          <button
                            key={s}
                            onClick={() => setStageFilter(s)}
                            className={cx(
                              "rounded-full border px-3 py-1 text-xs transition",
                              stageFilter === s
                                ? "border-amber-400/40 bg-amber-400/10 text-amber-100"
                                : "border-white/10 bg-white/5 text-slate-200/80 hover:bg-white/7"
                            )}
                          >
                            {s === "all" ? "ALL" : s.toUpperCase()}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="mt-4">
                      <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">Scope</div>
                      <select
                        className="mt-2 w-full rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-200 outline-none focus:border-amber-400/30"
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

                    <div className="mt-4">
                      <button
                        type="button"
                        onClick={() => setConstitutionalOnly((v) => !v)}
                        className={cx(
                          "w-full rounded-2xl border px-4 py-3 text-sm text-left transition",
                          constitutionalOnly
                            ? "border-amber-400/30 bg-amber-400/10 text-amber-100"
                            : "border-white/10 bg-white/5 text-slate-200 hover:bg-white/7"
                        )}
                      >
                        <div className="text-[10px] tracking-[0.3em] uppercase opacity-80">Toggle</div>
                        <div className="mt-1 font-semibold">Constitutional only</div>
                        <div className="mt-1 text-[11px] text-slate-400">Filters to constitutional amendments.</div>
                      </button>
                    </div>

                    <div className="mt-4">
                      <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">Search</div>
                      <div className="mt-2 relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                        <input
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                          placeholder="key, description, object…"
                          className="w-full rounded-2xl border border-white/10 bg-white/5 pl-10 pr-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-500 focus:border-amber-400/30"
                        />
                      </div>
                    </div>

                    <div className="mt-4 text-xs text-slate-400">
                      {loading ? "Loading…" : `${filteredRows.length} result(s)`}
                    </div>

                    <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 p-3 text-xs text-slate-400">
                      Amendments are read-only. Approvals are recorded via CI-Votes; applying changes is governed.
                    </div>
                  </div>
                </section>

                {/* MIDDLE: Timeline list */}
                <section className="col-span-12 lg:col-span-6">
                  <div className="rounded-3xl border border-white/10 bg-black/20 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-200">Timeline</div>
                        <div className="text-[11px] text-slate-500">Schema amendments</div>
                      </div>
                      <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[10px] tracking-[0.18em] uppercase text-slate-200">
                        registry
                      </span>
                    </div>

                    <div className="mt-3 space-y-2">
                      {loading ? (
                        <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-slate-400">
                          Loading governed schema amendments…
                        </div>
                      ) : error ? (
                        <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 p-4 text-sm text-rose-200">
                          {error}
                          <div className="mt-1 text-[11px] text-slate-300">
                            Check Supabase view{" "}
                            <span className="font-mono text-[11px] text-slate-200">v_schema_amendments</span>.
                          </div>
                        </div>
                      ) : filteredRows.length === 0 ? (
                        <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-slate-400">
                          No amendments match the current filters.
                          <div className="mt-1 text-[11px] text-slate-500">Try clearing the stage, scope, or search.</div>
                        </div>
                      ) : (
                        filteredRows.map((row) => {
                          const active = selected?.change_id === row.change_id;

                          return (
                            <button
                              key={row.change_id}
                              onClick={() => setSelected(row)}
                              className={cx(
                                "w-full text-left rounded-3xl border p-3 transition",
                                active
                                  ? "border-amber-400/25 bg-amber-400/5"
                                  : "border-white/10 bg-black/20 hover:bg-black/25"
                              )}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className={cx("rounded-full border px-2 py-1 text-[11px]", stagePill(row.stage))}>
                                      {String(row.stage ?? "unknown").toUpperCase()}
                                    </span>

                                    {row.breaking_change && (
                                      <span className="rounded-full border border-rose-400/25 bg-rose-400/10 px-2 py-1 text-[11px] text-rose-100">
                                        BREAKING
                                      </span>
                                    )}

                                    {row.is_constitutional && (
                                      <span className="rounded-full border border-yellow-400/20 bg-yellow-400/10 px-2 py-1 text-[11px] text-yellow-100 inline-flex items-center gap-1">
                                        <CheckCircle2 className="h-4 w-4" />
                                        Constitutional
                                      </span>
                                    )}
                                  </div>

                                  <div className="mt-2 text-sm font-medium text-slate-100 truncate">
                                    {row.change_key || "—"}
                                  </div>

                                  <div className="mt-1 text-xs text-slate-400 line-clamp-2">
                                    {row.description || "No description"}
                                  </div>

                                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                                    <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1">
                                      <span className="text-slate-500">scope:</span>
                                      <span className="text-slate-200">{row.impact_scope || "—"}</span>
                                    </span>
                                    <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1">
                                      <span className="text-slate-500">type:</span>
                                      <span className="text-slate-200">{row.change_type || "—"}</span>
                                    </span>
                                  </div>
                                </div>

                                <div className="shrink-0 text-right text-[11px] text-slate-500">
                                  <div>Proposed: {formatDate(row.proposed_at)}</div>
                                  <div>Approved: {formatDate(row.approved_at)}</div>
                                  <div>Applied: {formatDate(row.applied_at)}</div>
                                </div>
                              </div>
                            </button>
                          );
                        })
                      )}
                    </div>

                    <div className="mt-4 text-[11px] text-slate-500">
                      This console is read-only. Rows originate from governed schema change sources and constitutional mapping.
                    </div>
                  </div>
                </section>

                {/* RIGHT: Inspector */}
                <section className="col-span-12 lg:col-span-3">
                  <div className="rounded-3xl border border-white/10 bg-black/20 p-4 flex flex-col min-h-[240px]">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-200">Inspector</div>
                        <div className="text-[11px] text-slate-500">Selected amendment</div>
                      </div>
                      <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[10px] tracking-[0.18em] uppercase text-slate-200">
                        drawer
                      </span>
                    </div>

                    {!selected ? (
                      <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-slate-400">
                        Select an amendment to inspect its full record.
                      </div>
                    ) : (
                      <>
                        <div className="mt-3">
                          <div className="text-sm font-semibold text-slate-100">{selected.change_key || "—"}</div>
                          <div className="mt-1 text-[11px] text-slate-400">{selected.description || "No description"}</div>
                        </div>

                        <div className="mt-3 space-y-1 text-[11px] text-slate-300">
                          <div>
                            Stage:{" "}
                            <span className={cx("rounded-full border px-2 py-0.5 text-[10px] inline-flex", stagePill(selected.stage))}>
                              {String(selected.stage ?? "unknown").toUpperCase()}
                            </span>
                          </div>
                          <div>Scope: {selected.impact_scope || "—"}</div>
                          <div>Type: {selected.change_type || "—"}</div>
                          <div>
                            Constitutional:{" "}
                            <span className={selected.is_constitutional ? "text-amber-200" : "text-slate-400"}>
                              {selected.is_constitutional ? "yes" : "no"}
                            </span>
                          </div>
                          <div>
                            Breaking:{" "}
                            <span className={selected.breaking_change ? "text-rose-200" : "text-slate-400"}>
                              {selected.breaking_change ? "yes" : "no"}
                            </span>
                          </div>
                          <div>Proposed: {formatDate(selected.proposed_at)}</div>
                          <div>Approved: {formatDate(selected.approved_at)}</div>
                          <div>Applied: {formatDate(selected.applied_at)}</div>
                          <div>Rejected: {formatDate(selected.rejected_at)}</div>

                          <div className="pt-2">
                            <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">Constitutional object</div>
                            <div className="mt-1 text-slate-200">
                              {selected.constitutional_object_name || "—"}
                            </div>
                            <div className="text-[11px] text-slate-500">
                              {selected.constitutional_object_type || "—"}
                            </div>
                          </div>
                        </div>

                        <div className="mt-4 flex flex-col gap-2">
                          <button
                            type="button"
                            onClick={() => setOpenModal(true)}
                            className="rounded-full border border-amber-400/20 bg-amber-400/10 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-amber-100 hover:bg-amber-400/15"
                          >
                            Open record →
                          </button>

                          <button
                            type="button"
                            onClick={() => safeCopy(selected.change_id)}
                            className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7 inline-flex items-center justify-center gap-2"
                          >
                            <Copy className="h-4 w-4" />
                            Copy change_id
                          </button>
                        </div>

                        <div className="mt-auto pt-4 text-[10px] text-slate-500">
                          Amendment record • Immutable • ODP.AI
                        </div>
                      </>
                    )}
                  </div>

                  <div className="mt-4 rounded-3xl border border-white/10 bg-black/20 px-4 py-3 text-[11px] text-slate-400">
                    <div className="font-semibold text-slate-200">OS behavior</div>
                    <div className="mt-1 leading-relaxed text-slate-400">
                      CI-Amendments inherits the OS shell. Read-only list + modal inspector. No wiring changes.
                    </div>
                  </div>
                </section>
              </div>

              <div className="mt-5 flex items-center justify-between text-[10px] text-slate-600">
                <span>CI-Amendments · Oasis Digital Parliament</span>
                <span>ODP.AI · Governance Firmware</span>
              </div>
            </div>
          </div>

          {/* optional quick links row */}
          <div className="mt-4 flex flex-wrap gap-2">
            <Link
              href="/ci-votes"
              className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7"
            >
              CI-Votes
            </Link>
            <Link
              href="/ci-sentinel"
              className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7"
            >
              Sentinel
            </Link>
          </div>
        </div>
      </div>

      {/* MODAL: raw record inspector (read-only) */}
      {openModal && selected && (
        <div className="fixed inset-0 z-[80]">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setOpenModal(false)} />
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <div className="w-full max-w-[900px] rounded-3xl border border-white/10 bg-black/60 shadow-[0_40px_140px_rgba(0,0,0,0.65)] overflow-hidden">
              <div className="border-b border-white/10 bg-gradient-to-b from-white/[0.08] to-transparent px-5 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">Amendment record</div>
                    <div className="mt-1 text-lg font-semibold text-slate-50 truncate">
                      {selected.change_key || "—"}
                    </div>
                    <div className="mt-1 text-xs text-slate-400">
                      stage: <span className="text-slate-200">{String(selected.stage ?? "unknown")}</span> • scope:{" "}
                      <span className="text-slate-200">{selected.impact_scope || "—"}</span>
                    </div>
                  </div>

                  <button
                    onClick={() => setOpenModal(false)}
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
                      onClick={() => safeCopy(shortJson(selected))}
                      className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7 inline-flex items-center gap-2"
                    >
                      <Copy className="h-4 w-4" />
                      Copy JSON
                    </button>
                  </div>

                  <pre className="mt-3 max-h-[520px] overflow-auto rounded-2xl border border-white/10 bg-black/20 p-3 text-[11px] text-slate-200">
                    {shortJson(selected)}
                  </pre>

                  <div className="mt-3 text-[11px] text-slate-500">
                    Source: <span className="font-mono text-slate-200">v_schema_amendments</span>
                  </div>
                </div>
              </div>

              <div className="border-t border-white/10 bg-black/30 px-5 py-4 flex items-center justify-between gap-2">
                <div className="text-[11px] text-slate-500">CI-Amendments · Record modal</div>
                <button
                  onClick={() => setOpenModal(false)}
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
