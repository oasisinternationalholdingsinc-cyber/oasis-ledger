"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";

/* ================================
   Types
================================ */

type LedgerStatus = "PENDING" | "APPROVED" | "REJECTED" | "DEFERRED";
type ExecutionMode = "SIGNATURE_REQUIRED" | "DIRECT_ARCHIVE";

type LedgerRecord = {
  id: string;
  entity_id: string;
  title: string;
  body: string;
  status: LedgerStatus;
  is_test?: boolean | null;
  created_at: string;
};

function cx(...c: Array<string | false | undefined>) {
  return c.filter(Boolean).join(" ");
}

/* ================================
   Env resolver (shared with Alchemy)
================================ */

function resolveEnv(ctx: any): "ROT" | "SANDBOX" {
  const raw =
    (ctx?.oasis_os_env ??
      ctx?.activeEnv ??
      ctx?.environment ??
      ctx?.env ??
      "ROT") + "";
  return raw.toUpperCase().includes("SANDBOX") ? "SANDBOX" : "ROT";
}

/* ================================
   Page
================================ */

export default function CICouncilPage() {
  const entityCtx = useEntity() as any;
  const activeEntity = entityCtx?.activeEntity || "holdings";
  const env = useMemo(() => resolveEnv(entityCtx), [entityCtx]);
  const isSandbox = env === "SANDBOX";

  const [records, setRecords] = useState<LedgerRecord[]>([]);
  const [selected, setSelected] = useState<LedgerRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  /* ================================
     Load Council Queue
  ================================ */

  async function loadQueue() {
    setLoading(true);
    setError(null);

    const { data, error } = await supabase
      .from("governance_ledger")
      .select("id, entity_id, title, body, status, is_test, created_at")
      .eq("status", "PENDING")
      .eq("is_test", isSandbox)
      .order("created_at", { ascending: false });

    if (error) {
      setError(error.message);
    } else {
      setRecords(data || []);
      setSelected(data?.[0] ?? null);
    }

    setLoading(false);
  }

  useEffect(() => {
    loadQueue();
  }, [activeEntity, env]);

  /* ================================
     Council Decisions
  ================================ */

  async function decide(
    decision: LedgerStatus,
    mode?: ExecutionMode
  ) {
    if (!selected) return;
    setActing(true);
    setError(null);
    setInfo(null);

    const payload: any = {
      status: decision,
      council_decided_at: new Date().toISOString(),
    };

    if (decision === "APPROVED") {
      payload.execution_mode = mode;
    }

    const { error } = await supabase
      .from("governance_ledger")
      .update(payload)
      .eq("id", selected.id);

    if (error) {
      setError(error.message);
    } else {
      setInfo("Council decision recorded.");
      await loadQueue();
    }

    setActing(false);
  }

  /* ================================
     Render
  ================================ */

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
          Lane:{" "}
          <span className={cx(isSandbox ? "text-amber-300" : "text-sky-300")}>
            {env}
          </span>
        </div>
      </div>

      {/* Main Frame */}
      <div className="flex-1 min-h-0 flex justify-center">
        <div className="w-full max-w-[1500px] h-full rounded-3xl border border-slate-900 bg-black/60 px-6 py-5 flex gap-4">

          {/* Queue */}
          <aside className="w-[360px] rounded-2xl border border-slate-800 bg-slate-950/40 overflow-y-auto">
            {loading ? (
              <div className="p-4 text-slate-400">Loading…</div>
            ) : records.length === 0 ? (
              <div className="p-4 text-slate-500">No pending records.</div>
            ) : (
              <ul className="divide-y divide-slate-800">
                {records.map((r) => (
                  <li
                    key={r.id}
                    onClick={() => setSelected(r)}
                    className={cx(
                      "px-4 py-3 cursor-pointer hover:bg-slate-800/60",
                      selected?.id === r.id && "bg-slate-800/80"
                    )}
                  >
                    <div className="text-sm font-semibold text-slate-100 truncate">
                      {r.title}
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      Submitted {new Date(r.created_at).toLocaleString()}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          {/* Decision Panel */}
          <section className="flex-1 rounded-2xl border border-slate-800 bg-slate-950/40 flex flex-col">
            {selected ? (
              <>
                <div className="p-5 border-b border-slate-800">
                  <div className="text-sm font-semibold text-slate-100">
                    {selected.title}
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto p-5">
                  <pre className="whitespace-pre-wrap text-sm leading-relaxed text-slate-100">
                    {selected.body}
                  </pre>
                </div>

                {/* Council Actions */}
                <div className="p-5 border-t border-slate-800 flex flex-wrap gap-2">
                  <button
                    disabled={acting}
                    onClick={() =>
                      decide("APPROVED", "SIGNATURE_REQUIRED")
                    }
                    className="rounded-full bg-emerald-500 px-5 py-3 text-black font-semibold uppercase text-xs"
                  >
                    Approve → Signature
                  </button>

                  <button
                    disabled={acting}
                    onClick={() =>
                      decide("APPROVED", "DIRECT_ARCHIVE")
                    }
                    className="rounded-full border border-emerald-500/60 px-5 py-3 text-emerald-200 uppercase text-xs"
                  >
                    Approve → Direct Archive
                  </button>

                  <button
                    disabled={acting}
                    onClick={() => decide("DEFERRED")}
                    className="rounded-full border border-amber-500/60 px-5 py-3 text-amber-200 uppercase text-xs"
                  >
                    Defer
                  </button>

                  <button
                    disabled={acting}
                    onClick={() => decide("REJECTED")}
                    className="rounded-full border border-rose-500/60 px-5 py-3 text-rose-200 uppercase text-xs"
                  >
                    Reject
                  </button>
                </div>
              </>
            ) : (
              <div className="p-6 text-slate-500">
                Select a record for review.
              </div>
            )}
          </section>
        </div>
      </div>

      {/* Notices */}
      {(error || info) && (
        <div className="mt-4 text-sm">
          {error && (
            <div className="border border-red-500/60 bg-red-500/10 p-3 rounded-xl text-red-200">
              {error}
            </div>
          )}
          {info && (
            <div className="border border-emerald-500/60 bg-emerald-500/10 p-3 rounded-xl text-emerald-200">
              {info}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
