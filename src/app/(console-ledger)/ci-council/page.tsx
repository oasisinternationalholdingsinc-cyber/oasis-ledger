// src/app/(os)/ci-council/page.tsx
"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";

type CouncilStatus = "PENDING" | "APPROVED" | "REJECTED" | "ARCHIVED";
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

const ENTITY_LABELS: Record<string, string> = {
  holdings: "Oasis International Holdings Inc.",
  lounge: "Oasis International Lounge Inc.",
  "real-estate": "Oasis International Real Estate Inc.",
};

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

export default function CICouncilPage() {
  const entityCtx = useEntity() as any;
  const envCtx = useOsEnv() as any;

  // ✅ De-hardwired entity resolution (defensive, OS-consistent)
  const activeEntitySlug: string =
    (entityCtx?.entityKey as string) ||
    (entityCtx?.activeEntity as string) ||
    (entityCtx?.entity_slug as string) ||
    (entityCtx?.activeEntityKey as string) ||
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
      envCtx?.isSandbox
  );
  const env: "SANDBOX" | "ROT" = isSandbox ? "SANDBOX" : "ROT";

  const activeEntityLabel = useMemo(() => {
    if (!activeEntitySlug) return "—";
    return ENTITY_LABELS[activeEntitySlug] ?? activeEntitySlug;
  }, [activeEntitySlug]);

  const [entityId, setEntityId] = useState<string | null>(activeEntityIdFromCtx);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | "approve" | "reject" | "archive" | "sendback">(null);

  const [tab, setTab] = useState<StatusTab>("PENDING");
  const [detailTab, setDetailTab] = useState<DetailTab>("AXIOM");
  const [query, setQuery] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(true);

  const [records, setRecords] = useState<LedgerRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [readerOpen, setReaderOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

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
      const inTab =
        tabKey === "ALL" ? rows : rows.filter((r) => (r.status ?? "").toUpperCase() === tabKey);

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
    const { error: upErr } = await supabase
      .from("governance_ledger")
      .update({ status: next })
      .eq("id", recordId);

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

  async function handleArchiveDiscipline() {
    flashError(
      "Council does not directly archive by default. Use Forge (signature path) or wire Council to the deterministic seal/archive function for direct-archive mode."
    );
  }

  // ✅ Send Back is “best effort”:
  // - try existing RPC names + common parameter shapes
  // - if any real error occurs, we still fall back to opening Alchemy so you’re never blocked
  async function sendBackToAlchemy() {
    if (!selected?.id) return flashError("Select a record first.");
    setBusy("sendback");
    setError(null);
    setInfo(null);

    const openFallback = () => {
      window.open(`/ci-alchemy?from_ledger=${encodeURIComponent(selected.id)}`, "_blank", "noopener,noreferrer");
    };

    try {
      const candidates = [
        "council_send_back_to_alchemy",
        "council_send_back",
        "council_return_to_alchemy",
        "council_sendback",
      ];

      const paramShapes: Array<Record<string, any>> = [
        { p_record_id: selected.id },
        { record_id: selected.id },
        { p_record_id: selected.id, p_reason: "Council send-back" },
        { p_record_id: selected.id, p_note: "Council send-back" },
        { p_record_id: selected.id, p_message: "Council send-back" },
      ];

      let didRpc = false;
      let lastErr: any = null;

      for (const fn of candidates) {
        for (const params of paramShapes) {
          try {
            const { data, error } = await supabase.rpc(fn as any, params as any);
            if (!error) {
              const ok = (data as any)?.ok;
              if (ok === false) throw new Error((data as any)?.error ?? "Send-back RPC failed.");
              didRpc = true;
              break;
            }
            const msg = (error?.message ?? "").toLowerCase();
            if (msg.includes("function") && msg.includes("does not exist")) {
              // try next function name
              break;
            }
            // other errors: keep and continue trying shapes
            lastErr = error;
          } catch (e: any) {
            lastErr = e;
            if (isTruthImmutableErr(e)) throw e;
          }
        }
        if (didRpc) break;
      }

      if (didRpc) {
        flashInfo("Sent back to Alchemy.");
        await reload(true);
        return;
      }

      // If no RPC found/usable, fallback open
      if (lastErr) {
        flashError(`Send-back RPC failed; opening Alchemy fallback. (${String(lastErr?.message ?? lastErr)})`);
        openFallback();
        return;
      }

      openFallback();
      flashInfo("Opened Alchemy (manual send-back).");
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
      const { data: urlData, error: urlErr } = await supabase.storage
        .from(bucket)
        .createSignedUrl(path, 60 * 15);
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
    (axiomLastMemo?.severity as string | undefined) ??
    (axiomSelected?.severity as string | undefined) ??
    null;

  // UI polish: close queue automatically in AXIOM focus (pure UI)
  useEffect(() => {
    if (axiomFocus) setDrawerOpen(false);
  }, [axiomFocus]);

  return (
    <div className="h-full flex flex-col px-4 sm:px-8 pt-6 pb-6">
      {/* Header under OS bar */}
      <div className="mb-4 shrink-0">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">CI • Council</div>
        <div className="mt-1 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-slate-50">Council Review · Authority Console</h1>
            <p className="mt-1 text-xs text-slate-400 max-w-3xl">
              Council is the authority gate.{" "}
              <span className="text-emerald-300 font-semibold">Approve</span> or{" "}
              <span className="text-rose-300 font-semibold">Reject</span>. Execution/archival discipline occurs in Forge
              (signature) or in a direct-archive pipeline (if explicitly wired).
            </p>
            <div className="mt-2 text-xs text-slate-400">
              Entity: <span className="text-emerald-300 font-medium">{activeEntityLabel}</span>
              <span className="mx-2 text-slate-700">•</span>
              Lane:{" "}
              <span className={cx("font-semibold", isSandbox ? "text-amber-300" : "text-sky-300")}>{env}</span>
            </div>
          </div>

          {/* “Flip to AXIOM” (UI only) */}
          <button
            onClick={() => {
              setAxiomFocus((v) => !v);
              setDetailTab("AXIOM");
            }}
            disabled={!selected}
            className={cx(
              "shrink-0 rounded-full px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition",
              !selected
                ? "border border-slate-800 bg-slate-950/40 text-slate-500 cursor-not-allowed"
                : axiomFocus
                ? "border border-amber-400/60 bg-amber-500/10 text-amber-200 hover:bg-amber-500/15"
                : "border border-indigo-400/50 bg-indigo-500/10 text-indigo-200 hover:bg-indigo-500/15"
            )}
            title="Focus mode: flip the console to AXIOM so advisory has real space."
          >
            {axiomFocus ? "Back to Council" : "Focus AXIOM"}
          </button>
        </div>

        {showNoEntityWarning && (
          <div className="mt-3 rounded-2xl border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-[12px] text-amber-200">
            OS Context: missing entity selection. Council will activate once an entity is selected in the OS control plane.
          </div>
        )}
      </div>

      {/* Main OS window frame */}
      <div className="flex-1 min-h-0 flex justify-center overflow-hidden">
        <div className="w-full max-w-[1500px] h-full rounded-3xl border border-slate-900 bg-black/60 shadow-[0_0_60px_rgba(15,23,42,0.9)] px-4 sm:px-6 py-5 flex flex-col overflow-hidden">
          {/* Top strip */}
          <div className="shrink-0 mb-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="inline-flex rounded-full bg-slate-950/70 border border-slate-800 p-1 overflow-x-auto">
              <StatusTabButton label="Pending" value="PENDING" active={tab === "PENDING"} onClick={() => setTab("PENDING")} />
              <StatusTabButton label="Approved" value="APPROVED" active={tab === "APPROVED"} onClick={() => setTab("APPROVED")} />
              <StatusTabButton label="Rejected" value="REJECTED" active={tab === "REJECTED"} onClick={() => setTab("REJECTED")} />
              <StatusTabButton label="Archived" value="ARCHIVED" active={tab === "ARCHIVED"} onClick={() => setTab("ARCHIVED")} />
              <StatusTabButton label="All" value="ALL" active={tab === "ALL"} onClick={() => setTab("ALL")} />
            </div>

            <div className="flex items-center gap-2">
              {!axiomFocus && (
                <button
                  onClick={() => setDrawerOpen((v) => !v)}
                  className="rounded-full border border-slate-800 bg-slate-950/60 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60"
                >
                  {drawerOpen ? "Hide Queue" : "Show Queue"}
                </button>
              )}

              {!axiomFocus && (
                <button
                  onClick={() => setReaderOpen(true)}
                  disabled={!selected}
                  className="rounded-full border border-emerald-400/60 bg-emerald-500/10 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-emerald-200 hover:bg-emerald-500/15 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Open Reader
                </button>
              )}

              <button
                onClick={() => reload(true)}
                className="rounded-full border border-slate-800 bg-slate-950/60 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60"
              >
                Refresh
              </button>
            </div>
          </div>

          {/* Workspace (mobile stacks; desktop columns) */}
          <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-4 overflow-hidden">
            {/* Left queue drawer */}
            {!axiomFocus && drawerOpen && (
              <aside className="w-full lg:w-[360px] shrink-0 min-h-0 rounded-2xl border border-slate-800 bg-slate-950/40 flex flex-col overflow-hidden">
                <div className="shrink-0 p-4 border-b border-slate-800">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                      Queue · {filtered.length}/{envFiltered.length} <span className="mx-2 text-slate-700">•</span>
                      <span className={cx("font-semibold", isSandbox ? "text-amber-300" : "text-sky-300")}>{env}</span>
                    </div>
                  </div>

                  <input
                    className="mt-3 w-full rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-[13px] text-slate-100 outline-none focus:border-emerald-400"
                    placeholder="Search… title or body"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto">
                  {loading ? (
                    <div className="p-4 text-[13px] text-slate-400">Loading…</div>
                  ) : filtered.length === 0 ? (
                    <div className="p-4 text-[13px] text-slate-500">No records for this filter.</div>
                  ) : (
                    <ul className="divide-y divide-slate-800">
                      {filtered.map((r) => {
                        const st = (r.status ?? "").toUpperCase();
                        return (
                          <li
                            key={r.id}
                            onClick={() => handleSelect(r)}
                            className={cx(
                              "cursor-pointer px-4 py-3 transition hover:bg-slate-800/60",
                              r.id === selectedId && "bg-slate-800/80"
                            )}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-[13px] font-semibold text-slate-100">{r.title || "(untitled)"}</div>
                                <div className="mt-1 text-[11px] text-slate-500">
                                  {fmtShort(r.created_at)} · {r.record_type || "resolution"}
                                </div>
                                <div className="mt-2 line-clamp-2 text-[12px] leading-relaxed text-slate-400">{r.body || "—"}</div>
                              </div>

                              <span
                                className={cx(
                                  "shrink-0 rounded-full px-2 py-1 text-[9px] uppercase tracking-[0.18em]",
                                  st === "APPROVED"
                                    ? "bg-emerald-500/15 text-emerald-200"
                                    : st === "REJECTED"
                                    ? "bg-rose-500/15 text-rose-200"
                                    : st === "ARCHIVED"
                                    ? "bg-slate-700/40 text-slate-300"
                                    : "bg-sky-500/15 text-sky-200"
                                )}
                              >
                                {st || "—"}
                              </span>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </aside>
            )}

            {/* Center review surface */}
            {!axiomFocus && (
              <section className="flex-1 min-w-0 min-h-0 rounded-2xl border border-slate-800 bg-slate-950/40 flex flex-col overflow-hidden">
                <div className="shrink-0 px-5 py-4 border-b border-slate-800 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">Review</div>
                    <div className="mt-1 text-[13px] text-slate-400">
                      Entity: <span className="text-emerald-300 font-semibold">{activeEntityLabel}</span>
                      <span className="mx-2 text-slate-700">•</span>
                      Lane: <span className={cx("font-semibold", isSandbox ? "text-amber-300" : "text-sky-300")}>{env}</span>
                      {selected && (
                        <>
                          <span className="mx-2 text-slate-700">•</span>
                          <span className="text-slate-200">{(selected.status ?? "").toUpperCase()}</span>
                        </>
                      )}
                    </div>
                  </div>

                  {selected && (
                    <div className="shrink-0 flex flex-wrap items-center gap-2">
                      <button
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(selected.id);
                            flashInfo("Copied record id.");
                          } catch {
                            flashError("Copy failed.");
                          }
                        }}
                        className="rounded-full border border-slate-800 bg-slate-950/60 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60"
                      >
                        Copy ID
                      </button>

                      <Link
                        href="/ci-forge"
                        className="rounded-full border border-emerald-500/60 bg-black/40 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-emerald-200 hover:bg-emerald-500/10"
                        title="Signature execution happens in Forge"
                      >
                        Open Forge
                      </Link>

                      <Link
                        href="/ci-archive/ledger"
                        className="rounded-full border border-slate-700 bg-slate-950/40 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60"
                        title="Lifecycle registry in Archive"
                      >
                        Open Ledger Registry
                      </Link>
                    </div>
                  )}
                </div>

                <div className="flex-1 min-h-0 overflow-hidden p-5">
                  {!selected ? (
                    <div className="h-full w-full rounded-2xl border border-slate-800 bg-black/20 flex items-center justify-center text-slate-500">
                      Select a record for review.
                    </div>
                  ) : (
                    <div className="h-full w-full rounded-2xl border border-slate-800 bg-black/30 overflow-hidden flex flex-col">
                      <div className="shrink-0 px-5 py-4 border-b border-slate-800">
                        <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Record</div>
                        <div className="mt-1 text-[15px] font-semibold text-slate-100 truncate">{selected.title || "(untitled)"}</div>
                        <div className="mt-1 text-[11px] text-slate-500">
                          {fmtShort(selected.created_at)} · {selected.record_type || "resolution"} ·{" "}
                          {(selected.status ?? "").toUpperCase()}
                        </div>
                      </div>

                      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
                        <div className="rounded-2xl border border-slate-800 bg-black/35 px-5 py-5">
                          <pre className="whitespace-pre-wrap font-sans text-[13px] leading-[1.8] text-slate-100">
                            {selected.body || "—"}
                          </pre>
                        </div>
                      </div>

                      <div className="shrink-0 px-5 py-4 border-t border-slate-800 text-[10px] text-slate-500 flex items-center justify-between">
                        <span>Review is non-mutating. Authority actions happen in Council.</span>
                        <span>Oasis OS · Council Authority Gate</span>
                      </div>
                    </div>
                  )}

                  {(error || info) && (
                    <div className="mt-4 text-[13px]">
                      {error && (
                        <div className="rounded-2xl border border-red-500/60 bg-red-500/10 px-4 py-3 text-red-200">
                          {error}
                        </div>
                      )}
                      {info && !error && (
                        <div className="rounded-2xl border border-emerald-500/60 bg-emerald-500/10 px-4 py-3 text-emerald-200">
                          {info}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </section>
            )}

            {/* Right detail panel OR AXIOM Focus Surface */}
            {axiomFocus ? (
              <section className="flex-1 min-w-0 min-h-0 rounded-2xl border border-slate-800 bg-slate-950/40 overflow-hidden flex flex-col">
                {/* Focus header */}
                <div className="shrink-0 px-6 py-5 border-b border-slate-800 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
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
                      AXIOM is advisory-only. Memo PDF is a lane-scoped sidecar attachment and never mutates the resolution.
                    </div>
                  </div>

                  <div className="shrink-0 flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => loadAxiomNotesForSelected()}
                      disabled={!selected || axiomBusy !== null}
                      className="rounded-full border border-slate-700 bg-slate-950/40 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60 disabled:opacity-50 disabled:cursor-not-allowed"
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

                {/* Focus body */}
                <div className="flex-1 min-h-0 overflow-hidden p-5">
                  {!selected ? (
                    <div className="h-full w-full rounded-2xl border border-slate-800 bg-black/20 flex items-center justify-center text-slate-500">
                      Select a record first.
                    </div>
                  ) : (
                    <div className="h-full w-full grid grid-cols-12 gap-4 overflow-hidden">
                      {/* History rail */}
                      <div className="col-span-12 lg:col-span-4 min-h-0 rounded-2xl border border-slate-800 bg-black/25 overflow-hidden flex flex-col">
                        <div className="shrink-0 px-4 py-4 border-b border-slate-800">
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-300">Advisory History</div>
                            <button
                              onClick={() => loadAxiomNotesForSelected()}
                              disabled={axiomBusy !== null}
                              className="rounded-full border border-slate-700 bg-slate-950/40 px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {axiomBusy === "load" ? "…" : "Reload"}
                            </button>
                          </div>
                          <div className="mt-2 text-[11px] text-slate-500">
                            Showing {axiomNotes.length} note(s) · scope: <span className="font-mono">ai_notes</span>
                          </div>
                        </div>

                        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
                          {axiomNotes.length === 0 ? (
                            <div className="rounded-2xl border border-slate-800 bg-black/20 px-4 py-4 text-[12px] text-slate-500">
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
                                      : "border-slate-800 bg-black/20 hover:bg-slate-900/40"
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

                        <div className="shrink-0 px-4 py-4 border-t border-slate-800">
                          <div className="grid grid-cols-2 gap-2">
                            <button
                              onClick={async () => {
                                if (!selected?.id) return;
                                try {
                                  await navigator.clipboard.writeText(selected.id);
                                  flashInfo("Copied record id.");
                                } catch {
                                  flashError("Copy failed.");
                                }
                              }}
                              className="rounded-2xl border border-slate-700 bg-slate-950/40 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60"
                            >
                              Copy ID
                            </button>
                            <button
                              onClick={() => {
                                resetAxiomState();
                                flashInfo("Cleared local advisory state.");
                              }}
                              className="rounded-2xl border border-slate-700 bg-slate-950/40 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60"
                            >
                              Clear
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* Big preview */}
                      <div className="col-span-12 lg:col-span-8 min-h-0 rounded-2xl border border-slate-800 bg-black/25 overflow-hidden flex flex-col">
                        <div className="shrink-0 px-5 py-4 border-b border-slate-800 flex items-start justify-between gap-4">
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
                              className="rounded-full border border-slate-700 bg-slate-950/40 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60"
                              title="Lifecycle registry in Archive"
                            >
                              Registry
                            </Link>
                          </div>
                        </div>

                        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
                          <div className="rounded-2xl border border-slate-800 bg-black/30 px-5 py-5">
                            <pre className="whitespace-pre-wrap font-sans text-[13px] leading-[1.85] text-slate-100">
                              {axiomSelected?.content?.trim()
                                ? axiomSelected.content
                                : "— (No advisory loaded yet. Click Load or Run AXIOM.) —"}
                            </pre>
                          </div>
                        </div>

                        <div className="shrink-0 px-5 py-4 border-t border-slate-800 text-[10px] text-slate-500 flex items-center justify-between">
                          <span>AXIOM focus is non-mutating. Authority remains in Council.</span>
                          <span>Scoped by entity_id + is_test</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </section>
            ) : (
              <aside className="w-full lg:w-[410px] shrink-0 min-h-0 rounded-2xl border border-slate-800 bg-slate-950/40 flex flex-col overflow-hidden">
                {/* Panel header */}
                <div className="shrink-0 px-5 py-4 border-b border-slate-800">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">Authority Panel</div>
                      <div className="mt-1 text-[12px] text-slate-500">
                        Authority · AXIOM · Artifacts <span className="mx-2 text-slate-700">•</span>
                        <span className={cx("font-semibold", isSandbox ? "text-amber-300" : "text-sky-300")}>{env}</span>
                      </div>
                    </div>

                    {axiomSeverityLabel && (
                      <span
                        className={cx(
                          "rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.18em]",
                          severityPill(axiomSeverityLabel)
                        )}
                        title="Inferred severity (no metadata dependency)"
                      >
                        {axiomSeverityLabel}
                      </span>
                    )}
                  </div>

                  {/* ✅ Tabs: AXIOM + ARTIFACTS only */}
                  <div className="mt-3 inline-flex rounded-full bg-slate-950/70 border border-slate-800 p-1 overflow-hidden">
                    <DetailTabButton label="AXIOM" active={detailTab === "AXIOM"} onClick={() => setDetailTab("AXIOM")} />
                    <DetailTabButton
                      label="Artifacts"
                      active={detailTab === "ARTIFACTS"}
                      onClick={() => setDetailTab("ARTIFACTS")}
                    />
                  </div>

                  <div className="mt-3 text-[10px] text-slate-600">
                    Tip: Use <span className="text-indigo-200 font-semibold">Focus AXIOM</span> for full-width advisory.
                  </div>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto px-5 py-5 space-y-4">
                  {!selected ? (
                    <div className="rounded-2xl border border-slate-800 bg-black/25 px-4 py-4 text-[12px] text-slate-500">
                      Select a record to see authority + AXIOM tools.
                    </div>
                  ) : (
                    <>
                      {/* ✅ Authority block (phone-safe: big taps, no hover dependence) */}
                      <div className="rounded-2xl border border-slate-800 bg-black/30 px-4 py-4">
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
                          to Alchemy correction flow (best effort RPC; always falls back to opening Alchemy).
                        </div>

                        <div className="mt-4 space-y-2">
                          <button
                            onClick={() => updateStatus("APPROVED")}
                            disabled={!canApprove || !!busy}
                            className="w-full rounded-full bg-emerald-600 px-5 py-3 text-[12px] font-semibold tracking-[0.18em] uppercase text-black hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {busy === "approve" ? "Approving…" : "Approve"}
                          </button>

                          <button
                            onClick={() => updateStatus("REJECTED")}
                            disabled={!canReject || !!busy}
                            className="w-full rounded-full bg-rose-600 px-5 py-3 text-[12px] font-semibold tracking-[0.18em] uppercase text-black hover:bg-rose-500 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {busy === "reject" ? "Rejecting…" : "Reject"}
                          </button>

                          <button
                            onClick={() => sendBackToAlchemy()}
                            disabled={!canSendBack || !!busy}
                            className="w-full rounded-full bg-amber-500 px-5 py-3 text-[12px] font-semibold tracking-[0.18em] uppercase text-black hover:bg-amber-400 disabled:opacity-50 disabled:cursor-not-allowed"
                            title="Returns to Alchemy correction flow (RPC if present; otherwise opens Alchemy with record_id)."
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
                            className="rounded-2xl border border-slate-700 bg-slate-950/40 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60"
                          >
                            Ledger Registry
                          </Link>
                        </div>
                      </div>

                      {detailTab === "AXIOM" ? (
                        <>
                          {/* AXIOM controls */}
                          <div className="rounded-2xl border border-slate-800 bg-black/25 px-4 py-4">
                            <div className="flex items-center justify-between gap-2">
                              <div className="text-[11px] uppercase tracking-[0.22em] text-indigo-200">AXIOM Advisory</div>
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={() => loadAxiomNotesForSelected()}
                                  disabled={axiomBusy !== null}
                                  className="rounded-full border border-slate-700 bg-slate-950/40 px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                  {axiomBusy === "load" ? "Loading…" : "Load"}
                                </button>
                                <button
                                  onClick={() => runAxiomCouncilReview()}
                                  disabled={axiomBusy !== null}
                                  className="rounded-full border border-indigo-400/50 bg-indigo-500/10 px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-indigo-200 hover:bg-indigo-500/15 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                  {axiomBusy === "run" ? "Running…" : "Run"}
                                </button>
                              </div>
                            </div>

                            <div className="mt-2 text-[11px] text-slate-500">
                              Scope: <span className="font-mono">ai_notes</span> ·{" "}
                              <span className="font-mono">scope_type=document</span>
                            </div>

                            <div className="mt-3 grid grid-cols-2 gap-2">
                              <button
                                onClick={() => setAxiomFocus(true)}
                                className="rounded-2xl border border-indigo-400/50 bg-indigo-500/10 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-indigo-200 hover:bg-indigo-500/15"
                              >
                                Focus AXIOM
                              </button>
                              <button
                                onClick={async () => {
                                  try {
                                    await navigator.clipboard.writeText(selected.id);
                                    flashInfo("Copied record id.");
                                  } catch {
                                    flashError("Copy failed.");
                                  }
                                }}
                                className="rounded-2xl border border-slate-700 bg-slate-950/40 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60"
                              >
                                Copy ID
                              </button>
                            </div>
                          </div>

                          {/* AXIOM notes list + preview (compact) */}
                          <div className="rounded-2xl border border-slate-800 bg-black/25 overflow-hidden">
                            <div className="px-4 py-4 border-b border-slate-800">
                              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-300">Advisory History</div>
                              <div className="mt-1 text-[11px] text-slate-500">Showing {axiomNotes.length} note(s)</div>
                            </div>

                            <div className="max-h-[220px] overflow-y-auto divide-y divide-slate-800">
                              {axiomNotes.length === 0 ? (
                                <div className="p-4 text-[12px] text-slate-500">
                                  No advisory yet. Click <b>Run</b> to generate.
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
                                        "w-full text-left px-4 py-3 transition",
                                        active ? "bg-emerald-500/10" : "hover:bg-slate-900/40"
                                      )}
                                    >
                                      <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0 flex-1">
                                          <div className="truncate text-[12px] font-semibold text-slate-100">
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

                            <div className="px-4 py-4 border-t border-slate-800">
                              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-300">Preview</div>
                              <pre className="mt-2 whitespace-pre-wrap font-sans text-[12px] leading-[1.7] text-slate-200 max-h-[200px] overflow-y-auto rounded-2xl border border-slate-800 bg-black/30 px-4 py-4">
                                {axiomSelected?.content?.trim()
                                  ? axiomSelected.content
                                  : "— (No advisory loaded yet.) —"}
                              </pre>
                            </div>
                          </div>
                        </>
                      ) : (
                        <>
                          {/* ARTIFACTS */}
                          <div className="rounded-2xl border border-slate-800 bg-black/25 px-4 py-4">
                            <div className="flex items-center justify-between gap-2">
                              <div className="text-[11px] uppercase tracking-[0.22em] text-amber-200">Artifacts</div>
                              <button
                                onClick={() => invokeAxiomMemoEdgeFunction()}
                                disabled={axiomBusy !== null}
                                className="rounded-full border border-amber-400/50 bg-amber-500/10 px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-amber-200 hover:bg-amber-500/15 disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                {axiomBusy === "memo" ? "Generating…" : "Generate Memo PDF"}
                              </button>
                            </div>

                            <div className="mt-2 text-[12px] text-slate-500">
                              Memo PDF is a <b>sidecar evidence</b> artifact (lane-scoped). It does not change the resolution.
                            </div>
                          </div>

                          <div className="rounded-2xl border border-slate-800 bg-black/30 px-4 py-4">
                            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-300">AXIOM Memo (Latest)</div>

                            <div className="mt-3 space-y-2 text-[12px] text-slate-400">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-slate-500">Status</span>
                                <span className="text-slate-200 font-semibold">{axiomLastMemo ? "AVAILABLE" : "—"}</span>
                              </div>
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-slate-500">Bucket</span>
                                <span className="text-slate-200 font-mono text-[11px]">
                                  {axiomLastMemo?.storage_bucket ?? "—"}
                                </span>
                              </div>
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-slate-500">Path</span>
                                <span
                                  className="text-slate-200 font-mono text-[11px] truncate max-w-[220px]"
                                  title={axiomLastMemo?.storage_path ?? ""}
                                >
                                  {axiomLastMemo?.storage_path ?? "—"}
                                </span>
                              </div>
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-slate-500">Hash</span>
                                <span className="text-slate-200 font-mono text-[11px]">
                                  {hashShort(axiomLastMemo?.file_hash ?? null)}
                                </span>
                              </div>
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-slate-500">Size</span>
                                <span className="text-slate-200">{bytesPretty(axiomLastMemo?.file_size ?? null)}</span>
                              </div>
                            </div>

                            <div className="mt-4 grid grid-cols-2 gap-2">
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
                                className="rounded-2xl border border-slate-700 bg-slate-950/40 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60 disabled:opacity-50 disabled:cursor-not-allowed"
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
                                  "rounded-2xl px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase",
                                  axiomMemoUrl
                                    ? "border border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/15"
                                    : "border border-slate-700 bg-slate-950/40 text-slate-500 opacity-60 cursor-not-allowed"
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

                          {/* Execution & archive discipline (kept) */}
                          <div className="rounded-2xl border border-slate-800 bg-black/25 px-4 py-4">
                            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-300">Execution & Archive</div>
                            <div className="mt-2 text-[12px] text-slate-500 leading-relaxed">
                              Signature path executes in Forge. Direct-archive requires deterministic seal (PDF→hash→verify).
                            </div>

                            <div className="mt-3 grid grid-cols-2 gap-2">
                              <Link
                                href="/ci-forge"
                                className="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-emerald-200 hover:bg-emerald-500/15"
                              >
                                Forge
                              </Link>
                              <button
                                onClick={handleArchiveDiscipline}
                                disabled
                                className="rounded-2xl border border-slate-700 bg-slate-950/40 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-400 opacity-60 cursor-not-allowed"
                                title="Direct archive must be wired to the deterministic seal/archive function"
                              >
                                Archive
                              </button>
                            </div>
                          </div>
                        </>
                      )}
                    </>
                  )}
                </div>

                <div className="shrink-0 px-5 py-3 border-t border-slate-800 text-[10px] text-slate-500 flex items-center justify-between">
                  <span>CI-Council · Authority gate (governance_ledger)</span>
                  <span>Scoped by entity_id + is_test</span>
                </div>
              </aside>
            )}
          </div>
        </div>
      </div>

      {/* Reader Modal (kept; no wiring changes) */}
      {readerOpen && (
        <div className="fixed inset-0 z-[90] bg-black/70 px-4 sm:px-6 py-6 flex items-center justify-center">
          <div className="w-full max-w-[980px] h-[85vh] rounded-3xl border border-slate-800 bg-slate-950/95 shadow-2xl shadow-black/70 overflow-hidden flex flex-col">
            <div className="shrink-0 px-5 py-4 border-b border-slate-800 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-[0.22em] text-slate-400">Reader</div>
                <div className="mt-1 text-[15px] font-semibold text-slate-100 truncate">
                  {(selected?.title || "(untitled)") as string}
                </div>
                <div className="mt-1 text-[11px] text-slate-500">
                  {selected ? `${(selected.status ?? "").toUpperCase()} • ${fmtShort(selected.created_at)}` : "—"}
                  <span className="mx-2 text-slate-700">•</span>
                  <span className={cx("font-semibold", isSandbox ? "text-amber-300" : "text-sky-300")}>{env}</span>
                </div>
              </div>

              <button
                onClick={() => setReaderOpen(false)}
                className="rounded-full border border-slate-700 bg-slate-900/60 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-800/60"
              >
                Close
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-4">
              <div className="rounded-2xl border border-slate-800 bg-black/40 px-5 py-5">
                <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Resolution</div>
                <pre className="mt-2 whitespace-pre-wrap font-sans text-[13px] leading-[1.8] text-slate-100">
                  {selected?.body ?? "—"}
                </pre>
              </div>

              <div className="rounded-2xl border border-slate-800 bg-black/30 px-5 py-5">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[10px] uppercase tracking-[0.22em] text-indigo-200">AXIOM Advisory</div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => loadAxiomNotesForSelected()}
                      disabled={!selected || axiomBusy !== null}
                      className="rounded-full border border-slate-700 bg-slate-950/40 px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {axiomBusy === "load" ? "Loading…" : "Load"}
                    </button>
                    <button
                      onClick={() => runAxiomCouncilReview()}
                      disabled={!selected || axiomBusy !== null}
                      className="rounded-full border border-indigo-400/50 bg-indigo-500/10 px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-indigo-200 hover:bg-indigo-500/15 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {axiomBusy === "run" ? "Running…" : "Run AXIOM"}
                    </button>
                  </div>
                </div>

                <div className="mt-2 text-[11px] text-slate-500">
                  {axiomSelected?.created_at ? `Latest: ${fmtShort(axiomSelected.created_at)}` : "No advisory loaded."}
                </div>

                <pre className="mt-3 whitespace-pre-wrap font-sans text-[12px] leading-[1.7] text-slate-200">
                  {axiomSelected?.content?.trim() ? axiomSelected.content : "— (No advisory loaded yet.) —"}
                </pre>
              </div>
            </div>

            <div className="shrink-0 px-5 py-4 border-t border-slate-800 flex items-center justify-between text-[10px] text-slate-500">
              <span>Reader is non-mutating. Authority actions remain in Council.</span>
              <span>Oasis OS · Evidence-Bound Governance</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusTabButton({
  label,
  value,
  active,
  onClick,
}: {
  label: string;
  value: StatusTab;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "px-4 py-2 rounded-full text-left transition min-w-[110px] shrink-0",
        active
          ? "bg-emerald-500/15 border border-emerald-400/70 text-slate-50"
          : "bg-transparent border border-transparent hover:bg-slate-900/60 text-slate-300"
      )}
    >
      <div className="text-xs font-semibold">{label}</div>
      <div className="text-[10px] text-slate-400 uppercase tracking-[0.18em]">{value}</div>
    </button>
  );
}

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
      type="button"
      onClick={onClick}
      className={cx(
        "px-4 py-2 rounded-full text-left transition min-w-[150px]",
        active
          ? "bg-slate-50/10 border border-slate-200/25 text-slate-50"
          : "bg-transparent border border-transparent hover:bg-slate-900/60 text-slate-300"
      )}
    >
      <div className="text-xs font-semibold">{label}</div>
      <div className="text-[10px] text-slate-400 uppercase tracking-[0.18em]">Panel</div>
    </button>
  );
}
