"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";

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

export default function CIVotesPage() {
  const router = useRouter();

  const [votes, setVotes] = useState<VoteRow[]>([]);
  const [selected, setSelected] = useState<VoteRow | null>(null);
  const [loading, setLoading] = useState(true);

  // 🔐 Auth Guard
  useEffect(() => {
    const checkAuth = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) router.replace("/login");
    };
    checkAuth();
  }, [router]);

  // 📥 Load votes (view placeholder)
  useEffect(() => {
    const loadVotes = async () => {
      setLoading(true);

      // ⚠️ Replace later with v_schema_votes
      const { data } = await supabase
        .from("v_schema_votes")
        .select("*")
        .order("opened_at", { ascending: false });

      const rows = (data ?? []) as VoteRow[];
      setVotes(rows);
      setSelected(rows[0] ?? null);
      setLoading(false);
    };

    loadVotes();
  }, []);

  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      {/* Header */}
      <div className="mb-4 shrink-0">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">
          CI-VOTES
        </div>
        <p className="mt-1 text-[11px] text-slate-400">
          Democratic Record •{" "}
          <span className="font-semibold text-slate-200">
            Oasis Digital Parliament
          </span>
        </p>
      </div>

      {/* Main Workspace Frame */}
      <div className="flex-1 min-h-0 flex justify-center overflow-hidden">
        <div className="w-full max-w-[1500px] h-full rounded-3xl border border-slate-900 bg-black/60 shadow-[0_0_60px_rgba(15,23,42,0.9)] px-6 py-5 flex flex-col overflow-hidden">

          {/* Title & Filter Strip */}
          <div className="mb-4 shrink-0 space-y-4">
            <div>
              <h1 className="text-lg font-semibold text-slate-50">
                CI-Votes • Approvals & Rejections
              </h1>
              <p className="mt-1 text-xs text-slate-400">
                Official ledger of all recorded governance and schema votes.
              </p>
            </div>

            {/* Filters (visual only for now) */}
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              {["All", "Open", "Passed", "Failed", "Withdrawn"].map((s) => (
                <span
                  key={s}
                  className="px-3 py-1 rounded-full border border-slate-700 text-slate-300"
                >
                  {s}
                </span>
              ))}

              <span className="ml-2 px-3 py-1 rounded-full border border-slate-700 text-slate-300">
                Scope
              </span>

              <span className="px-3 py-1 rounded-full border border-amber-500/40 text-amber-300">
                Constitutional Only
              </span>

              <div className="ml-auto">
                <input
                  className="rounded-full bg-slate-950/70 border border-slate-800 px-4 py-1 text-xs text-slate-200"
                  placeholder="Search votes…"
                />
              </div>
            </div>
          </div>

          {/* Main Grid */}
          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,2fr),minmax(0,1fr)] gap-6 flex-1 min-h-0">

            {/* LEFT — Vote Table */}
            <section className="bg-slate-950/40 border border-slate-800 rounded-2xl overflow-hidden flex flex-col min-h-0">
              <div className="flex-1 min-h-0 overflow-y-auto">
                {loading && (
                  <div className="p-4 text-[11px] text-slate-400">
                    Loading votes…
                  </div>
                )}

                {!loading && votes.length === 0 && (
                  <div className="p-4 text-[11px] text-slate-400">
                    No votes found.
                  </div>
                )}

                {!loading &&
                  votes.map((v) => {
                    const active = selected?.id === v.id;
                    return (
                      <button
                        key={v.id}
                        onClick={() => setSelected(v)}
                        className={`w-full text-left px-4 py-3 border-b border-slate-800 transition ${
                          active
                            ? "bg-slate-900/90"
                            : "hover:bg-slate-900/60"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="text-xs font-semibold text-slate-100">
                              {v.subject}
                            </div>
                            <div className="text-[11px] text-slate-400">
                              {v.type} • {v.scope}
                            </div>
                          </div>

                          <div className="flex items-center gap-3 text-[11px]">
                            <span className="text-emerald-400">{v.yes_count}</span>
                            <span className="text-rose-400">{v.no_count}</span>
                            <span className="text-slate-400">
                              {v.abstain_count}
                            </span>

                            <span
                              className={`px-2 py-0.5 rounded-full text-[10px] ${
                                v.outcome === "passed"
                                  ? "bg-emerald-500/20 text-emerald-300"
                                  : v.outcome === "failed"
                                  ? "bg-rose-500/20 text-rose-300"
                                  : "bg-amber-500/20 text-amber-300"
                              }`}
                            >
                              {v.outcome.toUpperCase()}
                            </span>

                            {v.is_constitutional && (
                              <span className="px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-300 text-[10px]">
                                Constitutional
                              </span>
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })}
              </div>

              <div className="px-4 py-2 text-[10px] text-slate-500 border-t border-slate-800">
                Read-only view sourced from governed voting ledger.
              </div>
            </section>

            {/* RIGHT — Drawer */}
            <section className="border border-slate-800 rounded-2xl bg-slate-950/40 p-4 flex flex-col min-h-0">
              {!selected ? (
                <div className="text-[11px] text-slate-400">
                  Select a vote to inspect its full record.
                </div>
              ) : (
                <>
                  <div className="mb-4">
                    <h2 className="text-sm font-semibold text-slate-100">
                      {selected.subject}
                    </h2>
                    <p className="mt-1 text-[11px] text-slate-400">
                      {selected.type} • {selected.scope}
                    </p>
                  </div>

                  <div className="mb-4 space-y-1 text-[11px] text-slate-300">
                    <div>Yes: {selected.yes_count}</div>
                    <div>No: {selected.no_count}</div>
                    <div>Abstain: {selected.abstain_count}</div>
                    <div>Quorum: {selected.quorum_label}</div>
                  </div>

                  <div className="mt-auto text-[10px] text-slate-500">
                    Vote record • Immutable • ODP.AI
                  </div>
                </>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
