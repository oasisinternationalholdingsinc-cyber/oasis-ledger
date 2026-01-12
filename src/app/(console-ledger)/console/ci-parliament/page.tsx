"use client";
export const dynamic = "force-dynamic";

import { useState } from "react";
import { useRouter } from "next/navigation";

type TabKey = "council" | "amendments" | "votes" | "constitution";

export default function CIParliamentPage() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<TabKey>("council");

  const go = (path: string) => {
    router.push(path);
  };

  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      {/* Header under OS bar */}
      <div className="mb-4 shrink-0">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">
          Oasis Digital Parliament
        </div>
        <h1 className="mt-1 text-xl font-semibold text-slate-50">
          Parliament · Legislative &amp; Constitutional Authority
        </h1>
        <p className="mt-1 text-xs text-slate-400 max-w-3xl">
          Proposals, amendments, votes, and constitutional objects that define
          how the governance ledger is allowed to evolve.
        </p>
      </div>

      {/* Main window frame */}
      <div className="flex-1 min-h-0 flex justify-center overflow-hidden">
        <div className="w-full max-w-[1500px] h-full rounded-3xl border border-slate-900 bg-black/60 shadow-[0_0_60px_rgba(15,23,42,0.9)] px-6 py-5 flex flex-col overflow-hidden">
          {/* Top tabs row */}
          <div className="shrink-0 mb-4">
            <div className="inline-flex rounded-full bg-slate-950/70 border border-slate-800 p-1">
              <TabButton
                label="Council"
                description="Proposals & deliberation"
                active={activeTab === "council"}
                onClick={() => setActiveTab("council")}
              />
              <TabButton
                label="Amendments"
                description="Legislative timeline"
                active={activeTab === "amendments"}
                onClick={() => setActiveTab("amendments")}
              />
              <TabButton
                label="Votes"
                description="Approvals & rejections"
                active={activeTab === "votes"}
                onClick={() => setActiveTab("votes")}
              />
              <TabButton
                label="Constitution"
                description="Core protected objects"
                active={activeTab === "constitution"}
                onClick={() => setActiveTab("constitution")}
              />
            </div>
          </div>

          {/* Active tab content */}
          <div className="flex-1 min-h-0">
            {activeTab === "council" && (
              <section className="h-full rounded-2xl border border-slate-800 bg-slate-950/40 px-5 py-4 flex flex-col">
                <h2 className="text-sm font-semibold text-slate-100 mb-2">
                  Council · Proposals & Deliberation
                </h2>
                <p className="text-xs text-slate-400 max-w-2xl mb-4">
                  The Council console hosts drafted resolutions and governance
                  records awaiting debate, revision, or approval. It is where
                  CI-Alchemy drafts are reviewed before becoming active law in
                  the ledger.
                </p>

                <div className="mt-2 flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={() => go("/ci-council")}
                    className="rounded-full px-5 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase bg-emerald-500 text-black hover:bg-emerald-400 transition"
                  >
                    Open CI-Council Console
                  </button>
                  <span className="text-[11px] text-slate-500 self-center">
                    Live queue sourced from{" "}
                    <span className="font-semibold text-slate-300">
                      governance_ledger
                    </span>{" "}
                    (safe-mode decisions wired UI-only for now).
                  </span>
                </div>
              </section>
            )}

            {activeTab === "amendments" && (
              <section className="h-full rounded-2xl border border-slate-800 bg-slate-950/40 px-5 py-4 flex flex-col">
                <h2 className="text-sm font-semibold text-slate-100 mb-2">
                  Amendments · Schema Legislative Timeline
                </h2>
                <p className="text-xs text-slate-400 max-w-3xl mb-4">
                  Read-only record of every governed schema change: when it was
                  proposed, how it was classified, and when it became active law
                  in the ledger. Backed by{" "}
                  <span className="font-semibold text-slate-300">
                    schema_change_log
                  </span>{" "}
                  and constitutional mappings.
                </p>

                <div className="mt-2 flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={() => go("/ci-amendments")}
                    className="rounded-full px-5 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase bg-sky-500 text-black hover:bg-sky-400 transition"
                  >
                    Open CI-Amendments Timeline
                  </button>
                  <span className="text-[11px] text-slate-500 self-center">
                    Full filters, scopes, and constitutional-only view live in
                    the dedicated console.
                  </span>
                </div>
              </section>
            )}

            {activeTab === "votes" && (
              <section className="h-full rounded-2xl border border-slate-800 bg-slate-950/40 px-5 py-4 flex flex-col">
                <h2 className="text-sm font-semibold text-slate-100 mb-2">
                  Votes · Approvals & Rejections
                </h2>
                <p className="text-xs text-slate-400 max-w-3xl mb-4">
                  Official ledger of all recorded governance and schema votes:
                  who approved, who rejected, in what role, and when. This
                  console is the democratic record that backs every governed
                  change.
                </p>

                <div className="mt-2 flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={() => go("/ci-votes")}
                    className="rounded-full px-5 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase bg-fuchsia-500 text-black hover:bg-fuchsia-400 transition"
                  >
                    Open CI-Votes Record
                  </button>
                  <span className="text-[11px] text-slate-500 self-center">
                    Read-only UI wired to the governed voting ledger (open /
                    passed / failed / withdrawn / constitutional-only filters).
                  </span>
                </div>
              </section>
            )}

            {activeTab === "constitution" && (
              <section className="h-full rounded-2xl border border-slate-800 bg-slate-950/40 px-5 py-4 flex flex-col">
                <h2 className="text-sm font-semibold text-slate-100 mb-2">
                  Constitution · Core Protected Objects
                </h2>
                <p className="text-xs text-slate-400 max-w-3xl mb-4">
                  Catalogue of tables, views, triggers, and policies designated
                  as{" "}
                  <span className="font-semibold text-emerald-300">
                    constitutional
                  </span>
                  . These objects cannot be changed without a CI-Amendments
                  proposal and CI-Votes approval.
                </p>

                <div className="mt-2 flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={() => go("/ci-constitution")}
                    className="rounded-full px-5 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase bg-emerald-500 text-black hover:bg-emerald-400 transition"
                  >
                    Open CI-Constitution Catalogue
                  </button>
                  <span className="text-[11px] text-slate-500 self-center">
                    Backed by{" "}
                    <span className="font-semibold text-slate-300">
                      constitutional_objects
                    </span>{" "}
                    and related mapping to schema change log.
                  </span>
                </div>
              </section>
            )}
          </div>

          {/* Footer strip */}
          <div className="mt-4 text-[10px] text-slate-500 flex items-center justify-between">
            <span>Parliament Workspace · Oasis Digital Parliament</span>
            <span>Governance OS • Core legislative &amp; constitutional layer</span>
          </div>
        </div>
      </div>
    </div>
  );
}

type TabButtonProps = {
  label: string;
  description: string;
  active: boolean;
  onClick: () => void;
};

function TabButton({ label, description, active, onClick }: TabButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "px-4 py-2 rounded-full text-left transition min-w-[150px]",
        active
          ? "bg-emerald-500/15 border border-emerald-400/70 text-slate-50"
          : "bg-transparent border border-transparent hover:bg-slate-900/60 text-slate-300",
      ].join(" ")}
    >
      <div className="text-xs font-semibold">{label}</div>
      <div className="text-[10px] text-slate-400">{description}</div>
    </button>
  );
}
