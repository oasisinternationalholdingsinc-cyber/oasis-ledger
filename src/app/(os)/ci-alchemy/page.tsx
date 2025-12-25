"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";

/* ============================
   Types
============================ */

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

/* ============================
   Helpers
============================ */

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
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function isMissingColumnErr(err: any) {
  const msg = (err?.message ?? "").toLowerCase();
  return msg.includes("does not exist") && msg.includes("column");
}

/* ============================
   Page
============================ */

export default function CIAlchemyPage() {
  /* ---- OS CONTEXT (AUTHORITATIVE) ---- */
  const { activeEntity } = useEntity();               // holdings | lounge | real-estate
  const { env, isSandbox } = useOsEnv();              // ROT | SANDBOX

  const activeEntityLabel =
    ENTITY_LABELS[activeEntity] ?? activeEntity;

  /* ---- Core state ---- */
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [alchemyRunning, setAlchemyRunning] = useState(false);

  const [drafts, setDrafts] = useState<DraftRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  /* ---- OS UX ---- */
  const [statusTab, setStatusTab] = useState<StatusTab>("draft");
  const [query, setQuery] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [readerOpen, setReaderOpen] = useState(false);
  const [editorTheme, setEditorTheme] = useState<"light" | "dark">("light");

  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  /* ---- Delete ---- */
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteMode, setDeleteMode] = useState<DeleteMode>("soft");
  const [deleteReason, setDeleteReason] = useState("");
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);

  /* ---- Dirty guard ---- */
  const [dirty, setDirty] = useState(false);
  const lastLoadedRef = useRef<{ id: string | null; title: string; body: string } | null>(null);

  const selectedDraft = useMemo(
    () => drafts.find((d: DraftRecord) => d.id === selectedId) ?? null,
    [drafts, selectedId]
  );

  const canMutateSelected = useMemo(() => {
    if (!selectedDraft) return true;
    return !selectedDraft.finalized_record_id && selectedDraft.status !== "finalized";
  }, [selectedDraft]);

  /* ============================
     Data loading
  ============================ */

  async function reloadDrafts(preserveSelected = true) {
    setLoading(true);
    setError(null);

    try {
      const { data, error } = await supabase
        .from("governance_drafts")
        .select(`
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
        `)
        .eq("entity_slug", activeEntity)
        .eq("is_test", isSandbox)
        .order("created_at", { ascending: false });

      if (error) throw error;

      const rows = (data ?? []) as DraftRecord[];
      setDrafts(rows);

      if (preserveSelected && selectedId) {
        const still = rows.find((d: DraftRecord) => d.id === selectedId);
        if (still) {
          setTitle(still.title ?? "");
          setBody(still.draft_text ?? "");
          markLoadedSnapshot(still.id, still.title ?? "", still.draft_text ?? "");
          return;
        }
      }

      const first = rows[0] ?? null;
      if (first) {
        setSelectedId(first.id);
        setTitle(first.title ?? "");
        setBody(first.draft_text ?? "");
        markLoadedSnapshot(first.id, first.title ?? "", first.draft_text ?? "");
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
    reloadDrafts(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEntity, isSandbox]);

  /* ============================
     Utils
  ============================ */

  function flashError(msg: string) {
    console.error(msg);
    setError(msg);
    setTimeout(() => setError(null), 6000);
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

  /* ============================
     Handlers
  ============================ */

  function onTitleChange(v: string) {
    setTitle(v);
    setDirty(computeDirty(v, body, selectedId));
  }

  function onBodyChange(v: string) {
    setBody(v);
    setDirty(computeDirty(title, v, selectedId));
  }

  function handleSelectDraft(d: DraftRecord) {
    if (dirty && !confirm("You have unsaved edits. Continue?")) return;
    setSelectedId(d.id);
    setTitle(d.title ?? "");
    setBody(d.draft_text ?? "");
    markLoadedSnapshot(d.id, d.title ?? "", d.draft_text ?? "");
  }

  function handleNewDraft() {
    if (dirty && !confirm("You have unsaved edits. Continue?")) return;
    setSelectedId(null);
    setTitle("");
    setBody("");
    markLoadedSnapshot(null, "", "");
  }

  /* ============================
     SAVE / REVIEW / FINALIZE
     (unchanged logic, env-safe)
  ============================ */

  async function handleSaveDraft() {
    if (!title.trim() || !body.trim()) {
      flashError("Title and body are required.");
      return;
    }

    setSaving(true);
    try {
      const { data: entityRow } = await supabase
        .from("entities")
        .select("id, name, slug")
        .eq("slug", activeEntity)
        .single();

      if (!entityRow) throw new Error("Entity not found");

      const payload: any = {
        entity_id: entityRow.id,
        entity_slug: activeEntity,
        entity_name: entityRow.name,
        title: title.trim(),
        draft_text: body,
        record_type: "resolution",
        is_test: isSandbox,
        updated_at: new Date().toISOString(),
      };

      if (!selectedId) {
        const { data, error } = await supabase
          .from("governance_drafts")
          .insert({ ...payload, status: "draft" })
          .select("*")
          .single();

        if (error) throw error;
        setDrafts((p) => [data as DraftRecord, ...p]);
        setSelectedId(data.id);
        markLoadedSnapshot(data.id, data.title, data.draft_text);
        flashInfo("Draft created.");
      } else {
        const { data, error } = await supabase
          .from("governance_drafts")
          .update(payload)
          .eq("id", selectedId)
          .select("*")
          .single();

        if (error) throw error;
        setDrafts((p) => p.map((d) => (d.id === data.id ? data : d)));
        markLoadedSnapshot(data.id, data.title, data.draft_text);
        flashInfo("Draft saved.");
      }
    } catch (e: any) {
      flashError(e.message);
    } finally {
      setSaving(false);
    }
  }

  /* ============================
     UI (unchanged enterprise shell)
  ============================ */

  const editorCard =
    editorTheme === "light"
      ? "bg-white text-slate-900 border-slate-200"
      : "bg-slate-950/70 text-slate-100 border-slate-800";

  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      {/* HEADER */}
      <div className="mb-4">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">CI • Alchemy</div>
        <h1 className="mt-1 text-xl font-semibold text-slate-50">
          Drafting Console · AI Scribe
        </h1>
        <div className="mt-2 text-xs text-slate-400">
          Entity: <span className="text-emerald-300">{activeEntityLabel}</span>
          <span className="mx-2">•</span>
          Lane:{" "}
          <span className={isSandbox ? "text-amber-300" : "text-sky-300"}>
            {env}
          </span>
        </div>
      </div>

      {/* MAIN FRAME */}
      <div className="flex-1 flex gap-4 overflow-hidden">
        {drawerOpen && (
          <aside className="w-[360px] rounded-2xl border border-slate-800 bg-slate-950/40 overflow-y-auto">
            <div className="p-4 border-b border-slate-800">
              <input
                className="w-full rounded-xl bg-slate-900/60 px-3 py-2 text-sm"
                placeholder="Search drafts…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>

            <ul className="divide-y divide-slate-800">
              {drafts
                .filter((d) =>
                  query
                    ? `${d.title} ${d.draft_text}`.toLowerCase().includes(query.toLowerCase())
                    : true
                )
                .map((d: DraftRecord) => (
                  <li
                    key={d.id}
                    onClick={() => handleSelectDraft(d)}
                    className={cx(
                      "px-4 py-3 cursor-pointer hover:bg-slate-800/60",
                      d.id === selectedId && "bg-slate-800/80"
                    )}
                  >
                    <div className="text-sm font-semibold truncate">{d.title}</div>
                    <div className="text-xs text-slate-500">{fmtShort(d.created_at)}</div>
                  </li>
                ))}
            </ul>
          </aside>
        )}

        {/* EDITOR */}
        <section className={cx("flex-1 rounded-2xl border flex flex-col", editorCard)}>
          <div className="p-4 border-b">
            <input
              className="w-full rounded-xl px-3 py-2"
              placeholder="Resolution title"
              value={title}
              onChange={(e) => onTitleChange(e.target.value)}
            />
          </div>

          <textarea
            className="flex-1 p-4 resize-none"
            placeholder="Draft body…"
            value={body}
            onChange={(e) => onBodyChange(e.target.value)}
          />

          <div className="p-4 border-t flex gap-2">
            <button onClick={handleNewDraft} className="btn-secondary">New</button>
            <button onClick={handleSaveDraft} className="btn-primary">Save</button>
          </div>
        </section>
      </div>

      {(error || info) && (
        <div className="mt-4 text-sm">
          {error && <div className="text-red-300">{error}</div>}
          {info && <div className="text-emerald-300">{info}</div>}
        </div>
      )}
    </div>
  );
}
