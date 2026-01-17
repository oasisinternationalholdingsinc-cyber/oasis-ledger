// src/app/(console-ledger)/ci-archive/ledger/ledger.client.tsx
"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  RefreshCcw,
  ShieldCheck,
  Search,
  Hammer,
  Archive as ArchiveIcon,
  Shield,
  Trash2,
  FileCheck2,
} from "lucide-react";

type LedgerStatus =
  | "drafted"
  | "pending"
  | "approved"
  | "signing"
  | "signed"
  | "archived"
  | "rejected"
  | string;

type TabKey =
  | "ALL"
  | "DRAFTED"
  | "PENDING"
  | "APPROVED"
  | "SIGNING"
  | "SIGNED"
  | "ARCHIVED";

type LedgerRecord = {
  id: string;

  entity_id: string | null;
  entity_key?: string | null;

  title: string | null;
  description?: string | null;

  record_type?: string | null;
  record_no?: string | null;

  status: LedgerStatus | null;
  approved?: boolean | null;
  archived?: boolean | null;

  created_at: string | null;

  // from v_governance_ledger_scoped_v3
  draft_id?: string | null;
  envelope_id?: string | null;
  signer_url?: string | null;
  viewer_url?: string | null;
  verify_url?: string | null;
  certificate_url?: string | null;

  // derived (for lane-safe filtering)
  lane_is_test?: boolean | null;
};

function cx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function formatDate(d: string | null) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleString();
  } catch {
    return d;
  }
}

function normTabFromRecord(r: LedgerRecord): TabKey {
  if (r.archived) return "ARCHIVED";

  const s = (r.status || "").toString().toLowerCase().trim();
  if (s === "draft") return "DRAFTED";
  if (s === "drafted") return "DRAFTED";
  if (s === "pending") return "PENDING";
  if (s === "approved") return "APPROVED";
  if (s === "signing") return "SIGNING";
  if (s === "signed") return "SIGNED";
  if (s === "archived") return "ARCHIVED";

  if (r.approved) return "APPROVED";
  return "DRAFTED";
}

function statusPillClass(tab: TabKey) {
  if (tab === "APPROVED") return "border-emerald-400/30 bg-emerald-400/10 text-emerald-100";
  if (tab === "SIGNED") return "border-cyan-400/30 bg-cyan-400/10 text-cyan-100";
  if (tab === "ARCHIVED") return "border-white/10 bg-white/5 text-slate-200/80";
  if (tab === "SIGNING") return "border-amber-400/30 bg-amber-400/10 text-amber-100";
  if (tab === "PENDING") return "border-indigo-400/30 bg-indigo-400/10 text-indigo-100";
  if (tab === "DRAFTED") return "border-white/10 bg-white/5 text-slate-200/80";
  return "border-white/10 bg-white/5 text-slate-200/80";
}

function TabButton({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "rounded-full border px-3 py-1 text-xs transition",
        active
          ? "border-amber-400/40 bg-amber-400/10 text-amber-100"
          : "border-white/10 bg-white/5 text-slate-200/80 hover:bg-white/7"
      )}
    >
      {label} <span className="text-slate-500">·</span>{" "}
      <span className={cx(active ? "text-amber-100" : "text-slate-200/80")}>{count}</span>
    </button>
  );
}

export default function LedgerClient() {
  // IMPORTANT: same pattern as Verified page (activeEntity is a slug/key string)
  const { activeEntity } = useEntity();
  const { env } = useOsEnv();
  const laneIsTest = env === "SANDBOX";

  const [entityId, setEntityId] = useState<string | null>(null);

  const [rows, setRows] = useState<LedgerRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [tab, setTab] = useState<TabKey>("ALL");
  const [q, setQ] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = useMemo(
    () => rows.find((r) => r.id === selectedId) ?? null,
    [rows, selectedId]
  );

  // Resolve entity UUID from entities table using slug (MATCH VERIFIED — NO CHANGE)
  useEffect(() => {
    let alive = true;

    async function resolveEntity() {
      if (!activeEntity) {
        if (alive) setEntityId(null);
        return;
      }

      const { data, error } = await supabase
        .from("entities")
        .select("id")
        .eq("slug", String(activeEntity))
        .limit(1)
        .maybeSingle();

      if (!alive) return;

      if (error) {
        console.error("resolveEntity error", error);
        setEntityId(null);
        return;
      }

      setEntityId(data?.id ?? null);
    }

    resolveEntity();
    return () => {
      alive = false;
    };
  }, [activeEntity]);

  async function load() {
    if (!entityId) {
      setRows([]);
      setSelectedId(null);
      return;
    }

    setLoading(true);
    setErr(null);

    try {
      // Primary: scoped view (same wiring intent as your original ledger page)
      const { data: v, error: vErr } = await supabase
        .from("v_governance_ledger_scoped_v3")
        .select("*")
        .eq("entity_id", entityId)
        .order("created_at", { ascending: false })
        .limit(500);

      if (vErr) throw vErr;

      const base: LedgerRecord[] = (v ?? []) as any[];

      // Lane map (MATCH VERIFIED discipline): governance_ledger.id → is_test
      const ids = base.map((r) => r.id).filter(Boolean) as string[];
      const laneMap = new Map<string, boolean>();

      if (ids.length) {
        const { data: gl, error: glErr } = await supabase
          .from("governance_ledger")
          .select("id,is_test")
          .in("id", ids);

        if (!glErr && gl) {
          for (const r of gl as any[]) {
            laneMap.set(String(r.id), !!r.is_test);
          }
        }
      }

      const merged: LedgerRecord[] = base.map((r) => ({
        ...(r as LedgerRecord),
        lane_is_test: laneMap.has(r.id) ? laneMap.get(r.id)! : null,
      }));

      // Lane filter (MATCH VERIFIED — NO CHANGE)
      const laneFiltered = merged.filter((r) => {
        if (r.lane_is_test === null || r.lane_is_test === undefined) return true;
        return r.lane_is_test === laneIsTest;
      });

      setRows(laneFiltered);

      // Selection: keep or choose first
      if (!selectedId && laneFiltered.length) setSelectedId(laneFiltered[0]!.id);
      else if (selectedId && !laneFiltered.some((r) => r.id === selectedId) && laneFiltered.length) {
        setSelectedId(laneFiltered[0]!.id);
      }
    } catch (e: any) {
      console.error("ledger load error", e);
      setErr(e?.message ?? "Failed to load ledger.");
      setRows([]);
      setSelectedId(null);
    } finally {
      setLoading(false);
    }
  }

  // Load on entity + lane changes
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!alive) return;
      await load();
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId, laneIsTest]);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();

    return rows.filter((r) => {
      const st = normTabFromRecord(r);

      if (tab !== "ALL" && st !== tab) return false;
      if (!qq) return true;

      const hay = `${r.title ?? ""} ${r.record_type ?? ""} ${r.description ?? ""} ${st}`.toLowerCase();
      return hay.includes(qq);
    });
  }, [rows, tab, q]);

  // Selection resilience under filters/search (OS feel)
  useEffect(() => {
    if (!filtered.length) return;
    if (!selectedId) {
      setSelectedId(filtered[0]!.id);
      return;
    }
    const still = filtered.some((r) => r.id === selectedId);
    if (!still) setSelectedId(filtered[0]!.id);
  }, [filtered, selectedId]);

  const counts = useMemo(() => {
    const c: Record<TabKey, number> = {
      ALL: rows.length,
      DRAFTED: 0,
      PENDING: 0,
      APPROVED: 0,
      SIGNING: 0,
      SIGNED: 0,
      ARCHIVED: 0,
    };
    for (const r of rows) {
      c[normTabFromRecord(r)] += 1;
    }
    return c;
  }, [rows]);

  const selectedTab = selected ? normTabFromRecord(selected) : "DRAFTED";
  const canOpenForge = !!selected && (selectedTab === "APPROVED" || selectedTab === "SIGNING" || selectedTab === "SIGNED");
  const canArchiveNow = !!selected && selectedTab === "SIGNED";
  const canOpenArchive = !!selected && (selectedTab === "ARCHIVED" || selectedTab === "SIGNED" || selectedTab === "SIGNING");

  const portal = selected?.envelope_id
    ? {
        view: selected.viewer_url || null,
        sign: selected.signer_url || null,
        verify: selected.verify_url || null,
        certificate: selected.certificate_url || null,
      }
    : null;

  // OS shell/header/body pattern (MATCH VERIFIED)
  const shell =
    "rounded-3xl border border-white/10 bg-black/20 shadow-[0_28px_120px_rgba(0,0,0,0.55)] overflow-hidden";
  const header =
    "border-b border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent px-4 sm:px-6 py-4 sm:py-5";
  const body = "px-4 sm:px-6 py-5 sm:py-6";

  return (
    <div className="w-full">
      <div className="mx-auto w-full max-w-[1200px] px-4 pb-10 pt-4 sm:pt-6">
        <div className={shell}>
          {/* OS-aligned header (MATCH VERIFIED) */}
          <div className={header}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10px] sm:text-xs tracking-[0.3em] uppercase text-slate-500">
                  CI • Archive
                </div>
                <h1 className="mt-1 text-lg sm:text-xl font-semibold text-slate-50">
                  Drafts &amp; Approvals
                </h1>
                <p className="mt-1 max-w-3xl text-[11px] sm:text-xs text-slate-400 leading-relaxed">
                  Lifecycle surface for records in motion. Read-only. Lane-safe. Entity-scoped.
                </p>

                <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-400">
                  <span className="inline-flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-emerald-300" />
                    <span>Lifecycle surface • No destructive actions</span>
                  </span>
                  <span className="text-slate-700">•</span>
                  <span>
                    Lane:{" "}
                    <span className={cx("font-semibold", laneIsTest ? "text-amber-300" : "text-sky-300")}>
                      {laneIsTest ? "SANDBOX" : "RoT"}
                    </span>
                  </span>
                  <span className="text-slate-700">•</span>
                  <span>
                    Entity:{" "}
                    <span className="text-emerald-300 font-medium">{String(activeEntity ?? "—")}</span>
                  </span>
                </div>
              </div>

              <div className="shrink-0 flex items-center gap-2">
                <button
                  onClick={load}
                  className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7 inline-flex items-center gap-2"
                  title="Refresh"
                >
                  <RefreshCcw className="h-4 w-4" />
                  Refresh
                </button>

                <Link
                  href="/ci-archive"
                  className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7 inline-flex items-center gap-2"
                  title="Back to CI-Archive Launchpad"
                >
                  <ArrowLeft className="h-4 w-4" />
                  Launchpad
                </Link>
              </div>
            </div>
          </div>

          <div className={body}>
            <div className="grid grid-cols-12 gap-4">
              {/* LEFT: Filters (MATCH VERIFIED grammar) */}
              <section className="col-span-12 lg:col-span-3">
                <div className="rounded-3xl border border-white/10 bg-black/20 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-200">Filters</div>
                      <div className="text-[11px] text-slate-500">Status + search</div>
                    </div>
                    <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[10px] tracking-[0.18em] uppercase text-slate-200">
                      filters
                    </span>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <TabButton active={tab === "ALL"} label="ALL" count={counts.ALL} onClick={() => setTab("ALL")} />
                    <TabButton active={tab === "DRAFTED"} label="DRAFTED" count={counts.DRAFTED} onClick={() => setTab("DRAFTED")} />
                    <TabButton active={tab === "PENDING"} label="PENDING" count={counts.PENDING} onClick={() => setTab("PENDING")} />
                    <TabButton active={tab === "APPROVED"} label="APPROVED" count={counts.APPROVED} onClick={() => setTab("APPROVED")} />
                    <TabButton active={tab === "SIGNING"} label="SIGNING" count={counts.SIGNING} onClick={() => setTab("SIGNING")} />
                    <TabButton active={tab === "SIGNED"} label="SIGNED" count={counts.SIGNED} onClick={() => setTab("SIGNED")} />
                    <TabButton active={tab === "ARCHIVED"} label="ARCHIVED" count={counts.ARCHIVED} onClick={() => setTab("ARCHIVED")} />
                  </div>

                  <div className="mt-4">
                    <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">Search</div>
                    <div className="mt-2 relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                      <input
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder="title, type, status..."
                        className="w-full rounded-2xl border border-white/10 bg-white/5 pl-10 pr-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-500 focus:border-amber-400/30"
                      />
                    </div>
                  </div>

                  <div className="mt-4 text-xs text-slate-400">
                    {loading ? "Loading…" : `${filtered.length} result(s)`}
                  </div>

                  {err && (
                    <div className="mt-3 rounded-2xl border border-red-900/60 bg-red-950/30 px-3 py-2 text-sm text-red-200">
                      {err}
                    </div>
                  )}

                  <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 p-3 text-xs text-slate-400">
                    Lane-safe: filters by <span className="text-slate-200">governance_ledger.is_test</span> using record IDs.
                  </div>

                  {!entityId && (
                    <div className="mt-3 rounded-2xl border border-amber-400/20 bg-amber-400/10 p-3 text-xs text-amber-100">
                      Waiting for entity resolution (slug → entities.id).
                    </div>
                  )}
                </div>
              </section>

              {/* MIDDLE: Queue (MATCH VERIFIED “Documents” surface) */}
              <section className="col-span-12 lg:col-span-6">
                <div className="rounded-3xl border border-white/10 bg-black/20 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-200">Queue</div>
                      <div className="text-[11px] text-slate-500">Records in motion</div>
                    </div>
                    <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[10px] tracking-[0.18em] uppercase text-slate-200">
                      ledger
                    </span>
                  </div>

                  <div className="mt-3 space-y-2">
                    {filtered.length === 0 ? (
                      <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-slate-400">
                        {loading ? "Loading ledger…" : "No records match this view."}
                      </div>
                    ) : (
                      filtered.map((r) => {
                        const isSel = r.id === selectedId;
                        const st = normTabFromRecord(r);

                        return (
                          <button
                            key={r.id}
                            onClick={() => setSelectedId(r.id)}
                            className={cx(
                              "w-full text-left rounded-3xl border p-3 transition outline-none",
                              "hover:bg-black/25",
                              isSel
                                ? "border-amber-400/40 bg-amber-400/10"
                                : "border-white/10 bg-black/20"
                            )}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="text-sm font-medium text-slate-100 truncate">
                                  {r.title || "(Untitled record)"}
                                </div>
                                <div className="mt-1 text-xs text-slate-400">
                                  {r.record_type ? `${r.record_type} · ` : ""}
                                  Created: {formatDate(r.created_at)}
                                </div>
                                {r.description ? (
                                  <div className="mt-2 text-[11px] text-slate-500 line-clamp-2">
                                    {r.description}
                                  </div>
                                ) : null}
                              </div>

                              <span
                                className={cx(
                                  "shrink-0 rounded-full border px-2 py-1 text-[11px]",
                                  statusPillClass(st)
                                )}
                              >
                                {st}
                              </span>
                            </div>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              </section>

              {/* RIGHT: Record + Actions + AXIOM (same shell language as Verified) */}
              <section className="col-span-12 lg:col-span-3">
                <div className="rounded-3xl border border-white/10 bg-black/20 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-200">Selected</div>
                      <div className="text-[11px] text-slate-500">Record + posture</div>
                    </div>
                    <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[10px] tracking-[0.18em] uppercase text-slate-200">
                      detail
                    </span>
                  </div>

                  {!selected ? (
                    <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-slate-400">
                      Select a record from the queue.
                    </div>
                  ) : (
                    <div className="mt-3 space-y-3">
                      <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                        <div className="text-sm font-semibold text-slate-100 truncate">
                          {selected.title || "(Untitled record)"}
                        </div>
                        <div className="mt-1 text-xs text-slate-400">
                          Status:{" "}
                          <span className="text-slate-200 font-medium">{normTabFromRecord(selected)}</span>
                          <span className="text-slate-700"> • </span>
                          {formatDate(selected.created_at)}
                        </div>

                        <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                          <div className="rounded-2xl border border-white/10 bg-black/20 p-2">
                            <div className="text-[10px] tracking-[0.25em] uppercase text-slate-500">Approved</div>
                            <div className="mt-1 text-slate-200">{selected.approved ? "Yes" : "No"}</div>
                          </div>
                          <div className="rounded-2xl border border-white/10 bg-black/20 p-2">
                            <div className="text-[10px] tracking-[0.25em] uppercase text-slate-500">Archived</div>
                            <div className="mt-1 text-slate-200">{selected.archived ? "Yes" : "No"}</div>
                          </div>
                        </div>

                        {selected.record_no ? (
                          <div className="mt-2 text-[11px] text-slate-500">
                            No: <span className="text-slate-200">{selected.record_no}</span>
                          </div>
                        ) : null}

                        {selected.entity_key ? (
                          <div className="mt-1 text-[11px] text-slate-500">
                            Entity: <span className="text-slate-200">{selected.entity_key}</span>
                          </div>
                        ) : null}
                      </div>

                      {/* Actions (read-only) */}
                      <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                        <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">Actions</div>

                        <div className="mt-2 space-y-2">
                          <Link
                            href={canOpenForge ? `/ci-forge?record_id=${encodeURIComponent(selected.id)}` : "#"}
                            className={cx(
                              "w-full inline-flex items-center justify-between gap-3 rounded-2xl border px-3 py-2 text-sm transition",
                              canOpenForge
                                ? "border-white/10 bg-white/5 text-slate-200 hover:bg-white/7"
                                : "border-white/10 bg-black/20 text-slate-600 pointer-events-none"
                            )}
                            title={canOpenForge ? "Open in CI-Forge" : "Available after approval (or during signing/signed)."}
                          >
                            <span className="inline-flex items-center gap-2">
                              <Hammer className="h-4 w-4 text-amber-300" />
                              Open in Forge
                            </span>
                            <ArrowRight className="h-4 w-4" />
                          </Link>

                          <button
                            disabled={!canArchiveNow}
                            className={cx(
                              "w-full inline-flex items-center justify-between gap-3 rounded-2xl border px-3 py-2 text-sm transition",
                              canArchiveNow
                                ? "border-white/10 bg-white/5 text-slate-200 hover:bg-white/7"
                                : "border-white/10 bg-black/20 text-slate-600 cursor-not-allowed"
                            )}
                            title={canArchiveNow ? "Archive signed artifact (wired in Forge)." : "Archive is available once signed."}
                          >
                            <span className="inline-flex items-center gap-2">
                              <ArchiveIcon className="h-4 w-4 text-amber-300" />
                              Archive Now
                            </span>
                            <ArrowRight className="h-4 w-4" />
                          </button>

                          <Link
                            href={canOpenArchive ? "/ci-archive/minute-book" : "#"}
                            className={cx(
                              "w-full inline-flex items-center justify-between gap-3 rounded-2xl border px-3 py-2 text-sm transition",
                              canOpenArchive
                                ? "border-white/10 bg-white/5 text-slate-200 hover:bg-white/7"
                                : "border-white/10 bg-black/20 text-slate-600 pointer-events-none"
                            )}
                            title={canOpenArchive ? "Open CI-Archive registry surfaces" : "Available after signing / archival."}
                          >
                            <span className="inline-flex items-center gap-2">
                              <ExternalLink className="h-4 w-4 text-amber-300" />
                              Open Archive
                            </span>
                            <ArrowRight className="h-4 w-4" />
                          </Link>
                        </div>

                        {/* Portal shortcuts */}
                        <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 p-3">
                          <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">Portal</div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {([
                              ["View", portal?.view],
                              ["Sign", portal?.sign],
                              ["Verify", portal?.verify],
                              ["Certificate", portal?.certificate],
                            ] as Array<[string, string | null | undefined]>).map(([label, href]) => (
                              <a
                                key={label}
                                href={href ?? "#"}
                                target="_blank"
                                rel="noreferrer"
                                className={cx(
                                  "rounded-full border px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase inline-flex items-center gap-2 transition",
                                  href
                                    ? "border-amber-400/20 bg-amber-400/10 text-amber-100 hover:bg-amber-400/15"
                                    : "border-white/10 bg-black/20 text-slate-600 pointer-events-none"
                                )}
                              >
                                <ExternalLink className="h-4 w-4" />
                                {label}
                              </a>
                            ))}
                          </div>
                        </div>

                        {/* Constitutional note */}
                        <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 p-3 text-xs text-slate-400">
                          No governance_ledger deletes (constitutional memory). Cleanup lives in Drafts/Envelopes.
                        </div>

                        {/* Locked cleanup buttons (visual parity w/ your old ledger) */}
                        <div className="mt-3 border-t border-white/10 pt-3">
                          <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500 mb-2">Cleanup</div>
                          <button
                            disabled
                            className="w-full inline-flex items-center justify-between gap-3 rounded-2xl border border-red-900/60 bg-red-950/30 px-3 py-2 text-sm text-red-200 opacity-70 cursor-not-allowed"
                            title="Draft deletion remains in CI-Alchemy (blocked here)."
                          >
                            <span className="inline-flex items-center gap-2">
                              <Trash2 className="h-4 w-4" />
                              Delete Draft
                            </span>
                            <ArrowRight className="h-4 w-4" />
                          </button>
                        </div>
                      </div>

                      {/* AXIOM (same advisory grammar as Verified) */}
                      <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="inline-flex items-center gap-2">
                            <Shield className="h-4 w-4 text-amber-300" />
                            <div>
                              <div className="text-sm font-semibold text-slate-200">AXIOM Advisory</div>
                              <div className="text-[11px] text-slate-500">Intelligence support • never blocking</div>
                            </div>
                          </div>
                          <span className="px-2 py-0.5 rounded-full bg-amber-400/10 border border-amber-400/20 text-[10px] tracking-[0.18em] uppercase text-amber-100">
                            advisory
                          </span>
                        </div>

                        <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 p-3 text-xs text-slate-300">
                          <ul className="space-y-2">
                            <li>• Advisory only — never blocks a human decision.</li>
                            <li>• Severity flags: GREEN / AMBER / RED (informational).</li>
                            <li>• Cite the trigger (why the flag exists).</li>
                            <li>• Clarity over hype.</li>
                          </ul>
                        </div>

                        <div className="mt-3 text-[11px] text-slate-500">
                          Wire AXIOM outputs here later for the selected record.
                        </div>
                      </div>

                      <div className="hidden lg:flex items-center gap-2 px-1 text-[10px] uppercase tracking-[0.28em] text-slate-600">
                        <FileCheck2 className="h-4 w-4" />
                        Oasis OS • lifecycle discipline • evidence-first registry
                      </div>
                    </div>
                  )}
                </div>
              </section>
            </div>

            {/* OS behavior footnote (MATCH VERIFIED) */}
            <div className="mt-5 rounded-3xl border border-white/10 bg-black/20 px-4 py-3 text-[11px] text-slate-400">
              <div className="font-semibold text-slate-200">OS behavior</div>
              <div className="mt-1 leading-relaxed text-slate-400">
                CI-Archive Ledger inherits the OS shell. Lane-safe and entity-scoped. Read-only lifecycle surface.
              </div>
            </div>

            <div className="mt-5 flex items-center justify-between text-[10px] text-slate-600">
              <span>CI-Archive · Oasis Digital Parliament</span>
              <span>ODP.AI · Governance Firmware</span>
            </div>
          </div>
        </div>

        {/* optional quick links row (MATCH VERIFIED grammar) */}
        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            href="/ci-archive"
            className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7"
          >
            CI-Archive
          </Link>
          <Link
            href="/ci-archive/minute-book"
            className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7"
          >
            Minute Book
          </Link>
          <Link
            href="/ci-archive/verified"
            className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7"
          >
            Verified
          </Link>
        </div>
      </div>
    </div>
  );
}
