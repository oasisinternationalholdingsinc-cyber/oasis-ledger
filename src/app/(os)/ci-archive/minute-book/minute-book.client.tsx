"use client";
export const dynamic = "force-dynamic";

/**
 * CI-Archive → Minute Book (ENTERPRISE FINAL — PRODUCTION)
 * - Strict 3-column OS layout: Domains | Registry | Evidence
 * - Domains source of truth: governance_domains (Upload contract)
 * - Entries source of truth: minute_book_entries + supporting_documents (primary doc)
 * - Entity scope: minute_book_entries.entity_key = useEntity().entityKey
 * - Domain scope: minute_book_entries.domain_key = selected domain.key
 * - Evidence: signed URL from bucket minute_book using supporting_documents.file_path
 * - Evidence panel restored: Actions + PDF + Metadata Zone (Storage/Hash/Audit)
 * - Delete UX: right panel only (reason required) → rpc delete_minute_book_entry_and_files
 * - TS strict safe: no implicit any
 */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";

/* ───────────────────────── Types ───────────────────────── */

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
  thumbnail_path?: string | null;
};

type EntryWithDoc = MinuteBookEntry & {
  document_id?: string | null;
  storage_path?: string | null;
  file_name?: string | null;
  file_hash?: string | null;
  file_size?: number | null;
  mime_type?: string | null;
};

/* ───────────────────────── Helpers ───────────────────────── */

const DOMAIN_ICON: Record<string, string> = {
  incorporation: "📜",
  formation: "📜",
  "incorporation-and-formation": "📜",
  corporate_profile: "🛡️",
  "corporate-profile": "🛡️",
  share_capital: "📈",
  "share-capital": "📈",
  share_certificates: "📈",
  directors_officers: "👤",
  "directors-and-officers": "👤",
  resolutions: "⚖️",
  minutes: "⚖️",
  bylaws: "📘",
  governance: "📘",
  annual_returns: "🧾",
  tax: "🧾",
  banking: "🏦",
  insurance: "🛡️",
  risk: "🛡️",
  real_estate: "🏠",
  assets: "🏠",
  contracts: "🤝",
  agreements: "🤝",
  brand_ip: "™️",
  brand: "™️",
  compliance: "✅",
  regulatory: "✅",
  litigation: "⚠️",
  legal: "⚠️",
  annexes: "🗂️",
  misc: "🗂️",
};

function norm(s?: string | null, fb = "—") {
  const x = (s || "").toString().trim();
  return x.length ? x : fb;
}

function fmtBytes(n?: number | null) {
  if (!n || n <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function shortHash(h?: string | null) {
  if (!h) return "—";
  if (h.length <= 20) return h;
  return `${h.slice(0, 12)}…${h.slice(-8)}`;
}

function ts(iso?: string | null) {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleString();
}

/* ───────────────────────── Data Loaders ───────────────────────── */

async function loadDomains(): Promise<GovernanceDomain[]> {
  const { data, error } = await supabaseBrowser
    .from("governance_domains")
    .select("key,label,description,sort_order,active")
    .eq("active", true)
    .order("sort_order", { ascending: true });

  if (error) throw error;
  return ((data ?? []) as GovernanceDomain[]).filter(Boolean);
}

async function loadEntries(entityKey: string): Promise<MinuteBookEntry[]> {
  const { data, error } = await supabaseBrowser
    .from("minute_book_entries")
    .select("id,entity_key,domain_key,section_name,entry_type,title,notes,created_at,created_by,source")
    .eq("entity_key", entityKey)
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error) throw error;
  return (data ?? []) as MinuteBookEntry[];
}

async function loadSupportingDocs(entryIds: string[]): Promise<SupportingDoc[]> {
  if (!entryIds.length) return [];

  const { data, error } = await supabaseBrowser
    .from("supporting_documents")
    .select("id,entry_id,file_path,file_name,file_hash,file_size,mime_type,version,uploaded_at,thumbnail_path")
    .in("entry_id", entryIds)
    .order("version", { ascending: false })
    .order("uploaded_at", { ascending: false });

  if (error) throw error;
  return (data ?? []) as SupportingDoc[];
}

function pickPrimaryDocByEntry(docs: SupportingDoc[]): Map<string, SupportingDoc> {
  // docs already ordered by version desc, uploaded_at desc → first per entry_id is primary
  const m = new Map<string, SupportingDoc>();
  for (const d of docs) {
    if (!d?.entry_id) continue;
    if (!m.has(d.entry_id)) m.set(d.entry_id, d);
  }
  return m;
}

async function signedUrlFor(bucketId: string, storagePath: string, downloadName?: string | null) {
  const opts = downloadName ? { download: downloadName } : undefined;
  const { data, error } = await supabaseBrowser.storage.from(bucketId).createSignedUrl(storagePath, 60 * 10, opts as any);
  if (error) throw error;
  return data.signedUrl;
}

/* ───────────────────────── Component ───────────────────────── */

export default function MinuteBookClient() {
  const { entityKey } = useEntity();

  // data
  const [domains, setDomains] = useState<GovernanceDomain[]>([]);
  const [entries, setEntries] = useState<EntryWithDoc[]>([]);

  // selection
  const [activeDomainKey, setActiveDomainKey] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // ui
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // pdf
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfErr, setPdfErr] = useState<string | null>(null);

  // focus overlay
  const [focusOpen, setFocusOpen] = useState(false);

  // delete
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteReason, setDeleteReason] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  // load domains once
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await loadDomains();
        if (!alive) return;
        setDomains(d);
      } catch (e: any) {
        if (!alive) return;
        setDomains([]);
        setErr(e?.message || "Failed to load governance domains.");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // load entries per entity (and merge primary doc)
  async function refreshEntity() {
    if (!entityKey) {
      setEntries([]);
      setSelectedId(null);
      return;
    }

    setLoading(true);
    setErr(null);
    setPdfErr(null);
    setPreviewUrl(null);

    try {
      const base = await loadEntries(entityKey);
      const ids = base.map((e: MinuteBookEntry) => e.id); // TS-safe
      const docs = await loadSupportingDocs(ids);
      const primary = pickPrimaryDocByEntry(docs);

      const merged: EntryWithDoc[] = base.map((e: MinuteBookEntry) => {
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

      setEntries(merged);
      setSelectedId(merged[0]?.id ?? null);

      // keep activeDomainKey valid
      if (activeDomainKey !== "all" && !domains.some((d) => d.key === activeDomainKey)) {
        setActiveDomainKey("all");
      }
    } catch (e: any) {
      setErr(e?.message || "Failed to load Minute Book entries.");
      setEntries([]);
      setSelectedId(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshEntity();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityKey]);

  // derived
  const domainCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of domains) m.set(d.key, 0);
    for (const e of entries) {
      if (e.domain_key) m.set(e.domain_key, (m.get(e.domain_key) || 0) + 1);
    }
    return m;
  }, [domains, entries]);

  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = entries;

    if (activeDomainKey !== "all") {
      list = list.filter((e) => (e.domain_key || "") === activeDomainKey);
    }

    if (q) {
      list = list.filter((e) => {
        const hay = [
          e.title || "",
          e.entry_type || "",
          e.domain_key || "",
          e.section_name || "",
          e.file_name || "",
          e.storage_path || "",
          e.file_hash || "",
        ]
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      });
    }

    return list;
  }, [entries, activeDomainKey, query]);

  const selected = useMemo(() => {
    if (!selectedId) return null;
    return entries.find((e) => e.id === selectedId) || null;
  }, [entries, selectedId]);

  const activeDomainLabel = useMemo(() => {
    if (activeDomainKey === "all") return "All";
    return domains.find((d) => d.key === activeDomainKey)?.label || "Domain";
  }, [activeDomainKey, domains]);

  /* ───────────────────────── Actions ───────────────────────── */

  async function viewPdf() {
    if (!selected) return;
    setPdfErr(null);
    setPdfBusy(true);
    try {
      if (!selected.storage_path) throw new Error("Missing primary PDF reference (supporting_documents.file_path).");
      const url = await signedUrlFor("minute_book", selected.storage_path, null);
      setPreviewUrl(url);
      setFocusOpen(true); // default to Focus because you said PDF is too small
    } catch (e: any) {
      setPdfErr(e?.message || "Failed to generate PDF preview.");
    } finally {
      setPdfBusy(false);
    }
  }

  async function downloadPdf() {
    if (!selected) return;
    setPdfErr(null);
    setPdfBusy(true);
    try {
      if (!selected.storage_path) throw new Error("Missing primary PDF reference (supporting_documents.file_path).");
      const name = selected.file_name || `${norm(selected.title, "document")}.pdf`;
      const url = await signedUrlFor("minute_book", selected.storage_path, name);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e: any) {
      setPdfErr(e?.message || "Failed to generate download URL.");
    } finally {
      setPdfBusy(false);
    }
  }

  async function openNewTab() {
    if (!selected) return;
    setPdfErr(null);
    setPdfBusy(true);
    try {
      if (previewUrl) {
        window.open(previewUrl, "_blank", "noopener,noreferrer");
        return;
      }
      if (!selected.storage_path) throw new Error("Missing primary PDF reference (supporting_documents.file_path).");
      const url = await signedUrlFor("minute_book", selected.storage_path, null);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e: any) {
      setPdfErr(e?.message || "Failed to open PDF.");
    } finally {
      setPdfBusy(false);
    }
  }

  async function confirmDelete() {
    if (!selected) return;

    const reason = deleteReason.trim();
    if (!reason) {
      setDeleteErr("Reason is required.");
      return;
    }

    setDeleteBusy(true);
    setDeleteErr(null);

    try {
      const { error } = await supabaseBrowser.rpc("delete_minute_book_entry_and_files", {
        p_entry_id: selected.id,
        p_reason: reason,
      });

      if (error) throw error;

      setDeleteOpen(false);
      setDeleteReason("");
      setPreviewUrl(null);
      setFocusOpen(false);
      await refreshEntity();
    } catch (e: any) {
      setDeleteErr(e?.message || "Delete failed.");
    } finally {
      setDeleteBusy(false);
    }
  }

  /* ───────────────────────── Render ───────────────────────── */

  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      {/* Header */}
      <div className="mb-4 shrink-0">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">CI-ARCHIVE</div>
        <p className="mt-1 text-[11px] text-slate-400">
          Minute Book Registry • <span className="font-semibold text-slate-200">Evidence-first</span>
        </p>
      </div>

      {/* Main OS window */}
      <div className="flex-1 min-h-0 flex justify-center overflow-hidden">
        <div className="w-full max-w-[1650px] h-full rounded-3xl border border-slate-900 bg-black/60 shadow-[0_0_60px_rgba(15,23,42,0.9)] px-6 py-5 flex flex-col overflow-hidden">
          {/* Title row */}
          <div className="flex items-start justify-between mb-4 shrink-0">
            <div className="min-w-0">
              <h1 className="text-lg font-semibold text-slate-50 truncate">Minute Book Registry</h1>
              <p className="mt-1 text-xs text-slate-400">
                Canonical archive indexed by governance domain.{" "}
                <span className="text-slate-500">Domains mirror Upload contract.</span>
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <div className="hidden md:flex items-center text-[10px] uppercase tracking-[0.3em] text-slate-500">
                CI-ARCHIVE • LIVE
              </div>
              <Link
                href="/ci-archive/upload"
                className="rounded-full border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-amber-200 hover:bg-amber-500/15"
              >
                Go to Upload →
              </Link>
            </div>
          </div>

          {!entityKey ? (
            <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4 text-sm text-slate-300">
              Select an entity in the OS bar to view Minute Book records.
            </div>
          ) : (
            <div className="grid grid-cols-12 gap-6 flex-1 min-h-0">
              {/* LEFT: Domains */}
              <section className="col-span-12 lg:col-span-3 min-h-0 flex flex-col">
                <div className="bg-slate-950/40 border border-slate-800 rounded-2xl p-4 flex flex-col min-h-0">
                  <div className="flex items-center justify-between mb-3 shrink-0">
                    <div>
                      <div className="text-sm font-semibold text-slate-200">Domains</div>
                      <div className="text-[11px] text-slate-500">Source: governance_domains</div>
                    </div>
                    <div className="text-[10px] uppercase tracking-[0.25em] text-slate-500">{domains.length || "—"}</div>
                  </div>

                  <div className="flex-1 min-h-0 overflow-y-auto rounded-xl border border-slate-800/80 bg-slate-950/60 p-2">
                    {/* All */}
                    <button
                      type="button"
                      onClick={() => setActiveDomainKey("all")}
                      className={[
                        "w-full flex items-center justify-between gap-3 px-3 py-2 rounded-xl transition",
                        "hover:bg-slate-900/60 hover:shadow-[0_0_0_1px_rgba(148,163,184,0.18)]",
                        activeDomainKey === "all"
                          ? "bg-amber-500/10 border border-amber-500/40 shadow-[0_0_0_1px_rgba(245,158,11,0.25)]"
                          : "border border-transparent",
                      ].join(" ")}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <span className="w-7 h-7 grid place-items-center rounded-lg border border-slate-800 bg-slate-950/70 text-[12px]">
                          ◆
                        </span>
                        <span className="text-sm text-slate-100 truncate">All</span>
                      </span>
                      <span className="text-[11px] text-slate-500">{entries.length}</span>
                    </button>

                    <div className="mt-2 space-y-1">
                      {domains.map((d: GovernanceDomain) => {
                        const active = d.key === activeDomainKey;
                        const count = domainCounts.get(d.key) || 0;
                        const icon = DOMAIN_ICON[d.key] || "•";

                        return (
                          <button
                            key={d.key}
                            type="button"
                            onClick={() => setActiveDomainKey(d.key)}
                            className={[
                              "w-full flex items-center justify-between gap-3 px-3 py-2 rounded-xl transition",
                              "hover:bg-slate-900/60 hover:shadow-[0_0_0_1px_rgba(148,163,184,0.18)]",
                              active
                                ? "bg-amber-500/10 border border-amber-500/40 shadow-[0_0_0_1px_rgba(245,158,11,0.25)]"
                                : "border border-transparent",
                            ].join(" ")}
                          >
                            <span className="flex items-center gap-2 min-w-0">
                              <span className="w-7 h-7 grid place-items-center rounded-lg border border-slate-800 bg-slate-950/70 text-[12px]">
                                {icon}
                              </span>
                              <span className="text-sm text-slate-100 truncate">{d.label}</span>
                            </span>
                            <span className={["text-[11px]", count ? "text-amber-200/80" : "text-slate-600"].join(" ")}>
                              {count}
                            </span>
                          </button>
                        );
                      })}
                    </div>

                    {err ? (
                      <div className="mt-3 rounded-xl border border-red-800/60 bg-red-950/40 px-3 py-2 text-[11px] text-red-300">
                        {err}
                      </div>
                    ) : null}
                  </div>

                  <div className="mt-3 text-[10px] text-slate-500 flex items-center justify-between">
                    <span>
                      Entity: <span className="text-slate-300">{entityKey}</span>
                    </span>
                    <Link href="/ci-archive" className="text-slate-400 hover:text-slate-200">
                      Launchpad
                    </Link>
                  </div>
                </div>
              </section>

              {/* MIDDLE: Registry */}
              <section className="col-span-12 lg:col-span-5 min-h-0 flex flex-col">
                <div className="bg-slate-950/40 border border-slate-800 rounded-2xl p-4 flex flex-col min-h-0">
                  <div className="flex items-start justify-between mb-3 shrink-0">
                    <div>
                      <div className="text-sm font-semibold text-slate-200">Registry Entries</div>
                      <div className="text-[11px] text-slate-500">
                        {loading ? "Loading…" : `${filteredEntries.length} item(s)`} •{" "}
                        <span className="text-slate-300">{activeDomainLabel}</span>
                      </div>
                    </div>
                    <span className="px-2 py-0.5 rounded-full bg-sky-500/10 border border-sky-500/30 text-[10px] uppercase tracking-[0.18em] text-sky-200">
                      Evidence Index
                    </span>
                  </div>

                  <div className="mb-3 shrink-0">
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search title, hash, path…"
                      className="w-full rounded-xl bg-slate-950/70 border border-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 outline-none focus:border-amber-500/40"
                    />
                  </div>

                  <div className="flex-1 min-h-0 overflow-y-auto rounded-xl border border-slate-800/80 bg-slate-950/60">
                    {loading ? (
                      <div className="p-3 text-[11px] text-slate-400">Loading entries…</div>
                    ) : filteredEntries.length === 0 ? (
                      <div className="p-3 text-[11px] text-slate-400">
                        No records filed under <span className="text-slate-200">{activeDomainLabel}</span> yet.
                        <div className="mt-2 text-[10px] text-slate-500">
                          Upload later — it will appear here automatically (domain_key driven).
                        </div>
                      </div>
                    ) : (
                      filteredEntries.map((e: EntryWithDoc) => {
                        const active = e.id === selectedId;

                        return (
                          <button
                            key={e.id}
                            type="button"
                            onClick={() => {
                              setSelectedId(e.id);
                              setPdfErr(null);
                            }}
                            className={[
                              "w-full text-left px-3 py-3 border-b border-slate-800 last:border-b-0 transition",
                              active
                                ? "bg-slate-900/90 shadow-[0_0_0_1px_rgba(245,158,11,0.35)]"
                                : "hover:bg-slate-900/60",
                            ].join(" ")}
                          >
                            <div className="text-xs font-semibold text-slate-100 line-clamp-2">
                              {e.title || e.file_name || "Untitled filing"}
                            </div>
                            <div className="mt-1 text-[11px] text-slate-400 flex items-center gap-2 flex-wrap">
                              <span className="capitalize">{e.entry_type || "document"}</span>
                              <span className="w-1 h-1 rounded-full bg-slate-600" />
                              <span className="text-slate-500">{ts(e.created_at)}</span>
                              <span className="w-1 h-1 rounded-full bg-slate-700" />
                              <span className="text-slate-500">{fmtBytes(e.file_size)}</span>
                            </div>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              </section>

              {/* RIGHT: Evidence */}
              <section className="col-span-12 lg:col-span-4 min-h-0 flex flex-col">
                <div className="bg-slate-950/40 border border-slate-800 rounded-2xl p-4 flex flex-col min-h-0">
                  <div className="flex items-start justify-between mb-3 shrink-0">
                    <div>
                      <div className="text-sm font-semibold text-slate-200">Evidence</div>
                      <div className="text-[11px] text-slate-500">Focus PDF • Metadata secondary</div>
                    </div>
                    <span className="px-2 py-0.5 rounded-full bg-slate-900/40 border border-slate-700 text-[10px] uppercase tracking-[0.18em] text-slate-300">
                      minute_book
                    </span>
                  </div>

                  {!selected ? (
                    <div className="flex-1 min-h-0 rounded-xl border border-slate-800/80 bg-slate-950/60 p-3 text-[11px] text-slate-400">
                      Select a record to inspect evidence.
                    </div>
                  ) : (
                    <>
                      {/* Actions */}
                      <div className="rounded-xl border border-slate-800/80 bg-slate-950/60 p-3 shrink-0">
                        <div className="text-sm font-semibold text-slate-100">
                          {selected.title || selected.file_name || "Untitled filing"}
                        </div>

                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <span className="px-2 py-1 rounded-full bg-slate-900/60 border border-slate-800 text-[11px] text-slate-200 capitalize">
                            {selected.entry_type || "document"}
                          </span>
                          <span className="px-2 py-1 rounded-full bg-amber-500/10 border border-amber-500/30 text-[11px] text-amber-200">
                            {domains.find((d) => d.key === selected.domain_key)?.label || norm(selected.domain_key, "—")}
                          </span>
                        </div>

                        {pdfErr ? (
                          <div className="mt-3 rounded-xl border border-red-800/60 bg-red-950/40 px-3 py-2 text-[11px] text-red-300">
                            {pdfErr}
                          </div>
                        ) : null}

                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={viewPdf}
                            disabled={pdfBusy}
                            className={[
                              "rounded-full px-4 py-1.5 text-[11px] font-semibold tracking-[0.18em] uppercase transition",
                              pdfBusy
                                ? "bg-amber-500/20 text-amber-200/60 cursor-not-allowed"
                                : "bg-amber-500 text-black hover:bg-amber-400",
                            ].join(" ")}
                          >
                            View PDF
                          </button>

                          <button
                            type="button"
                            onClick={downloadPdf}
                            disabled={pdfBusy}
                            className={[
                              "rounded-full px-4 py-1.5 text-[11px] font-semibold tracking-[0.18em] uppercase transition",
                              pdfBusy
                                ? "bg-slate-800/40 text-slate-300/60 cursor-not-allowed"
                                : "bg-slate-200 text-black hover:bg-white",
                            ].join(" ")}
                          >
                            Download
                          </button>

                          <button
                            type="button"
                            onClick={openNewTab}
                            disabled={pdfBusy}
                            className={[
                              "rounded-full px-4 py-1.5 text-[11px] font-semibold tracking-[0.18em] uppercase transition border",
                              pdfBusy
                                ? "bg-slate-800/40 text-slate-300/60 border-slate-700/40 cursor-not-allowed"
                                : "bg-slate-900/60 text-slate-200 border-slate-700 hover:bg-slate-900",
                            ].join(" ")}
                            title="Open PDF in a new tab"
                          >
                            Open New Tab
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              setDeleteErr(null);
                              setDeleteOpen(true);
                            }}
                            className="rounded-full px-4 py-1.5 text-[11px] font-semibold tracking-[0.18em] uppercase bg-red-500/10 border border-red-500/30 text-red-200 hover:bg-red-500/15"
                            title="Hard-delete this filing (owner/admin only)"
                          >
                            Delete
                          </button>
                        </div>

                        <div className="mt-2 text-[10px] text-slate-500">
                          Deletion removes the Minute Book entry and stored files (bucket: <span className="text-slate-300">minute_book</span>).
                        </div>
                      </div>

                      {/* Inline Preview */}
                      <div className="mt-3 flex-1 min-h-0 rounded-xl border border-slate-800/80 bg-slate-950/60 overflow-hidden">
                        {previewUrl ? (
                          <iframe title="PDF Preview" src={previewUrl} className="h-full w-full" />
                        ) : (
                          <div className="h-full w-full grid place-items-center text-[11px] text-slate-500">
                            Preview will appear here after “View PDF”.
                          </div>
                        )}
                      </div>

                      {/* Metadata Zone */}
                      <div className="mt-3 rounded-xl border border-slate-800/80 bg-slate-950/60 p-3 shrink-0">
                        <div className="flex items-center justify-between mb-2">
                          <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">Metadata Zone</div>
                          <span className="px-2 py-0.5 rounded-full bg-slate-900/60 border border-slate-800 text-[10px] tracking-[0.18em] uppercase text-slate-300">
                            secondary
                          </span>
                        </div>

                        <div className="space-y-2">
                          <details className="rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2">
                            <summary className="cursor-pointer text-[11px] text-slate-200">Storage</summary>
                            <div className="mt-2 space-y-1 text-[11px] text-slate-300">
                              <div className="flex items-start justify-between gap-3">
                                <span className="text-slate-500">Path</span>
                                <span className="text-right font-mono break-all">{norm(selected.storage_path, "—")}</span>
                              </div>
                              <div className="flex items-start justify-between gap-3">
                                <span className="text-slate-500">File</span>
                                <span className="text-right break-all">{norm(selected.file_name, "—")}</span>
                              </div>
                              <div className="flex items-start justify-between gap-3">
                                <span className="text-slate-500">Size</span>
                                <span className="text-right">{fmtBytes(selected.file_size)}</span>
                              </div>
                              <div className="flex items-start justify-between gap-3">
                                <span className="text-slate-500">MIME</span>
                                <span className="text-right">{norm(selected.mime_type, "—")}</span>
                              </div>
                            </div>
                          </details>

                          <details open className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                            <summary className="cursor-pointer text-[11px] text-amber-200">Hash</summary>
                            <div className="mt-2 text-[11px] text-amber-100/90">
                              <div className="flex items-start justify-between gap-3">
                                <span className="text-amber-200/60">SHA-256</span>
                                <span className="text-right font-mono break-all">{shortHash(selected.file_hash)}</span>
                              </div>
                              <div className="mt-1 text-[10px] text-amber-200/60">
                                Minute Book is evidence access. Certification/attestation lives in Verified Registry.
                              </div>
                            </div>
                          </details>

                          <details className="rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2">
                            <summary className="cursor-pointer text-[11px] text-slate-200">Audit</summary>
                            <div className="mt-2 space-y-1 text-[11px] text-slate-300">
                              <div className="flex items-start justify-between gap-3">
                                <span className="text-slate-500">Created</span>
                                <span className="text-right">{ts(selected.created_at)}</span>
                              </div>
                              <div className="flex items-start justify-between gap-3">
                                <span className="text-slate-500">Created By</span>
                                <span className="text-right font-mono break-all">{norm(selected.created_by, "—")}</span>
                              </div>
                              <div className="flex items-start justify-between gap-3">
                                <span className="text-slate-500">Source</span>
                                <span className="text-right break-all">{norm(selected.source, "—")}</span>
                              </div>
                            </div>
                          </details>
                        </div>

                        <div className="mt-3 flex items-center justify-between text-[10px] text-slate-500">
                          <Link href="/ci-archive" className="hover:text-slate-200">
                            Archive Launchpad
                          </Link>
                          <span>Upload is the sole write entry point.</span>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </section>
            </div>
          )}

          <div className="mt-3 flex items-center justify-between text-[10px] text-slate-500">
            <span>CI-Archive · Oasis Digital Parliament</span>
            <span>ODP.AI · Governance Firmware</span>
          </div>
        </div>
      </div>

      {/* Focus PDF Overlay (big readable mode) */}
      {focusOpen && previewUrl ? (
        <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm">
          <div className="absolute inset-0 p-4 md:p-6">
            <div className="h-full w-full rounded-3xl border border-slate-800 bg-black/70 shadow-[0_0_80px_rgba(0,0,0,0.7)] overflow-hidden flex flex-col">
              <div className="shrink-0 px-4 py-3 border-b border-slate-800 flex items-center justify-between">
                <div className="min-w-0">
                  <div className="text-[11px] uppercase tracking-[0.25em] text-slate-500">Focus View</div>
                  <div className="text-sm text-slate-100 font-semibold truncate">
                    {selected?.title || selected?.file_name || "PDF"}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={openNewTab}
                    className="rounded-full px-4 py-1.5 text-[11px] font-semibold tracking-[0.18em] uppercase bg-slate-900/60 border border-slate-700 text-slate-200 hover:bg-slate-900"
                  >
                    Open New Tab
                  </button>
                  <button
                    type="button"
                    onClick={() => setFocusOpen(false)}
                    className="rounded-full px-4 py-1.5 text-[11px] font-semibold tracking-[0.18em] uppercase bg-amber-500 text-black hover:bg-amber-400"
                  >
                    Close
                  </button>
                </div>
              </div>

              <div className="flex-1 min-h-0">
                <iframe title="PDF Focus" src={previewUrl} className="h-full w-full" />
              </div>

              <div className="shrink-0 px-4 py-3 border-t border-slate-800 flex items-center justify-between text-[11px]">
                <span className="text-slate-400">
                  Hash: <span className="font-mono text-slate-200">{shortHash(selected?.file_hash || null)}</span>
                </span>
                <span className="text-slate-500">Evidence view • minute_book</span>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Delete Modal */}
      {deleteOpen ? (
        <div className="fixed inset-0 z-[70] bg-black/80 backdrop-blur-sm grid place-items-center p-4">
          <div className="w-full max-w-[520px] rounded-2xl border border-red-800/60 bg-slate-950/70 shadow-[0_0_60px_rgba(0,0,0,0.7)] p-5">
            <div className="text-[11px] uppercase tracking-[0.25em] text-red-300">Hard Delete</div>
            <div className="mt-1 text-lg font-semibold text-slate-50">Remove from Minute Book</div>
            <p className="mt-2 text-[12px] text-slate-300 leading-relaxed">
              This action permanently deletes:
              <span className="text-slate-100 font-semibold"> the Minute Book entry</span> and its associated stored files
              from <span className="font-mono text-slate-200">minute_book</span>. Use only for filing mistakes.
            </p>

            <div className="mt-4">
              <label className="text-[11px] text-slate-400">Reason (required)</label>
              <input
                value={deleteReason}
                onChange={(e) => setDeleteReason(e.target.value)}
                placeholder="e.g., Filed under wrong entity — re-uploaded correctly"
                className="mt-2 w-full rounded-xl bg-black/50 border border-slate-700 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 outline-none focus:border-red-500/40"
              />
              {deleteErr ? (
                <div className="mt-3 rounded-xl border border-red-800/60 bg-red-950/40 px-3 py-2 text-[11px] text-red-300">
                  {deleteErr}
                </div>
              ) : null}
            </div>

            <div className="mt-5 flex items-center justify-between">
              <button
                type="button"
                onClick={() => {
                  setDeleteOpen(false);
                  setDeleteErr(null);
                  setDeleteReason("");
                }}
                className="rounded-full px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase bg-slate-900/60 border border-slate-700 text-slate-200 hover:bg-slate-900"
              >
                Cancel
              </button>

              <button
                type="button"
                disabled={deleteBusy}
                onClick={confirmDelete}
                className={[
                  "rounded-full px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition",
                  deleteBusy
                    ? "bg-red-500/20 border border-red-500/20 text-red-200/60 cursor-not-allowed"
                    : "bg-red-500/10 border border-red-500/30 text-red-200 hover:bg-red-500/15",
                ].join(" ")}
              >
                {deleteBusy ? "Deleting…" : "Confirm Delete"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
