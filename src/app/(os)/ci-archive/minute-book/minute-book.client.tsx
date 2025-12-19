"use client";
export const dynamic = "force-dynamic";

/**
 * CI-Archive → Minute Book (FINAL CANONICAL PRODUCTION)
 * ---------------------------------------------------
 * - STRICT 3-column OS layout (vault | registry | inspection)
 * - Independent column scrolling (CI-Council parity)
 * - OS entity-scoped ONLY (useEntity)
 * - Registry-only (NO writes)
 * - WIRING LOCKED:
 *    • Reads v_registry_minute_book_entries (fallback minute_book_entries)
 *    • Uses supabaseBrowser singleton
 * - OFFICIAL-FIRST preview & download (signed URLs)
 * - Authority badge LOUD + fixed
 * - Domain vault restored (icons)
 */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";

/* =========================
   Types
========================= */

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

  notes?: string | null;
  source?: string | null;

  official_storage_path?: string | null;
  official_bucket_id?: string | null;
};

type OfficialArtifact = {
  bucket_id: string;
  storage_path: string;
  file_name?: string | null;
  kind?: "official" | "verified" | "certified";
};

/* =========================
   Helpers (UNCHANGED)
========================= */

const sb = supabaseBrowser;

const norm = (s?: string | null, fb = "") =>
  (s || "").toString().trim() || fb;

const getSection = (r: MinuteBookRow) =>
  norm(r.doc_section, norm(r.section, "General"));

const getTitle = (r: MinuteBookRow) =>
  norm(r.title, norm(r.file_name, "Untitled"));

const getType = (r: MinuteBookRow) =>
  norm(r.entry_type, "Document");

const getCreatedAtMs = (r: MinuteBookRow) =>
  r.created_at ? Date.parse(r.created_at) || 0 : 0;

const fmtBytes = (n?: number | null) => {
  if (!n) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
};

const shortHash = (h?: string | null) =>
  !h ? "—" : h.length > 18 ? `${h.slice(0,10)}…${h.slice(-6)}` : h;

const sectionIcon = (s: string) => {
  const x = s.toLowerCase();
  if (x.includes("incorp")) return "📜";
  if (x.includes("corporate") || x.includes("profile")) return "🛡️";
  if (x.includes("annual")) return "🗓️";
  if (x.includes("register")) return "📘";
  if (x.includes("resolution") || x.includes("minute")) return "⚖️";
  if (x.includes("bank")) return "🏦";
  if (x.includes("tax") || x.includes("cra")) return "🧾";
  if (x.includes("license")) return "📜";
  if (x.includes("contract")) return "✍️";
  return "🗂️";
};

/* =========================
   Data (LOCKED)
========================= */

async function loadMinuteBook(entityKey: string) {
  try {
    const { data, error } = await sb
      .from("v_registry_minute_book_entries")
      .select("*")
      .eq("entity_key", entityKey)
      .limit(1000);

    if (!error && data) return data as MinuteBookRow[];
  } catch {}

  const { data, error } = await sb
    .from("minute_book_entries")
    .select("*")
    .eq("entity_key", entityKey)
    .limit(1000);

  if (error) throw error;
  return (data || []) as MinuteBookRow[];
}

async function resolveOfficialArtifact(
  entityKey: string,
  r: MinuteBookRow
): Promise<OfficialArtifact | null> {

  if (r.official_storage_path && r.official_bucket_id) {
    return {
      bucket_id: r.official_bucket_id,
      storage_path: r.official_storage_path,
      file_name: r.file_name || null,
      kind: "official",
    };
  }

  try {
    const { data } = await sb
      .from("verified_documents")
      .select("*")
      .eq("entity_key", entityKey)
      .or(`minute_book_entry_id.eq.${r.id},source_entry_id.eq.${r.id}`)
      .order("created_at", { ascending: false })
      .limit(1);

    if (data?.length) {
      const v: any = data[0];
      if (v.bucket_id && v.storage_path) {
        return {
          bucket_id: v.bucket_id,
          storage_path: v.storage_path,
          file_name: v.file_name || r.file_name || null,
          kind: v.kind || "verified",
        };
      }
    }
  } catch {}

  return null;
}

async function signedUrl(bucket: string, path: string, download?: string | null) {
  const opts = download ? { download } : undefined;
  const { data, error } =
    await sb.storage.from(bucket).createSignedUrl(path, 600, opts);
  if (error) throw error;
  return data.signedUrl;
}

/* =========================
   Component
========================= */

export default function MinuteBookClient() {
  const { entityKey } = useEntity();

  const [rows, setRows] = useState<MinuteBookRow[]>([]);
  const [activeSection, setActiveSection] = useState("All");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [official, setOfficial] = useState<OfficialArtifact | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLabel, setPreviewLabel] = useState("");

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfErr, setPdfErr] = useState<string | null>(null);

  /* Load registry */
  useEffect(() => {
    if (!entityKey) return;
    let alive = true;

    (async () => {
      setLoading(true);
      setErr(null);
      setRows([]);
      setSelectedId(null);
      setOfficial(null);
      setPreviewUrl(null);

      try {
        const data = await loadMinuteBook(entityKey);
        if (!alive) return;
        setRows(data);
        if (data.length) {
          setSelectedId(
            [...data].sort((a,b)=>getCreatedAtMs(b)-getCreatedAtMs(a))[0].id
          );
        }
      } catch (e:any) {
        if (alive) setErr(e.message || "Failed to load registry");
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => { alive = false; };
  }, [entityKey]);

  const sections = useMemo(() => {
    const s = new Set<string>();
    rows.forEach(r => s.add(getSection(r)));
    return ["All", ...Array.from(s).sort()];
  }, [rows]);

  const visibleRows = useMemo(() => {
    const q = query.toLowerCase();
    return rows
      .filter(r =>
        (activeSection === "All" || getSection(r) === activeSection) &&
        (!q || [
          getTitle(r),
          getType(r),
          getSection(r),
          r.file_name,
          r.storage_path,
          r.file_hash,
          r.status
        ].join(" ").toLowerCase().includes(q))
      )
      .sort((a,b)=>getCreatedAtMs(b)-getCreatedAtMs(a));
  }, [rows, activeSection, query]);

  const selected = useMemo(
    () => rows.find(r => r.id === selectedId) || null,
    [rows, selectedId]
  );

  /* Resolve OFFICIAL */
  useEffect(() => {
    if (!entityKey || !selected) return;
    let alive = true;
    (async () => {
      const off = await resolveOfficialArtifact(entityKey, selected);
      if (alive) setOfficial(off);
    })();
    return () => { alive = false; };
  }, [entityKey, selected?.id]);

  async function viewPdf(download = false) {
    if (!selected) return;
    setPdfBusy(true);
    setPdfErr(null);
    try {
      if (official) {
        const url = await signedUrl(
          official.bucket_id,
          official.storage_path,
          download ? official.file_name : null
        );
        download ? window.open(url) : setPreviewUrl(url);
        setPreviewLabel("Official PDF");
        return;
      }
      if (!selected.storage_path) throw new Error("No storage path");
      const url = await signedUrl(
        "minute_book",
        selected.storage_path,
        download ? selected.file_name : null
      );
      download ? window.open(url) : setPreviewUrl(url);
      setPreviewLabel("Uploaded PDF");
    } catch (e:any) {
      setPdfErr(e.message || "PDF error");
    } finally {
      setPdfBusy(false);
    }
  }

  /* =========================
     Render (OS-Native)
  ========================= */

  return (
    <div className="h-full w-full px-4 py-4">
      {/* Header */}
      <div className="mb-4 flex justify-between">
        <div>
          <div className="text-xs text-white/50">CI-Archive</div>
          <div className="text-xl font-semibold">Minute Book Registry</div>
        </div>
        <div className="flex gap-2">
          <Link href="/ci-archive" className="btn-secondary">Archive</Link>
          <Link href="/ci-archive/upload" className="btn-gold">Upload</Link>
        </div>
      </div>

      {!entityKey ? (
        <div className="os-panel p-4">Select an entity in the OS bar.</div>
      ) : (
        <div className="grid grid-cols-12 gap-4 h-[calc(100vh-160px)]">

          {/* LEFT — VAULT */}
          <aside className="col-span-3 os-panel overflow-y-auto">
            <div className="os-panel-header">Domains</div>
            {sections.map(s => (
              <button
                key={s}
                onClick={()=>setActiveSection(s)}
                className={`os-folder ${activeSection===s?"active":""}`}
              >
                <span>{s==="All"?"◆":sectionIcon(s)}</span>
                <span>{s}</span>
                <span className="ml-auto text-xs text-white/40">
                  {s==="All"?rows.length:rows.filter(r=>getSection(r)===s).length}
                </span>
              </button>
            ))}
          </aside>

          {/* MIDDLE — REGISTRY */}
          <section className="col-span-5 os-panel overflow-y-auto">
            <div className="os-panel-header">
              Entries ({visibleRows.length})
            </div>
            <input
              className="os-input m-2"
              placeholder="Search title, hash, path…"
              value={query}
              onChange={e=>setQuery(e.target.value)}
            />
            {loading && <div className="p-3 muted">Loading…</div>}
            {err && <div className="p-3 text-red-300">{err}</div>}
            {visibleRows.map(r=>(
              <button
                key={r.id}
                onClick={()=>setSelectedId(r.id)}
                className={`os-row ${selectedId===r.id?"selected":""}`}
              >
                <div className="font-medium">{getTitle(r)}</div>
                <div className="text-xs muted">
                  {getSection(r)} · {r.created_at && new Date(r.created_at).toLocaleString()}
                </div>
              </button>
            ))}
          </section>

          {/* RIGHT — INSPECTION */}
          <aside className="col-span-4 os-panel flex flex-col overflow-hidden">
            {!selected ? (
              <div className="p-4 muted">Select a record</div>
            ) : (
              <>
                {/* FIXED HEADER */}
                <div className="p-4 border-b border-white/10">
                  <div className="text-lg font-semibold">{getTitle(selected)}</div>
                  <span className={`badge ${official?"badge-gold":"badge-neutral"}`}>
                    {official?"OFFICIAL":"UPLOADED"}
                  </span>
                </div>

                {/* CONSOLE */}
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                  <div className="flex gap-2">
                    <button onClick={()=>viewPdf(false)} className="btn-gold" disabled={pdfBusy}>
                      View
                    </button>
                    <button onClick={()=>viewPdf(true)} className="btn-secondary" disabled={pdfBusy}>
                      Download
                    </button>
                  </div>

                  {pdfErr && <div className="text-red-300 text-sm">{pdfErr}</div>}

                  {previewUrl && (
                    <iframe
                      src={previewUrl}
                      className="w-full h-[420px] rounded border border-white/10"
                    />
                  )}

                  {/* Metadata (quiet) */}
                  <div className="mt-3 text-sm muted space-y-1">
                    <div>SHA-256: {shortHash(selected.file_hash)}</div>
                    <div>Size: {fmtBytes(selected.file_size)}</div>
                    <div>Source: {norm(selected.source,"—")}</div>
                  </div>
                </div>
              </>
            )}
          </aside>

        </div>
      )}
    </div>
  );
}
