// src/app/(os)/ci-council/page.tsx
"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";
import { ArrowLeft, ShieldCheck, Search } from "lucide-react";

/**
 * ✅ CANONICAL STATUS SET (matches your check constraint)
 * governance_ledger.status valid values:
 * DRAFT/PENDING/APPROVED/REJECTED/READY_FOR_SIGNATURE/SIGNED/ARCHIVED
 */
type CouncilStatus =
  | "DRAFT"
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "READY_FOR_SIGNATURE"
  | "SIGNED"
  | "ARCHIVED";

type StatusTab = "PENDING" | "APPROVED" | "REJECTED" | "ARCHIVED" | "ALL";
type DetailTab = "AXIOM" | "ARTIFACTS"; // ✅ no duplicate Record tab

type LedgerRecord = {
  id: string;
  title: string | null;
  status: CouncilStatus | string | null;
  entity_id: string | null;
  is_test: boolean | null;
  created_at: string | null;

  body?: string | null;
  record_type?: string | null;
  source?: string | null;
};

type AxiomNote = {
  id: string;
  title: string | null;
  content: string | null;
  model: string | null;
  tokens_used: number | null;
  created_at: string | null;
  severity?: string | null;
};

type AxiomMemo = {
  ok: boolean;
  memo_id?: string;
  note_id?: string;
  severity?: "GREEN" | "YELLOW" | "RED" | "INFO" | string;
  storage_bucket?: string;
  storage_path?: string;
  file_hash?: string;
  file_size?: number;
  mime_type?: string;
  error?: string;
  warning?: string;
  supporting_document_id?: string | null;
};

// ---- Edge Functions (stable names) ----
const AXIOM_COUNCIL_MEMO_FN = "axiom-council-memo";
const AXIOM_COUNCIL_REVIEW_FN = "axiom-council-review"; // writes ai_notes for governance_ledger.id

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

function isMissingColumnErr(err: unknown) {
  const msg = String((err as any)?.message ?? "").toLowerCase();
  return msg.includes("does not exist") && msg.includes("column");
}

function isTruthImmutableErr(err: unknown) {
  const msg = String((err as any)?.message ?? "").toLowerCase();
  return msg.includes("truth records are immutable") || msg.includes("immutable");
}

function severityPill(sev?: string | null) {
  const s = (sev ?? "").toUpperCase();
  if (s.includes("RED") || s.includes("HIGH") || s.includes("CRITICAL")) {
    return "bg-rose-500/15 text-rose-200 border-rose-400/40";
  }
  if (s.includes("YELLOW") || s.includes("MED") || s.includes("WARN")) {
    return "bg-amber-500/15 text-amber-200 border-amber-400/40";
  }
  if (s.includes("GREEN") || s.includes("LOW") || s.includes("OK")) {
    return "bg-emerald-500/15 text-emerald-200 border-emerald-400/40";
  }
  return "bg-slate-700/30 text-slate-200 border-slate-600/40";
}

// ✅ infer severity from title/content only (no metadata dependency)
function inferSeverity(title?: string | null, content?: string | null) {
  const t = `${title ?? ""}\n${content ?? ""}`.toUpperCase();

  if (
    t.includes("SEVERITY: RED") ||
    t.includes("[RED]") ||
    t.includes("🔴") ||
    t.includes("CRITICAL") ||
    t.includes("HIGH RISK")
  )
    return "RED";
  if (
    t.includes("SEVERITY: YELLOW") ||
    t.includes("[YELLOW]") ||
    t.includes("🟡") ||
    t.includes("WARNING") ||
    t.includes("MEDIUM RISK")
  )
    return "YELLOW";
  if (
    t.includes("SEVERITY: GREEN") ||
    t.includes("[GREEN]") ||
    t.includes("🟢") ||
    t.includes("OK") ||
    t.includes("LOW RISK")
  )
    return "GREEN";

  return null;
}

function hashShort(hash?: string | null) {
  if (!hash) return "—";
  if (hash.length <= 18) return hash;
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`;
}

function bytesPretty(n?: number | null) {
  if (!n || n <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

type ConfirmKind = "APPROVE" | "REJECT" | "SENDBACK";
type ConfirmState =
  | { open: false }
  | { open: true; kind: ConfirmKind; title: string; subtitle?: string };

function ConfirmModal({
  state,
  busy,
  onCancel,
  onConfirm,
}: {
  state: ConfirmState;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!state.open) return null;

  const tone =
    state.kind === "APPROVE"
      ? "border-emerald-400/50 bg-emerald-500/10"
      : state.kind === "REJECT"
      ? "border-rose-400/50 bg-rose-500/10"
      : "border-amber-400/50 bg-amber-500/10";

  const cta =
    state.kind === "APPROVE"
      ? "Confirm Approve"
      : state.kind === "REJECT"
      ? "Confirm Reject"
      : "Confirm Send Back";

  const ctaStyle =
    state.kind === "APPROVE"
      ? "border border-emerald-400/60 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/20"
      : state.kind === "REJECT"
      ? "border border-rose-400/60 bg-rose-500/15 text-rose-200 hover:bg-rose-500/20"
      : "border border-amber-400/60 bg-amber-500/15 text-amber-200 hover:bg-amber-500/20";

  return (
    <div className="fixed inset-0 z-[100] bg-black/70 px-4 sm:px-6 py-6 flex items-center justify-center">
      <div className="w-full max-w-[560px] rounded-3xl border border-white/12 bg-[#070A12]/90 shadow-[0_40px_160px_rgba(0,0,0,0.70)] overflow-hidden">
        <div className="px-6 py-5 border-b border-white/10">
          <div className="text-[11px] uppercase tracking-[0.22em] text-slate-400">
            Authority Confirmation
          </div>
          <div className="mt-2 text-[15px] font-semibold text-slate-100">{state.title}</div>
          {state.subtitle && (
            <div className="mt-2 text-[12px] text-slate-400">{state.subtitle}</div>
          )}
        </div>

        <div className="px-6 py-5">
          <div
            className={cx(
              "rounded-2xl border px-4 py-4 text-[12px] text-slate-200",
              tone
            )}
          >
            <div className="text-slate-200">
              This will apply an <b>authority decision</b> to the selected record.
            </div>
            <div className="mt-2 text-slate-400">
              No archive/seal happens here. Execution discipline stays in Forge / seal pipeline.
            </div>
          </div>

          <div className="mt-5 flex items-center justify-end gap-2">
            <button
              onClick={onCancel}
              disabled={busy}
              className="rounded-full border border-white/12 bg-white/5 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/8 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              disabled={busy}
              className={cx(
                "rounded-full px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition disabled:opacity-50 disabled:cursor-not-allowed",
                ctaStyle
              )}
            >
              {busy ? "Working…" : cta}
            </button>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-white/10 text-[10px] text-slate-500 flex items-center justify-between">
          <span>CI-Council · Authority gate</span>
          <span>Scoped by entity_id + is_test</span>
        </div>
      </div>
    </div>
  );
}

export default function CICouncilPage() {
  const entityCtx = useEntity() as any;
  const envCtx = useOsEnv() as any;

  // ✅ OS-consistent entity resolution (NO hardcoded corporate names; flows from OS context)
  const activeEntitySlug: string =
    (entityCtx?.entityKey as string) ||
    (entityCtx?.activeEntity as string) ||
    (entityCtx?.entity_slug as string) ||
    (entityCtx?.activeEntityKey as string) ||
    "";

  const activeEntityNameFromCtx: string =
    (entityCtx?.entityName as string) ||
    (entityCtx?.activeEntityName as string) ||
    (entityCtx?.entity_name as string) ||
    "";

  const activeEntityIdFromCtx: string | null =
    (entityCtx?.activeEntityId as string) ||
    (entityCtx?.entityId as string) ||
    (entityCtx?.entity_id as string) ||
    null;

  // ✅ env toggle ONLY controls is_test (defensive)
  const isSandbox: boolean = Boolean(
    envCtx?.is_test ??
      envCtx?.isTest ??
      envCtx?.lane_is_test ??
      envCtx?.sandbox ??
      envCtx?.isSandbox ??
      false
  );
  const env: "SANDBOX" | "ROT" = isSandbox ? "SANDBOX" : "ROT";

  const activeEntityLabel = useMemo(() => {
    if (activeEntityNameFromCtx?.trim()) return activeEntityNameFromCtx.trim();
    if (!activeEntitySlug) return "—";
    return activeEntitySlug;
  }, [activeEntitySlug, activeEntityNameFromCtx]);

  const [entityId, setEntityId] = useState<string | null>(activeEntityIdFromCtx);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | "approve" | "reject" | "archive" | "sendback">(null);

  const [tab, setTab] = useState<StatusTab>("PENDING");
  const [detailTab, setDetailTab] = useState<DetailTab>("AXIOM");
  const [query, setQuery] = useState("");
  const [queueOpen, setQueueOpen] = useState(true);

  const [records, setRecords] = useState<LedgerRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [readerOpen, setReaderOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Authority confirm modals (Admissions-style)
  const [confirm, setConfirm] = useState<ConfirmState>({ open: false });

  // AXIOM (Council)
  const [axiomBusy, setAxiomBusy] = useState<null | "load" | "run" | "memo" | "url">(null);
  const [axiomNotes, setAxiomNotes] = useState<AxiomNote[]>([]);
  const [axiomSelectedNoteId, setAxiomSelectedNoteId] = useState<string | null>(null);
  const [axiomLastMemo, setAxiomLastMemo] = useState<AxiomMemo | null>(null);
  const [axiomMemoUrl, setAxiomMemoUrl] = useState<string | null>(null);

  // AXIOM Focus Mode (UI only — no wiring changes)
  const [axiomFocus, setAxiomFocus] = useState(false);

  const lastAutoPickRef = useRef<string | null>(null);
  const lastAxiomAutoloadKeyRef = useRef<string | null>(null);
  const lastArtifactsAutoloadKeyRef = useRef<string | null>(null);

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

  // env filtering (extra safety if table/view ever returns mixed lanes)
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

  async function ensureEntityId(slug: string) {
    if (entityId) return entityId;

    if (activeEntityIdFromCtx) {
      setEntityId(activeEntityIdFromCtx);
      return activeEntityIdFromCtx;
    }

    if (!slug) throw new Error("OS Context missing entity slug.");

    const { data, error } = await supabase
      .from("entities")
      .select("id, slug")
      .eq("slug", slug)
      .single();

    if (error || !data?.id) throw error ?? new Error("Entity lookup failed.");
    setEntityId(data.id);
    return data.id as string;
  }

  async function reload(preserveSelection = true) {
    setLoading(true);
    setError(null);

    try {
      if (!activeEntitySlug && !entityId) {
        setRecords([]);
        setSelectedId(null);
        return;
      }

      const eid = await ensureEntityId(activeEntitySlug);

      const tryWithIsTest = async () => {
        const { data, error } = await supabase
          .from("governance_ledger")
          .select("id,title,status,entity_id,is_test,created_at,body,record_type,source")
          .eq("entity_id", eid)
          .eq("is_test", isSandbox)
          .order("created_at", { ascending: false });

        if (error) throw error;
        return (data ?? []) as LedgerRecord[];
      };

      const tryWithoutIsTest = async () => {
        const { data, error } = await supabase
          .from("governance_ledger")
          .select("id,title,status,entity_id,created_at,body,record_type,source")
          .eq("entity_id", eid)
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

      if (preserveSelection && selectedId) {
        const still = rows.find((r) => r.id === selectedId);
        if (still) return;
      }

      const tabKey = tab === "ALL" ? "ALL" : tab;
      const inTab = tabKey === "ALL" ? rows : rows.filter((r) => (r.status ?? "").toUpperCase() === tabKey);

      const pick = inTab[0] ?? rows[0] ?? null;
      if (pick) {
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

  // keep entityId in sync if ctx becomes available
  useEffect(() => {
    if (activeEntityIdFromCtx && activeEntityIdFromCtx !== entityId) setEntityId(activeEntityIdFromCtx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEntityIdFromCtx]);

  useEffect(() => {
    setTab("PENDING");
    setQuery("");
    setSelectedId(null);
    setDetailTab("AXIOM");
    setAxiomFocus(false);
    void reload(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEntitySlug, isSandbox]);

  function resetAxiomState() {
    setAxiomNotes([]);
    setAxiomSelectedNoteId(null);
    setAxiomLastMemo(null);
    setAxiomMemoUrl(null);
  }

  function handleSelect(rec: LedgerRecord) {
    if (!rec?.id) return;
    setSelectedId(rec.id);
    setError(null);
    setInfo(null);
    resetAxiomState();
  }

  /**
   * Authority status update:
   * Prefer SECURITY DEFINER RPC (if present), fallback direct update.
   */
  async function setCouncilStatus(recordId: string, next: CouncilStatus) {
    // 1) RPC first
    try {
      const { data, error } = await supabase.rpc("council_set_status", {
        p_record_id: recordId,
        p_next_status: next,
      });

      if (!error) {
        const ok = (data as any)?.ok;
        if (ok === false) throw new Error((data as any)?.error ?? "Council RPC failed.");
        return;
      }

      const msg = (error?.message ?? "").toLowerCase();
      if (!msg.includes("function") && !msg.includes("does not exist")) throw error;
    } catch (e: any) {
      if (isTruthImmutableErr(e)) throw e;
      // fall through to direct update
    }

    // 2) fallback update
    const { error: upErr } = await supabase.from("governance_ledger").update({ status: next }).eq("id", recordId);
    if (upErr) throw upErr;
  }

  async function updateStatus(next: CouncilStatus) {
    if (!selected?.id) return flashError("Select a record first.");

    const current = (selected.status ?? "").toUpperCase();
    if (current === next) return flashInfo(`Already ${next}.`);

    if (next === "APPROVED") setBusy("approve");
    if (next === "REJECTED") setBusy("reject");
    if (next === "ARCHIVED") setBusy("archive");

    setError(null);
    setInfo(null);

    try {
      await setCouncilStatus(selected.id, next);
      setRecords((prev) => prev.map((r) => (r.id === selected.id ? { ...r, status: next } : r)));
      flashInfo(`Council: ${next}.`);
    } catch (err: any) {
      if (isTruthImmutableErr(err)) {
        flashError(
          "DB guardrail blocked this update: “Truth records are immutable”. Council must set status via SECURITY DEFINER SQL (rpc: council_set_status)."
        );
      } else {
        flashError(err?.message ?? `Failed to set status ${next}.`);
      }
    } finally {
      setBusy(null);
      void reload(true);
    }
  }

  /**
   * ✅ CANONICAL SEND-BACK (NO REGRESSION)
   * Calls the RPC you just installed:
   * public.council_send_back_to_alchemy(p_record_id uuid, p_reason text)
   * Returns { ok, draft_id, record_id }.
   *
   * - No probing other function names (avoids regressions)
   * - Opens Alchemy with draft_id (best UX)
   * - Falls back to opening Alchemy with from_ledger param if needed
   */
  async function sendBackToAlchemy() {
    if (!selected?.id) return flashError("Select a record first.");
    setBusy("sendback");
    setError(null);
    setInfo(null);

    const openFallback = () => {
      window.open(`/ci-alchemy?from_ledger=${encodeURIComponent(selected.id)}`, "_blank", "noopener,noreferrer");
    };

    try {
      const { data, error } = await supabase.rpc("council_send_back_to_alchemy", {
        p_record_id: selected.id,
        p_reason: "Council send-back",
      });

      if (error) throw error;

      const ok = (data as any)?.ok;
      if (ok === false) throw new Error((data as any)?.error ?? "Send-back failed.");

      const draftId = (data as any)?.draft_id as string | undefined;

      flashInfo("Sent back to Alchemy.");
      await reload(true);

      if (draftId) {
        window.open(`/ci-alchemy?draft_id=${encodeURIComponent(draftId)}`, "_blank", "noopener,noreferrer");
      } else {
        openFallback();
      }
    } catch (err: any) {
      if (isTruthImmutableErr(err)) {
        flashError("Blocked by immutability guardrail (Truth lane).");
      } else {
        flashError(`Send-back failed; opening Alchemy fallback. (${err?.message ?? "unknown error"})`);
        openFallback();
      }
    } finally {
      setBusy(null);
    }
  }

  const canApprove = !!selected && (selected.status ?? "").toUpperCase() === "PENDING";
  const canReject = !!selected && (selected.status ?? "").toUpperCase() === "PENDING";
  const canSendBack = !!selected;
  const showNoEntityWarning = !activeEntitySlug;

  // AXIOM helpers (Council)
  const axiomSelected = useMemo(() => {
    const pick = axiomNotes.find((n) => n.id === axiomSelectedNoteId);
    return pick ?? (axiomNotes[0] ?? null);
  }, [axiomNotes, axiomSelectedNoteId]);

  async function loadAxiomNotesForSelected() {
    if (!selected?.id) return;

    setAxiomBusy("load");
    try {
      // IMPORTANT: do NOT select metadata (may not exist). Keep stable.
      const { data, error } = await supabase
        .from("ai_notes")
        .select("id,title,content,model,tokens_used,created_at,note_type")
        .eq("scope_type", "document")
        .eq("scope_id", selected.id)
        .in("note_type", ["summary", "memo", "note"])
        .order("created_at", { ascending: false })
        .limit(30);

      if (error) throw error;

      const notes: AxiomNote[] = (data ?? []).map((r: any) => ({
        id: r.id,
        title: r.title ?? "AXIOM Advisory",
        content: r.content ?? "",
        model: r.model ?? null,
        tokens_used: r.tokens_used ?? null,
        created_at: r.created_at ?? null,
        severity: inferSeverity(r.title, r.content),
      }));

      setAxiomNotes(notes);
      setAxiomSelectedNoteId(notes[0]?.id ?? null);

      if (!notes.length) flashInfo("AXIOM: no advisory yet for this record.");
    } catch (e: any) {
      flashError(e?.message ?? "AXIOM: failed to load advisory.");
    } finally {
      setAxiomBusy(null);
    }
  }

  async function runAxiomCouncilReview() {
    if (!selected?.id) return flashError("Select a record first.");

    setAxiomBusy("run");
    try {
      const { data, error } = await supabase.functions.invoke(AXIOM_COUNCIL_REVIEW_FN, {
        body: { record_id: selected.id, is_test: isSandbox },
      });

      if (error) {
        const msg = (error as any)?.message ?? "AXIOM council review failed.";
        const lower = msg.toLowerCase();
        if (lower.includes("not found") || lower.includes("404")) {
          throw new Error(
            "AXIOM council review is not deployed. Deploy Edge Function `axiom-council-review` (writes ai_notes for governance_ledger.id)."
          );
        }
        throw new Error(msg);
      }

      const ok = (data as any)?.ok;
      if (ok === false) throw new Error((data as any)?.error ?? "AXIOM council review failed.");

      flashInfo("AXIOM: advisory generated.");
      await loadAxiomNotesForSelected();
    } catch (e: any) {
      flashError(e?.message ?? "AXIOM: run failed.");
    } finally {
      setAxiomBusy(null);
    }
  }

  async function ensureSignedUrlForMemo(bucket?: string | null, path?: string | null) {
    if (!bucket || !path) return;
    if (axiomBusy !== null) return;

    setAxiomBusy("url");
    try {
      const { data: urlData, error: urlErr } = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 15);
      if (!urlErr && urlData?.signedUrl) setAxiomMemoUrl(urlData.signedUrl);
    } finally {
      setAxiomBusy(null);
    }
  }

  async function invokeAxiomMemoEdgeFunction() {
    if (!selected?.id) return flashError("Select a record first.");

    setAxiomBusy("memo");
    setAxiomLastMemo(null);
    setAxiomMemoUrl(null);

    try {
      const payload = {
        record_id: selected.id,
        is_test: isSandbox,
        memo: {
          title: `AXIOM Council Memo — ${activeEntityLabel}`,
          executive_summary: (axiomSelected?.content ?? "").slice(0, 6000),
          findings: [],
          notes: `Generated from Council. Source note: ${axiomSelected?.id ?? "—"}`,
        },
      };

      const { data, error } = await supabase.functions.invoke(AXIOM_COUNCIL_MEMO_FN, { body: payload });

      if (error) {
        const msg = (error as any)?.message ?? "AXIOM memo invoke failed.";
        const lower = msg.toLowerCase();

        if (lower.includes("not found") || lower.includes("404")) {
          throw new Error(
            "AXIOM memo is not deployed. Council is still stable — deploy Edge Function `axiom-council-memo` to enable memo PDFs."
          );
        }

        if (lower.includes("storage") || lower.includes("objects") || lower.includes("is_test")) {
          throw new Error(
            "AXIOM memo failed during Storage upload (a storage.objects trigger is referencing a non-existent NEW.is_test field). Fix that trigger/function for the memo bucket, or disable memo generation for now."
          );
        }

        throw new Error(msg);
      }

      const memo = data as AxiomMemo;
      if (!memo || memo.ok === false) throw new Error(memo?.error ?? "AXIOM memo failed.");

      setAxiomLastMemo(memo);
      flashInfo(memo.warning ? "AXIOM memo: ok (warning)." : "AXIOM memo generated & registered.");

      void loadAxiomNotesForSelected();

      if (memo.storage_bucket && memo.storage_path) {
        await ensureSignedUrlForMemo(memo.storage_bucket, memo.storage_path);
      }
    } catch (e: any) {
      flashError(e?.message ?? "AXIOM: memo generation failed.");
    } finally {
      setAxiomBusy(null);
    }
  }

  // Preload AXIOM when tab opens
  useEffect(() => {
    if (!selected?.id) return;
    if (detailTab !== "AXIOM") return;
    if (axiomBusy !== null) return;

    const key = `${selected.id}:${env}`;
    if (axiomNotes.length > 0 && lastAxiomAutoloadKeyRef.current === key) return;

    lastAxiomAutoloadKeyRef.current = key;
    void loadAxiomNotesForSelected();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailTab, selectedId]);

  // Preload Artifacts: if memo exists but no signed URL yet, create it automatically
  useEffect(() => {
    if (!selected?.id) return;
    if (detailTab !== "ARTIFACTS") return;

    const key = `${selected.id}:${env}`;
    if (lastArtifactsAutoloadKeyRef.current === key && axiomMemoUrl) return;
    lastArtifactsAutoloadKeyRef.current = key;

    if (axiomLastMemo?.storage_bucket && axiomLastMemo?.storage_path && !axiomMemoUrl) {
      void ensureSignedUrlForMemo(axiomLastMemo.storage_bucket, axiomLastMemo.storage_path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailTab, selectedId, axiomLastMemo?.storage_bucket, axiomLastMemo?.storage_path]);

  const axiomSeverityLabel =
    (axiomLastMemo?.severity as string | undefined) ?? (axiomSelected?.severity as string | undefined) ?? null;

  // UI polish: close queue automatically in AXIOM focus (pure UI)
  useEffect(() => {
    if (axiomFocus) setQueueOpen(false);
  }, [axiomFocus]);

  function openConfirm(kind: ConfirmKind) {
    if (!selected) return flashError("Select a record first.");

    const recordTitle = selected.title || "(untitled)";
    if (kind === "APPROVE") {
      setConfirm({
        open: true,
        kind,
        title: "Approve this record?",
        subtitle: `Record: ${recordTitle}`,
      });
      return;
    }
    if (kind === "REJECT") {
      setConfirm({
        open: true,
        kind,
        title: "Reject this record?",
        subtitle: `Record: ${recordTitle}`,
      });
      return;
    }
    setConfirm({
      open: true,
      kind,
      title: "Send back to Alchemy?",
      subtitle: `Record: ${recordTitle}`,
    });
  }

  async function confirmAction() {
    if (!confirm.open) return;
    if (!selected?.id) return;

    if (confirm.kind === "APPROVE") return updateStatus("APPROVED");
    if (confirm.kind === "REJECT") return updateStatus("REJECTED");
    return sendBackToAlchemy();
  }

  const showToast = Boolean(error || info);

  // ✅ OS shell/header/body pattern (MATCH Verified/Forge/Minute Book)
  const shell =
    "rounded-3xl border border-white/10 bg-black/20 shadow-[0_28px_120px_rgba(0,0,0,0.55)] overflow-hidden";
  const header =
    "border-b border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent px-4 sm:px-6 py-4 sm:py-5";
  const body = "px-4 sm:px-6 py-5 sm:py-6";

  return (
    <div className="w-full">
      <div className="mx-auto w-full max-w-[1400px] px-4 pb-10 pt-4 sm:pt-6">
        <div className={shell}>
          {/* OS-aligned header */}
          <div className={header}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10px] sm:text-xs tracking-[0.3em] uppercase text-slate-500">CI • Council</div>
                <h1 className="mt-1 text-lg sm:text-xl font-semibold text-slate-50">Council Review</h1>
                <p className="mt-1 max-w-3xl text-[11px] sm:text-xs text-slate-400 leading-relaxed">
                  Authority gate for governance_ledger. Approve / Reject / Send Back. Execution and archival discipline
                  stays in Forge and the deterministic seal pipeline.
                </p>

                <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-400">
                  <span className="inline-flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-emerald-300" />
                    <span>Authority surface • Non-mutating review</span>
                  </span>
                  <span className="text-slate-700">•</span>
                  <span>
                    Lane:{" "}
                    <span className={cx("font-semibold", isSandbox ? "text-amber-300" : "text-sky-300")}>{env}</span>
                  </span>
                  <span className="text-slate-700">•</span>
                  <span>
                    Entity: <span className="text-emerald-300 font-medium">{activeEntityLabel}</span>
                  </span>
                  {axiomSeverityLabel && (
                    <>
                      <span className="text-slate-700">•</span>
                      <span
                        className={cx(
                          "inline-flex items-center rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.18em]",
                          severityPill(axiomSeverityLabel)
                        )}
                        title="Inferred severity (no metadata dependency)"
                      >
                        {axiomSeverityLabel}
                      </span>
                    </>
                  )}
                </div>
              </div>

              <div className="shrink-0 flex items-center gap-2">
                <Link href="/ci-council" className="hidden" aria-hidden="true" tabIndex={-1} />
                <Link href="/" className="hidden" aria-hidden="true" tabIndex={-1} />

                <Link
                  href="/ci-archive"
                  className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7 inline-flex items-center gap-2"
                  title="Back to Archive surfaces"
                >
                  <ArrowLeft className="h-4 w-4" />
                  Archive
                </Link>

                <button
                  onClick={() => {
                    setAxiomFocus((v) => !v);
                    setDetailTab("AXIOM");
                  }}
                  disabled={!selected}
                  className={cx(
                    "rounded-full px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase transition",
                    !selected
                      ? "border border-white/10 bg-white/5 text-slate-500 cursor-not-allowed"
                      : axiomFocus
                      ? "border border-amber-400/60 bg-amber-500/10 text-amber-200 hover:bg-amber-500/15"
                      : "border border-indigo-400/50 bg-indigo-500/10 text-indigo-200 hover:bg-indigo-500/15"
                  )}
                  title="Focus mode: give AXIOM full workspace (UI only)"
                >
                  {axiomFocus ? "Back to Council" : "Focus AXIOM"}
                </button>
              </div>
            </div>

            {showNoEntityWarning && (
              <div className="mt-4 rounded-2xl border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-[12px] text-amber-200">
                OS Context: missing entity selection. Council will activate once an entity is selected in the OS control
                plane.
              </div>
            )}
          </div>

          <div className={body}>
            {/* iPhone-first surface: stacks; desktop: 3 columns */}
            {axiomFocus ? (
              <section className="rounded-3xl border border-white/10 bg-black/20 overflow-hidden">
                <div className="px-5 sm:px-6 py-5 border-b border-white/10 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-indigo-200">
                      AXIOM Focus · Council Advisory
                    </div>
                    <div className="mt-1 text-[12px] text-slate-400">
                      Record: <span className="text-slate-100 font-semibold">{selected?.title || "—"}</span>
                      <span className="mx-2 text-slate-700">•</span>
                      <span className={cx("font-semibold", isSandbox ? "text-amber-300" : "text-sky-300")}>{env}</span>
                      {axiomSeverityLabel && (
                        <>
                          <span className="mx-2 text-slate-700">•</span>
                          <span
                            className={cx(
                              "inline-flex items-center rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.18em]",
                              severityPill(axiomSeverityLabel)
                            )}
                          >
                            {axiomSeverityLabel}
                          </span>
                        </>
                      )}
                    </div>

                    <div className="mt-2 text-[11px] text-slate-500 max-w-3xl">
                      AXIOM is advisory-only. Memo PDF is a lane-scoped sidecar attachment and never mutates the
                      resolution.
                    </div>
                  </div>

                  <div className="shrink-0 flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => loadAxiomNotesForSelected()}
                      disabled={!selected || axiomBusy !== null}
                      className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/8 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {axiomBusy === "load" ? "Loading…" : "Load"}
                    </button>

                    <button
                      onClick={() => runAxiomCouncilReview()}
                      disabled={!selected || axiomBusy !== null}
                      className="rounded-full border border-indigo-400/50 bg-indigo-500/10 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-indigo-200 hover:bg-indigo-500/15 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {axiomBusy === "run" ? "Running…" : "Run AXIOM"}
                    </button>

                    <button
                      onClick={() => invokeAxiomMemoEdgeFunction()}
                      disabled={!selected || axiomBusy !== null}
                      className="rounded-full border border-amber-400/50 bg-amber-500/10 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-amber-200 hover:bg-amber-500/15 disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Renders AXIOM Memo PDF as sidecar evidence"
                    >
                      {axiomBusy === "memo" ? "Generating…" : "Memo PDF"}
                    </button>

                    <button
                      onClick={() => setAxiomFocus(false)}
                      className="rounded-full border border-amber-400/60 bg-amber-500/10 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-amber-200 hover:bg-amber-500/15"
                    >
                      Back
                    </button>
                  </div>
                </div>

                <div className="p-4 sm:p-5 grid grid-cols-1 lg:grid-cols-12 gap-4">
                  {/* History */}
                  <div className="lg:col-span-4 rounded-3xl border border-white/10 bg-black/20 overflow-hidden flex flex-col">
                    <div className="px-4 py-4 border-b border-white/10">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-[11px] uppercase tracking-[0.22em] text-slate-300">Advisory History</div>
                        <button
                          onClick={() => loadAxiomNotesForSelected()}
                          disabled={axiomBusy !== null}
                          className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/8 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {axiomBusy === "load" ? "…" : "Reload"}
                        </button>
                      </div>
                      <div className="mt-2 text-[11px] text-slate-500">
                        Showing {axiomNotes.length} note(s) · <span className="font-mono">ai_notes</span>
                      </div>
                    </div>

                    {/* list scroll only */}
                    <div className="flex-1 overflow-y-auto p-3 space-y-2 max-h-[560px]">
                      {axiomNotes.length === 0 ? (
                        <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-4 text-[12px] text-slate-500">
                          No advisory yet. Click <b>Run AXIOM</b> to generate.
                        </div>
                      ) : (
                        axiomNotes.map((n) => {
                          const active = (axiomSelected?.id ?? axiomNotes[0]?.id) === n.id;
                          const sev = n.severity ?? inferSeverity(n.title, n.content);
                          return (
                            <button
                              key={n.id}
                              onClick={() => setAxiomSelectedNoteId(n.id)}
                              className={cx(
                                "w-full text-left rounded-2xl border px-3 py-3 transition",
                                active
                                  ? "border-emerald-400/50 bg-emerald-500/10"
                                  : "border-white/10 bg-black/20 hover:bg-white/5"
                              )}
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0 flex-1">
                                  <div className="text-[12px] font-semibold text-slate-100 truncate">
                                    {n.title || "AXIOM Advisory"}
                                  </div>
                                  <div className="mt-1 text-[10px] text-slate-500">
                                    {fmtShort(n.created_at)} {n.model ? `• ${n.model}` : ""}{" "}
                                    {typeof n.tokens_used === "number" ? ` • ${n.tokens_used} tok` : ""}
                                  </div>
                                </div>
                                {sev && (
                                  <span
                                    className={cx(
                                      "shrink-0 rounded-full border px-2 py-1 text-[9px] uppercase tracking-[0.18em]",
                                      severityPill(sev)
                                    )}
                                    title="Inferred severity"
                                  >
                                    {sev}
                                  </span>
                                )}
                              </div>
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>

                  {/* Preview */}
                  <div className="lg:col-span-8 rounded-3xl border border-white/10 bg-black/20 overflow-hidden flex flex-col">
                    <div className="px-5 py-4 border-b border-white/10 flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="text-[11px] uppercase tracking-[0.22em] text-slate-300">Advisory Preview</div>
                        <div className="mt-1 text-[12px] text-slate-500">
                          {axiomSelected?.created_at ? `Latest: ${fmtShort(axiomSelected.created_at)}` : "—"}
                        </div>
                      </div>

                      <div className="shrink-0 flex items-center gap-2">
                        <Link
                          href="/ci-forge"
                          className="rounded-full border border-emerald-500/60 bg-black/40 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-emerald-200 hover:bg-emerald-500/10"
                          title="Execution happens in Forge"
                        >
                          Open Forge
                        </Link>
                        <Link
                          href="/ci-archive/ledger"
                          className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/8"
                          title="Lifecycle registry in Archive"
                        >
                          Registry
                        </Link>
                      </div>
                    </div>

                    <div className="px-6 py-5">
                      <div className="rounded-2xl border border-white/10 bg-black/30 px-5 py-5">
                        <pre className="whitespace-pre-wrap font-sans text-[13px] leading-[1.85] text-slate-100">
                          {axiomSelected?.content?.trim()
                            ? axiomSelected.content
                            : "— (No advisory loaded yet. Click Load or Run AXIOM.) —"}
                        </pre>
                      </div>

                      {axiomLastMemo && (
                        <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-4 text-[12px] text-slate-400">
                          <div className="text-[11px] uppercase tracking-[0.22em] text-slate-300">Latest Memo</div>
                          <div className="mt-2 space-y-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-slate-500">Bucket</span>
                              <span className="font-mono text-slate-200 text-[11px]">
                                {axiomLastMemo.storage_bucket ?? "—"}
                              </span>
                            </div>
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-slate-500">Path</span>
                              <span
                                className="font-mono text-slate-200 text-[11px] truncate max-w-[520px]"
                                title={axiomLastMemo.storage_path ?? ""}
                              >
                                {axiomLastMemo.storage_path ?? "—"}
                              </span>
                            </div>
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-slate-500">Hash</span>
                              <span className="font-mono text-slate-200 text-[11px]">
                                {hashShort(axiomLastMemo.file_hash ?? null)}
                              </span>
                            </div>
                          </div>

                          <div className="mt-3 flex flex-wrap gap-2">
                            <button
                              onClick={async () => {
                                if (!axiomLastMemo?.storage_bucket || !axiomLastMemo?.storage_path) {
                                  flashError("No memo artifact yet. Generate Memo PDF first.");
                                  return;
                                }
                                await ensureSignedUrlForMemo(axiomLastMemo.storage_bucket, axiomLastMemo.storage_path);
                                flashInfo("Signed URL prepared.");
                              }}
                              disabled={axiomBusy !== null}
                              className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/8 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {axiomBusy === "url" ? "Preparing…" : "Prepare Link"}
                            </button>

                            <button
                              onClick={() => {
                                if (!axiomMemoUrl) return flashError("No signed URL yet. Click Prepare Link.");
                                window.open(axiomMemoUrl, "_blank", "noopener,noreferrer");
                              }}
                              disabled={!axiomMemoUrl}
                              className={cx(
                                "rounded-full px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase",
                                axiomMemoUrl
                                  ? "border border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/15"
                                  : "border border-white/10 bg-white/5 text-slate-500 opacity-60 cursor-not-allowed"
                              )}
                            >
                              Open PDF
                            </button>
                          </div>

                          {axiomLastMemo?.warning && (
                            <div className="mt-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 px-3 py-3 text-[12px] text-amber-200">
                              Memo warning: {axiomLastMemo.warning}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="px-5 py-4 border-t border-white/10 text-[10px] text-slate-500 flex items-center justify-between">
                      <span>AXIOM focus is non-mutating. Authority remains in Council.</span>
                      <span>Scoped by entity_id + is_test</span>
                    </div>
                  </div>
                </div>
              </section>
            ) : (
              <div className="grid grid-cols-12 gap-4">
                {/* LEFT: Filters */}
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
                      {(["PENDING", "APPROVED", "REJECTED", "ARCHIVED", "ALL"] as StatusTab[]).map((t) => (
                        <button
                          key={t}
                          onClick={() => setTab(t)}
                          className={cx(
                            "rounded-full border px-3 py-1 text-xs transition",
                            tab === t
                              ? "border-amber-400/40 bg-amber-400/10 text-amber-100"
                              : "border-white/10 bg-white/5 text-slate-200/80 hover:bg-white/7"
                          )}
                        >
                          {t}
                        </button>
                      ))}
                    </div>

                    <div className="mt-4">
                      <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">Search</div>
                      <div className="mt-2 relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                        <input
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                          placeholder="title or body…"
                          className="w-full rounded-2xl border border-white/10 bg-white/5 pl-10 pr-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-500 focus:border-amber-400/30"
                        />
                      </div>
                    </div>

                    <div className="mt-4 text-xs text-slate-400">{loading ? "Loading…" : `${filtered.length} item(s)`}</div>

                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <button
                        onClick={() => setQueueOpen((v) => !v)}
                        className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/8"
                      >
                        {queueOpen ? "Hide Queue" : "Show Queue"}
                      </button>

                      <button
                        onClick={() => reload(true)}
                        className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/8"
                      >
                        Refresh
                      </button>
                    </div>

                    <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 p-3 text-xs text-slate-400">
                      Scope: <span className="text-slate-200 font-mono">governance_ledger</span>
                      <br />
                      Lane-safe: <span className="text-slate-200 font-mono">entity_id + is_test</span>
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <button
                        onClick={() => setReaderOpen(true)}
                        disabled={!selected}
                        className={cx(
                          "rounded-2xl px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase transition",
                          selected
                            ? "border border-emerald-400/50 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/15"
                            : "border border-white/10 bg-white/5 text-slate-500 opacity-60 cursor-not-allowed"
                        )}
                      >
                        Reader
                      </button>

                      <Link
                        href="/ci-forge"
                        className="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-emerald-200 hover:bg-emerald-500/15"
                        title="Execution happens in Forge"
                      >
                        Forge
                      </Link>
                    </div>
                  </div>
                </section>

                {/* MIDDLE: Queue */}
                <section className={cx("col-span-12 rounded-3xl border border-white/10 bg-black/20 p-4", "lg:col-span-6")}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-200">Queue</div>
                      <div className="text-[11px] text-slate-500">Pending + lifecycle items</div>
                    </div>
                    <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[10px] tracking-[0.18em] uppercase text-slate-200">
                      queue
                    </span>
                  </div>

                  <div className="mt-3 space-y-2">
                    {!queueOpen ? (
                      <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-slate-400">Queue hidden.</div>
                    ) : loading ? (
                      <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-slate-400">Loading queue…</div>
                    ) : filtered.length === 0 ? (
                      <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-slate-400">
                        No records match this view.
                      </div>
                    ) : (
                      <div className="max-h-[760px] overflow-y-auto pr-1">
                        {filtered.map((r) => {
                          const st = (r.status ?? "").toUpperCase();
                          const active = r.id === selectedId;
                          return (
                            <button
                              key={r.id}
                              onClick={() => handleSelect(r)}
                              className={cx(
                                "w-full text-left rounded-3xl border p-3 transition",
                                active ? "border-emerald-400/40 bg-emerald-500/10" : "border-white/10 bg-black/20 hover:bg-black/25"
                              )}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="text-sm font-medium text-slate-100 truncate">{r.title || "(untitled)"}</div>
                                  <div className="mt-1 text-xs text-slate-400">
                                    {fmtShort(r.created_at)} · {r.record_type || "resolution"}
                                  </div>
                                  <div className="mt-2 line-clamp-2 text-[12px] leading-relaxed text-slate-400">
                                    {r.body || "—"}
                                  </div>
                                </div>

                                <span
                                  className={cx(
                                    "shrink-0 rounded-full border px-2 py-1 text-[11px]",
                                    st === "APPROVED"
                                      ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100"
                                      : st === "REJECTED"
                                      ? "border-rose-400/30 bg-rose-400/10 text-rose-100"
                                      : st === "ARCHIVED"
                                      ? "border-white/10 bg-white/5 text-slate-300"
                                      : "border-sky-400/30 bg-sky-400/10 text-sky-100"
                                  )}
                                >
                                  {st || "—"}
                                </span>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </section>

                {/* RIGHT: Authority */}
                <section className="col-span-12 lg:col-span-3">
                  <div className="rounded-3xl border border-white/10 bg-black/20 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-200">Authority</div>
                        <div className="text-[11px] text-slate-500">Decisions + AXIOM</div>
                      </div>
                      <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[10px] tracking-[0.18em] uppercase text-slate-200">
                        panel
                      </span>
                    </div>

                    {/* Tabs (AXIOM / ARTIFACTS) */}
                    <div className="mt-3 inline-flex rounded-full bg-white/5 border border-white/10 p-1 overflow-hidden">
                      <DetailTabButton label="AXIOM" active={detailTab === "AXIOM"} onClick={() => setDetailTab("AXIOM")} />
                      <DetailTabButton label="Artifacts" active={detailTab === "ARTIFACTS"} onClick={() => setDetailTab("ARTIFACTS")} />
                    </div>

                    <div className="mt-4 space-y-4">
                      {!selected ? (
                        <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-4 text-[12px] text-slate-500">
                          Select a record to see authority + AXIOM tools.
                        </div>
                      ) : (
                        <>
                          {/* Authority block */}
                          <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-4">
                            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-300">Authority</div>
                            <div className="mt-2 text-[12px] text-slate-400">
                              <span className="text-slate-100 font-semibold">{selected.title || "(untitled)"}</span>
                              <span className="mx-2 text-slate-700">•</span>
                              <span className="text-slate-300">{(selected.status ?? "").toUpperCase()}</span>
                            </div>
                            <div className="mt-2 text-[11px] text-slate-500">
                              {fmtShort(selected.created_at)} · {selected.record_type || "resolution"}
                            </div>

                            <div className="mt-3 text-[12px] text-slate-500 leading-relaxed">
                              Council is the authority. AXIOM is advisory-only and never blocks. Use <b>Send Back</b> to return
                              to Alchemy correction flow (canonical RPC + opens new draft).
                            </div>

                            <div className="mt-4 space-y-2">
                              <button
                                onClick={() => openConfirm("APPROVE")}
                                disabled={!canApprove || !!busy}
                                className="w-full rounded-full bg-emerald-600 px-5 py-3 text-[12px] font-semibold tracking-[0.18em] uppercase text-black hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                {busy === "approve" ? "Approving…" : "Approve"}
                              </button>

                              <button
                                onClick={() => openConfirm("REJECT")}
                                disabled={!canReject || !!busy}
                                className="w-full rounded-full bg-rose-600 px-5 py-3 text-[12px] font-semibold tracking-[0.18em] uppercase text-black hover:bg-rose-500 disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                {busy === "reject" ? "Rejecting…" : "Reject"}
                              </button>

                              <button
                                onClick={() => openConfirm("SENDBACK")}
                                disabled={!canSendBack || !!busy}
                                className="w-full rounded-full bg-amber-500 px-5 py-3 text-[12px] font-semibold tracking-[0.18em] uppercase text-black hover:bg-amber-400 disabled:opacity-50 disabled:cursor-not-allowed"
                                title="Creates new draft + returns ledger to DRAFT via SECURITY DEFINER RPC."
                              >
                                {busy === "sendback" ? "Sending Back…" : "Send Back to Alchemy"}
                              </button>
                            </div>

                            <div className="mt-4 grid grid-cols-2 gap-2">
                              <Link
                                href="/ci-forge"
                                className="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-emerald-200 hover:bg-emerald-500/15"
                              >
                                Forge
                              </Link>
                              <Link
                                href="/ci-archive/ledger"
                                className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/8"
                              >
                                Ledger Registry
                              </Link>
                            </div>
                          </div>

                          {detailTab === "AXIOM" ? (
                            <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-4">
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <div className="text-[11px] uppercase tracking-[0.22em] text-slate-300">AXIOM Advisory</div>
                                  <div className="mt-1 text-[12px] text-slate-500">
                                    Writes to <span className="font-mono text-slate-200">ai_notes</span> (scope_type=document, scope_id=ledger_id).
                                  </div>
                                </div>

                                {axiomSeverityLabel && (
                                  <span
                                    className={cx(
                                      "shrink-0 inline-flex items-center rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.18em]",
                                      severityPill(axiomSeverityLabel)
                                    )}
                                    title="Inferred severity (no metadata dependency)"
                                  >
                                    {axiomSeverityLabel}
                                  </span>
                                )}
                              </div>

                              <div className="mt-4 grid grid-cols-3 gap-2">
                                <button
                                  onClick={() => loadAxiomNotesForSelected()}
                                  disabled={axiomBusy !== null}
                                  className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/8 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                  {axiomBusy === "load" ? "Loading…" : "Load"}
                                </button>

                                <button
                                  onClick={() => runAxiomCouncilReview()}
                                  disabled={axiomBusy !== null}
                                  className="rounded-2xl border border-indigo-400/50 bg-indigo-500/10 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-indigo-200 hover:bg-indigo-500/15 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                  {axiomBusy === "run" ? "Running…" : "Run"}
                                </button>

                                <button
                                  onClick={() => invokeAxiomMemoEdgeFunction()}
                                  disabled={axiomBusy !== null}
                                  className="rounded-2xl border border-amber-400/50 bg-amber-500/10 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-amber-200 hover:bg-amber-500/15 disabled:opacity-50 disabled:cursor-not-allowed"
                                  title="Render memo PDF sidecar (lane-scoped)"
                                >
                                  {axiomBusy === "memo" ? "Generating…" : "Memo PDF"}
                                </button>
                              </div>

                              <div className="mt-4 space-y-2">
                                {axiomNotes.length === 0 ? (
                                  <div className="rounded-2xl border border-white/10 bg-black/25 px-4 py-4 text-[12px] text-slate-500">
                                    No advisory loaded yet. Click <b>Load</b> or <b>Run</b>.
                                  </div>
                                ) : (
                                  <>
                                    <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">Latest Advisory</div>
                                    <button
                                      onClick={() => setAxiomSelectedNoteId(axiomSelected?.id ?? axiomNotes[0]?.id ?? null)}
                                      className="w-full text-left rounded-2xl border border-white/10 bg-black/25 px-4 py-4 hover:bg-white/5 transition"
                                    >
                                      <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                          <div className="text-[12px] font-semibold text-slate-100 truncate">
                                            {axiomSelected?.title ?? "AXIOM Advisory"}
                                          </div>
                                          <div className="mt-1 text-[10px] text-slate-500">
                                            {fmtShort(axiomSelected?.created_at ?? null)}
                                            {axiomSelected?.model ? ` • ${axiomSelected.model}` : ""}
                                            {typeof axiomSelected?.tokens_used === "number" ? ` • ${axiomSelected.tokens_used} tok` : ""}
                                          </div>
                                        </div>

                                        {(axiomSelected?.severity ?? null) && (
                                          <span
                                            className={cx(
                                              "shrink-0 rounded-full border px-2 py-1 text-[9px] uppercase tracking-[0.18em]",
                                              severityPill(axiomSelected?.severity ?? null)
                                            )}
                                          >
                                            {axiomSelected?.severity}
                                          </span>
                                        )}
                                      </div>

                                      <div className="mt-3 line-clamp-4 text-[12px] leading-relaxed text-slate-300 whitespace-pre-wrap">
                                        {axiomSelected?.content?.trim() ? axiomSelected.content.trim() : "—"}
                                      </div>
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>
                          ) : (
                            <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-4">
                              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-300">Artifacts</div>
                              <div className="mt-2 text-[12px] text-slate-500">
                                Lane-scoped sidecars (e.g., AXIOM memo PDF). Council stays non-archiving.
                              </div>

                              <div className="mt-4 rounded-2xl border border-white/10 bg-black/25 px-4 py-4">
                                <div className="text-[11px] uppercase tracking-[0.22em] text-slate-300">AXIOM Memo PDF</div>
                                <div className="mt-2 text-[12px] text-slate-500">
                                  {axiomLastMemo?.storage_bucket && axiomLastMemo?.storage_path ? "Memo exists for this record." : "No memo generated yet."}
                                </div>

                                <div className="mt-3 space-y-2 text-[12px] text-slate-400">
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="text-slate-500">Bucket</span>
                                    <span className="font-mono text-slate-200 text-[11px]">{axiomLastMemo?.storage_bucket ?? "—"}</span>
                                  </div>
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="text-slate-500">Path</span>
                                    <span className="font-mono text-slate-200 text-[11px] truncate max-w-[220px]" title={axiomLastMemo?.storage_path ?? ""}>
                                      {axiomLastMemo?.storage_path ?? "—"}
                                    </span>
                                  </div>
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="text-slate-500">Hash</span>
                                    <span className="font-mono text-slate-200 text-[11px]">{hashShort(axiomLastMemo?.file_hash ?? null)}</span>
                                  </div>
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="text-slate-500">Size</span>
                                    <span className="font-mono text-slate-200 text-[11px]">{bytesPretty(axiomLastMemo?.file_size ?? null)}</span>
                                  </div>
                                </div>

                                <div className="mt-3 flex flex-wrap gap-2">
                                  <button
                                    onClick={() => invokeAxiomMemoEdgeFunction()}
                                    disabled={!selected || axiomBusy !== null}
                                    className="rounded-full border border-amber-400/50 bg-amber-500/10 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-amber-200 hover:bg-amber-500/15 disabled:opacity-50 disabled:cursor-not-allowed"
                                  >
                                    {axiomBusy === "memo" ? "Generating…" : "Generate Memo"}
                                  </button>

                                  <button
                                    onClick={async () => {
                                      if (!axiomLastMemo?.storage_bucket || !axiomLastMemo?.storage_path) {
                                        flashError("No memo artifact yet. Generate Memo first.");
                                        return;
                                      }
                                      await ensureSignedUrlForMemo(axiomLastMemo.storage_bucket, axiomLastMemo.storage_path);
                                      flashInfo("Signed URL prepared.");
                                    }}
                                    disabled={axiomBusy !== null}
                                    className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/8 disabled:opacity-50 disabled:cursor-not-allowed"
                                  >
                                    {axiomBusy === "url" ? "Preparing…" : "Prepare Link"}
                                  </button>

                                  <button
                                    onClick={() => {
                                      if (!axiomMemoUrl) return flashError("No signed URL yet. Click Prepare Link.");
                                      window.open(axiomMemoUrl, "_blank", "noopener,noreferrer");
                                    }}
                                    disabled={!axiomMemoUrl}
                                    className={cx(
                                      "rounded-full px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase",
                                      axiomMemoUrl
                                        ? "border border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/15"
                                        : "border border-white/10 bg-white/5 text-slate-500 opacity-60 cursor-not-allowed"
                                    )}
                                  >
                                    Open PDF
                                  </button>
                                </div>

                                <div className="mt-3 text-[11px] text-slate-500">
                                  Tip: Use <span className="font-semibold text-slate-300">Focus AXIOM</span> in the header for full workspace.
                                </div>
                              </div>

                              <div className="mt-4 rounded-2xl border border-white/10 bg-black/25 px-4 py-4 text-[12px] text-slate-500">
                                Council does not seal/archive. For lifecycle registry + evidence, use{" "}
                                <Link href="/ci-archive/ledger" className="text-emerald-200 hover:underline">
                                  Ledger Registry
                                </Link>{" "}
                                and for execution use{" "}
                                <Link href="/ci-forge" className="text-emerald-200 hover:underline">
                                  Forge
                                </Link>
                                .
                              </div>
                            </div>
                          )}

                          <div className="pt-3">
                            <div className="rounded-2xl border border-white/10 bg-black/20 p-3 text-[10px] text-slate-500">
                              <div className="flex items-center justify-between gap-2">
                                <span>CI-Council · Authority gate</span>
                                <span className="font-mono">entity_id + is_test</span>
                              </div>
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </section>
              </div>
            )}

            {/* Toast */}
            {showToast && (
              <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[120] w-[min(720px,92vw)]">
                <div
                  className={cx(
                    "rounded-2xl border px-4 py-3 shadow-[0_24px_90px_rgba(0,0,0,0.55)] backdrop-blur",
                    error ? "border-rose-500/40 bg-rose-500/10" : "border-emerald-500/30 bg-emerald-500/10"
                  )}
                >
                  <div className={cx("text-[12px] font-semibold", error ? "text-rose-200" : "text-emerald-200")}>
                    {error ? "Notice" : "OK"}
                  </div>
                  <div className="mt-1 text-[12px] text-slate-200">{error ?? info}</div>
                </div>
              </div>
            )}

            {/* Confirm Modal */}
            <ConfirmModal
              state={confirm}
              busy={!!busy}
              onCancel={() => setConfirm({ open: false })}
              onConfirm={async () => {
                setConfirm({ open: false });
                await confirmAction();
              }}
            />

            {/* Reader Modal (simple, safe, no new wiring) */}
            {readerOpen && selected && (
              <div className="fixed inset-0 z-[110] bg-black/70 px-4 sm:px-6 py-6 flex items-center justify-center">
                <div className="w-full max-w-[980px] rounded-3xl border border-white/12 bg-[#070A12]/90 shadow-[0_40px_160px_rgba(0,0,0,0.70)] overflow-hidden">
                  <div className="px-6 py-5 border-b border-white/10 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[11px] uppercase tracking-[0.22em] text-slate-400">Reader</div>
                      <div className="mt-2 text-[15px] font-semibold text-slate-100 truncate">
                        {selected.title || "(untitled)"}
                      </div>
                      <div className="mt-1 text-[12px] text-slate-400">
                        {fmtShort(selected.created_at)} • {(selected.status ?? "").toUpperCase()} •{" "}
                        {selected.record_type || "resolution"}
                      </div>
                    </div>
                    <button
                      onClick={() => setReaderOpen(false)}
                      className="rounded-full border border-white/12 bg-white/5 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/8"
                    >
                      Close
                    </button>
                  </div>

                  <div className="px-6 py-5 max-h-[72vh] overflow-y-auto">
                    <div className="rounded-2xl border border-white/10 bg-black/30 px-5 py-5">
                      <pre className="whitespace-pre-wrap font-sans text-[13px] leading-[1.85] text-slate-100">
                        {selected.body?.trim() ? selected.body : "—"}
                      </pre>
                    </div>

                    {detailTab === "AXIOM" && axiomSelected?.content?.trim() && (
                      <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 px-5 py-5">
                        <div className="text-[11px] uppercase tracking-[0.22em] text-slate-300">AXIOM Sidecar</div>
                        <div className="mt-3 rounded-2xl border border-white/10 bg-black/30 px-4 py-4">
                          <pre className="whitespace-pre-wrap font-sans text-[12px] leading-[1.85] text-slate-200">
                            {axiomSelected.content}
                          </pre>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="px-6 py-4 border-t border-white/10 text-[10px] text-slate-500 flex items-center justify-between">
                    <span>Non-mutating viewer • Council stays authority-only</span>
                    <span>Lane: {env}</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Small tab button (kept inline for single-file paste) */
function DetailTabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "rounded-full px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase transition",
        active ? "bg-amber-400/15 text-amber-100" : "text-slate-300 hover:bg-white/5"
      )}
    >
      {label}
    </button>
  );
}
