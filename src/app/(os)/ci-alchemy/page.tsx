"use client";
export const dynamic = "force-dynamic";

/**
 * CI-ALCHEMY — FINAL ENTERPRISE VERSION
 * ------------------------------------
 * Invariants (LOCKED):
 * • Entity is ALWAYS a real entity (holdings / lounge / real-estate)
 * • Sandbox is ENV ONLY → is_test flag
 * • Finalize → governance_ledger (status = PENDING)
 * • Council authority decides execution
 * • Supabase = Root of Truth
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";

/* ----------------------------- Types ----------------------------- */

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

/* -------------------------- Constants ----------------------------- */

const ENTITY_LABELS: Record<string, string> = {
  holdings: "Oasis International Holdings Inc.",
  lounge: "Oasis International Lounge Inc.",
  "real-estate": "Oasis International Real Estate Inc.",
};

/* --------------------------- Helpers ------------------------------ */

function cx(...c: Array<string | false | null | undefined>) {
  return c.filter(Boolean).join(" ");
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

function resolveEnv(ctx: any): "ROT" | "SANDBOX" {
  const raw =
    (ctx?.oasis_os_env ??
      ctx?.activeEnv ??
      ctx?.environment ??
      ctx?.env ??
      "ROT") + "";
  return raw.toUpperCase().includes("SANDBOX") ? "SANDBOX" : "ROT";
}

function isMissingColumnErr(err: any) {
  return (err?.message ?? "").toLowerCase().includes("column");
}

/* ============================ PAGE ================================ */

export default function CIAlchemyPage() {
  const entityCtx = useEntity() as any;

  /** ENTITY IS REAL — NEVER SANDBOX */
  const activeEntity = (entityCtx?.activeEntity as string) || "holdings";
  const activeEntityLabel =
    ENTITY_LABELS[activeEntity] ?? activeEntity;

  /** ENV IS A FLAG ONLY */
  const env = useMemo(() => resolveEnv(entityCtx), [entityCtx]);
  const isSandbox = env === "SANDBOX";

  /* ----------------------------- State ---------------------------- */

  const [drafts, setDrafts] = useState<DraftRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [alchemyRunning, setAlchemyRunning] = useState(false);

  const [statusTab, setStatusTab] = useState<StatusTab>("draft");
  const [query, setQuery] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const lastLoadedRef = useRef<{
    id: string | null;
    title: string;
    body: string;
  } | null>(null);

  /* ------------------------- Derived ------------------------------ */

  const selectedDraft = useMemo(
    () => drafts.find((d) => d.id === selectedId) ?? null,
    [drafts, selectedId]
  );

  const canMutate =
    !selectedDraft ||
    (!selectedDraft.finalized_record_id &&
      selectedDraft.status !== "finalized");

  const envDrafts = useMemo(() => {
    const hasEnv = drafts.some((d) => typeof d.is_test === "boolean");
    if (!hasEnv) return drafts;
    return drafts.filter((d) =>
      isSandbox ? d.is_test === true : d.is_test === false
    );
  }, [drafts, isSandbox]);

  const filteredDrafts = useMemo(() => {
    let list = envDrafts;
    if (statusTab !== "all")
      list = list.filter((d) => d.status === statusTab);

    const q = query.trim().toLowerCase();
    if (q)
      list = list.filter((d) =>
        `${d.title}\n${d.draft_text}`.toLowerCase().includes(q)
      );

    return list;
  }, [envDrafts, statusTab, query]);

  /* -------------------------- Effects ----------------------------- */

  useEffect(() => {
    reloadDrafts(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEntity, env]);

  /* ------------------------- Actions ------------------------------ */

  async function reloadDrafts(preserve = true) {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("governance_drafts")
        .select("*")
        .eq("entity_slug", activeEntity)
        .eq("is_test", isSandbox)
        .order("created_at", { ascending: false });

      if (error) throw error;

      setDrafts(data ?? []);

      if (!preserve) return;

      const still = (data as DraftRecord[] | null)?.find(
  (d: DraftRecord) => d.id === selectedId
);
      if (still) {
        setTitle(still.title);
        setBody(still.draft_text);
      }
    } catch (e: any) {
      setError(e.message ?? "Failed to load drafts");
    } finally {
      setLoading(false);
    }
  }

  /* ------------------------ Finalize ------------------------------ */

  async function handleFinalize() {
    if (!selectedDraft) return;

    setFinalizing(true);
    setError(null);

    try {
      const { data: entityRow } = await supabase
        .from("entities")
        .select("id,name")
        .eq("slug", activeEntity)
        .single();

      if (!entityRow) throw new Error("Entity missing");

      const { data: ledger, error: ledgerErr } = await supabase
        .from("governance_ledger")
        .insert({
          entity_id: entityRow.id,
          title,
          body,
          record_type: "resolution",
          status: "PENDING",
          source: "ci-alchemy",
          is_test: isSandbox,
        })
        .select("id")
        .single();

      if (ledgerErr) throw ledgerErr;

      await supabase
        .from("governance_drafts")
        .update({
          status: "finalized",
          finalized_record_id: ledger.id,
          is_test: isSandbox,
        })
        .eq("id", selectedDraft.id);

      setInfo("Finalized → Council queue");
      reloadDrafts(true);
    } catch (e: any) {
      setError(e.message ?? "Finalize failed");
    } finally {
      setFinalizing(false);
    }
  }

  /* ============================== UI ============================== */

  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      <div className="mb-4">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">
          CI · Alchemy
        </div>
        <h1 className="mt-1 text-xl font-semibold text-slate-50">
          Drafting Console
        </h1>
        <div className="mt-1 text-xs text-slate-400">
          Entity:{" "}
          <span className="text-emerald-300">{activeEntityLabel}</span>
          <span className="mx-2">•</span>
          Lane:{" "}
          <span
            className={cx(
              "font-semibold",
              isSandbox ? "text-amber-300" : "text-sky-300"
            )}
          >
            {env}
          </span>
        </div>
      </div>

      {/* MAIN */}
      <div className="flex-1 min-h-0 flex gap-4">
        <aside className="w-[360px] border border-slate-800 rounded-2xl overflow-hidden">
          <div className="p-4 border-b border-slate-800">
            <input
              className="w-full rounded-xl bg-black/40 px-4 py-2 text-sm"
              placeholder="Search drafts…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <ul className="overflow-y-auto">
            {filteredDrafts.map((d) => (
              <li
                key={d.id}
                onClick={() => {
                  setSelectedId(d.id);
                  setTitle(d.title);
                  setBody(d.draft_text);
                }}
                className={cx(
                  "p-4 cursor-pointer hover:bg-slate-800/60",
                  d.id === selectedId && "bg-slate-800"
                )}
              >
                <div className="font-semibold">{d.title}</div>
                <div className="text-xs text-slate-500">
                  {fmtShort(d.created_at)} • {d.status}
                </div>
              </li>
            ))}
          </ul>
        </aside>

        <section className="flex-1 border border-slate-800 rounded-2xl p-4 flex flex-col">
          <input
            className="mb-3 rounded-xl px-4 py-3 bg-black/40"
            placeholder="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={!canMutate}
          />

          <textarea
            className="flex-1 rounded-xl px-4 py-3 bg-black/40 resize-none"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            disabled={!canMutate}
          />

          <div className="mt-4 flex gap-2">
            <button
              onClick={handleFinalize}
              disabled={!canMutate || finalizing}
              className="px-6 py-3 rounded-full bg-emerald-500 text-black font-semibold"
            >
              {finalizing ? "Finalizing…" : "Finalize → Council"}
            </button>
          </div>

          {error && (
            <div className="mt-4 text-red-400 text-sm">{error}</div>
          )}
          {info && (
            <div className="mt-4 text-emerald-400 text-sm">{info}</div>
          )}
        </section>
      </div>
    </div>
  );
}
