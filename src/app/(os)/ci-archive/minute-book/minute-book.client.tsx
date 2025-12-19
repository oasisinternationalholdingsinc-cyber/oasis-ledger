"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";

type MinuteBookEntry = {
  id: string;
  entity_key: string;
  domain_key: string | null;
  entry_date: string | null;
  entry_type: string | null;
  title: string | null;
  notes: string | null;

  registry_status: string | null;
  instrument_date: string | null;

  file_name: string | null;
  storage_path: string | null;
  pdf_hash: string | null;

  created_at: string | null;
  updated_at: string | null;

  source_record_id: string | null;
  source_envelope_id: string | null;
};

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const BUCKET_MINUTE_BOOK = "minute_book";

// Prefer the view if it exists (often used for registry-safe selects),
// fall back to the base table if needed.
const VIEW_REGISTRY = "v_registry_minute_book_entries";
const TABLE_BASE = "minute_book_entries";

const CANONICAL_DOMAINS: { key: string; label: string }[] = [
  { key: "all", label: "All" },
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

function supabaseBrowser() {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
}

function cls(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function titleize(raw?: string | null): string {
  if (!raw) return "—";
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
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

function isPdf(name?: string | null) {
  return (name || "").toLowerCase().endsWith(".pdf");
}

export default function MinuteBookClient({
  initialEntityKey,
}: {
  initialEntityKey: string | null;
}) {
  const router = useRouter();
  const supabase = useMemo(() => supabaseBrowser(), []);
  const os = useOsEntity();

  // Prefer OS entity, fall back to ?entity_key= passed from server page.tsx
  const effectiveEntityKey = (os?.entityKey || initialEntityKey || "").trim() || null;

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [entries, setEntries] = useState<MinuteBookEntry[]>([]);
  const [domain, setDomain] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewErr, setPreviewErr] = useState<string | null>(null);

  // 🔐 Auth guard (prevents “silent empty” when session isn’t present on a new domain)
  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!data?.session) router.replace("/login");
    })();
  }, [router, supabase]);

  useEffect(() => {
    let alive = true;

    async function load() {
      setLoading(true);
      setErr(null);
      setEntries([]);
      setSelectedId(null);
      setDomain("all");
      setPreviewOpen(false);
      setPreviewUrl(null);
      setPreviewErr(null);

      if (!effectiveEntityKey) {
        setLoading(false);
        return;
      }

      // 1) Try registry view first
      const tryView = await supabase
        .from(VIEW_REGISTRY)
        .select(
          "id, entity_key, domain_key, entry_date, entry_type, title, notes, registry_status, instrument_date, file_name, storage_path, pdf_hash, created_at, updated_at, source_record_id, source_envelope_id"
        )
        .eq("entity_key", effectiveEntityKey)
        .order("entry_date", { ascending: false })
        .order("created_at", { ascending: false });

      let rows: MinuteBookEntry[] = [];
      if (!tryView.error) {
        rows = (tryView.data || []) as MinuteBookEntry[];
      } else {
        // 2) Fallback to base table
        const tryTable = await supabase
          .from(TABLE_BASE)
          .select(
            "id, entity_key, domain_key, entry_date, entry_type, title, notes, registry_status, instrument_date, file_name, storage_path, pdf_hash, created_at, updated_at, source_record_id, source_envelope_id"
          )
          .eq("entity_key", effectiveEntityKey)
          .order("entry_date", { ascending: false })
          .order("created_at", { ascending: false });

        if (tryTable.error) {
          if (!alive) return;
          setErr(
            tryTable.error.message ||
              "Failed to load minute book registry (RLS/session/view)."
          );
          setLoading(false);
          return;
        }
        rows = (tryTable.data || []) as MinuteBookEntry[];
      }

      if (!alive) return;

      setEntries(rows);
      setLoading(false);

      if (rows.length) {
        setDomain("all");
        setSelectedId(rows[0].id);
      }
    }

    load();
    return () => {
      alive = false;
    };
  }, [supabase, effectiveEntityKey]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of entries) {
      const k = (e.domain_key || "other").toString();
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  }, [entries]);

  const domainRail = useMemo(() => {
    const canonicalKeys = new Set(CANONICAL_DOMAINS.map((d) => d.key).filter(Boolean));
    const dynamic = Array.from(counts.keys()).filter((k) => k && !canonicalKeys.has(k));

    const items: Array<{ key: string; label: string; count: number }> = [];
    for (const d of CANONICAL_DOMAINS) {
      if (d.key === "all") items.push({ key: "all", label: "All", count: entries.length });
      else items.push({ key: d.key, label: d.label, count: counts.get(d.key) || 0 });
    }
    for (const k of dynamic) items.push({ key: k, label: titleize(k), count: counts.get(k) || 0 });
    return items;
  }, [counts, entries.length]);

  const filtered = useMemo(() => {
    const base =
      domain === "all" ? entries : entries.filter((e) => (e.domain_key || "other") === domain);

    if (!q.trim()) return base;
    const s = q.trim().toLowerCase();
    return base.filter((e) => {
      const t = (e.title || "").toLowerCase();
      const f = (e.file_name || "").toLowerCase();
      return t.includes(s) || f.includes(s);
    });
  }, [entries, domain, q]);

  const selected = useMemo(() => {
    if (!selectedId) return null;
    return entries.find((e) => e.id === selectedId) || null;
  }, [entries, selectedId]);

  useEffect(() => {
    setPreviewOpen(false);
    setPreviewUrl(null);
    setPreviewErr(null);
    setPreviewBusy(false);
  }, [selectedId]);

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
    const { data, error } = await supabase.storage
      .from(BUCKET_MINUTE_BOOK)
      .createSignedUrl(selected.storage_path, 60 * 10);
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
    const { data, error } = await supabase.storage
      .from(BUCKET_MINUTE_BOOK)
      .createSignedUrl(selected.storage_path, 60 * 10);

    if (error || !data?.signedUrl) {
      setPreviewErr("Preview unavailable — use Open/Download.");
      setPreviewBusy(false);
      return;
    }

    setPreviewUrl(`${data.signedUrl}#view=FitH`);
    setPreviewBusy(false);
  }

  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      {/* Header under OS bar (matches CI-Council structure) */}
      <div className="mb-4 shrink-0">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">
          CI-ARCHIVE
        </div>
        <p className="mt-1 text-[11px] text-slate-400">
          Minute Book Registry •{" "}
          <span className="font-semibold text-slate-200">
            Registry-only (Upload is the only write entry point)
          </span>
        </p>
      </div>

      {/* Main Window */}
      <div className="flex-1 min-h-0 flex justify-center overflow-hidden">
        <div className="w-full max-w-[1400px] h-full rounded-3xl border border-slate-900 bg-black/60 shadow-[0_0_60px_rgba(15,23,42,0.9)] px-6 py-5 flex flex-col overflow-hidden">
          {/* Window Title */}
          <div className="flex items-start justify-between mb-4 shrink-0">
            <div>
              <h1 className="text-lg font-semibold text-slate-50">
                Minute Book — Registry Surface
              </h1>
              <p className="mt-1 text-xs text-slate-400">
                <span className="font-semibold text-amber-300">Left:</span>{" "}
                domain index.{" "}
                <span className="font-semibold text-sky-400">Middle:</span>{" "}
                registry entries.{" "}
                <span className="font-semibold text-emerald-400">Right:</span>{" "}
                inspector + PDF preview.
              </p>
            </div>

            <div className="flex items-center gap-2">
              {effectiveEntityKey ? (
                <span className="px-3 py-1 rounded-full bg-slate-950/60 border border-slate-800 text-[11px] text-slate-300">
                  Entity:{" "}
                  <span className="font-semibold text-slate-100">
                    {effectiveEntityKey}
                  </span>
                </span>
              ) : (
                <span className="px-3 py-1 rounded-full bg-rose-950/40 border border-rose-800/60 text-[11px] text-rose-200">
                  No entity scope
                </span>
              )}

              <a
                href={`/ci-archive/upload${
                  effectiveEntityKey ? `?entity_key=${encodeURIComponent(effectiveEntityKey)}` : ""
                }`}
                className="rounded-full px-4 py-1.5 text-[11px] font-semibold tracking-[0.18em] uppercase transition bg-amber-500 text-black hover:bg-amber-400"
                title="Go to Upload (the only write entry point)"
              >
                Upload
              </a>
            </div>
          </div>

          {err ? (
            <div className="mb-4 text-[11px] text-red-300 bg-red-950/40 border border-red-800/60 rounded-xl px-3 py-2">
              {err}
            </div>
          ) : null}

          {/* THREE-COLUMN LAYOUT (locked) */}
          <div className="grid grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)_420px] gap-6 flex-1 min-h-0">
            {/* LEFT — Index */}
            <section className="bg-slate-950/40 border border-slate-800 rounded-2xl p-4 flex flex-col min-h-0">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-semibold text-slate-200">Index</div>
                <div className="text-[10px] uppercase tracking-[0.25em] text-slate-500">
                  Domains
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto rounded-xl border border-slate-800/80 bg-slate-950/60 p-2 space-y-1">
                {domainRail.map((d) => (
                  <button
                    key={d.key}
                    type="button"
                    onClick={() => setDomain(d.key)}
                    className={cls(
                      "w-full flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-left transition",
                      domain === d.key
                        ? "bg-amber-500/10 shadow-[0_0_0_1px_rgba(245,158,11,0.25)]"
                        : "hover:bg-slate-900/60"
                    )}
                  >
                    <div className="min-w-0">
                      <div
                        className={cls(
                          "text-sm truncate",
                          domain === d.key ? "text-slate-100" : "text-slate-300"
                        )}
                      >
                        {d.label}
                      </div>
                    </div>
                    <span
                      className={cls(
                        "shrink-0 px-2 py-0.5 rounded-full text-[11px] border",
                        domain === d.key
                          ? "bg-amber-500/10 border-amber-500/30 text-amber-200"
                          : "bg-slate-950/40 border-slate-700 text-slate-400"
                      )}
                    >
                      {d.count}
                    </span>
                  </button>
                ))}
              </div>
            </section>

            {/* MIDDLE — Registry */}
            <section className="bg-slate-950/40 border border-slate-800 rounded-2xl p-4 flex flex-col min-h-0">
              <div className="flex items-center justify-between mb-3 gap-3">
                <div>
                  <div className="text-sm font-semibold text-slate-200">Registry</div>
                  <div className="text-[11px] text-slate-500">
                    {loading ? "Loading…" : `${filtered.length} record${filtered.length === 1 ? "" : "s"}`}
                  </div>
                </div>

                <div className="w-[280px] max-w-full">
                  <div className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2">
                    <SearchIcon />
                    <input
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      placeholder="Search titles / file names…"
                      className="w-full bg-transparent text-xs text-slate-200 placeholder:text-slate-600 outline-none"
                    />
                  </div>
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto rounded-xl border border-slate-800/80 bg-slate-950/60">
                {loading ? (
                  <div className="p-3 text-[11px] text-slate-400">Loading registry…</div>
                ) : !effectiveEntityKey ? (
                  <div className="p-3 text-[11px] text-slate-400">
                    Select an entity from the OS bar.
                  </div>
                ) : filtered.length === 0 ? (
                  <div className="p-4">
                    <div className="rounded-xl border border-slate-800 bg-black/40 p-4">
                      <div className="text-sm font-semibold text-slate-100">
                        Registry is empty
                      </div>
                      <div className="mt-1 text-[11px] text-slate-400">
                        If you uploaded a document already, you may be logged out on this domain
                        (session not present) or RLS blocked the select. Use the Upload button above
                        and confirm you’re signed in.
                      </div>
                      <a
                        href={`/ci-archive/upload?entity_key=${encodeURIComponent(effectiveEntityKey)}`}
                        className="mt-3 inline-flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs text-slate-200 hover:bg-slate-900/60"
                      >
                        <UploadIcon />
                        Go to Upload
                      </a>
                    </div>
                  </div>
                ) : (
                  filtered.map((e) => {
                    const active = e.id === selectedId;
                    return (
                      <button
                        key={e.id}
                        type="button"
                        onClick={() => setSelectedId(e.id)}
                        className={cls(
                          "w-full text-left px-3 py-3 border-b border-slate-800 last:border-b-0 transition",
                          active ? "bg-slate-900/90" : "hover:bg-slate-900/60"
                        )}
                      >
                        <div className="text-xs font-semibold text-slate-100 line-clamp-2">
                          {e.title || "Untitled entry"}
                        </div>

                        <div className="mt-1 text-[11px] text-slate-400 flex flex-wrap items-center gap-2">
                          <span className="text-slate-500">{fmtDate(e.entry_date)}</span>
                          <span className="w-1 h-1 rounded-full bg-slate-600" />
                          <span className="capitalize">{titleize(e.entry_type)}</span>
                          {e.registry_status ? (
                            <>
                              <span className="w-1 h-1 rounded-full bg-slate-600" />
                              <span className="text-amber-200">{titleize(e.registry_status)}</span>
                            </>
                          ) : null}
                          {e.storage_path ? (
                            <>
                              <span className="w-1 h-1 rounded-full bg-slate-600" />
                              <span className="inline-flex items-center gap-1 text-slate-300">
                                <PaperclipIcon /> File
                              </span>
                            </>
                          ) : null}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </section>

            {/* RIGHT — Inspector */}
            <section className="bg-slate-950/40 border border-slate-800 rounded-2xl p-4 flex flex-col min-h-0">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="text-sm font-semibold text-slate-200">Inspector</div>
                  <div className="text-[11px] text-slate-500">Details</div>
                </div>
                {selected?.storage_path ? (
                  <button
                    onClick={openDownload}
                    className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs text-slate-200 hover:bg-slate-900/60 inline-flex items-center gap-2"
                  >
                    <DownloadIcon />
                    Open / Download
                  </button>
                ) : null}
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto rounded-xl border border-slate-800/80 bg-slate-950/60 p-4">
                {loading ? (
                  <div className="text-[11px] text-slate-400">Loading…</div>
                ) : !selected ? (
                  <div className="text-[11px] text-slate-400">
                    Select an entry to view details.
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="rounded-xl border border-slate-800 bg-black/40 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-slate-100">
                            {selected.title || "Untitled entry"}
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-slate-500">
                            <span className="px-2 py-0.5 rounded-full bg-slate-950/60 border border-slate-800 text-slate-300 normal-case tracking-normal text-[11px]">
                              {titleize(selected.domain_key)}
                            </span>
                            <span className="px-2 py-0.5 rounded-full bg-slate-950/60 border border-slate-800 text-slate-300 normal-case tracking-normal text-[11px]">
                              {titleize(selected.entry_type)}
                            </span>
                            {selected.registry_status ? (
                              <span className="px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-200 normal-case tracking-normal text-[11px]">
                                {titleize(selected.registry_status)}
                              </span>
                            ) : null}
                          </div>
                        </div>

                        <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-amber-500/20 bg-amber-500/10">
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

                    <div className="rounded-xl border border-slate-800 bg-black/40 p-4">
                      <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">
                        Notes
                      </div>
                      <div className="mt-2 whitespace-pre-wrap text-[12px] text-slate-200">
                        {selected.notes ? selected.notes : <span className="text-slate-500">No notes.</span>}
                      </div>
                    </div>

                    <div className="rounded-xl border border-slate-800 bg-black/40 p-4">
                      <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500 mb-2">
                        File
                      </div>

                      {selected.storage_path ? (
                        <div className="space-y-2 text-[11px] text-slate-300">
                          <Meta label="File name" value={selected.file_name || "—"} />
                          <Meta label="SHA-256" value={selected.pdf_hash || "—"} mono />
                          <Meta label="storage_path" value={selected.storage_path || "—"} mono />
                        </div>
                      ) : (
                        <div className="text-[11px] text-slate-500">No file linked for this entry.</div>
                      )}
                    </div>

                    {selected.storage_path && isPdf(selected.file_name) ? (
                      <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 overflow-hidden">
                        <button
                          onClick={async () => {
                            const next = !previewOpen;
                            setPreviewOpen(next);
                            if (next && !previewUrl && !previewBusy) await ensurePreviewUrl();
                          }}
                          className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left"
                        >
                          <div>
                            <div className="text-[11px] uppercase tracking-[0.2em] text-amber-200/80">
                              Preview
                            </div>
                            <div className="text-[11px] text-amber-200/50">
                              {previewOpen ? "Collapse PDF preview" : "Open PDF preview"}
                            </div>
                          </div>
                          <span className={cls("transition", previewOpen ? "rotate-90" : "rotate-0")}>
                            <ChevronRight />
                          </span>
                        </button>

                        {previewOpen ? (
                          <div className="border-t border-amber-500/15 p-4">
                            {previewBusy ? (
                              <div className="rounded-xl border border-slate-800 bg-black/40 p-3 text-[11px] text-slate-300">
                                Preparing preview…
                              </div>
                            ) : previewUrl ? (
                              <div className="overflow-hidden rounded-xl border border-amber-500/15 bg-black">
                                <iframe title="PDF Preview" src={previewUrl} className="h-[420px] w-full" />
                              </div>
                            ) : (
                              <div className="rounded-xl border border-slate-800 bg-black/40 p-3 text-[11px] text-slate-300">
                                {previewErr || "Preview unavailable — use Open/Download."}
                              </div>
                            )}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>

              <div className="mt-3 flex items-center justify-between text-[10px] text-slate-500">
                <span>CI-Archive · Oasis Digital Parliament Ledger</span>
                <span>Registry Surface</span>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Atoms ---------- */

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
      <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">
        {label}
      </div>
      <div className={cls("mt-1 text-[11px] text-slate-200", mono && "break-all font-mono")}>
        {value}
      </div>
    </div>
  );
}

/* ---------- Icons ---------- */

function UploadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-slate-200">
      <path d="M12 3v10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M8 7l4-4 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-slate-200">
      <path d="M12 3v10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M8 11l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 20h16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className="text-slate-300">
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
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-slate-400">
      <path d="M10.5 18a7.5 7.5 0 1 1 0-15a7.5 7.5 0 0 1 0 15Z" stroke="currentColor" strokeWidth="1.6" />
      <path d="M16.5 16.5L21 21" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function SealIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-amber-200">
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

function ChevronRight() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-slate-400">
      <path d="M9 18l6-6-6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
