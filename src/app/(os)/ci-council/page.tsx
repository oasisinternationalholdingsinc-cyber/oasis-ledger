"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";

type CouncilStatus = "PENDING" | "APPROVED" | "REJECTED" | "ARCHIVED";
type StatusTab = "PENDING" | "APPROVED" | "REJECTED" | "ARCHIVED" | "ALL";

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
};

// ✅ IMPORTANT: set this to the exact deployed Edge Function name in Supabase
const AXIOM_COUNCIL_MEMO_FN = "axiom-council-memo";

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

function isMissingColumnErr(err: any) {
  const msg = (err?.message ?? "").toLowerCase();
  return msg.includes("does not exist") && msg.includes("column");
}

function isTruthImmutableErr(err: any) {
  const msg = (err?.message ?? "").toLowerCase();
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

export default function CICouncilPage() {
  const entityCtx = useEntity() as any;
  const osEnv = useOsEnv();

  // CRITICAL: entity is ALWAYS corp entity (never "sandbox")
  const activeEntitySlug = (entityCtx?.activeEntity as string) || "holdings";

  // env toggle ONLY controls is_test
  const isSandbox = !!osEnv?.isSandbox;
  const env: "SANDBOX" | "ROT" = isSandbox ? "SANDBOX" : "ROT";

  const activeEntityLabel = useMemo(
    () => ENTITY_LABELS[activeEntitySlug] ?? activeEntitySlug,
    [activeEntitySlug]
  );

  const [entityId, setEntityId] = useState<string | null>(
    (entityCtx?.activeEntityId as string) || null
  );

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | "approve" | "reject" | "archive">(null);

  const [tab, setTab] = useState<StatusTab>("PENDING");
  const [query, setQuery] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(true);

  const [records, setRecords] = useState<LedgerRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [readerOpen, setReaderOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // AXIOM (Council)
  const [axiomBusy, setAxiomBusy] = useState<null | "load" | "run" | "url">(null);
  const [axiomNotes, setAxiomNotes] = useState<AxiomNote[]>([]);
  const [axiomSelectedNoteId, setAxiomSelectedNoteId] = useState<string | null>(null);
  const [axiomLastMemo, setAxiomLastMemo] = useState<AxiomMemo | null>(null);
  const [axiomMemoUrl, setAxiomMemoUrl] = useState<string | null>(null);

  const lastAutoPickRef = useRef<string | null>(null);

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

  // env filtering:
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

    const ctxId = (entityCtx?.activeEntityId as string) || null;
    if (ctxId) {
      setEntityId(ctxId);
      return ctxId;
    }

    const { data, error } = await supabase.from("entities").select("id, slug").eq("slug", slug).single();
    if (error || !data?.id) throw error ?? new Error("Entity lookup failed.");
    setEntityId(data.id);
    return data.id as string;
  }

  async function reload(preserveSelection = true) {
    setLoading(true);
    setError(null);

    try {
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
        if (still) {
          setLoading(false);
          return;
        }
      }

      const tabKey = tab === "ALL" ? "ALL" : tab;
      const inTab =
        tabKey === "ALL"
          ? rows
          : rows.filter((r) => (r.status ?? "").toUpperCase() === tabKey);

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

  useEffect(() => {
    setTab("PENDING");
    setQuery("");
    setSelectedId(null);
    void reload(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEntitySlug, isSandbox]);

  function handleSelect(rec: LedgerRecord) {
    if (!rec?.id) return;
    setSelectedId(rec.id);
    setError(null);
    setInfo(null);
    // AXIOM resets per selection
    setAxiomNotes([]);
    setAxiomSelectedNoteId(null);
    setAxiomLastMemo(null);
    setAxiomMemoUrl(null);
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
      // fall through
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

  async function handleArchiveDiscipline() {
    flashError(
      "Council does not directly archive by default. Use Forge (signature path) or wire Council to the deterministic seal/archive function for direct-archive mode."
    );
  }

  const lanePill = cx("font-semibold", isSandbox ? "text-amber-300" : "text-sky-300");
  const canApprove = !!selected && (selected.status ?? "").toUpperCase() === "PENDING";
  const canReject = !!selected && (selected.status ?? "").toUpperCase() === "PENDING";
  const showNoEntityWarning = !entityId;

  // AXIOM helpers (Council)
  const axiomSelected = useMemo(() => {
    const pick = axiomNotes.find((n) => n.id === axiomSelectedNoteId);
    return pick ?? (axiomNotes[0] ?? null);
  }, [axiomNotes, axiomSelectedNoteId]);

  async function loadAxiomNotesForSelected() {
    if (!selected?.id) return;

    setAxiomBusy("load");
    try {
      // ✅ Council reads advisory from ai_notes (stable in your stack)
      const { data, error } = await supabase
        .from("ai_notes")
        .select("id,title,content,model,tokens_used,created_at,metadata")
        .eq("scope_type", "document")
        .eq("scope_id", selected.id)
        .in("note_type", ["summary", "memo", "note"])
        .order("created_at", { ascending: false })
        .limit(20);

      if (error) throw error;

      const notes: AxiomNote[] = (data ?? []).map((r: any) => ({
        id: r.id,
        title: r.title ?? "AXIOM Advisory",
        content: r.content ?? "",
        model: r.model ?? null,
        tokens_used: r.tokens_used ?? null,
        created_at: r.created_at ?? null,
        severity:
          (r?.metadata?.severity as string | undefined) ??
          (r?.metadata?.severity_pill as string | undefined) ??
          null,
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

  async function invokeAxiomMemoEdgeFunction() {
    if (!selected?.id) return flashError("Select a record first.");

    setAxiomBusy("run");
    setAxiomLastMemo(null);
    setAxiomMemoUrl(null);

    try {
      const payload = {
        record_id: selected.id,
        is_test: isSandbox,
      };

      const { data, error } = await supabase.functions.invoke(AXIOM_COUNCIL_MEMO_FN, { body: payload });
      if (error) throw error;

      const memo = data as AxiomMemo;
      if (!memo || memo.ok === false) throw new Error(memo?.error ?? "AXIOM memo failed.");

      setAxiomLastMemo(memo);
      flashInfo(memo.warning ? `AXIOM memo: ok (note warning).` : "AXIOM memo generated & registered.");

      // Refresh advisory list (memo function also writes ai_notes in your design)
      void loadAxiomNotesForSelected();

      // Signed URL for the memo PDF (private bucket)
      if (memo.storage_bucket && memo.storage_path) {
        setAxiomBusy("url");
        const { data: urlData, error: urlErr } = await supabase.storage
          .from(memo.storage_bucket)
          .createSignedUrl(memo.storage_path, 60 * 15);
        if (!urlErr && urlData?.signedUrl) setAxiomMemoUrl(urlData.signedUrl);
      }
    } catch (e: any) {
      flashError(e?.message ?? "AXIOM: memo generation failed.");
    } finally {
      setAxiomBusy(null);
    }
  }

  const axiomSeverityLabel =
    (axiomLastMemo?.severity as string | undefined) ??
    (axiomSelected?.severity as string | undefined) ??
    null;

  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      {/* Header under OS bar */}
      <div className="mb-4 shrink-0">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">CI • Council</div>
        <h1 className="mt-1 text-xl font-semibold text-slate-50">Council Review · Authority Console</h1>
        <p className="mt-1 text-xs text-slate-400 max-w-3xl">
          Council is the authority gate. <span className="text-emerald-300 font-semibold">Approve</span> or{" "}
          <span className="text-rose-300 font-semibold">Reject</span>. Execution/archival discipline occurs in Forge
          (signature) or in a direct-archive pipeline (if explicitly wired).
        </p>
        <div className="mt-2 text-xs text-slate-400">
          Entity: <span className="text-emerald-300 font-medium">{activeEntityLabel}</span>
          <span className="mx-2 text-slate-700">•</span>
          Lane: <span className={lanePill}>{env}</span>
        </div>

        {showNoEntityWarning && (
          <div className="mt-3 rounded-2xl border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-[12px] text-amber-200">
            OS Context: <b>activeEntityId</b> missing; Council resolved <code>entities.id</code> by slug. Env toggle flips{" "}
            <code>is_test</code> only.
          </div>
        )}
      </div>

      {/* Main OS window frame */}
      <div className="flex-1 min-h-0 flex justify-center overflow-hidden">
        <div className="w-full max-w-[1500px] h-full rounded-3xl border border-slate-900 bg-black/60 shadow-[0_0_60px_rgba(15,23,42,0.9)] px-6 py-5 flex flex-col overflow-hidden">
          {/* Top strip */}
          <div className="shrink-0 mb-4 flex items-center justify-between gap-4">
            <div className="inline-flex rounded-full bg-slate-950/70 border border-slate-800 p-1 overflow-hidden">
              <StatusTabButton label="Pending" value="PENDING" active={tab === "PENDING"} onClick={() => setTab("PENDING")} />
              <StatusTabButton label="Approved" value="APPROVED" active={tab === "APPROVED"} onClick={() => setTab("APPROVED")} />
              <StatusTabButton label="Rejected" value="REJECTED" active={tab === "REJECTED"} onClick={() => setTab("REJECTED")} />
              <StatusTabButton label="Archived" value="ARCHIVED" active={tab === "ARCHIVED"} onClick={() => setTab("ARCHIVED")} />
              <StatusTabButton label="All" value="ALL" active={tab === "ALL"} onClick={() => setTab("ALL")} />
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => setDrawerOpen((v) => !v)}
                className="rounded-full border border-slate-800 bg-slate-950/60 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60"
              >
                {drawerOpen ? "Hide Queue" : "Show Queue"}
              </button>

              <button
                onClick={() => setReaderOpen(true)}
                disabled={!selected}
                className="rounded-full border border-emerald-400/60 bg-emerald-500/10 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-emerald-200 hover:bg-emerald-500/15 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Open Reader
              </button>

              <button
                onClick={() => reload(true)}
                className="rounded-full border border-slate-800 bg-slate-950/60 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60"
              >
                Refresh
              </button>
            </div>
          </div>

          {/* Workspace */}
          <div className="flex-1 min-h-0 flex gap-4 overflow-hidden">
            {/* Left queue drawer */}
            {drawerOpen && (
              <aside className="w-[360px] shrink-0 min-h-0 rounded-2xl border border-slate-800 bg-slate-950/40 flex flex-col overflow-hidden">
                <div className="shrink-0 p-4 border-b border-slate-800">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                      Queue · {filtered.length}/{envFiltered.length} <span className="mx-2 text-slate-700">•</span>
                      <span className={lanePill}>{env}</span>
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
                                <div className="truncate text-[13px] font-semibold text-slate-100">
                                  {r.title || "(untitled)"}
                                </div>
                                <div className="mt-1 text-[11px] text-slate-500">
                                  {fmtShort(r.created_at)} · {r.record_type || "resolution"}
                                </div>
                                <div className="mt-2 line-clamp-2 text-[12px] leading-relaxed text-slate-400">
                                  {r.body || "—"}
                                </div>
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
            <section className="flex-1 min-w-0 min-h-0 rounded-2xl border border-slate-800 bg-slate-950/40 flex flex-col overflow-hidden">
              <div className="shrink-0 px-5 py-4 border-b border-slate-800 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">Review</div>
                  <div className="mt-1 text-[13px] text-slate-400">
                    Entity: <span className="text-emerald-300 font-semibold">{activeEntityLabel}</span>
                    <span className="mx-2 text-slate-700">•</span>
                    Lane: <span className={lanePill}>{env}</span>
                    {selected && (
                      <>
                        <span className="mx-2 text-slate-700">•</span>
                        <span className="text-slate-200">{(selected.status ?? "").toUpperCase()}</span>
                      </>
                    )}
                  </div>
                </div>

                {selected && (
                  <div className="shrink-0 flex items-center gap-2">
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
                      <div className="mt-1 text-[15px] font-semibold text-slate-100 truncate">
                        {selected.title || "(untitled)"}
                      </div>
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
                      <span>Review is non-mutating. Authority actions happen in the panel.</span>
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

            {/* Right authority panel */}
            <aside className="w-[360px] shrink-0 min-h-0 rounded-2xl border border-slate-800 bg-slate-950/40 flex flex-col overflow-hidden">
              <div className="shrink-0 px-5 py-4 border-b border-slate-800">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                      Authority Panel
                    </div>
                    <div className="mt-1 text-[12px] text-slate-500">Advisory only. Council remains the authority.</div>
                  </div>

                  {axiomSeverityLabel && (
                    <span
                      className={cx(
                        "rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.18em]",
                        severityPill(axiomSeverityLabel)
                      )}
                    >
                      {axiomSeverityLabel}
                    </span>
                  )}
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto px-5 py-5 space-y-4">
                {/* AXIOM Advisory */}
                <div className="rounded-2xl border border-slate-800 bg-black/35 px-4 py-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] uppercase tracking-[0.22em] text-indigo-200">AXIOM Advisory</div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => loadAxiomNotesForSelected()}
                        disabled={!selected || axiomBusy !== null}
                        className="rounded-full border border-slate-700 bg-slate-950/40 px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {axiomBusy === "load" ? "Loading…" : "Load"}
                      </button>

                      <button
                        onClick={() => invokeAxiomMemoEdgeFunction()}
                        disabled={!selected || axiomBusy !== null}
                        className="rounded-full border border-amber-400/50 bg-amber-500/10 px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-amber-200 hover:bg-amber-500/15 disabled:opacity-50 disabled:cursor-not-allowed"
                        title="Renders AXIOM Memo PDF as sidecar evidence (lane-scoped) without touching the resolution PDF."
                      >
                        {axiomBusy === "run" ? "Generating…" : "Generate Memo PDF"}
                      </button>
                    </div>
                  </div>

                  <div className="mt-3 text-[12px] text-slate-400 leading-relaxed">
                    {selected ? (
                      <>
                        Advisory is read-only. Memo PDF is a{" "}
                        <span className="text-amber-200 font-semibold">sidecar attachment</span> and stays lane-scoped ({env}).
                      </>
                    ) : (
                      <>Select a record to evaluate.</>
                    )}
                  </div>

                  {/* notes list */}
                  {axiomNotes.length > 0 && (
                    <div className="mt-4">
                      <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Advisory History</div>
                      <div className="mt-2 grid gap-2">
                        {axiomNotes.slice(0, 4).map((n) => {
                          const active = (axiomSelected?.id ?? axiomNotes[0]?.id) === n.id;
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
                              <div className="text-[12px] font-semibold text-slate-100 truncate">{n.title || "AXIOM Advisory"}</div>
                              <div className="mt-1 text-[10px] text-slate-500">
                                {fmtShort(n.created_at)} {n.model ? `• ${n.model}` : ""}{" "}
                                {typeof n.tokens_used === "number" ? ` • ${n.tokens_used} tok` : ""}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* selected note preview */}
                  <div className="mt-4 rounded-2xl border border-slate-800 bg-black/25 px-4 py-4">
                    <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Advisory Preview</div>
                    <div className="mt-2 max-h-[190px] overflow-y-auto">
                      <pre className="whitespace-pre-wrap font-sans text-[12px] leading-[1.7] text-slate-200">
                        {axiomSelected?.content?.trim() ? axiomSelected.content : "— (No advisory loaded yet) —"}
                      </pre>
                    </div>
                  </div>

                  {/* memo PDF status */}
                  <div className="mt-4 rounded-2xl border border-slate-800 bg-black/20 px-4 py-4">
                    <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Memo PDF Attachment</div>

                    {!axiomLastMemo ? (
                      <div className="mt-2 text-[12px] text-slate-500">No memo generated yet.</div>
                    ) : (
                      <div className="mt-2 space-y-2">
                        <div className="text-[12px] text-slate-300">
                          Status: <span className="text-emerald-200 font-semibold">Registered</span>
                          {axiomLastMemo.file_hash ? (
                            <>
                              <span className="mx-2 text-slate-700">•</span>
                              <span className="text-slate-400">hash</span>{" "}
                              <span className="font-mono text-[11px] text-slate-200">
                                {axiomLastMemo.file_hash.slice(0, 10)}…{axiomLastMemo.file_hash.slice(-8)}
                              </span>
                            </>
                          ) : null}
                        </div>

                        {axiomMemoUrl && (
                          <div className="grid grid-cols-2 gap-2">
                            <a
                              href={axiomMemoUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="rounded-2xl border border-amber-500/40 bg-amber-500/10 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-amber-200 hover:bg-amber-500/15"
                            >
                              Open PDF
                            </a>
                            <a
                              href={axiomMemoUrl}
                              download
                              className="rounded-2xl border border-slate-700 bg-slate-950/40 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60"
                            >
                              Download
                            </a>
                          </div>
                        )}

                        {!axiomMemoUrl && axiomLastMemo.storage_bucket && axiomLastMemo.storage_path && (
                          <div className="text-[11px] text-slate-500">
                            Stored: <span className="font-mono">{axiomLastMemo.storage_bucket}</span> /{" "}
                            <span className="font-mono">{axiomLastMemo.storage_path}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Authority actions */}
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
              </div>

              <div className="shrink-0 px-5 py-3 border-t border-slate-800 text-[10px] text-slate-500 flex items-center justify-between">
                <span>CI-Council · Authority gate (governance_ledger)</span>
                <span>Scoped by entity_id + is_test</span>
              </div>
            </aside>
          </div>
        </div>
      </div>

      {/* Reader Modal */}
      {readerOpen && (
        <div className="fixed inset-0 z-[90] bg-black/70 px-6 py-6 flex items-center justify-center">
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
                  <span className={lanePill}>{env}</span>
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
                  <button
                    onClick={() => loadAxiomNotesForSelected()}
                    disabled={!selected || axiomBusy !== null}
                    className="rounded-full border border-slate-700 bg-slate-950/40 px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {axiomBusy === "load" ? "Loading…" : "Load"}
                  </button>
                </div>

                <div className="mt-2 text-[11px] text-slate-500">
                  {axiomSelected?.created_at ? `Latest: ${fmtShort(axiomSelected.created_at)}` : "No advisory loaded."}
                </div>

                <pre className="mt-3 whitespace-pre-wrap font-sans text-[12px] leading-[1.7] text-slate-200">
                  {axiomSelected?.content?.trim() ? axiomSelected.content : "— (No advisory loaded yet. Click Load.) —"}
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
        "px-4 py-2 rounded-full text-left transition min-w-[110px]",
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
