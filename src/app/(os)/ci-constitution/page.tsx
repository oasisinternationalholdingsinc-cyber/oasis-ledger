"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";

// Loosely typed on purpose so we don't blow up
// if columns evolve. We read what we can safely.
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

export default function CIConstitutionPage() {
  const router = useRouter();

  const [rows, setRows] = useState<ConstitutionalObject[]>([]);
  const [selected, setSelected] = useState<ConstitutionalObject | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 🔐 Auth guard
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

  // 📥 Load constitutional objects
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

  const nameOf = (row: ConstitutionalObject) =>
    row.object_name ?? row.name ?? "(unnamed)";

  const typeOf = (row: ConstitutionalObject) =>
    row.object_type ?? row.type ?? "—";

  const scopeOf = (row: ConstitutionalObject) =>
    row.scope ?? row.domain ?? "general";

  const descOf = (row: ConstitutionalObject) =>
    row.description ?? row.notes ?? "—";

  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      {/* Header under OS bar */}
      <div className="mb-4 shrink-0">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">
          CI-CONSTITUTION
        </div>
        <p className="mt-1 text-[11px] text-slate-400">
          Core Protected Objects •{" "}
          <span className="font-semibold text-slate-200">
            Oasis Digital Parliament
          </span>
        </p>
      </div>

      {/* Main workspace frame */}
      <div className="flex-1 min-h-0 flex justify-center overflow-hidden">
        <div className="w-full max-w-[1500px] h-full rounded-3xl border border-slate-900 bg-black/60 shadow-[0_0_60px_rgba(15,23,42,0.9)] px-6 py-5 flex flex-col overflow-hidden">
          {/* Title + context strip */}
          <div className="mb-4 shrink-0 flex flex-col gap-3">
            <div>
              <h1 className="text-lg font-semibold text-slate-50">
                CI-Constitution • Core Protected Objects
              </h1>
              <p className="mt-1 text-xs text-slate-400 max-w-2xl">
                Read-only catalogue of tables, views, triggers, and policies that
                have been designated as{" "}
                <span className="font-semibold text-emerald-300">
                  constitutional
                </span>{" "}
                and cannot be changed without a CI-Amendments + CI-Votes flow.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="px-3 py-1 rounded-full border border-slate-700 text-slate-300">
                All objects
              </span>
              <span className="px-3 py-1 rounded-full border border-slate-700 text-slate-300">
                Tables
              </span>
              <span className="px-3 py-1 rounded-full border border-slate-700 text-slate-300">
                Views
              </span>
              <span className="px-3 py-1 rounded-full border border-slate-700 text-slate-300">
                Triggers & policies
              </span>

              <span className="px-3 py-1 rounded-full border border-amber-500/40 text-amber-300">
                Constitutional only
              </span>

              <div className="ml-auto">
                <input
                  className="rounded-full bg-slate-950/70 border border-slate-800 px-4 py-1 text-xs text-slate-200"
                  placeholder="Search objects…"
                />
              </div>
            </div>
          </div>

          {/* Main grid: table + drawer */}
          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,2.1fr),minmax(0,1.1fr)] gap-6 flex-1 min-h-0">
            {/* LEFT – objects table */}
            <section className="bg-slate-950/40 border border-slate-800 rounded-2xl overflow-hidden flex flex-col min-h-0">
              <div className="flex-1 min-h-0 overflow-y-auto">
                {loading && (
                  <div className="p-4 text-[11px] text-slate-400">
                    Loading constitutional objects…
                  </div>
                )}

                {!loading && rows.length === 0 && (
                  <div className="p-4 text-[11px] text-slate-400">
                    No constitutional objects have been registered yet.
                  </div>
                )}

                {!loading &&
                  rows.map((row) => {
                    const key = (row.id as string) ?? nameOf(row);
                    const active = selected && selected === row;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setSelected(row)}
                        className={`w-full text-left px-4 py-3 border-b border-slate-800 transition ${
                          active
                            ? "bg-slate-900/90 shadow-[0_0_0_1px_rgba(56,189,248,0.35)]"
                            : "hover:bg-slate-900/60"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-4">
                          <div className="min-w-0">
                            <div className="text-xs font-semibold text-slate-100 truncate">
                              {nameOf(row)}
                            </div>
                            <div className="mt-0.5 text-[11px] text-slate-400 truncate">
                              {typeOf(row)} • {scopeOf(row)}
                            </div>
                          </div>

                          <div className="flex items-center gap-3 text-[10px]">
                            <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/40 text-emerald-200 uppercase tracking-[0.16em]">
                              Protected
                            </span>
                            {row.last_amended_change_key && (
                              <span className="hidden md:inline text-slate-400">
                                Last amendment:{" "}
                                <span className="text-slate-200">
                                  {row.last_amended_change_key}
                                </span>
                              </span>
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })}
              </div>

              <div className="px-4 py-2 text-[10px] text-slate-500 border-t border-slate-800">
                All entries originate from{" "}
                <span className="font-semibold text-slate-300">
                  constitutional_objects
                </span>{" "}
                and related schema change mappings. Changes require a governed
                amendment and vote.
              </div>
            </section>

            {/* RIGHT – detail drawer */}
            <section className="border border-slate-800 rounded-2xl bg-slate-950/40 p-4 flex flex-col min-h-0">
              {!selected ? (
                <div className="text-[11px] text-slate-400">
                  Select a constitutional object to inspect its protection
                  record.
                </div>
              ) : (
                <>
                  <div className="mb-3">
                    <div className="flex items-center justify-between gap-3">
                      <h2 className="text-sm font-semibold text-slate-100">
                        {nameOf(selected)}
                      </h2>
                      <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/40 text-[10px] uppercase tracking-[0.18em] text-emerald-200">
                        Constitutional
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-slate-400">
                      {typeOf(selected)} • {scopeOf(selected)}
                    </p>
                  </div>

                  <div className="mb-4 space-y-2 text-[11px] text-slate-300">
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
                        <span className="text-slate-500">
                          Last amendment key:{" "}
                        </span>
                        <span className="font-mono text-[10px] text-slate-200">
                          {selected.last_amended_change_key}
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="mt-auto text-[10px] text-slate-500">
                    CI-Constitution • Read-only view. To change this object, a
                    new schema amendment must be raised in CI-Amendments and
                    approved in CI-Votes.
                  </div>
                </>
              )}
            </section>
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-3 text-[11px] text-red-400 bg-red-950/40 border border-red-800/60 rounded-xl px-3 py-2">
          {error}
        </div>
      )}
    </div>
  );
}
