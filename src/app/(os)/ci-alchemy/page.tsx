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

type StatusFilter = "all" | "draft" | "reviewed" | "finalized";

const ENTITY_LABELS: Record<string, string> = {
  holdings: "Oasis International Holdings Inc.",
  lounge: "Oasis International Lounge Inc.",
  "real-estate": "Oasis International Real Estate Inc.",
};

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

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const activeEntityLabel = useMemo(
    () => ENTITY_LABELS[activeEntity] ?? activeEntity,
    [activeEntity]
  );

  const selectedDraft = useMemo(
    () => drafts.find((d) => d.id === selectedId) ?? null,
    [drafts, selectedId]
  );

  const filteredDrafts = useMemo(() => {
    if (statusFilter === "all") return drafts;
    return drafts.filter((d) => d.status === statusFilter);
  }, [drafts, statusFilter]);

  function flashError(msg: string) {
    console.error(msg);
    setError(msg);
    setTimeout(() => setError(null), 6000);
  }

  function flashInfo(msg: string) {
    setInfo(msg);
    setTimeout(() => setInfo(null), 4000);
  }

  // ---------------------------------------------------------------------------
  // Load drafts for the active entity
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      setSelectedId(null);
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
        if (cancelled) return;

        setDrafts((data ?? []) as DraftRecord[]);

        if (data && data.length > 0) {
          const first = data[0] as DraftRecord;
          setSelectedId(first.id);
          setTitle(first.title ?? "");
          setBody(first.draft_text ?? "");
        } else {
          setSelectedId(null);
          setTitle("");
          setBody("");
        }
      } catch (err: any) {
        flashError(err.message ?? "Failed to load drafts");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [activeEntity]);

  function handleSelectDraft(draft: DraftRecord) {
    setSelectedId(draft.id);
    setTitle(draft.title ?? "");
    setBody(draft.draft_text ?? "");
    setInfo(null);
    setError(null);
  }

  // ---------------------------------------------------------------------------
  // Run CI-Alchemy (Edge Function "scribe") via direct fetch
  // ---------------------------------------------------------------------------
  async function handleRunAlchemy() {
    if (!title.trim() && !body.trim()) {
      flashError(
        "Add at least a title or some body/context before running CI-Alchemy."
      );
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
      const hasBody = body.trim().length > 0;

      const instructions = hasBody
        ? body.trim()
        : `Draft a formal corporate resolution for ${activeEntityLabel} about: "${
            title.trim() || "a governance matter"
          }".
Include WHEREAS recitals, clear RESOLVED clauses, and a signing block for directors.`;

      const payload = {
        type: "board_resolution", // matches scribe's type mapping
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
          Authorization: `Bearer ${anonKey}`, // required by Supabase edge gateway
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const text = await res.text();
        console.error("scribe HTTP error", res.status, text);
        flashError(
          `CI-Alchemy HTTP ${res.status}. Check console for details.`
        );
        return;
      }

      const data = await res.json();
      console.log("scribe response", data);

      if (!data || typeof data !== "object") {
        flashError("Unexpected response from CI-Alchemy (scribe).");
        return;
      }

      const asAny = data as any;

      if (!asAny.ok) {
        const detail = asAny.error || asAny.stage || "Unknown error.";
        flashError(`CI-Alchemy failed: ${detail}`);
        return;
      }

      const draftId: string | undefined = asAny.draft_id;
      const draftText: string =
        asAny.draft_text || asAny.draft || asAny.content || asAny.text || "";

      if (!draftText || draftText.trim().length === 0) {
        flashError(
          "CI-Alchemy responded but did not include a usable draft body."
        );
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

      // Update editor with AI draft
      setTitle(newDraft.title);
      setBody(newDraft.draft_text);

      // Select this draft
      setSelectedId(newDraft.id);

      // Merge into list (dedupe by id)
      setDrafts((prev) => {
        const without = prev.filter((d) => d.id !== newDraft.id);
        return [newDraft, ...without];
      });

      flashInfo(
        "CI-Alchemy draft created and saved. Review or edit, then Save if you change anything."
      );
    } catch (err: any) {
      console.error("scribe invoke exception", err);
      flashError(
        err?.message ??
          "Unexpected network error while calling CI-Alchemy (scribe)."
      );
    } finally {
      setAlchemyRunning(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Save / status actions
  // ---------------------------------------------------------------------------
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

      if (entityErr || !entityRow)
        throw entityErr ?? new Error("Entity not found.");

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
        setDrafts((prev) =>
          prev.map((d) => (d.id === updated.id ? updated : d))
        );
        flashInfo("Draft saved.");
      }
    } catch (err: any) {
      flashError(err.message ?? "Failed to save draft.");
    } finally {
      setSaving(false);
    }
  }

  async function handleMarkReviewed() {
    if (!selectedId) {
      flashError("Select a draft first.");
      return;
    }

    const draft = drafts.find((d) => d.id === selectedId);
    if (!draft) {
      flashError("Draft not found in local state.");
      return;
    }

    if (draft.status === "reviewed") {
      flashInfo("Already marked as reviewed.");
      return;
    }
    if (draft.status === "finalized") {
      flashInfo("Already finalized; cannot go back to reviewed.");
      return;
    }

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
      setDrafts((prev) =>
        prev.map((d) => (d.id === updated.id ? updated : d))
      );
      flashInfo("Draft marked as reviewed.");
    } catch (err: any) {
      flashError(err.message ?? "Failed to mark as reviewed.");
    } finally {
      setSaving(false);
    }
  }

  async function handleFinalize() {
    if (!selectedId) {
      flashError("Select a draft first.");
      return;
    }

    const draft = drafts.find((d) => d.id === selectedId);
    if (!draft) {
      flashError("Draft not found in local state.");
      return;
    }

    if (!title.trim() || !body.trim()) {
      flashError("Title and body are required before finalizing.");
      return;
    }

    if (draft.status === "finalized") {
      flashInfo("Draft already finalized.");
      return;
    }

    setFinalizing(true);
    setError(null);
    setInfo(null);

    try {
      const { data: entityRow, error: entityErr } = await supabase
        .from("entities")
        .select("id, name, slug")
        .eq("slug", activeEntity)
        .single();

      if (entityErr || !entityRow)
        throw entityErr ?? new Error("Entity not found.");

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
          status: "PENDING", // CI-Council queue
        })
        .select("id")
        .single();

      console.log("🔎 governance_ledger insert result:", { ledgerRow, ledgerErr });

      if (ledgerErr || !ledgerRow) {
        console.error("❌ LEDGER INSERT FAILED:", ledgerErr);
        throw ledgerErr ?? new Error("Ledger insert failed with no details.");
      }

      const ledgerId = (ledgerRow as { id: string }).id;

      const { data: updatedDraft, error: draftErr } = await supabase
        .from("governance_drafts")
        .update({
          status: "finalized" as DraftStatus,
          finalized_record_id: ledgerId,
          finalized_at: new Date().toISOString(),
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

      if (draftErr) throw draftErr;

      const updated = updatedDraft as DraftRecord;
      setDrafts((prev) =>
        prev.map((d) => (d.id === updated.id ? updated : d))
      );

      flashInfo("Finalized and sent into governance ledger / council queue.");
    } catch (err: any) {
      flashError(
        err.message ??
          "Failed to finalize. (Check constraint or RLS may be blocking the insert.)"
      );
    } finally {
      setFinalizing(false);
    }
  }

  // ---------------------------------------------------------------------------
  // RENDER
  // ---------------------------------------------------------------------------
  return (
    <div className="flex h-[calc(100vh-80px)] w-full flex-col px-6 pb-6 pt-4 text-slate-100 overflow-hidden">
      {/* Header */}
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <div>
          <div className="text-xs font-semibold tracking-[0.2em] text-emerald-300">
            CI-ALCHEMY • LIVE
          </div>
          <h1 className="text-xl font-semibold tracking-wide">
            AI Scribe — Governance Drafting Console
          </h1>
          <p className="mt-1 text-xs text-slate-400">
            Left: run CI-Alchemy, edit &amp; save drafts for{" "}
            <span className="text-emerald-300">{activeEntityLabel}</span>. Right:
            queue &amp; preview feeding CI-Council / CI-Forge and the governance
            ledger.
          </p>
        </div>

        <div className="hidden text-right text-xs text-slate-400 md:block">
          <div>Active entity</div>
          <div className="font-medium text-slate-200">{activeEntityLabel}</div>
        </div>
      </div>

      {/* Main layout */}
      <div className="flex flex-1 gap-4 overflow-hidden">
        {/* LEFT: Editor */}
        <div className="flex h-full w-[60%] flex-col rounded-2xl bg-slate-950/70 p-4 shadow-lg shadow-black/40">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-400">
              Draft editor
            </div>
            {selectedDraft && (
              <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">
                Status:{" "}
                <span
                  className={
                    selectedDraft.status === "finalized"
                      ? "text-emerald-300"
                      : selectedDraft.status === "reviewed"
                      ? "text-amber-300"
                      : "text-sky-300"
                  }
                >
                  {selectedDraft.status}
                </span>
              </div>
            )}
          </div>

          {/* Title */}
          <input
            className="mb-3 rounded-xl border border-slate-700 bg-slate-900/80 px-3 py-2 text-sm outline-none ring-0 transition focus:border-emerald-400"
            placeholder="Resolution title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />

          {/* Body */}
          <div className="relative flex-1 overflow-hidden">
            <textarea
              className="h-full w-full resize-none rounded-xl border border-slate-700 bg-slate-900/80 px-3 py-3 text-xs leading-relaxed text-slate-100 outline-none ring-0 focus:border-emerald-400"
              placeholder="Draft body… (or run CI-Alchemy to generate a first draft)"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>

          {/* Buttons */}
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <button
              onClick={handleRunAlchemy}
              disabled={alchemyRunning || saving || finalizing}
              className="inline-flex flex-[1.1] items-center justify-center rounded-full border border-emerald-400/80 bg-emerald-500/10 px-4 py-2 font-semibold text-emerald-200 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:border-slate-700 disabled:text-slate-500"
            >
              {alchemyRunning ? "Running CI-Alchemy…" : "Run Alchemy (AI draft)"}
            </button>

            <button
              onClick={handleSaveDraft}
              disabled={saving || finalizing}
              className="inline-flex flex-1 items-center justify-center rounded-full bg-emerald-500 px-4 py-2 font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-emerald-900/60"
            >
              {saving ? "Saving…" : "Save draft"}
            </button>

            <button
              onClick={handleMarkReviewed}
              disabled={
                !selectedDraft ||
                saving ||
                finalizing ||
                selectedDraft?.status === "finalized"
              }
              className="inline-flex flex-[0.8] items-center justify-center rounded-full border border-amber-400/70 bg-slate-900/80 px-4 py-2 font-semibold text-amber-200 transition hover:bg-amber-500/10 disabled:cursor-not-allowed disabled:border-slate-700 disabled:text-slate-500"
            >
              Mark as reviewed
            </button>

            <button
              onClick={handleFinalize}
              disabled={
                !selectedDraft ||
                saving ||
                finalizing ||
                selectedDraft?.status === "finalized"
              }
              className="inline-flex flex-[1.1] items-center justify-center rounded-full border border-emerald-500/70 bg-slate-950 px-4 py-2 font-semibold text-emerald-300 transition hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:border-slate-700 disabled:text-slate-500"
            >
              {finalizing ? "Finalizing…" : "Finalize → Ledger / Council"}
            </button>
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
        </div>

        {/* RIGHT: Queue + Preview */}
        <div className="flex h-full w-[40%] flex-col gap-3 overflow-hidden">
          {/* Queue */}
          <div className="flex h-[40%] flex-col rounded-2xl bg-slate-950/70 p-4 shadow-lg shadow-black/40 overflow-hidden">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-400">
                Recent drafts
              </div>
              <div className="flex flex-wrap gap-1 text-[10px]">
                {(["all", "draft", "reviewed", "finalized"] as StatusFilter[]).map(
                  (key) => (
                    <button
                      key={key}
                      onClick={() => setStatusFilter(key)}
                      className={`rounded-full px-2 py-1 uppercase tracking-[0.16em] ${
                        statusFilter === key
                          ? "bg-emerald-500 text-slate-950"
                          : "bg-slate-900/80 text-slate-400 hover:bg-slate-800"
                      }`}
                    >
                      {key}
                    </button>
                  )
                )}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto rounded-xl border border-slate-800 bg-slate-950/60">
              {loading ? (
                <div className="p-3 text-xs text-slate-400">Loading drafts…</div>
              ) : filteredDrafts.length === 0 ? (
                <div className="p-3 text-xs text-slate-500">
                  No drafts yet for this entity. Run CI-Alchemy or write and save
                  your first draft on the left.
                </div>
              ) : (
                <ul className="divide-y divide-slate-800 text-xs">
                  {filteredDrafts.map((d) => (
                    <li
                      key={d.id}
                      onClick={() => handleSelectDraft(d)}
                      className={`cursor-pointer px-3 py-2 transition hover:bg-slate-800/70 ${
                        d.id === selectedId ? "bg-slate-800/90" : ""
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0 flex-1 font-medium text-slate-100">
                          <span className="block truncate">
                            {d.title || "(untitled)"}
                          </span>
                        </div>
                        <span
                          className={`shrink-0 rounded-full px-2 py-[2px] text-[9px] uppercase tracking-[0.18em] ${
                            d.status === "finalized"
                              ? "bg-emerald-500/20 text-emerald-300"
                              : d.status === "reviewed"
                              ? "bg-amber-500/20 text-amber-300"
                              : "bg-sky-500/20 text-sky-300"
                          }`}
                        >
                          {d.status}
                        </span>
                      </div>
                      <div className="mt-1 line-clamp-1 text-[11px] text-slate-400">
                        {d.draft_text}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Preview */}
          <div className="flex h-[60%] flex-col rounded-2xl bg-slate-950/70 p-4 shadow-lg shadow-black/40 overflow-hidden">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-400">
                Preview
              </div>
              {selectedDraft && (
                <div className="text-[10px] text-slate-500">
                  {selectedDraft.record_type || "Resolution"}
                </div>
              )}
            </div>

            <div className="flex-1 overflow-y-auto rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-xs leading-relaxed">
              {selectedDraft ? (
                <>
                  <h2 className="mb-2 text-[13px] font-semibold text-slate-50">
                    {title || selectedDraft.title}
                  </h2>
                  <pre className="whitespace-pre-wrap font-sans text-[11px] text-slate-200">
                    {body || selectedDraft.draft_text}
                  </pre>
                </>
              ) : (
                <div className="text-[11px] text-slate-500">
                  Select a draft from the queue to preview it here.
                </div>
              )}
            </div>

            <div className="mt-2 text-[10px] text-slate-500">
              CI-Alchemy drafts live here until they are finalized into the{" "}
              <span className="text-emerald-300">governance ledger</span> and
              picked up by CI-Council / CI-Forge.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
