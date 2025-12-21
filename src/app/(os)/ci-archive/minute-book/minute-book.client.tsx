"use client";
export const dynamic = "force-dynamic";

/**
 * CI-Archive → Minute Book (FINAL — LOCKED CONTRACT)
 * STRICT 3-column OS surface: Domains | Registry | Evidence
 * TypeScript strict-safe (noImplicitAny compliant)
 */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";

/* ---------------- types ---------------- */

type GovernanceDomain = {
  key: string;
  label: string;
  description?: string | null;
  sort_order?: number | null;
  active?: boolean | null;
};

type MinuteBookEntry = {
  id: string;
  entity_key: string;
  domain_key: string | null;
  section_name?: string | null;
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
  version?: number | null;
  uploaded_at?: string | null;
};

type EntryWithDoc = MinuteBookEntry & {
  document_id?: string | null;
  storage_path?: string | null;
  file_name?: string | null;
  file_hash?: string | null;
  file_size?: number | null;
  mime_type?: string | null;
};

type OfficialArtifact = {
  bucket_id: string;
  storage_path: string;
  file_name?: string | null;
  kind?: "official" | "verified";
};

/* ---------------- helpers ---------------- */

function norm(v?: string | null, fb = "—") {
  return v && v.trim().length ? v : fb;
}

function fmtBytes(n?: number | null) {
  if (!n) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${u[i]}`;
}

function shortHash(h?: string | null) {
  if (!h) return "—";
  return h.length > 18 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h;
}

/* ---------------- icon map (UI only) ---------------- */

const DOMAIN_ICON: Record<string, string> = {
  incorporation: "📜",
  formation: "📜",
  resolutions: "⚖️",
  minutes: "⚖️",
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

/* ---------------- data loaders ---------------- */

async function loadDomains(): Promise<GovernanceDomain[]> {
  const { data, error } = await supabaseBrowser
    .from("governance_domains")
    .select("key,label,description,sort_order,active")
    .eq("active", true)
    .order("sort_order");

  if (error) throw error;
  return (data || []) as GovernanceDomain[];
}

async function loadEntries(entityKey: string): Promise<MinuteBookEntry[]> {
  const { data, error } = await supabaseBrowser
    .from("minute_book_entries")
    .select("id,entity_key,domain_key,section_name,entry_type,title,notes,created_at,created_by,source")
    .eq("entity_key", entityKey)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return (data || []) as MinuteBookEntry[];
}

async function loadSupportingDocs(entryIds: string[]): Promise<SupportingDoc[]> {
  if (!entryIds.length) return [];
  const { data, error } = await supabaseBrowser
    .from("supporting_documents")
    .select("id,entry_id,file_path,file_name,file_hash,file_size,mime_type,version,uploaded_at")
    .in("entry_id", entryIds)
    .order("version", { ascending: false })
    .order("uploaded_at", { ascending: false });

  if (error) throw error;
  return (data || []) as SupportingDoc[];
}

function pickPrimaryDocByEntry(docs: SupportingDoc[]): Map<string, SupportingDoc> {
  const primary = new Map<string, SupportingDoc>();
  (docs as SupportingDoc[]).forEach((d) => {
    if (!primary.has(d.entry_id)) primary.set(d.entry_id, d);
  });
  return primary;
}

async function signedUrl(bucket: string, path: string, download?: string | null) {
  const { data, error } = await supabaseBrowser.storage
    .from(bucket)
    .createSignedUrl(path, 600, download ? { download } : undefined);
  if (error) throw error;
  return data.signedUrl;
}

/* ---------------- component ---------------- */

export default function MinuteBookClient() {
  const { entityKey } = useEntity();

  const [domains, setDomains] = useState<GovernanceDomain[]>([]);
  const [entries, setEntries] = useState<EntryWithDoc[]>([]);
  const [activeDomain, setActiveDomain] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* load domains */
  useEffect(() => {
    loadDomains().then(setDomains).catch((e) => setError(e.message));
  }, []);

  /* load entries */
  useEffect(() => {
    if (!entityKey) return;
    let alive = true;

    (async () => {
      setLoading(true);
      try {
        const base = await loadEntries(entityKey);
        const ids = (base as MinuteBookEntry[]).map((d) => d.id);
        const docs = await loadSupportingDocs(ids);
        const primary = pickPrimaryDocByEntry(docs);

        const merged: EntryWithDoc[] = base.map((e) => {
          const d = primary.get(e.id);
          return {
            ...e,
            document_id: d?.id ?? null,
            storage_path: d?.file_path ?? null,
            file_name: d?.file_name ?? null,
            file_hash: d?.file_hash ?? null,
            file_size: d?.file_size ?? null,
            mime_type: d?.mime_type ?? null,
          };
        });

        if (!alive) return;
        setEntries(merged);
        setSelectedId(merged[0]?.id ?? null);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [entityKey]);

  const filtered = useMemo(() => {
    return activeDomain === "all"
      ? entries
      : entries.filter((e) => e.domain_key === activeDomain);
  }, [entries, activeDomain]);

  const selected = useMemo(
    () => entries.find((e) => e.id === selectedId) || null,
    [entries, selectedId]
  );

  async function viewPdf() {
    if (!selected?.storage_path) return;
    const url = await signedUrl("minute_book", selected.storage_path);
    setPreviewUrl(url);
  }

  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      <div className="text-xs tracking-[0.3em] uppercase text-slate-500 mb-2">
        CI-ARCHIVE
      </div>

      <div className="flex-1 grid grid-cols-12 gap-6 min-h-0">
        {/* Domains */}
        <section className="col-span-3 bg-black/50 rounded-2xl border border-slate-800 p-4 overflow-y-auto">
          <button
            onClick={() => setActiveDomain("all")}
            className="w-full text-left mb-2 text-sm text-slate-200"
          >
            ◆ All
          </button>
          {domains.map((d) => (
            <button
              key={d.key}
              onClick={() => setActiveDomain(d.key)}
              className="w-full text-left flex gap-2 py-1 text-slate-300 hover:text-amber-300"
            >
              <span>{DOMAIN_ICON[d.key] || "•"}</span>
              <span>{d.label}</span>
            </button>
          ))}
        </section>

        {/* Registry */}
        <section className="col-span-5 bg-black/50 rounded-2xl border border-slate-800 overflow-y-auto">
          {loading ? (
            <div className="p-4 text-slate-400">Loading…</div>
          ) : (
            filtered.map((e) => (
              <button
                key={e.id}
                onClick={() => setSelectedId(e.id)}
                className={`w-full text-left p-3 border-b border-slate-800 ${
                  e.id === selectedId ? "bg-slate-900" : ""
                }`}
              >
                <div className="text-sm text-slate-100">{e.title || e.file_name}</div>
                <div className="text-xs text-slate-400">
                  {fmtBytes(e.file_size)} · {e.entry_type}
                </div>
              </button>
            ))
          )}
        </section>

        {/* Evidence */}
        <section className="col-span-4 bg-black/50 rounded-2xl border border-slate-800 flex flex-col">
          {selected ? (
            <>
              <div className="p-4 border-b border-slate-800">
                <div className="text-sm text-slate-100">{selected.title}</div>
                <div className="text-xs text-slate-400">
                  Hash: {shortHash(selected.file_hash)}
                </div>
                <button
                  onClick={viewPdf}
                  className="mt-2 px-4 py-1 text-xs bg-amber-500 text-black rounded-full"
                >
                  View PDF
                </button>
              </div>
              <div className="flex-1">
                {previewUrl ? (
                  <iframe src={previewUrl} className="w-full h-full" />
                ) : (
                  <div className="h-full grid place-items-center text-xs text-slate-500">
                    No preview loaded
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="p-4 text-slate-400">Select a record</div>
          )}
        </section>
      </div>
    </div>
  );
}
