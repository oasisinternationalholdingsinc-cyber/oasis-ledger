// src/app/(os)/ci-alchemy/page.tsx
"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";

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

  // optional env field (safe)
  is_test?: boolean | null;
};

type StatusTab = "draft" | "reviewed" | "finalized" | "discarded" | "all";
type DeleteMode = "soft" | "hard";
type WorkspaceTab = "editor" | "axiom";

type AxiomNote = {
  id: string;
  scope_id: string;
  scope_type: string;
  note_type: string;
  title: string | null;
  body: string | null;
  metadata: any | null;
  created_at: string | null;
  created_by: string | null;
};

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

function safeJsonParse(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export default function CIAlchemyPage() {
  const entityCtx = useEntity() as any;
  const osEnv = useOsEnv();

  // IMPORTANT: entitySlug is ALWAYS holdings/lounge/real-estate (never "sandbox")
  const activeEntity = (entityCtx?.activeEntity as string) || "holdings";
  const activeEntityLabel = useMemo(
    () => ENTITY_LABELS[activeEntity] ?? activeEntity,
    [activeEntity]
  );

  // Lane flag (must match Council)
  const isSandbox = !!osEnv.isSandbox;
  const env = isSandbox ? "SANDBOX" : "ROT";

  // Core state
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [alchemyRunning, setAlchemyRunning] = useState(false);
  const [axiomRunning, setAxiomRunning] = useState(false);

  const [drafts, setDrafts] = useState<DraftRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  // OS UX controls
  const [statusTab, setStatusTab] = useState<StatusTab>("draft");
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("editor");
  const [query, setQuery] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [readerOpen, setReaderOpen] = useState(false);
  const [editorTheme, setEditorTheme] = useState<"light" | "dark">("light");

  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Delete modal
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteMode, setDeleteMode] = useState<DeleteMode>("soft");
  const [deleteReason, setDeleteReason] = useState("");
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);

  // AXIOM panel state (draft-stage = ai_notes only)
  const [axiomLoading, setAxiomLoading] = useState(false);
  const [axiomNotes, setAxiomNotes] = useState<AxiomNote[]>([]);
  const [axiomLastRefreshedAt, setAxiomLastRefreshedAt] = useState<string | null>(null);
  const [axiomError, setAxiomError] = useState<string | null>(null);

  // Unsaved changes guard
  const [dirty, setDirty] = useState(false);
  const lastLoadedRef = useRef<{ id: string | null; title: string; body: string } | null>(null);

  const selectedDraft = useMemo(
    () => drafts.find((d) => d.id === selectedId) ?? null,
    [drafts, selectedId]
  );

  // Mutations allowed only while still inside Alchemy (not finalized / not ledger-linked)
  const canMutateSelected = useMemo(() => {
    if (!selectedDraft) return true;
    return !selectedDraft.finalized_record_id && selectedDraft.status !== "finalized";
  }, [selectedDraft]);

  function flashError(msg: string) {
    console.error(msg);
    setError(msg);
    setTimeout(() => setError(null), 7000);
  }

  function flashInfo(msg: string) {
    setInfo(msg);
    setTimeout(() => setInfo(null), 3500);
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
    const preferred =
      rows.find((d) => d.status === "draft" && !d.finalized_record_id) ||
      rows.find((d) => d.status === "reviewed" && !d.finalized_record_id) ||
      rows.find((d) => !d.finalized_record_id && d.status !== "discarded") ||
      rows[0];
    return preferred ?? null;
  }

  async function reloadDrafts(preserveSelected = true) {
    setLoading(true);
    setError(null);

    // STRICT lane query.
    // We ONLY fall back if the is_test column truly does not exist.
    // (No silent mixing of ROT+SANDBOX ever.)
    const tryWithIsTest = async () => {
      const q = supabase
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
            finalized_record_id,
            is_test
          `
        )
        .eq("entity_slug", activeEntity)
        .eq("is_test", isSandbox)
        .order("created_at", { ascending: false });

      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as DraftRecord[];
    };

    const tryWithoutIsTest = async () => {
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
      return (data ?? []) as DraftRecord[];
    };

    try {
      let rows: DraftRecord[] = [];
      try {
        rows = await tryWithIsTest();
      } catch (e: any) {
        if (isMissingColumnErr(e)) {
          rows = await tryWithoutIsTest();
        } else {
          throw e;
        }
      }

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
    } catch (err: any) {
      flashError(err?.message ?? "Failed to load drafts");
    } finally {
      setLoading(false);
    }
  }

  // CRITICAL: env + entity must re-scope Alchemy registry
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      setStatusTab("draft");
      setWorkspaceTab("editor");
      setQuery("");
      setAxiomNotes([]);
      setAxiomError(null);
      setAxiomLastRefreshedAt(null);
      await reloadDrafts(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEntity, isSandbox]);

  function handleSelectDraft(draft: DraftRecord) {
    if (!confirmNavigateAwayIfDirty()) return;

    setSelectedId(draft.id);
    setTitle(draft.title ?? "");
    setBody(draft.draft_text ?? "");
    setInfo(null);
    setError(null);
    setAxiomError(null);
    markLoadedSnapshot(draft.id, draft.title ?? "", draft.draft_text ?? "");
  }

  function handleNewDraft() {
    if (!confirmNavigateAwayIfDirty()) return;

    setSelectedId(null);
    setTitle("");
    setBody("");
    setInfo(null);
    setError(null);
    setAxiomNotes([]);
    setAxiomError(null);
    setAxiomLastRefreshedAt(null);
    markLoadedSnapshot(null, "", "");
  }

  // --- FILTERING (already strict lane query; this is for UI search/status only) ---
  const filteredDrafts = useMemo(() => {
    let list = drafts;

    if (statusTab !== "all") list = list.filter((d) => d.status === statusTab);

    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter((d) => {
        const hay = `${d.title ?? ""}\n${d.draft_text ?? ""}`.toLowerCase();
        return hay.includes(q);
      });
    }

    return list;
  }, [drafts, statusTab, query]);

  async function refreshAxiomNotes() {
    setAxiomError(null);

    if (!selectedId) {
      setAxiomNotes([]);
      setAxiomLastRefreshedAt(null);
      return;
    }

    // Draft-stage AXIOM must remain inside ai_notes (scope_type='document', scope_id=draft_id)
    setAxiomLoading(true);
    try {
      // Prefer scope_type filter; fallback if enum column mismatch ever shows up.
      const tryFull = async () => {
        const { data, error } = await supabase
          .from("ai_notes")
          .select(
            `
              id,
              scope_id,
              scope_type,
              note_type,
              title,
              body,
              metadata,
              created_at,
              created_by
            `
          )
          .eq("scope_id", selectedId)
          .eq("scope_type", "document")
          .eq("note_type", "summary")
          .order("created_at", { ascending: false })
          .limit(25);

        if (error) throw error;
        return (data ?? []) as AxiomNote[];
      };

      const tryWithoutScopeType = async () => {
        const { data, error } = await supabase
          .from("ai_notes")
          .select(
            `
              id,
              scope_id,
              scope_type,
              note_type,
              title,
              body,
              metadata,
              created_at,
              created_by
            `
          )
          .eq("scope_id", selectedId)
          .eq("note_type", "summary")
          .order("created_at", { ascending: false })
          .limit(25);

        if (error) throw error;
        return (data ?? []) as AxiomNote[];
      };

      let rows: AxiomNote[] = [];
      try {
        rows = await tryFull();
      } catch (e: any) {
        const msg = (e?.message ?? "").toLowerCase();
        if (msg.includes("column") && msg.includes("does not exist")) {
          rows = await tryWithoutScopeType();
        } else {
          throw e;
        }
      }

      setAxiomNotes(rows);
      setAxiomLastRefreshedAt(new Date().toISOString());
    } catch (e: any) {
      console.error("AXIOM notes load failed:", e);
      setAxiomNotes([]);
      setAxiomLastRefreshedAt(null);
      setAxiomError(e?.message ?? "Failed to load AXIOM notes.");
    } finally {
      setAxiomLoading(false);
    }
  }

  // If AXIOM tab is open, keep it fresh when selection changes.
  useEffect(() => {
    if (workspaceTab !== "axiom") return;
    void refreshAxiomNotes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceTab, selectedId]);

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
        is_test: isSandbox,
        lane: isSandbox ? "SANDBOX" : "ROT",
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

      const producedTitle = (asAny.title || title.trim() || "(untitled)") as string;

      const newDraft: DraftRecord = {
        id: draftId || crypto.randomUUID(),
        entity_id: asAny.entity_id ?? null,
        entity_slug: asAny.entity_slug ?? activeEntity,
        entity_name: asAny.entity_name ?? activeEntityLabel,
        title: producedTitle,
        record_type: asAny.record_type || "resolution",
        draft_text: draftText,
        status: (asAny.draft_status || "draft") as DraftStatus,
        created_at: asAny.draft_created_at ?? new Date().toISOString(),
        updated_at: null,
        finalized_record_id: asAny.finalized_record_id ?? null,
        is_test: typeof asAny.is_test === "boolean" ? asAny.is_test : isSandbox,
      };

      setTitle(newDraft.title);
      setBody(newDraft.draft_text);
      setSelectedId(newDraft.id);

      setDrafts((prev) => {
        const without = prev.filter((d) => d.id !== newDraft.id);
        return [newDraft, ...without];
      });

      setWorkspaceTab("editor");
      markLoadedSnapshot(newDraft.id, newDraft.title, newDraft.draft_text);

      flashInfo("Draft created. Review, edit, then Save.");
      await reloadDrafts(true);
    } catch (err: any) {
      console.error("scribe invoke exception", err);
      flashError(err?.message ?? "Network error calling CI-Alchemy (scribe).");
    } finally {
      setAlchemyRunning(false);
    }
  }

  // AXIOM pre-draft review (Edge Function "axiom-pre-draft-review")
  async function handleAxiomReview() {
    if (!selectedId) return flashError("Select a draft first.");
    if (!canMutateSelected)
      return flashError("This draft has left Alchemy. Draft-stage AXIOM runs pre-finalize only.");
    if (!title.trim() || !body.trim()) return flashError("Title + body required (save first).");

    const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!baseUrl || !anonKey) return flashError("Missing Supabase URL or anon key in environment.");

    setAxiomRunning(true);
    setError(null);
    setInfo(null);
    setAxiomError(null);

    try {
      const { data: sessionData, error: sessionErr } = await supabase.auth.getSession();
      if (sessionErr) throw sessionErr;

      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) return flashError("Not authenticated. Please log in (OS auth gate).");

      // IMPORTANT: draft-stage AXIOM writes to ai_notes (scope_type='document', scope_id=draft_id, note_type='summary')
      const payload = {
        draft_id: selectedId,
        entity_slug: activeEntity,
        trigger: "alchemy-pre-finalize",
        title: title.trim(),
        draft_text: body,
        is_test: isSandbox,
      };

      const res = await fetch(`${baseUrl}/functions/v1/axiom-pre-draft-review`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: anonKey,
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(payload),
      });

      // Parse safely (prevents “500/invalid JSON” style crashes)
      const raw = await res.text();
      const json = safeJsonParse(raw);

      if (!res.ok) {
        console.error("axiom-pre-draft-review HTTP error", res.status, raw);
        flashError(`AXIOM Review HTTP ${res.status}. See console.`);
        return;
      }

      if (!json?.ok) {
        console.error("AXIOM review failed payload", json ?? raw);
        flashError(json?.error || "AXIOM review failed.");
        return;
      }

      const noteId = json?.note_id || json?.ai_note_id || json?.id || null;

      // Flip into AXIOM tab + refresh notes so you SEE it immediately.
      setWorkspaceTab("axiom");
      await refreshAxiomNotes();

      flashInfo(noteId ? `AXIOM Review saved (note_id=${noteId}).` : "AXIOM Review saved.");
    } catch (err: any) {
      console.error("axiom review invoke exception", err);
      flashError(err?.message ?? "Network error calling AXIOM Review.");
    } finally {
      setAxiomRunning(false);
    }
  }

  async function handleSaveDraft() {
    if (!title.trim() || !body.trim()) {
      flashError("Title and body are required to save a draft.");
      return;
    }

    if (selectedDraft?.status === "finalized") {
      flashError("This draft is finalized. Create a new revision instead.");
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

      const basePayload: any = {
        entity_id: entityRow.id as string,
        entity_slug: activeEntity,
        entity_name: entityRow.name as string,
        title: title.trim(),
        draft_text: body,
        record_type: "resolution",
        is_test: isSandbox,
      };

      if (!selectedId) {
        const insertTry = await supabase
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
              finalized_record_id,
              is_test
            `
          )
          .single();

        if (insertTry.error) {
          if (isMissingColumnErr(insertTry.error)) {
            delete basePayload.is_test;
            const retry = await supabase
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

            if (retry.error) throw retry.error;

            const newDraft = retry.data as DraftRecord;
            setDrafts((prev) => [newDraft, ...prev]);
            setSelectedId(newDraft.id);
            markLoadedSnapshot(newDraft.id, newDraft.title ?? "", newDraft.draft_text ?? "");
            flashInfo("Draft created.");
          } else {
            throw insertTry.error;
          }
        } else {
          const newDraft = insertTry.data as DraftRecord;
          setDrafts((prev) => [newDraft, ...prev]);
          setSelectedId(newDraft.id);
          markLoadedSnapshot(newDraft.id, newDraft.title ?? "", newDraft.draft_text ?? "");
          flashInfo("Draft created.");
        }
      } else {
        const updateTry = await supabase
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
              finalized_record_id,
              is_test
            `
          )
          .single();

        if (updateTry.error) {
          if (isMissingColumnErr(updateTry.error)) {
            delete basePayload.is_test;
            const retry = await supabase
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

            if (retry.error) throw retry.error;

            const updated = retry.data as DraftRecord;
            setDrafts((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
            markLoadedSnapshot(updated.id, updated.title ?? "", updated.draft_text ?? "");
            flashInfo("Draft saved.");
          } else {
            throw updateTry.error;
          }
        } else {
          const updated = updateTry.data as DraftRecord;
          setDrafts((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
          markLoadedSnapshot(updated.id, updated.title ?? "", updated.draft_text ?? "");
          flashInfo("Draft saved.");
        }
      }
    } catch (err: any) {
      flashError(err?.message ?? "Failed to save draft.");
    } finally {
      setSaving(false);
    }
  }

  async function handleMarkReviewed() {
    if (!selectedId) return flashError("Select a draft first.");
    if (!canMutateSelected)
      return flashError("This draft has left Alchemy and can’t be changed here.");

    const draft = drafts.find((d) => d.id === selectedId);
    if (!draft) return flashError("Draft not found.");
    if (draft.status === "reviewed") return flashInfo("Already reviewed.");

    setSaving(true);
    setError(null);
    setInfo(null);

    try {
      const baseUpdate: any = {
        status: "reviewed" as DraftStatus,
        updated_at: new Date().toISOString(),
        is_test: isSandbox,
      };

      const tryUpd = await supabase
        .from("governance_drafts")
        .update(baseUpdate)
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
            finalized_record_id,
            is_test
          `
        )
        .single();

      if (tryUpd.error) {
        if (isMissingColumnErr(tryUpd.error)) {
          delete baseUpdate.is_test;
          const retry = await supabase
            .from("governance_drafts")
            .update(baseUpdate)
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

          if (retry.error) throw retry.error;

          const updated = retry.data as DraftRecord;
          setDrafts((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
          markLoadedSnapshot(updated.id, updated.title ?? "", updated.draft_text ?? "");
          flashInfo("Marked as reviewed.");
        } else {
          throw tryUpd.error;
        }
      } else {
        const updated = tryUpd.data as DraftRecord;
        setDrafts((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
        markLoadedSnapshot(updated.id, updated.title ?? "", updated.draft_text ?? "");
        flashInfo("Marked as reviewed.");
      }
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

    if (!title.trim() || !body.trim())
      return flashError("Title and body are required before finalizing.");
    if (draft.status === "finalized") return flashInfo("Already finalized.");
    if (draft.finalized_record_id)
      return flashError("This draft is already linked to a ledger record.");

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

      const ledgerPayload: any = {
        entity_id: entityRow.id as string,
        title: title.trim(),
        description: null,
        record_type: "resolution",
        record_no: null,
        body, // schema uses `body`
        source: "ci-alchemy",
        status: "PENDING",
        is_test: isSandbox,
      };

      const tryLedger = await supabase.from("governance_ledger").insert(ledgerPayload).select("id").single();

      let ledgerId: string | null = null;

      if (tryLedger.error) {
        if (isMissingColumnErr(tryLedger.error)) {
          delete ledgerPayload.is_test;
          const retry = await supabase.from("governance_ledger").insert(ledgerPayload).select("id").single();
          if (retry.error || !retry.data) throw retry.error ?? new Error("Ledger insert failed.");
          ledgerId = (retry.data as { id: string }).id;
        } else {
          throw tryLedger.error;
        }
      } else {
        ledgerId = (tryLedger.data as { id: string }).id;
      }

      if (!ledgerId) throw new Error("Ledger insert failed.");

      const draftUpdate: any = {
        status: "finalized" as DraftStatus,
        finalized_record_id: ledgerId,
        finalized_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        is_test: isSandbox,
      };

      const tryDraftUpd = await supabase
        .from("governance_drafts")
        .update(draftUpdate)
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
            finalized_record_id,
            is_test
          `
        )
        .single();

      if (tryDraftUpd.error) {
        if (isMissingColumnErr(tryDraftUpd.error)) {
          delete draftUpdate.is_test;
          const retry = await supabase
            .from("governance_drafts")
            .update(draftUpdate)
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

          if (retry.error) throw retry.error;

          const updated = retry.data as DraftRecord;
          setDrafts((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
          markLoadedSnapshot(updated.id, updated.title ?? "", updated.draft_text ?? "");
        } else {
          throw tryDraftUpd.error;
        }
      } else {
        const updated = tryDraftUpd.data as DraftRecord;
        setDrafts((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
        markLoadedSnapshot(updated.id, updated.title ?? "", updated.draft_text ?? "");
      }

      flashInfo("Finalized → Council queue.");
      await reloadDrafts(true);
    } catch (err: any) {
      flashError(err?.message ?? "Failed to finalize.");
    } finally {
      setFinalizing(false);
    }
  }

  // Delete controls (soft + hard), only pre-finalize
  function openDelete() {
    if (!selectedDraft) return flashError("Select a draft first.");
    if (!canMutateSelected) return flashError("Can’t remove a draft that already left Alchemy.");
    setDeleteMode("soft");
    setDeleteReason("");
    setDeleteConfirmText("");
    setDeleteBusy(false);
    setDeleteOpen(true);
  }

  async function softDeleteDraft(draftId: string, reason: string) {
    const baseUpdate: any = {
      status: "discarded" as DraftStatus,
      updated_at: new Date().toISOString(),
      discard_reason: reason || null,
      discarded_at: new Date().toISOString(),
      is_test: isSandbox,
    };

    const tryUpd = await supabase
      .from("governance_drafts")
      .update(baseUpdate)
      .eq("id", draftId)
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
          finalized_record_id,
          is_test
        `
      )
      .single();

    if (tryUpd.error) {
      if (isMissingColumnErr(tryUpd.error)) {
        delete baseUpdate.is_test;
        const retry = await supabase
          .from("governance_drafts")
          .update(baseUpdate)
          .eq("id", draftId)
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

        if (retry.error) throw retry.error;
        return retry.data as DraftRecord;
      }
      throw tryUpd.error;
    }

    return tryUpd.data as DraftRecord;
  }

  async function hardDeleteDraft(draftId: string, reason: string) {
    const tryTwo = await supabase.rpc(
      "owner_delete_governance_draft",
      { p_draft_id: draftId, p_reason: reason || null } as any
    );
    if (!tryTwo.error) return;

    const tryOne = await supabase.rpc("owner_delete_governance_draft", { p_draft_id: draftId } as any);
    if (!tryOne.error) return;

    const tryAlt = await supabase.rpc(
      "owner_delete_governance_draft",
      { draft_id: draftId, reason: reason || null } as any
    );
    if (tryAlt.error) throw tryAlt.error;
  }

  async function confirmDelete() {
    if (!selectedDraft || !selectedId) return;
    if (!canMutateSelected) return;

    if (deleteMode === "hard" && deleteConfirmText.trim().toUpperCase() !== "DELETE") {
      flashError('Type "DELETE" to confirm hard deletion.');
      return;
    }

    setDeleteBusy(true);
    setError(null);
    setInfo(null);

    try {
      if (deleteMode === "soft") {
        const updated = await softDeleteDraft(selectedId, deleteReason.trim());
        setDrafts((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
        flashInfo("Draft discarded.");
      } else {
        await hardDeleteDraft(selectedId, deleteReason.trim());
        setDrafts((prev) => prev.filter((d) => d.id !== selectedId));
        flashInfo("Draft permanently deleted.");
      }

      setDeleteOpen(false);

      const nextRows =
        deleteMode === "hard"
          ? (drafts.filter((d) => d.id !== selectedId) as DraftRecord[])
          : (drafts.map((d) =>
              d.id === selectedId ? { ...d, status: "discarded" as DraftStatus } : d
            ) as DraftRecord[]);

      const next = pickDefaultSelection(nextRows);
      if (next) {
        setSelectedId(next.id);
        setTitle(next.title ?? "");
        setBody(next.draft_text ?? "");
        setWorkspaceTab("editor");
        markLoadedSnapshot(next.id, next.title ?? "", next.draft_text ?? "");
      } else {
        setSelectedId(null);
        setTitle("");
        setBody("");
        setWorkspaceTab("editor");
        markLoadedSnapshot(null, "", "");
      }
    } catch (err: any) {
      flashError(err?.message ?? "Delete failed.");
    } finally {
      setDeleteBusy(false);
    }
  }

  // Dirty tracking
  function onTitleChange(v: string) {
    setTitle(v);
    setDirty(computeDirty(v, body, selectedId));
  }
  function onBodyChange(v: string) {
    setBody(v);
    setDirty(computeDirty(title, v, selectedId));
  }

  // Styles for editor theme
  const editorCard =
    editorTheme === "light"
      ? "bg-white text-slate-900 border-slate-200"
      : "bg-slate-950/70 text-slate-100 border-slate-800";

  const inputBase =
    editorTheme === "light"
      ? "bg-white border-slate-200 text-slate-900 placeholder:text-slate-400 focus:border-emerald-500"
      : "bg-slate-900/80 border-slate-700 text-slate-100 placeholder:text-slate-500 focus:border-emerald-400";

  const textareaBase =
    editorTheme === "light"
      ? "bg-white border-slate-200 text-slate-900 focus:border-emerald-500"
      : "bg-slate-900/80 border-slate-700 text-slate-100 focus:border-emerald-400";

  const disableAll = saving || finalizing || alchemyRunning || axiomRunning;

  const axiomLatest = axiomNotes?.[0] ?? null;

  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      {/* Header under OS bar */}
      <div className="mb-4 shrink-0">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">CI • Alchemy</div>
        <h1 className="mt-1 text-xl font-semibold text-slate-50">Drafting Console · AI Scribe</h1>
        <p className="mt-1 text-xs text-slate-400 max-w-3xl">
          Draft safely inside Alchemy.{" "}
          <span className="text-emerald-300 font-semibold">Finalize</span> promotes into
          Council (governance_ledger status=PENDING).
        </p>
        <div className="mt-2 text-xs text-slate-400">
          Entity: <span className="text-emerald-300 font-medium">{activeEntityLabel}</span>
          <span className="mx-2 text-slate-700">•</span>
          Lane:{" "}
          <span className={cx("font-semibold", isSandbox ? "text-amber-300" : "text-sky-300")}>
            {env}
          </span>
        </div>
      </div>

      {/* Main OS window frame (Parliament-style) */}
      <div className="flex-1 min-h-0 flex justify-center overflow-hidden">
        <div className="w-full max-w-[1500px] h-full rounded-3xl border border-slate-900 bg-black/60 shadow-[0_0_60px_rgba(15,23,42,0.9)] px-6 py-5 flex flex-col overflow-hidden">
          {/* Top strip: tabs + controls */}
          <div className="shrink-0 mb-4 flex items-center justify-between gap-4">
            <div className="inline-flex rounded-full bg-slate-950/70 border border-slate-800 p-1 overflow-hidden">
              <StatusTabButton label="Drafts" value="draft" active={statusTab === "draft"} onClick={() => setStatusTab("draft")} />
              <StatusTabButton label="Reviewed" value="reviewed" active={statusTab === "reviewed"} onClick={() => setStatusTab("reviewed")} />
              <StatusTabButton label="Finalized" value="finalized" active={statusTab === "finalized"} onClick={() => setStatusTab("finalized")} />
              <StatusTabButton label="Discarded" value="discarded" active={statusTab === "discarded"} onClick={() => setStatusTab("discarded")} />
              <StatusTabButton label="All" value="all" active={statusTab === "all"} onClick={() => setStatusTab("all")} />
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => setDrawerOpen((v) => !v)}
                className="rounded-full border border-slate-800 bg-slate-950/60 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60"
                title="Toggle drafts drawer"
              >
                {drawerOpen ? "Hide Drafts" : "Show Drafts"}
              </button>

              <div className="inline-flex rounded-full border border-slate-800 bg-slate-950/60 p-1 text-[10px] uppercase tracking-[0.18em]">
                <button
                  onClick={() => setEditorTheme("light")}
                  className={cx(
                    "rounded-full px-3 py-1 transition",
                    editorTheme === "light" ? "bg-white text-black" : "text-slate-400 hover:bg-slate-900/60"
                  )}
                >
                  Paper
                </button>
                <button
                  onClick={() => setEditorTheme("dark")}
                  className={cx(
                    "rounded-full px-3 py-1 transition",
                    editorTheme === "dark" ? "bg-emerald-500 text-black" : "text-slate-400 hover:bg-slate-900/60"
                  )}
                >
                  Noir
                </button>
              </div>

              <button
                onClick={() => {
                  if (!selectedDraft && !body.trim()) return flashError("Select a draft (or write) first.");
                  setReaderOpen(true);
                }}
                className="rounded-full border border-emerald-400/60 bg-emerald-500/10 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-emerald-200 hover:bg-emerald-500/15"
              >
                Open Reader
              </button>
            </div>
          </div>

          {/* Workspace body (NO page scroll) */}
          <div className="flex-1 min-h-0 flex gap-4 overflow-hidden">
            {drawerOpen && (
              <aside className="w-[360px] shrink-0 min-h-0 rounded-2xl border border-slate-800 bg-slate-950/40 flex flex-col overflow-hidden">
                <div className="shrink-0 p-4 border-b border-slate-800">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                      Drafts · {filteredDrafts.length}/{drafts.length}
                      <span className="mx-2 text-slate-700">•</span>
                      <span className={cx(isSandbox ? "text-amber-300" : "text-sky-300")}>{env}</span>
                    </div>
                    <button
                      onClick={() => reloadDrafts(true)}
                      className="rounded-full border border-slate-800 bg-slate-950/60 px-3 py-1.5 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60"
                    >
                      Refresh
                    </button>
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
                                {fmtShort(d.created_at)} · {d.record_type || "resolution"}
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
              </aside>
            )}

            {/* Main editor surface */}
            <section className="flex-1 min-w-0 min-h-0 rounded-2xl border border-slate-800 bg-slate-950/40 flex flex-col overflow-hidden">
              <div className="shrink-0 px-5 py-4 border-b border-slate-800 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                    Workspace
                  </div>
                  <div className="mt-1 text-[13px] text-slate-400">
                    Entity:{" "}
                    <span className="text-emerald-300 font-semibold">{activeEntityLabel}</span>
                    <span className="mx-2 text-slate-700">•</span>
                    Lane:{" "}
                    <span className={cx("font-semibold", isSandbox ? "text-amber-300" : "text-sky-300")}>
                      {env}
                    </span>
                    {selectedDraft?.finalized_record_id && (
                      <>
                        <span className="mx-2 text-slate-700">•</span>
                        <span className="text-emerald-200">Ledger-linked</span>
                      </>
                    )}
                    {dirty && (
                      <>
                        <span className="mx-2 text-slate-700">•</span>
                        <span className="text-amber-200">Unsaved</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={handleNewDraft}
                    className="rounded-full border border-slate-800 bg-slate-950/60 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60"
                  >
                    New
                  </button>

                  {selectedDraft && (
                    <span
                      className={cx(
                        "rounded-full px-3 py-2 text-[10px] uppercase tracking-[0.18em] border",
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
                  )}

                  {!canMutateSelected && selectedDraft && (
                    <span className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-slate-300">
                      Locked
                    </span>
                  )}
                </div>
              </div>

              {/* Workspace tabs (Editor vs AXIOM) */}
              <div className="shrink-0 px-5 py-3 border-b border-slate-800 flex items-center justify-between gap-3">
                <div className="inline-flex rounded-full bg-slate-950/70 border border-slate-800 p-1">
                  <button
                    onClick={() => setWorkspaceTab("editor")}
                    className={cx(
                      "rounded-full px-4 py-2 text-[11px] font-semibold tracking-[0.16em] uppercase transition",
                      workspaceTab === "editor"
                        ? "bg-emerald-500/15 border border-emerald-400/70 text-slate-50"
                        : "border border-transparent text-slate-300 hover:bg-slate-900/60"
                    )}
                  >
                    Editor
                  </button>
                  <button
                    onClick={() => setWorkspaceTab("axiom")}
                    className={cx(
                      "rounded-full px-4 py-2 text-[11px] font-semibold tracking-[0.16em] uppercase transition",
                      workspaceTab === "axiom"
                        ? "bg-sky-500/15 border border-sky-400/60 text-slate-50"
                        : "border border-transparent text-slate-300 hover:bg-slate-900/60"
                    )}
                    title="AXIOM = read-only intelligence (draft stage writes ai_notes only)"
                  >
                    AXIOM
                    {axiomLatest?.created_at ? (
                      <span className="ml-2 text-[10px] tracking-[0.12em] text-slate-400">
                        {fmtShort(axiomLatest.created_at)}
                      </span>
                    ) : null}
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  {workspaceTab === "axiom" && (
                    <button
                      onClick={() => refreshAxiomNotes()}
                      disabled={axiomLoading || !selectedId}
                      className="rounded-full border border-slate-800 bg-slate-950/60 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60 disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Refresh AXIOM notes for this draft"
                    >
                      {axiomLoading ? "Refreshing…" : "Refresh AXIOM"}
                    </button>
                  )}

                  <button
                    onClick={handleAxiomReview}
                    disabled={!selectedDraft || disableAll || !canMutateSelected}
                    className="rounded-full border border-sky-400/50 bg-sky-500/10 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-sky-200 hover:bg-sky-500/15 disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Runs AXIOM draft review (writes ai_notes scoped to this draft)"
                  >
                    {axiomRunning ? "AXIOM…" : "Run AXIOM"}
                  </button>
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-hidden p-5">
                {/* EDITOR TAB */}
                {workspaceTab === "editor" && (
                  <div className={cx("h-full w-full rounded-2xl border overflow-hidden", editorCard)}>
                    <div className="h-full flex flex-col">
                      <div
                        className={cx(
                          "shrink-0 px-5 py-4 border-b",
                          editorTheme === "light" ? "border-slate-200" : "border-slate-800"
                        )}
                      >
                        <input
                          className={cx(
                            "w-full rounded-2xl border px-4 py-3 text-[15px] outline-none transition",
                            inputBase,
                            (!canMutateSelected || disableAll) && "opacity-70 cursor-not-allowed"
                          )}
                          placeholder="Resolution title"
                          value={title}
                          onChange={(e) => onTitleChange(e.target.value)}
                          disabled={!canMutateSelected || disableAll}
                        />
                      </div>

                      <div className="flex-1 min-h-0 overflow-hidden px-5 py-4">
                        <textarea
                          className={cx(
                            "h-full w-full resize-none rounded-2xl border px-4 py-4 text-[13px] leading-[1.75] outline-none transition",
                            textareaBase,
                            (!canMutateSelected || disableAll) && "opacity-70 cursor-not-allowed"
                          )}
                          placeholder="Draft body… (or Run Alchemy)"
                          value={body}
                          onChange={(e) => onBodyChange(e.target.value)}
                          disabled={!canMutateSelected || disableAll}
                        />
                      </div>

                      <div
                        className={cx(
                          "shrink-0 px-5 py-4 border-t flex flex-wrap gap-2",
                          editorTheme === "light" ? "border-slate-200" : "border-slate-800"
                        )}
                      >
                        <button
                          onClick={handleRunAlchemy}
                          disabled={alchemyRunning || saving || finalizing || axiomRunning}
                          className="rounded-full border border-emerald-400/70 bg-emerald-500/10 px-5 py-3 text-[12px] font-semibold tracking-[0.18em] uppercase text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {alchemyRunning ? "Running…" : "Run Alchemy"}
                        </button>

                        <button
                          onClick={handleSaveDraft}
                          disabled={saving || finalizing || !canMutateSelected || axiomRunning}
                          className="rounded-full bg-emerald-500 px-5 py-3 text-[12px] font-semibold tracking-[0.18em] uppercase text-black hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {saving ? "Saving…" : "Save"}
                        </button>

                        <button
                          onClick={handleMarkReviewed}
                          disabled={!selectedDraft || saving || finalizing || !canMutateSelected || axiomRunning}
                          className="rounded-full border border-amber-400/60 bg-slate-950/60 px-5 py-3 text-[12px] font-semibold tracking-[0.18em] uppercase text-amber-200 hover:bg-amber-500/10 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Mark reviewed
                        </button>

                        <button
                          onClick={handleFinalize}
                          disabled={!selectedDraft || saving || finalizing || !canMutateSelected || axiomRunning}
                          className="rounded-full border border-emerald-500/60 bg-black/40 px-5 py-3 text-[12px] font-semibold tracking-[0.18em] uppercase text-emerald-200 hover:bg-emerald-500/10 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {finalizing ? "Finalizing…" : "Finalize → Council"}
                        </button>

                        <div className="flex-1" />

                        <button
                          onClick={openDelete}
                          disabled={!selectedDraft || !canMutateSelected || disableAll}
                          className="rounded-full border border-rose-500/50 bg-rose-500/10 px-5 py-3 text-[12px] font-semibold tracking-[0.18em] uppercase text-rose-200 hover:bg-rose-500/15 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* AXIOM TAB */}
                {workspaceTab === "axiom" && (
                  <div className="h-full w-full rounded-2xl border border-slate-800 bg-black/40 overflow-hidden flex flex-col">
                    <div className="shrink-0 px-5 py-4 border-b border-slate-800 flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="text-[11px] uppercase tracking-[0.22em] text-sky-300">
                          AXIOM · Draft Review
                        </div>
                        <div className="mt-1 text-[13px] text-slate-400">
                          Read-only intelligence sidecar. Draft stage writes{" "}
                          <span className="text-slate-200 font-semibold">ai_notes</span> only (scope_type=document,
                          note_type=summary). Nothing touches files.
                        </div>
                        <div className="mt-2 text-[11px] text-slate-500">
                          Draft:{" "}
                          <span className="text-slate-200 font-semibold">
                            {selectedDraft?.title || title || "(untitled)"}
                          </span>
                          <span className="mx-2 text-slate-700">•</span>
                          Lane:{" "}
                          <span className={cx("font-semibold", isSandbox ? "text-amber-300" : "text-sky-300")}>
                            {env}
                          </span>
                          <span className="mx-2 text-slate-700">•</span>
                          Last refresh:{" "}
                          <span className="text-slate-300">{fmtShort(axiomLastRefreshedAt)}</span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => refreshAxiomNotes()}
                          disabled={axiomLoading || !selectedId}
                          className="rounded-full border border-slate-800 bg-slate-950/60 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {axiomLoading ? "Refreshing…" : "Refresh"}
                        </button>

                        <button
                          onClick={handleAxiomReview}
                          disabled={!selectedDraft || disableAll || !canMutateSelected}
                          className="rounded-full border border-sky-400/50 bg-sky-500/10 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-sky-200 hover:bg-sky-500/15 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {axiomRunning ? "Running…" : "Run AXIOM"}
                        </button>
                      </div>
                    </div>

                    <div className="flex-1 min-h-0 overflow-y-auto px-5 py-5">
                      {!selectedId ? (
                        <div className="rounded-2xl border border-slate-800 bg-slate-950/40 px-4 py-3 text-[13px] text-slate-400">
                          Select a draft to view AXIOM output.
                        </div>
                      ) : axiomError ? (
                        <div className="rounded-2xl border border-red-500/60 bg-red-500/10 px-4 py-3 text-[13px] text-red-200">
                          {axiomError}
                        </div>
                      ) : axiomLoading ? (
                        <div className="rounded-2xl border border-slate-800 bg-slate-950/40 px-4 py-3 text-[13px] text-slate-400">
                          Loading AXIOM notes…
                        </div>
                      ) : axiomNotes.length === 0 ? (
                        <div className="rounded-2xl border border-slate-800 bg-slate-950/40 px-4 py-3 text-[13px] text-slate-400">
                          No AXIOM summary found yet for this draft. Click{" "}
                          <span className="text-sky-200 font-semibold">Run AXIOM</span>.
                        </div>
                      ) : (
                        <div className="space-y-3">
                          {axiomNotes.map((n, idx) => (
                            <div
                              key={n.id}
                              className={cx(
                                "rounded-2xl border bg-slate-950/40 overflow-hidden",
                                idx === 0 ? "border-sky-400/40" : "border-slate-800"
                              )}
                            >
                              <div className="px-4 py-3 border-b border-slate-800 flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="text-[11px] uppercase tracking-[0.22em] text-slate-400">
                                    {idx === 0 ? "Latest" : "History"} · {n.note_type}
                                  </div>
                                  <div className="mt-1 text-[13px] font-semibold text-slate-100 truncate">
                                    {n.title || "AXIOM Summary"}
                                  </div>
                                  <div className="mt-1 text-[11px] text-slate-500">
                                    {fmtShort(n.created_at)}
                                    <span className="mx-2 text-slate-700">•</span>
                                    note_id: <span className="text-slate-300">{n.id}</span>
                                  </div>
                                </div>
                                {idx === 0 && (
                                  <span className="shrink-0 rounded-full border border-sky-400/40 bg-sky-500/10 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-sky-200">
                                    Active
                                  </span>
                                )}
                              </div>

                              <div className="px-4 py-4">
                                <pre className="whitespace-pre-wrap font-sans text-[13px] leading-[1.8] text-slate-100">
                                  {n.body || "—"}
                                </pre>

                                {n.metadata ? (
                                  <div className="mt-4 rounded-2xl border border-slate-800 bg-black/30 px-4 py-3">
                                    <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
                                      Metadata
                                    </div>
                                    <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] leading-[1.6] text-slate-300">
                                      {JSON.stringify(n.metadata, null, 2)}
                                    </pre>
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="shrink-0 px-5 py-3 border-t border-slate-800 text-[10px] text-slate-500 flex items-center justify-between">
                      <span>AXIOM · ai_notes (draft stage) · advisory-only</span>
                      <span>Archive embeds AXIOM snapshot later (not during draft)</span>
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

              <div className="shrink-0 px-5 py-3 border-t border-slate-800 text-[10px] text-slate-500 flex items-center justify-between">
                <span>CI-Alchemy · Draft factory (governance_drafts)</span>
                <span>
                  Lane-aware · AXIOM Review → ai_notes · Finalize → governance_ledger (PENDING)
                </span>
              </div>
            </section>
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
                  {(selectedDraft?.title || title || "(untitled)") as string}
                </div>
                <div className="mt-1 text-[11px] text-slate-500">
                  {selectedDraft ? `${selectedDraft.status.toUpperCase()} • ${fmtShort(selectedDraft.created_at)}` : "—"}
                  <span className="mx-2 text-slate-700">•</span>
                  <span className={cx(isSandbox ? "text-amber-300" : "text-sky-300")}>{env}</span>
                </div>
              </div>

              <button
                onClick={() => setReaderOpen(false)}
                className="rounded-full border border-slate-700 bg-slate-900/60 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-800/60"
              >
                Close
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
              <div className="rounded-2xl border border-slate-800 bg-black/40 px-5 py-5">
                <pre className="whitespace-pre-wrap font-sans text-[13px] leading-[1.8] text-slate-100">
                  {selectedDraft ? selectedDraft.draft_text ?? "" : body ?? ""}
                </pre>
              </div>
            </div>

            <div className="shrink-0 px-5 py-4 border-t border-slate-800 flex items-center justify-between text-[10px] text-slate-500">
              <span>Reader is non-mutating. Edit in the Paper/Noir editor.</span>
              <span>Oasis OS · Evidence-Bound Drafting</span>
            </div>
          </div>
        </div>
      )}

      {/* Delete Modal (soft + hard) */}
      {deleteOpen && selectedDraft && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-[620px] rounded-3xl border border-slate-800 bg-slate-950 shadow-2xl shadow-black/60 overflow-hidden">
            <div className="px-6 py-5 border-b border-slate-800">
              <div className="text-[11px] uppercase tracking-[0.22em] text-rose-300">Delete draft</div>
              <div className="mt-1 text-[16px] font-semibold text-slate-100">Discard vs Permanent Delete</div>
              <div className="mt-2 text-[12px] text-slate-400">
                Allowed only before finalize. Ledger-linked drafts are locked.
              </div>
            </div>

            <div className="px-6 py-5 space-y-4">
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setDeleteMode("soft")}
                  className={cx(
                    "rounded-2xl border px-4 py-3 text-left transition",
                    deleteMode === "soft"
                      ? "border-emerald-500/60 bg-emerald-500/10"
                      : "border-slate-800 bg-slate-950 hover:bg-slate-900/60"
                  )}
                  disabled={deleteBusy}
                >
                  <div className="text-[11px] uppercase tracking-[0.2em] text-emerald-300">Soft</div>
                  <div className="mt-1 text-sm font-semibold text-slate-100">Discard</div>
                  <div className="mt-1 text-[11px] text-slate-400">Marks status = discarded.</div>
                </button>

                <button
                  onClick={() => setDeleteMode("hard")}
                  className={cx(
                    "rounded-2xl border px-4 py-3 text-left transition",
                    deleteMode === "hard"
                      ? "border-rose-500/60 bg-rose-500/10"
                      : "border-slate-800 bg-slate-950 hover:bg-slate-900/60"
                  )}
                  disabled={deleteBusy}
                >
                  <div className="text-[11px] uppercase tracking-[0.2em] text-rose-300">Hard</div>
                  <div className="mt-1 text-sm font-semibold text-slate-100">Permanent</div>
                  <div className="mt-1 text-[11px] text-slate-400">Calls owner_delete_governance_draft.</div>
                </button>
              </div>

              <div>
                <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500 mb-2">Reason (optional)</div>
                <textarea
                  className="w-full min-h-[96px] rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-sm text-slate-100 resize-none outline-none focus:border-slate-600"
                  value={deleteReason}
                  onChange={(e) => setDeleteReason(e.target.value)}
                  placeholder="e.g., test run / duplicate / wrong entity…"
                  disabled={deleteBusy}
                />
              </div>

              {deleteMode === "hard" && (
                <div className="rounded-2xl border border-rose-500/30 bg-rose-500/5 px-4 py-3">
                  <div className="text-[11px] uppercase tracking-[0.2em] text-rose-300">Confirm hard delete</div>
                  <div className="mt-1 text-[11px] text-slate-400">
                    Type <span className="text-slate-200 font-semibold">DELETE</span> to confirm.
                  </div>
                  <input
                    className="mt-3 w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-sm text-slate-100 outline-none focus:border-rose-500/50"
                    value={deleteConfirmText}
                    onChange={(e) => setDeleteConfirmText(e.target.value)}
                    placeholder='Type "DELETE"'
                    disabled={deleteBusy}
                  />
                </div>
              )}
            </div>

            <div className="px-6 py-5 border-t border-slate-800 flex items-center justify-between gap-2">
              <button
                onClick={() => (deleteBusy ? null : setDeleteOpen(false))}
                disabled={deleteBusy}
                className="rounded-full border border-slate-800 bg-slate-950 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60 disabled:opacity-50"
              >
                Cancel
              </button>

              <button
                onClick={confirmDelete}
                disabled={deleteBusy || !canMutateSelected}
                className={cx(
                  "rounded-full px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition disabled:opacity-50 disabled:cursor-not-allowed",
                  deleteMode === "soft" ? "bg-emerald-500 text-black hover:bg-emerald-400" : "bg-rose-500 text-black hover:bg-rose-400"
                )}
              >
                {deleteBusy ? "Deleting…" : deleteMode === "soft" ? "Discard" : "Hard Delete"}
              </button>
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
