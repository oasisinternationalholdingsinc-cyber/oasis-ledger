// src/app/(os)/ci-archive/upload/upload.client.tsx
"use client";

export const dynamic = "force-dynamic";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  UploadCloud,
  ShieldCheck,
  FileText,
  AlertTriangle,
  CheckCircle2,
  Hash,
  FolderTree,
  Database,
} from "lucide-react";

import { supabaseBrowser } from "@/lib/supabase/browser";
import { useEntity } from "@/components/OsEntityContext";

type GovernanceDomain = {
  key: string;
  label: string;
  description: string | null;
  sort_order: number | null;
  active: boolean;
};

type EntryTypeDefault = {
  entry_type: string;
  default_section: string | null;
};

type Preview = {
  entity_key: string;
  domain_key: string;
  entry_type: string;
  entry_date: string;
  title: string;
  notes: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  sha256: string;
  storage_path: string;
};

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function formatDateYYYYMMDD(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function safeFilename(name: string) {
  return name
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .slice(0, 140);
}

async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buf);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export default function UploadClient() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const { entityKey } = useEntity(); // expected enum keys: "holdings" | "real-estate" | "lounge" | future client keys

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [domains, setDomains] = useState<GovernanceDomain[]>([]);
  const [entryTypeDefaults, setEntryTypeDefaults] = useState<EntryTypeDefault[]>([]);
  const [loadingMeta, setLoadingMeta] = useState(true);

  const [domainKey, setDomainKey] = useState<string>("incorporation");
  const [entryType, setEntryType] = useState<string>("filing");
  const [entryDate, setEntryDate] = useState<string>(() => formatDateYYYYMMDD(new Date()));
  const [title, setTitle] = useState<string>("");
  const [notes, setNotes] = useState<string>("");

  const [file, setFile] = useState<File | null>(null);
  const [sha, setSha] = useState<string>("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoadingMeta(true);
      setError(null);

      // 1) governance_domains drives the 15-domain taxonomy in registry + upload
      const d = await supabase
        .from("governance_domains")
        .select("key,label,description,sort_order,active")
        .eq("active", true)
        .order("sort_order", { ascending: true });

      // 2) optional: entry type defaults
      const t = await supabase
        .from("entry_type_section_defaults")
        .select("entry_type,default_section")
        .order("entry_type", { ascending: true });

      if (cancelled) return;

      if (d.error) {
        setError(d.error.message);
        setDomains([]);
      } else {
        setDomains((d.data ?? []) as GovernanceDomain[]);
      }

      // not fatal if missing
      if (t.error) setEntryTypeDefaults([]);
      else setEntryTypeDefaults((t.data ?? []) as EntryTypeDefault[]);

      setLoadingMeta(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  // keep domain sane
  useEffect(() => {
    if (!domains.length) return;
    if (!domains.some((d) => d.key === domainKey)) {
      setDomainKey(domains[0]!.key);
    }
  }, [domains, domainKey]);

  // keep entry type sane (if defaults exist)
  useEffect(() => {
    if (!entryTypeDefaults.length) return;
    if (!entryTypeDefaults.some((t) => t.entry_type === entryType)) {
      setEntryType(entryTypeDefaults[0]!.entry_type);
    }
  }, [entryTypeDefaults, entryType]);

  const domainLabel = useMemo(() => {
    const d = domains.find((x) => x.key === domainKey);
    return d?.label ?? domainKey;
  }, [domains, domainKey]);

  const domainDescription = useMemo(() => {
    const d = domains.find((x) => x.key === domainKey);
    return d?.description ?? null;
  }, [domains, domainKey]);

  const preview: Preview | null = useMemo(() => {
    if (!entityKey || !domainKey || !entryType || !entryDate || !title.trim() || !file || !sha) return null;

    const cleanFile = safeFilename(file.name);

    // Contract: <entity>/<domain>/<entry_type>/<YYYY-MM-DD>/<sha256>-<filename>
    const storage_path = `${entityKey}/${domainKey}/${entryType}/${entryDate}/${sha}-${cleanFile}`;

    return {
      entity_key: entityKey,
      domain_key: domainKey,
      entry_type: entryType,
      entry_date: entryDate,
      title: title.trim(),
      notes: notes.trim(),
      file_name: cleanFile,
      file_size: file.size,
      mime_type: file.type || "application/pdf",
      sha256: sha,
      storage_path,
    };
  }, [entityKey, domainKey, entryType, entryDate, title, notes, file, sha]);

  async function onPickFile(f: File | null) {
    setOk(null);
    setError(null);
    setFile(f);
    setSha("");

    if (!f) return;

    // PDF-first for Minute Book
    const isPdf = f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      setFile(null);
      setError("PDF required. Please select a .pdf file.");
      return;
    }

    try {
      const h = await sha256Hex(f);
      setSha(h);

      // Auto-suggest title if empty
      if (!title.trim()) {
        const base = f.name.replace(/\.[^.]+$/, "");
        setTitle(base.replace(/[_-]+/g, " ").trim());
      }
    } catch (e: any) {
      setError(e?.message ?? "Failed to hash file.");
      setFile(null);
      setSha("");
    }
  }

  async function uploadAndRegister() {
    setOk(null);
    setError(null);

    if (!preview || !file) {
      setError("Missing required fields (title, pdf, or hashing not complete).");
      return;
    }

    setBusy(true);
    try {
      // 1) Upload to Storage (canonical bucket)
      const up = await supabase.storage.from("minute_book").upload(preview.storage_path, file, {
        cacheControl: "3600",
        upsert: false,
        contentType: preview.mime_type,
      });

      if (up.error) {
        throw new Error(`Storage upload failed: ${up.error.message}`);
      }

      // 2) Register in DB via canonical RPC (KEEP CONTRACT)
      // IMPORTANT: This matches your DB signature pattern (pdf hash + supporting jsonb)
      const rpc = await supabase.rpc("register_minute_book_upload", {
        p_entity_key: preview.entity_key,
        p_domain_key: preview.domain_key,
        p_entry_type: preview.entry_type,
        p_entry_date: preview.entry_date,
        p_title: preview.title,
        p_notes: preview.notes || null,
        p_file_name: preview.file_name,
        p_storage_path: preview.storage_path,
        p_pdf_hash: preview.sha256,
        p_file_size: preview.file_size,
        p_mime_type: preview.mime_type,
        p_supporting: [] as any, // jsonb (future: multi-supporting docs)
      });

      if (rpc.error) throw new Error(`Register failed: ${rpc.error.message}`);

      const newId = String(rpc.data ?? "");
      setOk(`Uploaded + registered${newId ? ` • Entry ID: ${newId}` : ""}`);

      // Reset (keep entity/domain/type/date)
      setTitle("");
      setNotes("");
      setFile(null);
      setSha("");
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (e: any) {
      setError(e?.message ?? "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-[calc(100vh-72px)] px-4 py-6 md:px-8">
      <div className="mx-auto w-full max-w-[1400px]">
        {/* Top header (Council-like console header) */}
        <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-2xl bg-slate-950/60 border border-slate-800 flex items-center justify-center shadow-[0_0_0_1px_rgba(15,23,42,0.35)]">
              <UploadCloud className="h-5 w-5 text-amber-300" />
            </div>

            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-xl md:text-2xl font-semibold text-slate-100">Minute Book & Registry Upload</h1>
                <span className="text-[10px] tracking-widest uppercase rounded-full border border-amber-400/30 bg-amber-500/10 text-amber-200 px-3 py-1">
                  Enterprise Contract
                </span>
              </div>

              <p className="mt-1 text-xs md:text-sm text-slate-400">
                Domain-driven filing • SHA-256 enforced • Writes via{" "}
                <span className="text-amber-200">register_minute_book_upload</span>
              </p>

              <div className="mt-2 flex items-center gap-2 text-xs text-slate-400">
                <ShieldCheck className="h-4 w-4 text-emerald-300" />
                <span>Upload is the sole write-entry point. Registry remains OS-native and read-only.</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Link
              href="/ci-archive/minute-book"
              className="inline-flex items-center gap-2 rounded-2xl border border-slate-800 bg-slate-900/30 px-3 py-2 text-sm text-slate-200 hover:bg-slate-900/60"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Registry
            </Link>

            <button
              onClick={uploadAndRegister}
              disabled={!preview || busy}
              className={cx(
                "inline-flex items-center gap-2 rounded-2xl px-3 py-2 text-sm font-semibold transition",
                preview && !busy
                  ? "bg-amber-500/90 text-slate-950 hover:bg-amber-400"
                  : "bg-slate-800/60 text-slate-400 cursor-not-allowed"
              )}
              title={!preview ? "Complete required fields + compute hash to enable" : undefined}
            >
              <UploadCloud className="h-4 w-4" />
              {busy ? "Uploading…" : "Upload & Register"}
            </button>
          </div>
        </div>

        {/* Alerts (OS toast-like band) */}
        {(error || ok) && (
          <div
            className={cx(
              "mb-5 rounded-2xl border px-4 py-3 text-sm",
              error
                ? "border-red-900/60 bg-red-950/30 text-red-200"
                : "border-emerald-900/50 bg-emerald-950/25 text-emerald-200"
            )}
          >
            <div className="flex items-start gap-3">
              {error ? (
                <AlertTriangle className="h-5 w-5 mt-0.5" />
              ) : (
                <CheckCircle2 className="h-5 w-5 mt-0.5 text-emerald-300" />
              )}
              <div className="leading-relaxed">{error ?? ok}</div>
            </div>
          </div>
        )}

        {/* Three-column Council/OS console surface */}
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
          {/* LEFT: Filing (inputs) */}
          <section className="xl:col-span-4 rounded-3xl border border-slate-800 bg-slate-950/40 shadow-[0_0_0_1px_rgba(15,23,42,0.3)]">
            <div className="p-5 border-b border-slate-800/70">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-slate-200">Filing</div>
                <div className="text-[10px] tracking-widest uppercase rounded-full border border-slate-700 bg-slate-900/30 text-slate-200 px-3 py-1">
                  Write-Set
                </div>
              </div>
              <div className="mt-2 text-xs text-slate-500">
                Entity is scoped by the OS selector. Domains are sourced from governance_domains.
              </div>
            </div>

            <div className="p-5 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-1 gap-4">
                <div>
                  <label className="block text-[11px] font-medium text-slate-400 tracking-wider uppercase">Entity</label>
                  <input
                    value={entityKey ?? ""}
                    readOnly
                    className="mt-2 w-full rounded-2xl border border-slate-800 bg-slate-900/30 px-3 py-2.5 text-sm text-slate-200 outline-none"
                  />
                  <p className="mt-1 text-[11px] text-slate-500">Must match entity_companies.key (enum).</p>
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-slate-400 tracking-wider uppercase">Domain</label>
                  <select
                    value={domainKey}
                    onChange={(e) => setDomainKey(e.target.value)}
                    disabled={loadingMeta}
                    className="mt-2 w-full rounded-2xl border border-slate-800 bg-slate-900/30 px-3 py-2.5 text-sm text-slate-200 outline-none"
                  >
                    {domains.map((d) => (
                      <option key={d.key} value={d.key}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-[11px] text-slate-500">
                    Source: governance_domains {domainDescription ? `• ${domainDescription}` : ""}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-1 gap-4">
                <div>
                  <label className="block text-[11px] font-medium text-slate-400 tracking-wider uppercase">Entry Type</label>
                  <select
                    value={entryType}
                    onChange={(e) => setEntryType(e.target.value)}
                    className="mt-2 w-full rounded-2xl border border-slate-800 bg-slate-900/30 px-3 py-2.5 text-sm text-slate-200 outline-none"
                  >
                    {entryTypeDefaults.length ? (
                      entryTypeDefaults.map((t) => (
                        <option key={t.entry_type} value={t.entry_type}>
                          {t.entry_type}
                        </option>
                      ))
                    ) : (
                      <>
                        <option value="filing">filing</option>
                        <option value="resolution">resolution</option>
                        <option value="minute">minute</option>
                        <option value="agreement">agreement</option>
                      </>
                    )}
                  </select>
                  <p className="mt-1 text-[11px] text-slate-500">Source: entry_type_section_defaults</p>
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-slate-400 tracking-wider uppercase">Entry Date</label>
                  <input
                    type="date"
                    value={entryDate}
                    onChange={(e) => setEntryDate(e.target.value)}
                    className="mt-2 w-full rounded-2xl border border-slate-800 bg-slate-900/30 px-3 py-2.5 text-sm text-slate-200 outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-400 tracking-wider uppercase">Title</label>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g., Articles of Incorporation — Real Estate"
                  className="mt-2 w-full rounded-2xl border border-slate-800 bg-slate-900/30 px-3 py-2.5 text-sm text-slate-200 outline-none"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-400 tracking-wider uppercase">Notes</label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Optional registry notes…"
                  rows={4}
                  className="mt-2 w-full rounded-2xl border border-slate-800 bg-slate-900/30 px-3 py-2.5 text-sm text-slate-200 outline-none resize-none"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-400 tracking-wider uppercase">PDF (required)</label>
                <div className="mt-2 rounded-2xl border border-slate-800 bg-slate-900/20 px-3 py-3">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="application/pdf,.pdf"
                    onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
                    className="block w-full text-sm text-slate-200 file:mr-3 file:rounded-xl file:border-0 file:bg-slate-800/70 file:px-3 file:py-2 file:text-slate-200 hover:file:bg-slate-800"
                  />
                  <div className="mt-2 text-[11px] text-slate-500">
                    Bucket: <span className="text-slate-300">minute_book</span>
                  </div>
                </div>
              </div>

              {/* Footer buttons (kept minimal to match OS) */}
              <div className="pt-2 flex items-center gap-3">
                <button
                  onClick={uploadAndRegister}
                  disabled={!preview || busy}
                  className={cx(
                    "inline-flex items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold transition",
                    preview && !busy
                      ? "bg-amber-500/90 text-slate-950 hover:bg-amber-400"
                      : "bg-slate-800/60 text-slate-400 cursor-not-allowed"
                  )}
                >
                  <UploadCloud className="h-4 w-4" />
                  {busy ? "Uploading…" : "Upload & Register"}
                </button>

                <Link
                  href="/ci-archive/minute-book"
                  className="inline-flex items-center justify-center rounded-2xl border border-slate-800 bg-slate-900/30 px-4 py-3 text-sm text-slate-200 hover:bg-slate-900/60"
                >
                  Back to Registry
                </Link>
              </div>
            </div>
          </section>

          {/* MIDDLE: Preview / Deterministic write-set */}
          <section className="xl:col-span-4 rounded-3xl border border-slate-800 bg-slate-950/40 shadow-[0_0_0_1px_rgba(15,23,42,0.3)]">
            <div className="p-5 border-b border-slate-800/70">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-slate-200">Registry Preview</div>
                <div className="text-[10px] tracking-widest uppercase rounded-full border border-slate-700 bg-slate-900/30 text-slate-200 px-3 py-1">
                  Deterministic
                </div>
              </div>
              <div className="mt-2 text-xs text-slate-500">
                This panel shows exactly what will be written (storage path + metadata + SHA-256).
              </div>
            </div>

            <div className="p-5 space-y-4">
              <div className="rounded-2xl border border-slate-800 bg-slate-900/20 p-4">
                <div className="flex items-center gap-2">
                  <FolderTree className="h-4 w-4 text-amber-300" />
                  <div className="text-[11px] text-slate-400 tracking-wider uppercase">Storage Path</div>
                </div>

                <div className="mt-2 font-mono text-xs text-slate-200 break-all">
                  {preview ? (
                    preview.storage_path
                  ) : (
                    <span className="text-slate-500">Fill required fields + choose a PDF to compute path…</span>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3">
                <div className="rounded-2xl border border-slate-800 bg-slate-900/20 p-4">
                  <div className="flex items-center justify-between">
                    <div className="text-[11px] text-slate-400 tracking-wider uppercase">Entity</div>
                    <div className="text-[11px] text-slate-400 tracking-wider uppercase">Domain</div>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <div className="text-sm text-slate-200">{entityKey ?? "—"}</div>
                    <div className="text-sm text-slate-200">
                      {domainKey} <span className="text-slate-500">({domainLabel})</span>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-800 bg-slate-900/20 p-4">
                  <div className="flex items-center justify-between">
                    <div className="text-[11px] text-slate-400 tracking-wider uppercase">Entry Type</div>
                    <div className="text-[11px] text-slate-400 tracking-wider uppercase">Entry Date</div>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <div className="text-sm text-slate-200">{entryType}</div>
                    <div className="text-sm text-slate-200">{entryDate}</div>
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-800 bg-slate-900/20 p-4">
                  <div className="text-[11px] text-slate-400 tracking-wider uppercase">Title</div>
                  <div className="mt-2 text-sm text-slate-200">
                    {title.trim() ? title.trim() : <span className="text-slate-500">—</span>}
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-800 bg-slate-900/20 p-4">
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-amber-300" />
                    <div className="text-[11px] text-slate-400 tracking-wider uppercase">File</div>
                  </div>

                  <div className="mt-2 text-sm text-slate-200">
                    {preview ? preview.file_name : <span className="text-slate-500">No file selected</span>}
                  </div>

                  <div className="mt-3 flex items-start gap-2">
                    <Hash className="h-4 w-4 text-emerald-300 mt-0.5" />
                    <div className="text-[11px] text-slate-500 leading-relaxed">
                      SHA-256{" "}
                      <span className="font-mono text-slate-300">
                        {sha ? `${sha.slice(0, 16)}…${sha.slice(-16)}` : "—"}
                      </span>
                      <div className="mt-1 text-[11px] text-slate-500">
                        Hash is computed client-side and submitted as <span className="text-slate-300">p_pdf_hash</span>.
                      </div>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-800 bg-slate-900/20 p-4">
                  <div className="flex items-center gap-2">
                    <Database className="h-4 w-4 text-slate-300" />
                    <div className="text-[11px] text-slate-400 tracking-wider uppercase">Registry Index</div>
                  </div>
                  <div className="mt-2 text-[11px] text-slate-500 leading-relaxed">
                    After registration, the Minute Book registry reads from{" "}
                    <span className="text-slate-300">v_registry_minute_book_entries</span> and shows the primary doc via{" "}
                    <span className="text-slate-300">supporting_documents</span>.
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* RIGHT: Contract + guardrails (Council-like right rail) */}
          <section className="xl:col-span-4 rounded-3xl border border-slate-800 bg-slate-950/40 shadow-[0_0_0_1px_rgba(15,23,42,0.3)]">
            <div className="p-5 border-b border-slate-800/70">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-slate-200">Enterprise Contract</div>
                <div className="text-[10px] tracking-widest uppercase rounded-full border border-slate-700 bg-slate-900/30 text-slate-200 px-3 py-1">
                  Guardrails
                </div>
              </div>
              <div className="mt-2 text-xs text-slate-500">
                Upload accepts PDFs, but the system is built to produce and certify later (Verified Registry).
              </div>
            </div>

            <div className="p-5 space-y-4">
              <div className="rounded-2xl border border-slate-800 bg-slate-900/20 p-4">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-emerald-300" />
                  <div className="text-[11px] text-slate-400 tracking-wider uppercase">Principle</div>
                </div>
                <div className="mt-2 text-sm text-slate-200">Evidence-first. Registry-only surfaces.</div>
                <div className="mt-2 text-[11px] text-slate-500 leading-relaxed">
                  CI-Archive remains non-destructive. Upload is the single write-entry point. Read surfaces stay OS-native.
                </div>
              </div>

              <div className="rounded-2xl border border-slate-800 bg-slate-900/20 p-4">
                <div className="flex items-center gap-2">
                  <Hash className="h-4 w-4 text-amber-300" />
                  <div className="text-[11px] text-slate-400 tracking-wider uppercase">SHA-256 Enforcement</div>
                </div>
                <div className="mt-2 text-[11px] text-slate-500 leading-relaxed">
                  The hash is computed client-side and stored alongside the registry record. Later, Oasis can generate a
                  branded certificate and/or a signed envelope in the Verified Registry without changing the original
                  evidence file.
                </div>
              </div>

              <div className="rounded-2xl border border-slate-800 bg-slate-900/20 p-4">
                <div className="text-[11px] text-slate-400 tracking-wider uppercase">Write Contract</div>
                <div className="mt-2 font-mono text-xs text-slate-200 break-all">
                  Storage: <span className="text-slate-400">minute_book /</span>{" "}
                  <span className="text-slate-300">{preview?.storage_path ?? "<entity>/<domain>/<type>/<date>/<hash>-<file>"}</span>
                </div>
                <div className="mt-3 font-mono text-[11px] text-slate-500 leading-relaxed">
                  RPC: register_minute_book_upload(
                  <br />
                  &nbsp;&nbsp;p_entity_key, p_domain_key, p_entry_type, p_entry_date,
                  <br />
                  &nbsp;&nbsp;p_title, p_notes, p_file_name, p_storage_path,
                  <br />
                  &nbsp;&nbsp;p_pdf_hash, p_file_size, p_mime_type, p_supporting
                  <br />)
                </div>
              </div>

              <div className="rounded-2xl border border-slate-800 bg-slate-900/20 p-4">
                <div className="text-[11px] text-slate-400 tracking-wider uppercase">Tips</div>
                <ul className="mt-2 space-y-2 text-[11px] text-slate-500">
                  <li>• If you hit “resource already exists”, the storage path already exists for that hash+filename.</li>
                  <li>• If registry shows nothing, verify the DB record exists for the selected entity_key.</li>
                  <li>• Verified certificates belong in Verified Registry (attestation), not Minute Book (evidence).</li>
                </ul>
              </div>

              <div className="pt-1 flex items-center gap-2">
                <Link
                  href="/ci-archive"
                  className="inline-flex items-center justify-center rounded-2xl border border-slate-800 bg-slate-900/30 px-4 py-2.5 text-sm text-slate-200 hover:bg-slate-900/60"
                >
                  Archive Launchpad
                </Link>
                <Link
                  href="/ci-archive/minute-book"
                  className="inline-flex items-center justify-center rounded-2xl border border-slate-800 bg-slate-900/30 px-4 py-2.5 text-sm text-slate-200 hover:bg-slate-900/60"
                >
                  Minute Book
                </Link>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
