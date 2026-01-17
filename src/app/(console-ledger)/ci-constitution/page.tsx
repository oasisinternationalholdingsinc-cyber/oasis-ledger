"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { ArrowLeft, Search, ShieldCheck, CheckCircle2, X, Copy } from "lucide-react";

// Loosely typed on purpose so we don't blow up if columns evolve.
// We read what we can safely.
type ConstitutionalObject = {
  id?: string;
  object_name?: string;
  object_type?: string;
  scope?: string | null;
  notes?: string | null;
  description?: string | null;
  created_at?: string | null;
  last_amended_change_key?: string | null;
  last_amended_at?: string | null;
  [key: string]: any;
};

function cx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function safeCopy(text: string) {
  try {
    navigator.clipboard?.writeText(text);
  } catch {}
}

export default function CIConstitutionPage() {
  const router = useRouter();

  const [rows, setRows] = useState<ConstitutionalObject[]>([]);
  const [selected, setSelected] = useState<ConstitutionalObject | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // UI-only (no wiring changes)
  const [tab, setTab] = useState<"ALL" | "TABLE" | "VIEW" | "POLICY">("ALL");
  const [q, setQ] = useState("");
  const [openModal, setOpenModal] = useState(false);

  // 🔐 Auth guard (NO CHANGE)
  useEffect(() => {
    const checkAuth = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        router.replace("/login");
      }
    };

    checkAuth();
  }, [router]);

  // 📥 Load constitutional objects (NO CHANGE)
  useEffect(() => {
    const loadObjects = async () => {
      setLoading(true);
      setError(null);

      // For now we hit the base table directly.
      // Later we can swap this to v_constitutional_objects
      const { data, error } = await supabase
        .from("constitutional_objects")
        .select("*")
        .order("object_name", { ascending: true });

      if (error) {
        console.error("CI-Constitution load error:", error);
        setError("Unable to load constitutional objects.");
        setRows([]);
        setSelected(null);
      } else {
        const list = (data ?? []) as ConstitutionalObject[];
        setRows(list);
        setSelected(list[0] ?? null);
      }

      setLoading(false);
    };

    loadObjects();
  }, []);

  const fmt = (iso?: string | null) => {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  const nameOf = (row: ConstitutionalObject) => row.object_name ?? row.name ?? "(unnamed)";
  const typeOf = (row: ConstitutionalObject) => row.object_type ?? row.type ?? "—";
  const scopeOf = (row: ConstitutionalObject) => row.scope ?? row.domain ?? "general";
  const descOf = (row: ConstitutionalObject) => row.description ?? row.notes ?? "—";

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();

    return rows.filter((r) => {
      const t = String(typeOf(r) ?? "").toLowerCase();

      if (tab === "TABLE" && !t.includes("table")) return false;
      if (tab === "VIEW" && !t.includes("view")) return false;

      // Keep this loose so we don’t break if your DB uses different labels
      if (tab === "POLICY") {
        const looksPolicy =
          t.includes("policy") ||
          t.includes("trigger") ||
          t.includes("rls") ||
          t.includes("function") ||
          t.includes("constraint");
        if (!looksPolicy) return false;
      }

      if (!qq) return true;

      const hay = [
        nameOf(r),
        typeOf(r),
        scopeOf(r),
        descOf(r),
        r.last_amended_change_key,
        r.object_type,
        r.object_name,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return hay.includes(qq);
    });
  }, [rows, tab, q]);

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
                  <div className="text-[10px] sm:text-xs tracking-[0.3em] uppercase text-slate-500">
                    CI • Constitution
                  </div>
                  <h1 className="mt-1 text-lg sm:text-xl font-semibold text-slate-50">
                    Core Protected Objects
                  </h1>
                  <p className="mt-1 max-w-3xl text-[11px] sm:text-xs text-slate-400 leading-relaxed">
                    Read-only catalogue of tables, views, triggers, and policies designated as constitutional.
                    Changes require CI-Amendments + CI-Votes.
                  </p>

                  <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-400">
                    <span className="inline-flex items-center gap-2">
                      <ShieldCheck className="h-4 w-4 text-emerald-300" />
                      <span>Protected registry • No destructive actions</span>
                    </span>
                    <span className="text-slate-700">•</span>
                    <span>
                      Source:{" "}
                      <span className="font-mono text-[11px] text-slate-200">constitutional_objects</span>
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
                        <div className="text-[11px] text-slate-500">Type + search</div>
                      </div>
                      <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[10px] tracking-[0.18em] uppercase text-slate-200">
                        filters
                      </span>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      {(["ALL", "TABLE", "VIEW", "POLICY"] as const).map((t) => (
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
                          placeholder="name, type, scope…"
                          className="w-full rounded-2xl border border-white/10 bg-white/5 pl-10 pr-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-500 focus:border-amber-400/30"
                        />
                      </div>
                    </div>

                    <div className="mt-4 text-xs text-slate-400">
                      {loading ? "Loading…" : `${filtered.length} result(s)`}
                    </div>

                    <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 p-3 text-xs text-slate-400">
                      Protected objects cannot be changed without a governed amendment and recorded vote.
                    </div>
                  </div>
                </section>

                {/* MIDDLE: Objects */}
                <section className="col-span-12 lg:col-span-6">
                  <div className="rounded-3xl border border-white/10 bg-black/20 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-200">Objects</div>
                        <div className="text-[11px] text-slate-500">Constitutional registry</div>
                      </div>
                      <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[10px] tracking-[0.18em] uppercase text-slate-200">
                        registry
                      </span>
                    </div>

                    <div className="mt-3 space-y-2">
                      {loading ? (
                        <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-slate-400">
                          Loading constitutional objects…
                        </div>
                      ) : error ? (
                        <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 p-4 text-sm text-rose-200">
                          {error}
                          <div className="mt-1 text-[11px] text-slate-300">
                            Check table{" "}
                            <span className="font-mono text-[11px] text-slate-200">constitutional_objects</span>.
                          </div>
                        </div>
                      ) : filtered.length === 0 ? (
                        <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-slate-400">
                          No objects match this view.
                          <div className="mt-1 text-[11px] text-slate-500">Try clearing filters or search.</div>
                        </div>
                      ) : (
                        filtered.map((row) => {
                          const key = (row.id as string) ?? nameOf(row);
                          const active = !!selected && selected === row;

                          return (
                            <button
                              key={key}
                              type="button"
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
                                  <div className="text-sm font-medium text-slate-100 truncate">{nameOf(row)}</div>
                                  <div className="mt-1 text-xs text-slate-400 truncate">
                                    {typeOf(row)} • {scopeOf(row)}
                                  </div>
                                  <div className="mt-2 text-[11px] text-slate-500 line-clamp-2">{descOf(row)}</div>

                                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                                    <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1">
                                      <CheckCircle2 className="h-4 w-4 text-emerald-300" />
                                      <span className="text-slate-200">PROTECTED</span>
                                    </span>

                                    {row.last_amended_change_key && (
                                      <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1">
                                        <span className="text-slate-500">last:</span>
                                        <span className="font-mono text-[11px] text-slate-200">
                                          {row.last_amended_change_key}
                                        </span>
                                      </span>
                                    )}
                                  </div>
                                </div>

                                <div className="shrink-0 text-right text-[11px] text-slate-500">
                                  <div>Registered: {fmt(row.created_at)}</div>
                                  <div>Amended: {fmt(row.last_amended_at)}</div>
                                </div>
                              </div>
                            </button>
                          );
                        })
                      )}
                    </div>

                    <div className="mt-4 text-[11px] text-slate-500">
                      Read-only. To change an object, raise a new amendment in CI-Amendments and approve in CI-Votes.
                    </div>
                  </div>
                </section>

                {/* RIGHT: Inspector */}
                <section className="col-span-12 lg:col-span-3">
                  <div className="rounded-3xl border border-white/10 bg-black/20 p-4 flex flex-col min-h-[240px]">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-200">Inspector</div>
                        <div className="text-[11px] text-slate-500">Selected object</div>
                      </div>
                      <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[10px] tracking-[0.18em] uppercase text-slate-200">
                        drawer
                      </span>
                    </div>

                    {!selected ? (
                      <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-slate-400">
                        Select a constitutional object to inspect its protection record.
                      </div>
                    ) : (
                      <>
                        <div className="mt-3">
                          <div className="text-sm font-semibold text-slate-100">{nameOf(selected)}</div>
                          <div className="mt-1 text-xs text-slate-400">
                            {typeOf(selected)} • {scopeOf(selected)}
                          </div>
                        </div>

                        <div className="mt-3 space-y-2 text-[11px] text-slate-300">
                          <div>
                            <span className="text-slate-500">Description: </span>
                            <span>{descOf(selected)}</span>
                          </div>

                          <div>
                            <span className="text-slate-500">Registered: </span>
                            <span>{fmt(selected.created_at)}</span>
                          </div>

                          <div>
                            <span className="text-slate-500">Last amended: </span>
                            <span>{fmt(selected.last_amended_at)}</span>
                          </div>

                          {selected.last_amended_change_key && (
                            <div>
                              <span className="text-slate-500">Last amendment key: </span>
                              <span className="font-mono text-[10px] text-slate-200">
                                {selected.last_amended_change_key}
                              </span>
                            </div>
                          )}
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
                            onClick={() => safeCopy(String(selected.id ?? ""))}
                            className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7 inline-flex items-center justify-center gap-2"
                          >
                            <Copy className="h-4 w-4" />
                            Copy id
                          </button>
                        </div>

                        <div className="mt-auto pt-4 text-[10px] text-slate-500">
                          CI-Constitution • Immutable • ODP.AI
                        </div>
                      </>
                    )}
                  </div>

                  <div className="mt-4 rounded-3xl border border-white/10 bg-black/20 px-4 py-3 text-[11px] text-slate-400">
                    <div className="font-semibold text-slate-200">OS behavior</div>
                    <div className="mt-1 leading-relaxed text-slate-400">
                      CI-Constitution inherits the OS shell. Read-only list + modal inspector. No wiring changes.
                    </div>
                  </div>
                </section>
              </div>

              <div className="mt-5 flex items-center justify-between text-[10px] text-slate-600">
                <span>CI-Constitution · Oasis Digital Parliament</span>
                <span>ODP.AI · Governance Firmware</span>
              </div>
            </div>
          </div>

          {/* optional quick links row */}
          <div className="mt-4 flex flex-wrap gap-2">
            <Link
              href="/ci-amendments"
              className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7"
            >
              CI-Amendments
            </Link>
            <Link
              href="/ci-votes"
              className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7"
            >
              CI-Votes
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
                    <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">Constitutional object</div>
                    <div className="mt-1 text-lg font-semibold text-slate-50 truncate">{nameOf(selected)}</div>
                    <div className="mt-1 text-xs text-slate-400">
                      type: <span className="text-slate-200">{typeOf(selected)}</span> • scope:{" "}
                      <span className="text-slate-200">{scopeOf(selected)}</span>
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
                      onClick={() => safeCopy(JSON.stringify(selected, null, 2))}
                      className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7 inline-flex items-center gap-2"
                    >
                      <Copy className="h-4 w-4" />
                      Copy JSON
                    </button>
                  </div>

                  <pre className="mt-3 max-h-[520px] overflow-auto rounded-2xl border border-white/10 bg-black/20 p-3 text-[11px] text-slate-200">
                    {JSON.stringify(selected, null, 2)}
                  </pre>

                  <div className="mt-3 text-[11px] text-slate-500">
                    Source: <span className="font-mono text-slate-200">constitutional_objects</span>
                  </div>
                </div>
              </div>

              <div className="border-t border-white/10 bg-black/30 px-5 py-4 flex items-center justify-between gap-2">
                <div className="text-[11px] text-slate-500">CI-Constitution · Record modal</div>
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
