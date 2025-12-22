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
  Trash2,
  X,
  AlertTriangle,
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

type TabKey =
  | "all"
  | "drafted"
  | "pending"
  | "approved"
  | "signing"
  | "signed"
  | "archived";

type LedgerRecord = {
  id: string;
  entity_id: string | null;

  // v2 view adds this
  entity_key?: string | null;

  title: string | null;
  description?: string | null;

  record_type?: string | null;
  record_no?: string | null;

  status: LedgerStatus | null;

  approved?: boolean | null;
  archived?: boolean | null;

  created_at: string | null;

  // test flag (filtered out by v2, but keep type-safe)
  is_test?: boolean | null;

  // cleanup linkages (from v2)
  draft_id?: string | null;
  envelope_id?: string | null;

  // portal URLs (from v2)
  signer_url?: string | null;
  viewer_url?: string | null;
  verify_url?: string | null;
  certificate_url?: string | null;
};

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function formatDate(d: string | null) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleString();
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

function DangerModal({
  open,
  title,
  subtitle,
  confirmLabel,
  confirmDisabled,
  reason,
  setReason,
  onCancel,
  onConfirm,
  busy,
}: {
  open: boolean;
  title: string;
  subtitle: string;
  confirmLabel: string;
  confirmDisabled: boolean;
  reason: string;
  setReason: (v: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6">
      <div className="w-full max-w-[620px] rounded-3xl border border-slate-900 bg-[#070A12] shadow-[0_0_80px_rgba(0,0,0,0.65)] overflow-hidden">
        <div className="flex items-start justify-between gap-4 p-5 border-b border-slate-900">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 inline-flex h-9 w-9 items-center justify-center rounded-2xl border border-amber-500/30 bg-amber-500/10">
              <AlertTriangle className="h-5 w-5 text-amber-300" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-slate-100">{title}</div>
              <div className="mt-1 text-xs text-slate-400">{subtitle}</div>
            </div>
          </div>
          <button
            onClick={onCancel}
            className="inline-flex items-center justify-center rounded-2xl border border-slate-800 bg-black/40 p-2 text-slate-300 hover:text-slate-100 hover:border-slate-700"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5">
          <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Reason (required)</div>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g., SANDBOX cleanup / test data removal"
            className="mt-2 w-full min-h-[110px] resize-none rounded-2xl border border-slate-800 bg-black/40 px-3 py-3 text-sm text-slate-200 placeholder:text-slate-600 outline-none focus:border-amber-500/30"
          />

          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              onClick={onCancel}
              className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-950/40 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:border-slate-700"
              disabled={busy}
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              disabled={busy || confirmDisabled}
              className={cx(
                "inline-flex items-center gap-2 rounded-full border px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition",
                busy || confirmDisabled
                  ? "border-slate-900 bg-black/20 text-slate-600 cursor-not-allowed"
                  : "border-red-900/60 bg-red-950/30 text-red-200 hover:border-red-700/70"
              )}
              title={confirmDisabled ? "Reason required." : confirmLabel}
            >
              <Trash2 className="h-4 w-4" />
              {busy ? "Working..." : confirmLabel}
            </button>
          </div>

          <div className="mt-4 rounded-2xl border border-slate-900 bg-black/20 p-3 text-xs text-slate-400">
            Ledger rows remain immutable. This only deletes the linked draft/envelope using your existing SECURITY DEFINER cleanup functions.
          </div>
        </div>
      </div>
    </div>
  );
}

export default function DraftsApprovalsClient() {
  const supabase = useMemo(() => supabaseBrowser(), []);

  // OS entity selector context (do NOT assume shape)
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
      const type = (r.record_type || "").toString().toLowerCase();
      const desc = (r.description || "").toString().toLowerCase();
      const ek = (r.entity_key || "").toString().toLowerCase();
      return (
        title.includes(term) ||
        type.includes(term) ||
        desc.includes(term) ||
        st.includes(term) ||
        ek.includes(term)
      );
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
    for (const r of records) c[normalizedStatus(r)] += 1;
    return c;
  }, [records]);

  const scopeQuery = useMemo(() => {
    // Keep for nav UX (not relied on for filtering)
    return scopedEntityId ? `?entity_id=${encodeURIComponent(scopedEntityId)}` : "";
  }, [scopedEntityId]);

  // --- Delete modals (Ledger immutable; delete linked draft/envelope only)
  const [draftModalOpen, setDraftModalOpen] = useState(false);
  const [envModalOpen, setEnvModalOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    setErr(null);

    try {
      // v2 view (non-test + enriched)
      const sel = [
        "id",
        "entity_id",
        "entity_key",
        "title",
        "description",
        "record_type",
        "record_no",
        "status",
        "approved",
        "archived",
        "created_at",
        "is_test",
        "draft_id",
        "envelope_id",
        "signer_url",
        "viewer_url",
        "verify_url",
        "certificate_url",
      ].join(",");

      let query = supabase.from("v_governance_ledger_scoped_v2").select(sel);

      // Real fix: entity scoped via entity_id
      if (scopedEntityId) query = query.eq("entity_id", scopedEntityId);

      query = query.order("created_at", { ascending: false });

      const { data, error } = await query;
      if (error) throw error;

      const list = (data ?? []) as unknown as LedgerRecord[];
      setRecords(list);

      if (!selectedId && list.length) setSelectedId(list[0]!.id);
    } catch (e: any) {
      setErr(e?.message ?? "Failed to load v_governance_ledger_scoped_v2.");
      setRecords([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Auth gating belongs to OS layout — do NOT redirect here.
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedEntityId]);

  const st: TabKey = selected ? normalizedStatus(selected) : "drafted";
  const canOpenForge = !!selected && (st === "approved" || st === "signing" || st === "signed");
  const canArchiveNow = !!selected && st === "signed";
  const canOpenArchive = !!selected && (st === "archived" || st === "signed" || st === "signing");

  const openInForgeHref = selected ? `/ci-forge?record_id=${encodeURIComponent(selected.id)}` : "#";
  const openInArchiveHref = selected ? `/ci-archive/minute-book${scopeQuery}` : "#";

  const canDeleteDraft = !!selected && !!selected.draft_id;
  const canDeleteEnvelope = !!selected && !!selected.envelope_id;

  async function doDeleteDraft() {
    if (!selected?.draft_id) return;
    const trimmed = reason.trim();
    if (!trimmed) return;

    setBusy(true);
    setErr(null);

    try {
      // IMPORTANT: ledger is immutable. This deletes the linked draft only.
      // Adjust param names if your function signature differs.
      const { data, error } = await supabase.rpc("owner_delete_governance_draft", {
        p_draft_id: selected.draft_id,
        p_reason: trimmed,
      } as any);

      if (error) throw error;

      // If your RPC returns { ok, ... } you can inspect it, but we keep it simple.
      setDraftModalOpen(false);
      setReason("");
      await load();
    } catch (e: any) {
      setErr(e?.message ?? "Delete Draft failed.");
    } finally {
      setBusy(false);
    }
  }

  async function doDeleteEnvelope() {
    if (!selected?.envelope_id) return;
    const trimmed = reason.trim();
    if (!trimmed) return;

    setBusy(true);
    setErr(null);

    try {
      // Deletes the envelope (test cleanup) using SECURITY DEFINER.
      // Adjust param names if your function signature differs.
      const { data, error } = await supabase.rpc("owner_delete_signature_envelope", {
        p_envelope_id: selected.envelope_id,
        p_reason: trimmed,
      } as any);

      if (error) throw error;

      setEnvModalOpen(false);
      setReason("");
      await load();
    } catch (e: any) {
      setErr(e?.message ?? "Delete Envelope failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      {/* Header under OS bar */}
      <div className="mb-4 shrink-0">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">CI-ARCHIVE</div>
        <p className="mt-1 text-[11px] text-slate-400">
          Drafts &amp; Approvals •{" "}
          <span className="font-semibold text-slate-200">Lifecycle surface</span> • Entity-scoped via OS selector
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
                Council decides execution mode. Forge is signature-only. Archive is registry of record.
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <div className="hidden md:block text-[10px] uppercase tracking-[0.22em] text-slate-500">
                Source • <span className="text-slate-300">v_governance_ledger_scoped_v2</span>
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
                              {r.entity_key && (
                                <div className="mt-1 text-[10px] uppercase tracking-[0.22em] text-slate-600">
                                  {r.entity_key}
                                </div>
                              )}
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
                              Status: <span className="text-slate-200">{normalizedStatus(selected)}</span>
                            </span>
                            <span>
                              Created: <span className="text-slate-200">{formatDate(selected.created_at)}</span>
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
                            {selected.entity_key && (
                              <span>
                                Entity: <span className="text-slate-200">{selected.entity_key}</span>
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
                          <div className="mt-1 text-slate-200">{selected.approved ? "Yes" : "No"}</div>
                        </div>

                        <div className="rounded-2xl border border-slate-900 bg-black/20 p-3">
                          <div className="text-[11px] text-slate-500">Archived</div>
                          <div className="mt-1 text-slate-200">{selected.archived ? "Yes" : "No"}</div>
                        </div>

                        <div className="col-span-2 rounded-2xl border border-slate-900 bg-black/20 p-3">
                          <div className="text-[11px] text-slate-500">Discipline</div>
                          <div className="mt-1 text-slate-200">
                            Approval ≠ archived. Both execution paths yield archive-quality artifacts (PDF + hash + registry entry).
                          </div>
                        </div>
                      </div>
                    </div>

                    {(selected.signer_url || selected.verify_url || selected.certificate_url) && (
                      <div className="rounded-3xl border border-slate-900 bg-black/20 p-4">
                        <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Portal links</div>
                        <div className="mt-3 flex flex-col gap-2 text-sm">
                          {selected.signer_url && (
                            <a
                              href={selected.signer_url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center justify-between gap-3 rounded-2xl border border-slate-900 bg-black/20 px-3 py-2 text-slate-200 hover:border-amber-500/30"
                            >
                              <span className="inline-flex items-center gap-2">
                                <ExternalLink className="h-4 w-4" />
                                Signer / Wet-ink portal
                              </span>
                              <ArrowRight className="h-4 w-4" />
                            </a>
                          )}
                          {selected.verify_url && (
                            <a
                              href={selected.verify_url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center justify-between gap-3 rounded-2xl border border-slate-900 bg-black/20 px-3 py-2 text-slate-200 hover:border-amber-500/30"
                            >
                              <span className="inline-flex items-center gap-2">
                                <FileCheck2 className="h-4 w-4" />
                                Verify
                              </span>
                              <ArrowRight className="h-4 w-4" />
                            </a>
                          )}
                          {selected.certificate_url && (
                            <a
                              href={selected.certificate_url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center justify-between gap-3 rounded-2xl border border-slate-900 bg-black/20 px-3 py-2 text-slate-200 hover:border-amber-500/30"
                            >
                              <span className="inline-flex items-center gap-2">
                                <Shield className="h-4 w-4" />
                                Certificate receipt
                              </span>
                              <ArrowRight className="h-4 w-4" />
                            </a>
                          )}
                        </div>
                      </div>
                    )}

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
                      <div className="text-[11px] text-slate-400">Context-aware CTAs + cleanup</div>
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

                  {/* Cleanup */}
                  <div className="mt-4 pt-3 border-t border-slate-900">
                    <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Cleanup</div>
                    <button
                      onClick={() => {
                        setErr(null);
                        setReason("");
                        setDraftModalOpen(true);
                      }}
                      disabled={!canDeleteDraft}
                      className={cx(
                        "mt-2 w-full inline-flex items-center justify-between gap-3 rounded-2xl border px-3 py-2 text-sm transition",
                        canDeleteDraft
                          ? "border-red-900/50 bg-red-950/20 text-red-200 hover:border-red-700/60"
                          : "border-slate-900 bg-black/20 text-slate-600 cursor-not-allowed"
                      )}
                      title={canDeleteDraft ? "Delete linked CI-Alchemy draft (ledger stays)." : "No linked draft_id on this ledger row."}
                    >
                      <span className="inline-flex items-center gap-2">
                        <Trash2 className="h-4 w-4" />
                        Delete Draft
                      </span>
                      <ArrowRight className="h-4 w-4" />
                    </button>

                    <button
                      onClick={() => {
                        setErr(null);
                        setReason("");
                        setEnvModalOpen(true);
                      }}
                      disabled={!canDeleteEnvelope}
                      className={cx(
                        "mt-2 w-full inline-flex items-center justify-between gap-3 rounded-2xl border px-3 py-2 text-sm transition",
                        canDeleteEnvelope
                          ? "border-red-900/50 bg-red-950/20 text-red-200 hover:border-red-700/60"
                          : "border-slate-900 bg-black/20 text-slate-600 cursor-not-allowed"
                      )}
                      title={canDeleteEnvelope ? "Delete linked signature envelope (ledger stays)." : "No envelope_id on this ledger row."}
                    >
                      <span className="inline-flex items-center gap-2">
                        <Trash2 className="h-4 w-4" />
                        Delete Envelope
                      </span>
                      <ArrowRight className="h-4 w-4" />
                    </button>

                    <div className="mt-3 rounded-2xl border border-slate-900 bg-black/20 p-3 text-xs text-slate-400">
                      No governance_ledger deletes — constitutional memory.
                    </div>
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
                    This is where summaries / risk notes / compliance cautions render once AXIOM is wired for the selected record.
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

      {/* Modals */}
      <DangerModal
        open={draftModalOpen}
        title="Delete linked draft?"
        subtitle="This removes the CI-Alchemy draft that created/linked to this ledger record. Ledger stays immutable."
        confirmLabel="Delete Draft"
        confirmDisabled={!reason.trim() || !canDeleteDraft}
        reason={reason}
        setReason={setReason}
        onCancel={() => {
          if (!busy) {
            setDraftModalOpen(false);
            setReason("");
          }
        }}
        onConfirm={doDeleteDraft}
        busy={busy}
      />

      <DangerModal
        open={envModalOpen}
        title="Delete linked envelope?"
        subtitle="This deletes the signature envelope (test cleanup). Ledger stays immutable."
        confirmLabel="Delete Envelope"
        confirmDisabled={!reason.trim() || !canDeleteEnvelope}
        reason={reason}
        setReason={setReason}
        onCancel={() => {
          if (!busy) {
            setEnvModalOpen(false);
            setReason("");
          }
        }}
        onConfirm={doDeleteEnvelope}
        busy={busy}
      />
    </div>
  );
}
