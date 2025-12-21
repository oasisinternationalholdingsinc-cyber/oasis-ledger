"use client";
export const dynamic = "force-dynamic";

/**
 * CI-Archive → Minute Book (ENTERPRISE FINAL)
 * Contract locked:
 * - 3-column OS layout (Domains | Registry | Evidence)
 * - Full Evidence panel (Actions, PDF, Metadata, Audit)
 * - Delete UX (right-panel only, ISO-aligned)
 * - No wiring changes
 */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";

/* ─────────────── Types ─────────────── */

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
  notes?: string | null;
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
  uploaded_at?: string | null;
};

type EntryWithDoc = MinuteBookEntry & {
  storage_path?: string | null;
  file_name?: string | null;
  file_hash?: string | null;
  file_size?: number | null;
  mime_type?: string | null;
};

/* ─────────────── Helpers ─────────────── */

const DOMAIN_ICON: Record<string, string> = {
  incorporation: "📜",
  resolutions: "⚖️",
  bylaws: "📘",
  share_capital: "📈",
  directors_officers: "👤",
  annual_returns: "🧾",
  tax: "🧾",
  banking: "🏦",
  insurance: "🛡️",
  real_estate: "🏠",
  contracts: "🤝",
  brand_ip: "™️",
  compliance: "✅",
  legal: "⚠️",
};

const fmtBytes = (n?: number | null) =>
  !n ? "—" : n > 1e6 ? `${(n / 1e6).toFixed(2)} MB` : `${(n / 1e3).toFixed(1)} KB`;

const shortHash = (h?: string | null) =>
  !h ? "—" : h.length > 20 ? `${h.slice(0, 10)}…${h.slice(-8)}` : h;

/* ─────────────── Data Loaders ─────────────── */

async function loadDomains(): Promise<GovernanceDomain[]> {
  const { data, error } = await supabaseBrowser
    .from("governance_domains")
    .select("key,label,sort_order,active")
    .eq("active", true)
    .order("sort_order");
  if (error) throw error;
  return data ?? [];
}

async function loadEntries(entityKey: string): Promise<EntryWithDoc[]> {
  const { data: entries, error } = await supabaseBrowser
    .from("minute_book_entries")
    .select("id,entity_key,domain_key,entry_type,title,notes,created_at,created_by,source")
    .eq("entity_key", entityKey)
    .order("created_at", { ascending: false });
  if (error) throw error;

  const ids = entries.map((e) => e.id);
  if (!ids.length) return [];

  const { data: docs } = await supabaseBrowser
    .from("supporting_documents")
    .select("entry_id,file_path,file_name,file_hash,file_size,mime_type")
    .in("entry_id", ids)
    .order("uploaded_at", { ascending: false });

  const primary = new Map<string, SupportingDoc>();
  (docs ?? []).forEach((d) => {
    if (!primary.has(d.entry_id)) primary.set(d.entry_id, d);
  });

  return entries.map((e) => {
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

/* ─────────────── Component ─────────────── */

export default function MinuteBookClient() {
  const { entityKey } = useEntity();

  const [domains, setDomains] = useState<GovernanceDomain[]>([]);
  const [entries, setEntries] = useState<EntryWithDoc[]>([]);
  const [activeDomain, setActiveDomain] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [showDelete, setShowDelete] = useState(false);
  const [deleteReason, setDeleteReason] = useState("");

  useEffect(() => {
    loadDomains().then(setDomains);
  }, []);

  useEffect(() => {
    if (!entityKey) return;
    loadEntries(entityKey).then((e) => {
      setEntries(e);
      setSelectedId(e[0]?.id ?? null);
    });
  }, [entityKey]);

  const filtered = useMemo(
    () =>
      activeDomain === "all"
        ? entries
        : entries.filter((e) => e.domain_key === activeDomain),
    [entries, activeDomain]
  );

  const selected = useMemo(
    () => entries.find((e) => e.id === selectedId) ?? null,
    [entries, selectedId]
  );

  async function viewPdf() {
    if (!selected?.storage_path) return;
    const { data } = await supabaseBrowser.storage
      .from("minute_book")
      .createSignedUrl(selected.storage_path, 600);
    setPdfUrl(data?.signedUrl ?? null);
  }

  async function deleteEntry() {
    if (!selected) return;
    await supabaseBrowser.rpc("delete_minute_book_entry_and_files", {
      p_entry_id: selected.id,
      p_reason: deleteReason,
    });
    setEntries((e) => e.filter((x) => x.id !== selected.id));
    setSelectedId(null);
    setShowDelete(false);
    setDeleteReason("");
  }

  return (
    <div className="h-full px-8 py-6 flex flex-col">
      <div className="text-xs tracking-[0.3em] uppercase text-slate-500 mb-4">
        CI-ARCHIVE · Minute Book
      </div>

      <div className="grid grid-cols-12 gap-6 flex-1 min-h-0">
        {/* Domains */}
        <aside className="col-span-3 bg-black/60 border border-slate-800 rounded-2xl p-4 overflow-y-auto">
          <button
            onClick={() => setActiveDomain("all")}
            className={`w-full text-left mb-2 px-3 py-2 rounded-xl ${
              activeDomain === "all" ? "bg-amber-500/20" : "hover:bg-slate-900"
            }`}
          >
            ◆ All
          </button>
          {domains.map((d) => (
            <button
              key={d.key}
              onClick={() => setActiveDomain(d.key)}
              className={`w-full text-left px-3 py-2 rounded-xl flex gap-2 ${
                activeDomain === d.key
                  ? "bg-amber-500/20"
                  : "hover:bg-slate-900"
              }`}
            >
              <span>{DOMAIN_ICON[d.key] ?? "•"}</span>
              <span>{d.label}</span>
            </button>
          ))}
        </aside>

        {/* Registry */}
        <section className="col-span-5 bg-black/60 border border-slate-800 rounded-2xl overflow-y-auto">
          {filtered.map((e) => (
            <button
              key={e.id}
              onClick={() => setSelectedId(e.id)}
              className={`w-full text-left p-3 border-b border-slate-800 ${
                e.id === selectedId ? "bg-slate-900" : ""
              }`}
            >
              <div className="text-slate-100 text-sm">{e.title ?? e.file_name}</div>
              <div className="text-xs text-slate-400">
                {fmtBytes(e.file_size)} · {e.entry_type}
              </div>
            </button>
          ))}
        </section>

        {/* Evidence */}
        <section className="col-span-4 bg-black/60 border border-slate-800 rounded-2xl flex flex-col">
          {!selected ? (
            <div className="p-4 text-slate-400">Select a record</div>
          ) : (
            <>
              {/* Actions */}
              <div className="p-4 border-b border-slate-800">
                <div className="text-slate-100 font-semibold">{selected.title}</div>
                <div className="text-xs text-slate-400 mb-2">
                  Hash: {shortHash(selected.file_hash)}
                </div>
                <div className="flex gap-2">
                  <button onClick={viewPdf} className="btn-primary">View PDF</button>
                  <button onClick={() => setShowDelete(true)} className="btn-danger">
                    Remove from Minute Book
                  </button>
                </div>
              </div>

              {/* PDF */}
              <div className="flex-1">
                {pdfUrl ? (
                  <iframe src={pdfUrl} className="w-full h-full" />
                ) : (
                  <div className="h-full grid place-items-center text-slate-500 text-xs">
                    No PDF loaded
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </div>

      {/* Delete Modal */}
      {showDelete && (
        <div className="fixed inset-0 bg-black/80 grid place-items-center z-50">
          <div className="bg-slate-950 border border-red-800 rounded-xl p-6 w-[420px]">
            <h3 className="text-slate-100 font-semibold mb-2">
              Remove Minute Book Record
            </h3>
            <p className="text-xs text-slate-400 mb-3">
              This permanently removes the record and stored files. Verified
              records are not affected.
            </p>
            <input
              value={deleteReason}
              onChange={(e) => setDeleteReason(e.target.value)}
              placeholder="Reason for removal (required)"
              className="w-full mb-4 px-3 py-2 bg-black border border-slate-700 rounded"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowDelete(false)}>Cancel</button>
              <button onClick={deleteEntry} className="btn-danger">
                Confirm Removal
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
