"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";
import { ArrowLeft, ExternalLink, Copy, RefreshCw } from "lucide-react";

/**
 * CI — Forge (Execution Console)
 * ✅ Entity-scoped via OS Global Bar (activeEntity)
 * ✅ Lane-safe via is_test (SANDBOX vs RoT)
 * ✅ SQL-backed queues: v_forge_queue_latest + v_forge_queue_archived
 * ✅ Canonical archive path remains archive-save-document (seal wrapper)
 * ✅ Adds operator-only legacy path button: archive-signed-resolution (direct)
 *
 * ENHANCEMENTS (NO REGRESSION):
 * 1) Stabilized selection when switching tabs + refresh (keeps selectedId if still present).
 * 2) "Copy" actions for IDs + Verified hash (quick operator flow).
 * 3) "Open Best PDF" preference remains: Verified registry first → Minute Book primary → entry.
 * 4) Defensive evidence + intent loaders: never destabilize Forge if sidecars fail.
 * 5) Better disabled-state styling (NOT blacked out) — UI-only, logic unchanged.
 */

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

// ✅ Archived tab (SQL-backed)
type TabKey = "active" | "completed" | "archived";
type AxiomTab = "advisory" | "summary" | "analysis" | "advice";

// ✅ Intent sidecar tab (same tier as Evidence / AXIOM / Portal)
type RightTab = "evidence" | "axiom" | "portal" | "intent" | "notes";

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

/* ---------------- Intent (sidecar) types ---------------- */

type IntentHeader = {
  id: string;
  title: string | null;
  summary: string | null;
  created_at: string | null;
  created_by?: string | null;
};

type IntentArtifactRow = {
  id: string;
  intent_id: string;
  artifact_type: string;
  artifact_id: string;
  created_at: string | null;
};

function fmt(iso: string | null | undefined) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
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

async function getActorId(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getUser();
    return data?.user?.id ?? null;
  } catch {
    return null;
  }
}

async function safeCopy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function MiniPill({
  label,
  tone = "slate",
  title,
}: {
  label: string;
  tone?: "slate" | "amber" | "emerald" | "cyan" | "rose";
  title?: string;
}) {
  const cls =
    tone === "emerald"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
      : tone === "amber"
      ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
      : tone === "cyan"
      ? "border-cyan-500/30 bg-cyan-500/10 text-cyan-100"
      : tone === "rose"
      ? "border-rose-500/30 bg-rose-500/10 text-rose-100"
      : "border-white/10 bg-black/20 text-slate-300";

  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center gap-2 rounded-full border px-2 py-1 text-[10px] font-semibold tracking-[0.18em] uppercase",
        cls
      )}
    >
      {label}
    </span>
  );
}

function IconButton({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cx(
        "inline-flex items-center justify-center rounded-xl border border-white/10 bg-black/20 p-2 text-slate-200 hover:border-white/20 hover:bg-white/5 transition",
        disabled ? "opacity-60 cursor-not-allowed pointer-events-none" : ""
      )}
    >
      {children}
    </button>
  );
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

  // ✅ archive-signed-resolution direct state
  const [isArchivingSigned, setIsArchivingSigned] = useState(false);

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

  // ============================
  // Intent sidecar state
  // ============================
  const [intentLoading, setIntentLoading] = useState(false);
  const [intentError, setIntentError] = useState<string | null>(null);
  const [intentInfo, setIntentInfo] = useState<string | null>(null);
  const [intentHeader, setIntentHeader] = useState<IntentHeader | null>(null);
  const [intentArtifacts, setIntentArtifacts] = useState<IntentArtifactRow[]>([]);

  // Create Intent modal
  const [intentCreateOpen, setIntentCreateOpen] = useState(false);
  const [intentTitle, setIntentTitle] = useState("");
  const [intentReason, setIntentReason] = useState("");
  const [intentBackfillAfterCreate, setIntentBackfillAfterCreate] = useState(true);
  const [intentCreating, setIntentCreating] = useState(false);
  const [intentBackfilling, setIntentBackfilling] = useState(false);

  const [startModalOpen, setStartModalOpen] = useState(false);
  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  const [archiveModalOpen, setArchiveModalOpen] = useState(false);
  const [resealModalOpen, setResealModalOpen] = useState(false);
  const [archiveSignedModalOpen, setArchiveSignedModalOpen] = useState(false);

  // ✅ keep recently archived/sealed record visible even if view stops returning it immediately
  const [pinned, setPinned] = useState<ForgeQueueItem | null>(null);

  // ✅ enhancements: local copy flash
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1800);
    return () => clearTimeout(t);
  }, [copied]);

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

  function flashIntentError(msg: string) {
    console.error(msg);
    setIntentError(msg);
    setTimeout(() => setIntentError(null), 6500);
  }

  function flashIntentInfo(msg: string) {
    setIntentInfo(msg);
    setTimeout(() => setIntentInfo(null), 5200);
  }

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

  async function fetchQueues(preferKeepId?: string | null) {
    setLoadingQueue(true);
    setError(null);
    setInfo(null);

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

      if (latestR.error) {
        console.error("CI-Forge latest queue error:", latestR.error);
        setQueueLatest([]);
        setSelectedId(null);
        setError("Unable to load Forge queue for this entity/environment.");
        return;
      }

      if (archivedR.error) {
        console.warn("CI-Forge archived queue error:", archivedR.error);
        setQueueArchived([]);
      } else {
        setQueueArchived((((archivedR.data ?? []) as unknown) as ForgeQueueItem[]) ?? []);
      }

      const latestRows = ((((latestR.data ?? []) as unknown) as ForgeQueueItem[]) ?? []);
      setQueueLatest(latestRows);

      // ✅ Enhancement: preserve selection if possible
      const keepId = preferKeepId ?? selectedId ?? null;
      const archivedRows = (((archivedR.data ?? []) as unknown) as ForgeQueueItem[]) ?? [];
      const foundInLatest = !!keepId && latestRows.some((r) => r.ledger_id === keepId);
      const foundInArchived = !!keepId && archivedRows.some((r) => r.ledger_id === keepId);

      if (keepId && (foundInLatest || foundInArchived)) {
        setSelectedId(keepId);
      } else {
        setSelectedId((prev) => prev ?? latestRows[0]?.ledger_id ?? null);
      }
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
      await fetchQueues(null);
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
    if (isArchived(pinned)) return base;
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

  // ✅ Enhancement: preserve selection if it still exists in the new visibleQueue
  useEffect(() => {
    if (!visibleQueue.length) {
      setSelectedId(null);
      return;
    }
    setSelectedId((prev) => {
      if (prev && visibleQueue.some((x) => x.ledger_id === prev)) return prev;
      return visibleQueue[0]?.ledger_id ?? null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, activeEntity, isTest, hideEnvelopes, visibleQueue.length]);

  const selected = visibleQueue.find((q) => q.ledger_id === selectedId) ?? visibleQueue[0] ?? null;

  useEffect(() => {
    setPortal({});
    setPortalError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.ledger_id]);

  // Reset intent when selection changes
  useEffect(() => {
    setIntentHeader(null);
    setIntentArtifacts([]);
    setIntentError(null);
    setIntentInfo(null);
  }, [selected?.ledger_id]);

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

  // Best PDF preference: Verified → Minute Book primary → entry storage_path
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

        const row = latestRows.find((x) => x.ledger_id === keepLedgerId) ?? null;
        if (row) {
          if (!isCompleted(row)) setTab("active");
          else setTab("completed");
          setSelectedId(keepLedgerId);
          return;
        }
      }

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

  // ✅ direct archive-signed-resolution handler (operator-only legacy path)
  async function onArchiveSignedDirect() {
    setError(null);
    setInfo(null);

    if (!selected?.ledger_id) return;

    if (selected.envelope_status !== "completed") {
      flashError("Archive Signed requires a completed envelope.");
      return;
    }

    if (!selected.envelope_id) {
      flashError("Archive Signed requires an envelope_id.");
      return;
    }

    setIsArchivingSigned(true);
    try {
      setPinned(selected);

      const { data, error } = await supabase.functions.invoke("archive-signed-resolution", {
        body: {
          record_id: selected.ledger_id,
          ledger_id: selected.ledger_id,
          envelope_id: selected.envelope_id,
          entity_slug: activeEntity,
          is_test: isTest,
          trigger: "forge-archive-signed-direct",
        },
      });

      if (error) {
        const msg = await extractFnError(error);
        throw new Error(msg);
      }

      const res = data as ArchiveSignedResolutionResponse;

      if (!res?.ok) {
        flashError(res?.error ?? "Archive Signed failed.");
        return;
      }

      if (res.already_archived) {
        flashInfo("Signed artifact already archived — no action required.");
      } else {
        flashInfo("Archived Signed artifact (direct).");
      }

      await loadArchiveEvidence(selected.ledger_id);
      await refreshQueuesKeepSelection(selected.ledger_id);
    } catch (e: any) {
      console.error("onArchiveSignedDirect error", e);
      flashError(e?.message || "Archive Signed failed.");
    } finally {
      setIsArchivingSigned(false);
    }
  }

  async function onArchiveNow() {
    setError(null);
    setInfo(null);

    if (!selected?.ledger_id) return;
    if (selected.envelope_status !== "completed") {
      flashError("Archive requires a completed envelope.");
      return;
    }

    setIsArchiving(true);
    try {
      setPinned(selected);

      const { data, error } = await supabase.functions.invoke("archive-save-document", {
        body: { record_id: selected.ledger_id, is_test: isTest, trigger: "forge-archive" },
      });

      if (error) {
        const msg = await extractFnError(error);
        throw new Error(msg);
      }

      const res = data as ArchiveSaveDocumentResponse;
      if (!res?.ok) {
        flashError(res?.error ?? "Archive failed.");
        return;
      }

      if (res.already_archived) flashInfo("Record already archived — no action required.");
      else flashInfo(res.repaired ? "Archived (repaired pointers)." : "Archived successfully.");

      await loadArchiveEvidence(selected.ledger_id);
      await refreshQueuesKeepSelection(selected.ledger_id);
    } catch (e: any) {
      console.error("onArchiveNow error", e);
      flashError(e?.message || "Archive failed.");
    } finally {
      setIsArchiving(false);
    }
  }

  // --------------------------
  // Start Signature
  // --------------------------
  async function onStartSignature() {
    setError(null);
    setInfo(null);

    if (!selected?.ledger_id) return;

    setIsStarting(true);
    try {
      const actorId = await getActorId();
      if (!actorId) {
        flashError("You must be signed in to start a signature envelope.");
        return;
      }

      const { data, error } = await supabase.functions.invoke("start-signature-envelope", {
        body: {
          record_id: selected.ledger_id,
          entity_slug: activeEntity,
          is_test: isTest,
          actor_id: actorId,
        },
      });

      if (error) {
        const msg = await extractFnError(error);
        throw new Error(msg);
      }

      const res = data as StartSignatureResponse;
      if (!res?.ok) {
        flashError(res?.error ?? "Start signature failed.");
        return;
      }

      flashInfo(res.reused ? "Envelope already existed — reopened." : "Signature envelope created.");
      await refreshQueuesKeepSelection(selected.ledger_id);
    } catch (e: any) {
      console.error("onStartSignature error", e);
      flashError(e?.message || "Start signature failed.");
    } finally {
      setIsStarting(false);
    }
  }

  // --------------------------
  // Send Invite
  // --------------------------
  async function onSendInvite() {
    setError(null);
    setInfo(null);

    if (!selected?.ledger_id) return;
    if (!selected?.envelope_id) {
      flashError("No envelope yet — start signature first.");
      return;
    }

    const name = primarySignerName.trim();
    const email = primarySignerEmail.trim();

    if (!email || !email.includes("@")) {
      flashError("Signer email is required.");
      return;
    }

    setIsSendingInvite(true);
    try {
      const { data, error } = await supabase.functions.invoke("send-signature-invite", {
        body: {
          envelope_id: selected.envelope_id,
          signer_name: name || null,
          signer_email: email,
          cc_emails: ccEmails
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 10),
          is_test: isTest,
          entity_slug: activeEntity,
        },
      });

      if (error) {
        const msg = await extractFnError(error);
        throw new Error(msg);
      }

      const res = data as SendInviteResponse;
      if (!res?.ok) {
        flashError(res?.error ?? "Invite failed.");
        return;
      }

      flashInfo(res?.message ?? "Invite sent.");
      await refreshQueuesKeepSelection(selected.ledger_id);
    } catch (e: any) {
      console.error("onSendInvite error", e);
      flashError(e?.message || "Invite failed.");
    } finally {
      setIsSendingInvite(false);
    }
  }

  // --------------------------
  // AXIOM run (optional sidecar)
  // --------------------------
  async function onRunAxiom() {
    if (!selected?.ledger_id) return;

    setAxiomLoading(true);
    setAxiomError(null);
    setAxiomInfo(null);

    try {
      const { data, error } = await supabase.functions.invoke("axiom-pre-signature-review", {
        body: { record_id: selected.ledger_id, is_test: isTest, entity_slug: activeEntity },
      });

      if (error) {
        const msg = await extractFnError(error);
        throw new Error(msg);
      }

      const res = data as AxiomReviewResponse;
      if (!res?.ok) {
        flashAxiomError(res?.error ?? "AXIOM failed.");
        return;
      }

      flashAxiomInfo(res?.message ?? "AXIOM complete.");
      await loadAxiomLatest(selected.ledger_id);
    } catch (e: any) {
      console.error("onRunAxiom error", e);
      flashAxiomError(e?.message || "AXIOM failed.");
    } finally {
      setAxiomLoading(false);
    }
  }

  // ============================
  // Intent loaders + actions
  // ============================

  async function loadIntentSidecarForLedger(ledgerId: string) {
    setIntentLoading(true);
    setIntentError(null);

    try {
      let intentId: string | null = null;

      const rr = await supabase.rpc(
        "resolve_intent_from_artifact" as any,
        {
          p_artifact_type: "ledger",
          p_artifact_id: ledgerId,
        } as any
      );

      if (rr && !rr.error) {
        const d: any = rr.data;
        const row = Array.isArray(d) ? d[0] : d;
        intentId = row?.intent_id ?? row?.id ?? row?.intent?.id ?? (typeof d === "string" ? d : null);
      } else {
        const gi = await supabase
          .from("governance_intent_artifacts" as any)
          .select("intent_id, created_at")
          .eq("artifact_type", "ledger")
          .eq("artifact_id", ledgerId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!gi.error) intentId = (gi.data as any)?.intent_id ?? null;
      }

      if (!intentId) {
        setIntentHeader(null);
        setIntentArtifacts([]);
        return;
      }

      let header: IntentHeader | null = null;

      const ih = await supabase
        .from("governance_intents" as any)
        .select("id, title, summary, created_at, created_by")
        .eq("id", intentId)
        .maybeSingle();

      if (!ih.error && ih.data) {
        header = ih.data as any;
      } else {
        header = { id: intentId, title: null, summary: null, created_at: null };
      }

      setIntentHeader(header);

      const ia = await supabase
        .from("governance_intent_artifacts" as any)
        .select("id, intent_id, artifact_type, artifact_id, created_at")
        .eq("intent_id", intentId)
        .order("created_at", { ascending: false });

      if (!ia.error) setIntentArtifacts(((ia.data ?? []) as any) ?? []);
      else setIntentArtifacts([]);
    } catch (e) {
      console.warn("loadIntentSidecarForLedger exception", e);
      setIntentHeader(null);
      setIntentArtifacts([]);
    } finally {
      setIntentLoading(false);
    }
  }

  useEffect(() => {
    if (!selected?.ledger_id) return;
    loadIntentSidecarForLedger(selected.ledger_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.ledger_id, isTest]);

  async function doCreateIntentAndLink() {
    if (!selected?.ledger_id) return;

    const title = intentTitle.trim();
    const reason = intentReason.trim();

    if (!title) return flashIntentError("Title is required.");
    if (!reason) return flashIntentError("Reason is required.");

    setIntentCreating(true);
    setIntentError(null);
    setIntentInfo(null);

    try {
      const actorId = await getActorId();

      const entityId = (selected as any)?.entity_id as string | undefined;
      if (!entityId) {
        flashIntentError("Cannot create intent: entity_id missing on selected record.");
        return;
      }

      const cr = await supabase.rpc(
        "governance_create_intent" as any,
        {
          p_entity_id: entityId,
          p_is_test: !!isTest,
          p_title: title,
          p_intent_text: reason,
          p_intent_kind: "forge",
          p_slots: {
            source: "ci-forge",
            ledger_id: selected.ledger_id,
            envelope_id: (selected as any)?.envelope_id ?? null,
            entity_id: entityId,
            entity_slug: (selected as any)?.entity_slug ?? null,
            lane: isTest ? "SANDBOX" : "ROT",
          },
        } as any
      );

      if (!cr || cr.error) {
        console.warn("governance_create_intent error:", cr?.error);
        throw new Error(cr?.error?.message || "Unable to create intent (RPC).");
      }

      const cd: any = cr.data;
      const cRow = Array.isArray(cd) ? cd[0] : cd;

      const intentId =
        cRow?.intent_id ??
        cRow?.id ??
        cRow?.intent?.id ??
        cd?.intent_id ??
        cd?.id ??
        (typeof cd === "string" ? cd : null);

      if (!intentId) throw new Error("Intent created but id could not be resolved.");

      const ar = await supabase.rpc(
        "governance_attach_intent_artifact" as any,
        {
          p_intent_id: intentId,
          p_artifact_type: "ledger",
          p_artifact_id: selected.ledger_id,
          p_role: "primary",
        } as any
      );

      if (ar?.error) {
        console.warn("governance_attach_intent_artifact error:", ar.error);
        flashIntentError("Intent created, but linking the ledger artifact failed.");
      }

      if (intentBackfillAfterCreate) {
        if (!actorId) {
          flashIntentError("Intent created; cannot backfill because actor could not be resolved (auth).");
        } else {
          setIntentBackfilling(true);

          const br = await supabase.rpc(
            "attach_intent_artifacts_from_ledger" as any,
            {
              p_ledger_id: selected.ledger_id,
              p_actor_id: actorId,
            } as any
          );

          if (br?.error) {
            console.warn("attach_intent_artifacts_from_ledger error:", br.error);
            flashIntentError("Intent created; backfill blocked by guard (expected if artifacts/link not eligible).");
          } else {
            flashIntentInfo("Intent created + Forge artifacts attached.");
          }
        }
      } else {
        flashIntentInfo("Intent created (no backfill).");
      }

      setIntentCreateOpen(false);
      setIntentTitle("");
      setIntentReason("");
      setIntentBackfillAfterCreate(true);

      await loadIntentSidecarForLedger(selected.ledger_id);
      setRightTab("intent");
    } catch (e: any) {
      console.error("doCreateIntentAndLink error", e);
      flashIntentError(e?.message || "Unable to create intent.");
    } finally {
      setIntentBackfilling(false);
      setIntentCreating(false);
    }
  }

  async function doBackfillIntentArtifacts() {
    if (!selected?.ledger_id) return;

    if (!intentHeader?.id) {
      flashIntentError("No intent is linked (by design). Create an intent first.");
      return;
    }

    setIntentBackfilling(true);
    setIntentError(null);
    setIntentInfo(null);

    try {
      const actorId = await getActorId();
      if (!actorId) {
        flashIntentError("Actor could not be resolved (auth).");
        return;
      }

      const r = await supabase.rpc(
        "attach_intent_artifacts_from_ledger" as any,
        {
          p_ledger_id: selected.ledger_id,
          p_actor_id: actorId,
        } as any
      );

      if (!r || r.error) {
        console.warn("attach_intent_artifacts_from_ledger error:", r?.error);
        flashIntentError("Backfill blocked by guard (expected if link/artifacts not eligible).");
        return;
      }

      flashIntentInfo("Forge artifacts attached to intent.");
      await loadIntentSidecarForLedger(selected.ledger_id);
    } catch (e: any) {
      console.error("doBackfillIntentArtifacts error", e);
      flashIntentError(e?.message || "Backfill failed.");
    } finally {
      setIntentBackfilling(false);
    }
  }

  const step = inferStep(selected);

  const statusPill = (item: ForgeQueueItem) => {
    const s = (item.envelope_status ?? "").toLowerCase();
    const base = "rounded-full px-2 py-1 text-[10px] font-semibold tracking-[0.18em] uppercase border whitespace-nowrap";
    if (!item.envelope_id)
      return <span className={cx(base, "border-slate-700 bg-slate-950/40 text-slate-300")}>No Envelope</span>;
    if (s === "completed")
      return <span className={cx(base, "border-emerald-500/40 bg-emerald-500/10 text-emerald-200")}>Completed</span>;
    if (s === "sent" || s === "pending")
      return <span className={cx(base, "border-amber-500/40 bg-amber-500/10 text-amber-200")}>In Progress</span>;
    if (s === "cancelled" || s === "expired")
      return <span className={cx(base, "border-slate-600 bg-slate-900/40 text-slate-300")}>{s}</span>;
    return <span className={cx(base, "border-slate-600 bg-slate-900/40 text-slate-300")}>{s || "unknown"}</span>;
  };

  const ledgerStatusPill = (item: ForgeQueueItem) => {
    const s = (item.ledger_status ?? "").toUpperCase();
    const base = "rounded-full px-2 py-1 text-[10px] font-semibold tracking-[0.18em] uppercase border whitespace-nowrap";
    if (s === "ARCHIVED")
      return <span className={cx(base, "border-emerald-500/40 bg-emerald-500/10 text-emerald-200")}>Archived</span>;
    if (s === "APPROVED")
      return <span className={cx(base, "border-sky-500/30 bg-sky-500/10 text-sky-200")}>Approved</span>;
    if (s === "SIGNING" || s === "SIGNED")
      return <span className={cx(base, "border-amber-500/40 bg-amber-500/10 text-amber-200")}>{s}</span>;
    if (s === "PENDING")
      return <span className={cx(base, "border-slate-700 bg-slate-950/40 text-slate-300")}>Pending</span>;
    return <span className={cx(base, "border-slate-700 bg-slate-950/40 text-slate-300")}>{s || "—"}</span>;
  };

  const stepsUi = (
    <div className="flex items-center gap-2">
      <div className={cx("h-2 w-2 rounded-full", step >= 1 ? "bg-slate-200" : "bg-slate-700")} />
      <div className={cx("h-2 w-2 rounded-full", step >= 2 ? "bg-amber-300" : "bg-slate-700")} />
      <div className={cx("h-2 w-2 rounded-full", step >= 3 ? "bg-emerald-300" : "bg-slate-700")} />
      <div className="ml-2 text-[11px] text-slate-400">
        {step === 0 ? "No envelope" : step === 2 ? "Signing" : step === 3 ? "Completed" : "Ready"}
      </div>
    </div>
  );

  const SectionTitle = ({ label, hint }: { label: string; hint?: string }) => (
    <div className="flex items-end justify-between gap-4">
      <div>
        <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">{label}</div>
        {hint ? <div className="mt-1 text-[12px] text-slate-400">{hint}</div> : null}
      </div>
    </div>
  );

  const EmptyState = ({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) => (
    <div className="rounded-2xl border border-white/10 bg-black/25 p-5">
      <div className="text-sm font-semibold text-slate-100">{title}</div>
      {detail ? <div className="mt-1 text-[12px] text-slate-400">{detail}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );

  // ✅ ENHANCED (UI ONLY): disabled state no longer looks "blacked out"
  const ActionButton = ({
    label,
    tone = "amber",
    disabled,
    onClick,
  }: {
    label: string;
    tone?: "amber" | "emerald" | "cyan" | "slate";
    disabled?: boolean;
    onClick: () => void;
  }) => {
    const cls =
      tone === "emerald"
        ? "bg-emerald-500 text-black hover:bg-emerald-400"
        : tone === "cyan"
        ? "bg-cyan-500/15 text-cyan-100 border border-cyan-500/40 hover:bg-cyan-500/20"
        : tone === "slate"
        ? "bg-slate-100 text-slate-950 hover:bg-white"
        : "bg-amber-500/15 text-amber-100 border border-amber-500/40 hover:bg-amber-500/20";

    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={cx(
          "w-full rounded-2xl px-4 py-3 text-[12px] font-semibold tracking-[0.18em] uppercase transition",
          tone === "emerald" || tone === "slate" ? cls : cx("border", cls),
          disabled ? "opacity-70 cursor-not-allowed border-white/10 bg-white/[0.04] text-slate-400" : ""
        )}
      >
        {label}
      </button>
    );
  };

  const RightTabButton = ({ k, label }: { k: RightTab; label: string }) => (
    <button
      type="button"
      onClick={() => setRightTab(k)}
      className={cx(
        "rounded-full px-3 py-1.5 text-[11px] font-semibold tracking-[0.18em] uppercase border transition whitespace-nowrap",
        rightTab === k
          ? "border-white/20 bg-white/10 text-slate-100"
          : "border-white/10 bg-black/20 text-slate-300 hover:border-white/20 hover:bg-white/5"
      )}
    >
      {label}
    </button>
  );

  const TopTab = ({ k, label, count }: { k: TabKey; label: string; count: number }) => (
    <button
      type="button"
      onClick={() => setTab(k)}
      className={cx(
        "rounded-full px-3 py-1.5 text-[11px] font-semibold tracking-[0.18em] uppercase border transition whitespace-nowrap",
        tab === k
          ? "border-white/20 bg-white/10 text-slate-100"
          : "border-white/10 bg-black/20 text-slate-300 hover:border-white/20 hover:bg-white/5"
      )}
    >
      {label} <span className="ml-2 text-[10px] text-slate-400">{count}</span>
    </button>
  );

  const CopyRow = ({ label, value }: { label: string; value: string | null | undefined }) => {
    if (!value) return null;
    return (
      <div className="flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/20 px-3 py-2">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">{label}</div>
          <div className="mt-1 font-mono text-[11px] text-slate-200 break-all">{value}</div>
        </div>
        <IconButton
          title="Copy"
          onClick={async () => {
            const ok = await safeCopy(value);
            setCopied(ok ? label : "Copy failed");
          }}
        >
          <Copy className="h-4 w-4" />
        </IconButton>
      </div>
    );
  };

  // --------------------------
  // Render
  // --------------------------
  return (
    <div className={shell}>
      <div className={header}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="rounded-2xl border border-white/10 bg-black/20 p-2.5 text-slate-200 hover:border-white/20 hover:bg-white/5 transition"
              title="Back"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>

            <div>
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
                CI — Forge <span className="mx-2 text-slate-700">•</span> Execution Console
              </div>
              <div className="mt-1 flex items-center gap-2">
                <div className="text-base font-semibold text-slate-100">Sign → Verify → Archive</div>
                {envPill()}
                {copied ? <MiniPill label={copied} tone={copied === "Copy failed" ? "rose" : "emerald"} /> : null}
              </div>
              <div className="mt-1 text-[12px] text-slate-400">
                Entity-scoped via OS Global Bar • Lane-safe via <span className="font-mono">is_test</span> • No shortcuts
              </div>
            </div>
          </div>

          <div className="hidden sm:flex items-center gap-2">
            <div className="rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-[12px] text-slate-300">
              <span className="text-slate-500">Entity:</span>{" "}
              <span className="font-semibold text-slate-100">{activeEntity}</span>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-[12px] text-slate-300">
              <span className="text-slate-500">Lane:</span>{" "}
              <span className="font-semibold text-slate-100">{isTest ? "SANDBOX" : "RoT"}</span>
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            <TopTab k="active" label="Active" count={activeQueue.length} />
            <TopTab k="completed" label="Completed" count={completedQueue.length} />
            <TopTab k="archived" label="Archived" count={archivedQueue.length} />
          </div>

          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 rounded-full border border-white/10 bg-black/20 px-3 py-2 text-[11px] text-slate-300">
              <input
                type="checkbox"
                checked={hideEnvelopes}
                onChange={(e) => setHideEnvelopes(e.target.checked)}
                className="h-3.5 w-3.5 accent-amber-400"
              />
              Hide envelope rows
            </label>

            <button
              type="button"
              onClick={() => fetchQueues(selectedId)}
              disabled={loadingQueue}
              className={cx(
                "rounded-full border border-white/10 bg-black/20 px-3 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:border-white/20 hover:bg-white/5 transition",
                loadingQueue ? "opacity-60 cursor-not-allowed" : ""
              )}
            >
              <span className="inline-flex items-center gap-2">
                {loadingQueue ? <RefreshCw className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                {loadingQueue ? "Refreshing…" : "Refresh"}
              </span>
            </button>
          </div>
        </div>

        {error ? (
          <div className="mt-4 rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-[12px] text-rose-100">
            {error}
          </div>
        ) : null}

        {info ? (
          <div className="mt-4 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-[12px] text-emerald-100">
            {info}
          </div>
        ) : null}
      </div>

      <div className={body}>
        <div className="grid grid-cols-12 gap-4 lg:gap-5">
          {/* Queue */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 overflow-hidden">
              <div className="px-4 py-3 border-b border-white/10 bg-white/[0.03]">
                <div className="flex items-center justify-between">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
                    Queue <span className="mx-2 text-slate-700">•</span> {tab}
                  </div>
                  <div className="text-[11px] text-slate-500">{visibleQueue.length} items</div>
                </div>
              </div>

              <div className="max-h-[62vh] overflow-auto">
                {visibleQueue.length === 0 ? (
                  <div className="p-4">
                    <EmptyState
                      title="No items in this tab."
                      detail={
                        tab === "active"
                          ? "Council-approved items will appear here for signing."
                          : tab === "completed"
                          ? "Completed envelopes appear here until archived."
                          : "Archived items appear here (SQL-backed)."
                      }
                    />
                  </div>
                ) : (
                  <div className="divide-y divide-white/5">
                    {visibleQueue.map((q) => {
                      const risk = computeRiskLevel(q);
                      const selectedCls = q.ledger_id === selectedId ? "bg-white/[0.06]" : "hover:bg-white/[0.04]";
                      return (
                        <button
                          key={q.ledger_id}
                          type="button"
                          onClick={() => setSelectedId(q.ledger_id)}
                          className={cx("w-full text-left px-4 py-3 transition", selectedCls)}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="truncate text-[13px] font-semibold text-slate-100">{q.title}</div>
                              <div className="mt-1 flex flex-wrap items-center gap-2">
                                {statusPill(q)}
                                {ledgerStatusPill(q)}
                                <span className="inline-flex items-center gap-2 text-[11px] text-slate-400">
                                  <span className={cx("h-2 w-2 rounded-full", riskLightClasses(risk))} />
                                  {riskLabel(risk)}
                                </span>
                              </div>
                              <div className="mt-1 text-[11px] text-slate-500">Created {fmt(q.created_at)}</div>
                            </div>
                            <div className="shrink-0 text-right">
                              <div className="text-[11px] text-slate-400">
                                {q.parties_signed ?? 0}/{q.parties_total ?? 0}
                              </div>
                              <div className="mt-1 text-[10px] text-slate-500">
                                {q.last_signed_at ? `Last: ${fmt(q.last_signed_at)}` : "—"}
                              </div>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Details */}
          <div className="col-span-12 lg:col-span-5">
            {!selected ? (
              <EmptyState title="Select a record to view details." />
            ) : (
              <div className="rounded-3xl border border-white/10 bg-black/20 overflow-hidden">
                <div className="px-4 sm:px-5 py-4 border-b border-white/10 bg-white/[0.03]">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Record</div>
                      <div className="mt-1 text-base font-semibold text-slate-100 break-words">{selected.title}</div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {statusPill(selected)}
                        {ledgerStatusPill(selected)}
                        {stepsUi}
                      </div>

                      <div className="mt-3 space-y-2">
                        <CopyRow label="Ledger ID" value={selected.ledger_id} />
                        {selected.envelope_id ? <CopyRow label="Envelope ID" value={selected.envelope_id} /> : null}
                        {evidence.verified_document?.file_hash ? (
                          <CopyRow label="Verified Hash" value={evidence.verified_document.file_hash} />
                        ) : null}
                      </div>
                    </div>

                    <div className="shrink-0 flex flex-col gap-2 w-[180px]">
                      <ActionButton
                        label={selected.envelope_id ? "Open Signer" : "Start Signature"}
                        tone={selected.envelope_id ? "slate" : "amber"}
                        disabled={isStarting || (selected.envelope_id ? !portal.signer_url : false)}
                        onClick={() => {
                          if (selected.envelope_id) {
                            if (portal.signer_url) window.open(portal.signer_url, "_blank", "noopener,noreferrer");
                            else flashError("Signer URL not available yet.");
                            return;
                          }
                          setStartModalOpen(true);
                        }}
                      />

                      <ActionButton
                        label="Open Best PDF"
                        tone="slate"
                        disabled={isOpeningArchive || !selected.ledger_id}
                        onClick={() => onViewArchivePdf()}
                      />

                      {portal.verify_url ? (
                        <button
                          type="button"
                          onClick={() => window.open(portal.verify_url as string, "_blank", "noopener,noreferrer")}
                          className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-[12px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:border-white/20 hover:bg-white/5 transition"
                        >
                          <span className="inline-flex items-center justify-center gap-2">
                            <ExternalLink className="h-4 w-4" /> Open Verify
                          </span>
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>

                <div className="px-4 sm:px-5 py-5">
                  <div className="grid grid-cols-12 gap-4">
                    <div className="col-span-12">
                      <SectionTitle label="Signature" hint="Create envelope, invite signer, monitor status." />
                    </div>

                    <div className="col-span-12">
                      <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
                        <div className="grid grid-cols-12 gap-3">
                          <div className="col-span-12 md:col-span-6">
                            <label className="block text-[11px] uppercase tracking-[0.22em] text-slate-500">Signer name</label>
                            <input
                              value={primarySignerName}
                              onChange={(e) => setPrimarySignerName(e.target.value)}
                              className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-[13px] text-slate-100 outline-none focus:border-white/20"
                              placeholder="Primary signer (optional)"
                            />
                          </div>
                          <div className="col-span-12 md:col-span-6">
                            <label className="block text-[11px] uppercase tracking-[0.22em] text-slate-500">Signer email</label>
                            <input
                              value={primarySignerEmail}
                              onChange={(e) => setPrimarySignerEmail(e.target.value)}
                              className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-[13px] text-slate-100 outline-none focus:border-white/20"
                              placeholder="name@email.com"
                            />
                          </div>

                          <div className="col-span-12">
                            <label className="block text-[11px] uppercase tracking-[0.22em] text-slate-500">
                              CC emails (comma-separated)
                            </label>
                            <input
                              value={ccEmails}
                              onChange={(e) => setCcEmails(e.target.value)}
                              className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-[13px] text-slate-100 outline-none focus:border-white/20"
                              placeholder="optional@cc.com, another@cc.com"
                            />
                          </div>

                          <div className="col-span-12 md:col-span-6">
                            <ActionButton
                              label="Send Invite"
                              tone="amber"
                              disabled={
                                isSendingInvite ||
                                !selected.envelope_id ||
                                !primarySignerEmail.trim().includes("@") ||
                                selected.envelope_status === "completed"
                              }
                              onClick={() => setInviteModalOpen(true)}
                            />
                            <div className="mt-2 text-[11px] text-slate-500">
                              Requires an envelope. Invite sends to signer + optional CC.
                            </div>
                          </div>

                          <div className="col-span-12 md:col-span-6">
                            <ActionButton
                              label="Re-seal / Repair"
                              tone="cyan"
                              disabled={isResealing || selected.envelope_status !== "completed"}
                              onClick={() => setResealModalOpen(true)}
                            />
                            <div className="mt-2 text-[11px] text-slate-500">
                              Repairs Verified + Minute Book pointers (idempotent). Completed envelope only.
                            </div>
                          </div>

                          <div className="col-span-12">
                            <ActionButton
                              label={archiveLocked ? "Archive (Already)" : "Archive Now"}
                              tone="emerald"
                              disabled={isArchiving || selected.envelope_status !== "completed" || archiveLocked}
                              onClick={() => setArchiveModalOpen(true)}
                            />
                            <div className="mt-2 text-[11px] text-slate-500">
                              Archive writes Minute Book primary pointer + Verified registry (certified source).
                            </div>

                            {/* Explicit Archive Signed (Direct) button */}
                            <div className="mt-3">
                              <ActionButton
                                label={archiveLocked ? "Archive Signed (Already)" : "Archive Signed (Direct)"}
                                tone="amber"
                                disabled={
                                  isArchivingSigned ||
                                  selected.envelope_status !== "completed" ||
                                  !selected.envelope_id ||
                                  archiveLocked
                                }
                                onClick={() => setArchiveSignedModalOpen(true)}
                              />
                              <div className="mt-2 text-[11px] text-slate-500">
                                Calls <span className="font-mono">archive-signed-resolution</span> directly (legacy path). This does{" "}
                                <span className="font-semibold">not</span> replace Archive Now; it’s an explicit operator action.
                              </div>
                            </div>

                            {archiveMissing ? (
                              <div className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-100">
                                Completed envelope detected, but archive pointers are missing. Use{" "}
                                <span className="font-semibold">Re-seal / Repair</span>. If you specifically need the legacy signed-only
                                archiver, use <span className="font-semibold">Archive Signed (Direct)</span>.
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="col-span-12">
                      <div className="grid grid-cols-12 gap-3">
                        <div className="col-span-12 md:col-span-6 rounded-2xl border border-white/10 bg-black/25 p-4">
                          <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Portal</div>
                          {portalError ? (
                            <div className="mt-2 text-[12px] text-rose-200">{portalError}</div>
                          ) : (
                            <div className="mt-3 flex flex-col gap-2">
                              <a
                                className={cx(
                                  "rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-[12px] text-slate-200 hover:border-white/20 hover:bg-white/5 transition",
                                  !portal.viewer_url ? "opacity-60 pointer-events-none" : ""
                                )}
                                href={portal.viewer_url || "#"}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Open Viewer
                              </a>
                              <a
                                className={cx(
                                  "rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-[12px] text-slate-200 hover:border-white/20 hover:bg-white/5 transition",
                                  !portal.verify_url ? "opacity-60 pointer-events-none" : ""
                                )}
                                href={portal.verify_url || "#"}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Open Verify
                              </a>
                              <a
                                className={cx(
                                  "rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-[12px] text-slate-200 hover:border-white/20 hover:bg-white/5 transition",
                                  !portal.certificate_url ? "opacity-60 pointer-events-none" : ""
                                )}
                                href={portal.certificate_url || "#"}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Open Certificate
                              </a>
                            </div>
                          )}
                        </div>

                        <div className="col-span-12 md:col-span-6 rounded-2xl border border-white/10 bg-black/25 p-4">
                          <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">AXIOM</div>
                          {axiomError ? <div className="mt-2 text-[12px] text-rose-200">{axiomError}</div> : null}
                          {axiomInfo ? <div className="mt-2 text-[12px] text-emerald-200">{axiomInfo}</div> : null}

                          <div className="mt-3 flex gap-2 flex-wrap">
                            {(["advisory", "summary", "analysis", "advice"] as AxiomTab[]).map((k) => (
                              <button
                                key={k}
                                type="button"
                                onClick={() => setAxiomTab(k)}
                                className={cx(
                                  "rounded-full px-3 py-1.5 text-[11px] font-semibold tracking-[0.18em] uppercase border transition",
                                  axiomTab === k
                                    ? "border-white/20 bg-white/10 text-slate-100"
                                    : "border-white/10 bg-black/20 text-slate-300 hover:border-white/20 hover:bg-white/5"
                                )}
                              >
                                {k}
                              </button>
                            ))}
                          </div>

                          <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 p-3">
                            {axiomTab === "advisory" ? (
                              <div className="text-[12px] text-slate-300">
                                AXIOM is advisory only. It never blocks signing or alters resolution templates.
                              </div>
                            ) : null}

                            {axiomTab === "summary" ? (
                              <div className="text-[12px] text-slate-200 whitespace-pre-wrap">
                                {axiomLatest.summary?.summary ?? "No summary yet."}
                              </div>
                            ) : null}

                            {axiomTab === "analysis" ? (
                              <div className="text-[12px] text-slate-200 whitespace-pre-wrap">
                                {axiomLatest.analysis?.analysis ?? "No analysis yet."}
                              </div>
                            ) : null}

                            {axiomTab === "advice" ? (
                              <div className="text-[12px] text-slate-200 whitespace-pre-wrap">
                                {axiomLatest.advice?.advice ?? "No advice yet."}
                              </div>
                            ) : null}
                          </div>

                          <div className="mt-3">
                            <ActionButton label="Run AXIOM" tone="cyan" disabled={axiomLoading} onClick={() => onRunAxiom()} />
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="col-span-12">
                      <div className="text-[11px] text-slate-500">
                        Forge is signature-only. Archive is idempotent and lane-safe. No SQL shortcuts; all writes via RPC/Edge Functions.
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Right Sidecar */}
          <div className="col-span-12 lg:col-span-3">
            {!selected ? (
              <EmptyState title="No record selected." />
            ) : (
              <div className="rounded-3xl border border-white/10 bg-black/20 overflow-hidden">
                <div className="px-4 py-3 border-b border-white/10 bg-white/[0.03]">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Sidecar</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <RightTabButton k="evidence" label="Evidence" />
                    <RightTabButton k="portal" label="Portal" />
                    <RightTabButton k="axiom" label="AXIOM" />
                    <RightTabButton k="intent" label="Intent" />
                    <RightTabButton k="notes" label="Notes" />
                  </div>
                </div>

                <div className="p-4">
                  {/* Evidence */}
                  {rightTab === "evidence" ? (
                    <div className="space-y-3">
                      {evidenceError ? (
                        <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-100">
                          {evidenceError}
                        </div>
                      ) : null}

                      {evidenceLoading ? (
                        <div className="text-[12px] text-slate-400">Loading evidence…</div>
                      ) : (
                        <>
                          <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Minute Book</div>
                            <div className="mt-2 text-[12px] text-slate-200">
                              {evidence.minute_book_entry_id ? (
                                <>
                                  <div className="font-semibold">{evidence.minute_book_title || "Minute Book Entry"}</div>
                                  <div className="mt-1 text-slate-400">
                                    Entry ID <span className="font-mono">{evidence.minute_book_entry_id}</span>
                                  </div>
                                  <div className="mt-1 text-slate-400">
                                    Storage <span className="font-mono">{evidence.minute_book_storage_path || "—"}</span>
                                  </div>
                                </>
                              ) : (
                                <div className="text-slate-400">No Minute Book entry yet.</div>
                              )}
                            </div>
                          </div>

                          <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Verified Registry</div>
                            <div className="mt-2 text-[12px] text-slate-200">
                              {evidence.verified_document?.id ? (
                                <>
                                  <div className="font-semibold">Certified</div>
                                  <div className="mt-2 flex flex-col gap-2">
                                    <CopyRow label="Hash" value={evidence.verified_document.file_hash || "—"} />
                                    {evidence.verified_document.storage_bucket && evidence.verified_document.storage_path ? (
                                      <div className="text-[11px] text-slate-500 break-all">
                                        <span className="font-mono">
                                          {evidence.verified_document.storage_bucket}/{evidence.verified_document.storage_path}
                                        </span>
                                      </div>
                                    ) : null}
                                  </div>
                                </>
                              ) : (
                                <div className="text-slate-400">No verified document yet.</div>
                              )}
                            </div>
                          </div>

                          <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Supporting Docs</div>
                            <div className="mt-2 space-y-2">
                              {evidence.supporting_docs.length === 0 ? (
                                <div className="text-[12px] text-slate-400">No supporting documents yet.</div>
                              ) : (
                                evidence.supporting_docs.slice(0, 10).map((d) => (
                                  <div key={d.id} className="rounded-xl border border-white/10 bg-black/15 px-3 py-2">
                                    <div className="text-[12px] font-semibold text-slate-200">
                                      {d.file_name || d.doc_type || "Document"}
                                    </div>
                                    <div className="mt-1 text-[11px] text-slate-500">
                                      {d.file_hash ? <span className="font-mono break-all">{d.file_hash}</span> : "—"}
                                    </div>
                                  </div>
                                ))
                              )}
                            </div>
                          </div>

                          <ActionButton label="Open Best PDF" tone="slate" disabled={isOpeningArchive} onClick={() => onViewArchivePdf()} />
                        </>
                      )}
                    </div>
                  ) : null}

                  {/* Portal */}
                  {rightTab === "portal" ? (
                    <div className="space-y-3">
                      {!selected.envelope_id ? (
                        <EmptyState title="No envelope yet." detail="Start signature to generate portal URLs." />
                      ) : portalError ? (
                        <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-100">
                          {portalError}
                        </div>
                      ) : (
                        <>
                          <a
                            className={cx(
                              "block rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-[12px] text-slate-200 hover:border-white/20 hover:bg-white/5 transition",
                              !portal.signer_url ? "opacity-60 pointer-events-none" : ""
                            )}
                            href={portal.signer_url || "#"}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open Signer Terminal
                          </a>
                          <a
                            className={cx(
                              "block rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-[12px] text-slate-200 hover:border-white/20 hover:bg-white/5 transition",
                              !portal.viewer_url ? "opacity-60 pointer-events-none" : ""
                            )}
                            href={portal.viewer_url || "#"}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open Viewer
                          </a>
                          <a
                            className={cx(
                              "block rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-[12px] text-slate-200 hover:border-white/20 hover:bg-white/5 transition",
                              !portal.verify_url ? "opacity-60 pointer-events-none" : ""
                            )}
                            href={portal.verify_url || "#"}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open Verify
                          </a>
                          <a
                            className={cx(
                              "block rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-[12px] text-slate-200 hover:border-white/20 hover:bg-white/5 transition",
                              !portal.certificate_url ? "opacity-60 pointer-events-none" : ""
                            )}
                            href={portal.certificate_url || "#"}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open Certificate
                          </a>
                        </>
                      )}
                    </div>
                  ) : null}

                  {/* AXIOM */}
                  {rightTab === "axiom" ? (
                    <div className="space-y-3">
                      <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                        <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Advisory</div>
                        <div className="mt-2 text-[12px] text-slate-300">
                          AXIOM is a sidecar. It does not change the resolution PDF or block signing.
                        </div>
                      </div>

                      <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                        <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Latest Summary</div>
                        <div className="mt-2 text-[12px] text-slate-200 whitespace-pre-wrap">
                          {axiomLatest.summary?.summary ?? "No summary yet."}
                        </div>
                      </div>

                      <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                        <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Latest Analysis</div>
                        <div className="mt-2 text-[12px] text-slate-200 whitespace-pre-wrap">
                          {axiomLatest.analysis?.analysis ?? "No analysis yet."}
                        </div>
                      </div>

                      <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                        <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Latest Advice</div>
                        <div className="mt-2 text-[12px] text-slate-200 whitespace-pre-wrap">
                          {axiomLatest.advice?.advice ?? "No advice yet."}
                        </div>
                      </div>

                      <ActionButton label="Run AXIOM" tone="cyan" disabled={axiomLoading} onClick={() => onRunAxiom()} />
                    </div>
                  ) : null}

                  {/* Intent */}
                  {rightTab === "intent" ? (
                    <div className="space-y-3">
                      {intentError ? (
                        <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-100">
                          {intentError}
                        </div>
                      ) : null}

                      {intentInfo ? (
                        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-[12px] text-emerald-100">
                          {intentInfo}
                        </div>
                      ) : null}

                      {intentLoading ? (
                        <div className="text-[12px] text-slate-400">Loading intent…</div>
                      ) : !intentHeader ? (
                        <EmptyState
                          title="No Intent linked (by design)."
                          detail="Forge does not create intents automatically. This is operator-driven."
                          action={
                            <ActionButton
                              label="Create Intent"
                              tone="amber"
                              disabled={!selected?.ledger_id}
                              onClick={() => {
                                setIntentTitle(selected?.title || "");
                                setIntentReason("");
                                setIntentBackfillAfterCreate(true);
                                setIntentCreateOpen(true);
                              }}
                            />
                          }
                        />
                      ) : (
                        <>
                          <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Intent</div>
                            <div className="mt-2 text-[13px] font-semibold text-slate-100">
                              {intentHeader.title || "Untitled Intent"}
                            </div>
                            <div className="mt-2 text-[12px] text-slate-300 whitespace-pre-wrap">
                              {intentHeader.summary || "—"}
                            </div>
                            <div className="mt-2 text-[11px] text-slate-500">
                              Intent ID <span className="font-mono text-slate-300">{intentHeader.id}</span>
                            </div>
                          </div>

                          <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Linked Artifacts</div>
                            <div className="mt-2 space-y-2">
                              {intentArtifacts.length === 0 ? (
                                <div className="text-[12px] text-slate-400">No artifacts attached yet.</div>
                              ) : (
                                intentArtifacts.slice(0, 12).map((a) => (
                                  <div key={a.id} className="rounded-xl border border-white/10 bg-black/15 px-3 py-2">
                                    <div className="text-[12px] font-semibold text-slate-200">{a.artifact_type}</div>
                                    <div className="mt-1 text-[11px] text-slate-500 font-mono break-all">{a.artifact_id}</div>
                                    <div className="mt-1 text-[10px] text-slate-600">{fmt(a.created_at)}</div>
                                  </div>
                                ))
                              )}
                            </div>
                          </div>

                          <ActionButton
                            label={intentBackfilling ? "Backfilling…" : "Backfill / Attach Forge Artifacts"}
                            tone="cyan"
                            disabled={intentBackfilling}
                            onClick={() => doBackfillIntentArtifacts()}
                          />

                          <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-100">
                            Backfill is guarded. It only works when a link exists and artifacts are eligible. SANDBOX remains artifact-only by default unless you choose to backfill.
                          </div>
                        </>
                      )}
                    </div>
                  ) : null}

                  {/* Notes */}
                  {rightTab === "notes" ? (
                    <div className="space-y-3">
                      <EmptyState title="Notes (optional)" detail="Reserved for operator notes. Keep Forge execution clean." />
                    </div>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Modals */}
      <Modal
        open={startModalOpen}
        title="Start signature envelope"
        description="Creates (or reuses) a signature envelope for this record. No archive changes."
        confirmLabel={isStarting ? "Starting…" : "Start"}
        confirmTone="amber"
        confirmDisabled={isStarting}
        onConfirm={async () => {
          setStartModalOpen(false);
          await onStartSignature();
        }}
        onClose={() => setStartModalOpen(false)}
      />

      <Modal
        open={inviteModalOpen}
        title="Send signature invite"
        description="Sends the signing invitation to the primary signer (and optional CC)."
        confirmLabel={isSendingInvite ? "Sending…" : "Send"}
        confirmTone="amber"
        confirmDisabled={isSendingInvite}
        onConfirm={async () => {
          setInviteModalOpen(false);
          await onSendInvite();
        }}
        onClose={() => setInviteModalOpen(false)}
      />

      <Modal
        open={archiveModalOpen}
        title="Archive now"
        description="Runs the canonical archive-save-document flow (idempotent). Writes Minute Book primary + Verified registry."
        confirmLabel={isArchiving ? "Archiving…" : "Archive"}
        confirmTone="emerald"
        confirmDisabled={isArchiving}
        onConfirm={async () => {
          setArchiveModalOpen(false);
          await onArchiveNow();
        }}
        onClose={() => setArchiveModalOpen(false)}
      />

      <Modal
        open={archiveSignedModalOpen}
        title="Archive Signed (Direct)"
        description="Invokes archive-signed-resolution explicitly. This does not replace Archive Now; it is an operator-triggered legacy path."
        confirmLabel={isArchivingSigned ? "Archiving…" : "Archive Signed"}
        confirmTone="amber"
        confirmDisabled={isArchivingSigned}
        onConfirm={async () => {
          setArchiveSignedModalOpen(false);
          await onArchiveSignedDirect();
        }}
        onClose={() => setArchiveSignedModalOpen(false)}
      >
        <div className="rounded-2xl border border-white/10 bg-black/25 p-4 text-[12px] text-slate-300">
          <div className="text-slate-100 font-semibold">What this does</div>
          <div className="mt-2">
            • Calls <span className="font-mono">archive-signed-resolution</span> using the current{" "}
            <span className="font-mono">ledger_id</span> + <span className="font-mono">envelope_id</span>.
          </div>
          <div className="mt-2">
            • Intended when you specifically want the signed-artifact archiver path, separate from the canonical seal wrapper.
          </div>
          <div className="mt-3 text-slate-400">
            Preferred canonical flow remains <span className="font-semibold">Archive Now</span> or{" "}
            <span className="font-semibold">Re-seal / Repair</span>.
          </div>
        </div>
      </Modal>

      <Modal
        open={resealModalOpen}
        title="Re-seal / Repair"
        description="Repairs missing pointers and registry rows. Safe to run repeatedly."
        confirmLabel={isResealing ? "Repairing…" : "Repair"}
        confirmTone="cyan"
        confirmDisabled={isResealing}
        onConfirm={async () => {
          setResealModalOpen(false);
          await onRepairReseal();
        }}
        onClose={() => setResealModalOpen(false)}
      />

      <Modal
        open={intentCreateOpen}
        title="Create Intent"
        description="Operator-driven. Creates an intent and links it to this ledger record. Optional backfill attaches Forge artifacts."
        confirmLabel={intentCreating ? "Creating…" : "Create"}
        confirmTone="amber"
        confirmDisabled={intentCreating}
        onConfirm={async () => {
          await doCreateIntentAndLink();
        }}
        onClose={() => setIntentCreateOpen(false)}
      >
        <div className="grid grid-cols-12 gap-3">
          <div className="col-span-12">
            <label className="block text-[11px] uppercase tracking-[0.22em] text-slate-500">Title</label>
            <input
              value={intentTitle}
              onChange={(e) => setIntentTitle(e.target.value)}
              className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-[13px] text-slate-100 outline-none focus:border-white/20"
              placeholder="Intent title"
            />
          </div>

          <div className="col-span-12">
            <label className="block text-[11px] uppercase tracking-[0.22em] text-slate-500">Reason (stored as summary)</label>
            <textarea
              value={intentReason}
              onChange={(e) => setIntentReason(e.target.value)}
              rows={5}
              className="mt-2 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-[13px] text-slate-100 outline-none focus:border-white/20"
              placeholder="Required: why are we creating this intent?"
            />
          </div>

          <div className="col-span-12">
            <label className="flex items-center gap-2 rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-[12px] text-slate-200">
              <input
                type="checkbox"
                checked={intentBackfillAfterCreate}
                onChange={(e) => setIntentBackfillAfterCreate(e.target.checked)}
                className="h-4 w-4 accent-amber-400"
              />
              Backfill Forge artifacts after create (recommended)
            </label>
            <div className="mt-2 text-[11px] text-slate-500">
              Backfill calls the guarded helper <span className="font-mono">attach_intent_artifacts_from_ledger</span> (no SQL shortcuts).
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
