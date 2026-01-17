"use client";
export const dynamic = "force-dynamic";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";
import { ShieldCheck, Search, CheckCircle2, ArrowLeft, FileText } from "lucide-react";

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
type TabKey = "active" | "completed";
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

  const [queue, setQueue] = useState<ForgeQueueItem[]>([]);
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

  // Verified-Registry OS shell/header/body pattern
  const shell =
    "rounded-3xl border border-white/10 bg-black/20 shadow-[0_28px_120px_rgba(0,0,0,0.55)] overflow-hidden";
  const header =
    "border-b border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent px-4 sm:px-6 py-4 sm:py-5";
  const body = "px-4 sm:px-6 py-5 sm:py-6";

  // --------------------------
  // Queue loader
  // --------------------------
  async function fetchQueue() {
    setLoadingQueue(true);
    setError(null);
    setInfo(null);

    try {
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

      const { data, error } = await supabase
        .from("v_forge_queue_latest")
        .select(selectCols)
        .eq("entity_slug", activeEntity)
        .eq("is_test", isTest)
        .order("created_at", { ascending: false });

      if (error) {
        console.error("CI-Forge queue error:", error);
        setQueue([]);
        setSelectedId(null);
        setError("Unable to load Forge queue for this entity/environment.");
        return;
      }

      const rows = ((data ?? []) as unknown as ForgeQueueItem[]) ?? [];
      setQueue(rows);
      setSelectedId(rows[0]?.ledger_id ?? null);
    } catch (err) {
      console.error("CI-Forge queue exception:", err);
      setQueue([]);
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
      await fetchQueue();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEntity, isTest]);

  const isCompleted = (item: ForgeQueueItem) => item.envelope_status === "completed";
  const activeQueueRaw = useMemo(() => queue.filter((q) => !isCompleted(q)), [queue]);
  const completedQueue = useMemo(() => queue.filter((q) => isCompleted(q)), [queue]);

  const activeQueue = useMemo(() => {
    if (!hideEnvelopes) return activeQueueRaw;
    return activeQueueRaw.filter((q) => !q.envelope_id);
  }, [activeQueueRaw, hideEnvelopes]);

  const visibleQueue = tab === "active" ? activeQueue : completedQueue;

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

  async function refreshQueueKeepSelection(keepLedgerId?: string | null) {
    try {
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

      const { data, error } = await supabase
        .from("v_forge_queue_latest")
        .select(selectCols)
        .eq("entity_slug", activeEntity)
        .eq("is_test", isTest)
        .order("created_at", { ascending: false });

      if (error) throw error;

      const rows = ((data ?? []) as unknown as ForgeQueueItem[]) ?? [];
      setQueue(rows);

      const nextVisibleBase =
        tab === "active" ? rows.filter((r) => !isCompleted(r)) : rows.filter((r) => isCompleted(r));

      const nextVisible =
        tab === "active" && hideEnvelopes ? nextVisibleBase.filter((r) => !r.envelope_id) : nextVisibleBase;

      const fallback = nextVisible[0]?.ledger_id ?? null;
      const desired = keepLedgerId && nextVisible.some((x) => x.ledger_id === keepLedgerId) ? keepLedgerId : fallback;

      setSelectedId(desired);
    } catch (e) {
      console.error("refreshQueue error", e);
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
        supabase.from("ai_summaries").select("id, summary, generated_at, model").eq("record_id", recordId).order("generated_at", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("ai_analyses").select("id, analysis, generated_at, model").eq("record_id", recordId).order("generated_at", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("ai_advice").select("id, advice, recommendation, generated_at, model").eq("record_id", recordId).order("generated_at", { ascending: false }).limit(1).maybeSingle(),
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
      await refreshQueueKeepSelection(selected.ledger_id);
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
        { signer_name: primarySignerName.trim(), signer_email: primarySignerEmail.trim(), role: "signer", signing_order: 1 },
      ];

      const { data, error } = await supabase.functions.invoke("start-signature", {
        body: {
          record_id: selected.ledger_id,
          entity_slug: selected.entity_slug,
          parties,
          entity_id: selected.entity_id,
          is_test: isTest,
          cc_emails: ccEmails.split(",").map((x) => x.trim()).filter(Boolean),
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
      await refreshQueueKeepSelection(selected.ledger_id);
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
      await refreshQueueKeepSelection(selected.ledger_id);
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
      await refreshQueueKeepSelection(selected.ledger_id);
      await loadArchiveEvidence(selected.ledger_id);
      setArchiveModalOpen(false);
      setRightTab("evidence");
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
    if (selected.envelope_status === "completed")
      bullets.push("Envelope completed. Next action is Archive Now to generate archive-grade artifacts + registry entry.");

    bullets.push("AXIOM Review generates advisory intelligence (side-car).");
    bullets.push("AXIOM is advisory-only. It never blocks authority.");
    bullets.push("Signing PDF stays pristine; archive render embeds immutable AXIOM snapshot at seal-time.");

    return { severity: risk, bullets };
  }, [selected]);

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
        axiomTab === k ? "bg-cyan-500/15 text-cyan-100 border-cyan-500/40" : "bg-slate-950/40 text-slate-300 border-slate-800 hover:border-slate-700 hover:text-slate-100"
      )}
    >
      {label}
    </button>
  );

  const laneBadge = () => (
    <div className="mt-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3">
      <div className="text-[10px] uppercase tracking-[0.22em] text-amber-200">Lane Clarification</div>
      <div className="mt-2 text-[11px] text-slate-200">
        <span className="font-semibold text-amber-200">Signed ≠ Archived.</span> Signing completes the envelope. Archiving
        creates the Minute Book registry entry, generates the archive-grade render + hash, and writes Verified pointers. If
        pointers ever go missing, use <span className="font-semibold text-amber-200">Re-seal/Repair</span> (idempotent).
      </div>
    </div>
  );

  const archiveBanner = () => {
    if (!selected) return null;
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

  const selectedRisk = selected ? computeRiskLevel(selected) : "IDLE";

  // ============================
  // UI SEARCH (Verified-style)
  // ============================
  const [q, setQ] = useState("");
  const filteredQueue = useMemo(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) return visibleQueue;
    return visibleQueue.filter((r) => `${r.title} ${r.ledger_status} ${r.envelope_status ?? ""}`.toLowerCase().includes(qq));
  }, [q, visibleQueue]);
  return (
    <div className="w-full">
      <div className="mx-auto w-full max-w-[1400px] px-4 pb-10 pt-4 sm:pt-6">
        {/* OS Shell (MATCH Verified Registry) */}
        <div className={shell}>
          {/* OS Header (MATCH Verified Registry grammar) */}
          <div className={header}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10px] sm:text-xs tracking-[0.3em] uppercase text-slate-500">CI • Forge</div>
                <h1 className="mt-1 text-lg sm:text-xl font-semibold text-slate-50">Execution</h1>
                <p className="mt-1 max-w-3xl text-[11px] sm:text-xs text-slate-400 leading-relaxed">
                  Signature execution surface. Authority-controlled. Lane-safe. Entity-scoped.
                </p>

                <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-400">
                  <span className="inline-flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-emerald-300" />
                    <span>Execution surface • Authority actions preserved</span>
                  </span>

                  <span className="text-slate-700">•</span>

                  <span>
                    Lane:{" "}
                    <span className={cx("font-semibold", isTest ? "text-amber-300" : "text-sky-300")}>
                      {isTest ? "SANDBOX" : "RoT"}
                    </span>
                  </span>

                  <span className="text-slate-700">•</span>

                  <span>
                    Entity: <span className="text-emerald-300 font-medium">{String(activeEntity ?? "—")}</span>
                  </span>
                </div>
              </div>

              <div className="shrink-0 flex items-center gap-2">
                <Link
                  href="/"
                  className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7 inline-flex items-center gap-2"
                  title="Back to Operator Console"
                >
                  <ArrowLeft className="h-4 w-4" />
                  Console
                </Link>
              </div>
            </div>
          </div>

          {/* OS Body */}
          <div className={body}>
            {/* iPhone-first: stacks; desktop: 3 columns */}
            <div className="grid grid-cols-12 gap-4">
              {/* LEFT: Filters */}
              <section className="col-span-12 lg:col-span-3">
                <div className="rounded-3xl border border-white/10 bg-black/20 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-200">Filters</div>
                      <div className="text-[11px] text-slate-500">Queue view + search</div>
                    </div>
                    <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[10px] tracking-[0.18em] uppercase text-slate-200">
                      filters
                    </span>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {tabBtn("active", "Active", activeQueue.length)}
                    {tabBtn("completed", "Completed", completedQueue.length)}
                  </div>

                  <div className="mt-4">
                    <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">Search</div>
                    <div className="mt-2 relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                      <input
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder="title, status…"
                        className="w-full rounded-2xl border border-white/10 bg-white/5 pl-10 pr-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-500 focus:border-amber-400/30"
                      />
                    </div>
                  </div>

                  <div className="mt-4 flex items-center justify-between text-xs text-slate-400">
                    <span>{loadingQueue ? "Loading…" : `${filteredQueue.length} item(s)`}</span>
                    {envPill()}
                  </div>

                  <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 p-3 text-xs text-slate-400">
                    Lane-safe: scoped by <span className="text-slate-200">entity_slug</span> +{" "}
                    <span className="text-slate-200">is_test</span>.
                  </div>

                  <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 p-3 text-xs text-slate-400">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={hideEnvelopes}
                        onChange={(e) => setHideEnvelopes(e.target.checked)}
                      />
                      Hide records that already have envelopes
                    </label>
                  </div>

                  {laneBadge()}
                </div>
              </section>

              {/* MIDDLE: Queue */}
              <section className="col-span-12 lg:col-span-6">
                <div className="rounded-3xl border border-white/10 bg-black/20 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-200">Queue</div>
                      <div className="text-[11px] text-slate-500">Execution items</div>
                    </div>
                    <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[10px] tracking-[0.18em] uppercase text-slate-200">
                      forge
                    </span>
                  </div>

                  {error ? (
                    <div className="mt-3 rounded-2xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-100">
                      {error}
                    </div>
                  ) : null}

                  {info ? (
                    <div className="mt-3 rounded-2xl border border-emerald-400/30 bg-emerald-400/10 p-3 text-sm text-emerald-100">
                      {info}
                    </div>
                  ) : null}

                  <div className="mt-3 space-y-2">
                    {filteredQueue.length === 0 ? (
                      <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-slate-400">
                        {loadingQueue ? "Loading queue…" : "No items match this view."}
                      </div>
                    ) : (
                      filteredQueue.map((item) => {
                        const risk = computeRiskLevel(item);
                        const selectedRow = item.ledger_id === selected?.ledger_id;

                        return (
                          <button
                            key={item.ledger_id}
                            type="button"
                            onClick={() => setSelectedId(item.ledger_id)}
                            className={cx(
                              "w-full text-left rounded-3xl border p-3 transition",
                              selectedRow
                                ? "border-amber-400/30 bg-amber-400/10"
                                : "border-white/10 bg-black/20 hover:bg-black/25"
                            )}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="text-sm font-medium text-slate-100 truncate">{item.title}</div>
                                <div className="mt-1 text-xs text-slate-400">
                                  Ledger: {item.ledger_status}{" "}
                                  {item.envelope_status ? `· Envelope: ${item.envelope_status}` : "· No envelope"}
                                </div>
                                <div className="mt-2 text-[11px] text-slate-500">
                                  Created: {fmt(item.created_at)} · Parties: {item.parties_signed ?? 0}/{item.parties_total ?? 0}
                                </div>
                              </div>

                              <div className="shrink-0 flex flex-col items-end gap-2">
                                <span className={cx("h-2.5 w-2.5 rounded-full", riskLightClasses(risk))} />
                                <span className="text-[10px] text-slate-400">{riskLabel(risk)}</span>
                              </div>
                            </div>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              </section>

              {/* RIGHT: Authority / Details */}
              <section className="col-span-12 lg:col-span-3">
                <div className="rounded-3xl border border-white/10 bg-black/20 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-200">Authority</div>
                      <div className="text-[11px] text-slate-500">Actions + sidecar</div>
                    </div>
                    <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[10px] tracking-[0.18em] uppercase text-slate-200">
                      control
                    </span>
                  </div>

                  {!selected ? (
                    <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-slate-400">
                      Select a queue item to act.
                    </div>
                  ) : (
                    <>
                      <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 p-3">
                        <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">Selected</div>
                        <div className="mt-1 text-sm font-semibold text-slate-100">{clamp(selected.title, 80)}</div>
                        <div className="mt-1 text-xs text-slate-400">
                          Ledger: {selected.ledger_status} · Envelope: {selected.envelope_status ?? "—"}
                        </div>

                        <div className="mt-3 flex items-center gap-2">
                          {stepDot(0)}
                          <span className="text-[11px] text-slate-400">Start</span>
                          <span className="text-slate-700">•</span>
                          {stepDot(2)}
                          <span className="text-[11px] text-slate-400">Sign</span>
                          <span className="text-slate-700">•</span>
                          {stepDot(3)}
                          <span className="text-[11px] text-slate-400">Archive</span>
                        </div>

                        {archiveBanner()}
                      </div>

                      {/* Right tabs (preserved, restyled only) */}
                      <div className="mt-3 flex flex-wrap gap-2">
                        {rightTabBtn("evidence", "Evidence")}
                        {rightTabBtn("axiom", "AXIOM")}
                        {rightTabBtn("portal", "Portal")}
                        {rightTabBtn("notes", "Notes")}
                      </div>

                      {/* PRIMARY ACTION (same logic) */}
                      <div className="mt-3">
                        <button
                          type="button"
                          disabled={primaryAction.disabled}
                          onClick={() => {
                            if (!selected) return;
                            if (primaryAction.key === "start") setStartModalOpen(true);
                            else if (primaryAction.key === "invite") setInviteModalOpen(true);
                            else if (primaryAction.key === "archive") setArchiveModalOpen(true);
                            else if (primaryAction.key === "view") onViewArchivePdf();
                          }}
                          className={cx(
                            "w-full rounded-2xl border px-4 py-3 text-[11px] font-semibold tracking-[0.18em] uppercase transition",
                            primaryAction.disabled
                              ? "border-white/10 bg-white/5 text-slate-500 cursor-not-allowed"
                              : "border-amber-400/25 bg-amber-400/10 text-amber-100 hover:bg-amber-400/15"
                          )}
                        >
                          {primaryAction.label}
                        </button>

                        <div className="mt-2 grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            onClick={() => setResealModalOpen(true)}
                            disabled={isResealing || !selected}
                            className={cx(
                              "rounded-2xl border px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase transition",
                              isResealing || !selected
                                ? "border-white/10 bg-white/5 text-slate-500 cursor-not-allowed"
                                : "border-white/10 bg-white/5 text-slate-200 hover:bg-white/7"
                            )}
                          >
                            Re-seal/Repair
                          </button>

                          <button
                            type="button"
                            onClick={() => onViewArchivePdf()}
                            disabled={isOpeningArchive || !selected}
                            className={cx(
                              "rounded-2xl border px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase transition",
                              isOpeningArchive || !selected
                                ? "border-white/10 bg-white/5 text-slate-500 cursor-not-allowed"
                                : "border-white/10 bg-white/5 text-slate-200 hover:bg-white/7"
                            )}
                          >
                            View Archive
                          </button>
                        </div>
                      </div>

                      {/* RIGHT TAB CONTENTS — UNCHANGED CONTENT, OS WRAPPERS ONLY */}
                      <div className="mt-3">
                        {rightTab === "portal" ? (
                          <div className="rounded-3xl border border-white/10 bg-black/20 p-3">
                            <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">Portal</div>
                            <div className="mt-2 text-xs text-slate-400">
                              External trust surfaces (from ci_portal_urls).
                            </div>

                            {portalError ? (
                              <div className="mt-2 text-xs text-rose-200">{portalError}</div>
                            ) : null}

                            <div className="mt-3 flex flex-col gap-2">
                              {portal.signer_url ? portalBtn(portal.signer_url, "Open Signer") : null}
                              {portal.viewer_url ? portalBtn(portal.viewer_url, "Open Viewer") : null}
                              {portal.verify_url ? portalBtn(portal.verify_url, "Open Verify") : null}
                              {portal.certificate_url ? portalBtn(portal.certificate_url, "Open Certificate") : null}
                              {!portal.signer_url && !portal.viewer_url && !portal.verify_url && !portal.certificate_url ? (
                                <div className="rounded-2xl border border-white/10 bg-black/20 p-3 text-xs text-slate-400">
                                  No portal URLs yet (start envelope first).
                                </div>
                              ) : null}
                            </div>
                          </div>
                        ) : null}

                        {rightTab === "axiom" ? (
                          <div className="rounded-3xl border border-white/10 bg-black/20 p-3">
                            <div className="flex items-center justify-between">
                              <div>
                                <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">AXIOM</div>
                                <div className="mt-1 text-xs text-slate-400">Advisory-only. Never blocks authority.</div>
                              </div>
                              <button
                                type="button"
                                onClick={() => onRunAxiomReview()}
                                disabled={axiomLoading || !selected}
                                className={cx(
                                  "rounded-full border px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase transition",
                                  axiomLoading || !selected
                                    ? "border-white/10 bg-white/5 text-slate-500 cursor-not-allowed"
                                    : "border-cyan-400/25 bg-cyan-400/10 text-cyan-100 hover:bg-cyan-400/15"
                                )}
                              >
                                Run AXIOM
                              </button>
                            </div>

                            {axiomError ? (
                              <div className="mt-2 rounded-2xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-100">
                                {axiomError}
                              </div>
                            ) : null}

                            {axiomInfo ? (
                              <div className="mt-2 rounded-2xl border border-emerald-400/30 bg-emerald-400/10 p-3 text-xs text-emerald-100">
                                {axiomInfo}
                              </div>
                            ) : null}

                            <div className="mt-3 flex flex-wrap gap-2">
                              {axiomTabBtn("advisory", "Advisory")}
                              {axiomTabBtn("summary", "Summary")}
                              {axiomTabBtn("analysis", "Analysis")}
                              {axiomTabBtn("advice", "Advice")}
                            </div>

                            <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 p-3 text-xs text-slate-300">
                              {axiomTab === "advisory" ? (
                                <ul className="list-disc pl-4 space-y-1">
                                  {axiomAdvisory.bullets.map((b, i) => (
                                    <li key={i}>{b}</li>
                                  ))}
                                </ul>
                              ) : null}

                              {axiomTab === "summary" ? (
                                <div className="whitespace-pre-wrap">
                                  {axiomLatest.summary?.summary || "No summary yet."}
                                </div>
                              ) : null}

                              {axiomTab === "analysis" ? (
                                <div className="whitespace-pre-wrap">
                                  {axiomLatest.analysis?.analysis || "No analysis yet."}
                                </div>
                              ) : null}

                              {axiomTab === "advice" ? (
                                <div className="whitespace-pre-wrap">
                                  {axiomLatest.advice?.advice || axiomLatest.advice?.recommendation || "No advice yet."}
                                </div>
                              ) : null}
                            </div>
                          </div>
                        ) : null}

                        {rightTab === "evidence" ? (
                          <div className="rounded-3xl border border-white/10 bg-black/20 p-3">
                            <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">Archive evidence</div>
                            <div className="mt-1 text-xs text-slate-400">
                              Minute Book + supporting docs + verified registry pointers.
                            </div>

                            {evidenceError ? (
                              <div className="mt-2 text-xs text-rose-200">{evidenceError}</div>
                            ) : null}

                            <div className="mt-3 space-y-2 text-xs text-slate-300">
                              <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                                <div className="text-slate-400">Minute Book Entry</div>
                                <div className="mt-1 text-slate-100">{evidence.minute_book_entry_id ?? "—"}</div>
                                <div className="mt-1 text-slate-500">{evidence.minute_book_title ?? ""}</div>
                              </div>

                              <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                                <div className="text-slate-400">Verified Document</div>
                                <div className="mt-1 text-slate-100">{evidence.verified_document?.id ?? "—"}</div>
                                <div className="mt-1 text-slate-500 font-mono break-all">
                                  {evidence.verified_document?.storage_path ?? ""}
                                </div>
                              </div>

                              <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                                <div className="text-slate-400">Supporting Docs</div>
                                <div className="mt-1 text-slate-100">{evidence.supporting_docs.length}</div>
                              </div>

                              <button
                                type="button"
                                onClick={() => selected?.ledger_id && loadArchiveEvidence(selected.ledger_id)}
                                disabled={evidenceLoading || !selected}
                                className={cx(
                                  "w-full rounded-2xl border px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase transition",
                                  evidenceLoading || !selected
                                    ? "border-white/10 bg-white/5 text-slate-500 cursor-not-allowed"
                                    : "border-white/10 bg-white/5 text-slate-200 hover:bg-white/7"
                                )}
                              >
                                Refresh evidence
                              </button>
                            </div>
                          </div>
                        ) : null}

                        {rightTab === "notes" ? (
                          <div className="rounded-3xl border border-white/10 bg-black/20 p-3">
                            <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">Notes</div>
                            <div className="mt-2 text-xs text-slate-400">
                              (Reserved) Operator notes. No mutations here.
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </>
                  )}
                </div>
              </section>
            </div>

            {/* OS behavior footnote (matches Verified Registry) */}
            <div className="mt-5 rounded-3xl border border-white/10 bg-black/20 px-4 py-3 text-[11px] text-slate-400">
              <div className="font-semibold text-slate-200">OS behavior</div>
              <div className="mt-1 leading-relaxed text-slate-400">
                CI-Forge inherits the OS shell. Authority actions are explicit. Lane-safe and entity-scoped.
              </div>
            </div>

            <div className="mt-5 flex items-center justify-between text-[10px] text-slate-600">
              <span>CI-Forge · Oasis Digital Parliament</span>
              <span>ODP.AI · Governance Firmware</span>
            </div>
          </div>
        </div>

        {/* optional quick links row (same grammar as Archive launchpad) */}
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

      {/* ==========================
          MODALS (UNTOUCHED)
      ========================== */}
      <Modal
        open={startModalOpen}
        title="Start envelope"
        description="Creates a signature envelope for this record."
        confirmLabel={isStarting ? "Starting…" : "Start"}
        confirmTone="amber"
        confirmDisabled={isStarting}
        onConfirm={doStartEnvelope}
        onClose={() => setStartModalOpen(false)}
      >
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            doStartEnvelope();
          }}
          className="space-y-3"
        >
          <div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Signer name</div>
            <input
              value={primarySignerName}
              onChange={(e) => setPrimarySignerName(e.target.value)}
              className="mt-2 w-full rounded-2xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-200 outline-none focus:border-amber-400/30"
              placeholder="Full name"
            />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Signer email</div>
            <input
              value={primarySignerEmail}
              onChange={(e) => setPrimarySignerEmail(e.target.value)}
              className="mt-2 w-full rounded-2xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-200 outline-none focus:border-amber-400/30"
              placeholder="email@example.com"
            />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">CC emails (comma separated)</div>
            <input
              value={ccEmails}
              onChange={(e) => setCcEmails(e.target.value)}
              className="mt-2 w-full rounded-2xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-200 outline-none focus:border-amber-400/30"
              placeholder="optional"
            />
          </div>
        </form>
      </Modal>

      <Modal
        open={inviteModalOpen}
        title="Send invite"
        description="Sends the signature invite email using the envelope."
        confirmLabel={isSendingInvite ? "Sending…" : "Send"}
        confirmTone="amber"
        confirmDisabled={isSendingInvite}
        onConfirm={doSendInvite}
        onClose={() => setInviteModalOpen(false)}
      >
        <div className="text-sm text-slate-300">
          This will send/re-send the invite for the current envelope.
        </div>
      </Modal>

      <Modal
        open={archiveModalOpen}
        title="Archive now"
        description="Generates archive-grade artifacts, writes Verified pointers, and registers Minute Book evidence."
        confirmLabel={isArchiving ? "Archiving…" : "Archive"}
        confirmTone="amber"
        confirmDisabled={isArchiving}
        onConfirm={doArchiveSigned}
        onClose={() => setArchiveModalOpen(false)}
      >
        <div className="text-sm text-slate-300">
          Archive is idempotent. If already archived, Forge will report no action required.
        </div>
      </Modal>

      <Modal
        open={resealModalOpen}
        title="Re-seal / Repair"
        description="Idempotent repair: re-writes pointers + registry if anything is missing."
        confirmLabel={isResealing ? "Running…" : "Run repair"}
        confirmTone="cyan"
        confirmDisabled={isResealing}
        onConfirm={async () => {
          await onRepairReseal();
          setResealModalOpen(false);
        }}
        onClose={() => setResealModalOpen(false)}
      >
        <div className="text-sm text-slate-300">
          Safe to run multiple times. Does not mutate signed artifacts—only repairs registry pointers if missing.
        </div>
      </Modal>
    </div>
  );
}

