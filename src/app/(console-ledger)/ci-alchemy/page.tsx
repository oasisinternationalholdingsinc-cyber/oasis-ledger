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
  is_test?: boolean | null;
};

type StatusTab = "draft" | "reviewed" | "finalized" | "discarded" | "all";
type DeleteMode = "soft" | "hard";
type WorkspaceTab = "editor" | "axiom";

type AxiomNote = {
  id: string;
  scope_type: "document" | "section" | "book" | "entity";
  scope_id: string;
  note_type: string | null;
  title: string | null;
  content: string | null;
  model: string | null;
  tokens_used: number | null;
  created_by: string | null;
  created_at: string | null;
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

export default function CIAlchemyPage() {
  const entityCtx = useEntity() as any;
  const osEnv = useOsEnv();

  const activeEntity = (entityCtx?.activeEntity as string) || "holdings";

  // ✅ contamination-safe: never hardcode corporate entity names
  const activeEntityLabel = useMemo(() => {
    const fromCtx =
      (entityCtx?.entityName as string) ||
      (entityCtx?.activeEntityName as string) ||
      (entityCtx?.label as string) ||
      (entityCtx?.name as string);
    return fromCtx?.trim() ? fromCtx : activeEntity;
  }, [entityCtx, activeEntity]);

  const isSandbox = !!osEnv.isSandbox;
  const env = isSandbox ? "SANDBOX" : "RoT";

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [alchemyRunning, setAlchemyRunning] = useState(false);
  const [axiomRunning, setAxiomRunning] = useState(false);

  const [drafts, setDrafts] = useState<DraftRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const [statusTab, setStatusTab] = useState<StatusTab>("draft");
  const [query, setQuery] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [readerOpen, setReaderOpen] = useState(false);
  const [editorTheme, setEditorTheme] = useState<"light" | "dark">("light");
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("editor");

  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteMode, setDeleteMode] = useState<DeleteMode>("soft");
  const [deleteReason, setDeleteReason] = useState("");
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);

  const [dirty, setDirty] = useState(false);
  const lastLoadedRef = useRef<{ id: string | null; title: string; body: string } | null>(null);

  // -------------------------
  // AXIOM (ai_notes)
  // -------------------------
  const [axiomNotes, setAxiomNotes] = useState<AxiomNote[]>([]);
  const [axiomLoading, setAxiomLoading] = useState(false);
  const [axiomErr, setAxiomErr] = useState<string | null>(null);
  const [axiomLastRefresh, setAxiomLastRefresh] = useState<string | null>(null);
  const [selectedAxiomId, setSelectedAxiomId] = useState<string | null>(null);

  const selectedDraft = useMemo(
    () => drafts.find((d) => d.id === selectedId) ?? null,
    [drafts, selectedId]
  );

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

  // ✅ Browser-level guard (refresh/close/back) – no wiring changes
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

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
        if (isMissingColumnErr(e)) rows = await tryWithoutIsTest();
        else throw e;
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      setStatusTab("draft");
      setQuery("");
      setWorkspaceTab("editor");
      setSelectedAxiomId(null);
      setAxiomNotes([]);
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

    // reset AXIOM selection for new draft
    setSelectedAxiomId(null);
    setAxiomNotes([]);
    setAxiomErr(null);
    setAxiomLastRefresh(null);

    markLoadedSnapshot(draft.id, draft.title ?? "", draft.draft_text ?? "");
  }

  function handleNewDraft() {
    if (!confirmNavigateAwayIfDirty()) return;
    setSelectedId(null);
    setTitle("");
    setBody("");
    setInfo(null);
    setError(null);
    setWorkspaceTab("editor");

    // reset AXIOM selection for new draft
    setSelectedAxiomId(null);
    setAxiomNotes([]);
    setAxiomErr(null);
    setAxiomLastRefresh(null);

    markLoadedSnapshot(null, "", "");
  }

  const filteredDrafts = useMemo(() => {
    let list = drafts;
    if (statusTab !== "all") list = list.filter((d) => d.status === statusTab);

    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter((d) => {
        const hay = [d.title ?? "", d.draft_text ?? ""].join("\n").toLowerCase();
        return hay.includes(q);
      });
    }
    return list;
  }, [drafts, statusTab, query]);

  const selectedAxiomNote = useMemo(() => {
    if (selectedAxiomId) {
      const found = axiomNotes.find((n) => n.id === selectedAxiomId);
      if (found) return found;
    }
    const summaries = axiomNotes.filter((n) => (n.note_type ?? "").toLowerCase() === "summary");
    return summaries[0] ?? axiomNotes[0] ?? null;
  }, [axiomNotes, selectedAxiomId]);

  async function loadAxiomNotes(opts?: { keepSelection?: boolean }) {
    if (!selectedId) return;
    setAxiomLoading(true);
    setAxiomErr(null);

    try {
      const { data, error } = await supabase
        .from("ai_notes")
        .select(
          `
            id,
            scope_type,
            scope_id,
            note_type,
            title,
            content,
            model,
            tokens_used,
            created_by,
            created_at
          `
        )
        .eq("scope_type", "document")
        .eq("scope_id", selectedId)
        .order("created_at", { ascending: false })
        .limit(25);

      if (error) throw error;
      const rows = (data ?? []) as AxiomNote[];
      setAxiomNotes(rows);
      setAxiomLastRefresh(new Date().toISOString());

      // ✅ enhancement: stable selection (no UI regression)
      if (opts?.keepSelection && selectedAxiomId) {
        const stillThere = rows.find((n) => n.id === selectedAxiomId);
        if (stillThere) return;
      }

      const summaries = rows.filter((n) => (n.note_type ?? "").toLowerCase() === "summary");
      const defaultPick = summaries[0] ?? rows[0] ?? null;
      setSelectedAxiomId(defaultPick?.id ?? null);
    } catch (e: any) {
      setAxiomNotes([]);
      setSelectedAxiomId(null);
      setAxiomErr(e?.message ?? "Failed to load AXIOM notes.");
    } finally {
      setAxiomLoading(false);
    }
  }

  useEffect(() => {
    if (workspaceTab !== "axiom") return;
    if (!selectedId) return;
    void loadAxiomNotes({ keepSelection: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceTab, selectedId]);

  // Run CI-Alchemy (Edge Function "scribe")
  async function handleRunAlchemy() {
    if (!title.trim() && !body.trim()) {
      flashError("Add a title or some context before running CI-Alchemy.");
      return;
    }
    if (selectedDraft && !canMutateSelected) {
      flashError("This draft is locked (finalized/ledger-linked). Create a new draft to run Alchemy.");
      return;
    }

    const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!baseUrl || !anonKey) return flashError("Missing Supabase URL or anon key in environment.");

    setAlchemyRunning(true);
    setError(null);
    setInfo(null);

    try {
      const { data: sessionData, error: sessionErr } = await supabase.auth.getSession();
      if (sessionErr) throw sessionErr;

      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) return flashError("Not authenticated. Please log in (OS auth gate).");

      // ✅ Ensure we have a REAL governance_drafts row to write into.
      const ensureDraftRow = async (): Promise<string> => {
        if (selectedId) return selectedId;

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
          title: title.trim() || "(untitled)",
          draft_text: body || "",
          record_type: "resolution",
          status: "draft" as DraftStatus,
          is_test: isSandbox,
        };

        const insertTry = await supabase
          .from("governance_drafts")
          .insert(basePayload)
          .select(
            `
              id, entity_id, entity_slug, entity_name, title, record_type, draft_text,
              status, created_at, updated_at, finalized_record_id, is_test
            `
          )
          .single();

        if (insertTry.error) {
          if (isMissingColumnErr(insertTry.error)) {
            delete basePayload.is_test;
            const retry = await supabase
              .from("governance_drafts")
              .insert(basePayload)
              .select(
                `
                  id, entity_id, entity_slug, entity_name, title, record_type, draft_text,
                  status, created_at, updated_at, finalized_record_id
                `
              )
              .single();
            if (retry.error) throw retry.error;
            const created = retry.data as DraftRecord;

            setSelectedId(created.id);
            setTitle(created.title ?? "");
            setBody(created.draft_text ?? "");
            markLoadedSnapshot(created.id, created.title ?? "", created.draft_text ?? "");
            return created.id;
          }
          throw insertTry.error;
        }

        const created = insertTry.data as DraftRecord;
        setSelectedId(created.id);
        setTitle(created.title ?? "");
        setBody(created.draft_text ?? "");
        markLoadedSnapshot(created.id, created.title ?? "", created.draft_text ?? "");
        return created.id;
      };

      const targetDraftId = await ensureDraftRow();

      const hasBody = body.trim().length > 0;
      const defaultTopic = title.trim() || "a governance matter";
      const instructions = hasBody
        ? body.trim()
        : "Draft a formal corporate resolution for " +
          String(activeEntityLabel) +
          ' about: "' +
          String(defaultTopic) +
          '".\nInclude WHEREAS recitals, clear RESOLVED clauses, and a signing block for directors.';

      const payload = {
        type: "board_resolution",
        entity_slug: activeEntity,
        entity_name: activeEntityLabel,
        title: title.trim() || "(untitled)",
        instructions,
        tone: "formal",
        language: "English",
        is_test: isSandbox,
        lane: isSandbox ? "SANDBOX" : "RoT",
        draft_id: targetDraftId,
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
        return flashError(`CI-Alchemy HTTP ${res.status}. See console for details.`);
      }

      const data = await res.json();
      if (!data?.ok) return flashError(`CI-Alchemy failed: ${data?.error || data?.stage || "Unknown error."}`);

      const draftText: string = data.draft_text || data.draft || data.content || data.text || "";
      if (!draftText?.trim()) return flashError("CI-Alchemy returned no usable draft body.");

      const producedTitle = (data.title || title.trim() || "(untitled)") as string;

      const updatePayload: any = {
        title: producedTitle,
        draft_text: draftText,
        record_type: data.record_type || "resolution",
        status: "draft" as DraftStatus,
        updated_at: new Date().toISOString(),
        is_test: isSandbox,
      };

      const updateTry = await supabase
        .from("governance_drafts")
        .update(updatePayload)
        .eq("id", targetDraftId)
        .select(
          `
            id, entity_id, entity_slug, entity_name, title, record_type, draft_text,
            status, created_at, updated_at, finalized_record_id, is_test
          `
        )
        .single();

      if (updateTry.error) {
        if (isMissingColumnErr(updateTry.error)) {
          delete updatePayload.is_test;
          const retry = await supabase
            .from("governance_drafts")
            .update(updatePayload)
            .eq("id", targetDraftId)
            .select(
              `
                id, entity_id, entity_slug, entity_name, title, record_type, draft_text,
                status, created_at, updated_at, finalized_record_id
              `
            )
            .single();
          if (retry.error) throw retry.error;

          const updated = retry.data as DraftRecord;
          setSelectedId(updated.id);
          setTitle(updated.title ?? "");
          setBody(updated.draft_text ?? "");
          setWorkspaceTab("editor");
          markLoadedSnapshot(updated.id, updated.title ?? "", updated.draft_text ?? "");
          flashInfo("Alchemy draft applied. Review, edit, then Save/Finalize.");
          await reloadDrafts(true);
          return;
        }
        throw updateTry.error;
      }

      const updated = updateTry.data as DraftRecord;
      setSelectedId(updated.id);
      setTitle(updated.title ?? "");
      setBody(updated.draft_text ?? "");
      setWorkspaceTab("editor");
      markLoadedSnapshot(updated.id, updated.title ?? "", updated.draft_text ?? "");

      flashInfo("Alchemy draft applied. Review, edit, then Save/Finalize.");
      await reloadDrafts(true);
    } catch (err: any) {
      console.error("scribe invoke exception", err);
      flashError(err?.message ?? "Network error calling CI-Alchemy (scribe).");
    } finally {
      setAlchemyRunning(false);
    }
  }

  // AXIOM pre-draft review
  async function handleAxiomReview() {
    if (!selectedId) return flashError("Select a draft first.");
    if (!canMutateSelected) return flashError("This draft left Alchemy. Draft-stage AXIOM runs pre-finalize only.");
    if (!title.trim() || !body.trim()) return flashError("Title + body required (save first).");

    const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!baseUrl || !anonKey) return flashError("Missing Supabase URL or anon key in environment.");

    setAxiomRunning(true);
    setError(null);
    setInfo(null);

    try {
      const { data: sessionData, error: sessionErr } = await supabase.auth.getSession();
      if (sessionErr) throw sessionErr;

      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) return flashError("Not authenticated. Please log in (OS auth gate).");

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

      const raw = await res.text();
      let data: any = null;
      try {
        data = JSON.parse(raw);
      } catch {}

      if (!res.ok) {
        console.error("axiom-pre-draft-review HTTP error", res.status, raw);
        return flashError(`AXIOM Review HTTP ${res.status}. See console.`);
      }
      if (!data?.ok) return flashError(data?.error || "AXIOM review failed.");

      const noteId = data?.note_id || data?.ai_note_id || data?.id || null;
      flashInfo(noteId ? `AXIOM Review saved (note_id=${noteId}).` : "AXIOM Review saved.");

      setWorkspaceTab("axiom");
      await loadAxiomNotes({ keepSelection: false });
      if (noteId) setSelectedAxiomId(String(noteId));
    } catch (err: any) {
      console.error("axiom review invoke exception", err);
      flashError(err?.message ?? "Network error calling AXIOM Review.");
    } finally {
      setAxiomRunning(false);
    }
  }

  async function handleSaveDraft() {
    if (!title.trim() || !body.trim()) return flashError("Title and body are required to save a draft.");
    if (selectedDraft?.status === "finalized") return flashError("This draft is finalized. Create a new revision instead.");

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
          .insert({ ...basePayload, status: "draft" as DraftStatus })
          .select(
            `
              id, entity_id, entity_slug, entity_name, title, record_type, draft_text,
              status, created_at, updated_at, finalized_record_id, is_test
            `
          )
          .single();

        if (insertTry.error) {
          if (isMissingColumnErr(insertTry.error)) {
            delete basePayload.is_test;
            const retry = await supabase
              .from("governance_drafts")
              .insert({ ...basePayload, status: "draft" as DraftStatus })
              .select(
                `
                  id, entity_id, entity_slug, entity_name, title, record_type, draft_text,
                  status, created_at, updated_at, finalized_record_id
                `
              )
              .single();
            if (retry.error) throw retry.error;

            const newDraft = retry.data as DraftRecord;
            setDrafts((prev) => [newDraft, ...prev]);
            setSelectedId(newDraft.id);
            markLoadedSnapshot(newDraft.id, newDraft.title ?? "", newDraft.draft_text ?? "");
            flashInfo("Draft created.");
          } else throw insertTry.error;
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
          .update({ ...basePayload, updated_at: new Date().toISOString() })
          .eq("id", selectedId)
          .select(
            `
              id, entity_id, entity_slug, entity_name, title, record_type, draft_text,
              status, created_at, updated_at, finalized_record_id, is_test
            `
          )
          .single();

        if (updateTry.error) {
          if (isMissingColumnErr(updateTry.error)) {
            delete basePayload.is_test;
            const retry = await supabase
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
            if (retry.error) throw retry.error;

            const updated = retry.data as DraftRecord;
            setDrafts((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
            markLoadedSnapshot(updated.id, updated.title ?? "", updated.draft_text ?? "");
            flashInfo("Draft saved.");
          } else throw updateTry.error;
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
    if (!canMutateSelected) return flashError("This draft has left Alchemy and can’t be changed here.");

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
            id, entity_id, entity_slug, entity_name, title, record_type, draft_text,
            status, created_at, updated_at, finalized_record_id, is_test
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
                id, entity_id, entity_slug, entity_name, title, record_type, draft_text,
                status, created_at, updated_at, finalized_record_id
              `
            )
            .single();
          if (retry.error) throw retry.error;

          const updated = retry.data as DraftRecord;
          setDrafts((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
          markLoadedSnapshot(updated.id, updated.title ?? "", updated.draft_text ?? "");
          flashInfo("Marked as reviewed.");
        } else throw tryUpd.error;
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

  // ✅ FINALIZE = Edge Function only (alchemy-finalize). NO direct governance_ledger inserts.
  async function handleFinalize() {
    if (!selectedId) return flashError("Select a draft first.");

    const draft = drafts.find((d) => d.id === selectedId);
    if (!draft) return flashError("Draft not found.");

    if (!title.trim() || !body.trim()) return flashError("Title and body are required before finalizing.");
    if (draft.status === "finalized") return flashInfo("Already finalized.");
    if (draft.finalized_record_id) return flashError("This draft is already linked to a ledger record.");
    if (!canMutateSelected) return flashError("This draft has left Alchemy and can’t be finalized here.");

    if (typeof draft.is_test === "boolean" && draft.is_test !== isSandbox) {
      return flashError("Lane mismatch: this draft belongs to the other environment.");
    }

    const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!baseUrl || !anonKey) return flashError("Missing Supabase URL or anon key in environment.");

    setFinalizing(true);
    setError(null);
    setInfo(null);

    try {
      if (dirty) {
        await handleSaveDraft();
      }

      const { data: sessionData, error: sessionErr } = await supabase.auth.getSession();
      if (sessionErr) throw sessionErr;

      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) return flashError("Not authenticated. Please log in (OS auth gate).");

      const res = await fetch(`${baseUrl}/functions/v1/alchemy-finalize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: anonKey,
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          draft_id: selectedId,
          is_test: isSandbox,
        }),
      });

      const raw = await res.text();
      let data: any = null;
      try {
        data = JSON.parse(raw);
      } catch {}

      if (!res.ok) {
        console.error("alchemy-finalize HTTP error", res.status, raw);
        return flashError(`Finalize HTTP ${res.status}: ${data?.error || "See console."}`);
      }

      if (!data?.ok) {
        console.error("alchemy-finalize failed payload", data);
        return flashError(data?.error || "Finalize failed.");
      }

      flashInfo("Finalized → Council queue.");
      await reloadDrafts(true);
    } catch (err: any) {
      console.error("finalize exception", err);
      flashError(err?.message ?? "Failed to finalize.");
    } finally {
      setFinalizing(false);
    }
  }

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
    // ✅ NO schema assumptions: do NOT write discard_reason / discarded_at unless you know they exist.
    const baseUpdate: any = {
      status: "discarded" as DraftStatus,
      updated_at: new Date().toISOString(),
      is_test: isSandbox,
    };

    const tryUpd = await supabase
      .from("governance_drafts")
      .update(baseUpdate)
      .eq("id", draftId)
      .select(
        `
          id, entity_id, entity_slug, entity_name, title, record_type, draft_text,
          status, created_at, updated_at, finalized_record_id, is_test
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
              id, entity_id, entity_slug, entity_name, title, record_type, draft_text,
              status, created_at, updated_at, finalized_record_id
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
      {
        p_draft_id: draftId,
        p_reason: reason || null,
      } as any
    );
    if (!tryTwo.error) return;

    const tryOne = await supabase.rpc("owner_delete_governance_draft", { p_draft_id: draftId } as any);
    if (!tryOne.error) return;

    const tryAlt = await supabase.rpc(
      "owner_delete_governance_draft",
      {
        draft_id: draftId,
        reason: reason || null,
      } as any
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
          : (drafts.map((d) => (d.id === selectedId ? { ...d, status: "discarded" as DraftStatus } : d)) as DraftRecord[]);

      const next = pickDefaultSelection(nextRows);
      if (next) {
        setSelectedId(next.id);
        setTitle(next.title ?? "");
        setBody(next.draft_text ?? "");
        setWorkspaceTab("editor");
        setSelectedAxiomId(null);
        setAxiomNotes([]);
        setAxiomErr(null);
        setAxiomLastRefresh(null);
        markLoadedSnapshot(next.id, next.title ?? "", next.draft_text ?? "");
      } else {
        setSelectedId(null);
        setTitle("");
        setBody("");
        setWorkspaceTab("editor");
        setSelectedAxiomId(null);
        setAxiomNotes([]);
        setAxiomErr(null);
        setAxiomLastRefresh(null);
        markLoadedSnapshot(null, "", "");
      }
    } catch (err: any) {
      flashError(err?.message ?? "Delete failed.");
    } finally {
      setDeleteBusy(false);
    }
  }

  function onTitleChange(v: string) {
    setTitle(v);
    setDirty(computeDirty(v, body, selectedId));
  }
  function onBodyChange(v: string) {
    setBody(v);
    setDirty(computeDirty(title, v, selectedId));
  }

  const editorCard =
    editorTheme === "light" ? "bg-white text-slate-900 border-slate-200" : "bg-slate-950/70 text-slate-100 border-slate-800";

  const inputBase =
    editorTheme === "light"
      ? "bg-white border-slate-200 text-slate-900 placeholder:text-slate-400 focus:border-emerald-500"
      : "bg-slate-900/80 border-slate-700 text-slate-100 placeholder:text-slate-500 focus:border-emerald-400";

  const textareaBase =
    editorTheme === "light"
      ? "bg-white border-slate-200 text-slate-900 focus:border-emerald-500"
      : "bg-slate-900/80 border-slate-700 text-slate-100 focus:border-emerald-400";

  const readerMode = workspaceTab === "axiom" ? "axiom" : "draft";
  const readerTitle =
    readerMode === "axiom" ? selectedAxiomNote?.title || "AXIOM Snapshot" : selectedDraft?.title || title || "(untitled)";
  const readerMetaLine =
    readerMode === "axiom"
      ? `${fmtShort(selectedAxiomNote?.created_at ?? null)} • model: ${selectedAxiomNote?.model || "—"} • tokens: ${
          selectedAxiomNote?.tokens_used ?? "—"
        }`
      : `${selectedDraft ? `${selectedDraft.status.toUpperCase()} • ${fmtShort(selectedDraft.created_at)}` : "—"}`;
  const readerBody =
    readerMode === "axiom"
      ? selectedAxiomNote?.content || "No AXIOM summary yet. Run AXIOM to generate one."
      : selectedDraft
      ? selectedDraft.draft_text ?? ""
      : body ?? "";

  // ✅ Provisioning/Council-consistent card shell
  const cardShell =
    "rounded-3xl border border-white/10 bg-black/20 shadow-[0_28px_120px_rgba(0,0,0,0.55)] overflow-hidden flex flex-col";
  const cardHeader = "shrink-0 border-b border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent";
  const cardBody = "flex-1 min-h-0 overflow-hidden";

  return (
    <div className="w-full">
      <div className="mx-auto w-full max-w-[1400px] px-4 pb-8 pt-4 sm:pt-6">
        <div className="mb-4">
          <div className="text-[10px] sm:text-xs tracking-[0.3em] uppercase text-slate-500">CI • Alchemy</div>
          <h1 className="mt-1 text-lg sm:text-xl font-semibold text-slate-50">Drafting Console · AI Scribe</h1>
          <p className="mt-1 text-[11px] sm:text-xs text-slate-400 max-w-3xl leading-relaxed">
            Draft safely inside Alchemy. <span className="text-emerald-300 font-semibold">Finalize</span> promotes into
            Council (governance_ledger status=PENDING).
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-400">
            <span>
              Entity: <span className="text-emerald-300 font-medium">{activeEntityLabel}</span>
            </span>
            <span className="text-slate-700">•</span>
            <span>
              Lane:{" "}
              <span className={cx("font-semibold", isSandbox ? "text-amber-300" : "text-sky-300")}>{env}</span>
            </span>
            {selectedDraft?.finalized_record_id && (
              <>
                <span className="text-slate-700">•</span>
                <span className="text-emerald-200">Ledger-linked</span>
              </>
            )}
            {dirty && (
              <>
                <span className="text-slate-700">•</span>
                <span className="text-amber-200">Unsaved edits</span>
              </>
            )}
          </div>
        </div>

        <div className={cx(cardShell, "mb-4")}>
          <div className={cx(cardHeader, "px-4 sm:px-6 pt-4 sm:pt-5 pb-3")}>
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
              <div className="inline-flex w-full lg:w-auto rounded-full bg-slate-950/70 border border-slate-800 p-1 overflow-x-auto no-scrollbar">
                <StatusTabButton label="Drafts" active={statusTab === "draft"} onClick={() => setStatusTab("draft")} />
                <StatusTabButton label="Reviewed" active={statusTab === "reviewed"} onClick={() => setStatusTab("reviewed")} />
                <StatusTabButton label="Finalized" active={statusTab === "finalized"} onClick={() => setStatusTab("finalized")} />
                <StatusTabButton
                  label="Discarded"
                  active={statusTab === "discarded"}
                  onClick={() => setStatusTab("discarded")}
                />
                <StatusTabButton label="All" active={statusTab === "all"} onClick={() => setStatusTab("all")} />
              </div>

              <div className="flex flex-wrap items-center gap-2 justify-between lg:justify-end">
                <button
                  onClick={() => setDrawerOpen((v) => !v)}
                  className="rounded-full border border-slate-800 bg-slate-950/55 px-4 py-2 text-[10px] sm:text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60"
                  title="Toggle drafts drawer"
                >
                  {drawerOpen ? "Hide Drafts" : "Show Drafts"}
                </button>

                <div className="inline-flex rounded-full border border-slate-800 bg-slate-950/55 p-1 text-[10px] uppercase tracking-[0.18em]">
                  <button
                    onClick={() => setEditorTheme("light")}
                    className={cx(
                      "rounded-full px-3 py-1.5 transition",
                      editorTheme === "light" ? "bg-white text-black" : "text-slate-400 hover:bg-slate-900/60"
                    )}
                  >
                    Paper
                  </button>
                  <button
                    onClick={() => setEditorTheme("dark")}
                    className={cx(
                      "rounded-full px-3 py-1.5 transition",
                      editorTheme === "dark" ? "bg-emerald-500 text-black" : "text-slate-400 hover:bg-slate-900/60"
                    )}
                  >
                    Noir
                  </button>
                </div>

                <button
                  onClick={() => {
                    if (workspaceTab === "axiom") {
                      if (!selectedId) return flashError("Select a draft first.");
                      setReaderOpen(true);
                      return;
                    }
                    if (!selectedDraft && !body.trim()) return flashError("Select a draft (or write) first.");
                    setReaderOpen(true);
                  }}
                  className="rounded-full border border-emerald-400/60 bg-emerald-500/10 px-4 py-2 text-[10px] sm:text-[11px] font-semibold tracking-[0.18em] uppercase text-emerald-200 hover:bg-emerald-500/15"
                >
                  Open Reader
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-12 gap-4">
          {drawerOpen ? (
            <aside className={cx(cardShell, "col-span-12 lg:col-span-4")}>
              <div className={cx(cardHeader, "p-4")}>
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

              <div className={cx(cardBody, "flex flex-col")}>
                <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar">
                  {loading ? (
                    <div className="p-4 text-[13px] text-slate-400">Loading…</div>
                  ) : filteredDrafts.length === 0 ? (
                    <div className="p-4 text-[13px] text-slate-500">No drafts for this filter.</div>
                  ) : (
                    <ul className="divide-y divide-white/10">
                      {filteredDrafts.map((d) => (
                        <li
                          key={d.id}
                          onClick={() => handleSelectDraft(d)}
                          className={cx("cursor-pointer px-4 py-3 transition", "hover:bg-white/5", d.id === selectedId && "bg-white/7")}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-[13px] font-semibold text-slate-100">{d.title || "(untitled)"}</div>
                              <div className="mt-1 text-[11px] text-slate-500">
                                {fmtShort(d.created_at)} · {d.record_type || "resolution"}
                              </div>
                              <div className="mt-2 line-clamp-2 text-[12px] leading-relaxed text-slate-400">{d.draft_text}</div>
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
                            <div className="mt-2 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-[11px] text-slate-400">
                              Ledger-linked (locked)
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="shrink-0 p-3 border-t border-white/10 flex items-center justify-between text-[10px] text-slate-500">
                  <span>governance_drafts</span>
                  <button
                    onClick={handleNewDraft}
                    className="rounded-full border border-white/10 bg-black/20 px-3 py-1.5 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-black/30"
                  >
                    New
                  </button>
                </div>
              </div>
            </aside>
          ) : null}

          <main className={cx(cardShell, drawerOpen ? "col-span-12 lg:col-span-8" : "col-span-12")}>
            <div className={cx(cardHeader, "p-4 sm:p-5")}>
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                      Workspace
                      {selectedDraft?.status ? (
                        <>
                          <span className="mx-2 text-slate-700">•</span>
                          <span className="text-slate-200">{selectedDraft.status.toUpperCase()}</span>
                        </>
                      ) : null}
                    </div>
                    <div className="mt-1 text-[12px] text-slate-500">
                      {selectedDraft ? fmtShort(selectedDraft.updated_at || selectedDraft.created_at) : "New draft"}
                      <span className="mx-2 text-slate-700">•</span>
                      <span className={cx(isSandbox ? "text-amber-300" : "text-sky-300")}>{env}</span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <div className="inline-flex rounded-full border border-slate-800 bg-slate-950/55 p-1 text-[10px] uppercase tracking-[0.18em]">
                      <button
                        onClick={() => setWorkspaceTab("editor")}
                        className={cx(
                          "rounded-full px-3 py-1.5 transition",
                          workspaceTab === "editor" ? "bg-white/10 text-slate-100 border border-white/10" : "text-slate-400 hover:bg-slate-900/60"
                        )}
                      >
                        Draft
                      </button>
                      <button
                        onClick={() => setWorkspaceTab("axiom")}
                        className={cx(
                          "rounded-full px-3 py-1.5 transition",
                          workspaceTab === "axiom"
                            ? "bg-emerald-500/15 text-emerald-200 border border-emerald-400/20"
                            : "text-slate-400 hover:bg-slate-900/60"
                        )}
                      >
                        AXIOM
                      </button>
                    </div>

                    <button
                      onClick={handleSaveDraft}
                      disabled={saving || finalizing || alchemyRunning || axiomRunning || !title.trim() || !body.trim()}
                      className={cx(
                        "rounded-full px-4 py-2 text-[10px] sm:text-[11px] font-semibold tracking-[0.18em] uppercase border",
                        saving || finalizing || alchemyRunning || axiomRunning || !title.trim() || !body.trim()
                          ? "border-white/10 bg-white/5 text-slate-500 cursor-not-allowed"
                          : "border-white/15 bg-white/7 text-slate-100 hover:bg-white/10"
                      )}
                    >
                      {saving ? "Saving…" : selectedId ? "Save" : "Create"}
                    </button>

                    <button
                      onClick={handleMarkReviewed}
                      disabled={saving || finalizing || alchemyRunning || axiomRunning || !selectedId || !canMutateSelected}
                      className={cx(
                        "rounded-full px-4 py-2 text-[10px] sm:text-[11px] font-semibold tracking-[0.18em] uppercase border",
                        saving || finalizing || alchemyRunning || axiomRunning || !selectedId || !canMutateSelected
                          ? "border-white/10 bg-white/5 text-slate-500 cursor-not-allowed"
                          : "border-amber-400/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/15"
                      )}
                    >
                      Mark Reviewed
                    </button>

                    <button
                      onClick={handleFinalize}
                      disabled={finalizing || saving || alchemyRunning || axiomRunning || !selectedId || !canMutateSelected}
                      className={cx(
                        "rounded-full px-4 py-2 text-[10px] sm:text-[11px] font-semibold tracking-[0.18em] uppercase border",
                        finalizing || saving || alchemyRunning || axiomRunning || !selectedId || !canMutateSelected
                          ? "border-white/10 bg-white/5 text-slate-500 cursor-not-allowed"
                          : "border-emerald-400/50 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/15"
                      )}
                      title="Finalize promotes this draft into governance_ledger (PENDING) via alchemy-finalize Edge Function"
                    >
                      {finalizing ? "Finalizing…" : "Finalize"}
                    </button>

                    <button
                      onClick={openDelete}
                      disabled={!selectedId || !selectedDraft || !canMutateSelected}
                      className={cx(
                        "rounded-full px-4 py-2 text-[10px] sm:text-[11px] font-semibold tracking-[0.18em] uppercase border",
                        !selectedId || !selectedDraft || !canMutateSelected
                          ? "border-white/10 bg-white/5 text-slate-500 cursor-not-allowed"
                          : "border-rose-400/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/15"
                      )}
                    >
                      Delete
                    </button>
                  </div>
                </div>

                {error ? (
                  <div className="rounded-2xl border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-[12px] text-rose-100">
                    {error}
                  </div>
                ) : null}
                {info ? (
                  <div className="rounded-2xl border border-emerald-400/20 bg-emerald-500/10 px-4 py-3 text-[12px] text-emerald-100">
                    {info}
                  </div>
                ) : null}
              </div>
            </div>

            <div className={cx(cardBody, "flex flex-col")}>
              <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar p-4 sm:p-6">
                {workspaceTab === "editor" ? (
                  <div className="space-y-4">
                    <div className={cx("rounded-3xl border shadow-sm overflow-hidden", editorCard)}>
                      <div className="border-b border-black/10 px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                        <div className="text-[10px] uppercase tracking-[0.25em] font-semibold text-slate-500">Draft Editor</div>

                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            onClick={handleRunAlchemy}
                            disabled={alchemyRunning || finalizing || saving || axiomRunning}
                            className={cx(
                              "rounded-full px-4 py-2 text-[10px] sm:text-[11px] font-semibold tracking-[0.18em] uppercase border",
                              alchemyRunning || finalizing || saving || axiomRunning
                                ? "border-black/10 bg-black/5 text-slate-400 cursor-not-allowed"
                                : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/15"
                            )}
                            title="Run CI-Alchemy (scribe) to generate a structured resolution draft"
                          >
                            {alchemyRunning ? "Running…" : "Run Alchemy"}
                          </button>

                          <button
                            onClick={handleAxiomReview}
                            disabled={
                              axiomRunning ||
                              finalizing ||
                              saving ||
                              alchemyRunning ||
                              !selectedId ||
                              !canMutateSelected ||
                              !title.trim() ||
                              !body.trim()
                            }
                            className={cx(
                              "rounded-full px-4 py-2 text-[10px] sm:text-[11px] font-semibold tracking-[0.18em] uppercase border",
                              axiomRunning ||
                                finalizing ||
                                saving ||
                                alchemyRunning ||
                                !selectedId ||
                                !canMutateSelected ||
                                !title.trim() ||
                                !body.trim()
                                ? "border-black/10 bg-black/5 text-slate-400 cursor-not-allowed"
                                : "border-slate-300 bg-slate-50 text-slate-700 hover:bg-slate-100"
                            )}
                            title="Run AXIOM pre-draft review (writes to ai_notes only)"
                          >
                            {axiomRunning ? "Running…" : "Run AXIOM"}
                          </button>
                        </div>
                      </div>

                      <div className="p-4 sm:p-5 space-y-4">
                        <div>
                          <label className="block text-[10px] uppercase tracking-[0.25em] font-semibold text-slate-500">Title</label>
                          <input
                            className={cx("mt-2 w-full rounded-2xl border px-4 py-3 text-[14px] outline-none", inputBase)}
                            placeholder="Resolution title…"
                            value={title}
                            onChange={(e) => onTitleChange(e.target.value)}
                            disabled={!canMutateSelected}
                          />
                        </div>

                        <div>
                          <label className="block text-[10px] uppercase tracking-[0.25em] font-semibold text-slate-500">Draft Body</label>
                          <textarea
                            className={cx(
                              "mt-2 w-full rounded-2xl border px-4 py-3 text-[13px] leading-relaxed outline-none min-h-[360px] sm:min-h-[520px]",
                              textareaBase
                            )}
                            placeholder="Write or generate a draft…"
                            value={body}
                            onChange={(e) => onBodyChange(e.target.value)}
                            disabled={!canMutateSelected}
                          />
                          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
                            <span>{selectedDraft ? `Draft: ${selectedDraft.id.slice(0, 8)}…` : "New draft (not saved)"}</span>
                            <span>
                              {dirty ? <span className="text-amber-600 font-semibold">Unsaved</span> : <span className="text-emerald-600 font-semibold">Saved</span>}
                            </span>
                          </div>
                        </div>

                        {!canMutateSelected ? (
                          <div className="rounded-2xl border border-amber-400/30 bg-amber-200/30 px-4 py-3 text-[12px] text-slate-700">
                            This draft is locked (finalized / ledger-linked). Create a new draft to continue editing.
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                        AXIOM Notes
                        {axiomLastRefresh ? (
                          <span className="ml-2 text-slate-600 normal-case tracking-normal font-medium">refreshed {fmtShort(axiomLastRefresh)}</span>
                        ) : null}
                      </div>

                      <button
                        onClick={() => loadAxiomNotes({ keepSelection: true })}
                        disabled={axiomLoading || !selectedId}
                        className={cx(
                          "rounded-full border px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase",
                          axiomLoading || !selectedId
                            ? "border-white/10 bg-white/5 text-slate-500 cursor-not-allowed"
                            : "border-white/15 bg-white/7 text-slate-100 hover:bg-white/10"
                        )}
                      >
                        {axiomLoading ? "Loading…" : "Refresh AXIOM"}
                      </button>
                    </div>

                    {axiomErr ? (
                      <div className="rounded-2xl border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-[12px] text-rose-100">
                        {axiomErr}
                      </div>
                    ) : null}

                    <div className="grid grid-cols-12 gap-4">
                      <div className="col-span-12 lg:col-span-5">
                        <div className={cx(cardShell)}>
                          <div className={cx(cardHeader, "px-4 py-3")}>
                            <div className="text-[10px] uppercase tracking-[0.25em] font-semibold text-slate-400">History</div>
                          </div>
                          <div className={cx(cardBody, "flex flex-col")}>
                            <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar">
                              {!selectedId ? (
                                <div className="p-4 text-[13px] text-slate-500">Select a draft first.</div>
                              ) : axiomLoading ? (
                                <div className="p-4 text-[13px] text-slate-400">Loading…</div>
                              ) : axiomNotes.length === 0 ? (
                                <div className="p-4 text-[13px] text-slate-500">No AXIOM notes yet. Run AXIOM to generate a summary.</div>
                              ) : (
                                <ul className="divide-y divide-white/10">
                                  {axiomNotes.map((n) => {
                                    const active = selectedAxiomNote?.id === n.id;
                                    return (
                                      <li
                                        key={n.id}
                                        onClick={() => setSelectedAxiomId(n.id)}
                                        className={cx("px-4 py-3 cursor-pointer", active ? "bg-white/7" : "hover:bg-white/5")}
                                        title="Select note"
                                      >
                                        <div className="flex items-start justify-between gap-2">
                                          <div className="min-w-0 flex-1">
                                            <div className="truncate text-[13px] font-semibold text-slate-100">{n.title || "AXIOM Note"}</div>
                                            <div className="mt-1 text-[11px] text-slate-500">
                                              {fmtShort(n.created_at)}
                                              <span className="mx-2 text-slate-700">•</span>
                                              {n.note_type || "note"}
                                            </div>
                                            <div className="mt-2 line-clamp-2 text-[12px] leading-relaxed text-slate-400">{n.content || ""}</div>
                                          </div>
                                          <span className="shrink-0 rounded-full px-2 py-1 text-[9px] uppercase tracking-[0.18em] bg-emerald-500/15 text-emerald-200">
                                            {n.note_type || "note"}
                                          </span>
                                        </div>
                                      </li>
                                    );
                                  })}
                                </ul>
                              )}
                            </div>

                            <div className="shrink-0 p-3 border-t border-white/10 text-[10px] text-slate-500">
                              ai_notes • scope=document • scope_id=draft
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="col-span-12 lg:col-span-7">
                        <div className={cx(cardShell, "h-full")}>
                          <div className={cx(cardHeader, "px-4 py-3")}>
                            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                              <div className="min-w-0">
                                <div className="truncate text-[13px] font-semibold text-slate-100">{selectedAxiomNote?.title || "AXIOM Snapshot"}</div>
                                <div className="mt-1 text-[11px] text-slate-500">
                                  {selectedAxiomNote ? (
                                    <>
                                      {fmtShort(selectedAxiomNote.created_at)}
                                      <span className="mx-2 text-slate-700">•</span>
                                      model: {selectedAxiomNote.model || "—"}
                                      <span className="mx-2 text-slate-700">•</span>
                                      tokens: {selectedAxiomNote.tokens_used ?? "—"}
                                    </>
                                  ) : (
                                    "—"
                                  )}
                                </div>
                              </div>

                              <button
                                onClick={() => setReaderOpen(true)}
                                disabled={!selectedId}
                                className={cx(
                                  "rounded-full border px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase",
                                  !selectedId
                                    ? "border-white/10 bg-white/5 text-slate-500 cursor-not-allowed"
                                    : "border-emerald-400/60 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/15"
                                )}
                              >
                                Open Reader
                              </button>
                            </div>
                          </div>

                          <div className={cx(cardBody, "p-4 sm:p-5")}>
                            <div className="rounded-3xl border border-white/10 bg-black/20 p-4 sm:p-5 shadow-inner">
                              <div className="prose prose-invert max-w-none prose-p:leading-relaxed prose-pre:bg-black/30">
                                <pre className="whitespace-pre-wrap break-words text-[12px] sm:text-[13px] leading-relaxed">
{selectedAxiomNote?.content || "No AXIOM summary yet. Run AXIOM to generate one."}
                                </pre>
                              </div>
                            </div>
                            <div className="mt-3 text-[11px] text-slate-500">AXIOM is advisory (sidecar). It never alters drafts or resolution templates.</div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="shrink-0 border-t border-white/10 px-4 py-3 text-[10px] text-slate-500 flex flex-wrap items-center justify-between gap-2">
                <span>
                  Mutations are RPC/Edge only · Finalize → <span className="text-emerald-300">Council</span>
                </span>
                <span className="text-slate-600">
                  Draft-stage AI → <span className="text-slate-300">ai_notes</span> (scope=document)
                </span>
              </div>
            </div>
          </main>
        </div>
      </div>

      {/* Reader Modal */}
      {readerOpen ? (
        <div className="fixed inset-0 z-[80]">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setReaderOpen(false)} />
          <div className="absolute inset-x-0 bottom-0 top-10 sm:top-14 mx-auto max-w-5xl px-3 pb-3">
            <div className="h-full rounded-3xl border border-white/10 bg-black/40 shadow-[0_30px_140px_rgba(0,0,0,0.75)] overflow-hidden flex flex-col">
              <div className="shrink-0 border-b border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent px-4 sm:px-6 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-[0.25em] font-semibold text-slate-400">
                      Reader • {readerMode === "axiom" ? "AXIOM" : "Draft"}
                    </div>
                    <div className="mt-1 truncate text-[14px] sm:text-[16px] font-semibold text-slate-50">{readerTitle}</div>
                    <div className="mt-1 text-[11px] text-slate-500">{readerMetaLine}</div>
                  </div>

                  <div className="flex items-center gap-2">
                    <div className="inline-flex rounded-full border border-slate-800 bg-slate-950/55 p-1 text-[10px] uppercase tracking-[0.18em]">
                      <button
                        onClick={() => setWorkspaceTab("editor")}
                        className={cx(
                          "rounded-full px-3 py-1.5 transition",
                          workspaceTab === "editor" ? "bg-white/10 text-slate-100 border border-white/10" : "text-slate-400 hover:bg-slate-900/60"
                        )}
                      >
                        Draft
                      </button>
                      <button
                        onClick={() => setWorkspaceTab("axiom")}
                        className={cx(
                          "rounded-full px-3 py-1.5 transition",
                          workspaceTab === "axiom"
                            ? "bg-emerald-500/15 text-emerald-200 border border-emerald-400/20"
                            : "text-slate-400 hover:bg-slate-900/60"
                        )}
                      >
                        AXIOM
                      </button>
                    </div>

                    <button
                      onClick={() => setReaderOpen(false)}
                      className="rounded-full border border-white/10 bg-black/20 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-black/30"
                    >
                      Close
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar p-4 sm:p-6">
                <div className="rounded-3xl border border-white/10 bg-black/20 p-4 sm:p-6 shadow-inner">
                  <pre className="whitespace-pre-wrap break-words text-[12px] sm:text-[13px] leading-relaxed text-slate-100">
{readerBody || "—"}
                  </pre>
                </div>

                <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
                  <span>
                    Lane:{" "}
                    <span className={cx("font-semibold", isSandbox ? "text-amber-300" : "text-sky-300")}>{env}</span>
                  </span>
                  <span>Reader is non-mutating.</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Delete Modal */}
      {deleteOpen ? (
        <div className="fixed inset-0 z-[90]">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setDeleteOpen(false)} />
          <div className="absolute inset-x-0 bottom-0 top-14 mx-auto max-w-xl px-3 pb-3">
            <div className="h-full rounded-3xl border border-white/10 bg-black/40 shadow-[0_30px_140px_rgba(0,0,0,0.75)] overflow-hidden flex flex-col">
              <div className="shrink-0 border-b border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent px-4 sm:px-6 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-[0.25em] font-semibold text-slate-400">Delete Draft</div>
                    <div className="mt-1 truncate text-[14px] sm:text-[16px] font-semibold text-slate-50">{selectedDraft?.title || "(untitled)"}</div>
                    <div className="mt-1 text-[11px] text-slate-500">
                      Soft delete = status “discarded”. Hard delete = RPC owner_delete_governance_draft.
                    </div>
                  </div>

                  <button
                    onClick={() => setDeleteOpen(false)}
                    className="rounded-full border border-white/10 bg-black/20 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-black/30"
                  >
                    Close
                  </button>
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar p-4 sm:p-6 space-y-4">
                <div className="inline-flex w-full rounded-2xl border border-slate-800 bg-slate-950/55 p-1 text-[10px] uppercase tracking-[0.18em]">
                  <button
                    onClick={() => setDeleteMode("soft")}
                    className={cx(
                      "flex-1 rounded-xl px-3 py-2 transition",
                      deleteMode === "soft" ? "bg-white/10 text-slate-100 border border-white/10" : "text-slate-400 hover:bg-slate-900/60"
                    )}
                  >
                    Soft (Discard)
                  </button>
                  <button
                    onClick={() => setDeleteMode("hard")}
                    className={cx(
                      "flex-1 rounded-xl px-3 py-2 transition",
                      deleteMode === "hard"
                        ? "bg-rose-500/15 text-rose-200 border border-rose-400/20"
                        : "text-slate-400 hover:bg-slate-900/60"
                    )}
                  >
                    Hard (Permanent)
                  </button>
                </div>

                <div>
                  <label className="block text-[10px] uppercase tracking-[0.25em] font-semibold text-slate-400">Reason (optional)</label>
                  <textarea
                    className="mt-2 w-full rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-[13px] text-slate-100 outline-none focus:border-emerald-400 min-h-[120px]"
                    placeholder="Why are you removing this draft?"
                    value={deleteReason}
                    onChange={(e) => setDeleteReason(e.target.value)}
                    disabled={deleteBusy}
                  />
                </div>

                {deleteMode === "hard" ? (
                  <div className="rounded-2xl border border-rose-400/25 bg-rose-500/10 px-4 py-3">
                    <div className="text-[12px] text-rose-100">
                      Hard delete is permanent. Type <span className="font-semibold">DELETE</span> to confirm.
                    </div>
                    <input
                      className="mt-3 w-full rounded-2xl border border-rose-400/30 bg-black/30 px-4 py-3 text-[13px] text-rose-100 outline-none focus:border-rose-300"
                      placeholder='Type "DELETE"'
                      value={deleteConfirmText}
                      onChange={(e) => setDeleteConfirmText(e.target.value)}
                      disabled={deleteBusy}
                    />
                  </div>
                ) : (
                  <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-[12px] text-slate-300">
                    Soft delete keeps the draft for audit. It becomes <span className="font-semibold">discarded</span>.
                  </div>
                )}

                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    onClick={() => setDeleteOpen(false)}
                    disabled={deleteBusy}
                    className={cx(
                      "rounded-full border px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase",
                      deleteBusy ? "border-white/10 bg-white/5 text-slate-500 cursor-not-allowed" : "border-white/10 bg-black/20 text-slate-200 hover:bg-black/30"
                    )}
                  >
                    Cancel
                  </button>

                  <button
                    onClick={confirmDelete}
                    disabled={deleteBusy}
                    className={cx(
                      "rounded-full border px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase",
                      deleteBusy
                        ? "border-white/10 bg-white/5 text-slate-500 cursor-not-allowed"
                        : deleteMode === "hard"
                        ? "border-rose-400/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/15"
                        : "border-amber-400/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/15"
                    )}
                  >
                    {deleteBusy ? "Working…" : deleteMode === "hard" ? "Delete Permanently" : "Discard Draft"}
                  </button>
                </div>
              </div>

              <div className="shrink-0 border-t border-white/10 px-4 py-3 text-[10px] text-slate-500">
                Safety gates: ledger-linked drafts cannot be deleted here.
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ---------------- small UI atoms ---------------- */

function StatusTabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "rounded-full px-4 py-2 text-[10px] sm:text-[11px] font-semibold tracking-[0.18em] uppercase transition",
        active ? "bg-white/10 text-slate-100 border border-white/10" : "text-slate-400 hover:bg-slate-900/60"
      )}
    >
      {label}
    </button>
  );
}
