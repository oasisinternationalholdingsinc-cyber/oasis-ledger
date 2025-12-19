"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { useSearchParams } from "next/navigation";

type MinuteBookEntry = {
  id: string;
  entity_key: string;
  entity_id: string;
  domain_key: string;
  entry_date: string; // date
  entry_type: string; // enum (USER-DEFINED)
  title: string;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;

  file_name: string | null;
  section_name: string | null;
  storage_path: string | null;
  registry_status: string | null;
  instrument_date: string | null;
  source: string | null;
  source_record_id: string | null;
  source_envelope_id: string | null;
  pdf_hash: string | null;
};

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const BUCKET_MINUTE_BOOK = "minute_book";

/**
 * Executive defaults (your “FINAL OS ENTERPRISE” recs)
 * - Strict 3-column layout
 * - Fixed canonical domains + dynamic merge
 * - One query per page (no refetch loops)
 * - PDF preview in right panel only (iframe) when storage_path exists
 */
const CANONICAL_DOMAIN_ORDER: { key: string; label: string }[] = [
  { key: "articles", label: "Articles" },
  { key: "share-capital", label: "Share Capital" },
  { key: "directors-officers", label: "Directors & Officers" },
  { key: "resolutions", label: "Resolutions" },
  { key: "annual-returns", label: "Annual Returns" },
  { key: "tax-cra", label: "Tax & CRA" },
  { key: "banking", label: "Banking" },
  { key: "contracts", label: "Contracts" },
  { key: "licenses-compliance", label: "Licenses & Compliance" },
  { key: "other", label: "Other" },
];

function oasisSupabase(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
}

function titleize(raw: string): string {
  if (!raw) return raw;
  const s = raw
    .replace(/[_]/g, " ")
    .replace(/[-]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
  return s
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function formatDate(isoOrDate: string | null | undefined): string {
  if (!isoOrDate) return "—";
  // Handles both date and timestamptz
  const d = new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return isoOrDate;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
}

function pillClass(tone: "neutral" | "gold" | "muted" = "neutral") {
  switch (tone) {
    case "gold":
      return "border border-yellow-500/35 bg-yellow-500/10 text-yellow-200";
    case "muted":
      return "border border-white/10 bg-white/5 text-white/70";
    default:
      return "border border-white/12 bg-white/6 text-white/80";
  }
}

function copyToClipboard(text: string) {
  try {
    navigator.clipboard.writeText(text);
  } catch {
    // ignore
  }
}

export default function MinuteBookPage() {
  const sp = useSearchParams();

  // Entity scope: prefer URL, then localStorage (so OS feels “sticky”)
  const entityKeyFromUrl = sp.get("entity_key") || sp.get("entityKey") || sp.get("entity");
  const [entityKey, setEntityKey] = useState<string | null>(entityKeyFromUrl);

  useEffect(() => {
    if (entityKeyFromUrl) {
      setEntityKey(entityKeyFromUrl);
      try {
        localStorage.setItem("oasis_entity_key", entityKeyFromUrl);
      } catch {}
      return;
    }
    try {
      const saved = localStorage.getItem("oasis_entity_key");
      if (saved) setEntityKey(saved);
    } catch {}
  }, [entityKeyFromUrl]);

  const supabase = useMemo(() => oasisSupabase(), []);

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [entries, setEntries] = useState<MinuteBookEntry[]>([]);
  const [domainFilter, setDomainFilter] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // PDF preview url (signed)
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfErr, setPdfErr] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);

  // One stable query per page (only re-run when entityKey changes)
  useEffect(() => {
    let alive = true;

    async function load() {
      setLoading(true);
      setErr(null);
      setEntries([]);
      setSelectedId(null);
      setPdfUrl(null);
      setPdfErr(null);

      if (!entityKey) {
        setLoading(false);
        return;
      }

      const { data, error } = await supabase
        .from("minute_book_entries")
        .select("*")
        .eq("entity_key", entityKey)
        .order("entry_date", { ascending: false })
        .order("created_at", { ascending: false });

      if (!alive) return;

      if (error) {
        setErr(error.message || "Failed to load minute book entries.");
        setLoading(false);
        return;
      }

      const rows = (data || []) as MinuteBookEntry[];
      setEntries(rows);
      setLoading(false);

      // Default domain: first with records; else "all"
      const domainsWithCounts = new Map<string, number>();
      for (const r of rows) domainsWithCounts.set(r.domain_key, (domainsWithCounts.get(r.domain_key) || 0) + 1);

      if (rows.length > 0) {
        // Choose first entry’s domain for a “feels alive” default
        const defaultDomain = rows[0]?.domain_key || "all";
        setDomainFilter(defaultDomain || "all");
        setSelectedId(rows[0].id);
      } else {
        setDomainFilter("all");
        setSelectedId(null);
      }
    }

    load();
    return () => {
      alive = false;
    };
  }, [supabase, entityKey]);

  // Derived: domain list (canonical + dynamic merge) + counts
  const domainCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of entries) m.set(e.domain_key, (m.get(e.domain_key) || 0) + 1);
    return m;
  }, [entries]);

  const domainItems = useMemo(() => {
    const dynamic = Array.from(domainCounts.keys()).filter(Boolean);

    const canonicalKeys = new Set(CANONICAL_DOMAIN_ORDER.map((d) => d.key));
    const merged: { key: string; label: string; count: number }[] = [];

    // Canonical first (stable/enterprise feel)
    for (const d of CANONICAL_DOMAIN_ORDER) {
      merged.push({ key: d.key, label: d.label, count: domainCounts.get(d.key) || 0 });
    }

    // Add dynamic domains not in canonical (so nothing disappears)
    for (const k of dynamic) {
      if (!canonicalKeys.has(k)) merged.push({ key: k, label: titleize(k), count: domainCounts.get(k) || 0 });
    }

    // If there are no entries at all, still show canonical list (counts=0)
    return merged;
  }, [domainCounts]);

  const filteredEntries = useMemo(() => {
    if (domainFilter === "all") return entries;
    return entries.filter((e) => e.domain_key === domainFilter);
  }, [entries, domainFilter]);

  const selected = useMemo(() => {
    if (!selectedId) return null;
    return entries.find((e) => e.id === selectedId) || null;
  }, [entries, selectedId]);

  // When filter changes, pick first item (no refetch; no flicker)
  useEffect(() => {
    if (loading) return;
    if (!filteredEntries.length) {
      setSelectedId(null);
      return;
    }
    // If current selection not in filtered list, auto-select first
    const stillValid = selectedId && filteredEntries.some((e) => e.id === selectedId);
    if (!stillValid) setSelectedId(filteredEntries[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domainFilter, loading]);

  // PDF preview: signed url generated ONLY for selected row with storage_path
  useEffect(() => {
    let alive = true;

    async function buildPreview() {
      setPdfUrl(null);
      setPdfErr(null);

      if (!selected?.storage_path) return;

      // Only preview PDFs (by file_name)
      const isPdf = (selected.file_name || "").toLowerCase().endsWith(".pdf");
      if (!isPdf) return;

      setPdfLoading(true);

      // Signed URL for private bucket access (10 minutes)
      const { data, error } = await supabase.storage
        .from(BUCKET_MINUTE_BOOK)
        .createSignedUrl(selected.storage_path, 60 * 10);

      if (!alive) return;

      if (error || !data?.signedUrl) {
        setPdfErr("Preview unavailable — download to view.");
        setPdfLoading(false);
        return;
      }

      // Fit horizontally (keeps it “inspector panel” clean)
      setPdfUrl(`${data.signedUrl}#view=FitH`);
      setPdfLoading(false);
    }

    buildPreview();
    return () => {
      alive = false;
    };
  }, [supabase, selected?.storage_path, selected?.file_name]);

  async function downloadFile() {
    if (!selected?.storage_path) return;
    // Use signed URL to open in new tab (download/open)
    const { data, error } = await supabase.storage
      .from(BUCKET_MINUTE_BOOK)
      .createSignedUrl(selected.storage_path, 60 * 10);

    if (error || !data?.signedUrl) {
      setPdfErr("Download unavailable — please verify storage policies.");
      return;
    }

    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  }

  return (
    <div className="min-h-[calc(100vh-0px)] bg-black text-white">
      {/* OS Header */}
      <div className="sticky top-0 z-20 border-b border-white/10 bg-black/80 backdrop-blur">
        <div className="mx-auto max-w-[1600px] px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-yellow-500/25 bg-yellow-500/10">
                  <DocIcon />
                </span>
                <h1 className="text-lg font-semibold tracking-tight">CI-Archive · Minute Book</h1>
                <span className="ml-2 rounded-full border border-yellow-500/25 bg-yellow-500/10 px-2 py-0.5 text-xs text-yellow-100/90">
                  Registry
                </span>
              </div>
              <p className="mt-1 text-sm text-white/60">
                Read-only minute book registry. Domains → Entries → Details. PDF preview appears only when a PDF is present.
              </p>
            </div>

            <div className="flex items-center gap-2">
              {entityKey ? (
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/80">
                  Entity: <span className="text-white/95">{entityKey}</span>
                </span>
              ) : (
                <span className="rounded-full border border-red-500/25 bg-red-500/10 px-3 py-1 text-xs text-red-200">
                  No entity selected
                </span>
              )}
              <a
                href="/ci-archive/upload"
                className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/85 hover:bg-white/10"
                title="Upload is the only write entry point (handled last)."
              >
                <UploadIcon />
                Upload
              </a>
            </div>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="mx-auto max-w-[1600px] px-5 py-5">
        {err ? (
          <div className="mb-4 rounded-2xl border border-red-500/25 bg-red-500/10 p-4 text-sm text-red-100">
            <div className="font-semibold">Could not load minute book entries</div>
            <div className="mt-1 text-red-100/80">{err}</div>
          </div>
        ) : null}

        {!entityKey ? (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
            <div className="text-base font-semibold">Select an entity to view the Minute Book.</div>
            <div className="mt-2 text-sm text-white/70">
              This page expects an <span className="text-white/90">entity_key</span> (from OS scope or URL).
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <HintPill text="Tip: open from CI-Archive launchpad with entity selected" />
              <HintPill text='Or add "?entity_key=holdings" to the URL (example)' />
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-12 gap-4">
            {/* Left: Domains */}
            <div className="col-span-12 lg:col-span-3">
              <Panel title="Domains" subtitle="Canonical, stable governance grouping">
                <div className="mb-3 flex items-center gap-2">
                  <button
                    onClick={() => setDomainFilter("all")}
                    className={[
                      "w-full rounded-xl px-3 py-2 text-left text-sm transition",
                      domainFilter === "all"
                        ? "border border-yellow-500/30 bg-yellow-500/10 text-yellow-100"
                        : "border border-white/10 bg-white/5 text-white/80 hover:bg-white/10",
                    ].join(" ")}
                  >
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-2">
                        <GridIcon />
                        All
                      </span>
                      <span className="rounded-full border border-white/10 bg-black/30 px-2 py-0.5 text-xs text-white/70">
                        {entries.length}
                      </span>
                    </div>
                  </button>
                </div>

                <div className="space-y-2">
                  {loading ? (
                    <SkeletonList rows={8} />
                  ) : (
                    domainItems.map((d) => (
                      <button
                        key={d.key}
                        onClick={() => setDomainFilter(d.key)}
                        className={[
                          "w-full rounded-xl px-3 py-2 text-left text-sm transition",
                          domainFilter === d.key
                            ? "border border-yellow-500/30 bg-yellow-500/10 text-yellow-100"
                            : "border border-white/10 bg-white/5 text-white/80 hover:bg-white/10",
                        ].join(" ")}
                        title={d.key}
                      >
                        <div className="flex items-center justify-between">
                          <span className="flex items-center gap-2">
                            <FolderIcon />
                            {d.label}
                          </span>
                          <span className="rounded-full border border-white/10 bg-black/30 px-2 py-0.5 text-xs text-white/70">
                            {d.count}
                          </span>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </Panel>
            </div>

            {/* Middle: Entries */}
            <div className="col-span-12 lg:col-span-5">
              <Panel
                title="Entries"
                subtitle={
                  loading
                    ? "Loading…"
                    : filteredEntries.length
                    ? `${filteredEntries.length} record${filteredEntries.length === 1 ? "" : "s"}`
                    : "No records in this domain"
                }
              >
                <div className="max-h-[72vh] overflow-auto pr-1">
                  {loading ? (
                    <SkeletonCards rows={6} />
                  ) : filteredEntries.length === 0 ? (
                    <EmptyState
                      title="No minute book entries yet"
                      desc="Your registry is ready. Once uploads/registering begin, entries will appear here under domains."
                      ctaHref="/ci-archive/upload"
                      ctaText="Go to Upload"
                    />
                  ) : (
                    <div className="space-y-2">
                      {filteredEntries.map((e) => {
                        const isSelected = e.id === selectedId;
                        const hasFile = !!e.storage_path;
                        return (
                          <button
                            key={e.id}
                            onClick={() => setSelectedId(e.id)}
                            className={[
                              "w-full rounded-2xl border p-3 text-left transition",
                              isSelected
                                ? "border-yellow-500/25 bg-yellow-500/10"
                                : "border-white/10 bg-white/5 hover:bg-white/10",
                            ].join(" ")}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="truncate text-sm font-semibold text-white/95">{e.title}</span>
                                  {hasFile ? (
                                    <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-white/70">
                                      <PaperclipIcon />
                                      File
                                    </span>
                                  ) : null}
                                </div>
                                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-white/60">
                                  <span>{formatDate(e.entry_date)}</span>
                                  <span className="text-white/35">•</span>
                                  <span className={`rounded-full px-2 py-0.5 ${pillClass("muted")}`}>
                                    {titleize(e.entry_type)}
                                  </span>
                                  {e.registry_status ? (
                                    <span className={`rounded-full px-2 py-0.5 ${pillClass("neutral")}`}>
                                      {titleize(e.registry_status)}
                                    </span>
                                  ) : null}
                                  {e.section_name ? (
                                    <>
                                      <span className="text-white/35">•</span>
                                      <span className="truncate">{e.section_name}</span>
                                    </>
                                  ) : null}
                                </div>
                              </div>
                              <span className="mt-0.5 inline-flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-black/30 text-white/70">
                                <ChevronRight />
                              </span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </Panel>
            </div>

            {/* Right: Details */}
            <div className="col-span-12 lg:col-span-4">
              <Panel title="Details" subtitle="Inspector view · PDF preview (when present)">
                <div className="max-h-[72vh] overflow-auto pr-1">
                  {loading ? (
                    <SkeletonDetail />
                  ) : !selected ? (
                    <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-white/70">
                      Select an entry to view details.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {/* Header */}
                      <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-base font-semibold text-white/95">{selected.title}</div>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-white/60">
                              <span className={`rounded-full px-2 py-0.5 ${pillClass("muted")}`}>
                                {titleize(selected.domain_key)}
                              </span>
                              <span className={`rounded-full px-2 py-0.5 ${pillClass("muted")}`}>
                                {titleize(selected.entry_type)}
                              </span>
                              {selected.registry_status ? (
                                <span className={`rounded-full px-2 py-0.5 ${pillClass("gold")}`}>
                                  {titleize(selected.registry_status)}
                                </span>
                              ) : null}
                            </div>
                          </div>

                          <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-yellow-500/25 bg-yellow-500/10">
                            <SealIcon />
                          </span>
                        </div>

                        <div className="mt-4 grid grid-cols-2 gap-2 text-xs text-white/70">
                          <Info label="Entry date" value={formatDate(selected.entry_date)} />
                          <Info label="Instrument date" value={formatDate(selected.instrument_date)} />
                          <Info label="Created" value={formatDate(selected.created_at)} />
                          <Info label="Updated" value={formatDate(selected.updated_at)} />
                        </div>
                      </div>

                      {/* Notes */}
                      <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                        <div className="mb-2 text-xs font-semibold text-white/80">Notes</div>
                        {selected.notes ? (
                          <div className="whitespace-pre-wrap text-sm text-white/80">{selected.notes}</div>
                        ) : (
                          <div className="text-sm text-white/50">No notes.</div>
                        )}
                      </div>

                      {/* File */}
                      <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <div className="text-xs font-semibold text-white/80">File</div>
                          {selected.storage_path ? (
                            <button
                              onClick={downloadFile}
                              className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/85 hover:bg-white/10"
                            >
                              <DownloadIcon />
                              Open / Download
                            </button>
                          ) : null}
                        </div>

                        {selected.storage_path ? (
                          <div className="space-y-2 text-xs text-white/70">
                            <Info label="File name" value={selected.file_name || "—"} />
                            <div className="grid grid-cols-1 gap-2">
                              <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="text-[11px] text-white/50">SHA-256</div>
                                    <div className="mt-1 break-all text-[12px] text-white/80">
                                      {selected.pdf_hash || "—"}
                                    </div>
                                  </div>
                                  {selected.pdf_hash ? (
                                    <button
                                      onClick={() => copyToClipboard(selected.pdf_hash!)}
                                      className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-white/75 hover:bg-white/10"
                                      title="Copy SHA-256"
                                    >
                                      Copy
                                    </button>
                                  ) : null}
                                </div>
                              </div>

                              <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="text-[11px] text-white/50">storage_path</div>
                                    <div className="mt-1 break-all text-[12px] text-white/80">
                                      {selected.storage_path}
                                    </div>
                                  </div>
                                  <button
                                    onClick={() => copyToClipboard(selected.storage_path!)}
                                    className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-white/75 hover:bg-white/10"
                                    title="Copy storage_path"
                                  >
                                    Copy
                                  </button>
                                </div>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div className="text-sm text-white/50">No file linked for this entry.</div>
                        )}
                      </div>

                      {/* PDF Preview */}
                      {selected.storage_path && (selected.file_name || "").toLowerCase().endsWith(".pdf") ? (
                        <div className="rounded-2xl border border-yellow-500/20 bg-yellow-500/5 p-4">
                          <div className="mb-3 flex items-center justify-between gap-2">
                            <div className="text-xs font-semibold text-yellow-100/90">PDF Preview</div>
                            {pdfLoading ? (
                              <span className="text-xs text-yellow-100/60">Preparing…</span>
                            ) : null}
                          </div>

                          {pdfUrl ? (
                            <div className="overflow-hidden rounded-xl border border-yellow-500/15 bg-black">
                              <iframe
                                title="PDF Preview"
                                src={pdfUrl}
                                className="h-[460px] w-full"
                                loading="lazy"
                              />
                            </div>
                          ) : pdfErr ? (
                            <div className="rounded-xl border border-white/10 bg-black/30 p-3 text-sm text-white/70">
                              {pdfErr}
                            </div>
                          ) : (
                            <div className="rounded-xl border border-white/10 bg-black/30 p-3 text-sm text-white/70">
                              Preview unavailable — download to view.
                            </div>
                          )}
                        </div>
                      ) : null}

                      {/* Linking hooks (optional) */}
                      {(selected.source_record_id || selected.source_envelope_id) && (
                        <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                          <div className="mb-2 text-xs font-semibold text-white/80">Links</div>
                          <div className="space-y-2">
                            {selected.source_record_id ? (
                              <a
                                href={`/ci-archive/ledger?entity_key=${encodeURIComponent(entityKey || "")}&source_record_id=${encodeURIComponent(
                                  selected.source_record_id
                                )}`}
                                className="inline-flex w-full items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/85 hover:bg-white/10"
                              >
                                <span className="flex items-center gap-2">
                                  <LinkIcon />
                                  View Ledger Record
                                </span>
                                <ChevronRight />
                              </a>
                            ) : null}

                            {selected.source_envelope_id ? (
                              <a
                                href={`/ci-forge?envelope_id=${encodeURIComponent(selected.source_envelope_id)}`}
                                className="inline-flex w-full items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/85 hover:bg-white/10"
                              >
                                <span className="flex items-center gap-2">
                                  <LinkIcon />
                                  View Signature Envelope
                                </span>
                                <ChevronRight />
                              </a>
                            ) : null}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </Panel>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- UI atoms (no external deps) ---------- */

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-3xl border border-white/10 bg-white/4 shadow-[0_0_0_1px_rgba(255,255,255,0.02)]">
      <div className="border-b border-white/10 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-white/90">{title}</div>
            {subtitle ? <div className="mt-0.5 text-xs text-white/55">{subtitle}</div> : null}
          </div>
        </div>
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/30 p-2">
      <div className="text-[11px] text-white/50">{label}</div>
      <div className="mt-0.5 text-xs text-white/80">{value}</div>
    </div>
  );
}

function HintPill({ text }: { text: string }) {
  return (
    <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70">{text}</span>
  );
}

function EmptyState({
  title,
  desc,
  ctaHref,
  ctaText,
}: {
  title: string;
  desc: string;
  ctaHref?: string;
  ctaText?: string;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
      <div className="text-sm font-semibold text-white/90">{title}</div>
      <div className="mt-1 text-sm text-white/65">{desc}</div>
      {ctaHref && ctaText ? (
        <a
          href={ctaHref}
          className="mt-4 inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/85 hover:bg-white/10"
        >
          <UploadIcon />
          {ctaText}
        </a>
      ) : null}
    </div>
  );
}

function SkeletonList({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-10 w-full animate-pulse rounded-xl border border-white/10 bg-white/5"
        />
      ))}
    </div>
  );
}

function SkeletonCards({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-20 w-full animate-pulse rounded-2xl border border-white/10 bg-white/5"
        />
      ))}
    </div>
  );
}

function SkeletonDetail() {
  return (
    <div className="space-y-3">
      <div className="h-28 animate-pulse rounded-2xl border border-white/10 bg-white/5" />
      <div className="h-24 animate-pulse rounded-2xl border border-white/10 bg-white/5" />
      <div className="h-40 animate-pulse rounded-2xl border border-white/10 bg-white/5" />
    </div>
  );
}

/* ---------- Icons ---------- */

function DocIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-yellow-200">
      <path
        d="M7 3h7l3 3v15a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path d="M14 3v4h4" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 12h8M8 16h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-white/70">
      <path
        d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"
        stroke="currentColor"
        strokeWidth="1.6"
      />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-white/70">
      <path d="M4 4h7v7H4V4Zm9 0h7v7h-7V4ZM4 13h7v7H4v-7Zm9 0h7v7h-7v-7Z" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-white/80">
      <path d="M12 3v10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M8 7l4-4 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-white/80">
      <path d="M12 3v10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M8 11l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 20h16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-white/70">
      <path
        d="M21 10.5 12.5 19a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 1 1-3-3l8.5-8.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SealIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-yellow-200">
      <path
        d="M12 2l2.2 4.4L19 7l-3.5 3.4.8 4.8L12 13.8 7.7 15.2l.8-4.8L5 7l4.8-.6L12 2Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M8 22l4-2 4 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-white/80">
      <path
        d="M10 13a5 5 0 0 1 0-7l1-1a5 5 0 0 1 7 7l-1 1"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M14 11a5 5 0 0 1 0 7l-1 1a5 5 0 0 1-7-7l1-1"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-white/70">
      <path d="M9 18l6-6-6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
