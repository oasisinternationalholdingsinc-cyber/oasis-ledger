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
  AlertTriangle,
  PenTool,
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

  // from scoped view
  entity_key: string | null;

  title: string | null;
  description?: string | null;

  record_type?: string | null;
  record_no?: string | null;

  status: LedgerStatus | null;
  approved?: boolean | null;
  archived?: boolean | null;

  created_at: string | null;

  source?: string | null;

  envelope_id?: string | null;
  document_id?: string | null;

  signer_url?: string | null;
  viewer_url?: string | null;
  verify_url?: string | null;
  certificate_url?: string | null;
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

function ConfirmModal({
  open,
  title,
  subtitle,
  dangerLabel,
  onCancel,
  onConfirm,
  busy,
}: {
  open: boolean;
  title: string;
  subtitle: string;
  dangerLabel: string;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
  busy?: boolean;
}) {
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (open) setReason("");
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 px-4">
      <div className="w-full max-w-[560px] rounded-3xl border border-slate-800 bg-black/90 shadow-[0_0_80px_rgba(0,0,0,0.65)] overflow-hidden">
        <div className="p-5 border-b border-slate-900">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-2">
              <AlertTriangle className="h-5 w-5 text-amber-200" />
            </div>
            <div className="min-w-0">
              <div className="text-base font-semibold text-slate-50">{title}</div>
              <div className="mt-1 text-sm text-slate-400">{subtitle}</div>
            </div>
          </div>
        </div>

        <div className="p-5">
          <label className="block text-[11px] uppercase tracking-[0.22em] text-slate-500">
            Reason (required)
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="mt-2 w-full min-h-[110px] rounded-2xl border border-slate-800 bg-black/40 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 outline-none focus:border-amber-500/30"
            placeholder="Why are you deleting this? (e.g., SANDBOX cleanup, routing test, duplicate record...)"
          />

          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              onClick={onCancel}
              className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-950/40 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:border-slate-700"
              disabled={!!busy}
            >
              Cancel
            </button>
            <button
              onClick={() => onConfirm(reason.trim())}
              disabled={!!busy || reason.trim().length < 4}
              className={cx(
                "inline-flex items-center gap-2 rounded-full border px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition",
                !!busy || reason.trim().length < 4
                  ? "border-red-900/40 bg-red-950/20 text-red-200/40 cursor-not-allowed"
                  : "border-red-500/30 bg-red-500/15 text-red-200 hover:border-red-400/40"
              )}
            >
              <Trash2 className="h-4 w-4" />
              {busy ? "Deleting…" : dangerLabel}
            </button>
          </div>

          <div className="mt-3 text-xs text-slate-500">
            Ledger rows are immutable. This action only deletes the related <span className="text-slate-300">draft</span> or{" "}
            <span className="text-slate-300">envelope</span> (test cleanup / routing cleanup), using your existing SECURITY DEFINER functions.
          </div>
        </div>
      </div>
    </div>
  );
}

export default function DraftsApprovalsClient() {
  const supabase = useMemo(() => supabaseBrowser(), []);

  const entityCtx: any = useEntity() as any;
  const activeEntity = entityCtx?.activeEntity ?? null;

  // Prefer entity "key/slug" for the scoped view
  const scopedEntityKey: string =
    (activeEntity?.key ||
      activeEntity?.slug ||
      activeEntity?.entity_key ||
      activeEntity?.entity_slug ||
      "")?.toString() ?? "";

  const scopedEntityLabel: string =
    (activeEntity?.name || activeEntity?.label || activeEntity?.slug || activeEntity?.key || "")?.toString() ||
    (scopedEntityKey ? "selected" : "—");

  const [loading, setLoading] = useState(true);
  const [busyDelete, setBusyDelete] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [records, setRecords] = useState<LedgerRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [tab, setTab] = useState<TabKey>("all");
  const [q, setQ] = useState("");

  const [confirmDraftOpen, setConfirmDraftOpen] = useState(false);
  const [confirmEnvelopeOpen, setConfirmEnvelopeOpen] = useState(false);

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
      const entity = (r.entity_key || "").toLowerCase();
      return (
        title.includes(term) ||
        type.includes(term) ||
        desc.includes(term) ||
        st.includes(term) ||
        entity.includes(term)
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
    for (const r of records) {
      const st = normalizedStatus(r);
      c[st] += 1;
    }
    return c;
  }, [records]);

  const scopeQuery = useMemo(() => {
    // purely for navigation UX
    return scopedEntityKey ? `?entity_key=${encodeURIComponent(scopedEntityKey)}` : "";
  }, [scopedEntityKey]);

  async function load() {
    setLoading(true);
    setErr(null);

    try {
      // Pull from your scoped view (includes portal URLs when envelope_id exists)
      const sel =
        "id,entity_key,title,description,record_type,record_no,status,approved,archived,created_at,source,envelope_id,document_id,signer_url,viewer_url,verify_url,certificate_url";

      let query = supabase.from("v_governance_ledger_scoped").select(sel);

      // Entity scope
      if (scopedEntityKey) query = query.eq("entity_key", scopedEntityKey);

      query = query.order("created_at", { ascending: false });

      const { data, error } = await query;
      if (error) throw error;

      const list = (data ?? []) as LedgerRecord[];
      setRecords(list);

      if (!selectedId && list.length) setSelectedId(list[0]!.id);
      if (selectedId && list.length && !list.some((r) => r.id === selectedId)) {
        setSelectedId(list[0]!.id);
      }
    } catch (e: any) {
      setErr(e?.message ?? "Failed to load v_governance_ledger_scoped.");
      setRecords([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedEntityKey]);

  // CTA enablement logic
  const st: TabKey = selected ? normalizedStatus(selected) : "drafted";
  const canOpenForge = !!selected && (st === "approved" || st === "signing" || st === "signed");
  const canArchiveNow = !!selected && st === "signed"; // wiring later (kept safe)
  const canOpenArchive = !!selected && (st === "archived" || st === "signed" || st === "signing");

  const openInForgeHref = selected ? `/ci-forge?record_id=${encodeURIComponent(selected.id)}` : "#";
  const openInArchiveHref = selected ? `/ci-archive/minute-book${scopeQuery}` : "#";

  // Portal links (ceremonial signing flow)
  const canSignerPortal = !!selected?.signer_url;
  const canVerifyPortal = !!selected?.verify_url;
  const canCertificatePortal = !!selected?.certificate_url;
  const canViewerPortal = !!selected?.viewer_url;

  // Deletes (no governance_ledger deletes)
  const canDeleteEnvelope = !!selected?.envelope_id;
  const canDeleteDraftLink = !!selected; // we resolve draft via governance_drafts.finalized_record_id

  async function deleteEnvelope(reason: string) {
    if (!selected?.envelope_id) return;
    setBusyDelete(true);
    setErr(null);

    try {
      // Your function exists: owner_delete_signature_envelope (SECURITY DEFINER)
      // Best-guess parameter names:
      const { error } = await supabase.rpc("owner_delete_signature_envelope", {
        p_envelope_id: selected.envelope_id,
        p_reason: reason,
      });
      if (error) throw error;

      setConfirmEnvelopeOpen(false);
      await load();
    } catch (e: any) {
      setErr(e?.message ?? "Failed to delete envelope.");
    } finally {
      setBusyDelete(false);
    }
  }

  async function deleteDraft(reason: string) {
    if (!selected?.id) return;
    setBusyDelete(true);
    setErr(null);

    try {
      // Find the source draft that produced this ledger row:
      // governance_drafts.finalized_record_id -> governance_ledger.id
      const { data: draftRow, error: qErr } = await supabase
        .from("governance_drafts")
        .select("id")
        .eq("finalized_record_id", selected.id)
        .limit(1)
        .maybeSingle();

      if (qErr) throw qErr;
      if (!draftRow?.id) {
        throw new Error("No linked draft found for this ledger record (finalized_record_id lookup returned none).");
      }

      // Your function exists: owner_delete_governance_draft (SECURITY DEFINER)
      // Best-guess parameter names:
      const { error: delErr } = await supabase.rpc("owner_delete_governance_draft", {
        p_draft_id: draftRow.id,
        p_reason: reason,
      });
      if (delErr) throw delErr;

      setConfirmDraftOpen(false);
      await load();
    } catch (e: any) {
      setErr(e?.message ?? "Failed to delete draft.");
    } finally {
      setBusyDelete(false);
    }
  }

  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      <ConfirmModal
        open={confirmDraftOpen}
        title="Delete linked draft?"
        subtitle="This removes the CI-Alchemy draft that created this ledger record. Ledger row remains immutable."
        dangerLabel="Delete Draft"
        onCancel={() => setConfirmDraftOpen(false)}
        onConfirm={deleteDraft}
        busy={busyDelete}
      />
      <ConfirmModal
        open={confirmEnvelopeOpen}
        title="Delete signature envelope?"
        subtitle="This removes the CI-Forge envelope (and related signer parties). Ledger row remains immutable."
        dangerLabel="Delete Envelope"
        onCancel={() => setConfirmEnvelopeOpen(false)}
        onConfirm={deleteEnvelope}
        busy={busyDelete}
      />

      {/* Header under OS bar */}
      <div className="mb-4 shrink-0">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">CI-ARCHIVE</div>
        <p className="mt-1 text-[11px] text-slate-400">
          Drafts &amp; Approvals • <span className="font-semibold text-slate-200">Lifecycle surface</span> • Scoped via OS selector
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
                Council decides execution mode. Forge = signature-only execution. Archive = registry of record.
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <div className="hidden md:block text-[10px] uppercase tracking-[0.22em] text-slate-500">
                Source • <span className="text-slate-300">v_governance_ledger_scoped</span>
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
                    {!scopedEntityKey && (
                      <div className="mt-2 text-[11px] text-amber-200/90">
                        Note: no entity_key found — loading unscoped.
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
                  <TabButton
                    active={tab === "drafted"}
                    label="Drafted"
                    count={counts.drafted}
                    onClick={() => setTab("drafted")}
                  />
                  <TabButton
                    active={tab === "pending"}
                    label="Pending"
                    count={counts.pending}
                    onClick={() => setTab("pending")}
                  />
                  <TabButton
                    active={tab === "approved"}
                    label="Approved"
                    count={counts.approved}
                    onClick={() => setTab("approved")}
                  />
                  <TabButton
                    active={tab === "signing"}
                    label="Signing"
                    count={counts.signing}
                    onClick={() => setTab("signing")}
                  />
                  <TabButton
                    active={tab === "signed"}
                    label="Signed"
                    count={counts.signed}
                    onClick={() => setTab("signed")}
                  />
                  <TabButton
                    active={tab === "archived"}
                    label="Archived"
                    count={counts.archived}
                    onClick={() => setTab("archived")}
                  />
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
                            Approval ≠ archived. Both execution modes must yield archive-quality artifacts (PDF + hash + registry entry).
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

                    {(canSignerPortal || canVerifyPortal || canCertificatePortal || canViewerPortal) && (
                      <div className="rounded-3xl border border-slate-900 bg-black/25 p-4">
                        <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Portals</div>
                        <div className="mt-3 grid grid-cols-2 gap-2">
                          <a
                            href={canSignerPortal ? (selected.signer_url as string) : undefined}
                            target="_blank"
                            rel="noreferrer"
                            className={cx(
                              "inline-flex items-center justify-between gap-2 rounded-2xl border px-3 py-2 text-sm transition",
                              canSignerPortal
                                ? "border-slate-800 bg-black/40 text-slate-100 hover:border-amber-500/30"
                                : "border-slate-900 bg-black/20 text-slate-600 pointer-events-none"
                            )}
                            title="Signer portal"
                          >
                            <span className="inline-flex items-center gap-2">
                              <PenTool className="h-4 w-4" />
                              Signer
                            </span>
                            <ExternalLink className="h-4 w-4" />
                          </a>

                          <a
                            href={canViewerPortal ? (selected.viewer_url as string) : undefined}
                            target="_blank"
                            rel="noreferrer"
                            className={cx(
                              "inline-flex items-center justify-between gap-2 rounded-2xl border px-3 py-2 text-sm transition",
                              canViewerPortal
                                ? "border-slate-800 bg-black/40 text-slate-100 hover:border-amber-500/30"
                                : "border-slate-900 bg-black/20 text-slate-600 pointer-events-none"
                            )}
                            title="Viewer portal"
                          >
                            <span className="inline-flex items-center gap-2">
                              <ExternalLink className="h-4 w-4" />
                              Viewer
                            </span>
                            <ExternalLink className="h-4 w-4" />
                          </a>

                          <a
                            href={canVerifyPortal ? (selected.verify_url as string) : undefined}
                            target="_blank"
                            rel="noreferrer"
                            className={cx(
                              "inline-flex items-center justify-between gap-2 rounded-2xl border px-3 py-2 text-sm transition",
                              canVerifyPortal
                                ? "border-slate-800 bg-black/40 text-slate-100 hover:border-amber-500/30"
                                : "border-slate-900 bg-black/20 text-slate-600 pointer-events-none"
                            )}
                            title="Verify portal"
                          >
                            <span className="inline-flex items-center gap-2">
                              <FileCheck2 className="h-4 w-4" />
                              Verify
                            </span>
                            <ExternalLink className="h-4 w-4" />
                          </a>

                          <a
                            href={canCertificatePortal ? (selected.certificate_url as string) : undefined}
                            target="_blank"
                            rel="noreferrer"
                            className={cx(
                              "inline-flex items-center justify-between gap-2 rounded-2xl border px-3 py-2 text-sm transition",
                              canCertificatePortal
                                ? "border-amber-500/25 bg-amber-500/10 text-amber-100 hover:border-amber-500/40"
                                : "border-slate-900 bg-black/20 text-slate-600 pointer-events-none"
                            )}
                            title="Certificate portal"
                          >
                            <span className="inline-flex items-center gap-2">
                              <Shield className="h-4 w-4" />
                              Certificate
                            </span>
                            <ExternalLink className="h-4 w-4" />
                          </a>
                        </div>

                        <div className="mt-3 text-xs text-slate-500">
                          This is the “ceremonial” surface: review → sign → verify → certificate receipt.
                        </div>
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
                    title={canArchiveNow ? "Archive signed artifact (wiring later)." : "Archive is available once signed."}
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
                    title={canOpenArchive ? "Open CI-Archive registry" : "Available after signing / archival."}
                  >
                    <span className="inline-flex items-center gap-2">
                      <ExternalLink className="h-4 w-4" />
                      Open in CI-Archive
                    </span>
                    <ArrowRight className="h-4 w-4" />
                  </Link>

                  {/* DELETE CONTROLS (tests cleanup) */}
                  <div className="mt-3 rounded-2xl border border-slate-900 bg-black/20 p-3">
                    <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Cleanup</div>
                    <div className="mt-2 space-y-2">
                      <button
                        onClick={() => setConfirmDraftOpen(true)}
                        disabled={!selected || busyDelete || !canDeleteDraftLink}
                        className={cx(
                          "w-full inline-flex items-center justify-between gap-3 rounded-2xl border px-3 py-2 text-sm transition",
                          selected && canDeleteDraftLink && !busyDelete
                            ? "border-red-500/20 bg-red-500/10 text-red-100 hover:border-red-400/30"
                            : "border-slate-900 bg-black/20 text-slate-600 cursor-not-allowed"
                        )}
                        title="Delete the linked CI-Alchemy draft (ledger row remains)."
                      >
                        <span className="inline-flex items-center gap-2">
                          <Trash2 className="h-4 w-4" />
                          Delete Draft
                        </span>
                        <ArrowRight className="h-4 w-4" />
                      </button>

                      <button
                        onClick={() => setConfirmEnvelopeOpen(true)}
                        disabled={!selected || busyDelete || !canDeleteEnvelope}
                        className={cx(
                          "w-full inline-flex items-center justify-between gap-3 rounded-2xl border px-3 py-2 text-sm transition",
                          selected && canDeleteEnvelope && !busyDelete
                            ? "border-red-500/20 bg-red-500/10 text-red-100 hover:border-red-400/30"
                            : "border-slate-900 bg-black/20 text-slate-600 cursor-not-allowed"
                        )}
                        title="Delete the CI-Forge envelope (ledger row remains)."
                      >
                        <span className="inline-flex items-center gap-2">
                          <Trash2 className="h-4 w-4" />
                          Delete Envelope
                        </span>
                        <ArrowRight className="h-4 w-4" />
                      </button>

                      <div className="text-xs text-slate-500">
                        No governance_ledger deletes — constitutional memory stays intact.
                      </div>
                    </div>
                  </div>

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
                    Wire AXIOM outputs here (summary / risk notes / compliance cautions) for the selected record.
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
