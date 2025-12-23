// src/app/(os)/ci-alchemy/page.tsx
"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
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

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export default function CIAlchemyPage() {
  const { activeEntity } = useEntity();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [alchemyRunning, setAlchemyRunning] = useState(false);

  const [drafts, setDrafts] = useState<DraftRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  // Default: don’t shove finalized clutter in your face
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("draft");
  const [query, setQuery] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Discard / Delete modal
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmMode, setConfirmMode] = useState<"discard" | "delete">("discard");
  const [confirmText, setConfirmText] = useState("");
  const [confirmBusy, setConfirmBusy] = useState(false);

  // Preview (Reader-style overlay) — replaces the always-on right column
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewTone, setPreviewTone] = useState<"evidence" | "reader">("evidence");

  const activeEntityLabel = useMemo(
    () => ENTITY_LABELS[activeEntity] ?? activeEntity,
    [activeEntity]
  );

  const selectedDraft = useMemo(
    () => drafts.find((d) => d.id === selectedId) ?? null,
    [drafts, selectedId]
  );

  const canMutateSelected = useMemo(() => {
    if (!selectedDraft) return false;
    // Once it left Alchemy (finalized -> Council/Ledger), Alchemy can’t mutate it.
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
    setTimeout(() => setError(null), 5000);
  }

  function flashInfo(msg: string) {
    setInfo(msg);
    setTimeout(() => setInfo(null), 3500);
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
        const stillThere = rows.find((r) => r.id === selectedId);
        if (stillThere) {
          setTitle(stillThere.title ?? "");
          setBody(stillThere.draft_text ?? "");
          return;
        }
      }

      const chosen = pickDefaultSelection(rows);
      if (chosen) {
        setSelectedId(chosen.id);
        setTitle(chosen.title ?? "");
        setBody(chosen.draft_text ?? "");
      } else {
        setSelectedId(null);
        setTitle("");
        setBody("");
      }
    } catch (err: any) {
      flashError(err?.message ?? "Failed to load drafts");
    } finally {
      setLoading(false);
    }
  }

  // Load drafts for the active entity
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
    setSelectedId(draft.id);
    setTitle(draft.title ?? "");
    setBody(draft.draft_text ?? "");
    setInfo(null);
    setError(null);
  }

  // Run CI-Alchemy (Edge Function "scribe") via direct fetch
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
      // Use signed-in user token for RLS/audit
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
        : `Draft a formal corporate resolution for ${activeEntityLabel} about: "${
            title.trim() || "a governance matter"
          }".
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

      const data = await res.json();
      const asAny = data as any;

      if (!asAny?.ok) {
        const detail = asAny?.error || asAny?.stage || "Unknown error.";
        flashError(`CI-Alchemy failed: ${detail}`);
        return;
      }

      const draftId: string | undefined = asAny.draft_id;
      const draftText: string =
        asAny.draft_text || asAny.draft || asAny.content || asAny.text || "";

      if (!draftText?.trim()) {
        flashError("CI-Alchemy returned no usable draft body.");
        return;
      }

      const newDraft: DraftRecord = {
        id: draftId || crypto.randomUUID(),
        entity_id: asAny.entity_id ?? null,
        entity_slug: asAny.entity_slug ?? activeEntity,
        entity_name: asAny.entity_name ?? activeEntityLabel,
        title: asAny.title || title.trim() || "(untitled)",
        record_type: asAny.record_type || "resolution",
        draft_text: draftText,
        status: (asAny.draft_status || "draft") as DraftStatus,
        created_at: asAny.draft_created_at ?? new Date().toISOString(),
        updated_at: null,
        finalized_record_id: asAny.finalized_record_id ?? null,
      };

      setTitle(newDraft.title);
      setBody(newDraft.draft_text);
      setSelectedId(newDraft.id);

      setDrafts((prev) => {
        const without = prev.filter((d) => d.id !== newDraft.id);
        return [newDraft, ...without];
      });

      flashInfo("Draft created. Review, edit, then Save.");

      // Re-sync list with DB truth
      await reloadDrafts(true);
    } catch (err: any) {
      console.error("scribe invoke exception", err);
      flashError(err?.message ?? "Network error calling CI-Alchemy (scribe).");
    } finally {
      setAlchemyRunning(false);
    }
  }

  async function handleSaveDraft() {
    if (!title.trim() || !body.trim()) {
      flashError("Title and body are required to save a draft.");
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
          .insert({
            ...basePayload,
            status: "draft" as DraftStatus,
          })
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
          .single();

        if (error) throw error;

        const newDraft = data as DraftRecord;
        setDrafts((prev) => [newDraft, ...prev]);
        setSelectedId(newDraft.id);
        flashInfo("Draft created.");
      } else {
        const { data, error } = await supabase
          .from("governance_drafts")
          .update({
            ...basePayload,
            updated_at: new Date().toISOString(),
          })
          .eq("id", selectedId)
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
          .single();

        if (error) throw error;

        const updated = data as DraftRecord;
        setDrafts((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
        flashInfo("Draft saved.");
      }
    } catch (err: any) {
      flashError(err?.message ?? "Failed to save draft.");
    } finally {
      setSaving(false);
    }
  }

  async function handleMarkReviewed() {
    if (!selectedId) return flashError("Select a draft first.");
    if (!canMutateSelected) return flashError("This draft has left Alchemy and can’t be changed here.");

    const draft = drafts.find((d) => d.id === selectedId);
    if (!draft) return flashError("Draft not found.");
    if (draft.status === "reviewed") return flashInfo("Already reviewed.");

    setSaving(true);
    setError(null);
    setInfo(null);

    try {
      const { data, error } = await supabase
        .from("governance_drafts")
        .update({
          status: "reviewed" as DraftStatus,
          updated_at: new Date().toISOString(),
        })
        .eq("id", selectedId)
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
        .single();

      if (error) throw error;

      const updated = data as DraftRecord;
      setDrafts((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
      flashInfo("Marked as reviewed.");
    } catch (err: any) {
      flashError(err?.message ?? "Failed to mark as reviewed.");
    } finally {
      setSaving(false);
    }
  }

  async function handleFinalize() {
    if (!selectedId) return flashError("Select a draft first.");

    const draft = drafts.find((d) => d.id === selectedId);
    if (!draft) return flashError("Draft not found.");

    if (!title.trim() || !body.trim()) return flashError("Title and body are required before finalizing.");
    if (draft.status === "finalized") return flashInfo("Already finalized.");
    if (draft.finalized_record_id) return flashError("This draft is already linked to a ledger record.");

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
        .single();

      if (draftErr) throw draftErr;

      const updated = updatedDraft as DraftRecord;
      setDrafts((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));

      flashInfo("Finalized → Council queue.");
    } catch (err: any) {
      flashError(err?.message ?? "Failed to finalize.");
    } finally {
      setFinalizing(false);
    }
  }

  // Discard / Delete (enterprise guardrails)
  function openConfirm(mode: "discard" | "delete") {
    if (!selectedDraft) return flashError("Select a draft first.");
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
          .update({
            status: "discarded" as DraftStatus,
            updated_at: new Date().toISOString(),
          } as any)
          .eq("id", selectedId)
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
          .single();

        if (error) throw error;

        const updated = data as DraftRecord;
        setDrafts((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
        flashInfo("Draft discarded.");
        setConfirmOpen(false);
        return;
      }

      // HARD DELETE: SECURITY DEFINER function (no ledger deletes)
      const tryA = await supabase.rpc("owner_delete_governance_draft", {
        p_draft_id: selectedId,
      } as any);

      if (tryA.error) throw tryA.error;

      setDrafts((prev) => {
        const nextList = prev.filter((d) => d.id !== selectedId);
        const next = pickDefaultSelection(nextList);

        if (next) {
          setSelectedId(next.id);
          setTitle(next.title ?? "");
          setBody(next.draft_text ?? "");
        } else {
          setSelectedId(null);
          setTitle("");
          setBody("");
        }

        return nextList;
      });

      flashInfo("Draft permanently deleted.");
      setConfirmOpen(false);
    } catch (err: any) {
      flashError(err?.message ?? "Delete/discard failed.");
    } finally {
      setConfirmBusy(false);
    }
  }

  const previewTitle = (title || selectedDraft?.title || "(untitled)").trim();
  const previewBody = (body || selectedDraft?.draft_text || "").trim();

  function openPreview() {
    if (!selectedDraft && !previewBody && !previewTitle) {
      flashError("Select a draft (or write something) before preview.");
      return;
    }
    setPreviewOpen(true);
  }

  return (
    <div className="flex h-[calc(100vh-80px)] w-full flex-col px-6 pb-6 pt-4 text-slate-100 overflow-hidden">
      {/* Header */}
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold tracking-[0.22em] text-emerald-300">
            CI-ALCHEMY • GENESIS
          </div>
          <h1 className="mt-1 text-[22px] font-semibold tracking-wide">Drafting Console</h1>
          <div className="mt-1 text-[13px] text-slate-400">
            Entity:{" "}
            <span className="text-emerald-300 font-medium">{activeEntityLabel}</span>
            <span className="mx-2 text-slate-700">•</span>
            Drafts here are editable + deletable until they leave Alchemy.
          </div>
        </div>

        {/* AXIOM shell (read-only) */}
        <div className="hidden md:block w-[360px] shrink-0">
          <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 shadow-lg shadow-black/40">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
              AXIOM Advisory
            </div>
            <div className="mt-2 text-[13px] text-slate-300 leading-relaxed">
              Draft support (non-blocking): clarity checks, risk flags, missing clauses.
            </div>
            <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200">
              Advisory only. Authority remains Evidence-Bound.
            </div>
          </div>
        </div>
      </div>

      {/* Main layout: 2 columns (OS registry feel + breathing room) */}
      <div className="flex flex-1 gap-4 overflow-hidden">
        {/* LEFT: Editor */}
        <div className="flex h-full w-[62%] flex-col rounded-2xl bg-slate-950/70 p-4 shadow-lg shadow-black/40 overflow-hidden">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
              Editor
            </div>

            <div className="flex items-center gap-2">
              {selectedDraft && (
                <>
                  <span
                    className={cx(
                      "rounded-full px-3 py-[6px] text-[10px] uppercase tracking-[0.18em] border",
                      selectedDraft.status === "finalized"
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                        : selectedDraft.status === "reviewed"
                        ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
                        : selectedDraft.status === "discarded"
                        ? "border-slate-600/50 bg-slate-800/40 text-slate-300"
                        : "border-sky-500/40 bg-sky-500/10 text-sky-200"
                    )}
                  >
                    {selectedDraft.status}
                  </span>

                  {!canMutateSelected && (
                    <span className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-[6px] text-[10px] uppercase tracking-[0.18em] text-slate-300">
                      Locked (left Alchemy)
                    </span>
                  )}
                </>
              )}

              {/* Preview opener (Reader-style) */}
              <button
                onClick={openPreview}
                className="rounded-full border border-slate-700 bg-slate-950 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60"
                title="Open Reader preview"
              >
                Preview
              </button>
            </div>
          </div>

          {/* Title */}
          <input
            className={cx(
              "mb-3 rounded-2xl border bg-slate-900/80 px-4 py-3 text-[15px] outline-none transition",
              !!selectedDraft && !canMutateSelected
                ? "border-slate-800 text-slate-400 cursor-not-allowed"
                : "border-slate-700 focus:border-emerald-400"
            )}
            placeholder="Resolution title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={!!selectedDraft && !canMutateSelected}
          />

          {/* Body */}
          <div className="relative flex-1 overflow-hidden">
            <textarea
              className={cx(
                "h-full w-full resize-none rounded-2xl border bg-slate-900/80 px-4 py-4 text-[13px] leading-[1.65] outline-none transition",
                !!selectedDraft && !canMutateSelected
                  ? "border-slate-800 text-slate-400 cursor-not-allowed"
                  : "border-slate-700 text-slate-100 focus:border-emerald-400"
              )}
              placeholder="Draft body… (or Run Alchemy)"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={!!selectedDraft && !canMutateSelected}
            />
          </div>

          {/* Actions */}
          <div className="mt-3 flex flex-wrap gap-2 text-[13px]">
            <button
              onClick={handleRunAlchemy}
              disabled={alchemyRunning || saving || finalizing}
              className="inline-flex items-center justify-center rounded-full border border-emerald-400/70 bg-emerald-500/10 px-5 py-3 font-semibold text-emerald-200 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:border-slate-700 disabled:text-slate-500"
            >
              {alchemyRunning ? "Running…" : "Run Alchemy"}
            </button>

            <button
              onClick={handleSaveDraft}
              disabled={saving || finalizing || (!!selectedDraft && !canMutateSelected)}
              className="inline-flex items-center justify-center rounded-full bg-emerald-500 px-5 py-3 font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-emerald-900/50"
            >
              {saving ? "Saving…" : "Save"}
            </button>

            <button
              onClick={handleMarkReviewed}
              disabled={!selectedDraft || saving || finalizing || !canMutateSelected}
              className="inline-flex items-center justify-center rounded-full border border-amber-400/60 bg-slate-900/70 px-5 py-3 font-semibold text-amber-200 transition hover:bg-amber-500/10 disabled:cursor-not-allowed disabled:border-slate-700 disabled:text-slate-500"
            >
              Mark reviewed
            </button>

            <button
              onClick={handleFinalize}
              disabled={!selectedDraft || saving || finalizing || !canMutateSelected}
              className="inline-flex items-center justify-center rounded-full border border-emerald-500/60 bg-slate-950 px-5 py-3 font-semibold text-emerald-300 transition hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:border-slate-700 disabled:text-slate-500"
            >
              {finalizing ? "Finalizing…" : "Finalize → Council"}
            </button>

            <div className="flex-1" />

            <button
              onClick={() => openConfirm("discard")}
              disabled={!selectedDraft || !canMutateSelected || saving || finalizing}
              className="inline-flex items-center justify-center rounded-full border border-slate-600/60 bg-slate-900/60 px-5 py-3 font-semibold text-slate-200 transition hover:bg-slate-800/60 disabled:cursor-not-allowed disabled:border-slate-800 disabled:text-slate-500"
              title="Soft remove (keeps row, marks discarded)"
            >
              Discard
            </button>

            <button
              onClick={() => openConfirm("delete")}
              disabled={!selectedDraft || !canMutateSelected || saving || finalizing}
              className="inline-flex items-center justify-center rounded-full border border-red-500/50 bg-red-500/10 px-5 py-3 font-semibold text-red-200 transition hover:bg-red-500/15 disabled:cursor-not-allowed disabled:border-slate-800 disabled:text-slate-500"
              title="Hard delete (permanent)"
            >
              Delete
            </button>
          </div>

          {(error || info) && (
            <div className="mt-3 text-[13px]">
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

          <div className="mt-3 text-[11px] text-slate-500">
            Preview opens as a Reader overlay (OS style) — no cramped right column.
          </div>
        </div>

        {/* RIGHT: Drafts registry */}
        <div className="flex h-full w-[38%] flex-col rounded-2xl bg-slate-950/70 p-4 shadow-lg shadow-black/40 overflow-hidden">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
              Drafts
            </div>
            <span className="text-[11px] text-slate-500">
              {filteredDrafts.length}/{drafts.length}
            </span>
          </div>

          <input
            className="mb-3 rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-[13px] outline-none focus:border-emerald-400"
            placeholder="Search drafts…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          <div className="mb-3 flex flex-wrap gap-1">
            {(["draft", "reviewed", "finalized", "discarded", "all"] as StatusFilter[]).map((key) => (
              <button
                key={key}
                onClick={() => setStatusFilter(key)}
                className={cx(
                  "rounded-full px-3 py-2 text-[10px] uppercase tracking-[0.18em] transition",
                  statusFilter === key
                    ? "bg-emerald-500 text-slate-950"
                    : "bg-slate-900/70 text-slate-400 hover:bg-slate-800/70"
                )}
              >
                {key}
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
                        <div className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-slate-400">
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
                        Linked to Ledger (locked)
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="mt-3 flex items-center justify-between text-[11px] text-slate-500">
            <span>OS Registry view — clean + scoped.</span>
            <button
              onClick={() => reloadDrafts(true)}
              className="rounded-full border border-slate-700 bg-slate-950 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-200 hover:bg-slate-900/60"
              title="Refresh list"
            >
              Refresh
            </button>
          </div>
        </div>
      </div>

      {/* Reader Preview Overlay */}
      {previewOpen && (
        <div className="fixed inset-0 z-[80] bg-black/65">
          <div className="absolute inset-0" onClick={() => setPreviewOpen(false)} />

          <div className="absolute left-1/2 top-1/2 w-[min(1100px,92vw)] h-[min(86vh,860px)] -translate-x-1/2 -translate-y-1/2">
            <div className="h-full rounded-3xl border border-slate-800 bg-slate-950/95 shadow-2xl shadow-black/60 overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between gap-3 border-b border-slate-800 px-6 py-4">
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">
                    Reader • Preview
                  </div>
                  <div className="mt-1 truncate text-[16px] font-semibold text-slate-100">
                    {previewTitle || "(untitled)"}
                  </div>
                  <div className="mt-1 text-[12px] text-slate-400">
                    {selectedDraft?.record_type || "resolution"}
                    <span className="mx-2 text-slate-700">•</span>
                    {selectedDraft?.finalized_record_id ? (
                      <span className="text-emerald-300">ledger-linked (locked)</span>
                    ) : (
                      <span className="text-slate-300">draft (editable)</span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {/* Tone toggle (optional, OS-style) */}
                  <div className="hidden sm:flex rounded-full border border-slate-800 bg-slate-950/60 p-1 text-[10px] uppercase tracking-[0.18em]">
                    <button
                      onClick={() => setPreviewTone("evidence")}
                      className={cx(
                        "rounded-full px-3 py-1 transition",
                        previewTone === "evidence"
                          ? "bg-emerald-500 text-slate-950"
                          : "text-slate-400 hover:bg-slate-900/60"
                      )}
                    >
                      Evidence
                    </button>
                    <button
                      onClick={() => setPreviewTone("reader")}
                      className={cx(
                        "rounded-full px-3 py-1 transition",
                        previewTone === "reader"
                          ? "bg-slate-200 text-slate-950"
                          : "text-slate-400 hover:bg-slate-900/60"
                      )}
                    >
                      Reader
                    </button>
                  </div>

                  <button
                    onClick={() => setPreviewOpen(false)}
                    className="rounded-full border border-slate-700 bg-slate-950 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-200 hover:bg-slate-900/60"
                  >
                    Close
                  </button>
                </div>
              </div>

              {/* Body */}
              <div className="h-[calc(100%-64px)] px-6 py-5 overflow-y-auto">
                <div
                  className={cx(
                    "rounded-3xl border bg-slate-950/60 px-6 py-6",
                    previewTone === "evidence"
                      ? "border-emerald-500/20"
                      : "border-slate-800"
                  )}
                >
                  {/* “Reader breathing room” typography */}
                  <div className="text-[12px] uppercase tracking-[0.22em] text-slate-500">
                    Document body
                  </div>
                  <div className="mt-4 whitespace-pre-wrap text-[13px] leading-[1.85] text-slate-100">
                    {previewBody || "—"}
                  </div>
                </div>

                <div className="mt-4 text-[11px] text-slate-500">
                  Preview is non-mutating. Save/Finalize happens in the editor panel.
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Confirm modal (Discard/Delete) */}
      {confirmOpen && selectedDraft && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-6">
          <div className="w-full max-w-[560px] rounded-3xl border border-slate-800 bg-slate-950/95 shadow-2xl shadow-black/60">
            <div className="p-6">
              <div className="flex items-start justify-between gap-3">
                <div>
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
                </div>

                <button
                  onClick={() => setConfirmOpen(false)}
                  disabled={confirmBusy}
                  className="rounded-full border border-slate-700 bg-slate-900/60 px-4 py-2 text-[12px] text-slate-200 hover:bg-slate-800/60 disabled:opacity-50"
                >
                  Close
                </button>
              </div>

              <div className="mt-5 rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                <div className="text-[12px] text-slate-300">
                  Type{" "}
                  <span
                    className={cx(
                      "font-semibold",
                      confirmMode === "delete" ? "text-red-200" : "text-slate-100"
                    )}
                  >
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
                    className="rounded-full border border-slate-700 bg-slate-900/60 px-5 py-3 text-[13px] font-semibold text-slate-200 hover:bg-slate-800/60 disabled:opacity-50"
                  >
                    Cancel
                  </button>

                  <button
                    onClick={performDiscardOrDelete}
                    disabled={confirmBusy}
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

              {!canMutateSelected && (
                <div className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-200">
                  This draft is linked to the Ledger (left Alchemy). It can’t be discarded or deleted here.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
