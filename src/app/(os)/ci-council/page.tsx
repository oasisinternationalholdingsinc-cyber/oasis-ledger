"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";

/* ----------------------------- Types ----------------------------- */

type LedgerStatus = "PENDING" | "APPROVED" | "REJECTED" | "ARCHIVED";

type CouncilRecord = {
  id: string;
  entity_id: string;
  title: string;
  body: string;
  status: LedgerStatus;
  record_type: string;
  created_at: string;
  is_test?: boolean | null;
};

type CouncilTab = "pending" | "approved" | "rejected" | "archived";

/* ----------------------------- Helpers ----------------------------- */

function cx(...c: Array<string | false | null | undefined>) {
  return c.filter(Boolean).join(" ");
}

function fmt(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

/* ----------------------------- Page ----------------------------- */

export default function CICouncilPage() {
  const entityCtx = useEntity() as any;

  const activeEntity = (entityCtx?.activeEntity as string) || "holdings";
  const env = (entityCtx?.oasis_os_env ?? "ROT").toUpperCase();
  const isSandbox = env === "SANDBOX";

  const [records, setRecords] = useState<CouncilRecord[]>([]);
  const [selected, setSelected] = useState<CouncilRecord | null>(null);
  const [tab, setTab] = useState<CouncilTab>("pending");
  const [loading, setLoading] = useState(true);

  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  /* ----------------------------- Load ----------------------------- */

  async function load() {
    setLoading(true);
    setError(null);

    const { data, error } = await supabase
      .from("governance_ledger")
      .select("id, entity_id, title, body, status, record_type, created_at, is_test")
      .eq("entity_id", entityCtx.activeEntityId)
      .eq("is_test", isSandbox)
      .order("created_at", { ascending: false });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    setRecords((data ?? []) as CouncilRecord[]);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEntity, env]);

  /* ----------------------------- Filters ----------------------------- */

  const filtered = useMemo(() => {
    return records.filter((r) => {
      if (tab === "pending") return r.status === "PENDING";
      if (tab === "approved") return r.status === "APPROVED";
      if (tab === "rejected") return r.status === "REJECTED";
      if (tab === "archived") return r.status === "ARCHIVED";
      return true;
    });
  }, [records, tab]);

  /* ----------------------------- Actions ----------------------------- */

  async function updateStatus(next: LedgerStatus) {
    if (!selected) return;
    setActionBusy(true);
    setError(null);
    setInfo(null);

    const { error } = await supabase
      .from("governance_ledger")
      .update({ status: next })
      .eq("id", selected.id);

    if (error) {
      setError(error.message);
    } else {
      setInfo(`Record ${next}`);
      await load();
      setSelected(null);
    }

    setActionBusy(false);
  }

  /* ----------------------------- Render ----------------------------- */

  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      {/* Header */}
      <div className="mb-4">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">
          CI • Council
        </div>
        <h1 className="mt-1 text-xl font-semibold text-slate-50">
          Council Review · Authority Console
        </h1>
        <div className="mt-2 text-xs text-slate-400">
          Entity <span className="text-emerald-300">{activeEntity}</span> • Lane{" "}
          <span className={cx(isSandbox ? "text-amber-300" : "text-sky-300")}>
            {env}
          </span>
        </div>
      </div>

      {/* OS Frame */}
      <div className="flex-1 min-h-0 flex justify-center overflow-hidden">
        <div className="w-full max-w-[1500px] h-full rounded-3xl border border-slate-900 bg-black/60 shadow-[0_0_60px_rgba(15,23,42,0.9)] px-6 py-5 flex flex-col overflow-hidden">
          {/* Tabs */}
          <div className="mb-4 flex gap-2">
            {(["pending", "approved", "rejected", "archived"] as CouncilTab[]).map(
              (t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={cx(
                    "rounded-full px-4 py-2 text-xs uppercase tracking-[0.18em] border",
                    tab === t
                      ? "border-emerald-400/60 bg-emerald-500/15 text-slate-50"
                      : "border-slate-800 text-slate-400 hover:bg-slate-900/60"
                  )}
                >
                  {t}
                </button>
              )
            )}
          </div>

          {/* Body */}
          <div className="flex-1 min-h-0 flex gap-4 overflow-hidden">
            {/* Registry */}
            <aside className="w-[340px] rounded-2xl border border-slate-800 bg-slate-950/40 overflow-y-auto">
              {loading ? (
                <div className="p-4 text-slate-400">Loading…</div>
              ) : filtered.length === 0 ? (
                <div className="p-4 text-slate-500">No records.</div>
              ) : (
                <ul className="divide-y divide-slate-800">
                  {filtered.map((r) => (
                    <li
                      key={r.id}
                      onClick={() => setSelected(r)}
                      className={cx(
                        "cursor-pointer px-4 py-3 hover:bg-slate-800/60",
                        selected?.id === r.id && "bg-slate-800/80"
                      )}
                    >
                      <div className="text-sm font-semibold text-slate-100 truncate">
                        {r.title}
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        {fmt(r.created_at)}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </aside>

            {/* Reader */}
            <section className="flex-1 rounded-2xl border border-slate-800 bg-slate-950/40 flex flex-col overflow-hidden">
              {!selected ? (
                <div className="flex-1 flex items-center justify-center text-slate-500">
                  Select a record for review.
                </div>
              ) : (
                <>
                  <div className="px-5 py-4 border-b border-slate-800">
                    <div className="text-sm font-semibold text-slate-100">
                      {selected.title}
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      Status: {selected.status}
                    </div>
                  </div>
                  <div className="flex-1 overflow-y-auto px-5 py-4">
                    <pre className="whitespace-pre-wrap text-sm leading-[1.8] text-slate-100">
                      {selected.body}
                    </pre>
                  </div>
                </>
              )}
            </section>

            {/* Authority Panel */}
            <aside className="w-[360px] rounded-2xl border border-slate-800 bg-slate-950/40 flex flex-col overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-800">
                <div className="text-xs uppercase tracking-[0.22em] text-slate-400">
                  Authority Panel
                </div>
              </div>

              <div className="flex-1 px-5 py-4 space-y-4">
                {/* AXIOM Placeholder */}
                <div className="rounded-2xl border border-indigo-500/40 bg-indigo-500/10 px-4 py-3">
                  <div className="text-xs uppercase tracking-[0.2em] text-indigo-300">
                    AXIOM Advisory
                  </div>
                  <div className="mt-1 text-xs text-slate-300">
                    No blocking advisories. Record eligible for action.
                  </div>
                </div>

                <button
                  disabled={!selected || actionBusy}
                  onClick={() => updateStatus("APPROVED")}
                  className="w-full rounded-full bg-emerald-500 px-4 py-3 text-sm font-semibold text-black hover:bg-emerald-400 disabled:opacity-50"
                >
                  Approve
                </button>

                <button
                  disabled={!selected || actionBusy}
                  onClick={() => updateStatus("REJECTED")}
                  className="w-full rounded-full bg-rose-500 px-4 py-3 text-sm font-semibold text-black hover:bg-rose-400 disabled:opacity-50"
                >
                  Reject
                </button>

                <button
                  disabled={!selected || actionBusy}
                  onClick={() => updateStatus("ARCHIVED")}
                  className="w-full rounded-full border border-slate-700 px-4 py-3 text-sm text-slate-200 hover:bg-slate-800/60 disabled:opacity-50"
                >
                  Archive
                </button>
              </div>

              {(error || info) && (
                <div className="px-5 py-3 border-t border-slate-800 text-xs">
                  {error && <div className="text-rose-300">{error}</div>}
                  {info && <div className="text-emerald-300">{info}</div>}
                </div>
              )}
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}
