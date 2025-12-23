// src/app/(os)/ci-alchemy/page.tsx
"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";

type DraftStatus = "draft" | "reviewed" | "finalized" | "discarded";

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

type StatusFilter = "all" | "draft" | "reviewed" | "finalized" | "discarded";

const ENTITY_LABELS: Record<string, string> = {
  holdings: "Oasis International Holdings Inc.",
  lounge: "Oasis International Lounge Inc.",
  "real-estate": "Oasis International Real Estate Inc.",
};

type ConfirmMode = "discard" | "delete";
type EditorTheme = "dark" | "light";

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

  // core state
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [alchemyRunning, setAlchemyRunning] = useState(false);

  const [drafts, setDrafts] = useState<DraftRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  // OS feel: keep page locked, use panels (drawers/modals) instead of stacking columns
  const [registryOpen, setRegistryOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("draft");
  const [query, setQuery] = useState("");

  const [theme, setTheme] = useState<EditorTheme>("light");

  // toasts
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // confirm modal
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmMode, setConfirmMode] = useState<ConfirmMode>("discard");
  const [confirmText, setConfirmText] = useState("");
  const [confirmReason, setConfirmReason] = useState("");
  const [confirmBusy, setConfirmBusy] = useState(false);

  // dirty guard
  const [dirty, setDirty] = useState(false);
  const snapRef = useRef<{ id: string | null; title: string; body: string } | null>(null);

  const activeEntityLabel = useMemo(
    () => ENTITY_LABELS[activeEntity] ?? activeEntity,
    [activeEntity]
  );

  const selectedDraft = useMemo(
    () => drafts.find((d) => d.id === selectedId) ?? null,
    [drafts, selectedId]
  );

  const canMutateSelected = useMemo(() => {
    if (!selectedDraft) return true; // new/unsaved draft in editor
    // once ledger-linked, Alchemy must not mutate/delete
    return !selectedDraft.finalized_record_id && selectedDraft.status !== "finalized";
  }, [selectedDraft]);

  const filteredDrafts = useMemo(() => {
    let list = drafts;

    if (statusFilter !== "all") list = list.filter((d) => d.status === statusFilter);

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
    setTimeout(() => setInfo(null), 3800);
  }

  function markSnapshot(id: string | null, t: string, b: string) {
    snapRef.current = { id, title: t, body: b };
    setDirty(false);
  }

  function computeDirty(nextTitle: string, nextBody: string, nextId: string | null) {
    const s = snapRef.current;
    if (!s) return false;
    if (s.id !== nextId) return false;
    return s.title !== nextTitle || s.body !== nextBody;
  }

  function confirmLoseEdits() {
    if (!dirty) return true;
    return window.confirm("You have unsaved edits. Continue and lose changes?");
  }

  function pickDefaultSelection(data: DraftRecord[]) {
    if (!data || data.length === 0) return null;
    const preferred =
      data.find((d) => d.status === "draft" && !d.finalized_record_id) ||
      data.find((d) => d.status === "reviewed" && !d.finalized_record_id) ||
      data.find((d) => !d.finalized_record_id && d.status !== "discarded") ||
      data[0];
    return preferred ?? null;
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
        const still = rows.find((r) => r.id === selectedId);
        if (still) {
          setTitle(still.title ?? "");
          setBody(still.draft_text ?? "");
          markSnapshot(still.id, still.title ?? "", still.draft_text ?? "");
          return;
        }
      }

      const chosen = pickDefaultSelection(rows);
      if (chosen) {
        setSelectedId(chosen.id);
        setTitle(chosen.title ?? "");
        setBody(chosen.draft_text ?? "");
        markSnapshot(chosen.id, chosen.title ?? "", chosen.draft_text ?? "");
      } else {
        setSelectedId(null);
        setTitle("");
        setBody("");
        markSnapshot(null, "", "");
      }
    } catch (err: any) {
      flashError(err?.message ?? "Failed to load drafts");
    } finally {
      setLoading(false);
    }
  }

  // initial load per entity
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      setRegistryOpen(false);
      setPreviewOpen(false);
      setStatusFilter("draft");
      setQuery("");
      await reloadDrafts(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEntity]);

  function handleSelectDraft(d: DraftRecord) {
    if (!confirmLoseEdits()) return;
    setSelectedId(d.id);
    setTitle(d.title ?? "");
    setBody(d.draft_text ?? "");
    setInfo(null);
    setError(null);
    markSnapshot(d.id, d.title ?? "", d.draft_text ?? "");
    setRegistryOpen(false);
  }

  function handleNewDraft() {
    if (!confirmLoseEdits()) return;
    setSelectedId(null);
    setTitle("");
    setBody("");
    setInfo(null);
    setError(null);
    markSnapshot(null, "", "");
  }

  // Editor changes
  function onTitle(v: string) {
    setTitle(v);
    setDirty(computeDirty(v, body, selectedId));
  }
  function onBody(v: string) {
    setBody(v);
    setDirty(computeDirty(title, v, selectedId));
  }

  // Run CI-Alchemy (Edge Function "scribe")
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
        flashError("Not authenticated. OS auth gate required.");
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

      const data = (await res.json()) as any;
      if (!data?.ok) {
        flashError(`CI-Alchemy failed: ${data?.error || data?.stage || "Unknown error"}`);
        return;
      }

      const draftText: string = data.draft_text || data.draft || data.content || data.text || "";
      if (!draftText?.trim()) {
        flashError("CI-Alchemy returned no usable draft body.");
        return;
      }

      // optimistic
      const newDraft: DraftRecord = {
        id: data.draft_id || crypto.randomUUID(),
        entity_id: data.entity_id ?? null,
        entity_slug: data.entity_slug ?? activeEntity,
        entity_name: data.entity_name ?? activeEntityLabel,
        title: data.title || title.trim() || "(untitled)",
        record_type: data.record_type || "resolution",
        draft_text: draftText,
        status: (data.draft_status || "draft") as DraftStatus,
        created_at: data.draft_created_at ?? new Date().toISOString(),
        updated_at: null,
        finalized_record_id: data.finalized_record_id ?? null,
      };

      setSelectedId(newDraft.id);
      setTitle(newDraft.title);
      setBody(newDraft.draft_text);

      setDrafts((prev) => {
        const without = prev.filter((d) => d.id !== newDraft.id);
        return [newDraft, ...without];
      });

      markSnapshot(newDraft.id, newDraft.title, newDraft.draft_text);

      flashInfo("Draft created. Review, edit, then Save.");
      await reloadDrafts(true);
    } catch (err: any) {
      console.error("scribe invoke exception", err);
      flashError(err?.message ?? "Network error calling CI-Alchemy (scribe).");
    } finally {
      setAlchemyRunning(false);
    }
  }

  // Save draft
  async function handleSaveDraft() {
    if (!title.trim() || !body.trim()) {
      flashError("Title and body are required to save a draft.");
      return;
    }
    if (selectedDraft && !canMutateSelected) {
      flashError("This draft has left Alchemy (ledger-linked). It’s locked here.");
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
            id, entity_id, entity_slug, entity_name, title, record_type,
            draft_text, status, created_at, updated_at, finalized_record_id
          `
          )
          .single();

        if (error) throw error;

        const newDraft = data as DraftRecord;
        setDrafts((prev) => [newDraft, ...prev]);
        setSelectedId(newDraft.id);
        markSnapshot(newDraft.id, newDraft.title ?? "", newDraft.draft_text ?? "");
        flashInfo("Draft created.");
      } else {
        const { data, error } = await supabase
          .from("governance_drafts")
          .update({ ...basePayload, updated_at: new Date().toISOString() })
          .eq("id", selectedId)
          .select(
            `
            id, entity_id, entity_slug, entity_name, title, record_type,
            draft_text, status, created_at, updated_at, finalized_record_id
          `
          )
          .single();

        if (error) throw error;

        const updated = data as DraftRecord;
        setDrafts((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
        markSnapshot(updated.id, updated.title ?? "", updated.draft_text ?? "");
        flashInfo("Draft saved.");
      }
    } catch (err: any) {
      flashError(err?.message ?? "Failed to save draft.");
    } finally {
      setSaving(false);
    }
  }

  async function handleMarkReviewed() {
    if (!selectedId || !selectedDraft) return flashError("Select a draft first.");
    if (!canMutateSelected) return flashError("This draft left Alchemy and can’t be changed here.");
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
          id, entity_id, entity_slug, entity_name, title, record_type,
          draft_text, status, created_at, updated_at, finalized_record_id
        `
        )
        .single();

      if (error) throw error;

      const updated = data as DraftRecord;
      setDrafts((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
      markSnapshot(updated.id, updated.title ?? "", updated.draft_text ?? "");
      flashInfo("Marked as reviewed.");
    } catch (err: any) {
      flashError(err?.message ?? "Failed to mark as reviewed.");
    } finally {
      setSaving(false);
    }
  }

  async function handleFinalize() {
    if (!selectedId || !selectedDraft) return flashError("Select a draft first.");
    if (!title.trim() || !body.trim()) return flashError("Title and body are required before finalizing.");
    if (!canMutateSelected) return flashError("This draft is ledger-linked / locked.");
    if (selectedDraft.finalized_record_id) return flashError("Already linked to a ledger record.");

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
        } as any)
        .eq("id", selectedId)
        .select(
          `
          id, entity_id, entity_slug, entity_name, title, record_type,
          draft_text, status, created_at, updated_at, finalized_record_id
        `
        )
        .single();

      if (draftErr) throw draftErr;

      const updated = updatedDraft as DraftRecord;
      setDrafts((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
      markSnapshot(updated.id, updated.title ?? "", updated.draft_text ?? "");
      flashInfo("Finalized → Council queue.");
    } catch (err: any) {
      flashError(err?.message ?? "Failed to finalize.");
    } finally {
      setFinalizing(false);
    }
  }

  // discard / delete UI
  function openConfirm(mode: ConfirmMode) {
    if (!selectedDraft || !selectedId) return flashError("Select a draft first.");
    if (!canMutateSelected) return flashError("Can’t remove a draft that already left Alchemy.");
    setConfirmMode(mode);
    setConfirmText("");
    setConfirmReason("");
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
          .update({
            status: "discarded" as DraftStatus,
            updated_at: new Date().toISOString(),
            discard_reason: confirmReason || null,
            discarded_at: new Date().toISOString(),
          } as any)
          .eq("id", selectedId)
          .select(
            `
            id, entity_id, entity_slug, entity_name, title, record_type,
            draft_text, status, created_at, updated_at, finalized_record_id
          `
          )
          .single();

        if (error) throw error;

        const updated = data as DraftRecord;
        setDrafts((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
        setConfirmOpen(false);
        flashInfo("Draft discarded.");
        return;
      }

      // HARD DELETE: SECURITY DEFINER (existing in prod)
      const tryTwo = await supabase.rpc("owner_delete_governance_draft", {
        p_draft_id: selectedId,
        p_reason: confirmReason || null,
      } as any);

      if (tryTwo.error) {
        const tryOne = await supabase.rpc("owner_delete_governance_draft", {
          p_draft_id: selectedId,
        } as any);
        if (tryOne.error) {
          const tryAlt = await supabase.rpc("owner_delete_governance_draft", {
            draft_id: selectedId,
            reason: confirmReason || null,
          } as any);
          if (tryAlt.error) throw tryAlt.error;
        }
      }

      setDrafts((prev) => {
        const nextList = prev.filter((d) => d.id !== selectedId);
        const next = pickDefaultSelection(nextList);

        if (next) {
          setSelectedId(next.id);
          setTitle(next.title ?? "");
          setBody(next.draft_text ?? "");
          markSnapshot(next.id, next.title ?? "", next.draft_text ?? "");
        } else {
          setSelectedId(null);
          setTitle("");
          setBody("");
          markSnapshot(null, "", "");
        }

        return nextList;
      });

      setConfirmOpen(false);
      flashInfo("Draft permanently deleted.");
    } catch (err: any) {
      flashError(err?.message ?? "Delete/discard failed.");
    } finally {
      setConfirmBusy(false);
    }
  }

  const editorShell = useMemo(() => {
    const isLight = theme === "light";
    return {
      card: cx(
        "rounded-3xl border shadow-[0_0_60px_rgba(15,23,42,0.9)] overflow-hidden",
        isLight ? "border-slate-200 bg-white/95" : "border-slate-900 bg-black/60"
      ),
      input: cx(
        "w-full rounded-2xl border px-4 py-3 text-[15px] outline-none transition",
        isLight
          ? "border-slate-200 bg-white text-slate-900 placeholder:text-slate-400 focus:border-emerald-400"
          : "border-slate-700 bg-slate-900/80 text-slate-100 placeholder:text-slate-500 focus:border-emerald-400"
      ),
      textarea: cx(
        "h-full w-full resize-none rounded-2xl border px-4 py-4 text-[13px] leading-[1.65] outline-none transition",
        isLight
          ? "border-slate-200 bg-white text-slate-900 focus:border-emerald-400"
          : "border-slate-700 bg-slate-900/80 text-slate-100 focus:border-emerald-400"
      ),
      subtle: isLight ? "text-slate-500" : "text-slate-400",
      heading: isLight ? "text-slate-900" : "text-slate-50",
      panel: cx(
        "rounded-2xl border p-4",
        isLight ? "border-slate-200 bg-white" : "border-slate-800 bg-slate-950/40"
      ),
    };
  }, [theme]);

  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      {/* Header under OS bar */}
      <div className="mb-4 shrink-0 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-xs tracking-[0.3em] uppercase text-slate-500">CI-Alchemy</div>
          <h1 className="mt-1 text-xl font-semibold text-slate-50">
            Drafting Console · Evidence-Bound
          </h1>
          <p className="mt-1 text-xs text-slate-400 max-w-3xl">
            Draft safely. <span className="text-emerald-300 font-semibold">Finalize</span> promotes into
            Council (governance_ledger status=PENDING). Ledger-linked drafts are locked here.
          </p>
        </div>

        <div className="hidden md:flex items-end gap-2">
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Active entity</div>
            <div className="text-xs font-semibold text-slate-200">{activeEntityLabel}</div>
          </div>
        </div>
      </div>

      {/* Main OS window frame */}
      <div className="flex-1 min-h-0 flex justify-center overflow-hidden">
        <div className="w-full max-w-[1500px] h-full rounded-3xl border border-slate-900 bg-black/60 shadow-[0_0_60px_rgba(15,23,42,0.9)] px-6 py-5 flex flex-col overflow-hidden">
          {/* Top bar (tabs + controls) */}
          <div className="shrink-0 mb-4 flex items-center justify-between gap-3">
            <div className="inline-flex rounded-full bg-slate-950/70 border border-slate-800 p-1">
              <TopPill
                label="Drafts"
                description="Registry"
                active={registryOpen}
                onClick={() => setRegistryOpen(true)}
              />
              <TopPill
                label="Preview"
                description="Reader"
                active={previewOpen}
                onClick={() => setPreviewOpen(true)}
              />
              <TopPill
                label="AXIOM"
                description="Advisory"
                active={false}
                onClick={() => flashInfo("AXIOM advisory is read-only here (non-blocking).")}
              />
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleNewDraft}
                className="rounded-full px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase border border-slate-700 bg-slate-950/40 text-slate-200 hover:bg-slate-900/60 transition"
              >
                New
              </button>

              <button
                type="button"
                onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
                className="rounded-full px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase border border-slate-700 bg-slate-950/40 text-slate-200 hover:bg-slate-900/60 transition"
                title="Toggle editor paper mode"
              >
                {theme === "light" ? "Paper: ON" : "Paper: OFF"}
              </button>

              <button
                type="button"
                onClick={() => reloadDrafts(true)}
                className="rounded-full px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase border border-slate-700 bg-slate-950/40 text-slate-200 hover:bg-slate-900/60 transition"
              >
                Refresh
              </button>
            </div>
          </div>

          {/* Content area (single contained card; no “freelancer columns”) */}
          <div className="flex-1 min-h-0 overflow-hidden">
            <div className={cx("h-full w-full px-6 py-5 flex flex-col", editorShell.card)}>
              {/* status strip */}
              <div className="shrink-0 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className={cx("text-[11px] font-semibold uppercase tracking-[0.18em]", editorShell.subtle)}>
                    Editor
                    {dirty && (
                      <span className="ml-2 inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-[2px] text-[9px] uppercase tracking-[0.18em] text-amber-600">
                        Unsaved
                      </span>
                    )}
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {selectedDraft ? (
                      <>
                        <span
                          className={cx(
                            "rounded-full px-3 py-[6px] text-[10px] uppercase tracking-[0.18em] border",
                            selectedDraft.status === "finalized"
                              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600"
                              : selectedDraft.status === "reviewed"
                              ? "border-amber-500/40 bg-amber-500/10 text-amber-600"
                              : selectedDraft.status === "discarded"
                              ? "border-slate-300 bg-slate-100 text-slate-600"
                              : "border-sky-500/40 bg-sky-500/10 text-sky-600"
                          )}
                        >
                          {selectedDraft.status}
                        </span>

                        <span className={cx("text-[11px]", editorShell.subtle)}>
                          {fmtShort(selectedDraft.created_at)}
                        </span>

                        {selectedDraft.finalized_record_id && (
                          <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-[6px] text-[10px] uppercase tracking-[0.18em] text-emerald-600">
                            Ledger-linked (locked)
                          </span>
                        )}
                      </>
                    ) : (
                      <span className={cx("text-[11px]", editorShell.subtle)}>
                        New draft (not saved yet)
                      </span>
                    )}
                  </div>
                </div>

                {/* right micro panel (AXIOM advisory shell) */}
                <div className="hidden lg:block w-[380px] shrink-0">
                  <div className={editorShell.panel}>
                    <div className={cx("text-[11px] font-semibold uppercase tracking-[0.18em]", editorShell.subtle)}>
                      AXIOM Advisory (non-blocking)
                    </div>
                    <div className={cx("mt-2 text-[13px] leading-relaxed", theme === "light" ? "text-slate-700" : "text-slate-300")}>
                      Clarity checks, missing clauses, risk flags — advisory only. Authority remains evidence-bound.
                    </div>
                    <div className={cx("mt-3 rounded-xl border px-3 py-2 text-[12px]", theme === "light"
                      ? "border-amber-200 bg-amber-50 text-amber-700"
                      : "border-amber-500/30 bg-amber-500/10 text-amber-200"
                    )}>
                      Council is the gate. Forge is signature-only execution.
                    </div>
                  </div>
                </div>
              </div>

              {/* title */}
              <div className="shrink-0 mt-4">
                <input
                  className={editorShell.input}
                  placeholder="Resolution title"
                  value={title}
                  onChange={(e) => onTitle(e.target.value)}
                  disabled={!canMutateSelected || saving || finalizing || alchemyRunning}
                />
              </div>

              {/* body */}
              <div className="flex-1 min-h-0 mt-3">
                <textarea
                  className={editorShell.textarea}
                  placeholder="Draft body… (or Run Alchemy)"
                  value={body}
                  onChange={(e) => onBody(e.target.value)}
                  disabled={!canMutateSelected || saving || finalizing || alchemyRunning}
                />
              </div>

              {/* actions */}
              <div className="shrink-0 mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handleRunAlchemy}
                  disabled={alchemyRunning || saving || finalizing}
                  className={cx(
                    "rounded-full px-5 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition",
                    "border border-emerald-400/70 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/15",
                    (alchemyRunning || saving || finalizing) && "opacity-60 cursor-not-allowed"
                  )}
                >
                  {alchemyRunning ? "Running…" : "Run Alchemy"}
                </button>

                <button
                  type="button"
                  onClick={handleSaveDraft}
                  disabled={saving || finalizing || !canMutateSelected}
                  className={cx(
                    "rounded-full px-5 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition",
                    "bg-emerald-500 text-black hover:bg-emerald-400",
                    (saving || finalizing || !canMutateSelected) && "opacity-60 cursor-not-allowed"
                  )}
                >
                  {saving ? "Saving…" : "Save"}
                </button>

                <button
                  type="button"
                  onClick={handleMarkReviewed}
                  disabled={!selectedDraft || saving || finalizing || !canMutateSelected}
                  className={cx(
                    "rounded-full px-5 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition",
                    "border border-amber-400/60 bg-transparent text-amber-700 hover:bg-amber-500/10",
                    (!selectedDraft || saving || finalizing || !canMutateSelected) && "opacity-60 cursor-not-allowed"
                  )}
                >
                  Mark reviewed
                </button>

                <button
                  type="button"
                  onClick={handleFinalize}
                  disabled={!selectedDraft || saving || finalizing || !canMutateSelected}
                  className={cx(
                    "rounded-full px-5 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition",
                    "border border-emerald-500/60 bg-transparent text-emerald-700 hover:bg-emerald-500/10",
                    (!selectedDraft || saving || finalizing || !canMutateSelected) && "opacity-60 cursor-not-allowed"
                  )}
                >
                  {finalizing ? "Finalizing…" : "Finalize → Council"}
                </button>

                <div className="flex-1" />

                <button
                  type="button"
                  onClick={() => openConfirm("discard")}
                  disabled={!selectedDraft || saving || finalizing || !canMutateSelected}
                  className={cx(
                    "rounded-full px-5 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition",
                    "border border-slate-300 bg-transparent text-slate-700 hover:bg-slate-100",
                    (!selectedDraft || saving || finalizing || !canMutateSelected) && "opacity-60 cursor-not-allowed"
                  )}
                  title="Soft remove (marks discarded)"
                >
                  Discard
                </button>

                <button
                  type="button"
                  onClick={() => openConfirm("delete")}
                  disabled={!selectedDraft || saving || finalizing || !canMutateSelected}
                  className={cx(
                    "rounded-full px-5 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition",
                    "border border-red-300 bg-red-500/10 text-red-700 hover:bg-red-500/15",
                    (!selectedDraft || saving || finalizing || !canMutateSelected) && "opacity-60 cursor-not-allowed"
                  )}
                  title="Hard delete (SECURITY DEFINER)"
                >
                  Delete
                </button>
              </div>

              {(error || info) && (
                <div className="shrink-0 mt-4">
                  {error && (
                    <div className="rounded-2xl border border-red-300 bg-red-50 px-4 py-3 text-[13px] text-red-700">
                      {error}
                    </div>
                  )}
                  {info && !error && (
                    <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-700">
                      {info}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Footer strip */}
          <div className="mt-4 text-[10px] text-slate-500 flex items-center justify-between">
            <span>CI-Alchemy · Draft Factory (writes governance_drafts)</span>
            <span>Finalize → governance_ledger(PENDING) → Council decides execution mode</span>
          </div>
        </div>
      </div>

      {/* Registry Drawer */}
      {registryOpen && (
        <div className="fixed inset-0 z-[70] flex justify-end bg-black/60">
          <div className="h-full w-full max-w-[560px] bg-slate-950/95 border-l border-slate-800 shadow-2xl overflow-hidden flex flex-col">
            <div className="shrink-0 p-5 border-b border-slate-800 flex items-start justify-between gap-3">
              <div>
                <div className="text-[11px] uppercase tracking-[0.22em] text-slate-400">Draft Registry</div>
                <div className="mt-1 text-sm font-semibold text-slate-100">
                  {activeEntityLabel}
                </div>
                <div className="mt-1 text-[12px] text-slate-400">
                  Select a draft to load it into the editor.
                </div>
              </div>
              <button
                type="button"
                onClick={() => setRegistryOpen(false)}
                className="rounded-full border border-slate-700 bg-slate-900/40 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-800/60 transition"
              >
                Close
              </button>
            </div>

            <div className="p-5 border-b border-slate-800">
              <div className="flex gap-2">
                <input
                  className="flex-1 rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-[13px] text-slate-100 outline-none focus:border-emerald-400"
                  placeholder="Search drafts…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => reloadDrafts(true)}
                  className="rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60 transition"
                >
                  Sync
                </button>
              </div>

              <div className="mt-3 flex flex-wrap gap-1">
                {(["draft", "reviewed", "finalized", "discarded", "all"] as StatusFilter[]).map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setStatusFilter(key)}
                    className={cx(
                      "rounded-full px-3 py-2 text-[10px] uppercase tracking-[0.18em] transition",
                      statusFilter === key
                        ? "bg-emerald-500 text-black"
                        : "bg-slate-900/60 text-slate-300 hover:bg-slate-800/70"
                    )}
                  >
                    {key}
                  </button>
                ))}
              </div>

              <div className="mt-3 text-[11px] text-slate-500">
                {filteredDrafts.length}/{drafts.length}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto">
              {loading ? (
                <div className="p-5 text-[13px] text-slate-400">Loading…</div>
              ) : filteredDrafts.length === 0 ? (
                <div className="p-5 text-[13px] text-slate-500">No drafts for this filter.</div>
              ) : (
                <ul className="divide-y divide-slate-800">
                  {filteredDrafts.map((d) => (
                    <li
                      key={d.id}
                      onClick={() => handleSelectDraft(d)}
                      className={cx(
                        "cursor-pointer px-5 py-4 transition hover:bg-slate-900/60",
                        d.id === selectedId && "bg-slate-900/70"
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-semibold text-slate-100">
                            {d.title || "(untitled)"}
                          </div>
                          <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
                            <span>{fmtShort(d.created_at)}</span>
                            <span className="w-1 h-1 rounded-full bg-slate-700" />
                            <span className="uppercase tracking-[0.16em]">{d.record_type || "resolution"}</span>
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
                        <div className="mt-3 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-200">
                          Ledger-linked · locked in Alchemy
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="shrink-0 p-4 border-t border-slate-800 text-[10px] text-slate-500 flex items-center justify-between">
              <span>Registry Drawer · OS-native</span>
              <span>Close to return to editor</span>
            </div>
          </div>
        </div>
      )}

      {/* Preview Reader Modal */}
      {previewOpen && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-6">
          <div className="w-full max-w-[980px] h-[85vh] rounded-3xl border border-slate-800 bg-slate-950/95 shadow-2xl overflow-hidden flex flex-col">
            <div className="shrink-0 px-6 py-4 border-b border-slate-800 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-[0.22em] text-slate-400">Reader</div>
                <div className="mt-1 text-sm font-semibold text-slate-100 truncate">
                  {selectedDraft ? (title || selectedDraft.title || "(untitled)") : "No draft selected"}
                </div>
                <div className="mt-1 text-[11px] text-slate-500">
                  {selectedDraft ? `${selectedDraft.record_type || "resolution"} · ${fmtShort(selectedDraft.created_at)}` : "Open registry and select a draft"}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPreviewOpen(false)}
                className="rounded-full border border-slate-700 bg-slate-900/40 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-800/60 transition"
              >
                Close
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              {selectedDraft ? (
                <div className="rounded-2xl border border-slate-800 bg-black/40 p-6">
                  <pre className="whitespace-pre-wrap font-sans text-[13px] leading-[1.75] text-slate-100">
                    {(body || selectedDraft.draft_text || "").trim()}
                  </pre>
                </div>
              ) : (
                <div className="text-[13px] text-slate-400">
                  Select a draft first (Drafts → choose one), then open Preview.
                </div>
              )}
            </div>

            <div className="shrink-0 px-6 py-4 border-t border-slate-800 text-[10px] text-slate-500 flex items-center justify-between">
              <span>Reader is a view-only overlay (breathing room)</span>
              <span>Finalize promotes to Council queue</span>
            </div>
          </div>
        </div>
      )}

      {/* Confirm modal (Discard/Delete) */}
      {confirmOpen && selectedDraft && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-6">
          <div className="w-full max-w-[620px] rounded-3xl border border-slate-800 bg-slate-950/95 shadow-2xl overflow-hidden">
            <div className="p-6 border-b border-slate-800">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                Confirm {confirmMode === "delete" ? "Hard Delete" : "Discard"}
              </div>
              <div className="mt-2 text-[18px] font-semibold text-slate-100">
                {selectedDraft.title || "(untitled)"}
              </div>
              <div className="mt-2 text-[13px] text-slate-400 leading-relaxed">
                {confirmMode === "delete"
                  ? "Permanent removal. Allowed only while the draft is still in Alchemy."
                  : "Soft remove: marks this draft as discarded (kept for audit / recovery)."}
              </div>
              {!canMutateSelected && (
                <div className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-200">
                  This draft is ledger-linked (left Alchemy). It can’t be discarded or deleted here.
                </div>
              )}
            </div>

            <div className="p-6 space-y-4">
              <div>
                <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500 mb-2">
                  Reason (optional)
                </div>
                <textarea
                  className="w-full min-h-[90px] rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-[13px] text-slate-100 outline-none focus:border-emerald-400 resize-none"
                  value={confirmReason}
                  onChange={(e) => setConfirmReason(e.target.value)}
                  placeholder="e.g., duplicate / wrong entity / test run / invalid attempt…"
                  disabled={confirmBusy}
                />
              </div>

              <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                <div className="text-[12px] text-slate-300">
                  Type{" "}
                  <span className={cx("font-semibold", confirmMode === "delete" ? "text-red-200" : "text-slate-100")}>
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
              </div>

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmOpen(false)}
                  disabled={confirmBusy}
                  className="rounded-full border border-slate-700 bg-slate-900/50 px-5 py-3 text-[13px] font-semibold text-slate-200 hover:bg-slate-800/60 disabled:opacity-50"
                >
                  Cancel
                </button>

                <button
                  type="button"
                  onClick={performDiscardOrDelete}
                  disabled={confirmBusy || !canMutateSelected}
                  className={cx(
                    "rounded-full px-5 py-3 text-[13px] font-semibold transition disabled:opacity-50",
                    confirmMode === "delete"
                      ? "border border-red-500/50 bg-red-500/15 text-red-200 hover:bg-red-500/20"
                      : "border border-slate-600/60 bg-slate-900/60 text-slate-100 hover:bg-slate-800/60"
                  )}
                >
                  {confirmBusy
                    ? confirmMode === "delete"
                      ? "Deleting…"
                      : "Discarding…"
                    : confirmMode === "delete"
                    ? "Hard Delete"
                    : "Discard Draft"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

type TopPillProps = {
  label: string;
  description: string;
  active: boolean;
  onClick: () => void;
};

function TopPill({ label, description, active, onClick }: TopPillProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "px-4 py-2 rounded-full text-left transition min-w-[150px]",
        active
          ? "bg-emerald-500/15 border border-emerald-400/70 text-slate-50"
          : "bg-transparent border border-transparent hover:bg-slate-900/60 text-slate-300",
      ].join(" ")}
    >
      <div className="text-xs font-semibold">{label}</div>
      <div className="text-[10px] text-slate-400">{description}</div>
    </button>
  );
}
