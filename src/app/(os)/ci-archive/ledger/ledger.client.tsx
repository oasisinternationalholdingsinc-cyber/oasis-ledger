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
  title: string | null;
  status: LedgerStatus | null;
  created_at: string | null;
  updated_at: string | null;

  // optional fields (don’t assume they exist)
  record_type?: string | null;
  entity_key?: string | null;
  entity_slug?: string | null;
  source_record_id?: string | null;

  // signature/envelope-related (optional)
  envelope_id?: string | null;
  envelope_status?: string | null;

  // archive linkage (optional)
  archived_entry_id?: string | null;
};

type TabKey = "all" | "drafted" | "pending" | "approved" | "signing" | "signed" | "archived";

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

function statusLabel(s: string | null | undefined) {
  const v = (s || "").toLowerCase();
  if (!v) return "—";
  if (v === "draft") return "drafted";
  return v;
}

function statusPillClass(s: string) {
  const v = s.toLowerCase();
  if (v === "approved") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
  if (v === "signed") return "border-cyan-500/30 bg-cyan-500/10 text-cyan-200";
  if (v === "archived") return "border-slate-500/30 bg-slate-500/10 text-slate-200";
  if (v === "signing") return "border-amber-500/30 bg-amber-500/10 text-amber-200";
  if (v === "pending") return "border-indigo-500/30 bg-indigo-500/10 text-indigo-200";
  if (v === "drafted") return "border-slate-600/30 bg-slate-900/40 text-slate-200";
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
  const { activeEntity, entityKey } = useEntity(); // some builds expose both; we’ll use whichever exists
  const scopedEntity = (entityKey || activeEntity || "").toString();

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

  const normalized = useMemo(() => {
    const term = q.trim().toLowerCase();
    const filtered = records.filter((r) => {
      const st = statusLabel(r.status);
      if (tab !== "all" && st !== tab) return false;
      if (!term) return true;

      const title = (r.title || "").toLowerCase();
      const type = ((r.record_type as any) || "").toString().toLowerCase();
      return title.includes(term) || type.includes(term) || st.includes(term);
    });

    return filtered;
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
      const st = statusLabel(r.status) as TabKey;
      if (c[st] !== undefined) c[st] += 1;
    }
    return c;
  }, [records]);

  const scopeQuery = useMemo(() => {
    const ek = scopedEntity ? `?entity_key=${encodeURIComponent(scopedEntity)}` : "";
    return ek;
  }, [scopedEntity]);

  async function load() {
    setLoading(true);
    setErr(null);

    try {
      // Keep it forgiving: only select columns that definitely exist in your schema.
      // If your governance_ledger has more fields, we can expand later.
      const sel =
        "id,title,status,created_at,updated_at,record_type,entity_key,entity_slug,source_record_id,envelope_id,envelope_status,archived_entry_id";

      let query = supabase
        .from("governance_ledger")
        .select(sel)
        .order("updated_at", { ascending: false });

      if (scopedEntity) {
        // Your ecosystem uses entity_key heavily (holdings/lounge/real-estate).
        query = query.eq("entity_key", scopedEntity);
      }

      const { data, error } = await query;

      if (error) throw error;

      const list = (data ?? []) as LedgerRecord[];
      setRecords(list);

      // auto-select first visible record if none selected
      if (!selectedId && list.length) setSelectedId(list[0]!.id);
    } catch (e: any) {
      setErr(e?.message ?? "Failed to load governance_ledger.");
      setRecords([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // IMPORTANT: auth gating belongs to (os)/layout or os-auth-gate — do NOT redirect here.
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedEntity]);

  // CTA enablement logic (wiring-safe: just links / disabled states)
  const st = selected ? statusLabel(selected.status) : "";
  const canOpenForge = !!selected && (st === "approved" || st === "signing" || st === "signed");
  const canArchiveNow = !!selected && st === "signed";
  const canOpenArchive = !!selected && (st === "archived" || st === "signed" || st === "signing");

  const openInForgeHref = selected
    ? `/ci-forge?record_id=${encodeURIComponent(selected.id)}${scopedEntity ? `&entity_key=${encodeURIComponent(scopedEntity)}` : ""}`
    : "#";

  // if you later support deep-linking by archived_entry_id, this will “just work” visually
  const openInArchiveHref = selected
    ? `/ci-archive/minute-book${scopedEntity ? `?entity_key=${encodeURIComponent(scopedEntity)}` : ""}`
    : "#";

  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      {/* Header under OS bar */}
      <div className="mb-4 shrink-0">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">CI-ARCHIVE</div>
        <p className="mt-1 text-[11px] text-slate-400">
          Drafts & Approvals • <span className="font-semibold text-slate-200">Lifecycle surface</span> • Entity-scoped via OS selector
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
                      Entity: <span className="text-slate-200">{scopedEntity || "—"}</span>
                    </div>
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
                ) : normalized.length === 0 ? (
                  <div className="p-3 text-sm text-slate-500">No records match this view.</div>
                ) : (
                  <div className="space-y-2">
                    {normalized.map((r) => {
                      const isSel = r.id === selectedId;
                      const st = statusLabel(r.status);
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
                                Updated: <span className="text-slate-300">{formatDate(r.updated_at)}</span>
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
                              <span className="text-slate-200">{statusLabel(selected.status)}</span>
                            </span>
                            <span>
                              Created:{" "}
                              <span className="text-slate-200">{formatDate(selected.created_at)}</span>
                            </span>
                            <span>
                              Updated:{" "}
                              <span className="text-slate-200">{formatDate(selected.updated_at)}</span>
                            </span>
                          </div>
                        </div>

                        <div
                          className={cx(
                            "shrink-0 rounded-full border px-3 py-1.5 text-[10px] uppercase tracking-[0.22em]",
                            statusPillClass(statusLabel(selected.status))
                          )}
                        >
                          {statusLabel(selected.status)}
                        </div>
                      </div>
                    </div>

                    <div className="rounded-3xl border border-slate-900 bg-black/30 p-4">
                      <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Execution monitor</div>

                      <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                        <div className="rounded-2xl border border-slate-900 bg-black/20 p-3">
                          <div className="text-[11px] text-slate-500">Envelope</div>
                          <div className="mt-1 text-slate-200">
                            {selected.envelope_id ? (
                              <span className="break-all">{selected.envelope_id}</span>
                            ) : (
                              "—"
                            )}
                          </div>
                        </div>

                        <div className="rounded-2xl border border-slate-900 bg-black/20 p-3">
                          <div className="text-[11px] text-slate-500">Envelope status</div>
                          <div className="mt-1 text-slate-200">{selected.envelope_status || "—"}</div>
                        </div>

                        <div className="col-span-2 rounded-2xl border border-slate-900 bg-black/20 p-3">
                          <div className="text-[11px] text-slate-500">Archive linkage</div>
                          <div className="mt-1 text-slate-200">
                            {selected.archived_entry_id ? (
                              <span className="break-all">{selected.archived_entry_id}</span>
                            ) : (
                              "Not linked yet (registry entry created after archive)."
                            )}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-3xl border border-slate-900 bg-black/20 p-4 text-xs text-slate-400">
                      Discipline: approval ≠ archived. Both execution paths must produce the same archive-quality artifact (PDF + hash + registry entry).
                    </div>
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
                  {/* Open in Forge */}
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

                  {/* Archive Now (disabled for now; wiring later) */}
                  <button
                    disabled={!canArchiveNow}
                    className={cx(
                      "w-full inline-flex items-center justify-between gap-3 rounded-2xl border px-3 py-2 text-sm transition",
                      canArchiveNow
                        ? "border-slate-800 bg-black/40 text-slate-100 hover:border-amber-500/30"
                        : "border-slate-900 bg-black/20 text-slate-600 cursor-not-allowed"
                    )}
                    title={
                      canArchiveNow
                        ? "Archive the signed artifact into CI-Archive (wiring next)."
                        : "Archive is available once signed."
                    }
                  >
                    <span className="inline-flex items-center gap-2">
                      <ArchiveIcon className="h-4 w-4" />
                      Archive Now
                    </span>
                    <ArrowRight className="h-4 w-4" />
                  </button>

                  {/* Open in CI-Archive */}
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
                    Approval + Archive: Both execution paths must produce the same archive-quality artifact (PDF + hash + registry entry).
                  </div>
                </div>
              </div>

              {/* AXIOM Advisory (placeholder panel; wiring later) */}
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

                  <div className="mt-3 flex items-center gap-2">
                    <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-[10px] uppercase tracking-[0.22em] text-emerald-200">
                      Green
                    </span>
                    <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[10px] uppercase tracking-[0.22em] text-amber-200">
                      Amber
                    </span>
                    <span className="rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1 text-[10px] uppercase tracking-[0.22em] text-red-200">
                      Red
                    </span>
                  </div>
                </div>
              </div>

              {/* Small footer marker */}
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
