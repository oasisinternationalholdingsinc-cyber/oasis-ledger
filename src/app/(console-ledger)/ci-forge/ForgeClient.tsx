"use client";
export const dynamic = "force-dynamic";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";
import { ShieldCheck, Search, ArrowLeft } from "lucide-react";

type ForgeQueueItem = {
  ledger_id: string;
  title: string;
  ledger_status: string;
  created_at: string;

  entity_id: string;
  entity_name: string;
  entity_slug: string;

  envelope_id: string | null;
  envelope_status: string | null;

  parties_total: number | null;
  parties_signed: number | null;
  last_signed_at: string | null;
  days_since_last_signature: number | null;

  is_test?: boolean | null;
};

type StartSignatureResponse = {
  ok: boolean;
  envelope_id?: string;
  record_id?: string;
  entity_slug?: string;
  reused?: boolean;
  error?: string;
};

type SendInviteResponse = {
  ok: boolean;
  message?: string;
  error?: string;
};

type ArchiveSignedResolutionResponse = {
  ok: boolean;
  minute_book_entry_id?: string;
  governance_document_id?: string;
  already_archived?: boolean;
  error?: string;
};

type ArchiveSaveDocumentResponse = {
  ok: boolean;
  minute_book_entry_id?: string;
  verified_document_id?: string;
  already_archived?: boolean;
  repaired?: boolean;
  error?: string;
};

type AxiomReviewResponse = {
  ok: boolean;
  record_id?: string;
  summary_id?: string | null;
  analysis_id?: string | null;
  advice_id?: string | null;
  compliance_review_id?: string | null;
  message?: string;
  error?: string;
};

type RiskLevel = "GREEN" | "AMBER" | "RED" | "IDLE";

// ✅ add Archived tab (SQL-backed)
type TabKey = "active" | "completed" | "archived";

type AxiomTab = "advisory" | "summary" | "analysis" | "advice";
type RightTab = "evidence" | "axiom" | "portal" | "notes";

type AxiomLatest = {
  summary?: { id: string; summary: string | null; generated_at: string | null; model: string | null } | null;
  analysis?: { id: string; analysis: string | null; generated_at: string | null; model: string | null } | null;
  advice?:
    | { id: string; advice: string | null; recommendation: string | null; generated_at: string | null; model: string | null }
    | null;
};

type PortalUrls = {
  signer_url?: string | null;
  viewer_url?: string | null;
  verify_url?: string | null;
  certificate_url?: string | null;
};

type ArchiveEvidence = {
  minute_book_entry_id: string | null;
  minute_book_title: string | null;
  minute_book_is_test: boolean | null;
  minute_book_storage_path: string | null;
  supporting_docs: Array<{
    id: string;
    doc_type: string | null;
    file_path: string | null;
    file_name: string | null;
    file_hash: string | null;
    mime_type: string | null;
    file_size: number | null;
    uploaded_at: string | null;
    signature_envelope_id: string | null;
    verified: boolean | null;
    registry_visible: boolean | null;
  }>;
  verified_document: null | {
    id: string;
    storage_bucket: string | null;
    storage_path: string | null;
    file_hash: string | null;
    verification_level: string | null;
    created_at: string | null;
  };
};

function fmt(iso: string | null | undefined) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function clamp(s: string, n: number) {
  const t = (s ?? "").trim();
  if (!t) return "";
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function cx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

async function extractFnError(err: any): Promise<string> {
  try {
    const anyErr = err as any;
    const ctx = anyErr?.context;
    const resp: Response | undefined = ctx?.response;
    if (resp && typeof resp.text === "function") {
      const t = await resp.text();
      if (t?.trim()) return t;
    }
  } catch {}
  return err?.message || "Request failed.";
}

function inferStep(item: ForgeQueueItem | null) {
  if (!item) return 0;
  if (!item.envelope_id) return 0;
  if (item.envelope_status === "completed") return 3;
  return 2;
}

function Modal({
  open,
  title,
  description,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmTone = "amber",
  confirmDisabled,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description?: string;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmTone?: "amber" | "emerald" | "cyan" | "slate";
  confirmDisabled?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  if (!open) return null;

  const tone =
    confirmTone === "emerald"
      ? "bg-emerald-500 text-black hover:bg-emerald-400"
      : confirmTone === "cyan"
      ? "bg-cyan-500/15 text-cyan-100 border border-cyan-500/40 hover:bg-cyan-500/20"
      : confirmTone === "slate"
      ? "bg-slate-100 text-slate-950 hover:bg-white"
      : "bg-amber-500/15 text-amber-100 border border-amber-500/40 hover:bg-amber-500/20";

  const confirmCls =
    confirmTone === "emerald"
      ? "bg-emerald-500 text-black hover:bg-emerald-400"
      : confirmTone === "slate"
      ? "bg-slate-100 text-slate-950 hover:bg-white"
      : tone;

  return (
    <div className="fixed inset-0 z-[60]">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div className="absolute inset-0 flex items-end sm:items-center justify-center p-3 sm:p-6">
        <div className="w-full max-w-[720px] rounded-3xl border border-slate-800 bg-black/80 shadow-[0_0_70px_rgba(15,23,42,0.85)]">
          <div className="px-5 sm:px-6 py-4 border-b border-slate-800">
            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Action</div>
            <div className="mt-1 text-base font-semibold text-slate-100">{title}</div>
            {description ? <div className="mt-1 text-[12px] text-slate-400">{description}</div> : null}
          </div>

          <div className="px-5 sm:px-6 py-4">{children}</div>

          <div className="px-5 sm:px-6 py-4 border-t border-slate-800 flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-800 bg-slate-950/40 px-4 py-2 text-[12px] font-semibold text-slate-200 hover:border-slate-700 hover:bg-slate-950/55 transition"
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={confirmDisabled}
              className={cx(
                "rounded-xl px-4 py-2 text-[12px] font-semibold tracking-[0.18em] uppercase transition",
                confirmTone === "emerald" ? confirmCls : cx("border", confirmCls),
                confirmDisabled ? "opacity-60 cursor-not-allowed" : ""
              )}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ForgeClient() {
  const { activeEntity } = useEntity();
  const { env } = useOsEnv();
  const isTest = env === "SANDBOX";

  const [tab, setTab] = useState<TabKey>("active");
  const [rightTab, setRightTab] = useState<RightTab>("evidence");
  const [axiomTab, setAxiomTab] = useState<AxiomTab>("advisory");

  // ✅ SQL-backed: latest queue + archived queue
  const [queueLatest, setQueueLatest] = useState<ForgeQueueItem[]>([]);
  const [queueArchived, setQueueArchived] = useState<ForgeQueueItem[]>([]);
  const [loadingQueue, setLoadingQueue] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [primarySignerName, setPrimarySignerName] = useState("");
  const [primarySignerEmail, setPrimarySignerEmail] = useState("");
  const [ccEmails, setCcEmails] = useState("");

  const [isStarting, setIsStarting] = useState(false);
  const [isSendingInvite, setIsSendingInvite] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);
  const [isResealing, setIsResealing] = useState(false);
  const [isOpeningArchive, setIsOpeningArchive] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [hideEnvelopes, setHideEnvelopes] = useState(false);

  const [axiomLoading, setAxiomLoading] = useState(false);
  const [axiomError, setAxiomError] = useState<string | null>(null);
  const [axiomInfo, setAxiomInfo] = useState<string | null>(null);
  const [axiomLatest, setAxiomLatest] = useState<AxiomLatest>({});

  const [portal, setPortal] = useState<PortalUrls>({});
  const [portalError, setPortalError] = useState<string | null>(null);

  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<ArchiveEvidence>({
    minute_book_entry_id: null,
    minute_book_title: null,
    minute_book_is_test: null,
    minute_book_storage_path: null,
    supporting_docs: [],
    verified_document: null,
  });

  const [startModalOpen, setStartModalOpen] = useState(false);
  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  const [archiveModalOpen, setArchiveModalOpen] = useState(false);
  const [resealModalOpen, setResealModalOpen] = useState(false);

  // ✅ FRONTEND-ONLY: keep recently archived/sealed record visible even if view stops returning it immediately
  const [pinned, setPinned] = useState<ForgeQueueItem | null>(null);

  useEffect(() => {
    setPinned(null);
  }, [activeEntity, isTest]);

  const shell =
    "rounded-3xl border border-white/10 bg-black/20 shadow-[0_28px_120px_rgba(0,0,0,0.55)] overflow-hidden";
  const header =
    "border-b border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent px-4 sm:px-6 py-4 sm:py-5";
  const body = "px-4 sm:px-6 py-5 sm:py-6";

  const isCompleted = (item: ForgeQueueItem) => item.envelope_status === "completed";
  const isArchived = (item: ForgeQueueItem) => (item.ledger_status || "").toUpperCase() === "ARCHIVED";

  const selectCols = [
    "ledger_id",
    "title",
    "ledger_status",
    "created_at",
    "entity_id",
    "entity_name",
    "entity_slug",
    "envelope_id",
    "envelope_status",
    "parties_total",
    "parties_signed",
    "last_signed_at",
    "days_since_last_signature",
    "is_test",
  ].join(", ");

  async function fetchQueues() {
    setLoadingQueue(true);
    setError(null);
    setInfo(null);

    try {
      // ✅ Active + Completed: latest view
      const latestP = supabase
        .from("v_forge_queue_latest")
        .select(selectCols)
        .eq("entity_slug", activeEntity)
        .eq("is_test", isTest)
        .order("created_at", { ascending: false });

      // ✅ Archived tab: archived view (SQL-backed)
      const archivedP = supabase
        .from("v_forge_queue_archived")
        .select(selectCols)
        .eq("entity_slug", activeEntity)
        .eq("is_test", isTest)
        .order("created_at", { ascending: false });

      const [latestR, archivedR] = await Promise.all([latestP, archivedP]);

      if (latestR.error) {
        console.error("CI-Forge latest queue error:", latestR.error);
        setQueueLatest([]);
        setSelectedId(null);
        setError("Unable to load Forge queue for this entity/environment.");
        return;
      }

      if (archivedR.error) {
        // Non-fatal: keep Forge functional even if archived view is temporarily unavailable
        console.warn("CI-Forge archived queue error:", archivedR.error);
        setQueueArchived([]);
      } else {
        setQueueArchived((((archivedR.data ?? []) as unknown) as ForgeQueueItem[]) ?? []);
      }

      const latestRows = ((((latestR.data ?? []) as unknown) as ForgeQueueItem[]) ?? []);
      setQueueLatest(latestRows);

      // Default selection: first item in current tab (after memo below runs)
      setSelectedId((prev) => prev ?? latestRows[0]?.ledger_id ?? null);
    } catch (err) {
      console.error("CI-Forge fetchQueues exception:", err);
      setQueueLatest([]);
      setQueueArchived([]);
      setSelectedId(null);
      setError("Unable to load Forge queue for this entity/environment.");
    } finally {
      setLoadingQueue(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      await fetchQueues();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEntity, isTest]);

  const activeQueueRaw = useMemo(() => queueLatest.filter((q) => !isCompleted(q)), [queueLatest]);
  const completedQueueRaw = useMemo(() => queueLatest.filter((q) => isCompleted(q) && !isArchived(q)), [queueLatest]);
  const archivedQueueSqlRaw = useMemo(() => queueArchived, [queueArchived]);

  const activeQueue = useMemo(() => {
    if (!hideEnvelopes) return activeQueueRaw;
    return activeQueueRaw.filter((q) => !q.envelope_id);
  }, [activeQueueRaw, hideEnvelopes]);

  const completedQueue = useMemo(() => {
    const base = completedQueueRaw;
    if (!pinned) return base;
    if (pinned.is_test !== isTest) return base;
    if (pinned.entity_slug !== activeEntity) return base;
    if (base.some((x) => x.ledger_id === pinned.ledger_id)) return base;
    if (isArchived(pinned)) return base; // don't pin archived into Completed
    return [pinned, ...base];
  }, [completedQueueRaw, pinned, isTest, activeEntity]);

  const archivedQueue = useMemo(() => {
    const base = archivedQueueSqlRaw;
    if (!pinned) return base;
    if (pinned.is_test !== isTest) return base;
    if (pinned.entity_slug !== activeEntity) return base;
    if (base.some((x) => x.ledger_id === pinned.ledger_id)) return base;
    if (!isArchived(pinned)) return base;
    return [pinned, ...base];
  }, [archivedQueueSqlRaw, pinned, isTest, activeEntity]);

  const visibleQueue = tab === "active" ? activeQueue : tab === "archived" ? archivedQueue : completedQueue;

  useEffect(() => {
    setSelectedId(visibleQueue[0]?.ledger_id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, activeEntity, isTest, hideEnvelopes]);

  const selected = visibleQueue.find((q) => q.ledger_id === selectedId) ?? visibleQueue[0] ?? null;

  useEffect(() => {
    setPortal({});
    setPortalError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.ledger_id]);

  const envelopeLocked =
    !!selected?.envelope_status &&
    selected.envelope_status !== "cancelled" &&
    selected.envelope_status !== "expired";

  const computeRiskLevel = (item: ForgeQueueItem): RiskLevel => {
    const days = item.days_since_last_signature ?? null;
    const status = item.envelope_status;

    if (!status || status === "draft" || status === "pending") {
      if (days == null) return "IDLE";
      if (days >= 7) return "RED";
      if (days >= 3) return "AMBER";
      return "GREEN";
    }

    if (status === "completed") {
      if (days != null && days >= 7) return "AMBER";
      return "GREEN";
    }

    if (status === "cancelled" || status === "expired") return "IDLE";

    if (days == null) return "GREEN";
    if (days >= 7) return "RED";
    if (days >= 3) return "AMBER";
    return "GREEN";
  };

  const riskLightClasses = (risk: RiskLevel) => {
    switch (risk) {
      case "GREEN":
        return "bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.9)]";
      case "AMBER":
        return "bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.9)]";
      case "RED":
        return "bg-rose-500 shadow-[0_0_10px_rgba(248,113,113,0.9)]";
      default:
        return "bg-slate-500 shadow-[0_0_8px_rgba(148,163,184,0.9)]";
    }
  };

  const riskLabel = (risk: RiskLevel) => {
    if (risk === "RED") return "Stalled";
    if (risk === "AMBER") return "Slow";
    if (risk === "GREEN") return "Active";
    return "Idle";
  };

  const envPill = () => (
    <span
      className={cx(
        "rounded-full px-2 py-1 text-[10px] font-semibold tracking-[0.18em] uppercase border",
        isTest ? "border-amber-500/40 bg-amber-500/10 text-amber-200" : "border-sky-500/30 bg-sky-500/10 text-sky-200"
      )}
      title={isTest ? "SANDBOX (is_test=true)" : "RoT (is_test=false)"}
    >
      {isTest ? "SANDBOX" : "RoT"}
    </span>
  );

  function flashError(msg: string) {
    console.error(msg);
    setError(msg);
    setTimeout(() => setError(null), 6500);
  }

  function flashInfo(msg: string) {
    setInfo(msg);
    setTimeout(() => setInfo(null), 5200);
  }

  function flashAxiomError(msg: string) {
    console.error(msg);
    setAxiomError(msg);
    setTimeout(() => setAxiomError(null), 6500);
  }

  function flashAxiomInfo(msg: string) {
    setAxiomInfo(msg);
    setTimeout(() => setAxiomInfo(null), 5000);
  }

  async function refreshQueuesKeepSelection(keepLedgerId?: string | null) {
    try {
      const latestP = supabase
        .from("v_forge_queue_latest")
        .select(selectCols)
        .eq("entity_slug", activeEntity)
        .eq("is_test", isTest)
        .order("created_at", { ascending: false });

      const archivedP = supabase
        .from("v_forge_queue_archived")
        .select(selectCols)
        .eq("entity_slug", activeEntity)
        .eq("is_test", isTest)
        .order("created_at", { ascending: false });

      const [latestR, archivedR] = await Promise.all([latestP, archivedP]);

      if (!latestR.error) setQueueLatest(((((latestR.data ?? []) as unknown) as ForgeQueueItem[]) ?? []));
      if (!archivedR.error) setQueueArchived(((((archivedR.data ?? []) as unknown) as ForgeQueueItem[]) ?? []));

      if (keepLedgerId) {
        const latestRows = (((latestR.data ?? []) as unknown) as ForgeQueueItem[]) ?? [];
        const archivedRows = (((archivedR.data ?? []) as unknown) as ForgeQueueItem[]) ?? [];

        const inLatest = latestRows.some((x) => x.ledger_id === keepLedgerId);
        const inArchived = archivedRows.some((x) => x.ledger_id === keepLedgerId);

        if (!inLatest && !inArchived) {
          const prev =
            (selected && selected.ledger_id === keepLedgerId ? selected : null) ??
            (pinned && pinned.ledger_id === keepLedgerId ? pinned : null) ??
            null;

          if (prev) {
            setPinned(prev);
            if (isArchived(prev)) setTab("archived");
            else if (tab === "active") setTab("completed");
            setSelectedId(keepLedgerId);
            return;
          }
        }

        if (inArchived) {
          setTab("archived");
          setSelectedId(keepLedgerId);
          return;
        }

        // else: it’s in latest — choose tab based on status
        const row = latestRows.find((x) => x.ledger_id === keepLedgerId) ?? null;
        if (row) {
          if (!isCompleted(row)) setTab("active");
          else setTab("completed");
          setSelectedId(keepLedgerId);
          return;
        }
      }

      // fallback selection by current tab
      const latestRows = (((latestR.data ?? []) as unknown) as ForgeQueueItem[]) ?? [];
      const archivedRows = (((archivedR.data ?? []) as unknown) as ForgeQueueItem[]) ?? [];

      const next =
        tab === "active"
          ? latestRows.filter((r) => !isCompleted(r))
          : tab === "completed"
          ? latestRows.filter((r) => isCompleted(r) && !isArchived(r))
          : archivedRows;

      const nextFinal = tab === "active" && hideEnvelopes ? next.filter((r) => !r.envelope_id) : next;
      setSelectedId(nextFinal[0]?.ledger_id ?? null);
    } catch (e) {
      console.error("refreshQueuesKeepSelection error", e);
    }
  }

  // --------------------------
  // Portal URLs
  // --------------------------
  async function loadPortalUrls(envelopeId: string) {
    setPortalError(null);
    setPortal({});
    try {
      const tryRpc = async (fn: string, args: any) => supabase.rpc(fn as any, args as any);

      let r = await tryRpc("ci_portal_urls_rpc", { p_envelope_id: envelopeId });
      if (r.error) r = await tryRpc("ci_portal_urls_rpc", { envelope_id: envelopeId });
      if (r.error) r = await tryRpc("ci_portal_urls", { p_envelope_id: envelopeId });
      if (r.error) r = await tryRpc("ci_portal_urls", { envelope_id: envelopeId });

      if (r.error) {
        console.warn("Portal RPC error:", r.error);
        setPortalError("Portal URLs unavailable (RPC).");
        return;
      }

      const pu = (r.data as any) ?? {};
      const row = Array.isArray(pu) ? pu[0] : pu;

      setPortal({
        signer_url: row?.signer_url ?? row?.signer ?? null,
        viewer_url: row?.viewer_url ?? row?.viewer ?? null,
        verify_url: row?.verify_url ?? row?.verify ?? null,
        certificate_url: row?.certificate_url ?? row?.certificate ?? null,
      });
    } catch (e) {
      console.warn("loadPortalUrls exception:", e);
      setPortalError("Portal URLs unavailable.");
    }
  }

  useEffect(() => {
    if (!selected?.envelope_id) {
      setPortal({});
      setPortalError(null);
      return;
    }
    loadPortalUrls(selected.envelope_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.envelope_id]);

  // --------------------------
  // AXIOM latest
  // --------------------------
  async function loadAxiomLatest(recordId: string) {
    setAxiomError(null);
    try {
      const [s, a, adv] = await Promise.all([
        supabase
          .from("ai_summaries")
          .select("id, summary, generated_at, model")
          .eq("record_id", recordId)
          .order("generated_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("ai_analyses")
          .select("id, analysis, generated_at, model")
          .eq("record_id", recordId)
          .order("generated_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("ai_advice")
          .select("id, advice, recommendation, generated_at, model")
          .eq("record_id", recordId)
          .order("generated_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      if (s.error) console.warn("AXIOM latest summary load error:", s.error);
      if (a.error) console.warn("AXIOM latest analysis load error:", a.error);
      if (adv.error) console.warn("AXIOM latest advice load error:", adv.error);

      setAxiomLatest({
        summary: (s.data as any) ?? null,
        analysis: (a.data as any) ?? null,
        advice: (adv.data as any) ?? null,
      });
    } catch (e) {
      console.error("loadAxiomLatest exception", e);
      flashAxiomError("Unable to load AXIOM artifacts.");
    }
  }

  useEffect(() => {
    if (!selected?.ledger_id) {
      setAxiomLatest({});
      return;
    }
    loadAxiomLatest(selected.ledger_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.ledger_id]);

  // --------------------------
  // Archive Evidence loader
  // --------------------------
  async function loadArchiveEvidence(recordId: string) {
    setEvidenceLoading(true);
    setEvidenceError(null);

    try {
      const mbe = await supabase
        .from("minute_book_entries")
        .select("id, title, is_test, storage_path, created_at")
        .eq("source_record_id", recordId)
        .eq("is_test", isTest)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (mbe.error) console.warn("minute_book_entries evidence error", mbe.error);

      const minuteBookEntryId = (mbe.data as any)?.id ?? null;

      let supporting_docs: ArchiveEvidence["supporting_docs"] = [];
      if (minuteBookEntryId) {
        const sd = await supabase
          .from("supporting_documents")
          .select(
            "id, doc_type, file_path, file_name, file_hash, mime_type, file_size, uploaded_at, signature_envelope_id, verified, registry_visible"
          )
          .eq("entry_id", minuteBookEntryId)
          .order("uploaded_at", { ascending: false });

        if (sd.error) console.warn("supporting_documents evidence error", sd.error);
        else supporting_docs = ((sd.data ?? []) as any) ?? [];
      }

      const vd = await supabase
        .from("verified_documents")
        .select("id, storage_bucket, storage_path, file_hash, verification_level, created_at")
        .eq("source_record_id", recordId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (vd.error) console.warn("verified_documents evidence error", vd.error);

      setEvidence({
        minute_book_entry_id: minuteBookEntryId,
        minute_book_title: (mbe.data as any)?.title ?? null,
        minute_book_is_test: (mbe.data as any)?.is_test ?? null,
        minute_book_storage_path: (mbe.data as any)?.storage_path ?? null,
        supporting_docs,
        verified_document: (vd.data as any) ?? null,
      });
    } catch (e) {
      console.error("loadArchiveEvidence exception", e);
      setEvidenceError("Unable to load archive evidence.");
      setEvidence({
        minute_book_entry_id: null,
        minute_book_title: null,
        minute_book_is_test: null,
        minute_book_storage_path: null,
        supporting_docs: [],
        verified_document: null,
      });
    } finally {
      setEvidenceLoading(false);
    }
  }

  useEffect(() => {
    if (!selected?.ledger_id) {
      setEvidence({
        minute_book_entry_id: null,
        minute_book_title: null,
        minute_book_is_test: null,
        minute_book_storage_path: null,
        supporting_docs: [],
        verified_document: null,
      });
      setEvidenceError(null);
      return;
    }
    loadArchiveEvidence(selected.ledger_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.ledger_id, isTest]);

  const alreadyArchived = !!evidence.minute_book_entry_id || !!evidence.verified_document?.id;
  const archiveLocked = (selected?.ledger_status || "").toUpperCase() === "ARCHIVED" || alreadyArchived;

  const archiveMissing =
    selected?.envelope_status === "completed" && !evidence.minute_book_entry_id && !evidence.verified_document?.id;

  async function openStorageObject(bucket: string, path: string) {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 60);
    if (error || !data?.signedUrl) throw new Error(error?.message || "Unable to create signed URL.");
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  }

  async function onViewArchivePdf() {
    setError(null);
    setInfo(null);
    if (!selected?.ledger_id) return;

    setIsOpeningArchive(true);
    try {
      if (evidence.verified_document?.storage_bucket && evidence.verified_document?.storage_path) {
        await openStorageObject(evidence.verified_document.storage_bucket, evidence.verified_document.storage_path);
        flashInfo("Opened Verified archive PDF.");
        return;
      }

      const primary = evidence.supporting_docs.find((d) => d.doc_type === "primary" && d.file_path);
      if (primary?.file_path) {
        await openStorageObject("minute_book", primary.file_path);
        flashInfo("Opened Minute Book render (primary).");
        return;
      }

      if (evidence.minute_book_storage_path) {
        await openStorageObject("minute_book", evidence.minute_book_storage_path);
        flashInfo("Opened Minute Book render (entry).");
        return;
      }

      flashError("No archive PDF pointer found yet (Verified or Minute Book primary). Try Re-seal/Repair.");
    } catch (e: any) {
      console.error("onViewArchivePdf error", e);
      flashError(e?.message || "Unable to open archive PDF.");
    } finally {
      setIsOpeningArchive(false);
    }
  }

  async function onRepairReseal() {
    setError(null);
    setInfo(null);

    if (!selected?.ledger_id) return;
    if (selected.envelope_status !== "completed") {
      flashError("Re-seal/Repair requires a completed envelope.");
      return;
    }

    setIsResealing(true);
    try {
      setPinned(selected);

      const { data, error } = await supabase.functions.invoke("archive-save-document", {
        body: { record_id: selected.ledger_id, is_test: isTest, trigger: "forge-reseal-repair" },
      });

      if (error) {
        const msg = await extractFnError(error);
        throw new Error(msg);
      }

      const res = data as ArchiveSaveDocumentResponse;
      if (!res?.ok) {
        flashError(res?.error ?? "Re-seal/repair failed.");
        return;
      }

      flashInfo(res.repaired ? "Re-seal repaired pointers + registry." : "Re-seal completed.");
      await loadArchiveEvidence(selected.ledger_id);
      await refreshQueuesKeepSelection(selected.ledger_id);
    } catch (e: any) {
      console.error("onRepairReseal error", e);
      flashError(e?.message || "Re-seal/repair failed.");
    } finally {
      setIsResealing(false);
    }
  }

  // ============================
  // ACTIONS (NO WIRING CHANGES)
  // ============================
  async function doStartEnvelope() {
    setError(null);
    setInfo(null);

    if (!selected) return;
    if (envelopeLocked) {
      flashInfo("Envelope already exists for this record.");
      return;
    }
    if (!primarySignerEmail.trim() || !primarySignerName.trim()) {
      flashError("Signer name + email are required.");
      return;
    }

    setIsStarting(true);
    try {
      const parties = [
        {
          signer_name: primarySignerName.trim(),
          signer_email: primarySignerEmail.trim(),
          role: "signer",
          signing_order: 1,
        },
      ];

      const { data, error } = await supabase.functions.invoke("start-signature", {
        body: {
          record_id: selected.ledger_id,
          entity_slug: selected.entity_slug,
          parties,
          entity_id: selected.entity_id,
          is_test: isTest,
          cc_emails: ccEmails
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
        },
      });

      if (error) {
        const msg = await extractFnError(error);
        throw new Error(msg);
      }

      const res = data as StartSignatureResponse;
      if (!res?.ok) {
        flashError(res?.error ?? "Unable to start envelope.");
        return;
      }

      flashInfo(res.reused ? "Existing envelope reused." : "Envelope started.");
      await refreshQueuesKeepSelection(selected.ledger_id);
      setStartModalOpen(false);
      setRightTab("portal");
    } catch (err: any) {
      console.error("start-signature error", err);
      flashError(err?.message || "Unable to start envelope.");
    } finally {
      setIsStarting(false);
    }
  }

  async function doSendInvite() {
    setError(null);
    setInfo(null);

    if (!selected?.envelope_id) {
      flashError("No envelope found for this record.");
      return;
    }

    setIsSendingInvite(true);
    try {
      const { data, error } = await supabase.functions.invoke("send-signature-invite", {
        body: { envelope_id: selected.envelope_id, is_test: isTest },
      });

      if (error) {
        const msg = await extractFnError(error);
        throw new Error(msg);
      }

      const res = data as SendInviteResponse;
      if (!res?.ok) {
        flashError(res?.error ?? "Unable to send invite.");
        return;
      }

      flashInfo(res.message ?? "Invite sent.");
      await refreshQueuesKeepSelection(selected.ledger_id);
      setInviteModalOpen(false);
      setRightTab("portal");
    } catch (err: any) {
      console.error("send-signature-invite error", err);
      flashError(err?.message || "Unable to send invite.");
    } finally {
      setIsSendingInvite(false);
    }
  }

  async function doArchiveSigned() {
    setError(null);
    setInfo(null);

    if (!selected?.envelope_id) {
      flashError("No envelope found for this record.");
      return;
    }
    if (!selected || selected.envelope_status !== "completed") {
      flashError("Envelope is not completed yet.");
      return;
    }

    if (archiveLocked) {
      flashInfo("Record already archived — no action required.");
      setArchiveModalOpen(false);
      return;
    }

    setIsArchiving(true);
    try {
      const { data, error } = await supabase.functions.invoke("archive-signed-resolution", {
        body: { envelope_id: selected.envelope_id, is_test: isTest },
      });

      if (error) {
        const msg = await extractFnError(error);
        throw new Error(msg);
      }

      const res = data as ArchiveSignedResolutionResponse;
      if (!res?.ok) {
        flashError(res?.error ?? "Unable to archive signed resolution.");
        return;
      }

      flashInfo(res.already_archived ? "Already archived." : "Archived into CI-Archive Minute Book.");

      // ✅ keep it visible if views lag
      setPinned(selected);

      // ✅ refresh BOTH SQL queues (latest + archived)
      await refreshQueuesKeepSelection(selected.ledger_id);
      await loadArchiveEvidence(selected.ledger_id);

      setArchiveModalOpen(false);
      setRightTab("evidence");
      setTab("archived"); // ✅ goes to SQL-backed Archived tab after Archive
    } catch (err: any) {
      console.error("archive-signed-resolution error", err);
      flashError(err?.message || "Unable to archive signed resolution.");
    } finally {
      setIsArchiving(false);
    }
  }

  async function onRunAxiomReview() {
    if (!selected) return;

    setAxiomError(null);
    setAxiomInfo(null);
    setAxiomLoading(true);

    try {
      const { data, error } = await supabase.functions.invoke("axiom-pre-signature-review", {
        body: {
          record_id: selected.ledger_id,
          entity_slug: selected.entity_slug,
          entity_id: selected.entity_id,
          is_test: isTest,
          envelope_id: selected.envelope_id ?? null,
          trigger: "forge-pre-signature",
        },
      });

      if (error) {
        const msg = await extractFnError(error);
        throw new Error(msg);
      }

      const res = data as AxiomReviewResponse;
      if (!res?.ok) {
        flashAxiomError(res?.error ?? "AXIOM review failed.");
        return;
      }

      flashAxiomInfo(res.message ?? "AXIOM review completed.");
      await loadAxiomLatest(selected.ledger_id);
      setAxiomTab("summary");
      setRightTab("axiom");
    } catch (e: any) {
      console.error("axiom-pre-signature-review error", e);
      flashAxiomError(e?.message || "Unable to run AXIOM review.");
    } finally {
      setAxiomLoading(false);
    }
  }

  const axiomAdvisory = useMemo(() => {
    if (!selected) {
      return { severity: "IDLE" as RiskLevel, bullets: ["Select an execution record to view intelligence."] };
    }

    const risk = computeRiskLevel(selected);
    const bullets: string[] = [];

    if (!selected.envelope_id) bullets.push("No envelope exists yet. Start the envelope to begin signing.");
    if (selected.envelope_id && selected.envelope_status !== "completed")
      bullets.push("Envelope is active. Monitor progress; resend invite if stalled.");
    if (selected.envelope_status === "completed" && !isArchived(selected))
      bullets.push("Envelope completed. Next action is Archive Now to generate archive-grade artifacts + registry entry.");
    if (selected.envelope_status === "completed" && isArchived(selected))
      bullets.push("Record archived. Use Re-seal/Repair anytime to regenerate pointers (idempotent).");

    if (archiveMissing)
      bullets.push("Archive pointers appear missing. Use Re-seal/Repair to regenerate registry pointers (idempotent).");

    bullets.push("AXIOM Review generates advisory intelligence (side-car).");
    bullets.push("AXIOM is advisory-only. It never blocks authority.");

    return { severity: risk, bullets };
  }, [selected, archiveMissing]);

  const tabBtn = (k: TabKey, label: string, count: number) => (
    <button
      type="button"
      onClick={() => setTab(k)}
      className={cx(
        "rounded-full px-3 py-1.5 text-[11px] font-semibold transition border",
        tab === k
          ? "bg-slate-100 text-slate-950 border-white/20 shadow-md shadow-white/10"
          : "bg-slate-950/40 text-slate-300 border-slate-800 hover:border-slate-700 hover:text-slate-100"
      )}
    >
      {label} <span className="ml-1 text-[10px] opacity-70">({count})</span>
    </button>
  );

  const rightTabBtn = (k: RightTab, label: string, hint?: string) => (
    <button
      type="button"
      onClick={() => setRightTab(k)}
      className={cx(
        "rounded-full px-3 py-1.5 text-[11px] font-semibold transition border",
        rightTab === k
          ? "bg-slate-100 text-slate-950 border-white/20 shadow-md shadow-white/10"
          : "bg-slate-950/40 text-slate-300 border-slate-800 hover:border-slate-700 hover:text-slate-100"
      )}
      title={hint}
    >
      {label}
    </button>
  );

  const portalBtn = (href: string, label: string) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="group flex-1 rounded-2xl border border-slate-800/80 bg-slate-950/40 px-3 py-2 text-[11px] font-semibold text-slate-200 transition
                 hover:border-amber-500/55 hover:bg-slate-950/55 hover:text-slate-50
                 hover:shadow-[0_0_0_1px_rgba(251,191,36,0.14),0_0_18px_rgba(251,191,36,0.18)]
                 focus:outline-none focus:ring-2 focus:ring-amber-400/30"
    >
      <span className="flex items-center justify-center gap-2">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-300/90 shadow-[0_0_10px_rgba(251,191,36,0.85)]" />
        <span className="text-center">{label}</span>
        <span className="opacity-0 transition group-hover:opacity-100 text-[10px] text-amber-200">↗</span>
      </span>
    </a>
  );

  const axiomTabBtn = (k: AxiomTab, label: string) => (
    <button
      type="button"
      onClick={() => setAxiomTab(k)}
      className={cx(
        "rounded-full px-3 py-1.5 text-[11px] font-semibold transition border",
        axiomTab === k
          ? "bg-cyan-500/15 text-cyan-100 border-cyan-500/40"
          : "bg-slate-950/40 text-slate-300 border-slate-800 hover:border-slate-700 hover:text-slate-100"
      )}
    >
      {label}
    </button>
  );

  const laneBadge = () => (
    <div className="mt-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3">
      <div className="text-[10px] uppercase tracking-[0.22em] text-amber-200">Lane Clarification</div>
      <div className="mt-2 text-[11px] text-slate-200">
        <span className="font-semibold text-amber-200">Signed ≠ Archived.</span> Signing completes the envelope.
        Archiving creates the registry pointers (Minute Book + Verified). If pointers ever go missing, use{" "}
        <span className="font-semibold text-amber-200">Re-seal/Repair</span> (idempotent).
      </div>
    </div>
  );

  const archiveBanner = () => {
    if (!selected) return null;

    if (archiveMissing) {
      return (
        <div className="mt-2 text-[11px] text-amber-200 bg-amber-950/30 border border-amber-700/40 rounded-xl px-3 py-2">
          Archive pointers missing — use Re-seal/Repair (idempotent).
        </div>
      );
    }

    if (!archiveLocked) return null;

    return (
      <div className="mt-2 text-[11px] text-amber-200 bg-amber-950/30 border border-amber-700/40 rounded-xl px-3 py-2">
        Record already archived — no action required.
      </div>
    );
  };

  const primaryAction = useMemo(() => {
    if (!selected) return { key: "none" as const, label: "Select a record", disabled: true };
    if (!selected.envelope_id) return { key: "start" as const, label: "Start envelope", disabled: false };
    if (selected.envelope_status !== "completed") return { key: "invite" as const, label: "Send invite", disabled: false };
    if (archiveLocked) return { key: "view" as const, label: "View archive PDF", disabled: false };
    return { key: "archive" as const, label: "Archive now", disabled: false };
  }, [selected, archiveLocked]);

  const step = inferStep(selected);
  const stepDot = (i: number) => {
    const on = step >= i;
    const done = step > i;
    const cls = done
      ? "bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.9)]"
      : on
      ? "bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.85)]"
      : "bg-slate-600 shadow-[0_0_8px_rgba(148,163,184,0.35)]";
    return <span className={cx("h-2.5 w-2.5 rounded-full", cls)} />;
  };

  // ============================
  // UI SEARCH (Verified-style)
  // ============================
  const [q, setQ] = useState("");
  const filteredQueue = useMemo(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) return visibleQueue;
    return visibleQueue.filter((r) =>
      `${r.title} ${r.ledger_status} ${r.envelope_status ?? ""}`.toLowerCase().includes(qq)
    );
  }, [q, visibleQueue]);
  // ============================
  // RENDER
  // ============================
  return (
    <div className="px-3 sm:px-6 py-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/20 px-3 py-1.5 text-[11px] font-semibold text-slate-200 hover:bg-black/30 hover:border-white/15 transition"
          >
            <ArrowLeft className="h-4 w-4" />
            Dashboard
          </Link>

          <div className="flex items-center gap-2">
            <span className="text-[11px] uppercase tracking-[0.22em] text-slate-500">CI-Forge</span>
            {envPill()}
          </div>
        </div>

        <button
          type="button"
          onClick={() => fetchQueues()}
          className="rounded-full border border-white/10 bg-black/20 px-3 py-1.5 text-[11px] font-semibold text-slate-200 hover:bg-black/30 hover:border-white/15 transition"
        >
          Refresh
        </button>
      </div>

      <div className={shell}>
        {/* Header */}
        <div className={header}>
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
            <div>
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
                Execution Queue • {activeEntity}
              </div>
              <div className="mt-1 text-base sm:text-lg font-semibold text-slate-100">
                Sign → Verify → Archive
              </div>
              <div className="mt-1 text-[12px] text-slate-400">
                SQL-backed lifecycle: Active (latest) • Completed (signed) • Archived (sealed)
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {tabBtn("active", "Active", activeQueue.length)}
              {tabBtn("completed", "Completed", completedQueue.length)}
              {tabBtn("archived", "Archived", archivedQueue.length)}
            </div>
          </div>

          <div className="mt-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
            <div className="flex items-center gap-2">
              <div className="relative w-full sm:w-[360px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search queue (title, status, envelope)…"
                  className="w-full rounded-2xl border border-white/10 bg-black/20 pl-10 pr-3 py-2 text-[12px] text-slate-100 placeholder:text-slate-500 outline-none
                             focus:border-amber-500/40 focus:ring-2 focus:ring-amber-400/15"
                />
              </div>

              {tab === "active" ? (
                <label className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/20 px-3 py-2 text-[11px] font-semibold text-slate-200">
                  <input
                    type="checkbox"
                    checked={hideEnvelopes}
                    onChange={(e) => setHideEnvelopes(e.target.checked)}
                    className="h-4 w-4 accent-amber-300"
                  />
                  Hide envelopes
                </label>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/20 px-3 py-2 text-[11px] font-semibold text-slate-200">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-300/90 shadow-[0_0_10px_rgba(251,191,36,0.85)]" />
                Lane-safe: <span className="text-slate-100">{isTest ? "SANDBOX" : "RoT"}</span>
              </div>
            </div>
          </div>

          {error ? (
            <div className="mt-4 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-[12px] text-rose-200">
              {error}
            </div>
          ) : null}
          {info ? (
            <div className="mt-4 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-[12px] text-emerald-200">
              {info}
            </div>
          ) : null}
        </div>

        {/* Body */}
        <div className={body}>
          <div className="grid grid-cols-12 gap-4 lg:gap-6">
            {/* Left: Queue */}
            <div className="col-span-12 lg:col-span-4">
              <div className="rounded-3xl border border-white/10 bg-black/20 overflow-hidden">
                <div className="px-4 py-3 border-b border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent">
                  <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">
                    {tab === "active" ? "Active queue" : tab === "archived" ? "Archived queue" : "Completed queue"}
                  </div>
                  <div className="mt-1 text-[12px] text-slate-300">
                    {loadingQueue ? "Loading…" : `${filteredQueue.length} record(s)`}
                  </div>
                </div>

                <div className="max-h-[64vh] lg:max-h-[calc(100vh-330px)] overflow-auto">
                  {filteredQueue.length === 0 ? (
                    <div className="p-4 text-[12px] text-slate-400">No items.</div>
                  ) : (
                    <div className="p-2">
                      {filteredQueue.map((item) => {
                        const risk = computeRiskLevel(item);
                        const isSel = item.ledger_id === selectedId;
                        const archived = isArchived(item);
                        const completed = isCompleted(item);

                        return (
                          <button
                            key={item.ledger_id}
                            type="button"
                            onClick={() => {
                              setSelectedId(item.ledger_id);
                              setRightTab("evidence");
                            }}
                            className={cx(
                              "w-full text-left rounded-2xl border px-3 py-3 mb-2 transition",
                              isSel
                                ? "border-amber-500/40 bg-amber-500/10 shadow-[0_0_0_1px_rgba(251,191,36,0.18),0_0_20px_rgba(251,191,36,0.08)]"
                                : "border-white/10 bg-black/10 hover:bg-black/20 hover:border-white/15"
                            )}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="text-[12px] font-semibold text-slate-100">
                                  {clamp(item.title ?? "Untitled", 90)}
                                </div>
                                <div className="mt-1 text-[11px] text-slate-400">
                                  <span className="uppercase tracking-[0.18em]">{item.ledger_status ?? "—"}</span>
                                  <span className="mx-2 text-slate-700">•</span>
                                  <span className="text-slate-300">{fmt(item.created_at)}</span>
                                </div>
                              </div>

                              <div className="flex flex-col items-end gap-2 shrink-0">
                                <span className={cx("h-2.5 w-2.5 rounded-full", riskLightClasses(risk))} />
                                <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">
                                  {riskLabel(risk)}
                                </div>
                              </div>
                            </div>

                            <div className="mt-3 flex flex-wrap items-center gap-2">
                              {completed ? (
                                <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] font-semibold tracking-[0.18em] uppercase text-emerald-200">
                                  signed
                                </span>
                              ) : null}

                              {archived ? (
                                <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] font-semibold tracking-[0.18em] uppercase text-amber-200">
                                  archived
                                </span>
                              ) : null}

                              {item.envelope_id ? (
                                <span className="rounded-full border border-white/10 bg-black/20 px-2 py-1 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-300">
                                  envelope
                                </span>
                              ) : (
                                <span className="rounded-full border border-white/10 bg-black/20 px-2 py-1 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-400">
                                  no envelope
                                </span>
                              )}

                              {item.parties_total != null ? (
                                <span className="rounded-full border border-white/10 bg-black/20 px-2 py-1 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-300">
                                  {item.parties_signed ?? 0}/{item.parties_total} signed
                                </span>
                              ) : null}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              {laneBadge()}
            </div>

            {/* Middle: Details */}
            <div className="col-span-12 lg:col-span-4">
              <div className="rounded-3xl border border-white/10 bg-black/20 overflow-hidden">
                <div className="px-4 py-3 border-b border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent">
                  <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Record</div>
                  <div className="mt-1 text-[12px] text-slate-300">
                    {selected ? "Selected" : "None selected"}
                  </div>
                </div>

                <div className="p-4">
                  {!selected ? (
                    <div className="text-[12px] text-slate-400">Select a record from the queue.</div>
                  ) : (
                    <>
                      <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Title</div>
                      <div className="mt-1 text-base font-semibold text-slate-100">{selected.title ?? "Untitled"}</div>

                      <div className="mt-4 grid grid-cols-2 gap-3">
                        <div className="rounded-2xl border border-white/10 bg-black/10 p-3">
                          <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Ledger</div>
                          <div className="mt-1 text-[12px] font-semibold text-slate-200">
                            {(selected.ledger_status ?? "—").toUpperCase()}
                          </div>
                        </div>

                        <div className="rounded-2xl border border-white/10 bg-black/10 p-3">
                          <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Envelope</div>
                          <div className="mt-1 text-[12px] font-semibold text-slate-200">
                            {selected.envelope_status ? selected.envelope_status.toUpperCase() : "—"}
                          </div>
                        </div>

                        <div className="rounded-2xl border border-white/10 bg-black/10 p-3">
                          <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Created</div>
                          <div className="mt-1 text-[12px] font-semibold text-slate-200">{fmt(selected.created_at)}</div>
                        </div>

                        <div className="rounded-2xl border border-white/10 bg-black/10 p-3">
                          <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Step</div>
                          <div className="mt-1 flex items-center gap-2">
                            {stepDot(1)}
                            {stepDot(2)}
                            {stepDot(3)}
                            <span className="ml-2 text-[12px] font-semibold text-slate-200">
                              {step === 0 ? "Draft" : step === 2 ? "Signing" : "Signed"}
                            </span>
                          </div>
                        </div>
                      </div>

                      {archiveBanner()}

                      <div className="mt-5 rounded-2xl border border-white/10 bg-black/10 p-3">
                        <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Primary action</div>
                        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <button
                            type="button"
                            disabled={primaryAction.disabled}
                            onClick={() => {
                              if (primaryAction.key === "start") setStartModalOpen(true);
                              if (primaryAction.key === "invite") setInviteModalOpen(true);
                              if (primaryAction.key === "archive") setArchiveModalOpen(true);
                              if (primaryAction.key === "view") onViewArchivePdf();
                            }}
                            className={cx(
                              "rounded-2xl px-4 py-3 text-[12px] font-semibold tracking-[0.18em] uppercase transition border",
                              "border-amber-500/40 bg-amber-500/10 text-amber-100 hover:bg-amber-500/15",
                              primaryAction.disabled ? "opacity-60 cursor-not-allowed" : ""
                            )}
                          >
                            {primaryAction.label}
                          </button>

                          <button
                            type="button"
                            onClick={() => setResealModalOpen(true)}
                            disabled={!selected?.ledger_id || selected?.envelope_status !== "completed" || isResealing}
                            className={cx(
                              "rounded-2xl px-4 py-3 text-[12px] font-semibold tracking-[0.18em] uppercase transition border",
                              "border-slate-800 bg-slate-950/40 text-slate-200 hover:border-slate-700 hover:bg-slate-950/55",
                              !selected?.ledger_id || selected?.envelope_status !== "completed" || isResealing
                                ? "opacity-60 cursor-not-allowed"
                                : ""
                            )}
                          >
                            {isResealing ? "Working…" : "Re-seal/Repair"}
                          </button>
                        </div>

                        <div className="mt-2 text-[11px] text-slate-400">
                          Archive Now seals + registers. Re-seal/Repair regenerates pointers (idempotent).
                        </div>
                      </div>

                      <div className="mt-4 rounded-2xl border border-white/10 bg-black/10 p-3">
                        <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Quick tabs</div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {rightTabBtn("evidence", "Evidence")}
                          {rightTabBtn("axiom", "AXIOM")}
                          {rightTabBtn("portal", "Portal")}
                          {rightTabBtn("notes", "Notes", "Reserved")}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Right: Panels */}
            <div className="col-span-12 lg:col-span-4">
              <div className="rounded-3xl border border-white/10 bg-black/20 overflow-hidden">
                <div className="px-4 py-3 border-b border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Authority panel</div>
                      <div className="mt-1 text-[12px] text-slate-300">
                        {rightTab === "evidence"
                          ? "Archive evidence + pointers"
                          : rightTab === "portal"
                          ? "Signer / Verify / Certificate"
                          : rightTab === "axiom"
                          ? "AXIOM intelligence"
                          : "Notes"}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => selected?.ledger_id && loadArchiveEvidence(selected.ledger_id)}
                        className="rounded-full border border-white/10 bg-black/20 px-3 py-1.5 text-[11px] font-semibold text-slate-200 hover:bg-black/30 hover:border-white/15 transition"
                      >
                        Refresh
                      </button>
                    </div>
                  </div>
                </div>

                <div className="p-4">
                  {!selected ? (
                    <div className="text-[12px] text-slate-400">Select a record to view authority data.</div>
                  ) : rightTab === "portal" ? (
                    <>
                      <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Portal terminals</div>
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        {portal.signer_url ? portalBtn(portal.signer_url, "Signer") : null}
                        {portal.viewer_url ? portalBtn(portal.viewer_url, "Viewer") : null}
                        {portal.verify_url ? portalBtn(portal.verify_url, "Verify") : null}
                        {portal.certificate_url ? portalBtn(portal.certificate_url, "Certificate") : null}
                      </div>

                      {portalError ? (
                        <div className="mt-3 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-[12px] text-rose-200">
                          {portalError}
                        </div>
                      ) : null}

                      <div className="mt-4 rounded-2xl border border-white/10 bg-black/10 p-3">
                        <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Envelope</div>
                        <div className="mt-2 text-[12px] text-slate-200">
                          <span className="text-slate-400">ID:</span>{" "}
                          <span className="font-semibold">{selected.envelope_id ?? "—"}</span>
                        </div>
                        <div className="mt-1 text-[12px] text-slate-200">
                          <span className="text-slate-400">Status:</span>{" "}
                          <span className="font-semibold">{selected.envelope_status ?? "—"}</span>
                        </div>
                      </div>
                    </>
                  ) : rightTab === "axiom" ? (
                    <>
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">AXIOM</div>
                          <div className="mt-1 text-[12px] text-slate-300">
                            Advisory-only intelligence sidecar (record-scoped)
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => onRunAxiomReview()}
                          disabled={axiomLoading || !selected?.ledger_id}
                          className={cx(
                            "rounded-full border border-cyan-500/40 bg-cyan-500/15 px-3 py-1.5 text-[11px] font-semibold text-cyan-100 hover:bg-cyan-500/20 transition",
                            axiomLoading || !selected?.ledger_id ? "opacity-60 cursor-not-allowed" : ""
                          )}
                        >
                          {axiomLoading ? "Running…" : "Run review"}
                        </button>
                      </div>

                      {axiomError ? (
                        <div className="mt-3 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-[12px] text-rose-200">
                          {axiomError}
                        </div>
                      ) : null}
                      {axiomInfo ? (
                        <div className="mt-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-[12px] text-emerald-200">
                          {axiomInfo}
                        </div>
                      ) : null}

                      <div className="mt-4 flex flex-wrap gap-2">
                        {axiomTabBtn("advisory", "Advisory")}
                        {axiomTabBtn("summary", "Summary")}
                        {axiomTabBtn("analysis", "Analysis")}
                        {axiomTabBtn("advice", "Advice")}
                      </div>

                      <div className="mt-4 rounded-2xl border border-white/10 bg-black/10 p-4">
                        {axiomTab === "advisory" ? (
                          <>
                            <div className="flex items-center justify-between">
                              <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">
                                Advisory signal
                              </div>
                              <span
                                className={cx("h-2.5 w-2.5 rounded-full", riskLightClasses(axiomAdvisory.severity))}
                                title={riskLabel(axiomAdvisory.severity)}
                              />
                            </div>
                            <ul className="mt-3 space-y-2">
                              {axiomAdvisory.bullets.map((b, i) => (
                                <li key={i} className="text-[12px] text-slate-200">
                                  <span className="text-amber-200">•</span> {b}
                                </li>
                              ))}
                            </ul>
                          </>
                        ) : axiomTab === "summary" ? (
                          <>
                            <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Latest summary</div>
                            <div className="mt-2 text-[11px] text-slate-400">
                              {axiomLatest.summary?.generated_at ? fmt(axiomLatest.summary.generated_at) : "—"}{" "}
                              {axiomLatest.summary?.model ? `• ${axiomLatest.summary.model}` : ""}
                            </div>
                            <div className="mt-3 whitespace-pre-wrap text-[12px] text-slate-200">
                              {axiomLatest.summary?.summary ?? "—"}
                            </div>
                          </>
                        ) : axiomTab === "analysis" ? (
                          <>
                            <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Latest analysis</div>
                            <div className="mt-2 text-[11px] text-slate-400">
                              {axiomLatest.analysis?.generated_at ? fmt(axiomLatest.analysis.generated_at) : "—"}{" "}
                              {axiomLatest.analysis?.model ? `• ${axiomLatest.analysis.model}` : ""}
                            </div>
                            <div className="mt-3 whitespace-pre-wrap text-[12px] text-slate-200">
                              {axiomLatest.analysis?.analysis ?? "—"}
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Latest advice</div>
                            <div className="mt-2 text-[11px] text-slate-400">
                              {axiomLatest.advice?.generated_at ? fmt(axiomLatest.advice.generated_at) : "—"}{" "}
                              {axiomLatest.advice?.model ? `• ${axiomLatest.advice.model}` : ""}
                            </div>
                            <div className="mt-3 whitespace-pre-wrap text-[12px] text-slate-200">
                              {axiomLatest.advice?.advice ?? "—"}
                            </div>
                            {axiomLatest.advice?.recommendation ? (
                              <div className="mt-3 rounded-2xl border border-cyan-500/30 bg-cyan-500/10 p-3 text-[12px] text-cyan-100">
                                <div className="text-[10px] uppercase tracking-[0.22em] text-cyan-200">Recommendation</div>
                                <div className="mt-2 whitespace-pre-wrap">{axiomLatest.advice.recommendation}</div>
                              </div>
                            ) : null}
                          </>
                        )}
                      </div>
                    </>
                  ) : rightTab === "evidence" ? (
                    <>
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Evidence</div>
                          <div className="mt-1 text-[12px] text-slate-300">
                            Minute Book + Verified pointers (lane-safe)
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => onViewArchivePdf()}
                          disabled={isOpeningArchive}
                          className={cx(
                            "rounded-full border border-amber-500/40 bg-amber-500/15 px-3 py-1.5 text-[11px] font-semibold text-amber-100 hover:bg-amber-500/20 transition",
                            isOpeningArchive ? "opacity-60 cursor-not-allowed" : ""
                          )}
                        >
                          {isOpeningArchive ? "Opening…" : "View PDF"}
                        </button>
                      </div>

                      {evidenceError ? (
                        <div className="mt-3 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-[12px] text-rose-200">
                          {evidenceError}
                        </div>
                      ) : null}

                      <div className="mt-4 rounded-2xl border border-white/10 bg-black/10 p-4">
                        <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Minute Book entry</div>
                        <div className="mt-2 text-[12px] text-slate-200">
                          <span className="text-slate-400">ID:</span>{" "}
                          <span className="font-semibold">{evidence.minute_book_entry_id ?? "—"}</span>
                        </div>
                        <div className="mt-1 text-[12px] text-slate-200">
                          <span className="text-slate-400">Title:</span>{" "}
                          <span className="font-semibold">{evidence.minute_book_title ?? "—"}</span>
                        </div>
                        <div className="mt-1 text-[12px] text-slate-200">
                          <span className="text-slate-400">Storage:</span>{" "}
                          <span className="font-semibold">{evidence.minute_book_storage_path ?? "—"}</span>
                        </div>
                      </div>

                      <div className="mt-3 rounded-2xl border border-white/10 bg-black/10 p-4">
                        <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Verified document</div>
                        <div className="mt-2 text-[12px] text-slate-200">
                          <span className="text-slate-400">ID:</span>{" "}
                          <span className="font-semibold">{evidence.verified_document?.id ?? "—"}</span>
                        </div>
                        <div className="mt-1 text-[12px] text-slate-200">
                          <span className="text-slate-400">Bucket:</span>{" "}
                          <span className="font-semibold">{evidence.verified_document?.storage_bucket ?? "—"}</span>
                        </div>
                        <div className="mt-1 text-[12px] text-slate-200">
                          <span className="text-slate-400">Path:</span>{" "}
                          <span className="font-semibold">{evidence.verified_document?.storage_path ?? "—"}</span>
                        </div>
                        <div className="mt-1 text-[12px] text-slate-200">
                          <span className="text-slate-400">Hash:</span>{" "}
                          <span className="font-semibold">{evidence.verified_document?.file_hash ?? "—"}</span>
                        </div>
                      </div>

                      <div className="mt-3 rounded-2xl border border-white/10 bg-black/10 p-4">
                        <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Supporting documents</div>

                        {evidenceLoading ? (
                          <div className="mt-3 text-[12px] text-slate-400">Loading…</div>
                        ) : evidence.supporting_docs.length === 0 ? (
                          <div className="mt-3 text-[12px] text-slate-400">No supporting docs.</div>
                        ) : (
                          <div className="mt-3 space-y-2">
                            {evidence.supporting_docs.map((d) => (
                              <div
                                key={d.id}
                                className="rounded-2xl border border-white/10 bg-black/10 px-3 py-2"
                              >
                                <div className="flex items-center justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="text-[12px] font-semibold text-slate-200">
                                      {d.file_name ?? d.doc_type ?? "Document"}
                                    </div>
                                    <div className="mt-1 text-[11px] text-slate-400">
                                      {d.doc_type ?? "—"} • {d.mime_type ?? "—"}
                                    </div>
                                  </div>

                                  {d.file_path ? (
                                    <button
                                      type="button"
                                      onClick={() => openStorageObject("minute_book", d.file_path!)}
                                      className="rounded-full border border-white/10 bg-black/20 px-3 py-1.5 text-[11px] font-semibold text-slate-200 hover:bg-black/30 hover:border-white/15 transition"
                                    >
                                      Open
                                    </button>
                                  ) : (
                                    <span className="text-[11px] text-slate-500">No path</span>
                                  )}
                                </div>

                                <div className="mt-2 text-[11px] text-slate-400 break-all">
                                  {d.file_path ?? "—"}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="text-[12px] text-slate-400">Notes panel reserved.</div>
                  )}
                </div>
              </div>

              {/* Actions footer */}
              {selected ? (
                <div className="mt-4 rounded-3xl border border-white/10 bg-black/20 overflow-hidden">
                  <div className="px-4 py-3 border-b border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent">
                    <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Actions</div>
                    <div className="mt-1 text-[12px] text-slate-300">Authority operations (no wiring changes)</div>
                  </div>

                  <div className="p-4 space-y-2">
                    <button
                      type="button"
                      onClick={() => setStartModalOpen(true)}
                      disabled={!!selected.envelope_id}
                      className={cx(
                        "w-full rounded-2xl border px-4 py-3 text-[12px] font-semibold tracking-[0.18em] uppercase transition",
                        "border-slate-800 bg-slate-950/40 text-slate-200 hover:border-slate-700 hover:bg-slate-950/55",
                        !!selected.envelope_id ? "opacity-60 cursor-not-allowed" : ""
                      )}
                    >
                      Start envelope
                    </button>

                    <button
                      type="button"
                      onClick={() => setInviteModalOpen(true)}
                      disabled={!selected.envelope_id}
                      className={cx(
                        "w-full rounded-2xl border px-4 py-3 text-[12px] font-semibold tracking-[0.18em] uppercase transition",
                        "border-slate-800 bg-slate-950/40 text-slate-200 hover:border-slate-700 hover:bg-slate-950/55",
                        !selected.envelope_id ? "opacity-60 cursor-not-allowed" : ""
                      )}
                    >
                      Send invite
                    </button>

                    <button
                      type="button"
                      onClick={() => setArchiveModalOpen(true)}
                      disabled={!selected.envelope_id || selected.envelope_status !== "completed" || archiveLocked}
                      className={cx(
                        "w-full rounded-2xl border px-4 py-3 text-[12px] font-semibold tracking-[0.18em] uppercase transition",
                        "border-amber-500/40 bg-amber-500/10 text-amber-100 hover:bg-amber-500/15",
                        !selected.envelope_id || selected.envelope_status !== "completed" || archiveLocked
                          ? "opacity-60 cursor-not-allowed"
                          : ""
                      )}
                    >
                      Archive now
                    </button>

                    <button
                      type="button"
                      onClick={() => setResealModalOpen(true)}
                      disabled={selected.envelope_status !== "completed"}
                      className={cx(
                        "w-full rounded-2xl border px-4 py-3 text-[12px] font-semibold tracking-[0.18em] uppercase transition",
                        "border-slate-800 bg-slate-950/40 text-slate-200 hover:border-slate-700 hover:bg-slate-950/55",
                        selected.envelope_status !== "completed" ? "opacity-60 cursor-not-allowed" : ""
                      )}
                    >
                      Re-seal/Repair
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {/* ============================
          MODALS
          ============================ */}

      <Modal
        open={startModalOpen}
        title="Start envelope"
        description="Create a signature envelope for this record (no wiring changes)."
        confirmLabel={isStarting ? "Starting…" : "Start"}
        confirmTone="amber"
        confirmDisabled={isStarting}
        onConfirm={doStartEnvelope}
        onClose={() => setStartModalOpen(false)}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Signer name</div>
            <input
              value={primarySignerName}
              onChange={(e) => setPrimarySignerName(e.target.value)}
              placeholder="Full name"
              className="mt-2 w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-[12px] text-slate-100 placeholder:text-slate-500 outline-none
                         focus:border-amber-500/40 focus:ring-2 focus:ring-amber-400/15"
            />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Signer email</div>
            <input
              value={primarySignerEmail}
              onChange={(e) => setPrimarySignerEmail(e.target.value)}
              placeholder="name@domain.com"
              className="mt-2 w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-[12px] text-slate-100 placeholder:text-slate-500 outline-none
                         focus:border-amber-500/40 focus:ring-2 focus:ring-amber-400/15"
            />
          </div>
        </div>

        <div className="mt-3">
          <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">CC emails (optional)</div>
          <input
            value={ccEmails}
            onChange={(e) => setCcEmails(e.target.value)}
            placeholder="comma,separated,emails@domain.com"
            className="mt-2 w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-[12px] text-slate-100 placeholder:text-slate-500 outline-none
                       focus:border-amber-500/40 focus:ring-2 focus:ring-amber-400/15"
          />
        </div>

        <div className="mt-3 text-[11px] text-slate-400">
          This uses <span className="text-slate-200 font-semibold">start-signature</span> and preserves existing contracts.
        </div>
      </Modal>

      <Modal
        open={inviteModalOpen}
        title="Send signature invite"
        description="Send the signature invite for the current envelope (no wiring changes)."
        confirmLabel={isSendingInvite ? "Sending…" : "Send"}
        confirmTone="amber"
        confirmDisabled={isSendingInvite}
        onConfirm={doSendInvite}
        onClose={() => setInviteModalOpen(false)}
      >
        <div className="text-[12px] text-slate-200">
          Envelope: <span className="font-semibold">{selected?.envelope_id ?? "—"}</span>
        </div>
        <div className="mt-2 text-[11px] text-slate-400">
          This uses <span className="text-slate-200 font-semibold">send-signature-invite</span>.
        </div>
      </Modal>

      <Modal
        open={archiveModalOpen}
        title="Archive now"
        description="Seal and register the signed record (Minute Book + Verified)."
        confirmLabel={isArchiving ? "Archiving…" : "Archive"}
        confirmTone="amber"
        confirmDisabled={isArchiving}
        onConfirm={doArchiveSigned}
        onClose={() => setArchiveModalOpen(false)}
      >
        <div className="text-[12px] text-slate-200">
          Envelope: <span className="font-semibold">{selected?.envelope_id ?? "—"}</span>
        </div>
        <div className="mt-2 text-[11px] text-slate-400">
          This uses <span className="text-slate-200 font-semibold">archive-signed-resolution</span> (idempotent).
        </div>
        {archiveLocked ? (
          <div className="mt-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[12px] text-amber-200">
            Already archived — no action required.
          </div>
        ) : null}
      </Modal>

      <Modal
        open={resealModalOpen}
        title="Re-seal / Repair"
        description="Idempotent repair: regenerate archive pointers and registry artifacts."
        confirmLabel={isResealing ? "Working…" : "Run"}
        confirmTone="slate"
        confirmDisabled={isResealing}
        onConfirm={onRepairReseal}
        onClose={() => setResealModalOpen(false)}
      >
        <div className="text-[12px] text-slate-200">
          Record: <span className="font-semibold">{selected?.ledger_id ?? "—"}</span>
        </div>
        <div className="mt-2 text-[11px] text-slate-400">
          This uses <span className="text-slate-200 font-semibold">archive-save-document</span> (repair mode).
        </div>
      </Modal>
    </div>
  );
}
