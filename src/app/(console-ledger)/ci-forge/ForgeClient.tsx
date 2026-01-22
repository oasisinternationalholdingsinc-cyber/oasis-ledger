"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";
import { Search, ArrowLeft } from "lucide-react";

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

// ✅ add Intent sidecar tab (same tier as Evidence / AXIOM / Portal)
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

async function getActorId(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getUser();
    return data?.user?.id ?? null;
  } catch {
    return null;
  }
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

  // Reset intent when selection changes
  useEffect(() => {
    setIntentHeader(null);
    setIntentArtifacts([]);
    setIntentError(null);
    setIntentInfo(null);
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

  function flashIntentError(msg: string) {
    console.error(msg);
    setIntentError(msg);
    setTimeout(() => setIntentError(null), 6500);
  }

  function flashIntentInfo(msg: string) {
    setIntentInfo(msg);
    setTimeout(() => setIntentInfo(null), 5200);
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
// Intent loaders + actions
// ============================

async function loadIntentSidecarForLedger(ledgerId: string) {
  setIntentLoading(true);
  setIntentError(null);

  try {
    // Step 1: resolve intent_id from ledger artifact (RPC is canonical)
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
      intentId =
        row?.intent_id ??
        row?.id ??
        row?.intent?.id ??
        (typeof d === "string" ? d : null);
    } else {
      // Fallback: direct table read (only if exposed). Still lane-safe because artifact link is explicit.
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

    // Step 2: intent header (best effort)
    // NOTE: governance_intents has `summary` (NOT reason, NOT intent_text)
    let header: IntentHeader | null = null;

    const ih = await supabase
      .from("governance_intents" as any)
      .select("id, title, summary, created_at, created_by")
      .eq("id", intentId)
      .maybeSingle();

    if (!ih.error && ih.data) header = ih.data as any;
    else header = { id: intentId, title: null, summary: null, created_at: null };

    setIntentHeader(header);

    // Step 3: artifacts (best effort)
    const ia = await supabase
      .from("governance_intent_artifacts" as any)
      .select("id, intent_id, artifact_type, artifact_id, created_at")
      .eq("intent_id", intentId)
      .order("created_at", { ascending: false });

    if (!ia.error) setIntentArtifacts(((ia.data ?? []) as any) ?? []);
    else setIntentArtifacts([]);
  } catch (e) {
    console.warn("loadIntentSidecarForLedger exception", e);
    // Sidecar must never destabilize Forge
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
  const reason = intentReason.trim(); // UI label stays "Reason" — stored as `summary` in DB

  if (!title) return flashIntentError("Title is required.");
  if (!reason) return flashIntentError("Reason is required.");

  setIntentCreating(true);
  setIntentError(null);
  setIntentInfo(null);

  try {
    const actorId = await getActorId(); // for guarded backfill helper

    // HARD RULES: lane-safe + entity-safe (no guessing)
    const entityId = (selected as any)?.entity_id as string | undefined;
    if (!entityId) {
      flashIntentError("Cannot create intent: entity_id missing on selected record.");
      return;
    }

    // 1) create intent (canonical signature in your schema)
    // DB table uses `summary` — function maps p_intent_text -> summary
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

    // tolerate different return shapes (uuid, {id}, {intent_id}, {intent:{id}})
    const intentId =
      cRow?.intent_id ??
      cRow?.id ??
      cRow?.intent?.id ??
      cd?.intent_id ??
      cd?.id ??
      (typeof cd === "string" ? cd : null);

    if (!intentId) throw new Error("Intent created but id could not be resolved.");

    // 2) explicitly link ledger artifact
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

    // 3) Optional backfill (guarded helper; only works AFTER link exists)
    if (intentBackfillAfterCreate) {
      if (!actorId) {
        flashIntentError(
          "Intent created; cannot backfill because actor could not be resolved (auth)."
        );
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
          flashIntentError(
            "Intent created; backfill blocked by guard (expected if artifacts/link not eligible)."
          );
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
  // Archive Now (completed envelopes only)
  // --------------------------
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

      // Canonical: archive-save-document is the stable wrapper calling seal RPC
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
  // AXIOM run (optional sidecar)
  // --------------------------
  async function onRunAxiom() {
    if (!selected?.ledger_id) return;

    setAxiomLoading(true);
    setAxiomError(null);
    setAxiomInfo(null);

    try {
      const { data, error } = await supabase.functions.invoke("axiom-review-record", {
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

  const step = inferStep(selected);

  const statusPill = (item: ForgeQueueItem) => {
    const s = (item.envelope_status ?? "").toLowerCase();
    const base =
      "rounded-full px-2 py-1 text-[10px] font-semibold tracking-[0.18em] uppercase border whitespace-nowrap";
    if (!item.envelope_id)
      return <span className={cx(base, "border-slate-700 bg-slate-950/40 text-slate-300")}>No Envelope</span>;
    if (s === "completed")
      return <span className={cx(base, "border-emerald-500/40 bg-emerald-500/10 text-emerald-200")}>Completed</span>;
    if (s === "sent" || s === "pending")
      return <span className={cx(base, "border-amber-500/40 bg-amber-500/10 text-amber-200")}>In Progress</span>;
    if (s === "cancelled" || s === "expired")
      return <span className={cx(base, "border-slate-600 bg-slate-900/40 text-slate-300")}>{s}</span>;
    return <span className={cx(base, "border-slate-600 bg-slate-900/40 text-slate-300")}>{s || "draft"}</span>;
  };

  const ledgerPill = (item: ForgeQueueItem) => {
    const ls = (item.ledger_status ?? "").toUpperCase() || "—";
    const base =
      "rounded-full px-2 py-1 text-[10px] font-semibold tracking-[0.18em] uppercase border whitespace-nowrap";
    if (ls === "ARCHIVED")
      return <span className={cx(base, "border-cyan-500/40 bg-cyan-500/10 text-cyan-200")}>ARCHIVED</span>;
    if (ls === "APPROVED")
      return <span className={cx(base, "border-sky-500/40 bg-sky-500/10 text-sky-200")}>APPROVED</span>;
    if (ls === "PENDING")
      return <span className={cx(base, "border-amber-500/40 bg-amber-500/10 text-amber-200")}>PENDING</span>;
    return <span className={cx(base, "border-slate-700 bg-slate-950/40 text-slate-300")}>{ls}</span>;
  };

  const queueCountLabel =
    tab === "active" ? `${activeQueue.length} Active` : tab === "archived" ? `${archivedQueue.length} Archived` : `${completedQueue.length} Completed`;

  return (
    <div className={shell}>
      <div className={header}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Link
                href="/ci-forge"
                className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-[12px] font-semibold text-white/85 hover:bg-black/30 hover:border-white/20 transition"
              >
                <ArrowLeft className="h-4 w-4" />
                Back
              </Link>

              <div className="text-[11px] uppercase tracking-[0.22em] text-white/45">CI • Forge</div>
              {envPill()}
            </div>

            <div className="mt-2 text-lg sm:text-xl font-semibold text-white/92">
              Execution Console <span className="text-white/35">—</span>{" "}
              <span className="text-white/70">{activeEntity}</span>
            </div>
            <div className="mt-1 text-[12px] text-white/45">{queueCountLabel}</div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setHideEnvelopes((v) => !v)}
              className={cx(
                "rounded-xl border px-3 py-2 text-[12px] font-semibold transition",
                hideEnvelopes
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-100 hover:bg-amber-500/15"
                  : "border-white/10 bg-black/20 text-white/80 hover:bg-black/30 hover:border-white/20"
              )}
              title="Filter out items that already have an envelope (Active tab only)."
            >
              {hideEnvelopes ? "Showing Draft-only" : "Show All"}
            </button>

            <button
              type="button"
              onClick={() => fetchQueues()}
              className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-[12px] font-semibold text-white/80 hover:bg-black/30 hover:border-white/20 transition"
              disabled={loadingQueue}
            >
              {loadingQueue ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setTab("active")}
            className={cx(
              "rounded-full px-3 py-1.5 text-[11px] font-semibold tracking-[0.18em] uppercase border transition",
              tab === "active"
                ? "border-amber-500/40 bg-amber-500/10 text-amber-100"
                : "border-white/10 bg-black/10 text-white/60 hover:border-white/20 hover:text-white/80"
            )}
          >
            Active
          </button>
          <button
            type="button"
            onClick={() => setTab("completed")}
            className={cx(
              "rounded-full px-3 py-1.5 text-[11px] font-semibold tracking-[0.18em] uppercase border transition",
              tab === "completed"
                ? "border-amber-500/40 bg-amber-500/10 text-amber-100"
                : "border-white/10 bg-black/10 text-white/60 hover:border-white/20 hover:text-white/80"
            )}
          >
            Completed
          </button>
          <button
            type="button"
            onClick={() => setTab("archived")}
            className={cx(
              "rounded-full px-3 py-1.5 text-[11px] font-semibold tracking-[0.18em] uppercase border transition",
              tab === "archived"
                ? "border-amber-500/40 bg-amber-500/10 text-amber-100"
                : "border-white/10 bg-black/10 text-white/60 hover:border-white/20 hover:text-white/80"
            )}
          >
            Archived
          </button>
        </div>

        {/* Alerts */}
        <div className="mt-4 space-y-2">
          {error ? (
            <div className="rounded-2xl border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-[12px] text-rose-100">
              {error}
            </div>
          ) : null}

          {info ? (
            <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-[12px] text-emerald-100">
              {info}
            </div>
          ) : null}
        </div>
      </div>

      <div className={body}>
        <div className="grid grid-cols-12 gap-4 lg:gap-6">
          {/* LEFT: Queue */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 overflow-hidden">
              <div className="px-4 py-3 border-b border-white/10 bg-gradient-to-b from-white/[0.05] to-transparent">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-white/50">Queue</div>
                  <div className="text-[11px] text-white/35">{visibleQueue.length} items</div>
                </div>
              </div>

              <div className="max-h-[56vh] lg:max-h-[64vh] overflow-auto">
                {visibleQueue.length === 0 ? (
                  <div className="px-4 py-8 text-center text-[12px] text-white/45">No items.</div>
                ) : (
                  <div className="p-2 space-y-2">
                    {visibleQueue.map((item) => {
                      const risk = computeRiskLevel(item);
                      const isSel = item.ledger_id === (selected?.ledger_id ?? "");
                      return (
                        <button
                          key={item.ledger_id}
                          type="button"
                          onClick={() => setSelectedId(item.ledger_id)}
                          className={cx(
                            "w-full text-left rounded-2xl border px-3 py-3 transition",
                            isSel
                              ? "border-amber-500/35 bg-amber-500/10"
                              : "border-white/10 bg-black/10 hover:bg-black/20 hover:border-white/20"
                          )}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-[12px] font-semibold text-white/90 truncate">{item.title}</div>
                              <div className="mt-1 text-[11px] text-white/45">
                                Created: <span className="text-white/60">{fmt(item.created_at)}</span>
                              </div>
                            </div>

                            <div className="flex items-center gap-2 shrink-0">
                              <span className={cx("h-2 w-2 rounded-full", riskLightClasses(risk))} />
                              <span className="text-[10px] tracking-[0.18em] uppercase text-white/45">
                                {riskLabel(risk)}
                              </span>
                            </div>
                          </div>

                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            {ledgerPill(item)}
                            {statusPill(item)}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* MIDDLE: Details + Actions */}
          <div className="col-span-12 lg:col-span-5">
            <div className="rounded-3xl border border-white/10 bg-black/20 overflow-hidden">
              <div className="px-4 py-3 border-b border-white/10 bg-gradient-to-b from-white/[0.05] to-transparent">
                <div className="text-[11px] uppercase tracking-[0.22em] text-white/50">Record</div>
              </div>

              {!selected ? (
                <div className="px-4 py-10 text-center text-[12px] text-white/45">Select a record.</div>
              ) : (
                <div className="p-4 space-y-4">
                  <div>
                    <div className="text-base font-semibold text-white/90">{selected.title}</div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {ledgerPill(selected)}
                      {statusPill(selected)}
                      <span className="rounded-full border border-white/10 bg-black/10 px-2 py-1 text-[10px] font-semibold tracking-[0.18em] uppercase text-white/60">
                        Step {step}/3
                      </span>
                    </div>

                    {/* Archive locked banner (frontend-only UX hardening) */}
                    {archiveLocked ? (
                      <div className="mt-3 rounded-2xl border border-cyan-500/25 bg-cyan-500/10 px-4 py-3 text-[12px] text-cyan-100">
                        Record already archived — no action required.
                      </div>
                    ) : null}

                    {archiveMissing ? (
                      <div className="mt-3 rounded-2xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-[12px] text-amber-100">
                        Signed but missing archive evidence. Use <span className="font-semibold">Re-seal/Repair</span>.
                      </div>
                    ) : null}
                  </div>

                  <div className="rounded-2xl border border-white/10 bg-black/10 p-4">
                    <div className="text-[11px] uppercase tracking-[0.22em] text-white/45">Key</div>
                    <div className="mt-2 grid grid-cols-2 gap-3 text-[12px]">
                      <div>
                        <div className="text-white/40">Ledger ID</div>
                        <div className="text-white/80 break-all">{selected.ledger_id}</div>
                      </div>
                      <div>
                        <div className="text-white/40">Envelope</div>
                        <div className="text-white/80 break-all">{selected.envelope_id ?? "—"}</div>
                      </div>
                      <div>
                        <div className="text-white/40">Parties</div>
                        <div className="text-white/80">
                          {(selected.parties_signed ?? 0).toString()}/{(selected.parties_total ?? 0).toString()}
                        </div>
                      </div>
                      <div>
                        <div className="text-white/40">Last Signed</div>
                        <div className="text-white/80">{fmt(selected.last_signed_at)}</div>
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="space-y-2">
                    <div className="text-[11px] uppercase tracking-[0.22em] text-white/45">Actions</div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setStartModalOpen(true)}
                        className="rounded-2xl border border-white/10 bg-black/15 px-4 py-3 text-[12px] font-semibold text-white/85 hover:bg-black/25 hover:border-white/20 transition"
                        disabled={isStarting}
                      >
                        {selected.envelope_id ? "Open Envelope" : "Start Signature"}
                      </button>

                      <button
                        type="button"
                        onClick={() => setInviteModalOpen(true)}
                        className="rounded-2xl border border-white/10 bg-black/15 px-4 py-3 text-[12px] font-semibold text-white/85 hover:bg-black/25 hover:border-white/20 transition"
                        disabled={!selected.envelope_id || isSendingInvite}
                        title={!selected.envelope_id ? "Start signature first." : "Send invite to signer."}
                      >
                        Send Invite
                      </button>

                      <button
                        type="button"
                        onClick={() => setResealModalOpen(true)}
                        className="rounded-2xl border border-amber-500/35 bg-amber-500/10 px-4 py-3 text-[12px] font-semibold text-amber-100 hover:bg-amber-500/15 transition"
                        disabled={selected.envelope_status !== "completed" || isResealing}
                        title={selected.envelope_status !== "completed" ? "Requires completed envelope." : "Repair archive pointers safely."}
                      >
                        Re-seal / Repair
                      </button>

                      <button
                        type="button"
                        onClick={() => setArchiveModalOpen(true)}
                        className={cx(
                          "rounded-2xl px-4 py-3 text-[12px] font-semibold transition border",
                          archiveLocked
                            ? "border-slate-700 bg-slate-950/40 text-slate-400 cursor-not-allowed"
                            : "border-emerald-500/35 bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/15"
                        )}
                        disabled={archiveLocked || selected.envelope_status !== "completed" || isArchiving}
                        title={
                          archiveLocked
                            ? "Already archived."
                            : selected.envelope_status !== "completed"
                            ? "Requires completed envelope."
                            : "Archive now (idempotent)."
                        }
                      >
                        Archive Now
                      </button>

                      <button
                        type="button"
                        onClick={() => onViewArchivePdf()}
                        className="rounded-2xl border border-cyan-500/30 bg-cyan-500/10 px-4 py-3 text-[12px] font-semibold text-cyan-100 hover:bg-cyan-500/15 transition"
                        disabled={isOpeningArchive}
                      >
                        {isOpeningArchive ? "Opening…" : "View Archive PDF"}
                      </button>

                      <button
                        type="button"
                        onClick={() => onRunAxiom()}
                        className="rounded-2xl border border-white/10 bg-black/15 px-4 py-3 text-[12px] font-semibold text-white/85 hover:bg-black/25 hover:border-white/20 transition"
                        disabled={axiomLoading}
                      >
                        {axiomLoading ? "Running…" : "Run AXIOM"}
                      </button>
                    </div>
                  </div>

                  {/* Modals */}
                  <Modal
                    open={startModalOpen}
                    title={selected?.envelope_id ? "Open / Reuse Envelope" : "Start Signature Envelope"}
                    description="Creates (or reuses) the signature envelope for this ledger record."
                    confirmLabel={isStarting ? "Working…" : "Start"}
                    confirmTone="emerald"
                    confirmDisabled={isStarting}
                    onConfirm={async () => {
                      setStartModalOpen(false);
                      await onStartSignature();
                    }}
                    onClose={() => setStartModalOpen(false)}
                  >
                    <div className="text-[12px] text-slate-300">
                      This action is lane-safe (<span className="text-slate-100 font-semibold">{isTest ? "SANDBOX" : "RoT"}</span>) and entity-scoped.
                    </div>
                  </Modal>

                  <Modal
                    open={inviteModalOpen}
                    title="Send Signature Invite"
                    description="Invite the signer to complete the envelope. (No wiring changes — uses existing Edge Function.)"
                    confirmLabel={isSendingInvite ? "Sending…" : "Send"}
                    confirmTone="amber"
                    confirmDisabled={isSendingInvite}
                    onConfirm={async () => {
                      setInviteModalOpen(false);
                      await onSendInvite();
                    }}
                    onClose={() => setInviteModalOpen(false)}
                  >
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <label className="block">
                        <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Signer Name</div>
                        <input
                          value={primarySignerName}
                          onChange={(e) => setPrimarySignerName(e.target.value)}
                          className="mt-1 w-full rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-[12px] text-slate-100 outline-none focus:border-amber-500/40"
                          placeholder="Optional"
                        />
                      </label>
                      <label className="block">
                        <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Signer Email *</div>
                        <input
                          value={primarySignerEmail}
                          onChange={(e) => setPrimarySignerEmail(e.target.value)}
                          className="mt-1 w-full rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-[12px] text-slate-100 outline-none focus:border-amber-500/40"
                          placeholder="name@email.com"
                        />
                      </label>
                      <label className="block sm:col-span-2">
                        <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">CC Emails</div>
                        <input
                          value={ccEmails}
                          onChange={(e) => setCcEmails(e.target.value)}
                          className="mt-1 w-full rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-[12px] text-slate-100 outline-none focus:border-amber-500/40"
                          placeholder="comma-separated (optional)"
                        />
                      </label>
                    </div>
                  </Modal>

                  <Modal
                    open={archiveModalOpen}
                    title="Archive Now"
                    description="Archives the signed record into Minute Book + Verified Registry (idempotent)."
                    confirmLabel={isArchiving ? "Archiving…" : "Archive"}
                    confirmTone="emerald"
                    confirmDisabled={isArchiving || archiveLocked || selected?.envelope_status !== "completed"}
                    onConfirm={async () => {
                      setArchiveModalOpen(false);
                      await onArchiveNow();
                    }}
                    onClose={() => setArchiveModalOpen(false)}
                  >
                    <div className="text-[12px] text-slate-300">
                      If this record is already archived, the system will return{" "}
                      <span className="text-slate-100 font-semibold">already_archived</span> and do nothing else.
                    </div>
                  </Modal>

                  <Modal
                    open={resealModalOpen}
                    title="Re-seal / Repair"
                    description="Repairs missing archive pointers safely (no rewiring; lane-safe)."
                    confirmLabel={isResealing ? "Working…" : "Re-seal"}
                    confirmTone="amber"
                    confirmDisabled={isResealing || selected?.envelope_status !== "completed"}
                    onConfirm={async () => {
                      setResealModalOpen(false);
                      await onRepairReseal();
                    }}
                    onClose={() => setResealModalOpen(false)}
                  >
                    <div className="text-[12px] text-slate-300">
                      Intended for: “Signed but missing archive evidence” or “Object not found” pointer drift.
                    </div>
                  </Modal>
                </div>
              )}
            </div>
          </div>

          {/* RIGHT: Sidecar */}
          <div className="col-span-12 lg:col-span-3">
            <div className="rounded-3xl border border-white/10 bg-black/20 overflow-hidden">
              <div className="px-4 py-3 border-b border-white/10 bg-gradient-to-b from-white/[0.05] to-transparent">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-white/50">Sidecar</div>
                  <div className="text-[11px] text-white/35">Read-only</div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {(["evidence", "portal", "axiom", "intent", "notes"] as RightTab[]).map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setRightTab(k)}
                      className={cx(
                        "rounded-full px-3 py-1.5 text-[10px] font-semibold tracking-[0.18em] uppercase border transition",
                        rightTab === k
                          ? "border-amber-500/40 bg-amber-500/10 text-amber-100"
                          : "border-white/10 bg-black/10 text-white/60 hover:border-white/20 hover:text-white/80"
                      )}
                    >
                      {k}
                    </button>
                  ))}
                </div>
              </div>

              <div className="p-4 space-y-3 max-h-[56vh] lg:max-h-[64vh] overflow-auto">
                {/* Evidence */}
                {rightTab === "evidence" ? (
                  <div className="space-y-3">
                    <div className="text-[11px] uppercase tracking-[0.22em] text-white/45">Archive Evidence</div>

                    {evidenceError ? (
                      <div className="rounded-2xl border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-[12px] text-rose-100">
                        {evidenceError}
                      </div>
                    ) : null}

                    {evidenceLoading ? (
                      <div className="text-[12px] text-white/50">Loading…</div>
                    ) : (
                      <>
                        <div className="rounded-2xl border border-white/10 bg-black/10 p-3">
                          <div className="text-[11px] text-white/45">Minute Book</div>
                          <div className="mt-1 text-[12px] text-white/85">
                            {evidence.minute_book_entry_id ? (
                              <>
                                <div className="font-semibold text-white/90">{evidence.minute_book_title ?? "—"}</div>
                                <div className="text-white/45 break-all">{evidence.minute_book_entry_id}</div>
                              </>
                            ) : (
                              "—"
                            )}
                          </div>
                        </div>

                        <div className="rounded-2xl border border-white/10 bg-black/10 p-3">
                          <div className="text-[11px] text-white/45">Verified Registry</div>
                          <div className="mt-1 text-[12px] text-white/85">
                            {evidence.verified_document?.id ? (
                              <>
                                <div className="text-white/90 font-semibold">{evidence.verified_document.verification_level ?? "verified"}</div>
                                <div className="text-white/45 break-all">{evidence.verified_document.id}</div>
                              </>
                            ) : (
                              "—"
                            )}
                          </div>
                        </div>

                        <div className="rounded-2xl border border-white/10 bg-black/10 p-3">
                          <div className="text-[11px] text-white/45">Supporting Documents</div>
                          {evidence.supporting_docs.length === 0 ? (
                            <div className="mt-1 text-[12px] text-white/50">—</div>
                          ) : (
                            <div className="mt-2 space-y-2">
                              {evidence.supporting_docs.slice(0, 6).map((d) => (
                                <div key={d.id} className="rounded-xl border border-white/10 bg-black/10 p-2">
                                  <div className="flex items-center justify-between gap-2">
                                    <div className="min-w-0">
                                      <div className="text-[12px] font-semibold text-white/85 truncate">
                                        {d.file_name ?? d.doc_type ?? "Document"}
                                      </div>
                                      <div className="text-[11px] text-white/45">{d.doc_type ?? "—"}</div>
                                    </div>
                                    <button
                                      type="button"
                                      className="rounded-xl border border-white/10 bg-black/15 px-2 py-1 text-[11px] font-semibold text-white/75 hover:bg-black/25 hover:border-white/20 transition"
                                      disabled={!d.file_path}
                                      onClick={async () => {
                                        try {
                                          if (!d.file_path) return;
                                          await openStorageObject("minute_book", d.file_path);
                                        } catch (e: any) {
                                          flashError(e?.message || "Unable to open document.");
                                        }
                                      }}
                                    >
                                      Open
                                    </button>
                                  </div>
                                </div>
                              ))}
                              {evidence.supporting_docs.length > 6 ? (
                                <div className="text-[11px] text-white/40">+ {evidence.supporting_docs.length - 6} more</div>
                              ) : null}
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                ) : null}

                {/* Portal */}
                {rightTab === "portal" ? (
                  <div className="space-y-3">
                    <div className="text-[11px] uppercase tracking-[0.22em] text-white/45">Portal URLs</div>
                    {portalError ? (
                      <div className="rounded-2xl border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-[12px] text-rose-100">
                        {portalError}
                      </div>
                    ) : null}

                    {!selected?.envelope_id ? (
                      <div className="text-[12px] text-white/50">Start signature to generate portal URLs.</div>
                    ) : (
                      <div className="space-y-2">
                        {(["signer_url", "viewer_url", "verify_url", "certificate_url"] as Array<keyof PortalUrls>).map((k) => (
                          <div key={k} className="rounded-2xl border border-white/10 bg-black/10 p-3">
                            <div className="text-[11px] text-white/45">{k.replace("_", " ")}</div>
                            <div className="mt-1 flex items-center justify-between gap-2">
                              <div className="text-[11px] text-white/70 break-all">{portal[k] ?? "—"}</div>
                              <button
                                type="button"
                                className="rounded-xl border border-white/10 bg-black/15 px-2 py-1 text-[11px] font-semibold text-white/75 hover:bg-black/25 hover:border-white/20 transition"
                                disabled={!portal[k]}
                                onClick={() => {
                                  const u = portal[k];
                                  if (!u) return;
                                  window.open(u, "_blank", "noopener,noreferrer");
                                }}
                              >
                                Open
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}

                {/* AXIOM */}
                {rightTab === "axiom" ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[11px] uppercase tracking-[0.22em] text-white/45">AXIOM</div>
                      <button
                        type="button"
                        className="rounded-xl border border-white/10 bg-black/15 px-2 py-1 text-[11px] font-semibold text-white/75 hover:bg-black/25 hover:border-white/20 transition"
                        disabled={axiomLoading}
                        onClick={() => onRunAxiom()}
                      >
                        Run
                      </button>
                    </div>

                    {axiomError ? (
                      <div className="rounded-2xl border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-[12px] text-rose-100">
                        {axiomError}
                      </div>
                    ) : null}
                    {axiomInfo ? (
                      <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-[12px] text-emerald-100">
                        {axiomInfo}
                      </div>
                    ) : null}

                    <div className="flex flex-wrap items-center gap-2">
                      {(["advisory", "summary", "analysis", "advice"] as AxiomTab[]).map((k) => (
                        <button
                          key={k}
                          type="button"
                          onClick={() => setAxiomTab(k)}
                          className={cx(
                            "rounded-full px-3 py-1.5 text-[10px] font-semibold tracking-[0.18em] uppercase border transition",
                            axiomTab === k
                              ? "border-amber-500/40 bg-amber-500/10 text-amber-100"
                              : "border-white/10 bg-black/10 text-white/60 hover:border-white/20 hover:text-white/80"
                          )}
                        >
                          {k}
                        </button>
                      ))}
                    </div>

                    <div className="rounded-2xl border border-white/10 bg-black/10 p-3">
                      {axiomTab === "advisory" ? (
                        <div className="text-[12px] text-white/70">
                          AXIOM is advisory-only. It never blocks Forge workflows.
                          <div className="mt-2 text-white/45">
                            Latest Summary: <span className="text-white/70">{fmt(axiomLatest.summary?.generated_at ?? null)}</span>
                          </div>
                        </div>
                      ) : null}

                      {axiomTab === "summary" ? (
                        <div className="text-[12px] text-white/75 whitespace-pre-wrap">
                          {axiomLatest.summary?.summary ?? "—"}
                        </div>
                      ) : null}

                      {axiomTab === "analysis" ? (
                        <div className="text-[12px] text-white/75 whitespace-pre-wrap">
                          {axiomLatest.analysis?.analysis ?? "—"}
                        </div>
                      ) : null}

                      {axiomTab === "advice" ? (
                        <div className="text-[12px] text-white/75 whitespace-pre-wrap">
                          {axiomLatest.advice?.advice ?? "—"}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {/* INTENT (explicit, operator-driven) */}
                {rightTab === "intent" ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[11px] uppercase tracking-[0.22em] text-white/45">Intent</div>

                      {!intentHeader ? (
                        <button
                          type="button"
                          onClick={() => setIntentCreateOpen(true)}
                          className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-2 py-1 text-[11px] font-semibold text-amber-100 hover:bg-amber-500/15 transition"
                        >
                          Create
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => doBackfillIntentArtifacts()}
                          disabled={intentBackfilling}
                          className={cx(
                            "rounded-xl border px-2 py-1 text-[11px] font-semibold transition",
                            intentBackfilling
                              ? "border-slate-700 bg-slate-950/40 text-slate-400 cursor-not-allowed"
                              : "border-amber-500/35 bg-amber-500/10 text-amber-100 hover:bg-amber-500/15"
                          )}
                        >
                          {intentBackfilling ? "Working…" : "Backfill"}
                        </button>
                      )}
                    </div>

                    {intentError ? (
                      <div className="rounded-2xl border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-[12px] text-rose-100">
                        {intentError}
                      </div>
                    ) : null}
                    {intentInfo ? (
                      <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-[12px] text-emerald-100">
                        {intentInfo}
                      </div>
                    ) : null}

                    {intentLoading ? (
                      <div className="text-[12px] text-white/50">Loading…</div>
                    ) : !intentHeader ? (
                      <div className="rounded-2xl border border-white/10 bg-black/10 p-3 text-[12px] text-white/70">
                        No Intent linked (by design). Use <span className="font-semibold text-white/85">Create Intent</span> to establish an explicit governance link.
                      </div>
                    ) : (
                      <>
                        <div className="rounded-2xl border border-white/10 bg-black/10 p-3">
                          <div className="text-[11px] uppercase tracking-[0.22em] text-white/45">Intent</div>
                          <div className="mt-1 text-[12px] text-white/85 font-semibold">
                            {intentHeader.title ?? "Untitled Intent"}
                          </div>
                          <div className="mt-1 text-[11px] text-white/50 break-all">{intentHeader.id}</div>
                          <div className="mt-2 text-[12px] text-white/70 whitespace-pre-wrap">{intentHeader.reason ?? "—"}</div>
                        </div>

                        <div className="rounded-2xl border border-white/10 bg-black/10 p-3">
                          <div className="text-[11px] uppercase tracking-[0.22em] text-white/45">Artifacts</div>
                          {intentArtifacts.length === 0 ? (
                            <div className="mt-2 text-[12px] text-white/55">
                              Link exists but attachments are missing. Use <span className="font-semibold">Backfill</span>.
                            </div>
                          ) : (
                            <div className="mt-2 space-y-2">
                              {intentArtifacts.slice(0, 8).map((a) => (
                                <div key={a.id} className="rounded-xl border border-white/10 bg-black/10 p-2">
                                  <div className="flex items-center justify-between gap-2">
                                    <div className="min-w-0">
                                      <div className="text-[11px] uppercase tracking-[0.18em] text-white/45">{a.artifact_type}</div>
                                      <div className="mt-1 text-[12px] text-white/80 break-all">{a.artifact_id}</div>
                                    </div>
                                    <div className="text-[11px] text-white/40">{fmt(a.created_at)}</div>
                                  </div>
                                </div>
                              ))}
                              {intentArtifacts.length > 8 ? (
                                <div className="text-[11px] text-white/40">+ {intentArtifacts.length - 8} more</div>
                              ) : null}
                            </div>
                          )}
                        </div>
                      </>
                    )}

                    <Modal
                      open={intentCreateOpen}
                      title="Create Intent"
                      description="Explicit, operator-driven governance link (never automatic)."
                      confirmLabel={intentCreating ? "Creating…" : "Create"}
                      confirmTone="amber"
                      confirmDisabled={intentCreating}
                      onConfirm={async () => {
                        await doCreateIntentAndLink();
                      }}
                      onClose={() => setIntentCreateOpen(false)}
                    >
                      <div className="space-y-3">
                        <label className="block">
                          <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Title *</div>
                          <input
                            value={intentTitle}
                            onChange={(e) => setIntentTitle(e.target.value)}
                            className="mt-1 w-full rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-[12px] text-slate-100 outline-none focus:border-amber-500/40"
                            placeholder="Intent title"
                          />
                        </label>

                        <label className="block">
                          <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Reason *</div>
                          <textarea
                            value={intentReason}
                            onChange={(e) => setIntentReason(e.target.value)}
                            className="mt-1 w-full min-h-[90px] rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-[12px] text-slate-100 outline-none focus:border-amber-500/40"
                            placeholder="Why are you creating this intent? (required)"
                          />
                        </label>

                        <label className="flex items-center gap-2 text-[12px] text-slate-200">
                          <input
                            type="checkbox"
                            checked={intentBackfillAfterCreate}
                            onChange={(e) => setIntentBackfillAfterCreate(e.target.checked)}
                          />
                          Backfill Forge artifacts after create (default ON)
                        </label>

                        <div className="text-[12px] text-slate-400">
                          Backfill calls the guarded helper{" "}
                          <span className="text-slate-200 font-semibold">attach_intent_artifacts_from_ledger</span> after the link exists.
                        </div>
                      </div>
                    </Modal>
                  </div>
                ) : null}

                {/* Notes (placeholder, stays stable) */}
                {rightTab === "notes" ? (
                  <div className="space-y-3">
                    <div className="text-[11px] uppercase tracking-[0.22em] text-white/45">Notes</div>
                    <div className="rounded-2xl border border-white/10 bg-black/10 p-3 text-[12px] text-white/60">
                      Operator notes panel (optional). No wiring changes.
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        {/* Footer hint */}
        <div className="mt-5 text-[11px] text-white/35">
          Lane-safe via <span className="text-white/55 font-semibold">is_test</span>, entity-safe via{" "}
          <span className="text-white/55 font-semibold">OsEntityContext</span>. Intent is explicit + operator-driven.
        </div>
      </div>
    </div>
  );
}
