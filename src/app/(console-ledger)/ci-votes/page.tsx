"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { ArrowLeft, Search, X, Copy, ShieldCheck, CheckCircle2 } from "lucide-react";

type VoteRow = {
  id: string;
  subject: string;
  scope: string;
  type: string;
  outcome: "passed" | "failed" | "open" | "withdrawn";
  yes_count: number;
  no_count: number;
  abstain_count: number;
  quorum_label: string;
  opened_at: string | null;
  closed_at: string | null;
  is_constitutional: boolean;
};

type Tab = "ALL" | "OPEN" | "PASSED" | "FAILED" | "WITHDRAWN";

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

function prettyJson(obj: any) {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

export default function CIVotesPage() {
  const router = useRouter();

  const [votes, setVotes] = useState<VoteRow[]>([]);
  const [selected, setSelected] = useState<VoteRow | null>(null);
  const [loading, setLoading] = useState(true);

  // UI-only filters (NO wiring changes)
  const [tab, setTab] = useState<Tab>("ALL");
  const [q, setQ] = useState("");
  const [constitutionalOnly, setConstitutionalOnly] = useState(false);

  // Modal (details)
  const [openModal, setOpenModal] = useState(false);

  // 🔐 Auth Guard (NO CHANGE)
  useEffect(() => {
    const checkAuth = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) router.replace("/login");
    };
    checkAuth();
  }, [router]);

  // 📥 Load votes (NO CHANGE)
  useEffect(() => {
    const loadVotes = async () => {
      setLoading(true);

      const { data } = await supabase.from("v_schema_votes").select("*").order("opened_at", { ascending: false });

      const rows = (data ?? []) as VoteRow[];
      setVotes(rows);
      setSelected(rows[0] ?? null);
      setLoading(false);
    };

    loadVotes();
  }, []);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();

    return votes.filter((v) => {
      if (tab !== "ALL" && v.outcome.toLowerCase() !== tab.toLowerCase()) return false;
      if (constitutionalOnly && !v.is_constitutional) return false;

      if (!qq) return true;
      const hay = `${v.subject} ${v.type} ${v.scope} ${v.outcome} ${v.quorum_label}`.toLowerCase();
      return hay.includes(qq);
    });
  }, [votes, tab, q, constitutionalOnly]);

  // OS shell/header/body pattern (MATCH Verified Registry)
  const shell =
    "rounded-3xl border border-white/10 bg-black/20 shadow-[0_28px_120px_rgba(0,0,0,0.55)] overflow-hidden";
  const header =
    "border-b border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent px-4 sm:px-6 py-4 sm:py-5";
  const body = "px-4 sm:px-6 py-5 sm:py-6";

  return (
    <>
      <div className="w-full">
        <div className="mx-auto w-full max-w-[1200px] px-4 pb-10 pt-4 sm:pt-6">
          <div className={shell}>
            {/* OS-aligned header */}
            <div className={header}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[10px] sm:text-xs tracking-[0.3em] uppercase text-slate-500">CI • Votes</div>
                  <h1 className="mt-1 text-lg sm:text-xl font-semibold text-slate-50">Approvals & Rejections</h1>
                  <p className="mt-1 max-w-3xl text-[11px] sm:text-xs text-slate-400 leading-relaxed">
                    Official record of governance and schema votes. Read-only. Immutable.
                  </p>

                  <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-400">
                    <span className="inline-flex items-center gap-2">
                      <ShieldCheck className="h-4 w-4 text-emerald-300" />
                      <span>Democratic record • No destructive actions</span>
                    </span>
                    <span className="text-slate-700">•</span>
                    <span>
                      Source:{" "}
                      <span className="font-mono text-[11px] text-slate-200">v_schema_votes</span>
                    </span>
                    <span className="text-slate-700">•</span>
                    <span>
                      Results: <span className="text-emerald-300 font-medium">{filtered.length}</span>
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
                        <div className="text-[11px] text-slate-500">View + search</div>
                      </div>
                      <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[10px] tracking-[0.18em] uppercase text-slate-200">
                        filters
                      </span>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      {(["ALL", "OPEN", "PASSED", "FAILED", "WITHDRAWN"] as Tab[]).map((t) => (
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

                    <div className="mt-3">
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
                        <div className="mt-1 text-[11px] text-slate-400">Filters to constitutional votes.</div>
                      </button>
                    </div>

                    <div className="mt-4">
                      <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">Search</div>
                      <div className="mt-2 relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                        <input
                          value={q}
                          onChange={(e) => setQ(e.target.value)}
                          placeholder="subject, scope, type..."
                          className="w-full rounded-2xl border border-white/10 bg-white/5 pl-10 pr-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-500 focus:border-amber-400/30"
                        />
                      </div>
                    </div>

                    <div className="mt-4 text-xs text-slate-400">{loading ? "Loading…" : `${filtered.length} result(s)`}</div>

                    <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 p-3 text-xs text-slate-400">
                      CI-Votes is read-only. Use Council/Forge/Archive to execute governance; this surface records outcomes.
                    </div>
                  </div>
                </section>

                {/* MIDDLE: Votes list */}
                <section className="col-span-12 lg:col-span-6">
                  <div className="rounded-3xl border border-white/10 bg-black/20 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-200">Votes</div>
                        <div className="text-[11px] text-slate-500">Select a record to inspect</div>
                      </div>
                      <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[10px] tracking-[0.18em] uppercase text-slate-200">
                        registry
                      </span>
                    </div>

                    <div className="mt-3 space-y-2">
                      {loading && (
                        <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-slate-400">
                          Loading votes…
                        </div>
                      )}

                      {!loading && filtered.length === 0 && (
                        <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-slate-400">
                          No votes found.
                        </div>
                      )}

                      {!loading &&
                        filtered.map((v) => {
                          const active = selected?.id === v.id;

                          const outcome = (v.outcome ?? "open").toLowerCase();
                          const outcomePill =
                            outcome === "passed"
                              ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100"
                              : outcome === "failed"
                              ? "border-rose-400/30 bg-rose-400/10 text-rose-100"
                              : outcome === "withdrawn"
                              ? "border-slate-500/30 bg-white/5 text-slate-300"
                              : "border-amber-400/30 bg-amber-400/10 text-amber-100";

                          return (
                            <button
                              key={v.id}
                              onClick={() => setSelected(v)}
                              className={cx(
                                "w-full text-left rounded-3xl border p-3 transition",
                                active ? "border-amber-400/25 bg-amber-400/5" : "border-white/10 bg-black/20 hover:bg-black/25"
                              )}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="text-sm font-medium text-slate-100 truncate">{v.subject}</div>
                                  <div className="mt-1 text-xs text-slate-400">
                                    {v.type} · {v.scope}
                                  </div>
                                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                                    <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1">
                                      <span className="text-emerald-300 font-semibold">{v.yes_count}</span>
                                      <span>yes</span>
                                    </span>
                                    <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1">
                                      <span className="text-rose-300 font-semibold">{v.no_count}</span>
                                      <span>no</span>
                                    </span>
                                    <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1">
                                      <span className="text-slate-200 font-semibold">{v.abstain_count}</span>
                                      <span>abstain</span>
                                    </span>
                                    {v.is_constitutional && (
                                      <span className="inline-flex items-center gap-2 rounded-full border border-yellow-400/20 bg-yellow-400/10 px-3 py-1 text-yellow-200">
                                        <CheckCircle2 className="h-4 w-4" />
                                        Constitutional
                                      </span>
                                    )}
                                  </div>
                                </div>

                                <div className="shrink-0 flex flex-col items-end gap-2">
                                  <span className={cx("rounded-full border px-2 py-1 text-[11px]", outcomePill)}>
                                    {String(v.outcome ?? "open").toUpperCase()}
                                  </span>

                                  <div className="text-[11px] text-slate-500 text-right">
                                    <div>Opened: {formatDate(v.opened_at)}</div>
                                    <div>Closed: {formatDate(v.closed_at)}</div>
                                  </div>
                                </div>
                              </div>
                            </button>
                          );
                        })}
                    </div>
                  </div>
                </section>

                {/* RIGHT: Details + actions */}
                <section className="col-span-12 lg:col-span-3">
                  <div className="rounded-3xl border border-white/10 bg-black/20 p-4 flex flex-col min-h-[240px]">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-200">Details</div>
                        <div className="text-[11px] text-slate-500">Selected vote record</div>
                      </div>
                      <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[10px] tracking-[0.18em] uppercase text-slate-200">
                        drawer
                      </span>
                    </div>

                    {!selected ? (
                      <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-slate-400">
                        Select a vote to inspect its full record.
                      </div>
                    ) : (
                      <>
                        <div className="mt-3">
                          <div className="text-sm font-semibold text-slate-100">{selected.subject}</div>
                          <div className="mt-1 text-[11px] text-slate-400">
                            {selected.type} · {selected.scope}
                          </div>
                        </div>

                        <div className="mt-3 space-y-1 text-[11px] text-slate-300">
                          <div>Yes: {selected.yes_count}</div>
                          <div>No: {selected.no_count}</div>
                          <div>Abstain: {selected.abstain_count}</div>
                          <div>Quorum: {selected.quorum_label}</div>
                          <div>Opened: {formatDate(selected.opened_at)}</div>
                          <div>Closed: {formatDate(selected.closed_at)}</div>
                        </div>

                        <div className="mt-4 flex flex-col gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setOpenModal(true);
                            }}
                            className="rounded-full border border-amber-400/20 bg-amber-400/10 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-amber-100 hover:bg-amber-400/15"
                          >
                            Open record →
                          </button>

                          <button
                            type="button"
                            onClick={() => safeCopy(selected.id)}
                            className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7 inline-flex items-center justify-center gap-2"
                          >
                            <Copy className="h-4 w-4" />
                            Copy ID
                          </button>
                        </div>

                        <div className="mt-auto pt-4 text-[10px] text-slate-500">
                          Vote record • Immutable • ODP.AI
                        </div>
                      </>
                    )}
                  </div>

                  <div className="mt-4 rounded-3xl border border-white/10 bg-black/20 px-4 py-3 text-[11px] text-slate-400">
                    <div className="font-semibold text-slate-200">OS behavior</div>
                    <div className="mt-1 leading-relaxed text-slate-400">
                      CI-Votes inherits the OS shell. Read-only list + modal inspector. No wiring changes.
                    </div>
                  </div>
                </section>
              </div>

              <div className="mt-5 flex items-center justify-between text-[10px] text-slate-600">
                <span>CI-Votes · Oasis Digital Parliament</span>
                <span>ODP.AI · Governance Firmware</span>
              </div>
            </div>
          </div>

          {/* optional quick links row */}
          <div className="mt-4 flex flex-wrap gap-2">
            <Link
              href="/ci-archive"
              className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7"
            >
              CI-Archive
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

      {/* DETAILS MODAL (copy-only inspector) */}
      {openModal && selected && (
        <div className="fixed inset-0 z-[80]">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setOpenModal(false)} />
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <div className="w-full max-w-[900px] rounded-3xl border border-white/10 bg-black/60 shadow-[0_40px_140px_rgba(0,0,0,0.65)] overflow-hidden">
              <div className="border-b border-white/10 bg-gradient-to-b from-white/[0.08] to-transparent px-5 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">Vote record</div>
                    <div className="mt-1 text-lg font-semibold text-slate-50 truncate">{selected.subject}</div>
                    <div className="mt-1 text-xs text-slate-400">
                      {selected.type} · {selected.scope} · outcome:{" "}
                      <span className="text-slate-200">{String(selected.outcome).toUpperCase()}</span>
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
                      onClick={() => safeCopy(prettyJson(selected))}
                      className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7 inline-flex items-center gap-2"
                    >
                      <Copy className="h-4 w-4" />
                      Copy JSON
                    </button>
                  </div>

                  <pre className="mt-3 max-h-[520px] overflow-auto rounded-2xl border border-white/10 bg-black/20 p-3 text-[11px] text-slate-200">
                    {prettyJson(selected)}
                  </pre>

                  <div className="mt-3 text-[11px] text-slate-500">
                    Source: <span className="font-mono text-slate-200">v_schema_votes</span>
                  </div>
                </div>
              </div>

              <div className="border-t border-white/10 bg-black/30 px-5 py-4 flex items-center justify-between gap-2">
                <div className="text-[11px] text-slate-500">CI-Votes · Record modal</div>
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
