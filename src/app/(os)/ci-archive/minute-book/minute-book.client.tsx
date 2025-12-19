"use client";
export const dynamic = "force-dynamic";

/**
 * CI-Archive → Minute Book (FINAL PRODUCTION)
 * - OS-consistent 3-column registry-only view
 * - NO upload logic here (upload is /ci-archive/upload)
 * - NO per-route auth gating (OS layout gates)
 * - NO useSearchParams
 * - Uses canonical supabaseBrowser singleton (NOT a function)
 * - Loads from v_registry_minute_book_entries (fallback: minute_book_entries)
 */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";

type MinuteBookRow = {
  id: string;
  entity_key?: string | null;

  // common registry fields (vary by view/table)
  title?: string | null;
  entry_type?: string | null;
  section?: string | null;
  doc_section?: string | null;

  storage_path?: string | null;
  file_name?: string | null;
  file_hash?: string | null;
  file_size?: number | null;
  mime_type?: string | null;

  status?: string | null;
  created_at?: string | null;
  created_by?: string | null;

  // optional extra fields (harmless if absent)
  notes?: string | null;
  source?: string | null;
};

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
  if (h.length <= 18) return h;
  return `${h.slice(0, 10)}…${h.slice(-6)}`;
}

function norm(s?: string | null, fallback = "") {
  const x = (s || "").toString().trim();
  return x.length ? x : fallback;
}

function getSection(r: MinuteBookRow) {
  return norm(r.doc_section, norm(r.section, "General"));
}

function getTitle(r: MinuteBookRow) {
  return norm(r.title, norm(r.file_name, "Untitled"));
}

function getType(r: MinuteBookRow) {
  return norm(r.entry_type, "Document");
}

function getCreatedAtMs(r: MinuteBookRow) {
  const t = r.created_at ? Date.parse(r.created_at) : NaN;
  return Number.isFinite(t) ? t : 0;
}

async function loadMinuteBook(entityKey: string) {
  const sb = supabaseBrowser; // IMPORTANT: singleton client, do NOT call it

  // 1) Try the registry view (preferred)
  try {
    const { data, error } = await sb
      .from("v_registry_minute_book_entries")
      .select("*")
      .eq("entity_key", entityKey)
      .limit(1000);

    if (!error && data) return data as MinuteBookRow[];
  } catch {
    // ignore; fallback below
  }

  // 2) Fallback: table
  const { data: data2, error: error2 } = await sb
    .from("minute_book_entries")
    .select("*")
    .eq("entity_key", entityKey)
    .limit(1000);

  if (error2) throw error2;
  return (data2 || []) as MinuteBookRow[];
}

export default function MinuteBookClient() {
  const sb = supabaseBrowser;
  const { entityKey } = useEntity();

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [rows, setRows] = useState<MinuteBookRow[]>([]);
  const [activeSection, setActiveSection] = useState<string>("All");
  const [query, setQuery] = useState<string>("");

  const [selectedId, setSelectedId] = useState<string | null>(null);

  // derived: sections
  const sections = useMemo(() => {
    const uniq = new Set<string>();
    rows.forEach((r) => uniq.add(getSection(r)));
    return ["All", ...Array.from(uniq).sort((a, b) => a.localeCompare(b))];
  }, [rows]);

  // derived: filtered rows
  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (activeSection !== "All" && getSection(r) !== activeSection) return false;
      if (!q) return true;

      const hay = [
        getTitle(r),
        getType(r),
        getSection(r),
        r.file_name || "",
        r.storage_path || "",
        r.status || "",
        r.file_hash || "",
      ]
        .join(" ")
        .toLowerCase();

      return hay.includes(q);
    });

    // newest first
    filtered.sort((a, b) => getCreatedAtMs(b) - getCreatedAtMs(a));
    return filtered;
  }, [rows, activeSection, query]);

  const selected = useMemo(() => {
    if (!selectedId) return null;
    return rows.find((r) => r.id === selectedId) || null;
  }, [rows, selectedId]);

  // load on entity change
  useEffect(() => {
    let alive = true;

    async function run() {
      setErr(null);
      setLoading(true);
      setRows([]);
      setSelectedId(null);
      setActiveSection("All");
      setQuery("");

      if (!entityKey) {
        setLoading(false);
        return;
      }

      try {
        const data = await loadMinuteBook(entityKey);
        if (!alive) return;

        setRows(data);

        // keep a stable selection: pick most recent if available
        if (data.length) {
          const newest = [...data].sort((a, b) => getCreatedAtMs(b) - getCreatedAtMs(a))[0];
          setSelectedId(newest?.id || null);
        }
      } catch (e: any) {
        if (!alive) return;
        setErr(e?.message || "Failed to load Minute Book registry.");
      } finally {
        if (alive) setLoading(false);
      }
    }

    run();
    return () => {
      alive = false;
    };
  }, [entityKey]);

  // ensure active section stays valid if rows change
  useEffect(() => {
    if (!sections.includes(activeSection)) setActiveSection("All");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections.join("|")]);

  return (
    <div className="min-h-[calc(100vh-56px)] w-full px-4 py-4">
      {/* Header */}
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-xs text-white/50">CI-Archive</div>
          <div className="truncate text-xl font-semibold tracking-tight text-white">
            Minute Book Registry
          </div>
          <div className="mt-1 text-sm text-white/50">
            Read-only registry. Upload is a separate enterprise filing flow.
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Link
            href="/ci-archive"
            className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10"
          >
            Back
          </Link>
          <Link
            href="/ci-archive/upload"
            className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm font-medium text-amber-200 hover:bg-amber-400/15"
          >
            Upload Filing →
          </Link>
        </div>
      </div>

      {/* Entity guard */}
      {!entityKey ? (
        <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-white/70">
          Select an entity in the OS bar to view Minute Book records.
        </div>
      ) : (
        <div className="grid grid-cols-12 gap-4">
          {/* Left: Sections */}
          <div className="col-span-12 md:col-span-3">
            <div className="h-[calc(100vh-160px)] overflow-hidden rounded-2xl border border-white/10 bg-white/5">
              <div className="border-b border-white/10 px-4 py-3">
                <div className="text-sm font-medium text-white">Sections</div>
                <div className="text-xs text-white/50">Domain grouping (no folders UI)</div>
              </div>

              <div className="h-full overflow-auto p-2">
                {sections.map((s) => {
                  const isActive = s === activeSection;
                  const count =
                    s === "All"
                      ? rows.length
                      : rows.filter((r) => getSection(r) === s).length;

                  return (
                    <button
                      key={s}
                      onClick={() => setActiveSection(s)}
                      className={[
                        "w-full rounded-xl px-3 py-2 text-left text-sm transition",
                        isActive
                          ? "border border-amber-400/30 bg-amber-400/10 text-amber-100"
                          : "border border-transparent text-white/80 hover:bg-white/5",
                      ].join(" ")}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate">{s}</span>
                        <span className="text-xs text-white/40">{count}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Middle: Entries */}
          <div className="col-span-12 md:col-span-5">
            <div className="h-[calc(100vh-160px)] overflow-hidden rounded-2xl border border-white/10 bg-white/5">
              <div className="border-b border-white/10 px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-white">Entries</div>
                    <div className="text-xs text-white/50">
                      {loading ? "Loading…" : `${visibleRows.length} item(s)`}
                      {activeSection !== "All" ? ` in ${activeSection}` : ""}
                    </div>
                  </div>
                  <div className="text-xs text-white/40">
                    Entity: <span className="text-white/70">{entityKey}</span>
                  </div>
                </div>

                <div className="mt-3">
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search title, type, path, hash…"
                    className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white placeholder:text-white/35 outline-none focus:border-amber-400/30"
                  />
                </div>
              </div>

              <div className="h-full overflow-auto p-2">
                {err ? (
                  <div className="rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200">
                    {err}
                  </div>
                ) : loading ? (
                  <div className="p-3 text-sm text-white/60">Loading registry…</div>
                ) : visibleRows.length === 0 ? (
                  <div className="p-3 text-sm text-white/60">
                    No entries found for this entity yet.
                    <div className="mt-2 text-xs text-white/40">
                      If you uploaded a document recently: verify the OS entity selection matches the
                      upload’s <span className="text-white/70">entity_key</span>. Registry is scoped by
                      OS entity context.
                    </div>
                  </div>
                ) : (
                  visibleRows.map((r) => {
                    const isActive = r.id === selectedId;
                    const title = getTitle(r);
                    const type = getType(r);
                    const section = getSection(r);
                    const createdAt = r.created_at
                      ? new Date(r.created_at).toLocaleString()
                      : "—";

                    return (
                      <button
                        key={r.id}
                        onClick={() => setSelectedId(r.id)}
                        className={[
                          "w-full rounded-xl border px-3 py-3 text-left transition",
                          isActive
                            ? "border-amber-400/30 bg-amber-400/10"
                            : "border-white/10 hover:bg-white/5",
                        ].join(" ")}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-white">{title}</div>
                            <div className="mt-1 flex flex-wrap gap-2 text-xs text-white/50">
                              <span className="rounded-lg border border-white/10 bg-white/5 px-2 py-0.5">
                                {type}
                              </span>
                              <span className="rounded-lg border border-white/10 bg-white/5 px-2 py-0.5">
                                {section}
                              </span>
                              <span className="text-white/40">{createdAt}</span>
                            </div>
                          </div>

                          <div className="shrink-0 text-right">
                            <div className="text-xs text-white/50">{fmtBytes(r.file_size)}</div>
                            <div className="mt-1 text-[11px] text-white/40">
                              {norm(r.status, "—")}
                            </div>
                          </div>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          {/* Right: Details */}
          <div className="col-span-12 md:col-span-4">
            <div className="h-[calc(100vh-160px)] overflow-hidden rounded-2xl border border-white/10 bg-white/5">
              <div className="border-b border-white/10 px-4 py-3">
                <div className="text-sm font-medium text-white">Details</div>
                <div className="text-xs text-white/50">Hash-first, OS-signature metadata</div>
              </div>

              <div className="h-full overflow-auto p-4">
                {!selected ? (
                  <div className="text-sm text-white/60">Select an entry to view details.</div>
                ) : (
                  <div className="space-y-4">
                    {/* Title + tags */}
                    <div>
                      <div className="text-xs text-white/40">Title</div>
                      <div className="mt-1 text-base font-semibold text-white">
                        {getTitle(selected)}
                      </div>

                      <div className="mt-2 flex flex-wrap gap-2">
                        <span className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-white/75">
                          {getType(selected)}
                        </span>
                        <span className="rounded-lg border border-amber-400/20 bg-amber-400/10 px-2 py-1 text-xs text-amber-100">
                          {getSection(selected)}
                        </span>
                        {selected.status ? (
                          <span className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-white/70">
                            {selected.status}
                          </span>
                        ) : null}
                      </div>
                    </div>

                    {/* Storage */}
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                      <div className="text-xs font-medium text-white/80">Storage</div>
                      <div className="mt-2 space-y-2 text-sm text-white/70">
                        <div className="flex items-start justify-between gap-3">
                          <div className="text-white/40">Path</div>
                          <div className="min-w-0 text-right font-mono text-xs text-white/70">
                            {norm(selected.storage_path, "—")}
                          </div>
                        </div>
                        <div className="flex items-start justify-between gap-3">
                          <div className="text-white/40">File</div>
                          <div className="min-w-0 text-right text-sm text-white/70">
                            {norm(selected.file_name, "—")}
                          </div>
                        </div>
                        <div className="flex items-start justify-between gap-3">
                          <div className="text-white/40">Size</div>
                          <div className="text-right text-sm text-white/70">
                            {fmtBytes(selected.file_size)}
                          </div>
                        </div>
                        <div className="flex items-start justify-between gap-3">
                          <div className="text-white/40">MIME</div>
                          <div className="text-right text-sm text-white/70">
                            {norm(selected.mime_type, "—")}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Verification */}
                    <div className="rounded-2xl border border-amber-400/20 bg-amber-400/10 p-3">
                      <div className="text-xs font-medium text-amber-100">Verification</div>
                      <div className="mt-2 space-y-2 text-sm text-amber-100/90">
                        <div className="flex items-start justify-between gap-3">
                          <div className="text-amber-100/60">SHA-256</div>
                          <div className="min-w-0 text-right font-mono text-xs">
                            {shortHash(selected.file_hash)}
                          </div>
                        </div>
                        <div className="text-[11px] text-amber-100/60">
                          Upload flow computes SHA-256 client-side and registers via the canonical SQL
                          function. Registry is read-only.
                        </div>
                      </div>
                    </div>

                    {/* Audit */}
                    <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                      <div className="text-xs font-medium text-white/80">Audit</div>
                      <div className="mt-2 space-y-2 text-sm text-white/70">
                        <div className="flex items-start justify-between gap-3">
                          <div className="text-white/40">Created</div>
                          <div className="text-right text-sm text-white/70">
                            {selected.created_at
                              ? new Date(selected.created_at).toLocaleString()
                              : "—"}
                          </div>
                        </div>
                        <div className="flex items-start justify-between gap-3">
                          <div className="text-white/40">Created By</div>
                          <div className="min-w-0 text-right font-mono text-xs text-white/70">
                            {norm(selected.created_by, "—")}
                          </div>
                        </div>
                        {selected.source ? (
                          <div className="flex items-start justify-between gap-3">
                            <div className="text-white/40">Source</div>
                            <div className="text-right text-sm text-white/70">
                              {norm(selected.source, "—")}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </div>

                    {/* Action */}
                    <div className="pt-1">
                      <Link
                        href="/ci-archive/upload"
                        className="inline-flex w-full items-center justify-center rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm font-medium text-amber-200 hover:bg-amber-400/15"
                      >
                        File another upload
                      </Link>
                      <div className="mt-2 text-center text-[11px] text-white/40">
                        Upload is the sole write entry point. Registry stays OS-native and read-only.
                      </div>
                    </div>

                    {/* Tiny health hint */}
                    <div className="text-[11px] text-white/35">
                      If your “corporate file from 2 hours ago” isn’t showing, the most common cause is
                      OS entity selection not matching the upload’s{" "}
                      <span className="text-white/60">entity_key</span>.
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* (Hidden) keep sb referenced so bundlers don't tree-shake incorrectly in some setups */}
      <span className="hidden">{String(!!sb)}</span>
    </div>
  );
}
