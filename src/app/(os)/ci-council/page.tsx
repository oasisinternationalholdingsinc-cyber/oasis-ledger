"use client";
export const dynamic = "force-dynamic";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";

type QueueItem = {
  id: string;
  title: string | null;
  record_type: string | null;
  status: string | null;
  created_at: string | null;
  body: string | null;
};

type Decision = "approve" | "reject" | "return";

export default function CICouncilPage() {
  const router = useRouter();

  const [items, setItems] = useState<QueueItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const selected =
    items.find((i) => i.id === selectedId) ?? items[0] ?? null;

  // 🔐 Auth guard – redirect to /login if not signed in
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

  // 📥 Load queue from governance_ledger (only PENDING items)
  useEffect(() => {
    const loadQueue = async () => {
      setLoading(true);
      setError(null);
      setInfo(null);

      const { data, error } = await supabase
        .from("governance_ledger")
        .select("id, title, record_type, status, created_at, body")
        .eq("status", "PENDING")
        .order("created_at", { ascending: false });

      if (error) {
        console.error("CI-Council queue error:", error);
        setError("Unable to load council queue.");
        setItems([]);
        setSelectedId(null);
      } else {
        const rows = (data ?? []) as QueueItem[];
        setItems(rows);
        setSelectedId(rows[0]?.id ?? null);
      }

      setLoading(false);
    };

    loadQueue();
  }, []);

  const formattedCreatedAt = (iso: string | null) => {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  // 🧩 Decide DB status based on council decision
  const statusForDecision = (kind: Decision): string => {
    switch (kind) {
      case "approve":
        return "APPROVED";
      case "reject":
        return "REJECTED";
      case "return":
        // Back to drafting stage in the ledger
        return "DRAFTED";
      default:
        return "DRAFTED";
    }
  };

  // ✅ Decision handler – writes to governance_ledger (+ drafts on return)
  const handleDecision = async (kind: Decision) => {
    if (!selected || decisionBusy) return;

    setDecisionBusy(true);
    setError(null);
    setInfo(null);

    const newStatus = statusForDecision(kind);

    try {
      // 1) Update governance_ledger status
      const { error: updateError } = await supabase
        .from("governance_ledger")
        .update({ status: newStatus })
        .eq("id", selected.id);

      if (updateError) {
        console.error("CI-Council decision update error:", updateError);
        setError("Could not update ledger status. Please try again.");
        return;
      }

      // 2) If returning to CI-Alchemy, also "un-finalize" the draft
      if (kind === "return") {
        const { error: draftErr } = await supabase
          .from("governance_drafts")
          .update({
            status: "draft", // back to editable state in CI-Alchemy
            updated_at: new Date().toISOString(),
          })
          .eq("finalized_record_id", selected.id);

        if (draftErr) {
          // Not fatal for council, but good to log
          console.error(
            "CI-Council return → governance_drafts update error:",
            draftErr
          );
        }
      }

      // 3) Optimistic UI – remove from queue
      setItems((prev) => {
        const filtered = prev.filter((i) => i.id !== selected.id);
        const nextId = filtered[0]?.id ?? null;
        setSelectedId(nextId);
        return filtered;
      });

      if (kind === "approve") {
        setInfo("Resolution approved and released to CI-Forge.");
      } else if (kind === "reject") {
        setInfo("Resolution rejected and removed from the council queue.");
      } else {
        setInfo("Resolution returned to CI-Alchemy for further drafting.");
      }
    } catch (err: any) {
      console.error("CI-Council decision error:", err);
      setError("Unexpected error while applying council decision.");
    } finally {
      setDecisionBusy(false);
    }
  };

  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      {/* Header under OS bar */}
      <div className="mb-4 shrink-0">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">
          CI-COUNCIL
        </div>
        <p className="mt-1 text-[11px] text-slate-400">
          Cabinet Console •{" "}
          <span className="font-semibold text-slate-200">
            ODP.AI – Governance Operated
          </span>
        </p>
      </div>

      {/* Main Window – fixed frame inside workspace */}
      <div className="flex-1 min-h-0 flex justify-center overflow-hidden">
        <div className="w-full max-w-[1400px] h-full rounded-3xl border border-slate-900 bg-black/60 shadow-[0_0_60px_rgba(15,23,42,0.9)] px-6 py-5 flex flex-col overflow-hidden">
          {/* Window Title */}
          <div className="flex items-start justify-between mb-4 shrink-0">
            <div>
              <h1 className="text-lg font-semibold text-slate-50">
                Cabinet – Council Review Console
              </h1>
              <p className="mt-1 text-xs text-slate-400">
                <span className="font-semibold text-emerald-400">Left:</span>{" "}
                review resolutions queued from CI-Alchemy and the ledger.{" "}
                <span className="font-semibold text-sky-400">Right:</span>{" "}
                record the council decision and push approved records to
                CI-Forge.
              </p>
            </div>
            <div className="hidden md:flex items-center text-[10px] uppercase tracking-[0.3em] text-slate-500">
              CI-COUNCIL • LIVE
            </div>
          </div>

          {/* TWO-COLUMN LAYOUT (height + scroll locked) */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 flex-1 min-h-0">
            {/* LEFT – Queue & brief */}
            <section className="bg-slate-950/40 border border-slate-800 rounded-2xl p-4 flex flex-col min-h-0">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-semibold text-slate-200">
                  Review Queue
                </div>
                <div className="text-[10px] uppercase tracking-[0.25em] text-slate-500">
                  {items.length} items
                </div>
              </div>

              <div className="flex-1 min-h-0 grid grid-cols-[260px,minmax(0,1fr)] gap-4">
                {/* Queue list – only this scrolls */}
                <div className="queue-scroll flex-1 min-h-0 overflow-y-auto rounded-xl border border-slate-800/80 bg-slate-950/60">
                  {loading && (
                    <div className="p-3 text-[11px] text-slate-400">
                      Loading queue…
                    </div>
                  )}

                  {!loading && items.length === 0 && (
                    <div className="p-3 text-[11px] text-slate-400">
                      No resolutions waiting for council review.
                    </div>
                  )}

                  {!loading &&
                    items.map((item) => {
                      const active = item.id === selected?.id;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => setSelectedId(item.id)}
                          className={[
                            "w-full text-left px-3 py-3 border-b border-slate-800 last:border-b-0",
                            "transition",
                            active
                              ? "bg-slate-900/90 shadow-[0_0_0_1px_rgba(56,189,248,0.4)]"
                              : "hover:bg-slate-900/60",
                          ].join(" ")}
                        >
                          <div className="text-xs font-semibold text-slate-100 line-clamp-2">
                            {item.title || "Untitled resolution"}
                          </div>
                          <div className="mt-1 text-[11px] text-slate-400 flex items-center gap-2">
                            <span className="capitalize">
                              {item.record_type || "resolution"}
                            </span>
                            <span className="w-1 h-1 rounded-full bg-slate-600" />
                            <span className="text-slate-500">
                              {formattedCreatedAt(item.created_at)}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                </div>

                {/* Selected summary + full text */}
                <div className="flex flex-col rounded-xl border border-slate-800/80 bg-slate-950/60 px-4 py-3 min-h-0">
                  {selected ? (
                    <>
                      <div className="flex items-center justify-between mb-2">
                        <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">
                          Selected Draft
                        </div>
                        <span className="px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/40 text-[10px] uppercase tracking-[0.18em] text-amber-300">
                          {selected.status?.toUpperCase() || "PENDING REVIEW"}
                        </span>
                      </div>

                      <div className="text-sm font-semibold text-slate-100 mb-1">
                        {selected.title || "Untitled resolution"}
                      </div>

                      <div className="text-[11px] text-slate-400 mb-3 space-y-1">
                        <div>
                          Type:{" "}
                          <span className="capitalize text-slate-200">
                            {selected.record_type || "resolution"}
                          </span>
                        </div>
                        <div>
                          Created:{" "}
                          <span className="text-slate-300">
                            {formattedCreatedAt(selected.created_at)}
                          </span>
                        </div>
                      </div>

                      {/* Full resolution text viewer */}
                      <div className="flex-1 min-h-0 flex flex-col">
                        <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500 mb-1">
                          Resolution Text
                        </div>
                        <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/80 px-3 py-2 text-[11px] leading-relaxed">
                          {selected.body ? (
                            <pre className="whitespace-pre-wrap font-sans text-slate-200">
                              {selected.body}
                            </pre>
                          ) : (
                            <div className="text-slate-500">
                              No body text stored on this record. (Check
                              governance_ledger.body.)
                            </div>
                          )}
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="text-[11px] text-slate-400">
                      Select a draft from the queue to see its briefing and full
                      text here.
                    </div>
                  )}
                </div>
              </div>
            </section>

            {/* RIGHT – Decision panel */}
            <section className="border border-slate-800 rounded-2xl bg-slate-950/40 p-4 flex flex-col min-h-0">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h2 className="text-sm font-semibold text-slate-200">
                    Council Decision
                  </h2>
                  <p className="mt-1 text-[11px] text-slate-400 max-w-lg">
                    Decisions here update the{" "}
                    <span className="font-semibold text-emerald-400">
                      governance_ledger.status
                    </span>{" "}
                    for the selected record.{" "}
                    <span className="font-semibold text-sky-400">
                      APPROVED
                    </span>{" "}
                    items flow into CI-Forge as execution-ready records.
                  </p>
                </div>
                <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/40 text-[10px] uppercase tracking-[0.18em] text-emerald-300">
                  Ledger-Linked
                </span>
              </div>

              {/* Decision buttons */}
              <div className="flex flex-wrap items-center gap-3 mb-4">
                <button
                  type="button"
                  disabled={!selected || decisionBusy}
                  onClick={() => handleDecision("approve")}
                  className={`rounded-full px-4 py-1.5 text-[11px] font-semibold tracking-[0.18em] uppercase transition ${
                    !selected || decisionBusy
                      ? "bg-emerald-500/20 text-emerald-200/60 cursor-not-allowed"
                      : "bg-emerald-500 text-black hover:bg-emerald-400"
                  }`}
                >
                  Approve Resolution
                </button>

                <button
                  type="button"
                  disabled={!selected || decisionBusy}
                  onClick={() => handleDecision("reject")}
                  className={`rounded-full px-4 py-1.5 text-[11px] font-semibold tracking-[0.18em] uppercase transition ${
                    !selected || decisionBusy
                      ? "bg-rose-500/20 text-rose-200/60 cursor-not-allowed"
                      : "bg-rose-500 text-black hover:bg-rose-400"
                  }`}
                >
                  Reject Resolution
                </button>

                <button
                  type="button"
                  disabled={!selected || decisionBusy}
                  onClick={() => handleDecision("return")}
                  className={`rounded-full px-4 py-1.5 text-[11px] font-semibold tracking-[0.18em] uppercase transition ${
                    !selected || decisionBusy
                      ? "bg-sky-500/20 text-sky-200/60 cursor-not-allowed"
                      : "bg-sky-500 text-black hover:bg-sky-400"
                  }`}
                >
                  Return to CI-Alchemy
                </button>
              </div>

              {/* Council notes (local-only for now) */}
              <div className="flex-1 min-h-0 flex flex-col">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">
                    Council Notes
                  </div>
                <div className="text-[10px] text-slate-500">
                    (Will be saved to ledger in a later pass)
                  </div>
                </div>
                <textarea
                  className="flex-1 min-h-[140px] rounded-xl bg-slate-950/70 border border-slate-800 px-3 py-2 text-sm text-slate-100 resize-none"
                  placeholder="Summarize the reasoning, conditions, or concerns behind this decision..."
                />
              </div>

              {error && (
                <div className="mt-3 text-[11px] text-red-400 bg-red-950/40 border border-red-800/60 rounded-xl px-3 py-2">
                  {error}
                </div>
              )}

              {info && !error && (
                <div className="mt-3 text-[11px] text-emerald-300 bg-emerald-950/40 border border-emerald-700/60 rounded-xl px-3 py-2">
                  {info}
                </div>
              )}

              <div className="mt-3 flex items-center justify-between text-[10px] text-slate-500">
                <span>CI-Council · Oasis Digital Parliament Ledger</span>
                <span>ODP.AI · Cabinet Session</span>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
