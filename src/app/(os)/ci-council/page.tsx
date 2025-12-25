"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";

/* =========================
   TYPES
========================= */
type CouncilTab = "pending" | "approved" | "rejected";
type ExecMode = "signature_required" | "direct_archive";

type CouncilRecord = {
  id: string;
  entity_id: string | null;
  entity_slug: string | null;
  title: string | null;
  body: string | null;
  record_type: string | null;
  status: string | null;
  created_at: string | null;

  draft_id?: string | null;
  envelope_id?: string | null;
  signer_url?: string | null;
  viewer_url?: string | null;
  verify_url?: string | null;
  certificate_url?: string | null;
};

/* =========================
   HELPERS
========================= */
function cx(...c: Array<string | false | null | undefined>) {
  return c.filter(Boolean).join(" ");
}

function fmtShort(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusPill(status: string | null) {
  const s = (status ?? "").toUpperCase();
  if (s === "PENDING") return "bg-amber-500/15 text-amber-200 border-amber-400/40";
  if (s === "APPROVED") return "bg-emerald-500/15 text-emerald-200 border-emerald-400/40";
  if (s === "REJECTED") return "bg-rose-500/15 text-rose-200 border-rose-400/40";
  if (s === "SIGNING") return "bg-sky-500/15 text-sky-200 border-sky-400/40";
  if (s === "SIGNED") return "bg-emerald-500/10 text-emerald-200 border-emerald-400/30";
  if (s === "ARCHIVED") return "bg-slate-700/30 text-slate-200 border-slate-500/30";
  return "bg-slate-800/40 text-slate-200 border-slate-600/40";
}

/* =========================
   COMPONENT
========================= */
export default function CICouncilPage() {
  const { activeEntity, activeEnv } = useEntity() as any;
  const isSandbox = activeEnv === "sandbox";

  const [records, setRecords] = useState<CouncilRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<CouncilTab>("pending");
  const [execMode, setExecMode] = useState<ExecMode>("signature_required");

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* =========================
     LOAD
  ========================= */
  async function load() {
    setLoading(true);
    setError(null);

    const view =
      activeEnv === "sandbox"
        ? "v_governance_ledger_scoped_v3_sandbox"
        : "v_governance_ledger_scoped_v3";

    const { data, error } = await supabase
      .from(view)
      .select("*")
      .eq("entity_slug", activeEntity)
      .order("created_at", { ascending: false });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    setRecords(data ?? []);
    setSelectedId(data?.[0]?.id ?? null);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, [activeEntity, activeEnv]);

  const selected = useMemo(
    () => records.find(r => r.id === selectedId) ?? null,
    [records, selectedId]
  );

  const filtered = useMemo(() => {
    const want =
      tab === "pending" ? "PENDING" :
      tab === "approved" ? "APPROVED" : "REJECTED";

    return records.filter(r => (r.status ?? "").toUpperCase() === want);
  }, [records, tab]);

  async function decide(next: "APPROVED" | "REJECTED") {
    if (!selected) return;
    setBusy(true);

    const { error } = await supabase
      .from("governance_ledger")
      .update({ status: next })
      .eq("id", selected.id);

    if (error) setError(error.message);
    await load();
    setBusy(false);
  }

  /* =========================
     RENDER
  ========================= */
  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      <h1 className="text-xl font-semibold text-slate-50">
        CI-Council · Authority Gate
      </h1>

      <div className="mt-2 text-xs text-slate-400">
        Entity: <span className="text-emerald-300">{activeEntity}</span> ·
        Env:{" "}
        <span className={isSandbox ? "text-sky-300" : "text-emerald-300"}>
          {isSandbox ? "SANDBOX" : "RoT"}
        </span>
      </div>

      <div className="mt-6 flex gap-4 flex-1 overflow-hidden">
        {/* Queue */}
        <div className="w-[35%] border border-slate-800 rounded-2xl overflow-y-auto">
          {loading && <div className="p-4 text-slate-400">Loading…</div>}
          {filtered.map(r => (
            <div
              key={r.id}
              onClick={() => setSelectedId(r.id)}
              className={cx(
                "p-4 cursor-pointer border-b border-slate-800",
                r.id === selectedId && "bg-slate-900/70"
              )}
            >
              <div className="text-sm font-semibold">{r.title}</div>
              <div className="text-xs text-slate-500">{fmtShort(r.created_at)}</div>
              <span className={cx("inline-block mt-2 px-2 py-1 text-[10px] border rounded-full", statusPill(r.status))}>
                {r.status}
              </span>
            </div>
          ))}
        </div>

        {/* Decision */}
        <div className="flex-1 border border-slate-800 rounded-2xl p-6">
          {selected ? (
            <>
              <h2 className="text-lg font-semibold">{selected.title}</h2>
              <pre className="mt-4 text-sm whitespace-pre-wrap">{selected.body}</pre>

              <div className="mt-6 flex gap-2">
                <button
                  disabled={busy}
                  onClick={() => decide("REJECTED")}
                  className="px-4 py-2 rounded-full border border-rose-400 text-rose-200"
                >
                  Reject
                </button>
                <button
                  disabled={busy}
                  onClick={() => decide("APPROVED")}
                  className="px-4 py-2 rounded-full bg-emerald-500 text-black"
                >
                  Approve
                </button>
              </div>
            </>
          ) : (
            <div className="text-slate-400">Select a record</div>
          )}
        </div>
      </div>

      {error && (
        <div className="mt-4 text-red-300 border border-red-500/40 rounded-xl p-3">
          {error}
        </div>
      )}
    </div>
  );
}
