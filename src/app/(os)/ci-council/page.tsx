// src/app/(os)/ci-council/page.tsx
"use client";
export const dynamic = "force-dynamic";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";

type LedgerStatus =
  | "PENDING"
  | "IN_REVIEW"
  | "CHANGES_REQUESTED"
  | "APPROVED"
  | "REJECTED"
  | "SIGNING"
  | "SIGNED"
  | "ARCHIVED"
  | string;

type ExecutionMode = "signature" | "direct";

type CouncilItem = {
  id: string;
  entity_id: string | null;
  title: string | null;
  record_type: string | null;
  status: LedgerStatus | null;
  created_at: string | null;
  updated_at?: string | null;

  // Optional columns (may or may not exist in your schema)
  body?: string | null;
  description?: string | null;
  record_no?: string | null;
  source?: string | null;

  // Optional “decision” fields (may or may not exist)
  execution_mode?: string | null;
  requires_signature?: boolean | null;
  approved_at?: string | null;
  approved_by?: string | null;
  rejected_at?: string | null;
  rejected_by?: string | null;
  council_notes?: string | null;
};

const ENTITY_LABELS: Record<string, string> = {
  holdings: "Oasis International Holdings Inc.",
  lounge: "Oasis International Lounge Inc.",
  "real-estate": "Oasis International Real Estate Inc.",
};

type Lane = "pending" | "completed";
type StatusFilter = "all" | "PENDING" | "IN_REVIEW" | "APPROVED" | "REJECTED" | "CHANGES_REQUESTED";

function fmtShort(iso: string | null | undefined) {
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
    return String(iso);
  }
}

function badgeClass(status: string | null | undefined) {
  const s = (status || "").toUpperCase();
  if (s === "APPROVED") return "bg-emerald-500/20 text-emerald-300";
  if (s === "REJECTED") return "bg-rose-500/20 text-rose-300";
  if (s === "CHANGES_REQUESTED") return "bg-amber-500/20 text-amber-300";
  if (s === "SIGNING") return "bg-sky-500/20 text-sky-300";
  if (s === "SIGNED") return "bg-indigo-500/20 text-indigo-300";
  if (s === "ARCHIVED") return "bg-slate-700/20 text-slate-300";
  if (s === "IN_REVIEW") return "bg-cyan-500/20 text-cyan-300";
  return "bg-emerald-500/10 text-emerald-200";
}

export default function CICouncilPage() {
  const { activeEntity } = useEntity();

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [items, setItems] = useState<CouncilItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [lane, setLane] = useState<Lane>("pending");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const [mode, setMode] = useState<ExecutionMode>("signature");
  const [notes, setNotes] = useState("");
  const [dirtyNotes, setDirtyNotes] = useState(false);
  const notesSnap = useRef<{ id: string | null; notes: string }>({ id: null, notes: "" });

  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const activeEntityLabel = useMemo(
    () => ENTITY_LABELS[activeEntity] ?? activeEntity,
    [activeEntity]
  );

  const selected = useMemo(
    () => items.find((x) => x.id === selectedId) ?? null,
    [items, selectedId]
  );

  const pendingItems = useMemo(() => {
    // “pending lane” = anything not in terminal states
    const terminal = new Set(["APPROVED", "REJECTED", "ARCHIVED", "SIGNED"]);
    return items.filter((x) => !terminal.has(String(x.status || "").toUpperCase()));
  }, [items]);

  const completedItems = useMemo(() => {
    const terminal = new Set(["APPROVED", "REJECTED", "ARCHIVED", "SIGNED"]);
    return items.filter((x) => terminal.has(String(x.status || "").toUpperCase()));
  }, [items]);

  const laneItems = useMemo(() => {
    const base = lane === "completed" ? completedItems : pendingItems;
    if (statusFilter === "all") return base;
    return base.filter((x) => String(x.status || "").toUpperCase() === statusFilter);
  }, [lane, completedItems, pendingItems, statusFilter]);

  function flashError(msg: string) {
    console.error(msg);
    setError(msg);
    setTimeout(() => setError(null), 6000);
  }

  function flashInfo(msg: string) {
    setInfo(msg);
    setTimeout(() => setInfo(null), 4000);
  }

  function markNotesSnapshot(id: string | null, v: string) {
    notesSnap.current = { id, notes: v };
    setDirtyNotes(false);
  }

  function computeNotesDirty(next: string, id: string | null) {
    const snap = notesSnap.current;
    if (snap.id !== id) return false;
    return snap.notes !== next;
  }

  function confirmNavigateAwayIfDirty(): boolean {
    if (!dirtyNotes) return true;
    const ok = window.confirm("You have unsaved council notes. Continue and lose changes?");
    return ok;
  }

  // ---------------------------------------------------------------------------
  // Load queue for active entity
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      setInfo(null);

      try {
        // Map slug -> entity_id
        const { data: entityRow, error: entityErr } = await supabase
          .from("entities")
          .select("id, name, slug")
          .eq("slug", activeEntity)
          .single();

        if (entityErr || !entityRow) throw entityErr ?? new Error("Entity not found.");

        // NOTE: keep select conservative to avoid column-missing crashes.
        // We’ll request optional fields too, but if your schema is strict,
        // remove extras from this select list.
        const { data, error } = await supabase
          .from("governance_ledger")
          .select(
            `
              id,
              entity_id,
              title,
              record_type,
              status,
              created_at,
              updated_at,
              body,
              description,
              record_no,
              source,
              execution_mode,
              requires_signature,
              approved_at,
              approved_by,
              rejected_at,
              rejected_by,
              council_notes
            `
          )
          .eq("entity_id", entityRow.id)
          .order("created_at", { ascending: false });

        if (error) throw error;
        if (cancelled) return;

        const rows = (data ?? []) as CouncilItem[];
        setItems(rows);

        // Default selection: most recent “PENDING/IN_REVIEW/CHANGES_REQUESTED” if exists
        setLane("pending");
        setStatusFilter("all");

        const first =
          rows.find((r) => {
            const s = String(r.status || "").toUpperCase();
            return s === "PENDING" || s === "IN_REVIEW" || s === "CHANGES_REQUESTED";
          }) ?? null;

        if (first) {
          setSelectedId(first.id);

          const inferredMode =
            (String(first.execution_mode || "").toLowerCase().includes("sign") ||
              first.requires_signature === true)
              ? "signature"
              : String(first.execution_mode || "").toLowerCase().includes("direct")
              ? "direct"
              : "signature";

          setMode(inferredMode);
          const initialNotes = first.council_notes ?? "";
          setNotes(initialNotes);
          markNotesSnapshot(first.id, initialNotes);
        } else {
          setSelectedId(null);
          setNotes("");
          markNotesSnapshot(null, "");
        }
      } catch (err: any) {
        flashError(err?.message ?? "Failed to load Council queue.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEntity]);

  function handleSelect(item: CouncilItem) {
    if (!confirmNavigateAwayIfDirty()) return;

    setSelectedId(item.id);

    const inferredMode =
      (String(item.execution_mode || "").toLowerCase().includes("sign") ||
        item.requires_signature === true)
        ? "signature"
        : String(item.execution_mode || "").toLowerCase().includes("direct")
        ? "direct"
        : "signature";

    setMode(inferredMode);

    const initialNotes = item.council_notes ?? "";
    setNotes(initialNotes);
    setError(null);
    setInfo(null);
    markNotesSnapshot(item.id, initialNotes);
  }

  // ---------------------------------------------------------------------------
  // Writes (defensive / non-breaking): try a few update shapes
  // ---------------------------------------------------------------------------
  async function tryUpdateLedger(
    id: string,
    patch: Record<string, any>
  ): Promise<{ ok: boolean; row?: CouncilItem }> {
    const { data, error } = await supabase
      .from("governance_ledger")
      .update(patch as any)
      .eq("id", id)
      .select(
        `
          id,
          entity_id,
          title,
          record_type,
          status,
          created_at,
          updated_at,
          body,
          description,
          record_no,
          source,
          execution_mode,
          requires_signature,
          approved_at,
          approved_by,
          rejected_at,
          rejected_by,
          council_notes
        `
      )
      .single();

    if (error) return { ok: false };
    return { ok: true, row: data as CouncilItem };
  }

  async function persistModeAndNotesOnly() {
    if (!selected) return;

    setBusy(true);
    setError(null);
    setInfo(null);

    try {
      // Try: execution_mode + council_notes
      const patchA = {
        execution_mode: mode === "signature" ? "SIGNATURE_REQUIRED" : "DIRECT_ARCHIVE",
        council_notes: notes || null,
        updated_at: new Date().toISOString(),
      };

      let r = await tryUpdateLedger(selected.id, patchA);
      if (!r.ok) {
        // Try: requires_signature + council_notes
        const patchB = {
          requires_signature: mode === "signature",
          council_notes: notes || null,
          updated_at: new Date().toISOString(),
        };
        r = await tryUpdateLedger(selected.id, patchB);
      }

      if (!r.ok || !r.row) {
        throw new Error(
          "Council save failed (schema mismatch). If needed, confirm governance_ledger has council_notes and either execution_mode or requires_signature."
        );
      }

      setItems((prev) => prev.map((x) => (x.id === r.row!.id ? r.row! : x)));
      markNotesSnapshot(r.row.id, r.row.council_notes ?? "");
      flashInfo("Council notes saved.");
    } catch (err: any) {
      flashError(err?.message ?? "Failed to save council notes.");
    } finally {
      setBusy(false);
    }
  }

  async function approveSelected() {
    if (!selected) return;

    setBusy(true);
    setError(null);
    setInfo(null);

    try {
      // Approve + decision fields (defensive)
      const now = new Date().toISOString();

      const patchA = {
        status: "APPROVED",
        execution_mode: mode === "signature" ? "SIGNATURE_REQUIRED" : "DIRECT_ARCHIVE",
        council_notes: notes || null,
        approved_at: now,
        updated_at: now,
      };

      let r = await tryUpdateLedger(selected.id, patchA);
      if (!r.ok) {
        // fallback: requires_signature
        const patchB = {
          status: "APPROVED",
          requires_signature: mode === "signature",
          council_notes: notes || null,
          approved_at: now,
          updated_at: now,
        };
        r = await tryUpdateLedger(selected.id, patchB);
      }

      if (!r.ok || !r.row) {
        // final fallback: status only
        const patchC = { status: "APPROVED", updated_at: now };
        r = await tryUpdateLedger(selected.id, patchC);
      }

      if (!r.ok || !r.row) throw new Error("Approve failed. (RLS/constraints/schema)");

      setItems((prev) => prev.map((x) => (x.id === r.row!.id ? r.row! : x)));
      markNotesSnapshot(r.row.id, r.row.council_notes ?? "");
      flashInfo("Approved.");

      // Keep selection but move lane if user is in pending
    } catch (err: any) {
      flashError(err?.message ?? "Approve failed.");
    } finally {
      setBusy(false);
    }
  }

  async function requestChanges() {
    if (!selected) return;

    setBusy(true);
    setError(null);
    setInfo(null);

    try {
      const now = new Date().toISOString();
      const patch = {
        status: "CHANGES_REQUESTED",
        council_notes: notes || null,
        updated_at: now,
      };
      const r = await tryUpdateLedger(selected.id, patch);
      if (!r.ok || !r.row) throw new Error("Request changes failed.");
      setItems((prev) => prev.map((x) => (x.id === r.row!.id ? r.row! : x)));
      markNotesSnapshot(r.row.id, r.row.council_notes ?? "");
      flashInfo("Changes requested.");
    } catch (err: any) {
      flashError(err?.message ?? "Request changes failed.");
    } finally {
      setBusy(false);
    }
  }

  async function rejectSelected() {
    if (!selected) return;

    const ok = window.confirm("Reject this record? This does not delete the ledger row.");
    if (!ok) return;

    setBusy(true);
    setError(null);
    setInfo(null);

    try {
      const now = new Date().toISOString();
      const patchA = {
        status: "REJECTED",
        council_notes: notes || null,
        rejected_at: now,
        updated_at: now,
      };

      let r = await tryUpdateLedger(selected.id, patchA);
      if (!r.ok) {
        const patchB = { status: "REJECTED", updated_at: now };
        r = await tryUpdateLedger(selected.id, patchB);
      }

      if (!r.ok || !r.row) throw new Error("Reject failed.");
      setItems((prev) => prev.map((x) => (x.id === r.row!.id ? r.row! : x)));
      markNotesSnapshot(r.row.id, r.row.council_notes ?? "");
      flashInfo("Rejected.");
    } catch (err: any) {
      flashError(err?.message ?? "Reject failed.");
    } finally {
      setBusy(false);
    }
  }

  const selectedStatus = String(selected?.status || "").toUpperCase();
  const isTerminal =
    selectedStatus === "APPROVED" ||
    selectedStatus === "REJECTED" ||
    selectedStatus === "ARCHIVED" ||
    selectedStatus === "SIGNED";

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="flex h-[calc(100vh-80px)] w-full flex-col px-6 pb-6 pt-4 text-slate-100 overflow-hidden">
      {/* Header */}
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <div className="text-xs font-semibold tracking-[0.22em] text-emerald-300">
            CI-COUNCIL • LIVE
          </div>
          <h1 className="text-xl font-semibold tracking-wide">
            Approval Gate — Council Decision Console
          </h1>
          <p className="mt-1 text-xs text-slate-400">
            Council decides execution mode:{" "}
            <span className="text-emerald-300">Signature-required</span> (Forge) or{" "}
            <span className="text-slate-200">Direct archive</span>.
          </p>
        </div>

        <div className="hidden text-right text-xs text-slate-400 md:block">
          <div>Active entity</div>
          <div className="font-medium text-slate-200">{activeEntityLabel}</div>
        </div>
      </div>

      {/* Main layout */}
      <div className="flex flex-1 gap-4 overflow-hidden">
        {/* LEFT: Queue */}
        <div className="flex h-full w-[28%] flex-col rounded-2xl bg-slate-950/70 p-4 shadow-lg shadow-black/40 overflow-hidden">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-400">
              Council queue
            </div>

            <div className="flex items-center gap-2">
              <div className="flex rounded-full border border-slate-800 bg-slate-950/70 p-1 text-[10px] uppercase tracking-[0.18em]">
                <button
                  onClick={() => setLane("pending")}
                  className={[
                    "rounded-full px-3 py-1 transition",
                    lane === "pending"
                      ? "bg-emerald-500 text-slate-950"
                      : "text-slate-400 hover:bg-slate-900/70",
                  ].join(" ")}
                >
                  Active
                </button>
                <button
                  onClick={() => setLane("completed")}
                  className={[
                    "rounded-full px-3 py-1 transition",
                    lane === "completed"
                      ? "bg-slate-200 text-slate-950"
                      : "text-slate-400 hover:bg-slate-900/70",
                  ].join(" ")}
                >
                  Completed
                </button>
              </div>
            </div>
          </div>

          {/* Filters */}
          <div className="mb-3 flex flex-wrap gap-1 text-[10px]">
            {(["all", "PENDING", "IN_REVIEW", "CHANGES_REQUESTED", "APPROVED", "REJECTED"] as StatusFilter[]).map(
              (k) => (
                <button
                  key={k}
                  onClick={() => setStatusFilter(k)}
                  className={`rounded-full px-2 py-1 uppercase tracking-[0.16em] ${
                    statusFilter === k
                      ? "bg-emerald-500 text-slate-950"
                      : "bg-slate-900/80 text-slate-400 hover:bg-slate-800"
                  }`}
                >
                  {k}
                </button>
              )
            )}
          </div>

          <div className="flex-1 overflow-y-auto rounded-xl border border-slate-800 bg-slate-950/60">
            {loading ? (
              <div className="p-3 text-xs text-slate-400">Loading queue…</div>
            ) : laneItems.length === 0 ? (
              <div className="p-3 text-xs text-slate-500">
                {lane === "completed"
                  ? "No completed items for this entity."
                  : "No pending items. Finalize a draft from CI-Alchemy to send it here."}
              </div>
            ) : (
              <ul className="divide-y divide-slate-800 text-xs">
                {laneItems.map((x) => (
                  <li
                    key={x.id}
                    onClick={() => handleSelect(x)}
                    className={`cursor-pointer px-3 py-2 transition hover:bg-slate-800/70 ${
                      x.id === selectedId ? "bg-slate-800/90" : ""
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-slate-100 truncate">
                          {x.title || "(untitled)"}
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-[10px] text-slate-500">
                          <span>{fmtShort(x.created_at)}</span>
                          <span className="w-1 h-1 rounded-full bg-slate-700" />
                          <span className="uppercase tracking-[0.16em]">
                            {x.record_type || "resolution"}
                          </span>
                        </div>
                      </div>

                      <span
                        className={`shrink-0 rounded-full px-2 py-[2px] text-[9px] uppercase tracking-[0.18em] ${badgeClass(
                          x.status
                        )}`}
                      >
                        {String(x.status || "PENDING")}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="mt-3 text-[10px] text-slate-500">
            Tip: Council doesn’t delete ledger rows. Cleanup is upstream (drafts/envelopes) and views hide test data.
          </div>
        </div>

        {/* MIDDLE: Record */}
        <div className="flex h-full w-[44%] flex-col rounded-2xl bg-slate-950/70 p-4 shadow-lg shadow-black/40 overflow-hidden">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-400">
                Record under review
              </div>
              <div className="mt-1 text-sm font-semibold text-slate-100">
                {selected?.title || "Select an item from the queue"}
              </div>
              <div className="mt-1 flex items-center gap-2 text-[10px] text-slate-500">
                <span>{selected ? fmtShort(selected.created_at) : "—"}</span>
                <span className="w-1 h-1 rounded-full bg-slate-700" />
                <span className="uppercase tracking-[0.16em]">
                  {selected?.record_type || "—"}
                </span>
                {selected?.status && (
                  <>
                    <span className="w-1 h-1 rounded-full bg-slate-700" />
                    <span className="text-slate-300">{String(selected.status)}</span>
                  </>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Link
                href="/ci-alchemy"
                className="rounded-full border border-slate-700 bg-slate-950 px-3 py-1.5 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/80"
              >
                Back to Alchemy
              </Link>
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-hidden">
            <div className="h-full overflow-y-auto rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-xs leading-relaxed">
              {!selected ? (
                <div className="text-[11px] text-slate-500">
                  Choose a queue item to review the record text and make a Council decision.
                </div>
              ) : (
                <>
                  {selected.description && (
                    <div className="mb-3 rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-[11px] text-slate-300">
                      {selected.description}
                    </div>
                  )}

                  <pre className="whitespace-pre-wrap font-sans text-[11px] text-slate-200">
                    {selected.body || "— (No body field found on this record) —"}
                  </pre>
                </>
              )}
            </div>
          </div>

          {(error || info) && (
            <div className="mt-3 text-[11px]">
              {error && (
                <div className="rounded-lg border border-red-500/70 bg-red-500/10 px-3 py-2 text-red-200">
                  {error}
                </div>
              )}
              {info && !error && (
                <div className="rounded-lg border border-emerald-500/70 bg-emerald-500/10 px-3 py-2 text-emerald-200">
                  {info}
                </div>
              )}
            </div>
          )}

          <div className="mt-3 text-[10px] text-slate-500">
            Approval ≠ archive. Approval only selects the execution path; Forge signs when required.
          </div>
        </div>

        {/* RIGHT: Decision + AXIOM */}
        <div className="flex h-full w-[28%] flex-col gap-3 overflow-hidden">
          {/* Decision */}
          <div className="flex h-[54%] flex-col rounded-2xl bg-slate-950/70 p-4 shadow-lg shadow-black/40 overflow-hidden">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-400">
                Council decision
              </div>

              {selected?.status && (
                <span
                  className={`rounded-full px-2 py-[2px] text-[9px] uppercase tracking-[0.18em] ${badgeClass(
                    selected.status
                  )}`}
                >
                  {String(selected.status)}
                </span>
              )}
            </div>

            {/* Execution Mode */}
            <div className="mb-3 grid grid-cols-2 gap-2">
              <button
                onClick={() => setMode("signature")}
                disabled={!selected || busy || isTerminal}
                className={[
                  "rounded-xl border px-4 py-3 text-left transition",
                  mode === "signature"
                    ? "border-emerald-500/60 bg-emerald-500/10"
                    : "border-slate-800 bg-slate-950 hover:bg-slate-900/60",
                  (!selected || busy || isTerminal) ? "opacity-60 cursor-not-allowed" : "",
                ].join(" ")}
              >
                <div className="text-[11px] uppercase tracking-[0.2em] text-emerald-300">
                  Signature path
                </div>
                <div className="mt-1 text-sm font-semibold text-slate-100">CI-Forge</div>
                <div className="mt-1 text-[11px] text-slate-400">
                  Envelope + signatures + archive.
                </div>
              </button>

              <button
                onClick={() => setMode("direct")}
                disabled={!selected || busy || isTerminal}
                className={[
                  "rounded-xl border px-4 py-3 text-left transition",
                  mode === "direct"
                    ? "border-slate-300/40 bg-slate-200/10"
                    : "border-slate-800 bg-slate-950 hover:bg-slate-900/60",
                  (!selected || busy || isTerminal) ? "opacity-60 cursor-not-allowed" : "",
                ].join(" ")}
              >
                <div className="text-[11px] uppercase tracking-[0.2em] text-slate-300">
                  Direct archive
                </div>
                <div className="mt-1 text-sm font-semibold text-slate-100">No envelope</div>
                <div className="mt-1 text-[11px] text-slate-400">
                  Must still generate PDF + archive discipline.
                </div>
              </button>
            </div>

            {/* Notes */}
            <div className="mb-2 flex items-center justify-between">
              <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">
                Council notes
              </div>
              {dirtyNotes && (
                <span className="rounded-full border border-amber-500/50 bg-amber-500/10 px-2 py-[2px] text-[10px] uppercase tracking-[0.18em] text-amber-200">
                  Unsaved
                </span>
              )}
            </div>

            <textarea
              className="min-h-[120px] w-full flex-1 resize-none rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-600 disabled:cursor-not-allowed disabled:text-slate-500"
              value={notes}
              onChange={(e) => {
                const v = e.target.value;
                setNotes(v);
                setDirtyNotes(computeNotesDirty(v, selectedId));
              }}
              placeholder="Non-blocking notes (rationale, conditions, required follow-ups)…"
              disabled={!selected || busy || isTerminal}
            />

            {/* Actions */}
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              <button
                onClick={persistModeAndNotesOnly}
                disabled={!selected || busy || isTerminal}
                className="inline-flex flex-1 items-center justify-center rounded-full border border-slate-700 bg-slate-950 px-4 py-2 font-semibold text-slate-200 transition hover:bg-slate-900/80 disabled:cursor-not-allowed disabled:text-slate-500"
                title="Saves notes + selected execution mode (defensive update)."
              >
                {busy ? "Working…" : "Save notes"}
              </button>

              <button
                onClick={requestChanges}
                disabled={!selected || busy || isTerminal}
                className="inline-flex flex-1 items-center justify-center rounded-full border border-amber-400/70 bg-slate-900/80 px-4 py-2 font-semibold text-amber-200 transition hover:bg-amber-500/10 disabled:cursor-not-allowed disabled:border-slate-700 disabled:text-slate-500"
              >
                Request changes
              </button>

              <button
                onClick={approveSelected}
                disabled={!selected || busy || isTerminal}
                className="inline-flex flex-1 items-center justify-center rounded-full bg-emerald-500 px-4 py-2 font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-emerald-900/60"
              >
                Approve
              </button>

              <button
                onClick={rejectSelected}
                disabled={!selected || busy || isTerminal}
                className="inline-flex flex-1 items-center justify-center rounded-full border border-rose-500/60 bg-rose-500/10 px-4 py-2 font-semibold text-rose-200 transition hover:bg-rose-500/15 disabled:cursor-not-allowed disabled:border-slate-700 disabled:text-slate-500 disabled:bg-slate-950"
              >
                Reject
              </button>
            </div>

            {selected && isTerminal && (
              <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-[11px] text-slate-400">
                This record is in a terminal state (<span className="text-slate-200">{selectedStatus}</span>).
                Council edits are locked at UX level.
              </div>
            )}
          </div>

          {/* AXIOM advisory shell */}
          <div className="flex h-[46%] flex-col rounded-2xl bg-slate-950/70 p-4 shadow-lg shadow-black/40 overflow-hidden">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-400">
                AXIOM advisory
              </div>
              <span className="rounded-full border border-slate-700 bg-slate-950 px-2 py-[2px] text-[9px] uppercase tracking-[0.18em] text-slate-300">
                advisory-only
              </span>
            </div>

            <div className="flex-1 overflow-y-auto rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-[11px] leading-relaxed text-slate-300">
              {!selected ? (
                <div className="text-slate-500">
                  Select a record to see contextual advisory (risk flags, missing clauses, signature necessity hints).
                </div>
              ) : (
                <>
                  <div className="mb-2 text-slate-200 font-semibold">
                    Signal snapshot (placeholder)
                  </div>
                  <ul className="list-disc pl-5 space-y-1 text-slate-400">
                    <li>Execution mode recommendation appears here (never blocking).</li>
                    <li>Missing clause alerts (authority, dates, signers, exhibits).</li>
                    <li>Severity flags: low / medium / high, but Council decides.</li>
                  </ul>

                  <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-slate-400">
                    Next wiring: read AXIOM views/tables for this record_id and render signals + summaries.
                  </div>
                </>
              )}
            </div>

            <div className="mt-2 text-[10px] text-slate-500">
              AXIOM never blocks Council. It advises; humans decide.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
