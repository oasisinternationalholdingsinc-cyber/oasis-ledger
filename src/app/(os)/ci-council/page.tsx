"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";

type CouncilStatus = "PENDING" | "APPROVED" | "REJECTED" | "ARCHIVED";
type StatusTab = "PENDING" | "APPROVED" | "REJECTED" | "ARCHIVED" | "ALL";

type LedgerRecord = {
  id: string;
  title: string | null;
  status: CouncilStatus | string | null;
  entity_id: string | null;
  is_test: boolean | null;
  created_at: string | null;

  // optional fields (safe)
  body?: string | null;
  record_type?: string | null;
  source?: string | null;
};

const ENTITY_LABELS: Record<string, string> = {
  holdings: "Oasis International Holdings Inc.",
  lounge: "Oasis International Lounge Inc.",
  "real-estate": "Oasis International Real Estate Inc.",
};

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function fmtShort(iso: string | null) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/**
 * Env resolver:
 * Priority:
 *  1) explicit oasis_os_env (your global toggle)
 *  2) fallback to common keys
 */
function resolveEnv(entityCtx: any): "ROT" | "SANDBOX" {
  const raw =
    (entityCtx?.oasis_os_env ??
      entityCtx?.activeEnv ??
      entityCtx?.environment ??
      entityCtx?.env ??
      entityCtx?.activeEnvironment ??
      "ROT") + "";
  const s = raw.toUpperCase();
  if (s.includes("SANDBOX") || s === "SBX") return "SANDBOX";
  return "ROT";
}

function isMissingColumnErr(err: any) {
  const msg = (err?.message ?? "").toLowerCase();
  return msg.includes("does not exist") && msg.includes("column");
}

export default function CICouncilPage() {
  const entityCtx = useEntity() as any;

  // CRITICAL: entity is ALWAYS corp entity (never "sandbox")
  const activeEntitySlug = (entityCtx?.activeEntity as string) || "holdings";
  const activeEntityId = (entityCtx?.activeEntityId as string) || null;

  const env = useMemo(() => resolveEnv(entityCtx), [entityCtx]);
  const isSandbox = env === "SANDBOX";
  const activeEntityLabel = useMemo(
    () => ENTITY_LABELS[activeEntitySlug] ?? activeEntitySlug,
    [activeEntitySlug]
  );

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | "approve" | "reject" | "archive">(null);

  const [tab, setTab] = useState<StatusTab>("PENDING");
  const [query, setQuery] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(true);

  const [records, setRecords] = useState<LedgerRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [readerOpen, setReaderOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const lastAutoPickRef = useRef<string | null>(null);

  function flashError(msg: string) {
    console.error(msg);
    setError(msg);
    setTimeout(() => setError(null), 6500);
  }
  function flashInfo(msg: string) {
    setInfo(msg);
    setTimeout(() => setInfo(null), 3500);
  }

  const selected = useMemo(
    () => records.find((r) => r.id === selectedId) ?? null,
    [records, selectedId]
  );

  // env filtering:
  // If DB returns is_test, filter strictly by it.
  const envFiltered = useMemo(() => {
    const hasEnv = records.some((r) => typeof r.is_test === "boolean");
    if (!hasEnv) return records;
    return records.filter((r) => (isSandbox ? r.is_test === true : r.is_test === false));
  }, [records, isSandbox]);

  const filtered = useMemo(() => {
    let list = envFiltered;

    if (tab !== "ALL") {
      list = list.filter((r) => (r.status ?? "").toUpperCase() === tab);
    }

    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter((r) => {
        const hay = `${r.title ?? ""}\n${r.body ?? ""}`.toLowerCase();
        return hay.includes(q);
      });
    }

    return list;
  }, [envFiltered, tab, query]);

  async function reload(preserveSelection = true) {
    setLoading(true);
    setError(null);

    try {
      if (!activeEntityId) {
        // If entityId isn’t in context, Council can’t scope correctly.
        // This prevents the “uuid undefined” bug chain.
        throw new Error(
          "Missing activeEntityId in OS context. Entity must resolve to a real entities.id (holdings/lounge/real-estate)."
        );
      }

      const tryWithIsTest = async () => {
        const { data, error } = await supabase
          .from("governance_ledger")
          .select("id,title,status,entity_id,is_test,created_at,body,record_type,source")
          .eq("entity_id", activeEntityId)
          .eq("is_test", isSandbox)
          .order("created_at", { ascending: false });

        if (error) throw error;
        return (data ?? []) as LedgerRecord[];
      };

      const tryWithoutIsTest = async () => {
        const { data, error } = await supabase
          .from("governance_ledger")
          .select("id,title,status,entity_id,created_at,body,record_type,source")
          .eq("entity_id", activeEntityId)
          .order("created_at", { ascending: false });

        if (error) throw error;
        return (data ?? []) as LedgerRecord[];
      };

      let rows: LedgerRecord[] = [];
      try {
        rows = await tryWithIsTest();
      } catch (e: any) {
        if (isMissingColumnErr(e)) rows = await tryWithoutIsTest();
        else rows = await tryWithoutIsTest();
      }

      setRecords(rows);

      // selection logic (avoid “undefined uuid” by always requiring a real selected record)
      if (preserveSelection && selectedId) {
        const still = rows.find((r) => r.id === selectedId);
        if (still) {
          setLoading(false);
          return;
        }
      }

      // auto-pick first row in current tab (stable)
      const tabKey = tab === "ALL" ? "ALL" : tab;
      const inTab =
        tabKey === "ALL" ? rows : rows.filter((r) => (r.status ?? "").toUpperCase() === tabKey);

      const pick = inTab[0] ?? rows[0] ?? null;
      if (pick) {
        // prevent re-picking same thing if user cleared selection
        if (lastAutoPickRef.current !== pick.id) {
          lastAutoPickRef.current = pick.id;
          setSelectedId(pick.id);
        }
      } else {
        setSelectedId(null);
      }
    } catch (err: any) {
      flashError(err?.message ?? "Failed to load Council records.");
    } finally {
      setLoading(false);
    }
  }

  // Re-scope when entity/env changes
  useEffect(() => {
    setTab("PENDING");
    setQuery("");
    setSelectedId(null);
    void reload(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEntityId, activeEntitySlug, env]);

  function handleSelect(rec: LedgerRecord) {
    if (!rec?.id) return;
    setSelectedId(rec.id);
    setError(null);
    setInfo(null);
  }

  async function updateStatus(next: CouncilStatus) {
    if (!selected?.id) {
      flashError("Select a record first.");
      return;
    }

    const current = (selected.status ?? "").toUpperCase();
    if (current === next) {
      flashInfo(`Already ${next}.`);
      return;
    }

    // gate actions
    if (next === "APPROVED") setBusy("approve");
    if (next === "REJECTED") setBusy("reject");
    if (next === "ARCHIVED") setBusy("archive");

    setError(null);
    setInfo(null);

    try {
      const { error } = await supabase
        .from("governance_ledger")
        .update({ status: next })
        .eq("id", selected.id);

      if (error) throw error;

      setRecords((prev) =>
        prev.map((r) => (r.id === selected.id ? { ...r, status: next } : r))
      );

      flashInfo(`Council: ${next}.`);
    } catch (err: any) {
      flashError(err?.message ?? `Failed to set status ${next}.`);
    } finally {
      setBusy(null);
      // keep list fresh
      void reload(true);
    }
  }

  // Council “Archive” button is intentionally disciplined:
  // By default, Council should NOT raw-archive unless you have the deterministic archive pipeline wired to a function.
  // If you later want direct-archive-from-council, replace this with your RPC (seal/render/hash/store).
  async function handleArchiveDiscipline() {
    flashError(
      "Council does not directly archive by default. Use Forge (signature path) or wire Council to the deterministic seal/archive function for direct-archive mode."
    );
  }

  const lanePill = cx(
    "font-semibold",
    isSandbox ? "text-amber-300" : "text-sky-300"
  );

  const canApprove = !!selected && (selected.status ?? "").toUpperCase() === "PENDING";
  const canReject = !!selected && (selected.status ?? "").toUpperCase() === "PENDING";

  const showNoEntityWarning = !activeEntityId;

  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      {/* Header under OS bar */}
      <div className="mb-4 shrink-0">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">
          CI • Council
        </div>
        <h1 className="mt-1 text-xl font-semibold text-slate-50">
          Council Review · Authority Console
        </h1>
        <p className="mt-1 text-xs text-slate-400 max-w-3xl">
          Council is the authority gate.{" "}
          <span className="text-emerald-300 font-semibold">Approve</span> or{" "}
          <span className="text-rose-300 font-semibold">Reject</span>. Execution/archival discipline occurs in Forge
          (signature) or in a direct-archive pipeline (if explicitly wired).
        </p>
        <div className="mt-2 text-xs text-slate-400">
          Entity:{" "}
          <span className="text-emerald-300 font-medium">
            {activeEntityLabel}
          </span>
          <span className="mx-2 text-slate-700">•</span>
          Lane: <span className={lanePill}>{env}</span>
        </div>

        {showNoEntityWarning && (
          <div className="mt-3 rounded-2xl border border-rose-500/50 bg-rose-500/10 px-4 py-3 text-[12px] text-rose-200">
            OS Context issue: <b>activeEntityId</b> is missing. Council must scope by <code>entities.id</code> +{" "}
            <code>is_test</code>. Fix OsEntityContext so the corp entity is always selected and env only flips{" "}
            <code>is_test</code>.
          </div>
        )}
      </div>

      {/* Main OS window frame (match Alchemy) */}
      <div className="flex-1 min-h-0 flex justify-center overflow-hidden">
        <div className="w-full max-w-[1500px] h-full rounded-3xl border border-slate-900 bg-black/60 shadow-[0_0_60px_rgba(15,23,42,0.9)] px-6 py-5 flex flex-col overflow-hidden">
          {/* Top strip: tabs + controls */}
          <div className="shrink-0 mb-4 flex items-center justify-between gap-4">
            <div className="inline-flex rounded-full bg-slate-950/70 border border-slate-800 p-1 overflow-hidden">
              <StatusTabButton
                label="Pending"
                value="PENDING"
                active={tab === "PENDING"}
                onClick={() => setTab("PENDING")}
              />
              <StatusTabButton
                label="Approved"
                value="APPROVED"
                active={tab === "APPROVED"}
                onClick={() => setTab("APPROVED")}
              />
              <StatusTabButton
                label="Rejected"
                value="REJECTED"
                active={tab === "REJECTED"}
                onClick={() => setTab("REJECTED")}
              />
              <StatusTabButton
                label="Archived"
                value="ARCHIVED"
                active={tab === "ARCHIVED"}
                onClick={() => setTab("ARCHIVED")}
              />
              <StatusTabButton
                label="All"
                value="ALL"
                active={tab === "ALL"}
                onClick={() => setTab("ALL")}
              />
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => setDrawerOpen((v) => !v)}
                className="rounded-full border border-slate-800 bg-slate-950/60 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60"
              >
                {drawerOpen ? "Hide Queue" : "Show Queue"}
              </button>

              <button
                onClick={() => setReaderOpen(true)}
                disabled={!selected}
                className="rounded-full border border-emerald-400/60 bg-emerald-500/10 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-emerald-200 hover:bg-emerald-500/15 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Open Reader
              </button>

              <button
                onClick={() => reload(true)}
                className="rounded-full border border-slate-800 bg-slate-950/60 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60"
              >
                Refresh
              </button>
            </div>
          </div>

          {/* Workspace body (NO page scroll) */}
          <div className="flex-1 min-h-0 flex gap-4 overflow-hidden">
            {/* Left queue drawer */}
            {drawerOpen && (
              <aside className="w-[360px] shrink-0 min-h-0 rounded-2xl border border-slate-800 bg-slate-950/40 flex flex-col overflow-hidden">
                <div className="shrink-0 p-4 border-b border-slate-800">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                      Queue · {filtered.length}/{envFiltered.length}{" "}
                      <span className="mx-2 text-slate-700">•</span>
                      <span className={lanePill}>{env}</span>
                    </div>
                  </div>

                  <input
                    className="mt-3 w-full rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-[13px] text-slate-100 outline-none focus:border-emerald-400"
                    placeholder="Search… title or body"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto">
                  {loading ? (
                    <div className="p-4 text-[13px] text-slate-400">Loading…</div>
                  ) : filtered.length === 0 ? (
                    <div className="p-4 text-[13px] text-slate-500">No records for this filter.</div>
                  ) : (
                    <ul className="divide-y divide-slate-800">
                      {filtered.map((r) => {
                        const st = (r.status ?? "").toUpperCase();
                        return (
                          <li
                            key={r.id}
                            onClick={() => handleSelect(r)}
                            className={cx(
                              "cursor-pointer px-4 py-3 transition hover:bg-slate-800/60",
                              r.id === selectedId && "bg-slate-800/80"
                            )}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-[13px] font-semibold text-slate-100">
                                  {r.title || "(untitled)"}
                                </div>
                                <div className="mt-1 text-[11px] text-slate-500">
                                  {fmtShort(r.created_at)} · {r.record_type || "resolution"}
                                </div>
                                <div className="mt-2 line-clamp-2 text-[12px] leading-relaxed text-slate-400">
                                  {r.body || "—"}
                                </div>
                              </div>

                              <span
                                className={cx(
                                  "shrink-0 rounded-full px-2 py-1 text-[9px] uppercase tracking-[0.18em]",
                                  st === "APPROVED"
                                    ? "bg-emerald-500/15 text-emerald-200"
                                    : st === "REJECTED"
                                    ? "bg-rose-500/15 text-rose-200"
                                    : st === "ARCHIVED"
                                    ? "bg-slate-700/40 text-slate-300"
                                    : "bg-sky-500/15 text-sky-200"
                                )}
                              >
                                {st || "—"}
                              </span>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </aside>
            )}

            {/* Center review surface */}
            <section className="flex-1 min-w-0 min-h-0 rounded-2xl border border-slate-800 bg-slate-950/40 flex flex-col overflow-hidden">
              <div className="shrink-0 px-5 py-4 border-b border-slate-800 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                    Review
                  </div>
                  <div className="mt-1 text-[13px] text-slate-400">
                    Entity:{" "}
                    <span className="text-emerald-300 font-semibold">{activeEntityLabel}</span>
                    <span className="mx-2 text-slate-700">•</span>
                    Lane: <span className={lanePill}>{env}</span>
                    {selected && (
                      <>
                        <span className="mx-2 text-slate-700">•</span>
                        <span className="text-slate-200">{(selected.status ?? "").toUpperCase()}</span>
                      </>
                    )}
                  </div>
                </div>

                {selected && (
                  <div className="shrink-0 flex items-center gap-2">
                    <button
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(selected.id);
                          flashInfo("Copied record id.");
                        } catch {
                          flashError("Copy failed.");
                        }
                      }}
                      className="rounded-full border border-slate-800 bg-slate-950/60 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60"
                    >
                      Copy ID
                    </button>

                    <Link
                      href="/ci-forge"
                      className="rounded-full border border-emerald-500/60 bg-black/40 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-emerald-200 hover:bg-emerald-500/10"
                      title="Signature execution happens in Forge"
                    >
                      Open Forge
                    </Link>

                    <Link
                      href="/ci-archive/ledger"
                      className="rounded-full border border-slate-700 bg-slate-950/40 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60"
                      title="Lifecycle registry in Archive"
                    >
                      Open Ledger Registry
                    </Link>
                  </div>
                )}
              </div>

              <div className="flex-1 min-h-0 overflow-hidden p-5">
                {!selected ? (
                  <div className="h-full w-full rounded-2xl border border-slate-800 bg-black/20 flex items-center justify-center text-slate-500">
                    Select a record for review.
                  </div>
                ) : (
                  <div className="h-full w-full rounded-2xl border border-slate-800 bg-black/30 overflow-hidden flex flex-col">
                    <div className="shrink-0 px-5 py-4 border-b border-slate-800">
                      <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
                        Record
                      </div>
                      <div className="mt-1 text-[15px] font-semibold text-slate-100 truncate">
                        {selected.title || "(untitled)"}
                      </div>
                      <div className="mt-1 text-[11px] text-slate-500">
                        {fmtShort(selected.created_at)} · {selected.record_type || "resolution"} ·{" "}
                        {(selected.status ?? "").toUpperCase()}
                      </div>
                    </div>

                    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
                      <div className="rounded-2xl border border-slate-800 bg-black/35 px-5 py-5">
                        <pre className="whitespace-pre-wrap font-sans text-[13px] leading-[1.8] text-slate-100">
                          {selected.body || "—"}
                        </pre>
                      </div>
                    </div>

                    <div className="shrink-0 px-5 py-4 border-t border-slate-800 text-[10px] text-slate-500 flex items-center justify-between">
                      <span>Review is non-mutating. Authority actions happen in the panel.</span>
                      <span>Oasis OS · Council Authority Gate</span>
                    </div>
                  </div>
                )}

                {(error || info) && (
                  <div className="mt-4 text-[13px]">
                    {error && (
                      <div className="rounded-2xl border border-red-500/60 bg-red-500/10 px-4 py-3 text-red-200">
                        {error}
                      </div>
                    )}
                    {info && !error && (
                      <div className="rounded-2xl border border-emerald-500/60 bg-emerald-500/10 px-4 py-3 text-emerald-200">
                        {info}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </section>

            {/* Right authority panel (PANEL, per your preference) */}
            <aside className="w-[360px] shrink-0 min-h-0 rounded-2xl border border-slate-800 bg-slate-950/40 flex flex-col overflow-hidden">
              <div className="shrink-0 px-5 py-4 border-b border-slate-800">
                <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                  Authority Panel
                </div>
                <div className="mt-1 text-[12px] text-slate-500">
                  No blocking advisories. Council remains the authority.
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto px-5 py-5 space-y-4">
                {/* AXIOM advisory shell (non-blocking) */}
                <div className="rounded-2xl border border-slate-800 bg-black/35 px-4 py-4">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-indigo-200">
                    AXIOM Advisory
                  </div>
                  <div className="mt-2 text-[12px] text-slate-400 leading-relaxed">
                    No blocking advisories. (Wire to your AXIOM views when ready.)
                    {selected ? " Record eligible for authority action." : " Select a record to evaluate."}
                  </div>
                </div>

                <button
                  onClick={() => updateStatus("APPROVED")}
                  disabled={!canApprove || !!busy}
                  className="w-full rounded-full bg-emerald-600 px-5 py-3 text-[12px] font-semibold tracking-[0.18em] uppercase text-black hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {busy === "approve" ? "Approving…" : "Approve"}
                </button>

                <button
                  onClick={() => updateStatus("REJECTED")}
                  disabled={!canReject || !!busy}
                  className="w-full rounded-full bg-rose-600 px-5 py-3 text-[12px] font-semibold tracking-[0.18em] uppercase text-black hover:bg-rose-500 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {busy === "reject" ? "Rejecting…" : "Reject"}
                </button>

                <div className="rounded-2xl border border-slate-800 bg-black/25 px-4 py-4">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-slate-300">
                    Execution & Archive
                  </div>
                  <div className="mt-2 text-[12px] text-slate-500 leading-relaxed">
                    Signature path executes in Forge. Direct-archive requires the deterministic seal pipeline (PDF→hash→verify).
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <Link
                      href="/ci-forge"
                      className="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-emerald-200 hover:bg-emerald-500/15"
                    >
                      Forge
                    </Link>
                    <button
                      onClick={handleArchiveDiscipline}
                      disabled
                      className="rounded-2xl border border-slate-700 bg-slate-950/40 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-400 opacity-60 cursor-not-allowed"
                      title="Direct archive must be wired to the deterministic seal/archive function"
                    >
                      Archive
                    </button>
                  </div>
                </div>
              </div>

              <div className="shrink-0 px-5 py-3 border-t border-slate-800 text-[10px] text-slate-500 flex items-center justify-between">
                <span>CI-Council · Authority gate (governance_ledger)</span>
                <span>Scoped by entity_id + is_test</span>
              </div>
            </aside>
          </div>
        </div>
      </div>

      {/* Reader Modal (matches Alchemy) */}
      {readerOpen && (
        <div className="fixed inset-0 z-[90] bg-black/70 px-6 py-6 flex items-center justify-center">
          <div className="w-full max-w-[980px] h-[85vh] rounded-3xl border border-slate-800 bg-slate-950/95 shadow-2xl shadow-black/70 overflow-hidden flex flex-col">
            <div className="shrink-0 px-5 py-4 border-b border-slate-800 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-[0.22em] text-slate-400">
                  Reader
                </div>
                <div className="mt-1 text-[15px] font-semibold text-slate-100 truncate">
                  {(selected?.title || "(untitled)") as string}
                </div>
                <div className="mt-1 text-[11px] text-slate-500">
                  {selected ? `${(selected.status ?? "").toUpperCase()} • ${fmtShort(selected.created_at)}` : "—"}
                  <span className="mx-2 text-slate-700">•</span>
                  <span className={lanePill}>{env}</span>
                </div>
              </div>

              <button
                onClick={() => setReaderOpen(false)}
                className="rounded-full border border-slate-700 bg-slate-900/60 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-800/60"
              >
                Close
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
              <div className="rounded-2xl border border-slate-800 bg-black/40 px-5 py-5">
                <pre className="whitespace-pre-wrap font-sans text-[13px] leading-[1.8] text-slate-100">
                  {selected?.body ?? "—"}
                </pre>
              </div>
            </div>

            <div className="shrink-0 px-5 py-4 border-t border-slate-800 flex items-center justify-between text-[10px] text-slate-500">
              <span>Reader is non-mutating. Authority actions remain in Council.</span>
              <span>Oasis OS · Evidence-Bound Governance</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusTabButton({
  label,
  value,
  active,
  onClick,
}: {
  label: string;
  value: StatusTab;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "px-4 py-2 rounded-full text-left transition min-w-[110px]",
        active
          ? "bg-emerald-500/15 border border-emerald-400/70 text-slate-50"
          : "bg-transparent border border-transparent hover:bg-slate-900/60 text-slate-300"
      )}
    >
      <div className="text-xs font-semibold">{label}</div>
      <div className="text-[10px] text-slate-400 uppercase tracking-[0.18em]">{value}</div>
    </button>
  );
}
