"use client";
export const dynamic = "force-dynamic";

/**
 * CI-Archive → Minute Book (FINAL PRODUCTION OS – COUNCIL-FRAMED)
 * - Window-in-OS framing (matches CI-Council)
 * - STRICT 3-column containment (no overflow)
 * - Registry-only (NO upload logic)
 * - Entity-scoped ONLY (useEntity)
 * - Domain source = minute_book_entries.domain_key ONLY (no inference)
 * - PDF-first right panel; metadata secondary (collapsible)
 */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";

/* ---------------- types ---------------- */

type MinuteBookRow = {
  id: string;
  entity_key?: string | null;
  domain_key?: string | null;

  title?: string | null;
  entry_type?: string | null;

  storage_path?: string | null;
  file_name?: string | null;
  file_hash?: string | null;
  file_size?: number | null;
  mime_type?: string | null;

  status?: string | null;
  created_at?: string | null;
  created_by?: string | null;
  source?: string | null;
};

type DomainDef = {
  key: string;
  label: string;
  icon: string;
};

type OfficialArtifact = {
  bucket_id: string;
  storage_path: string;
  file_name?: string | null;
  kind?: "official" | "verified";
};

/* ---------------- helpers ---------------- */

const fmtBytes = (n?: number | null) => {
  if (!n || n <= 0) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
};

const shortHash = (h?: string | null) =>
  !h ? "—" : h.length <= 18 ? h : `${h.slice(0, 10)}…${h.slice(-6)}`;

const titleOf = (r: MinuteBookRow) => r.title || r.file_name || "Untitled";

/* ---------------- canonical domains (MATCH UPLOAD) ---------------- */

const DOMAINS: DomainDef[] = [
  { key: "formation", label: "Formation", icon: "📜" },
  { key: "corporate_profile", label: "Corporate Profile", icon: "🛡️" },
  { key: "share_capital", label: "Share Capital", icon: "📈" },
  { key: "directors_officers", label: "Directors & Officers", icon: "👤" },
  { key: "resolutions", label: "Resolutions & Minutes", icon: "⚖️" },
  { key: "bylaws", label: "Bylaws & Governance", icon: "📘" },
  { key: "annual_returns", label: "Annual Returns & Tax", icon: "🧾" },
  { key: "banking", label: "Banking & Finance", icon: "🏦" },
  { key: "insurance", label: "Insurance & Risk", icon: "🛡️" },
  { key: "contracts", label: "Contracts & Agreements", icon: "🤝" },
  { key: "brand_ip", label: "Brand & IP", icon: "™️" },
  { key: "real_estate", label: "Real Estate & Assets", icon: "🏠" },
  { key: "compliance", label: "Compliance", icon: "✅" },
  { key: "litigation", label: "Litigation", icon: "⚠️" },
  { key: "annexes", label: "Annexes", icon: "🗂️" },
];

const ALL = { key: "all", label: "All", icon: "◆" } as DomainDef;

/* ---------------- data ---------------- */

async function loadMinuteBook(entityKey: string) {
  const { data, error } = await supabaseBrowser
    .from("v_registry_minute_book_entries")
    .select("*")
    .eq("entity_key", entityKey)
    .limit(1000);

  if (error) throw error;
  return (data || []) as MinuteBookRow[];
}

async function resolveOfficial(entityKey: string, row: MinuteBookRow): Promise<OfficialArtifact | null> {
  // Optional official-first lookup; safe if none exists
  try {
    const { data } = await supabaseBrowser
      .from("verified_documents")
      .select("*")
      .eq("entity_key", entityKey)
      .eq("source_entry_id", row.id)
      .order("created_at", { ascending: false })
      .limit(1);
    if (data && data[0]?.storage_path) {
      return {
        bucket_id: data[0].bucket_id || "verified_documents",
        storage_path: data[0].storage_path,
        file_name: data[0].file_name || row.file_name || null,
        kind: "verified",
      };
    }
  } catch {}
  return null;
}

async function signedUrl(bucket: string, path: string, download?: string | null) {
  const { data, error } = await supabaseBrowser
    .storage.from(bucket)
    .createSignedUrl(path, 600, download ? { download } : undefined);
  if (error) throw error;
  return data.signedUrl;
}

/* ---------------- UI ---------------- */

export default function MinuteBookClient() {
  const { entityKey } = useEntity();

  const [rows, setRows] = useState<MinuteBookRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [activeDomain, setActiveDomain] = useState<string>(ALL.key);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [official, setOfficial] = useState<OfficialArtifact | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const selected = useMemo(
    () => rows.find(r => r.id === selectedId) || null,
    [rows, selectedId]
  );

  const visible = useMemo(() => {
    if (activeDomain === ALL.key) return rows;
    return rows.filter(r => r.domain_key === activeDomain);
  }, [rows, activeDomain]);

  useEffect(() => {
    let alive = true;
    async function run() {
      if (!entityKey) return;
      setLoading(true);
      try {
        const data = await loadMinuteBook(entityKey);
        if (!alive) return;
        setRows(data);
        setSelectedId(data[0]?.id ?? null);
      } catch (e: any) {
        if (!alive) return;
        setErr(e?.message || "Failed to load registry.");
      } finally {
        if (alive) setLoading(false);
      }
    }
    run();
    return () => { alive = false; };
  }, [entityKey]);

  useEffect(() => {
    let alive = true;
    async function run() {
      setOfficial(null);
      setPreviewUrl(null);
      if (!entityKey || !selected) return;
      const off = await resolveOfficial(entityKey, selected);
      if (alive) setOfficial(off);
    }
    run();
    return () => { alive = false; };
  }, [entityKey, selected?.id]);

  const viewPdf = async () => {
    if (!selected) return;
    if (official) {
      setPreviewUrl(await signedUrl(official.bucket_id, official.storage_path));
    } else if (selected.storage_path) {
      setPreviewUrl(await signedUrl("minute_book", selected.storage_path));
    }
  };

  /* ---------------- render ---------------- */

  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6 overflow-hidden">
      {/* Header */}
      <div className="mb-4 shrink-0">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">
          CI-ARCHIVE
        </div>
        <p className="mt-1 text-[11px] text-slate-400">
          Minute Book Registry • <span className="font-semibold text-slate-200">Read-only · Evidence-first</span>
        </p>
      </div>

      {/* Window Frame (CI-Council style) */}
      <div className="flex-1 min-h-0 flex justify-center overflow-hidden">
        <div className="w-full max-w-[1400px] h-full rounded-3xl border border-slate-900 bg-black/60 shadow-[0_0_60px_rgba(15,23,42,0.9)] px-6 py-5 flex flex-col overflow-hidden">

          {/* Window Title */}
          <div className="flex items-start justify-between mb-4 shrink-0">
            <div>
              <h1 className="text-lg font-semibold text-slate-50">
                Minute Book Registry
              </h1>
              <p className="mt-1 text-xs text-slate-400">
                Canonical archive indexed by governance domain.
              </p>
            </div>
            <Link
              href="/ci-archive/upload"
              className="rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-300 hover:bg-amber-500/15"
            >
              Go to Upload →
            </Link>
          </div>

          {/* Three Columns */}
          <div className="grid grid-cols-[260px,minmax(0,1fr),360px] gap-6 flex-1 min-h-0">

            {/* LEFT – Domains (Finder-style tabs) */}
            <aside className="rounded-2xl border border-slate-800 bg-slate-950/40 p-2 flex flex-col min-h-0">
              {[ALL, ...DOMAINS].map(d => {
                const active = activeDomain === d.key;
                return (
                  <button
                    key={d.key}
                    onClick={() => setActiveDomain(d.key)}
                    className={[
                      "w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm transition",
                      active
                        ? "bg-amber-500/10 border border-amber-500/30 text-amber-200 shadow-[0_0_0_1px_rgba(245,158,11,0.35)]"
                        : "border border-transparent text-slate-300 hover:bg-slate-900/60",
                    ].join(" ")}
                  >
                    <span className="w-6 text-center">{d.icon}</span>
                    <span className="truncate">{d.label}</span>
                  </button>
                );
              })}
            </aside>

            {/* MIDDLE – Entries */}
            <section className="rounded-2xl border border-slate-800 bg-slate-950/40 p-3 flex flex-col min-h-0">
              <div className="text-sm font-semibold text-slate-200 mb-2">
                Registry Entries ({visible.length})
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto space-y-1">
                {loading && <div className="text-xs text-slate-400">Loading…</div>}
                {err && <div className="text-xs text-red-400">{err}</div>}
                {!loading && visible.map(r => {
                  const active = r.id === selectedId;
                  return (
                    <button
                      key={r.id}
                      onClick={() => setSelectedId(r.id)}
                      className={[
                        "w-full text-left px-3 py-2 rounded-xl border transition",
                        active
                          ? "bg-slate-900/80 border-sky-400/40"
                          : "border-slate-800 hover:bg-slate-900/60",
                      ].join(" ")}
                    >
                      <div className="text-sm font-medium text-slate-100">
                        {titleOf(r)}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        {r.entry_type || "document"} • {r.created_at ? new Date(r.created_at).toLocaleString() : "—"}
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* RIGHT – Evidence + Metadata */}
            <aside className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4 flex flex-col min-h-0">
              {!selected ? (
                <div className="text-sm text-slate-400">Select a record to inspect evidence.</div>
              ) : (
                <>
                  <div className="flex items-center justify-between mb-2">
                    <h2 className="text-sm font-semibold text-slate-200">
                      {titleOf(selected)}
                    </h2>
                    <span className="px-2 py-0.5 rounded-full border border-amber-500/40 bg-amber-500/10 text-[10px] uppercase tracking-[0.18em] text-amber-300">
                      {official ? "VERIFIED" : "UPLOADED"}
                    </span>
                  </div>

                  <button
                    onClick={viewPdf}
                    className="mb-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200 hover:bg-amber-500/15"
                  >
                    View PDF
                  </button>

                  {previewUrl && (
                    <div className="mb-3 rounded-xl border border-slate-800 overflow-hidden">
                      <iframe src={previewUrl} className="w-full h-[360px]" />
                    </div>
                  )}

                  {/* Metadata (secondary) */}
                  <div className="mt-auto space-y-2">
                    <details open className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
                      <summary className="text-sm text-amber-200 cursor-pointer">Hash</summary>
                      <div className="mt-2 text-xs text-amber-100">
                        SHA-256: <span className="font-mono">{shortHash(selected.file_hash)}</span>
                      </div>
                    </details>

                    <details className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                      <summary className="text-sm text-slate-300 cursor-pointer">Storage</summary>
                      <div className="mt-2 text-xs text-slate-400">
                        Path: {selected.storage_path || "—"}<br />
                        Size: {fmtBytes(selected.file_size)}<br />
                        MIME: {selected.mime_type || "—"}
                      </div>
                    </details>
                  </div>
                </>
              )}
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}
