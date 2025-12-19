"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { useSearchParams } from "next/navigation";

type MinuteBookEntry = {
  id: string;
  entity_key: string;
  domain_key: string;
  entry_date: string; // date
  entry_type: string; // enum
  title: string;
  notes: string | null;

  registry_status: string | null;
  instrument_date: string | null;

  file_name: string | null;
  storage_path: string | null;
  pdf_hash: string | null;

  created_at: string;
  updated_at: string;

  source_record_id: string | null;
  source_envelope_id: string | null;
};

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const BUCKET_MINUTE_BOOK = "minute_book";

// OS-Executive canonical domains (stable ordering)
const CANONICAL_DOMAINS: { key: string; label: string }[] = [
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

function supabaseBrowser(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
}

function titleize(raw: string): string {
  if (!raw) return raw;
  return raw
    .replace(/_/g, " ")
    .replace(/-/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function fmtDate(v?: string | null) {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
}

function cls(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function isPdf(name?: string | null) {
  return (name || "").toLowerCase().endsWith(".pdf");
}

export default function MinuteBookClient() {
  const sp = useSearchParams();
  const supabase = useMemo(() => supabaseBrowser(), []);

  // Canonical entity scope: URL param first, then storage fallback
  const [entityKey, setEntityKey] = useState<string | null>(null);

  useEffect(() => {
    const fromUrl = sp.get("entity_key") || sp.get("entityKey") || sp.get("entity");
    if (fromUrl) {
      setEntityKey(fromUrl);
      try {
        localStorage.setItem("oasis_entity_key", fromUrl);
      } catch {}
      return;
    }
    try {
      const saved = localStorage.getItem("oasis_entity_key");
      if (saved) setEntityKey(saved);
    } catch {}
  }, [sp]);

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [entries, setEntries] = useState<MinuteBookEntry[]>([]);

  const [domain, setDomain] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [q, setQ] = useState("");

  // Right-panel: preview collapsible
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewErr, setPreviewErr] = useState<string | null>(null);

  // One query per page (no flicker)
  useEffect(() => {
    let alive = true;

    async function load() {
      setLoading(true);
      setErr(null);
      setEntries([]);
      setSelectedId(null);
      setPreviewOpen(false);
      setPreviewUrl(null);
      setPreviewErr(null);

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

      if (rows.length) {
        // Default: pick the first row domain, select first row
        setDomain(rows[0].domain_key || "all");
        setSelectedId(rows[0].id);
      } else {
        setDomain("all");
      }
    }

    load();
    return () => {
      alive = false;
    };
  }, [supabase, entityKey]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of entries) m.set(e.domain_key, (m.get(e.domain_key) || 0) + 1);
    return m;
  }, [entries]);

  const domainRail = useMemo(() => {
    const canonicalKeys = new Set(CANONICAL_DOMAINS.map((d) => d.key));
    const dynamic = Array.from(counts.keys()).filter((k) => k && !canonicalKeys.has(k));

    const items: Array<{ key: string; label: string; count: number }> = [];

    for (const d of CANONICAL_DOMAINS) items.push({ key: d.key, label: d.label, count: counts.get(d.key) || 0 });
    for (const k of dynamic) items.push({ key: k, label: titleize(k), count: counts.get(k) || 0 });

    return items;
  }, [counts]);

  const filtered = useMemo(() => {
    const base = domain === "all" ? entries : entries.filter((e) => e.domain_key === domain);
    if (!q.trim()) return base;
    const s = q.trim().toLowerCase();
    return base.filter(
      (e) => (e.title || "").toLowerCase().includes(s) || (e.file_name || "").toLowerCase().includes(s)
    );
  }, [entries, domain, q]);

  const selected = useMemo(() => {
    if (!selectedId) return null;
    return entries.find((e) => e.id === selectedId) || null;
  }, [entries, selectedId]);

  // Keep selection valid when filters change
  useEffect(() => {
    if (loading) return;
    if (!filtered.length) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !filtered.some((e) => e.id === selectedId)) {
      setSelectedId(filtered[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain, q, loading]);

  async function openDownload() {
    if (!selected?.storage_path) return;
    const { data, error } = await supabase.storage.from(BUCKET_MINUTE_BOOK).createSignedUrl(selected.storage_path, 60 * 10);
    if (error || !data?.signedUrl) return;
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  }

  async function ensurePreviewUrl() {
    setPreviewErr(null);
    setPreviewUrl(null);

    if (!selected?.storage_path || !isPdf(selected.file_name)) {
      setPreviewErr("No PDF available for preview.");
      return;
    }

    setPreviewBusy(true);
    const { data, error } = await supabase.storage.from(BUCKET_MINUTE_BOOK).createSignedUrl(selected.storage_path, 60 * 10);

    if (error || !data?.signedUrl) {
      setPreviewErr("Preview unavailable — use Open/Download.");
      setPreviewBusy(false);
      return;
    }

    setPreviewUrl(`${data.signedUrl}#view=FitH`);
    setPreviewBusy(false);
  }

  // If selection changes, close preview (keeps it calm)
  useEffect(() => {
    setPreviewOpen(false);
    setPreviewUrl(null);
    setPreviewErr(null);
    setPreviewBusy(false);
  }, [selectedId]);

  return (
    <div className="min-h-screen bg-black text-white">
      {/* OS-quiet section bar (no hero header) */}
      <div className="mx-auto max-w-[1600px] px-5 pt-5">
        <div className="rounded-2xl border border-white/10 bg-white/5">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-yellow-500/20 bg-yellow-500/10">
                  <VaultIcon />
                </span>
                <div className="text-sm font-semibold tracking-tight text-white/95">Minute Book</div>
                <span className="rounded-full border border-white/10 bg-black/30 px-2 py-0.5 text-[11px] text-white/70">
                  Registry-only
                </span>
              </div>
              <div className="mt-1 text-xs text-white/55">
                Domains → Entries → Details · Non-destructive · PDF preview on demand
              </div>
            </div>

            <div className="flex items-center gap-2">
              {entityKey ? (
                <span className="rounded-full border border-white/10 bg-black/30 px-3 py-1 text-xs text-white/75">
                  Entity: <span className="text-white/95">{entityKey}</span>
                </span>
              ) : (
                <span className="rounded-full border border-red-500/25 bg-red-500/10 px-3 py-1 text-xs text-red-200">
                  No entity scope
                </span>
              )}
              <a
                href={`/ci-archive/upload${entityKey ? `?entity_key=${encodeURIComponent(entityKey)}` : ""}`}
                className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10"
                title="Upload is the only write entry point"
              >
                <UploadIcon />
                Upload
              </a>
            </div>
          </div>

          {/* ultra-thin gold pulse separator */}
          <div className="h-px w-full bg-gradient-to-r from-transparent via-yellow-500/35 to-transparent" />
        </div>

        {err ? (
          <div className="mt-3 rounded-2xl border border-red-500/25 bg-red-500/10 p-4 text-sm text-red-100">
            <div className="font-semibold">Could not load minute book</div>
            <div className="mt-1 text-red-100/80">{err}</div>
          </div>
        ) : null}
      </div>

      {/* Main 3-column OS layout */}
      <div className="mx-auto max-w-[1600px] px-5 pb-8 pt-4">
        {!entityKey ? (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
            <div className="text-sm font-semibold text-white/90">No entity selected.</div>
            <div className="mt-2 text-sm text-white/65">
              Your OS entity selector should append <span className="text-white/85">?entity_key=...</span> to the URL.
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)_420px]">
            {/* LEFT: Domain rail */}
            <div className="rounded-3xl border border-white/10 bg-white/5">
              <div className="px-4 py-3">
                <div className="text-xs font-semibold tracking-wide text-white/55">INDEX</div>
                <div className="mt-1 text-[11px] text-white/45">Domains</div>
              </div>
              <div className="h-px bg-white/10" />

              <div className="p-2">
                <RailItem label="All" count={entries.length} active={domain === "all"} onClick={() => setDomain("all")} />
                <div className="my-2 h-px bg-white/10" />
                {loading ? (
                  <div className="space-y-2 px-2 py-2">
                    {Array.from({ length: 8 }).map((_, i) => (
                      <div key={i} className="h-9 animate-pulse rounded-xl bg-white/5" />
                    ))}
                  </div>
                ) : (
                  <div className="space-y-1">
                    {domainRail.map((d) => (
                      <RailItem
                        key={d.key}
                        label={d.label}
                        count={d.count}
                        active={domain === d.key}
                        onClick={() => setDomain(d.key)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* MIDDLE: Registry list */}
            <div className="rounded-3xl border border-white/10 bg-white/5">
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <div>
                  <div className="text-xs font-semibold tracking-wide text-white/55">REGISTRY</div>
                  <div className="mt-1 text-[11px] text-white/45">
                    {loading ? "Loading…" : `${filtered.length} record${filtered.length === 1 ? "" : "s"}`}
                  </div>
                </div>

                <div className="w-[260px] max-w-full">
                  <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                    <SearchIcon />
                    <input
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      placeholder="Search titles / file names…"
                      className="w-full bg-transparent text-xs text-white/85 placeholder:text-white/35 outline-none"
                    />
                  </div>
                </div>
              </div>
              <div className="h-px bg-white/10" />

              <div className="max-h-[72vh] overflow-auto">
                {loading ? (
                  <div className="space-y-2 p-3">
                    {Array.from({ length: 6 }).map((_, i) => (
                      <div key={i} className="h-14 animate-pulse rounded-2xl bg-white/5" />
                    ))}
                  </div>
                ) : filtered.length === 0 ? (
                  <div className="p-5">
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-5">
                      <div className="text-sm font-semibold text-white/90">Registry is empty</div>
                      <div className="mt-1 text-sm text-white/60">
                        No minute book entries exist for this scope yet. Upload is the only write entry point.
                      </div>
                      <a
                        href={`/ci-archive/upload?entity_key=${encodeURIComponent(entityKey)}`}
                        className="mt-4 inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/85 hover:bg-white/10"
                      >
                        <UploadIcon />
                        Go to Upload
                      </a>
                    </div>
                  </div>
                ) : (
                  <div>
                    {filtered.map((e) => {
                      const active = e.id === selectedId;
                      const hasFile = !!e.storage_path;
                      return (
                        <button
                          key={e.id}
                          onClick={() => setSelectedId(e.id)}
                          className={cls(
                            "w-full text-left transition",
                            "border-b border-white/10",
                            "hover:bg-white/5",
                            active && "bg-yellow-500/10"
                          )}
                        >
                          <div className="flex items-center justify-between gap-3 px-4 py-3">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className={cls("h-4 w-[2px] rounded-full", active ? "bg-yellow-400/80" : "bg-transparent")} />
                                <div className="truncate text-sm font-semibold text-white/90">{e.title}</div>
                              </div>

                              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-white/55">
                                <span>{fmtDate(e.entry_date)}</span>
                                <span className="text-white/30">•</span>
                                <span className="rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-[11px] text-white/70">
                                  {titleize(e.entry_type)}
                                </span>
                                {e.registry_status ? (
                                  <span className="rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-[11px] text-white/70">
                                    {titleize(e.registry_status)}
                                  </span>
                                ) : null}
                              </div>
                            </div>

                            <div className="flex items-center gap-2">
                              {hasFile ? (
                                <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-[11px] text-white/70">
                                  <PaperclipIcon />
                                  File
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-black/10 px-2 py-0.5 text-[11px] text-white/40">
                                  No File
                                </span>
                              )}
                              <ChevronRight />
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* RIGHT: Inspector */}
            <div className="rounded-3xl border border-white/10 bg-white/5">
              <div className="px-4 py-3">
                <div className="text-xs font-semibold tracking-wide text-white/55">INSPECTOR</div>
                <div className="mt-1 text-[11px] text-white/45">Details</div>
              </div>
              <div className="h-px bg-white/10" />

              <div className="max-h-[72vh] overflow-auto p-4">
                {loading ? (
                  <div className="space-y-3">
                    <div className="h-24 animate-pulse rounded-2xl bg-white/5" />
                    <div className="h-20 animate-pulse rounded-2xl bg-white/5" />
                    <div className="h-44 animate-pulse rounded-2xl bg-white/5" />
                  </div>
                ) : !selected ? (
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-white/65">
                    Select an entry to view details.
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-base font-semibold text-white/95">{selected.title}</div>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <Badge>{titleize(selected.domain_key)}</Badge>
                            <Badge>{titleize(selected.entry_type)}</Badge>
                            {selected.registry_status ? <GoldBadge>{titleize(selected.registry_status)}</GoldBadge> : null}
                          </div>
                        </div>
                        <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-yellow-500/20 bg-yellow-500/10">
                          <SealIcon />
                        </span>
                      </div>

                      <div className="mt-4 grid grid-cols-2 gap-2">
                        <Meta label="Entry date" value={fmtDate(selected.entry_date)} />
                        <Meta label="Instrument date" value={fmtDate(selected.instrument_date)} />
                        <Meta label="Updated" value={fmtDate(selected.updated_at)} />
                        <Meta label="Created" value={fmtDate(selected.created_at)} />
                      </div>
                    </div>

                    <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                      <div className="text-xs font-semibold tracking-wide text-white/55">NOTES</div>
                      <div className="mt-2 whitespace-pre-wrap text-sm text-white/80">
                        {selected.notes ? selected.notes : <span className="text-white/45">No notes.</span>}
                      </div>
                    </div>

                    <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-xs font-semibold tracking-wide text-white/55">FILE</div>
                        {selected.storage_path ? (
                          <button
                            onClick={openDownload}
                            className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/85 hover:bg-white/10"
                          >
                            <DownloadIcon />
                            Open / Download
                          </button>
                        ) : null}
                      </div>

                      {selected.storage_path ? (
                        <div className="mt-3 space-y-2">
                          <Meta label="File name" value={selected.file_name || "—"} />
                          <Meta label="SHA-256" value={selected.pdf_hash || "—"} mono />
                          <Meta label="storage_path" value={selected.storage_path} mono />
                        </div>
                      ) : (
                        <div className="mt-2 text-sm text-white/45">No file linked for this entry.</div>
                      )}
                    </div>

                    {selected.storage_path && isPdf(selected.file_name) ? (
                      <div className="rounded-2xl border border-yellow-500/20 bg-yellow-500/5">
                        <button
                          onClick={async () => {
                            const next = !previewOpen;
                            setPreviewOpen(next);
                            if (next && !previewUrl && !previewBusy) {
                              await ensurePreviewUrl();
                            }
                          }}
                          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                        >
                          <div>
                            <div className="text-xs font-semibold tracking-wide text-yellow-100/80">PREVIEW</div>
                            <div className="mt-0.5 text-[11px] text-yellow-100/55">
                              {previewOpen ? "Collapse PDF preview" : "Open PDF preview"}
                            </div>
                          </div>
                          <span className={cls("transition", previewOpen ? "rotate-90" : "rotate-0")}>
                            <ChevronRight />
                          </span>
                        </button>

                        {previewOpen ? (
                          <div className="border-t border-yellow-500/15 p-4">
                            {previewBusy ? (
                              <div className="rounded-xl border border-white/10 bg-black/20 p-3 text-sm text-white/65">
                                Preparing preview…
                              </div>
                            ) : previewUrl ? (
                              <div className="overflow-hidden rounded-xl border border-yellow-500/15 bg-black">
                                <iframe title="PDF Preview" src={previewUrl} className="h-[420px] w-full" />
                              </div>
                            ) : (
                              <div className="rounded-xl border border-white/10 bg-black/20 p-3 text-sm text-white/65">
                                {previewErr || "Preview unavailable — use Open/Download."}
                              </div>
                            )}
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    {(selected.source_record_id || selected.source_envelope_id) ? (
                      <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                        <div className="text-xs font-semibold tracking-wide text-white/55">LINKS</div>
                        <div className="mt-3 space-y-2">
                          {selected.source_record_id ? (
                            <a
                              href={`/ci-archive/ledger?entity_key=${encodeURIComponent(entityKey)}&source_record_id=${encodeURIComponent(
                                selected.source_record_id
                              )}`}
                              className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/85 hover:bg-white/10"
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
                              className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/85 hover:bg-white/10"
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
                    ) : null}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- Small OS atoms ---------- */

function RailItem({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cls(
        "flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left transition",
        active ? "bg-yellow-500/10" : "hover:bg-white/5"
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className={cls("h-4 w-[2px] rounded-full", active ? "bg-yellow-400/80" : "bg-transparent")} />
        <span className={cls("truncate text-sm", active ? "text-white/95" : "text-white/75")}>{label}</span>
      </div>
      <span
        className={cls(
          "shrink-0 rounded-full px-2 py-0.5 text-[11px]",
          active
            ? "text-yellow-100/80 border border-yellow-500/20 bg-yellow-500/10"
            : "text-white/55 border border-white/10 bg-black/20"
        )}
      >
        {count}
      </span>
    </button>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-[11px] text-white/70">
      {children}
    </span>
  );
}

function GoldBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-yellow-500/20 bg-yellow-500/10 px-2 py-0.5 text-[11px] text-yellow-100/80">
      {children}
    </span>
  );
}

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/20 p-3">
      <div className="text-[11px] tracking-wide text-white/45">{label.toUpperCase()}</div>
      <div className={cls("mt-1 text-xs text-white/80", mono && "break-all font-mono")}>{value}</div>
    </div>
  );
}

/* ---------- Icons (minimal, OS-style) ---------- */

function VaultIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-yellow-200">
      <path
        d="M4 7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7Z"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0-6 0Z" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 9v3l2 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-white/80">
      <path d="M12 3v10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M8 7l4-4 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path
        d="M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-white/80">
      <path d="M12 3v10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M8 11l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 20h16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className="text-white/70">
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

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-white/55">
      <path
        d="M10.5 18a7.5 7.5 0 1 1 0-15a7.5 7.5 0 0 1 0 15Z"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path d="M16.5 16.5L21 21" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
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
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-white/70">
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
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-white/60">
      <path d="M9 18l6-6-6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
