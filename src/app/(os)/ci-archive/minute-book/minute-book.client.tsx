"use client";
export const dynamic = "force-dynamic";

/**
 * CI-Archive → Minute Book (FINAL PRODUCTION)
 * - STRICT 3-column OS layout
 * - Entity-scoped only (useEntity)
 * - Registry-only (no writes)
 * - OFFICIAL-first PDF view/download (fallback to uploaded)
 * - Wiring LOCKED (views + supabaseBrowser)
 */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";

/* ----------------------------- Types ----------------------------- */

type MinuteBookRow = {
  id: string;
  entity_key?: string | null;

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
  source?: string | null;

  // optional future-proof official pointers
  official_storage_path?: string | null;
  official_bucket_id?: string | null;
};

type OfficialArtifact = {
  bucket_id: string;
  storage_path: string;
  file_name?: string | null;
  kind?: "official" | "certified" | "verified";
};

/* ----------------------------- Helpers ----------------------------- */

const norm = (s?: string | null, fb = "—") =>
  (s ?? "").toString().trim() || fb;

const getSection = (r: MinuteBookRow) =>
  norm(r.doc_section, norm(r.section, "General"));

const getTitle = (r: MinuteBookRow) =>
  norm(r.title, norm(r.file_name, "Untitled"));

const getType = (r: MinuteBookRow) =>
  norm(r.entry_type, "Document");

const getCreatedAtMs = (r: MinuteBookRow) => {
  const t = r.created_at ? Date.parse(r.created_at) : NaN;
  return Number.isFinite(t) ? t : 0;
};

const fmtBytes = (n?: number | null) => {
  if (!n || n <= 0) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
};

const shortHash = (h?: string | null) =>
  !h ? "—" : h.length <= 18 ? h : `${h.slice(0, 10)}…${h.slice(-6)}`;

const sectionIcon = (s: string) => {
  const x = s.toLowerCase();
  if (x.includes("incorp") || x.includes("articles")) return "📜";
  if (x.includes("profile") || x.includes("corporate")) return "🛡️";
  if (x.includes("annual") || x.includes("return")) return "🗓️";
  if (x.includes("register") || x.includes("share")) return "📚";
  if (x.includes("resolution") || x.includes("minutes")) return "⚖️";
  if (x.includes("bank") || x.includes("finance")) return "💼";
  if (x.includes("tax") || x.includes("cra")) return "🧾";
  return "🗂️";
};

/* ----------------------------- Data (LOCKED) ----------------------------- */

async function loadMinuteBook(entityKey: string) {
  const sb = supabaseBrowser;

  // Preferred registry view
  try {
    const { data, error } = await sb
      .from("v_registry_minute_book_entries")
      .select("*")
      .eq("entity_key", entityKey)
      .limit(1000);
    if (!error && data) return data as MinuteBookRow[];
  } catch {}

  // Fallback table
  const { data, error } = await sb
    .from("minute_book_entries")
    .select("*")
    .eq("entity_key", entityKey)
    .limit(1000);

  if (error) throw error;
  return (data || []) as MinuteBookRow[];
}

/**
 * OFFICIAL-first resolution (read-only).
 * Priority:
 * 1) explicit official_* fields
 * 2) verified_documents best-effort lookup
 * 3) fallback to uploaded minute_book PDF
 */
async function resolveOfficial(
  entityKey: string,
  row: MinuteBookRow
): Promise<OfficialArtifact | null> {
  const sb = supabaseBrowser;

  if (row.official_bucket_id && row.official_storage_path) {
    return {
      bucket_id: row.official_bucket_id,
      storage_path: row.official_storage_path,
      file_name: row.file_name ?? null,
      kind: "official",
    };
  }

  try {
    const { data, error } = await sb
      .from("verified_documents")
      .select("*")
      .eq("entity_key", entityKey)
      .or(
        [
          row.file_hash ? `file_hash.eq.${row.file_hash}` : "",
          row.storage_path ? `source_storage_path.eq.${row.storage_path}` : "",
          `minute_book_entry_id.eq.${row.id}`,
        ].filter(Boolean).join(",")
      )
      .order("created_at", { ascending: false })
      .limit(1);

    if (!error && data?.length) {
      const v: any = data[0];
      const bucket = v.bucket_id || v.storage_bucket || "verified_documents";
      const path = v.storage_path || v.file_path || v.path;
      if (bucket && path) {
        return {
          bucket_id: bucket,
          storage_path: path,
          file_name: v.file_name || row.file_name || null,
          kind: v.kind || "verified",
        };
      }
    }
  } catch {}

  return null;
}

async function signedUrl(
  bucketId: string,
  path: string,
  downloadName?: string | null
) {
  const sb = supabaseBrowser;
  const opts: any = downloadName ? { download: downloadName } : undefined;
  const { data, error } = await sb
    .storage
    .from(bucketId)
    .createSignedUrl(path, 60 * 10, opts);
  if (error) throw error;
  return data.signedUrl;
}

/* ----------------------------- UI ----------------------------- */

export default function MinuteBookClient() {
  const { entityKey } = useEntity();

  const [rows, setRows] = useState<MinuteBookRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [activeSection, setActiveSection] = useState("All");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [official, setOfficial] = useState<OfficialArtifact | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLabel, setPreviewLabel] = useState("");
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfErr, setPdfErr] = useState<string | null>(null);

  /* ---------- Derived ---------- */

  const sections = useMemo(() => {
    const s = new Set<string>();
    rows.forEach(r => s.add(getSection(r)));
    return ["All", ...Array.from(s).sort()];
  }, [rows]);

  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const f = rows.filter(r => {
      if (activeSection !== "All" && getSection(r) !== activeSection) return false;
      if (!q) return true;
      return [
        getTitle(r), getType(r), getSection(r),
        r.file_name, r.storage_path, r.file_hash, r.status
      ].join(" ").toLowerCase().includes(q);
    });
    return f.sort((a,b)=>getCreatedAtMs(b)-getCreatedAtMs(a));
  }, [rows, activeSection, query]);

  const selected = useMemo(
    () => rows.find(r => r.id === selectedId) || null,
    [rows, selectedId]
  );

  const authorityBadge = useMemo(() => {
    if (!selected) return null;
    return official
      ? { label: "OFFICIAL", tone: "gold" as const }
      : { label: "UPLOADED", tone: "neutral" as const };
  }, [selected?.id, !!official]);

  /* ---------- Load ---------- */

  useEffect(() => {
    let alive = true;
    (async () => {
      setErr(null);
      setLoading(true);
      setRows([]);
      setSelectedId(null);
      setActiveSection("All");
      setQuery("");
      setOfficial(null);
      setPreviewUrl(null);
      setPreviewLabel("");
      setPdfErr(null);

      if (!entityKey) { setLoading(false); return; }

      try {
        const data = await loadMinuteBook(entityKey);
        if (!alive) return;
        setRows(data);
        if (data.length) {
          const newest = [...data].sort((a,b)=>getCreatedAtMs(b)-getCreatedAtMs(a))[0];
          setSelectedId(newest?.id ?? null);
        }
      } catch (e:any) {
        if (alive) setErr(e?.message || "Failed to load registry.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [entityKey]);

  useEffect(() => {
    if (!sections.includes(activeSection)) setActiveSection("All");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections.join("|")]);

  useEffect(() => {
    let alive = true;
    (async () => {
      setPdfErr(null);
      setPreviewUrl(null);
      setPreviewLabel("");
      setOfficial(null);
      if (!entityKey || !selected) return;
      setPdfBusy(true);
      try {
        const off = await resolveOfficial(entityKey, selected);
        if (alive) setOfficial(off);
      } finally {
        if (alive) setPdfBusy(false);
      }
    })();
    return () => { alive = false; };
  }, [entityKey, selected?.id]);

  /* ---------- Actions ---------- */

  const viewPdf = async () => {
    if (!selected) return;
    setPdfErr(null); setPdfBusy(true);
    try {
      if (official) {
        setPreviewUrl(await signedUrl(official.bucket_id, official.storage_path));
        setPreviewLabel("Official PDF");
      } else {
        if (!selected.storage_path) throw new Error("No storage_path.");
        setPreviewUrl(await signedUrl("minute_book", selected.storage_path));
        setPreviewLabel("Uploaded PDF");
      }
    } catch (e:any) {
      setPdfErr(e?.message || "Failed to preview PDF.");
    } finally { setPdfBusy(false); }
  };

  const downloadPdf = async () => {
    if (!selected) return;
    setPdfErr(null); setPdfBusy(true);
    try {
      const name = selected.file_name || `${getTitle(selected)}.pdf`;
      if (official) {
        window.open(
          await signedUrl(official.bucket_id, official.storage_path, name),
          "_blank","noopener,noreferrer"
        );
      } else {
        if (!selected.storage_path) throw new Error("No storage_path.");
        window.open(
          await signedUrl("minute_book", selected.storage_path, name),
          "_blank","noopener,noreferrer"
        );
      }
    } catch (e:any) {
      setPdfErr(e?.message || "Failed to download PDF.");
    } finally { setPdfBusy(false); }
  };

  /* ----------------------------- Render ----------------------------- */

  return (
    <div className="min-h-[calc(100vh-56px)] w-full px-4 py-4">
      {/* Header */}
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <div className="text-xs text-white/50">CI-Archive</div>
          <div className="text-xl font-semibold text-white">Minute Book Registry</div>
          <div className="text-sm text-white/50">
            Evidence registry. Read-only. Official-first when available.
          </div>
        </div>
        <div className="flex gap-2">
          <Link href="/ci-archive"
            className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10">
            Archive
          </Link>
          <Link href="/ci-archive/upload"
            className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm font-medium text-amber-200 hover:bg-amber-400/15">
            Upload Filing →
          </Link>
        </div>
      </div>

      {!entityKey ? (
        <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-white/70">
          Select an entity in the OS bar.
        </div>
      ) : (
        <div className="grid grid-cols-12 gap-4">
          {/* Left: Domains */}
          <div className="col-span-12 md:col-span-3">
            <div className="h-[calc(100vh-160px)] rounded-2xl border border-white/10 bg-white/5 overflow-hidden">
              <div className="border-b border-white/10 px-4 py-3">
                <div className="text-sm font-medium text-white">Domains</div>
                <div className="text-xs text-white/50">Canonical taxonomy</div>
              </div>
              <div className="h-full overflow-auto p-2">
                {sections.map(s => {
                  const count = s==="All" ? rows.length : rows.filter(r=>getSection(r)===s).length;
                  const active = s===activeSection;
                  return (
                    <button key={s} onClick={()=>setActiveSection(s)}
                      className={`w-full rounded-xl px-3 py-2 text-left transition
                        ${active ? "border border-amber-400/30 bg-amber-400/10 text-amber-100"
                                 : "border border-transparent text-white/80 hover:bg-white/5"}`}>
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-2">
                          <span className="grid h-7 w-7 place-items-center rounded-xl border border-white/10 bg-black/20">
                            {s==="All" ? "◆" : sectionIcon(s)}
                          </span>
                          <span className="truncate">{s}</span>
                        </span>
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
            <div className="h-[calc(100vh-160px)] rounded-2xl border border-white/10 bg-white/5 overflow-hidden">
              <div className="border-b border-white/10 px-4 py-3">
                <div className="flex justify-between">
                  <div>
                    <div className="text-sm font-medium text-white">Entries</div>
                    <div className="text-xs text-white/50">
                      {loading ? "Loading…" : `${visibleRows.length} item(s)`}
                    </div>
                  </div>
                  <div className="text-xs text-white/40">Entity: {entityKey}</div>
                </div>
                <input
                  className="mt-3 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white"
                  placeholder="Search title, hash, path…"
                  value={query}
                  onChange={e=>setQuery(e.target.value)}
                />
              </div>
              <div className="h-full overflow-auto p-2 space-y-2">
                {err && <div className="rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200">{err}</div>}
                {!loading && !visibleRows.length && (
                  <div className="p-3 text-sm text-white/60">No entries found.</div>
                )}
                {visibleRows.map(r => {
                  const active = r.id===selectedId;
                  return (
                    <button key={r.id} onClick={()=>setSelectedId(r.id)}
                      className={`w-full rounded-xl border px-3 py-3 text-left transition
                        ${active ? "border-amber-400/30 bg-amber-400/10"
                                 : "border-white/10 hover:bg-white/5"}`}>
                      <div className="flex justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium text-white truncate">{getTitle(r)}</div>
                          <div className="mt-1 flex gap-2 text-xs text-white/50">
                            <span className="rounded-lg border border-white/10 bg-white/5 px-2 py-0.5">{getType(r)}</span>
                            <span className="rounded-lg border border-white/10 bg-white/5 px-2 py-0.5">{getSection(r)}</span>
                          </div>
                        </div>
                        <div className="text-right text-xs text-white/50">
                          <div>{fmtBytes(r.file_size)}</div>
                          <div>{r.created_at ? new Date(r.created_at).toLocaleString() : "—"}</div>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Right: Details */}
          <div className="col-span-12 md:col-span-4">
            <div className="h-[calc(100vh-160px)] rounded-2xl border border-white/10 bg-white/5 overflow-hidden">
              <div className="border-b border-white/10 px-4 py-3 flex justify-between">
                <div>
                  <div className="text-sm font-medium text-white">Details</div>
                  <div className="text-xs text-white/50">Hash-first metadata</div>
                </div>
                {authorityBadge && (
                  <span className={`rounded-full border px-2 py-1 text-[11px]
                    ${authorityBadge.tone==="gold"
                      ? "border-amber-400/30 bg-amber-400/10 text-amber-200"
                      : "border-white/10 bg-white/5 text-white/60"}`}>
                    {authorityBadge.label}
                  </span>
                )}
              </div>

              <div className="h-full overflow-auto p-4 space-y-4">
                {!selected ? (
                  <div className="text-sm text-white/60">Select an entry.</div>
                ) : (
                  <>
                    {/* Actions */}
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                      <div className="flex gap-2 flex-wrap">
                        <button onClick={viewPdf} disabled={pdfBusy}
                          className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-200">
                          View PDF
                        </button>
                        <button onClick={downloadPdf} disabled={pdfBusy}
                          className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80">
                          Download
                        </button>
                      </div>
                      {pdfErr && (
                        <div className="mt-2 rounded-xl border border-red-400/20 bg-red-400/10 p-2 text-xs text-red-200">
                          {pdfErr}
                        </div>
                      )}
                      {previewUrl && (
                        <div className="mt-3 rounded-2xl border border-white/10 overflow-hidden">
                          <div className="border-b border-white/10 px-3 py-2 text-xs text-white/60">
                            {previewLabel}
                          </div>
                          <iframe src={previewUrl} className="h-[420px] w-full" />
                        </div>
                      )}
                    </div>

                    {/* Metadata (muted) */}
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                      <div className="text-xs font-medium text-white/80">Integrity</div>
                      <div className="mt-2 flex justify-between text-xs">
                        <span className="text-white/40">SHA-256</span>
                        <span className="font-mono text-white/70">{shortHash(selected.file_hash)}</span>
                      </div>
                      <div className="mt-1 text-[11px] text-white/40">
                        Certification lives in Verified Registry.
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
