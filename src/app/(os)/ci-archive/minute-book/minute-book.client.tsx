"use client";
export const dynamic = "force-dynamic";

/**
 * CI-Archive → Minute Book (FINAL ENTERPRISE OS)
 *
 * CONSTITUTION:
 * - READ-ONLY registry (NO upload, NO mutation)
 * - CI-Council layout discipline (NO overflow)
 * - STRICT 3-column OS surface
 * - DOMAIN SOURCE OF TRUTH = minute_book_entries.domain_key
 * - PDF-first evidence (RIGHT column)
 * - Metadata Zone stays RIGHT, secondary, collapsible
 * - Upload lives on its OWN page
 */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";

/* ================= TYPES ================= */

type MinuteBookRow = {
  id: string;
  entity_key: string;
  domain_key: string;

  title?: string | null;
  entry_type?: string | null;

  storage_path?: string | null;
  file_name?: string | null;
  file_hash?: string | null;
  file_size?: number | null;
  mime_type?: string | null;

  created_at?: string | null;
  created_by?: string | null;
};

/* ================= HELPERS ================= */

function titleOf(r: MinuteBookRow) {
  return r.title || r.file_name || "Untitled";
}

function fmtBytes(n?: number | null) {
  if (!n) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${u[i]}`;
}

function shortHash(h?: string | null) {
  if (!h) return "—";
  return h.length <= 18 ? h : `${h.slice(0, 10)}…${h.slice(-6)}`;
}

/* ================= CANONICAL DOMAINS (MATCH UPLOAD) ================= */

const DOMAIN_CABINET = [
  { key: "formation", label: "Formation" },
  { key: "corporate_profile", label: "Corporate Profile" },
  { key: "share_certificates", label: "Share Capital" },
  { key: "directors_officers", label: "Directors & Officers" },
  { key: "resolutions", label: "Resolutions & Minutes" },
  { key: "bylaws", label: "Bylaws & Governance" },
  { key: "annual_returns", label: "Annual Returns & Tax" },
  { key: "banking", label: "Banking & Finance" },
  { key: "insurance", label: "Insurance & Risk" },
  { key: "contracts", label: "Contracts & Agreements" },
  { key: "brand_ip", label: "Brand & IP" },
  { key: "appraisal", label: "Real Estate & Assets" },
  { key: "compliance", label: "Compliance" },
  { key: "litigation", label: "Litigation" },
  { key: "annexes", label: "Annexes" },
];

/* ================= DATA ================= */

async function loadMinuteBook(entityKey: string) {
  const sb = supabaseBrowser;
  const { data, error } = await sb
    .from("minute_book_entries")
    .select("*")
    .eq("entity_key", entityKey)
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error) throw error;
  return (data || []) as MinuteBookRow[];
}

async function signedUrl(path: string) {
  const sb = supabaseBrowser;
  const { data, error } = await sb.storage
    .from("minute_book")
    .createSignedUrl(path, 600);

  if (error) throw error;
  return data.signedUrl;
}

/* ================= COMPONENT ================= */

export default function MinuteBookClient() {
  const { entityKey } = useEntity();

  const [rows, setRows] = useState<MinuteBookRow[]>([]);
  const [activeDomain, setActiveDomain] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  /* Load registry */
  useEffect(() => {
    if (!entityKey) return;
    setErr(null);
    loadMinuteBook(entityKey)
      .then((d) => {
        setRows(d);
        setSelectedId(d[0]?.id || null);
      })
      .catch((e) => setErr(e.message));
  }, [entityKey]);

  /* Derived */
  const filtered = useMemo(() => {
    if (activeDomain === "all") return rows;
    return rows.filter((r) => r.domain_key === activeDomain);
  }, [rows, activeDomain]);

  const selected = useMemo(
    () => rows.find((r) => r.id === selectedId) || null,
    [rows, selectedId]
  );

  async function viewPdf() {
    if (!selected?.storage_path) return;
    try {
      const url = await signedUrl(selected.storage_path);
      setPdfUrl(url);
    } catch (e: any) {
      setErr(e.message);
    }
  }

  /* ================= RENDER ================= */

  return (
    <div className="h-[calc(100vh-56px)] w-full overflow-hidden px-4 py-4">

      {/* HEADER */}
      <div className="mb-4 flex items-start justify-between">
        <div>
          <div className="text-xs text-white/50">CI-Archive</div>
          <div className="text-xl font-semibold text-white">Minute Book Registry</div>
          <div className="text-sm text-white/50">Read-only • Evidence-first</div>
        </div>

        <Link
          href="/ci-archive/upload"
          className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-200"
        >
          Go to Upload →
        </Link>
      </div>

      {!entityKey ? (
        <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-white/60">
          Select an entity from the OS bar.
        </div>
      ) : (
        <div className="grid h-[calc(100vh-56px-96px)] grid-cols-12 gap-4">

          {/* LEFT — DOMAINS */}
          <div className="col-span-3 overflow-hidden rounded-2xl border border-white/10 bg-white/5">
            <div className="border-b border-white/10 px-4 py-3 text-sm text-white">
              Domains
            </div>
            <div className="h-full overflow-auto p-2 space-y-1">
              <button
                onClick={() => setActiveDomain("all")}
                className={`w-full rounded-xl px-3 py-2 text-left ${
                  activeDomain === "all"
                    ? "bg-amber-400/10 text-amber-200"
                    : "text-white/70"
                }`}
              >
                All
              </button>

              {DOMAIN_CABINET.map((d) => (
                <button
                  key={d.key}
                  onClick={() => setActiveDomain(d.key)}
                  className={`w-full rounded-xl px-3 py-2 text-left ${
                    activeDomain === d.key
                      ? "bg-amber-400/10 text-amber-200"
                      : "text-white/70"
                  }`}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>

          {/* MIDDLE — REGISTRY */}
          <div className="col-span-5 overflow-hidden rounded-2xl border border-white/10 bg-white/5">
            <div className="border-b border-white/10 px-4 py-3 text-sm text-white">
              Registry Entries ({filtered.length})
            </div>
            <div className="h-full overflow-auto p-2 space-y-2">
              {filtered.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setSelectedId(r.id)}
                  className={`w-full rounded-xl border px-3 py-3 text-left ${
                    selectedId === r.id
                      ? "border-amber-400/30 bg-amber-400/10"
                      : "border-white/10 hover:bg-white/5"
                  }`}
                >
                  <div className="text-sm font-medium text-white">
                    {titleOf(r)}
                  </div>
                  <div className="mt-1 text-xs text-white/50">
                    {r.entry_type || "Document"} •{" "}
                    {r.created_at
                      ? new Date(r.created_at).toLocaleString()
                      : "—"}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* RIGHT — EVIDENCE */}
          <div className="col-span-4 overflow-hidden rounded-2xl border border-white/10 bg-white/5">
            <div className="border-b border-white/10 px-4 py-3 text-sm text-white">
              Evidence
            </div>
            <div className="h-full overflow-auto p-4">
              {!selected ? (
                <div className="text-white/60">Select an entry.</div>
              ) : (
                <>
                  <div className="text-lg font-semibold text-white">
                    {titleOf(selected)}
                  </div>

                  <div className="mt-3">
                    <button
                      onClick={viewPdf}
                      className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-200"
                    >
                      View PDF
                    </button>
                  </div>

                  {pdfUrl && (
                    <div className="mt-4 h-[480px] overflow-hidden rounded-xl border border-white/10">
                      <iframe src={pdfUrl} className="h-full w-full" />
                    </div>
                  )}

                  {/* METADATA ZONE */}
                  <details open className="mt-4 rounded-xl border border-white/10 bg-black/20 p-3">
                    <summary className="cursor-pointer text-sm text-white/70">
                      Metadata (secondary)
                    </summary>
                    <div className="mt-3 space-y-2 text-sm text-white/70">
                      <div>
                        SHA-256:{" "}
                        <span className="font-mono">
                          {shortHash(selected.file_hash)}
                        </span>
                      </div>
                      <div className="break-all">
                        Path:{" "}
                        <span className="font-mono text-xs">
                          {selected.storage_path}
                        </span>
                      </div>
                      <div>Size: {fmtBytes(selected.file_size)}</div>
                      <div>MIME: {selected.mime_type || "—"}</div>
                    </div>
                  </details>
                </>
              )}

              {err && (
                <div className="mt-3 text-sm text-red-300">
                  {err}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
