"use client";
export const dynamic = "force-dynamic";

/**
 * CI-Archive → Minute Book (FINAL — PRODUCTION LOCK)
 * - OS-consistent (CI-Council grade)
 * - Evidence-first
 * - Read-only surface with guarded audit deletion
 */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";

/* ---------------- types ---------------- */

type GovernanceDomain = {
  key: string;
  label: string;
  sort_order?: number | null;
  active?: boolean | null;
};

type MinuteBookEntry = {
  id: string;
  entity_key: string;
  domain_key: string | null;
  entry_type?: string | null;
  title?: string | null;
  created_at?: string | null;
  created_by?: string | null;
  source?: string | null;
};

type SupportingDoc = {
  id: string;
  entry_id: string;
  file_path: string | null;
  file_name: string | null;
  file_hash: string | null;
  file_size: number | null;
  mime_type: string | null;
  version?: number | null;
  uploaded_at?: string | null;
};

type EntryWithDoc = MinuteBookEntry & {
  storage_path?: string | null;
  file_name?: string | null;
  file_hash?: string | null;
  file_size?: number | null;
  mime_type?: string | null;
};

/* ---------------- helpers ---------------- */

const fmtBytes = (n?: number | null) =>
  !n ? "—" : n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;

const shortHash = (h?: string | null) =>
  !h ? "—" : h.length <= 18 ? h : `${h.slice(0, 12)}…${h.slice(-6)}`;

/* ---------------- data loaders ---------------- */

async function loadDomains(): Promise<GovernanceDomain[]> {
  const { data, error } = await supabaseBrowser
    .from("governance_domains")
    .select("key,label,sort_order,active")
    .eq("active", true)
    .order("sort_order", { ascending: true });
  if (error) throw error;
  return data || [];
}

async function loadEntries(entityKey: string): Promise<EntryWithDoc[]> {
  const { data, error } = await supabaseBrowser
    .from("minute_book_entries")
    .select("id,entity_key,domain_key,entry_type,title,created_at,created_by,source")
    .eq("entity_key", entityKey)
    .order("created_at", { ascending: false });
  if (error) throw error;

  const ids = (data || []).map((d) => d.id);
  if (!ids.length) return [];

  const { data: docs } = await supabaseBrowser
    .from("supporting_documents")
    .select("entry_id,file_path,file_name,file_hash,file_size,mime_type,version,uploaded_at")
    .in("entry_id", ids)
    .order("version", { ascending: false })
    .order("uploaded_at", { ascending: false });

  const primary = new Map<string, SupportingDoc>();
  (docs || []).forEach((d) => {
    if (!primary.has(d.entry_id)) primary.set(d.entry_id, d);
  });

  return (data || []).map((e) => {
    const d = primary.get(e.id);
    return {
      ...e,
      storage_path: d?.file_path ?? null,
      file_name: d?.file_name ?? null,
      file_hash: d?.file_hash ?? null,
      file_size: d?.file_size ?? null,
      mime_type: d?.mime_type ?? null,
    };
  });
}

/* ---------------- component ---------------- */

export default function MinuteBookClient() {
  const { entityKey } = useEntity();

  const [domains, setDomains] = useState<GovernanceDomain[]>([]);
  const [entries, setEntries] = useState<EntryWithDoc[]>([]);
  const [activeDomain, setActiveDomain] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // PDF
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Delete (AUDIT ACTION)
  const [showDelete, setShowDelete] = useState(false);
  const [deleteReason, setDeleteReason] = useState("");
  const [busyDelete, setBusyDelete] = useState(false);

  useEffect(() => {
    loadDomains().then(setDomains);
  }, []);

  useEffect(() => {
    if (!entityKey) return;
    loadEntries(entityKey).then((rows) => {
      setEntries(rows);
      setSelectedId(rows[0]?.id ?? null);
    });
  }, [entityKey]);

  const filtered = useMemo(() => {
    let list = entries;
    if (activeDomain !== "all") list = list.filter((e) => e.domain_key === activeDomain);
    return list;
  }, [entries, activeDomain]);

  const selected = useMemo(
    () => entries.find((e) => e.id === selectedId) || null,
    [entries, selectedId]
  );

  async function viewPdf() {
    if (!selected?.storage_path) return;
    const { data } = await supabaseBrowser.storage
      .from("minute_book")
      .createSignedUrl(selected.storage_path, 600);
    setPreviewUrl(data?.signedUrl ?? null);
  }

  async function confirmDelete() {
    if (!selected || !deleteReason.trim()) return;
    setBusyDelete(true);

    const { error } = await supabaseBrowser.rpc(
      "delete_minute_book_entry_and_files",
      {
        p_entry_id: selected.id,
        p_reason: deleteReason,
      }
    );

    setBusyDelete(false);
    setShowDelete(false);
    setDeleteReason("");

    if (!error) {
      const refreshed = await loadEntries(entityKey!);
      setEntries(refreshed);
      setSelectedId(refreshed[0]?.id ?? null);
    } else {
      alert(error.message);
    }
  }

  /* ---------------- render ---------------- */

  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      <div className="mb-4">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">CI-ARCHIVE</div>
        <p className="mt-1 text-[11px] text-slate-400">
          Minute Book Registry • Read-only • Evidence-first
        </p>
      </div>

      <div className="flex-1 min-h-0 flex justify-center overflow-hidden">
        <div className="w-full max-w-[1600px] h-full rounded-3xl border border-slate-900 bg-black/60 px-6 py-5 flex flex-col overflow-hidden">

          {/* MAIN GRID */}
          <div className="grid grid-cols-12 gap-6 flex-1 min-h-0">

            {/* LEFT — DOMAINS */}
            <section className="col-span-3 min-h-0 flex flex-col">
              <div className="bg-slate-950/40 border border-slate-800 rounded-2xl p-4 flex-1 overflow-y-auto">
                <div className="text-sm font-semibold text-slate-200 mb-3">Domains</div>
                <button
                  onClick={() => setActiveDomain("all")}
                  className={`w-full mb-1 px-3 py-2 rounded-xl text-left ${
                    activeDomain === "all" ? "bg-amber-500/10 border border-amber-500/40" : "hover:bg-slate-900/60"
                  }`}
                >
                  All
                </button>
                {domains.map((d) => (
                  <button
                    key={d.key}
                    onClick={() => setActiveDomain(d.key)}
                    className={`w-full mb-1 px-3 py-2 rounded-xl text-left ${
                      activeDomain === d.key
                        ? "bg-amber-500/10 border border-amber-500/40"
                        : "hover:bg-slate-900/60"
                    }`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </section>

            {/* MIDDLE — ENTRIES */}
            <section className="col-span-5 min-h-0 flex flex-col">
              <div className="bg-slate-950/40 border border-slate-800 rounded-2xl p-4 flex-1 overflow-y-auto">
                <div className="text-sm font-semibold text-slate-200 mb-3">Registry Entries</div>
                {filtered.map((e) => (
                  <button
                    key={e.id}
                    onClick={() => setSelectedId(e.id)}
                    className={`w-full px-3 py-3 mb-1 rounded-xl text-left ${
                      selectedId === e.id
                        ? "bg-slate-900/90 shadow-[0_0_0_1px_rgba(245,158,11,0.35)]"
                        : "hover:bg-slate-900/60"
                    }`}
                  >
                    <div className="text-xs font-semibold text-slate-100">
                      {e.title || e.file_name || "Untitled"}
                    </div>
                    <div className="text-[11px] text-slate-400 mt-1">
                      {e.entry_type || "document"} • {fmtBytes(e.file_size)}
                    </div>
                  </button>
                ))}
              </div>
            </section>

            {/* RIGHT — EVIDENCE + AUDIT */}
            <section className="col-span-4 min-h-0 flex flex-col">
              <div className="bg-slate-950/40 border border-slate-800 rounded-2xl p-4 flex flex-col min-h-0">

                {!selected ? (
                  <div className="text-[11px] text-slate-400">
                    Select a record to inspect evidence.
                  </div>
                ) : (
                  <>
                    {/* EVIDENCE HEADER */}
                    <div className="mb-3">
                      <div className="text-sm font-semibold text-slate-200">
                        {selected.title || selected.file_name}
                      </div>
                      <div className="mt-1 text-[11px] text-slate-500">
                        {selected.entry_type || "document"}
                      </div>
                    </div>

                    {/* ACTIONS */}
                    <div className="flex gap-2 mb-3">
                      <button
                        onClick={viewPdf}
                        className="rounded-full px-4 py-1.5 text-[11px] font-semibold bg-amber-500 text-black"
                      >
                        View PDF
                      </button>
                    </div>

                    {/* PDF PREVIEW */}
                    <div className="flex-1 min-h-0 rounded-xl border border-slate-800 overflow-hidden mb-3">
                      {previewUrl ? (
                        <iframe src={previewUrl} className="w-full h-full" />
                      ) : (
                        <div className="h-full grid place-items-center text-[11px] text-slate-500">
                          Preview appears here
                        </div>
                      )}
                    </div>

                    {/* METADATA */}
                    <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3 mb-3">
                      <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500 mb-2">
                        Metadata
                      </div>
                      <div className="text-[11px] text-slate-300">
                        <div>Hash: <span className="font-mono">{shortHash(selected.file_hash)}</span></div>
                        <div>Size: {fmtBytes(selected.file_size)}</div>
                      </div>
                    </div>

                    {/* AUDIT ACTION — DELETE */}
                    <div className="border-t border-slate-800 pt-3">
                      {!showDelete ? (
                        <>
                          <button
                            onClick={() => setShowDelete(true)}
                            className="text-sm text-red-400 hover:text-red-300"
                          >
                            Authorize deletion of record
                          </button>
                          <p className="mt-1 text-[11px] text-slate-400">
                            Permanently deletes this record and its evidence. Reason required.
                          </p>
                        </>
                      ) : (
                        <div className="space-y-2">
                          <textarea
                            value={deleteReason}
                            onChange={(e) => setDeleteReason(e.target.value)}
                            placeholder="Deletion reason (required)"
                            className="w-full rounded-lg bg-black border border-slate-800 p-2 text-sm"
                          />
                          <div className="flex gap-2">
                            <button
                              onClick={() => setShowDelete(false)}
                              className="px-3 py-1.5 text-sm border border-slate-700 rounded"
                            >
                              Cancel
                            </button>
                            <button
                              disabled={busyDelete || !deleteReason.trim()}
                              onClick={confirmDelete}
                              className="px-3 py-1.5 text-sm border border-red-600 text-red-400 rounded"
                            >
                              Confirm Permanent Deletion
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            </section>

          </div>

          <div className="mt-3 text-[10px] text-slate-500 flex justify-between">
            <span>CI-Archive · Oasis Digital Parliament</span>
            <span>Upload is the sole write entry point</span>
          </div>
        </div>
      </div>
    </div>
  );
}
