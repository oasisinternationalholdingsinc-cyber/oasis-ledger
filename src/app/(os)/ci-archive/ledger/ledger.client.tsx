// src/app/(os)/ci-archive/ledger/ledger.client.tsx
"use client";
export const dynamic = "force-dynamic";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  ExternalLink,
  RefreshCcw,
  Shield,
  Hammer,
  Archive as ArchiveIcon,
  FileCheck2,
} from "lucide-react";

import { supabaseBrowser } from "@/lib/supabase/browser";
import { useEntity } from "@/components/OsEntityContext";

type LedgerStatus =
  | "drafted"
  | "pending"
  | "approved"
  | "signing"
  | "signed"
  | "archived"
  | string;

type LedgerRecord = {
  id: string;
  entity_id: string | null;

  title: string | null;
  description?: string | null;

  record_type?: string | null;
  record_no?: string | null;

  status: LedgerStatus | null;

  // These exist in your schema (per screenshot)
  approved?: boolean | null;
  archived?: boolean | null;

  created_at: string | null;

  // Optional (may exist later; do not assume)
  source?: string | null;
  provenance?: string | null;
  version?: number | null;
  locked?: boolean | null;

  // Optional future links
  ai_summary_id?: string | null;
};

type TabKey =
  | "all"
  | "drafted"
  | "pending"
  | "approved"
  | "signing"
  | "signed"
  | "archived";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function formatDate(d: string | null) {
  if (!d) return "—";
  try {
    const dt = new Date(d);
    return dt.toLocaleString();
  } catch {
    return d;
  }
}

/**
 * Normalize lifecycle for UI:
 * - archived=true => archived
 * - else if status present => status
 * - else if approved=true => approved
 * - else => drafted
 */
function normalizedStatus(r: LedgerRecord): TabKey {
  if (r.archived) return "archived";

  const s = (r.status || "").toString().toLowerCase().trim();
  if (s === "draft") return "drafted";
  if (s === "drafted") return "drafted";
  if (s === "pending") return "pending";
  if (s === "approved") return "approved";
  if (s === "signing") return "signing";
  if (s === "signed") return "signed";
  if (s === "archived") return "archived";

  if (r.approved) return "approved";

  return "drafted";
}

function statusPillClass(tab: TabKey) {
  if (tab === "approved") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
  if (tab === "signed") return "border-cyan-500/30 bg-cyan-500/10 text-cyan-200";
  if (tab === "archived") return "border-slate-500/30 bg-slate-500/10 text-slate-200";
  if (tab === "signing") return "border-amber-500/30 bg-amber-500/10 text-amber-200";
  if (tab === "pending") return "border-indigo-500/30 bg-indigo-500/10 text-indigo-200";
  if (tab === "drafted") return "border-slate-600/30 bg-slate-900/40 text-slate-200";
  return "border-slate-700 bg-slate-900/40 text-slate-200";
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
        "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-semibold tracking-[0.18em] uppercase transition",
        active
          ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
          : "border-slate-800 bg-slate-950/40 text-slate-300 hover:text-slate-100 hover:border-slate-700"
      )}
    >
      <span>{label}</span>
      <span
        className={cx(
          "rounded-full px-2 py-0.5 text-[10px] tracking-[0.12em]",
          active ? "bg-amber-500/10 text-amber-200" : "bg-slate-900/60 text-slate-300"
        )}
      >
        {count}
      </span>
    </button>
  );
}

export default function DraftsApprovalsClient() {
  const supabase = useMemo(() => supabaseBrowser(), []);

  // Make NO assumptions about your context shape — pull anything that looks like an ID.
  const entityCtx: any = useEntity() as any;
  const activeEntity = entityCtx?.activeEntity ?? null;

  const scopedEntityId: string =
    (entityCtx?.entityId ||
      activeEntity?.id ||
      activeEntity?.entity_id ||
      entityCtx?.activeEntityId ||
      "")?.toString() ?? "";

  const scopedEntityLabel: string =
    (activeEntity?.slug || activeEntity?.key || activeEntity?.name || "")?.toString() ||
    (scopedEntityId ? "selected" : "—");

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [records, setRecords] = useState<LedgerRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [tab, setTab] = useState<TabKey>("all");
  const [q, setQ] = useState("");

  const selected = useMemo(
    () => records.find((r) => r.id === selectedId) ?? null,
    [records, selectedId]
  );

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();

    return records.filter((r) => {
      const st = normalizedStatus(r);
      if (tab !== "all" && st !== tab) return false;
      if (!term) return true;

      const title = (r.title || "").toLowerCase();
      const type = ((r.record_type as any) || "").toString().toLowerCase();
      const desc = ((r.description as any) || "").toString().toLowerCase();
      return title.includes(term) || type.includes(term) || desc.includes(term) || st.includes(term);
    });
  }, [records, tab, q]);

  const counts = useMemo(() => {
    const c: Record<TabKey, number> = {
      all: records.length,
      drafted: 0,
      pending: 0,
      approved: 0,
      signing: 0,
      signed: 0,
      archived: 0,
    };

    for (const r of records) {
      const st = normalizedStatus(r);
      c[st] += 1;
    }
    return c;
  }, [records]);

  const scopeQuery = useMemo(() => {
    // keep query param for nav UX, but we do NOT rely on it for filtering
    return scopedEntityId ? `?entity_id=${encodeURIComponent(scopedEntityId)}` : "";
  }, [scopedEntityId]);

  async function load() {
    setLoading(true);
    setErr(null);

    try {
      const sel =
        "id,entity_id,title,description,record_type,record_no,status,approved,archived,created_at,source,provenance,version,locked,ai_summary_id";

      let query = supabase.from("governance_ledger").select(sel);

      // Entity scope (real fix)
      if (scopedEntityId) query = query.eq("entity_id", scopedEntityId);

      // Order by created_at (updated_at does NOT exist)
      query = query.order("created_at", { ascending: false });

      const { data, error } = await query;
      if (error) throw error;

      const list = (data ?? []) as LedgerRecord[];
      setRecords(list);

      if (!selectedId && list.length) setSelectedId(list[0]!.id);
    } catch (e: any) {
      setErr(e?.message ?? "Failed to load governance_ledger.");
      setRecords([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Auth gating belongs to (os)/layout or os-auth-gate — do NOT redirect here.
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedEntityId]);

  // CTA enablement logic (wiring-safe, just state + links)
  const st: TabKey = selected ? normalizedStatus(selected) : "drafted";
  const canOpenForge = !!selected && (st === "approved" || st === "signing" || st === "signed");
  const canArchiveNow = !!selected && st === "signed";
  const canOpenArchive = !!selected && (st === "archived" || st === "signed" || st === "signing");

  const openInForgeHref = selected
    ? `/ci-forge?record_id=${encodeURIComponent(selected.id)}`
    : "#";

  const openInArchiveHref = selected
    ? `/ci-archive/minute-book${scopeQuery}`
    : "#";

  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      {/* Header under OS bar */}
      <div className="mb-4 shrink-0">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">CI-ARCHIVE</div>
        <p className="mt-1 text-[11px] text-slate-400">
          Drafts &amp; Approvals • <span className="font-semibold text-slate-200">Lifecycle surface</span> • Entity-scoped via OS selector
        </p>
      </div>

      {/* Main window */}
      <div className="flex-1 min-h-0 flex justify-center overflow-hidden">
        <div className="w-full max-w-[1600px] h-full rounded-3xl border border-slate-900 bg-black/60 shadow-[0_0_60px_rgba(15,23,42,0.9)] px-6 py-5 flex flex-col overflow-hidden">
          {/* Title bar */}
          <div className="flex items-start justify-between mb-4 shrink-0">
            <div className="min-w-0">
              <h1 className="text-lg font-semibold text-slate-50 truncate">Drafts &amp; Approvals</h1>
              <p className="mt-1 text-xs text-slate-400">
                Council authority decides execution mode. Forge handles signature-only execution. Archive remains the registry of record.
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <div className="hidden md:block text-[10px] uppercase tracking-[0.22em] text-slate-500">
                Source • <span className="text-slate-300">governance_ledger</span>
              </div>

              <button
                onClick={load}
                className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-950/40 px-3 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:border-slate-700"
                title="Refresh"
              >
                <RefreshCcw className="h-4 w-4" />
                Refresh
              </button>

              <Link
                href={`/ci-archive${scopeQuery}`}
                className="inline-flex items-center gap-2 rounded-full border border-amber-500/30 bg-amber-500 px-3 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-black hover:bg-amber-400"
                title="Back to CI-Archive Launchpad"
              >
                Back to Launchpad <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </div>

          {/* Body grid */}
          <div className="flex-1 min-h-0 grid grid-cols-12 gap-4 overflow-hidden">
            {/* Queue */}
            <div className="col-span-12 lg:col-span-4 min-h-0 rounded-3xl border border-slate-900 bg-slate-950/30 overflow-hidden flex flex-col">
              <div className="p-4 border-b border-slate-900 shrink-0">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-50">Queue</div>
                    <div className="text-[11px] text-slate-400">
                      Entity: <span className="text-slate-200">{scopedEntityLabel}</span>
                    </div>
                    {!scopedEntityId && (
                      <div className="mt-2 text-[11px] text-amber-200/90">
                        Note: no entity_id found in OS selector context — loading unscoped.
                      </div>
                    )}
                  </div>

                  <div className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-black/40 px-3 py-1">
                    <span className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Records</span>
                    <span className="text-[11px] font-semibold text-slate-200">
                      {loading ? "…" : records.length}
                    </span>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <TabButton active={tab === "all"} label="All" count={counts.all} onClick={() => setTab("all")} />
                  <TabButton active={tab === "drafted"} label="Drafted" count={counts.drafted} onClick={() => setTab("drafted")} />
                  <TabButton active={tab === "pending"} label="Pending" count={counts.pending} onClick={() => setTab("pending")} />
                  <TabButton active={tab === "approved"} label="Approved" count={counts.approved} onClick={() => setTab("approved")} />
                  <TabButton active={tab === "signing"} label="Signing" count={counts.signing} onClick={() => setTab("signing")} />
                  <TabButton active={tab === "signed"} label="Signed" count={counts.signed} onClick={() => setTab("signed")} />
                  <TabButton active={tab === "archived"} label="Archived" count={counts.archived} onClick={() => setTab("archived")} />
                </div>

                <div className="mt-3">
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search title, type, status..."
                    className="w-full rounded-2xl border border-slate-800 bg-black/40 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 outline-none focus:border-amber-500/30"
                  />
                </div>

                {err && (
                  <div className="mt-3 rounded-2xl border border-red-900/60 bg-red-950/30 px-3 py-2 text-sm text-red-200">
                    {err}
                  </div>
                )}
              </div>

              <div className="flex-1 min-h-0 overflow-auto p-2">
                {loading ? (
                  <div className="p-3 text-sm text-slate-400">Loading…</div>
                ) : filtered.length === 0 ? (
                  <div className="p-3 text-sm text-slate-500">No records match this view.</div>
                ) : (
                  <div className="space-y-2">
                    {filtered.map((r) => {
                      const isSel = r.id === selectedId;
                      const st = normalizedStatus(r);
                      return (
                        <button
                          key={r.id}
                          onClick={() => setSelectedId(r.id)}
                          className={cx(
                            "w-full text-left rounded-2xl border p-3 transition",
                            isSel
                              ? "border-amber-500/35 bg-amber-500/5"
                              : "border-slate-900 bg-black/30 hover:border-slate-800"
                          )}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-sm font-semibold text-slate-100 truncate">
                                {r.title || "(Untitled record)"}
                              </div>
                              <div className="mt-1 text-[11px] text-slate-500">
                                Created: <span className="text-slate-300">{formatDate(r.created_at)}</span>
                              </div>
                            </div>

                            <div
                              className={cx(
                                "shrink-0 rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.22em]",
                                statusPillClass(st)
                              )}
                            >
                              {st}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Record */}
            <div className="col-span-12 lg:col-span-5 min-h-0 rounded-3xl border border-slate-900 bg-slate-950/30 overflow-hidden flex flex-col">
              <div className="p-4 border-b border-slate-900 shrink-0">
                <div className="text-sm font-semibold text-slate-50">Record</div>
                <div className="text-[11px] text-slate-400">Lifecycle details + execution posture</div>
              </div>

              <div className="flex-1 min-h-0 overflow-auto p-4">
                {!selected ? (
                  <div className="rounded-2xl border border-slate-800 bg-black/30 px-4 py-3 text-sm text-slate-400">
                    Select a record to review.
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="rounded-3xl border border-slate-900 bg-black/30 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-base font-semibold text-slate-50 truncate">
                            {selected.title || "(Untitled record)"}
                          </div>
                          <div className="mt-2 text-xs text-slate-400 flex flex-wrap gap-x-6 gap-y-2">
                            <span>
                              Status:{" "}
                              <span className="text-slate-200">{normalizedStatus(selected)}</span>
                            </span>
                            <span>
                              Created:{" "}
                              <span className="text-slate-200">{formatDate(selected.created_at)}</span>
                            </span>
                            {selected.record_type && (
                              <span>
                                Type: <span className="text-slate-200">{selected.record_type}</span>
                              </span>
                            )}
                            {selected.record_no && (
                              <span>
                                No: <span className="text-slate-200">{selected.record_no}</span>
                              </span>
                            )}
                          </div>
                        </div>

                        <div
                          className={cx(
                            "shrink-0 rounded-full border px-3 py-1.5 text-[10px] uppercase tracking-[0.22em]",
                            statusPillClass(normalizedStatus(selected))
                          )}
                        >
                          {normalizedStatus(selected)}
                        </div>
                      </div>
                    </div>

                    <div className="rounded-3xl border border-slate-900 bg-black/30 p-4">
                      <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Execution posture</div>

                      <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                        <div className="rounded-2xl border border-slate-900 bg-black/20 p-3">
                          <div className="text-[11px] text-slate-500">Approved</div>
                          <div className="mt-1 text-slate-200">
                            {selected.approved ? "Yes" : "No"}
                          </div>
                        </div>

                        <div className="rounded-2xl border border-slate-900 bg-black/20 p-3">
                          <div className="text-[11px] text-slate-500">Archived</div>
                          <div className="mt-1 text-slate-200">
                            {selected.archived ? "Yes" : "No"}
                          </div>
                        </div>

                        <div className="col-span-2 rounded-2xl border border-slate-900 bg-black/20 p-3">
                          <div className="text-[11px] text-slate-500">Discipline</div>
                          <div className="mt-1 text-slate-200">
                            Approval ≠ archived. Execution creates archive-quality artifacts (PDF + hash + registry entry).
                          </div>
                        </div>
                      </div>
                    </div>

                    {selected.description && (
                      <div className="rounded-3xl border border-slate-900 bg-black/20 p-4 text-sm text-slate-200">
                        <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Description</div>
                        <div className="mt-2 whitespace-pre-wrap">{selected.description}</div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Actions + AXIOM */}
            <div className="col-span-12 lg:col-span-3 min-h-0 overflow-hidden flex flex-col gap-4">
              <div className="rounded-3xl border border-slate-900 bg-slate-950/30 overflow-hidden">
                <div className="p-4 border-b border-slate-900">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-50">Actions</div>
                      <div className="text-[11px] text-slate-400">Context-aware CTAs</div>
                    </div>
                    <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">CTA</div>
                  </div>
                </div>

                <div className="p-4 space-y-2">
                  <Link
                    href={canOpenForge ? openInForgeHref : "#"}
                    className={cx(
                      "w-full inline-flex items-center justify-between gap-3 rounded-2xl border px-3 py-2 text-sm transition",
                      canOpenForge
                        ? "border-slate-800 bg-black/40 text-slate-100 hover:border-amber-500/30"
                        : "border-slate-900 bg-black/20 text-slate-600 cursor-not-allowed pointer-events-none"
                    )}
                    title={canOpenForge ? "Open in CI-Forge" : "Available once approved (or during signing/signed)."}
                  >
                    <span className="inline-flex items-center gap-2">
                      <Hammer className="h-4 w-4" />
                      Open in Forge
                    </span>
                    <ArrowRight className="h-4 w-4" />
                  </Link>

                  <button
                    disabled={!canArchiveNow}
                    className={cx(
                      "w-full inline-flex items-center justify-between gap-3 rounded-2xl border px-3 py-2 text-sm transition",
                      canArchiveNow
                        ? "border-slate-800 bg-black/40 text-slate-100 hover:border-amber-500/30"
                        : "border-slate-900 bg-black/20 text-slate-600 cursor-not-allowed"
                    )}
                    title={canArchiveNow ? "Archive signed artifact (wiring next)." : "Archive is available once signed."}
                  >
                    <span className="inline-flex items-center gap-2">
                      <ArchiveIcon className="h-4 w-4" />
                      Archive Now
                    </span>
                    <ArrowRight className="h-4 w-4" />
                  </button>

                  <Link
                    href={canOpenArchive ? openInArchiveHref : "#"}
                    className={cx(
                      "w-full inline-flex items-center justify-between gap-3 rounded-2xl border px-3 py-2 text-sm transition",
                      canOpenArchive
                        ? "border-slate-800 bg-black/40 text-slate-100 hover:border-amber-500/30"
                        : "border-slate-900 bg-black/20 text-slate-600 cursor-not-allowed pointer-events-none"
                    )}
                    title={canOpenArchive ? "Open registry surfaces (Minute Book)" : "Available after signing / archival."}
                  >
                    <span className="inline-flex items-center gap-2">
                      <ExternalLink className="h-4 w-4" />
                      Open in CI-Archive
                    </span>
                    <ArrowRight className="h-4 w-4" />
                  </Link>

                  <div className="mt-3 rounded-2xl border border-slate-900 bg-black/20 p-3 text-xs text-slate-400">
                    Approval + Archive: both execution paths must yield the same archive-quality artifact (PDF + hash + registry entry).
                  </div>
                </div>
              </div>

              <div className="rounded-3xl border border-slate-900 bg-slate-950/30 overflow-hidden">
                <div className="p-4 border-b border-slate-900">
                  <div className="flex items-start justify-between gap-3">
                    <div className="inline-flex items-center gap-2">
                      <Shield className="h-4 w-4 text-amber-300" />
                      <div>
                        <div className="text-sm font-semibold text-slate-50">AXIOM Advisory</div>
                        <div className="text-[11px] text-slate-400">Intelligence support • never blocking</div>
                      </div>
                    </div>
                    <div className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] uppercase tracking-[0.22em] text-amber-200">
                      Advisory
                    </div>
                  </div>
                </div>

                <div className="p-4">
                  <div className="rounded-2xl border border-slate-900 bg-black/20 p-3">
                    <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Tone rules</div>
                    <ul className="mt-2 space-y-2 text-xs text-slate-300">
                      <li>• Advisory only — never blocks a human decision.</li>
                      <li>• Severity flags: GREEN / AMBER / RED (informational).</li>
                      <li>• Always cite the reason (what triggered the flag).</li>
                      <li>• Prefer clarity + brevity over hype.</li>
                    </ul>
                  </div>

                  <div className="mt-3 rounded-2xl border border-slate-900 bg-black/20 p-3 text-xs text-slate-400">
                    This panel is where summaries / risk notes / compliance cautions render once you wire AXIOM outputs for the selected record.
                  </div>
                </div>
              </div>

              <div className="hidden lg:flex items-center gap-2 px-1 text-[10px] uppercase tracking-[0.28em] text-slate-600">
                <FileCheck2 className="h-4 w-4" />
                Oasis OS • lifecycle discipline • evidence-first registry
              </div>
            </div>
          </div>

          <div className="mt-4 text-[10px] uppercase tracking-[0.28em] text-slate-600">
            Oasis Digital Parliament • <span className="text-slate-400">Governance firmware</span>
          </div>
        </div>
      </div>
    </div>
  );
}
