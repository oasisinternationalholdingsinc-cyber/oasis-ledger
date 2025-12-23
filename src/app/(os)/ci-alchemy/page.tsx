// src/app/(os)/ci-alchemy/page.tsx
"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";

type DraftStatus = "draft" | "reviewed" | "finalized" | "discarded";
type StatusFilter = "all" | "draft" | "reviewed" | "finalized" | "discarded";

type DraftRecord = {
  id: string;
  entity_id: string | null;
  entity_slug: string;
  entity_name: string;
  title: string;
  record_type: string;
  draft_text: string;
  status: DraftStatus;
  created_at: string | null;
  updated_at: string | null;
  finalized_record_id: string | null;
};

type SideTab = "drafts" | "axiom";
type Tone = "dark" | "light";

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

export default function CIAlchemyPage() {
  const { activeEntity } = useEntity();

  // Data
  const [loading, setLoading] = useState(true);
  const [alchemyRunning, setAlchemyRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [finalizing, setFinalizing] = useState(false);

  const [drafts, setDrafts] = useState<DraftRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Editor
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  // UI controls
  const [sideTab, setSideTab] = useState<SideTab>("drafts");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("draft");
  const [query, setQuery] = useState("");
  const [tone, setTone] = useState<Tone>("light"); // ✅ white paper by default

  // Reader modal
  const [readerOpen, setReaderOpen] = useState(false);
  const [readerTone, setReaderTone] = useState<Tone>("light");

  // Alerts
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Delete / Discard confirm
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmMode, setConfirmMode] = useState<"discard" | "delete">("discard");
  const [confirmText, setConfirmText] = useState("");
  const [confirmBusy, setConfirmBusy] = useState(false);

  // Unsaved guard
  const [dirty, setDirty] = useState(false);
  const lastLoadedRef = useRef<{ id: string | null; title: string; body: string } | null>(null);

  const activeEntityLabel = useMemo(
    () => ENTITY_LABELS[activeEntity] ?? activeEntity,
    [activeEntity]
  );

  const selectedDraft = useMemo(
    () => drafts.find((d) => d.id === selectedId) ?? null,
    [drafts, selectedId]
  );

  const canMutateSelected = useMemo(() => {
    if (!selectedDraft) return true; // new draft composing is allowed
    // Once it left Alchemy (finalized -> ledger linked), lock edits + deletes here.
    return !selectedDraft.finalized_record_id && selectedDraft.status !== "finalized";
  }, [selectedDraft]);

  const filteredDrafts = useMemo(() => {
    let list = drafts;

    // Filter lane
    if (statusFilter !== "all") list = list.filter((d) => d.status === statusFilter);

    // Search
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter((d) => {
        const hay = `${d.title ?? ""}\n${d.draft_text ?? ""}`.toLowerCase();
        return hay.includes(q);
      });
    }

    return list;
  }, [drafts, statusFilter, query]);

  function flashError(msg: string) {
    console.error(msg);
    setError(msg);
    setTimeout(() => setError(null), 6000);
  }

  function flashInfo(msg: string) {
    setInfo(msg);
    setTimeout(() => setInfo(null), 4000);
  }

  function markLoadedSnapshot(id: string | null, t: string, b: string) {
    lastLoadedRef.current = { id, title: t, body: b };
    setDirty(false);
  }

  function computeDirty(nextTitle: string, nextBody: string, nextId: string | null) {
    const snap = lastLoadedRef.current;
    if (!snap) return false;
    if (snap.id !== nextId) return false;
    return snap.title !== nextTitle || snap.body !== nextBody;
  }

  function confirmNavigateAwayIfDirty(): boolean {
    if (!dirty) return true;
    return window.confirm("You have unsaved edits. Continue and lose changes?");
  }

  function pickDefaultSelection(rows: DraftRecord[]) {
    if (!rows.length) return null;
    return (
      rows.find((d) => d.status === "draft" && !d.finalized_record_id) ||
      rows.find((d) => d.status === "reviewed" && !d.finalized_record_id) ||
      rows.find((d) => !d.finalized_record_id && d.status !== "discarded") ||
      rows[0] ||
      null
    );
  }

  async function reloadDrafts(preserveSelected = true) {
    setLoading(true);
    setError(null);

    try {
      const { data, error } = await supabase
        .from("governance_drafts")
        .select(
          `
            id,
            entity_id,
            entity_slug,
            entity_name,
            title,
            record_type,
            draft_text,
            status,
            created_at,
            updated_at,
            finalized_record_id
          `
        )
        .eq("entity_slug", activeEntity)
        .order("created_at", { ascending: false });

      if (error) throw error;

      const rows = (data ?? []) as DraftRecord[];
      setDrafts(rows);

      if (preserveSelected && selectedId) {
        const stillThere = rows.find((r) => r.id === selectedId);
        if (stillThere) {
          setTitle(stillThere.title ?? "");
          setBody(stillThere.draft_text ?? "");
          markLoadedSnapshot(stillThere.id, stillThere.title ?? "", stillThere.draft_text ?? "");
          return;
        }
      }

      const chosen = pickDefaultSelection(rows);
      if (chosen) {
        setSelectedId(chosen.id);
        setTitle(chosen.title ?? "");
        setBody(chosen.draft_text ?? "");
        markLoadedSnapshot(chosen.id, chosen.title ?? "", chosen.draft_text ?? "");
      } else {
        setSelectedId(null);
        setTitle("");
        setBody("");
        markLoadedSnapshot(null, "", "");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to load drafts";
      flashError(msg);
    } finally {
      setLoading(false);
    }
  }

  // Initial load per entity
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      await reloadDrafts(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEntity]);

  function handleSelectDraft(draft: DraftRecord) {
    if (!confirmNavigateAwayIfDirty()) return;
    setSelectedId(draft.id);
    setTitle(draft.title ?? "");
    setBody(draft.draft_text ?? "");
    setInfo(null);
    setError(null);
    markLoadedSnapshot(draft.id, draft.title ?? "", draft.draft_text ?? "");
  }

  function handleNewDraft() {
    if (!confirmNavigateAwayIfDirty()) return;
    setSelectedId(null);
    setTitle("");
    setBody("");
    setInfo(null);
    setError(null);
    markLoadedSnapshot(null, "", "");
  }

  // ---------------------------------------------------------------------------
  // Run CI-Alchemy (Edge Function "scribe") using signed-in token (RLS-safe)
  // ---------------------------------------------------------------------------
  async function handleRunAlchemy() {
    if (!title.trim() && !body.trim()) {
      flashError("Add a title or some context before running CI-Alchemy.");
      return;
    }

    const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!baseUrl || !anonKey) {
      flashError("Missing Supabase URL or anon key in environment.");
      return;
    }

    setAlchemyRunning(true);
    setError(null);
    setInfo(null);

    try {
      const { data: sessionData, error: sessionErr } = await supabase.auth.getSession();
      if (sessionErr) throw sessionErr;

      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) {
        flashError("Not authenticated. Please log in (OS auth gate).");
        return;
      }

      const hasBody = body.trim().length > 0;
      const instructions = hasBody
        ? body.trim()
        : `Draft a formal corporate resolution for ${activeEntityLabel} about: "${title.trim() || "a governance matter"}".
Include WHEREAS recitals, clear RESOLVED clauses, and a signing block for directors.`;

      const payload = {
        type: "board_resolution",
        entity_slug: activeEntity,
        entity_name: activeEntityLabel,
        title: title.trim() || "(untitled)",
        instructions,
        tone: "formal",
        language: "English",
      };

      const res = await fetch(`${baseUrl}/functions/v1/scribe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: anonKey,
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const text = await res.text();
        console.error("scribe HTTP error", res.status, text);
        flashError(`CI-Alchemy HTTP ${res.status}. See console for details.`);
        return;
      }

      const data = (await res.json()) as Record<string, unknown>;
      const ok = Boolean(data?.ok);
      if (!ok) {
        const detail = (data?.error as string) || (data?.stage as string) || "Unknown error.";
        flashError(`CI-Alchemy failed: ${detail}`);
        return;
      }

      const draftText =
        (data?.draft_text as string) ||
        (data?.draft as string) ||
        (data?.content as string) ||
        (data?.text as string) ||
        "";

      if (!draftText?.trim()) {
        flashError("CI-Alchemy returned no usable draft body.");
        return;
      }

      // Optimistic UI update, then hard re-sync from DB
      const draftId = (data?.draft_id as string) || crypto.randomUUID();

      const newDraft: DraftRecord = {
        id: draftId,
        entity_id: (data?.entity_id as string) ?? null,
        entity_slug: (data?.entity_slug as string) ?? activeEntity,
        entity_name: (data?.entity_name as string) ?? activeEntityLabel,
        title: ((data?.title as string) || title.trim() || "(untitled)") as string,
        record_type: ((data?.record_type as string) || "resolution") as string,
        draft_text: draftText,
        status: ((data?.draft_status as DraftStatus) || "draft") as DraftStatus,
        created_at: (data?.draft_created_at as string) ?? new Date().toISOString(),
        updated_at: null,
        finalized_record_id: (data?.finalized_record_id as string) ?? null,
      };

      setSelectedId(newDraft.id);
      setTitle(newDraft.title);
      setBody(newDraft.draft_text);
      setDrafts((prev) => [newDraft, ...prev.filter((d) => d.id !== newDraft.id)]);
      markLoadedSnapshot(newDraft.id, newDraft.title, newDraft.draft_text);

      flashInfo("Draft created. Review, edit, then Save.");
      await reloadDrafts(true);
    } catch (err: unknown) {
      console.error("scribe invoke exception", err);
      const msg = err instanceof Error ? err.message : "Network error calling CI-Alchemy (scribe).";
      flashError(msg);
    } finally {
      setAlchemyRunning(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Save / Review / Finalize
  // ---------------------------------------------------------------------------
  async function handleSaveDraft() {
    if (!title.trim() || !body.trim()) {
      flashError("Title and body are required to save a draft.");
      return;
    }
    if (selectedDraft && !canMutateSelected) {
      flashError("This draft has left Alchemy and is locked.");
      return;
    }

    setSaving(true);
    setError(null);
    setInfo(null);

    try {
      const { data: entityRow, error: entityErr } = await supabase
        .from("entities")
        .select("id, name, slug")
        .eq("slug", activeEntity)
        .single();

      if (entityErr || !entityRow) throw entityErr ?? new Error("Entity not found.");

      const basePayload = {
        entity_id: entityRow.id as string,
        entity_slug: activeEntity,
        entity_name: entityRow.name as string,
        title: title.trim(),
        draft_text: body,
        record_type: "resolution",
      };

      if (!selectedId) {
        const { data, error } = await supabase
          .from("governance_drafts")
          .insert({ ...basePayload, status: "draft" as DraftStatus })
          .select(
            `
              id, entity_id, entity_slug, entity_name, title, record_type, draft_text,
              status, created_at, updated_at, finalized_record_id
            `
          )
          .single();

        if (error) throw error;

        const newDraft = data as DraftRecord;
        setDrafts((prev) => [newDraft, ...prev]);
        setSelectedId(newDraft.id);
        markLoadedSnapshot(newDraft.id, newDraft.title ?? "", newDraft.draft_text ?? "");
        flashInfo("Draft created.");
      } else {
        const { data, error } = await supabase
          .from("governance_drafts")
          .update({ ...basePayload, updated_at: new Date().toISOString() })
          .eq("id", selectedId)
          .select(
            `
              id, entity_id, entity_slug, entity_name, title, record_type, draft_text,
              status, created_at, updated_at, finalized_record_id
            `
          )
          .single();

        if (error) throw error;

        const updated = data as DraftRecord;
        setDrafts((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
        markLoadedSnapshot(updated.id, updated.title ?? "", updated.draft_text ?? "");
        flashInfo("Draft saved.");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to save draft.";
      flashError(msg);
    } finally {
      setSaving(false);
    }
  }

  async function handleMarkReviewed() {
    if (!selectedId || !selectedDraft) return flashError("Select a draft first.");
    if (!canMutateSelected) return flashError("This draft has left Alchemy and can’t be changed here.");
    if (selectedDraft.status === "reviewed") return flashInfo("Already reviewed.");

    setSaving(true);
    setError(null);
    setInfo(null);

    try {
      const { data, error } = await supabase
        .from("governance_drafts")
        .update({ status: "reviewed" as DraftStatus, updated_at: new Date().toISOString() })
        .eq("id", selectedId)
        .select(
          `
            id, entity_id, entity_slug, entity_name, title, record_type, draft_text,
            status, created_at, updated_at, finalized_record_id
          `
        )
        .single();

      if (error) throw error;

      const updated = data as DraftRecord;
      setDrafts((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
      markLoadedSnapshot(updated.id, updated.title ?? "", updated.draft_text ?? "");
      flashInfo("Marked as reviewed.");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to mark as reviewed.";
      flashError(msg);
    } finally {
      setSaving(false);
    }
  }

  async function handleFinalize() {
    if (!selectedId || !selectedDraft) return flashError("Select a draft first.");
    if (!canMutateSelected) return flashError("This draft already left Alchemy.");
    if (!title.trim() || !body.trim()) return flashError("Title and body are required before finalizing.");
    if (selectedDraft.finalized_record_id) return flashError("This draft is already linked to a ledger record.");

    setFinalizing(true);
    setError(null);
    setInfo(null);

    try {
      const { data: entityRow, error: entityErr } = await supabase
        .from("entities")
        .select("id, name, slug")
        .eq("slug", activeEntity)
        .single();

      if (entityErr || !entityRow) throw entityErr ?? new Error("Entity not found.");

      const { data: ledgerRow, error: ledgerErr } = await supabase
        .from("governance_ledger")
        .insert({
          entity_id: entityRow.id as string,
          title: title.trim(),
          description: null,
          record_type: "resolution",
          record_no: null,
          body,
          source: "ci-alchemy",
          status: "PENDING",
        })
        .select("id")
        .single();

      if (ledgerErr || !ledgerRow) throw ledgerErr ?? new Error("Ledger insert failed.");

      const ledgerId = (ledgerRow as { id: string }).id;

      const { data: updatedDraft, error: draftErr } = await supabase
        .from("governance_drafts")
        .update({
          status: "finalized" as DraftStatus,
          finalized_record_id: ledgerId,
          finalized_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        } as unknown as Record<string, unknown>)
        .eq("id", selectedId)
        .select(
          `
            id, entity_id, entity_slug, entity_name, title, record_type, draft_text,
            status, created_at, updated_at, finalized_record_id
          `
        )
        .single();

      if (draftErr) throw draftErr;

      const updated = updatedDraft as DraftRecord;
      setDrafts((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
      markLoadedSnapshot(updated.id, updated.title ?? "", updated.draft_text ?? "");
      flashInfo("Finalized → Council queue.");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to finalize.";
      flashError(msg);
    } finally {
      setFinalizing(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Discard / Hard delete (Alchemy-only)
  // ---------------------------------------------------------------------------
  function openConfirm(mode: "discard" | "delete") {
    if (!selectedDraft || !selectedId) return flashError("Select a draft first.");
    if (!canMutateSelected) return flashError("Can’t remove a draft that already left Alchemy.");
    setConfirmMode(mode);
    setConfirmText("");
    setConfirmOpen(true);
  }

  async function performDiscardOrDelete() {
    if (!selectedDraft || !selectedId) return;
    if (!canMutateSelected) return;

    const required = confirmMode === "delete" ? "DELETE" : "DISCARD";
    if (confirmText.trim().toUpperCase() !== required) {
      flashError(`Type ${required} to confirm.`);
      return;
    }

    setConfirmBusy(true);
    setError(null);
    setInfo(null);

    try {
      if (confirmMode === "discard") {
        const { data, error } = await supabase
          .from("governance_drafts")
          .update({ status: "discarded" as DraftStatus, updated_at: new Date().toISOString() })
          .eq("id", selectedId)
          .select(
            `
              id, entity_id, entity_slug, entity_name, title, record_type, draft_text,
              status, created_at, updated_at, finalized_record_id
            `
          )
          .single();

        if (error) throw error;

        const updated = data as DraftRecord;
        setDrafts((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
        flashInfo("Draft discarded.");
        setConfirmOpen(false);
        return;
      }

      // Hard delete: SECURITY DEFINER RPC exists in prod (try common signatures safely)
      const tryTwo = await supabase.rpc("owner_delete_governance_draft", {
        p_draft_id: selectedId,
        p_reason: "Deleted in CI-Alchemy UI",
      } as unknown as Record<string, unknown>);

      if (tryTwo.error) {
        const tryOne = await supabase.rpc("owner_delete_governance_draft", {
          p_draft_id: selectedId,
        } as unknown as Record<string, unknown>);
        if (tryOne.error) throw tryOne.error;
      }

      const nextList = drafts.filter((d) => d.id !== selectedId);
      setDrafts(nextList);

      const next = pickDefaultSelection(nextList);
      if (next) {
        setSelectedId(next.id);
        setTitle(next.title ?? "");
        setBody(next.draft_text ?? "");
        markLoadedSnapshot(next.id, next.title ?? "", next.draft_text ?? "");
      } else {
        setSelectedId(null);
        setTitle("");
        setBody("");
        markLoadedSnapshot(null, "", "");
      }

      flashInfo("Draft permanently deleted.");
      setConfirmOpen(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Delete/discard failed.";
      flashError(msg);
    } finally {
      setConfirmBusy(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Editor dirty tracking
  // ---------------------------------------------------------------------------
  function onTitleChange(v: string) {
    setTitle(v);
    setDirty(computeDirty(v, body, selectedId));
  }
  function onBodyChange(v: string) {
    setBody(v);
    setDirty(computeDirty(title, v, selectedId));
  }

  // ---------------------------------------------------------------------------
  // UI theme classes
  // ---------------------------------------------------------------------------
  const editorShell = tone === "light"
    ? "bg-white text-slate-900 border-slate-200"
    : "bg-slate-950/70 text-slate-100 border-slate-800";

  const editorInput = tone === "light"
    ? "bg-white text-slate-900 border-slate-200 focus:border-emerald-500"
    : "bg-slate-900/80 text-slate-100 border-slate-700 focus:border-emerald-400";

  const editorTextarea = tone === "light"
    ? "bg-white text-slate-900 border-slate-200 focus:border-emerald-500"
    : "bg-slate-900/80 text-slate-100 border-slate-700 focus:border-emerald-400";

  return (
    <div className="h-[calc(100vh-80px)] w-full px-6 pb-6 pt-4 overflow-hidden text-slate-100">
      {/* Header row (tight, OS-like) */}
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold tracking-[0.24em] text-emerald-300">
            CI-ALCHEMY • GENESIS
          </div>
          <h1 className="mt-1 text-[22px] font-semibold tracking-wide text-slate-100">
            Drafting Console
          </h1>
          <div className="mt-1 text-[13px] text-slate-400">
            Entity: <span className="text-emerald-300 font-medium">{activeEntityLabel}</span>
            <span className="mx-2 text-slate-700">•</span>
            Finalize promotes to Council (ledger-linked & locked here).
          </div>
        </div>

        {/* Compact right controls */}
        <div className="hidden md:flex items-center gap-2">
          <button
            onClick={handleNewDraft}
            className="rounded-full border border-slate-800 bg-slate-950/70 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/70"
            title="New draft canvas"
          >
            New
          </button>

          <div className="rounded-full border border-slate-800 bg-slate-950/70 p-1">
            <button
              onClick={() => setTone("light")}
              className={cx(
                "rounded-full px-3 py-2 text-[10px] uppercase tracking-[0.18em] transition",
                tone === "light" ? "bg-slate-200 text-slate-950" : "text-slate-400 hover:bg-slate-900/70"
              )}
            >
              Paper
            </button>
            <button
              onClick={() => setTone("dark")}
              className={cx(
                "rounded-full px-3 py-2 text-[10px] uppercase tracking-[0.18em] transition",
                tone === "dark" ? "bg-emerald-500 text-slate-950" : "text-slate-400 hover:bg-slate-900/70"
              )}
            >
              Noir
            </button>
          </div>
        </div>
      </div>

      {/* OS Card (single surface, no page scroll) */}
      <div className="h-[calc(100%-72px)] w-full overflow-hidden rounded-[28px] border border-slate-800 bg-slate-950/55 shadow-2xl shadow-black/50">
        {/* Card top bar (OS feel) */}
        <div className="flex items-center justify-between gap-3 border-b border-slate-800 px-5 py-4">
          <div className="flex items-center gap-2 min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-400">
              Draft workspace
            </div>
            {dirty && (
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-[3px] text-[10px] uppercase tracking-[0.18em] text-amber-200">
                Unsaved
              </span>
            )}
            {selectedDraft && (
              <span
                className={cx(
                  "rounded-full border px-2 py-[3px] text-[10px] uppercase tracking-[0.18em]",
                  selectedDraft.status === "finalized"
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                    : selectedDraft.status === "reviewed"
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
                    : selectedDraft.status === "discarded"
                    ? "border-slate-700 bg-slate-900/50 text-slate-300"
                    : "border-sky-500/40 bg-sky-500/10 text-sky-200"
                )}
              >
                {selectedDraft.status}
              </span>
            )}
            {selectedDraft?.finalized_record_id && (
              <span className="rounded-full border border-slate-700 bg-slate-900/50 px-2 py-[3px] text-[10px] uppercase tracking-[0.18em] text-slate-300">
                Ledger-linked (locked)
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setReaderOpen(true)}
              disabled={!selectedDraft}
              className="rounded-full border border-slate-800 bg-slate-950/70 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/70 disabled:cursor-not-allowed disabled:text-slate-500"
              title="Open Reader overlay"
            >
              Open Reader
            </button>

            <button
              onClick={() => reloadDrafts(true)}
              className="rounded-full border border-slate-800 bg-slate-950/70 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/70"
              title="Refresh"
            >
              Sync
            </button>
          </div>
        </div>

        {/* Main grid (editor + side panel). No page scrolling; only inner panes scroll. */}
        <div className="flex h-[calc(100%-64px)] w-full overflow-hidden">
          {/* Editor zone (dominant) */}
          <div className="flex h-full flex-1 flex-col overflow-hidden p-5">
            <div className={cx("h-full w-full rounded-[22px] border overflow-hidden", editorShell)}>
              {/* Editor header */}
              <div className={cx("flex items-center justify-between gap-3 border-b px-4 py-3", tone === "light" ? "border-slate-200" : "border-slate-800")}>
                <div className="min-w-0">
                  <div className={cx("text-[11px] font-semibold uppercase tracking-[0.2em]", tone === "light" ? "text-slate-500" : "text-slate-400")}>
                    Resolution editor
                  </div>
                  <div className={cx("text-[11px]", tone === "light" ? "text-slate-500" : "text-slate-500")}>
                    {selectedDraft ? `Created ${fmtShort(selectedDraft.created_at)}` : "New draft"}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={handleRunAlchemy}
                    disabled={alchemyRunning || saving || finalizing}
                    className="rounded-full border border-emerald-500/60 bg-emerald-500/10 px-4 py-2 text-[11px] font-semibold tracking-[0.16em] uppercase text-emerald-200 hover:bg-emerald-500/15 disabled:cursor-not-allowed disabled:border-slate-300/30 disabled:text-slate-400"
                    title="Generate a first draft"
                  >
                    {alchemyRunning ? "Running…" : "Run Alchemy"}
                  </button>

                  <button
                    onClick={handleSaveDraft}
                    disabled={saving || finalizing || (selectedDraft ? !canMutateSelected : false)}
                    className={cx(
                      "rounded-full px-4 py-2 text-[11px] font-semibold tracking-[0.16em] uppercase transition disabled:cursor-not-allowed",
                      "bg-emerald-500 text-slate-950 hover:bg-emerald-400 disabled:bg-emerald-900/30 disabled:text-slate-400"
                    )}
                    title="Save draft"
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>

                  <button
                    onClick={handleMarkReviewed}
                    disabled={!selectedDraft || saving || finalizing || !canMutateSelected}
                    className={cx(
                      "rounded-full border px-4 py-2 text-[11px] font-semibold tracking-[0.16em] uppercase transition disabled:cursor-not-allowed",
                      "border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/15 disabled:border-slate-300/30 disabled:text-slate-400"
                    )}
                  >
                    Reviewed
                  </button>

                  <button
                    onClick={handleFinalize}
                    disabled={!selectedDraft || saving || finalizing || !canMutateSelected}
                    className={cx(
                      "rounded-full border px-4 py-2 text-[11px] font-semibold tracking-[0.16em] uppercase transition disabled:cursor-not-allowed",
                      "border-emerald-500/50 bg-transparent text-emerald-300 hover:bg-emerald-500/10 disabled:border-slate-300/30 disabled:text-slate-400"
                    )}
                    title="Finalize → governance_ledger (status=PENDING)"
                  >
                    {finalizing ? "Finalizing…" : "Finalize → Council"}
                  </button>
                </div>
              </div>

              {/* Title + Body */}
              <div className="flex h-[calc(100%-56px)] flex-col overflow-hidden">
                <div className={cx("px-4 pt-4", tone === "light" ? "bg-white" : "bg-transparent")}>
                  <input
                    value={title}
                    onChange={(e) => onTitleChange(e.target.value)}
                    placeholder="Resolution title"
                    disabled={selectedDraft ? !canMutateSelected : false}
                    className={cx(
                      "w-full rounded-2xl border px-4 py-3 text-[15px] outline-none transition",
                      editorInput,
                      (selectedDraft && !canMutateSelected) && "opacity-70 cursor-not-allowed"
                    )}
                  />
                </div>

                <div className="flex-1 px-4 pb-4 pt-3 overflow-hidden">
                  <textarea
                    value={body}
                    onChange={(e) => onBodyChange(e.target.value)}
                    placeholder="Draft body… (or run Alchemy)"
                    disabled={selectedDraft ? !canMutateSelected : false}
                    className={cx(
                      "h-full w-full resize-none rounded-2xl border px-4 py-4 text-[13px] leading-[1.75] outline-none transition",
                      editorTextarea,
                      (selectedDraft && !canMutateSelected) && "opacity-70 cursor-not-allowed"
                    )}
                  />
                </div>
              </div>
            </div>

            {/* Footer (OS-like actions row) */}
            <div className="mt-3 flex items-center justify-between gap-3 px-1">
              <div className="min-w-0 text-[12px] text-slate-400">
                {selectedDraft
                  ? (selectedDraft.finalized_record_id
                      ? "This draft is ledger-linked (locked in Alchemy)."
                      : "Drafts are editable + deletable until they leave Alchemy.")
                  : "Write a draft or run Alchemy to generate one."}
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => openConfirm("discard")}
                  disabled={!selectedDraft || !canMutateSelected || saving || finalizing}
                  className="rounded-full border border-slate-700 bg-slate-950/60 px-4 py-2 text-[11px] font-semibold tracking-[0.16em] uppercase text-slate-200 hover:bg-slate-900/60 disabled:cursor-not-allowed disabled:text-slate-500"
                  title="Soft remove (status=discarded)"
                >
                  Discard
                </button>

                <button
                  onClick={() => openConfirm("delete")}
                  disabled={!selectedDraft || !canMutateSelected || saving || finalizing}
                  className="rounded-full border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-[11px] font-semibold tracking-[0.16em] uppercase text-rose-200 hover:bg-rose-500/15 disabled:cursor-not-allowed disabled:text-slate-500"
                  title="Hard delete via SECURITY DEFINER RPC (Alchemy only)"
                >
                  Delete
                </button>
              </div>
            </div>

            {(error || info) && (
              <div className="mt-3">
                {error && (
                  <div className="rounded-2xl border border-rose-500/50 bg-rose-500/10 px-4 py-3 text-[12px] text-rose-200">
                    {error}
                  </div>
                )}
                {info && !error && (
                  <div className="rounded-2xl border border-emerald-500/50 bg-emerald-500/10 px-4 py-3 text-[12px] text-emerald-200">
                    {info}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Side panel: compact tabs (Drafts / AXIOM). No “taking over the page”. */}
          <div className="h-full w-[380px] shrink-0 border-l border-slate-800 bg-slate-950/50 overflow-hidden">
            {/* Tabs */}
            <div className="flex items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
              <div className="flex rounded-full border border-slate-800 bg-slate-950/70 p-1">
                <button
                  onClick={() => setSideTab("drafts")}
                  className={cx(
                    "rounded-full px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.18em] transition",
                    sideTab === "drafts"
                      ? "bg-emerald-500 text-slate-950"
                      : "text-slate-400 hover:bg-slate-900/70"
                  )}
                >
                  Drafts
                </button>
                <button
                  onClick={() => setSideTab("axiom")}
                  className={cx(
                    "rounded-full px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.18em] transition",
                    sideTab === "axiom"
                      ? "bg-slate-200 text-slate-950"
                      : "text-slate-400 hover:bg-slate-900/70"
                  )}
                >
                  AXIOM
                </button>
              </div>

              <div className="text-[11px] text-slate-500">
                {loading ? "…" : `${filteredDrafts.length}/${drafts.length}`}
              </div>
            </div>

            {/* Content */}
            {sideTab === "drafts" ? (
              <div className="flex h-[calc(100%-52px)] flex-col overflow-hidden p-4">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search drafts…"
                  className="mb-3 rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-[13px] text-slate-100 outline-none focus:border-emerald-400"
                />

                <div className="mb-3 flex gap-1 overflow-x-auto pb-1">
                  {(["draft", "reviewed", "finalized", "discarded", "all"] as StatusFilter[]).map((k) => (
                    <button
                      key={k}
                      onClick={() => setStatusFilter(k)}
                      className={cx(
                        "shrink-0 rounded-full px-3 py-2 text-[10px] uppercase tracking-[0.18em] transition",
                        statusFilter === k
                          ? "bg-emerald-500 text-slate-950"
                          : "bg-slate-900/70 text-slate-400 hover:bg-slate-800/70"
                      )}
                    >
                      {k}
                    </button>
                  ))}
                </div>

                <div className="flex-1 overflow-y-auto rounded-2xl border border-slate-800 bg-slate-950/55">
                  {loading ? (
                    <div className="p-4 text-[13px] text-slate-400">Loading…</div>
                  ) : filteredDrafts.length === 0 ? (
                    <div className="p-4 text-[13px] text-slate-500">No drafts for this filter.</div>
                  ) : (
                    <ul className="divide-y divide-slate-800">
                      {filteredDrafts.map((d) => (
                        <li
                          key={d.id}
                          onClick={() => handleSelectDraft(d)}
                          className={cx(
                            "cursor-pointer px-4 py-3 transition hover:bg-slate-800/60",
                            d.id === selectedId && "bg-slate-800/80"
                          )}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-[13px] font-semibold text-slate-100">
                                {d.title || "(untitled)"}
                              </div>
                              <div className="mt-1 text-[11px] text-slate-500">
                                {fmtShort(d.created_at)} • {d.record_type || "resolution"}
                              </div>
                              <div className="mt-2 line-clamp-2 text-[12px] leading-relaxed text-slate-400">
                                {d.draft_text}
                              </div>
                            </div>

                            <span
                              className={cx(
                                "shrink-0 rounded-full px-2 py-1 text-[9px] uppercase tracking-[0.18em]",
                                d.status === "finalized"
                                  ? "bg-emerald-500/15 text-emerald-200"
                                  : d.status === "reviewed"
                                  ? "bg-amber-500/15 text-amber-200"
                                  : d.status === "discarded"
                                  ? "bg-slate-700/40 text-slate-300"
                                  : "bg-sky-500/15 text-sky-200"
                              )}
                            >
                              {d.status}
                            </span>
                          </div>

                          {d.finalized_record_id && (
                            <div className="mt-2 rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-[11px] text-slate-400">
                              Ledger-linked (locked)
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="mt-3 flex items-center justify-between gap-2">
                  <button
                    onClick={handleNewDraft}
                    className="rounded-full border border-slate-800 bg-slate-950/70 px-4 py-2 text-[11px] font-semibold tracking-[0.16em] uppercase text-slate-200 hover:bg-slate-900/70"
                  >
                    New
                  </button>

                  <button
                    onClick={() => setReaderOpen(true)}
                    disabled={!selectedDraft}
                    className="rounded-full border border-slate-800 bg-slate-950/70 px-4 py-2 text-[11px] font-semibold tracking-[0.16em] uppercase text-slate-200 hover:bg-slate-900/70 disabled:cursor-not-allowed disabled:text-slate-500"
                  >
                    Reader
                  </button>
                </div>
              </div>
            ) : (
              <div className="h-[calc(100%-52px)] overflow-hidden p-4">
                <div className="h-full rounded-2xl border border-slate-800 bg-slate-950/55 p-4 overflow-hidden">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                    AXIOM Advisory
                  </div>

                  <div className="mt-3 text-[13px] leading-relaxed text-slate-300">
                    Advisory only (non-blocking). Clarity checks, missing clauses, risk flags,
                    ISO-aligned phrasing suggestions.
                  </div>

                  <div className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[12px] text-amber-200">
                    Authority remains Evidence-Bound.
                  </div>

                  <div className="mt-4 text-[12px] text-slate-400">
                    (Next step: wire real advisory output to your AI tables/views — but UI stays non-blocking.)
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Reader Overlay (CI-Archive style: opens when you want it, not always eating space) */}
      {readerOpen && (
        <div className="fixed inset-0 z-[80] bg-black/70 p-6">
          <div className="mx-auto flex h-full max-w-[1100px] flex-col overflow-hidden rounded-[28px] border border-slate-800 bg-slate-950 shadow-2xl shadow-black/60">
            <div className="flex items-center justify-between gap-3 border-b border-slate-800 px-5 py-4">
              <div className="min-w-0">
                <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                  Reader
                </div>
                <div className="mt-1 truncate text-[16px] font-semibold text-slate-100">
                  {selectedDraft?.title || title || "(untitled)"}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className="rounded-full border border-slate-800 bg-slate-950/70 p-1">
                  <button
                    onClick={() => setReaderTone("light")}
                    className={cx(
                      "rounded-full px-3 py-2 text-[10px] uppercase tracking-[0.18em] transition",
                      readerTone === "light" ? "bg-slate-200 text-slate-950" : "text-slate-400 hover:bg-slate-900/70"
                    )}
                  >
                    Paper
                  </button>
                  <button
                    onClick={() => setReaderTone("dark")}
                    className={cx(
                      "rounded-full px-3 py-2 text-[10px] uppercase tracking-[0.18em] transition",
                      readerTone === "dark" ? "bg-emerald-500 text-slate-950" : "text-slate-400 hover:bg-slate-900/70"
                    )}
                  >
                    Noir
                  </button>
                </div>

                <button
                  onClick={() => setReaderOpen(false)}
                  className="rounded-full border border-slate-800 bg-slate-950/70 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/70"
                >
                  Close
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-hidden p-5">
              <div
                className={cx(
                  "h-full overflow-y-auto rounded-[22px] border p-6",
                  readerTone === "light"
                    ? "border-slate-200 bg-white text-slate-900"
                    : "border-slate-800 bg-slate-950 text-slate-100"
                )}
              >
                <div className={cx("text-[12px] uppercase tracking-[0.18em]", readerTone === "light" ? "text-slate-500" : "text-slate-400")}>
                  {selectedDraft?.record_type || "resolution"} • {fmtShort(selectedDraft?.created_at ?? null)}
                </div>

                <h2 className={cx("mt-2 text-[20px] font-semibold", readerTone === "light" ? "text-slate-900" : "text-slate-100")}>
                  {selectedDraft?.title || title || "(untitled)"}
                </h2>

                <div className={cx("mt-5 whitespace-pre-wrap text-[14px] leading-[1.85]", readerTone === "light" ? "text-slate-800" : "text-slate-200")}>
                  {selectedDraft ? (selectedDraft.draft_text || "") : (body || "")}
                </div>
              </div>
            </div>

            <div className="border-t border-slate-800 px-5 py-4 text-[12px] text-slate-400">
              Finalize promotes to Council queue. Ledger-linked drafts remain immutable inside Alchemy.
            </div>
          </div>
        </div>
      )}

      {/* Confirm modal (Discard / Delete) */}
      {confirmOpen && selectedDraft && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-6">
          <div className="w-full max-w-[620px] overflow-hidden rounded-[28px] border border-slate-800 bg-slate-950 shadow-2xl shadow-black/60">
            <div className="border-b border-slate-800 px-6 py-5">
              <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                Confirm {confirmMode === "delete" ? "Hard Delete" : "Discard"}
              </div>
              <div className="mt-2 text-[18px] font-semibold text-slate-100">
                {selectedDraft.title || "(untitled)"}
              </div>
              <div className="mt-2 text-[13px] text-slate-400">
                {confirmMode === "delete"
                  ? "Permanent removal (Alchemy-only). This does not delete governance_ledger."
                  : "Soft remove: marks this draft as discarded (kept for audit / recovery)."}
              </div>
            </div>

            <div className="px-6 py-5">
              <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                <div className="text-[12px] text-slate-300">
                  Type{" "}
                  <span className={cx("font-semibold", confirmMode === "delete" ? "text-rose-200" : "text-slate-100")}>
                    {confirmMode === "delete" ? "DELETE" : "DISCARD"}
                  </span>{" "}
                  to confirm.
                </div>
                <input
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  className="mt-3 w-full rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-[13px] text-slate-100 outline-none focus:border-emerald-400"
                  placeholder={confirmMode === "delete" ? "DELETE" : "DISCARD"}
                  disabled={confirmBusy}
                />

                <div className="mt-4 flex items-center justify-end gap-2">
                  <button
                    onClick={() => setConfirmOpen(false)}
                    disabled={confirmBusy}
                    className="rounded-full border border-slate-800 bg-slate-950/70 px-5 py-3 text-[12px] font-semibold tracking-[0.16em] uppercase text-slate-200 hover:bg-slate-900/70 disabled:opacity-50"
                  >
                    Cancel
                  </button>

                  <button
                    onClick={performDiscardOrDelete}
                    disabled={confirmBusy}
                    className={cx(
                      "rounded-full px-5 py-3 text-[12px] font-semibold tracking-[0.16em] uppercase transition disabled:opacity-50",
                      confirmMode === "delete"
                        ? "border border-rose-500/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/15"
                        : "border border-slate-700 bg-slate-950/60 text-slate-100 hover:bg-slate-900/60"
                    )}
                  >
                    {confirmBusy ? (confirmMode === "delete" ? "Deleting…" : "Discarding…") : (confirmMode === "delete" ? "Hard Delete" : "Discard")}
                  </button>
                </div>
              </div>

              {!canMutateSelected && (
                <div className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-200">
                  This draft is ledger-linked (left Alchemy). It can’t be discarded or deleted here.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
