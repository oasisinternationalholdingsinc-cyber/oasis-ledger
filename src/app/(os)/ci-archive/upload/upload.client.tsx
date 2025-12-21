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
} from "lucide-react";

import { supabaseBrowser } from "@/lib/supabase/browser";
import { useEntity } from "@/components/OsEntityContext";

/**
 * CI-Archive → Upload (OS CONSISTENT — NO WIRING CHANGES)
 * ✅ SAME contract + wiring:
 *    - governance_domains
 *    - entry_type_section_defaults
 *    - SHA-256 client-side
 *    - bucket minute_book
 *    - storage path: <entity>/<domain>/<entry_type>/<YYYY-MM-DD>/<sha>-<filename>
 *    - RPC: register_minute_book_upload (with p_supporting array)
 * ✅ FIXES:
 *    - OS/Council framed window like Minute Book
 *    - No full-page overflow: only columns scroll independently
 *    - Layout/typography/buttons match Minute Book vibe
 */

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

type UploadState =
  | { status: "idle" }
  | { status: "hashing" }
  | { status: "uploading" }
  | { status: "registering" }
  | { status: "success"; entryId?: string }
  | { status: "error"; message: string };

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
  const { entityKey } = useEntity();

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [domains, setDomains] = useState<GovernanceDomain[]>([]);
  const [entryTypeDefaults, setEntryTypeDefaults] = useState<EntryTypeDefault[]>([]);
  const [loadingMeta, setLoadingMeta] = useState(true);

  const [domainKey, setDomainKey] = useState<string>("");
  const [entryType, setEntryType] = useState<string>("filing");
  const [entryDate, setEntryDate] = useState<string>(() => formatDateYYYYMMDD(new Date()));
  const [title, setTitle] = useState<string>("");
  const [notes, setNotes] = useState<string>("");

  const [file, setFile] = useState<File | null>(null);
  const [sha, setSha] = useState<string>("");
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  const [state, setState] = useState<UploadState>({ status: "idle" });

  // Load taxonomy + entry types (NO CHANGE)
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoadingMeta(true);

      const d = await supabase
        .from("governance_domains")
        .select("key,label,description,sort_order,active")
        .eq("active", true)
        .order("sort_order", { ascending: true });

      const t = await supabase
        .from("entry_type_section_defaults")
        .select("entry_type,default_section")
        .order("entry_type", { ascending: true });

      if (cancelled) return;

      if (d.error) {
        setDomains([]);
        setState({ status: "error", message: `Failed to load domains: ${d.error.message}` });
      } else {
        const list = (d.data ?? []) as GovernanceDomain[];
        setDomains(list);
        if (!domainKey && list.length) setDomainKey(list[0]!.key);
      }

      if (!t.error) {
        setEntryTypeDefaults((t.data ?? []) as EntryTypeDefault[]);
      }

      setLoadingMeta(false);
    }

    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase]);

  // Clean blob URL on file change/unmount (NO CHANGE)
  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  const domainLabel = useMemo(() => {
    const d = domains.find((x: GovernanceDomain) => x.key === domainKey);
    return d?.label ?? (domainKey || "—");
  }, [domains, domainKey]);

  const preview = useMemo(() => {
    if (!entityKey || !domainKey || !entryType || !entryDate || !title.trim() || !file || !sha) return null;

    const cleanFile = safeFilename(file.name);
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
    setState({ status: "idle" });
    setFile(f);
    setSha("");

    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      setBlobUrl(null);
    }

    if (!f) return;

    const isPdf = f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      setFile(null);
      setState({ status: "error", message: "PDF required. Please select a .pdf file." });
      return;
    }

    try {
      setState({ status: "hashing" });
      const h = await sha256Hex(f);
      setSha(h);

      setBlobUrl(URL.createObjectURL(f));

      if (!title.trim()) {
        const base = f.name.replace(/\.[^.]+$/, "");
        setTitle(base.replace(/[_-]+/g, " ").trim());
      }

      setState({ status: "idle" });
    } catch (e: any) {
      setFile(null);
      setSha("");
      setState({ status: "error", message: e?.message ?? "Failed to hash file." });
    }
  }

  async function uploadAndRegister() {
    if (!preview || !file) {
      setState({ status: "error", message: "Missing required fields (title, pdf, or hashing not complete)." });
      return;
    }

    setState({ status: "uploading" });

    try {
      // 1) Storage upload (NO CHANGE)
      const up = await supabase.storage.from("minute_book").upload(preview.storage_path, file, {
        cacheControl: "3600",
        upsert: false,
        contentType: preview.mime_type,
      });

      if (up.error) {
        const msg =
          up.error.message?.toLowerCase().includes("already exists")
            ? "Storage upload failed: The resource already exists (same path/hash). Delete the existing object or change the file."
            : `Storage upload failed: ${up.error.message}`;
        throw new Error(msg);
      }

      // 2) Register via canonical RPC (NO CHANGE)
      setState({ status: "registering" });

      const supportingPayload = [
        {
          role: "primary",
          file_path: preview.storage_path,
          file_name: preview.file_name,
          file_hash: preview.sha256,
          file_size: preview.file_size,
          mime_type: preview.mime_type,
        },
      ];

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
        p_supporting: supportingPayload as any,
      });

      if (rpc.error) {
        throw new Error(`Register failed: ${rpc.error.message}`);
      }

      const entryId = rpc.data ? String(rpc.data) : undefined;

      setState({ status: "success", entryId });

      // reset file + content, keep domain/type/date (NO CHANGE)
      setTitle("");
      setNotes("");
      setFile(null);
      setSha("");
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
        setBlobUrl(null);
      }
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (e: any) {
      setState({ status: "error", message: e?.message ?? "Upload failed." });
    }
  }

  const busy = state.status === "hashing" || state.status === "uploading" || state.status === "registering";

  const statusLabel =
    state.status === "hashing"
      ? "Hashing…"
      : state.status === "uploading"
      ? "Uploading…"
      : state.status === "registering"
      ? "Registering…"
      : "Ready";

  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      {/* Header under OS bar (Minute Book style) */}
      <div className="mb-4 shrink-0">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">CI-ARCHIVE</div>
        <p className="mt-1 text-[11px] text-slate-400">
          Minute Book Filing • <span className="font-semibold text-slate-200">Write-entry point</span> •{" "}
          <span className="text-slate-500">SHA-256 enforced</span>
        </p>
      </div>

      {/* Main Window – council-framed (visual only) */}
      <div className="flex-1 min-h-0 flex justify-center overflow-hidden">
        <div className="w-full max-w-[1600px] h-full rounded-3xl border border-slate-900 bg-black/60 shadow-[0_0_60px_rgba(15,23,42,0.9)] px-6 py-5 flex flex-col overflow-hidden">
          {/* Window Title */}
          <div className="flex items-start justify-between mb-4 shrink-0">
            <div className="min-w-0">
              <h1 className="text-lg font-semibold text-slate-50 truncate">Minute Book Filing</h1>
              <p className="mt-1 text-xs text-slate-400">
                Upload → hash → register.{" "}
                <span className="text-slate-500">
                  Registry remains read-only and OS-native (Minute Book page).
                </span>
              </p>
            </div>

            <div className="flex items-center gap-3 shrink-0">
              <Link
                href="/ci-archive"
                className="text-[11px] text-slate-300 hover:text-slate-100 inline-flex items-center gap-2"
                title="Back to CI-Archive Launchpad"
              >
                <ArrowLeft className="h-4 w-4" />
                <span className="opacity-80 hover:opacity-100">Launchpad</span>
              </Link>

              <button
                onClick={uploadAndRegister}
                disabled={!preview || busy}
                className={cx(
                  "rounded-full border px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition inline-flex items-center gap-2",
                  preview && !busy
                    ? "border-amber-500/40 bg-amber-500 text-black hover:bg-amber-400"
                    : "border-slate-800 bg-slate-900/40 text-slate-500 cursor-not-allowed"
                )}
              >
                <UploadCloud className="h-4 w-4" />
                {state.status === "uploading"
                  ? "Uploading…"
                  : state.status === "registering"
                  ? "Registering…"
                  : state.status === "hashing"
                  ? "Hashing…"
                  : "File into Minute Book"}
              </button>
            </div>
          </div>

          {/* Status banner (kept, just OS styled) */}
          {(state.status === "error" || state.status === "success") && (
            <div
              className={cx(
                "mb-4 rounded-2xl border px-4 py-3 text-sm shrink-0",
                state.status === "error"
                  ? "border-red-900/60 bg-red-950/30 text-red-200"
                  : "border-emerald-900/50 bg-emerald-950/25 text-emerald-200"
              )}
            >
              <div className="flex items-start gap-3">
                {state.status === "error" ? (
                  <AlertTriangle className="h-5 w-5 mt-0.5" />
                ) : (
                  <CheckCircle2 className="h-5 w-5 mt-0.5" />
                )}
                <div className="leading-relaxed w-full">
                  {state.status === "error" ? (
                    <span>{state.message}</span>
                  ) : (
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <span>
                        Upload + registration complete{state.entryId ? ` • Entry ID: ${state.entryId}` : ""}.
                      </span>
                      <Link
                        href={`/ci-archive/minute-book${entityKey ? `?entity_key=${encodeURIComponent(entityKey)}` : ""}`}
                        className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-500/15"
                      >
                        View in Registry →
                      </Link>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Entity guard */}
          {!entityKey ? (
            <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4 text-sm text-slate-300">
              Select an entity in the OS bar to file Minute Book records.
            </div>
          ) : (
            <>
              {/* Contract strip (Minute Book vibe) */}
              <div className="mb-4 shrink-0 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-2xl bg-slate-900/60 border border-slate-800 flex items-center justify-center">
                    <UploadCloud className="h-5 w-5 text-amber-300" />
                  </div>
                  <div>
                    <p className="text-xs md:text-sm text-slate-400 mt-0.5 flex items-center gap-2">
                      <ShieldCheck className="h-4 w-4 text-emerald-300" />
                      <span>Enterprise Contract • SHA-256 enforced</span>
                    </p>
                    <div className="text-[11px] text-slate-500">
                      State: <span className="text-slate-300">{statusLabel}</span>
                    </div>
                  </div>
                </div>

                <div className="text-[10px] tracking-widest uppercase rounded-full border border-amber-400/30 bg-amber-500/10 text-amber-200 px-3 py-1">
                  Upload is the sole write entry point
                </div>
              </div>

              {/* STRICT 3-column surface (NO page scroll) */}
              <div className="grid grid-cols-12 gap-6 flex-1 min-h-0">
                {/* LEFT: Filing Context */}
                <section className="col-span-12 lg:col-span-3 min-h-0 flex flex-col">
                  <div className="bg-slate-950/40 border border-slate-800 rounded-2xl p-4 flex flex-col min-h-0">
                    <div className="flex items-center justify-between mb-3 shrink-0">
                      <div>
                        <div className="text-sm font-semibold text-slate-200">Filing Context</div>
                        <div className="text-[11px] text-slate-500">Entity + Domain + Type + Date</div>
                      </div>
                      <span className="px-2 py-0.5 rounded-full bg-slate-900/60 border border-slate-800 text-[10px] tracking-[0.18em] uppercase text-slate-300">
                        context
                      </span>
                    </div>

                    <div className="flex-1 min-h-0 overflow-y-auto rounded-xl border border-slate-800/80 bg-slate-950/60 p-3 space-y-4">
                      <div>
                        <div className="text-xs text-slate-400">Entity</div>
                        <div className="mt-1 rounded-xl border border-slate-800 bg-slate-900/25 px-3 py-2 text-sm text-slate-200">
                          {entityKey}
                        </div>
                        <div className="mt-1 text-[11px] text-slate-500">Must match entity_key_enum.</div>
                      </div>

                      <div>
                        <div className="text-xs text-slate-400">Domain</div>
                        <select
                          value={domainKey}
                          onChange={(e) => setDomainKey(e.target.value)}
                          disabled={loadingMeta}
                          className="mt-1 w-full rounded-xl border border-slate-800 bg-slate-900/25 px-3 py-2 text-sm text-slate-200 outline-none focus:border-amber-500/40"
                        >
                          {domains.map((d: GovernanceDomain) => (
                            <option key={d.key} value={d.key}>
                              {d.label}
                            </option>
                          ))}
                        </select>
                        <div className="mt-1 text-[11px] text-slate-500">
                          Source: governance_domains (15 domains)
                        </div>
                      </div>

                      <div>
                        <div className="text-xs text-slate-400">Entry Type</div>
                        <select
                          value={entryType}
                          onChange={(e) => setEntryType(e.target.value)}
                          className="mt-1 w-full rounded-xl border border-slate-800 bg-slate-900/25 px-3 py-2 text-sm text-slate-200 outline-none focus:border-amber-500/40"
                        >
                          {entryTypeDefaults.length ? (
                            entryTypeDefaults.map((t: EntryTypeDefault) => (
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
                        <div className="mt-1 text-[11px] text-slate-500">Source: entry_type_section_defaults</div>
                      </div>

                      <div>
                        <div className="text-xs text-slate-400">Date</div>
                        <input
                          type="date"
                          value={entryDate}
                          onChange={(e) => setEntryDate(e.target.value)}
                          className="mt-1 w-full rounded-xl border border-slate-800 bg-slate-900/25 px-3 py-2 text-sm text-slate-200 outline-none focus:border-amber-500/40"
                        />
                      </div>
                    </div>

                    <div className="mt-3 text-[10px] text-slate-500 flex items-center justify-between">
                      <span>
                        Domain: <span className="text-slate-300">{domainLabel}</span>
                      </span>
                      <span className="text-slate-600">contract</span>
                    </div>
                  </div>
                </section>

                {/* MIDDLE: Filing Payload */}
                <section className="col-span-12 lg:col-span-5 min-h-0 flex flex-col">
                  <div className="bg-slate-950/40 border border-slate-800 rounded-2xl p-4 flex flex-col min-h-0">
                    <div className="flex items-start justify-between mb-3 shrink-0">
                      <div>
                        <div className="text-sm font-semibold text-slate-200">Filing Payload</div>
                        <div className="text-[11px] text-slate-500">Title • Notes • PDF • Hash</div>
                      </div>
                      <span className="px-2 py-0.5 rounded-full bg-sky-500/10 border border-sky-500/30 text-[10px] uppercase tracking-[0.18em] text-sky-200">
                        writer
                      </span>
                    </div>

                    <div className="flex-1 min-h-0 overflow-y-auto rounded-xl border border-slate-800/80 bg-slate-950/60 p-3 space-y-4">
                      <div>
                        <div className="text-xs text-slate-400">Title</div>
                        <input
                          value={title}
                          onChange={(e) => setTitle(e.target.value)}
                          placeholder="e.g., Articles of Incorporation — Real Estate"
                          className="mt-1 w-full rounded-xl border border-slate-800 bg-slate-900/25 px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-amber-500/40"
                        />
                      </div>

                      <div>
                        <div className="text-xs text-slate-400">Notes</div>
                        <textarea
                          value={notes}
                          onChange={(e) => setNotes(e.target.value)}
                          placeholder="Optional registry notes…"
                          rows={6}
                          className="mt-1 w-full rounded-xl border border-slate-800 bg-slate-900/25 px-3 py-2.5 text-sm text-slate-200 outline-none resize-none focus:border-amber-500/40"
                        />
                      </div>

                      <div>
                        <div className="text-xs text-slate-400">PDF</div>
                        <div className="mt-1 rounded-xl border border-slate-800 bg-slate-900/20 px-3 py-3">
                          <input
                            ref={fileInputRef}
                            type="file"
                            accept="application/pdf,.pdf"
                            onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
                            className="block w-full text-sm text-slate-200 file:mr-3 file:rounded-xl file:border-0 file:bg-slate-800/70 file:px-3 file:py-2 file:text-slate-200 hover:file:bg-slate-800"
                          />
                          <div className="mt-2 text-[11px] text-slate-500 flex items-center justify-between gap-3">
                            <span>
                              Bucket: <span className="text-slate-300">minute_book</span>
                            </span>
                            <span className="inline-flex items-center gap-2">
                              <span className="text-emerald-300">#</span>
                              <span>SHA-256 enforced</span>
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-xl border border-slate-800 bg-slate-900/15 p-3">
                        <div className="text-[11px] text-slate-500 leading-relaxed">
                          This page writes:{" "}
                          <span className="text-slate-300">Storage upload → register_minute_book_upload()</span>. <br />
                          The registry reads Minute Book evidence from{" "}
                          <span className="text-slate-300">minute_book_entries + supporting_documents</span>.
                        </div>
                      </div>
                    </div>
                  </div>
                </section>

                {/* RIGHT: Registry Projection */}
                <section className="col-span-12 lg:col-span-4 min-h-0 flex flex-col">
                  <div className="bg-slate-950/40 border border-slate-800 rounded-2xl p-4 flex flex-col min-h-0">
                    <div className="flex items-start justify-between mb-3 shrink-0">
                      <div>
                        <div className="text-sm font-semibold text-slate-200">Registry Projection</div>
                        <div className="text-[11px] text-slate-500">Path + Evidence + Local Preview</div>
                      </div>
                      <span className="px-2 py-0.5 rounded-full bg-slate-900/60 border border-slate-800 text-[10px] tracking-[0.18em] uppercase text-slate-300">
                        projection
                      </span>
                    </div>

                    <div className="flex-1 min-h-0 overflow-y-auto rounded-xl border border-slate-800/80 bg-slate-950/60 p-3 space-y-3">
                      <div className="rounded-xl border border-slate-800 bg-slate-900/15 p-3">
                        <div className="text-[11px] text-slate-400 tracking-wider uppercase">Storage Path</div>
                        <div className="mt-2 font-mono text-xs text-slate-200 break-all">
                          {preview ? (
                            preview.storage_path
                          ) : (
                            <span className="text-slate-500">
                              Fill fields + choose a PDF to compute path…
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="grid grid-cols-1 gap-3">
                        <div className="rounded-xl border border-slate-800 bg-slate-900/15 p-3">
                          <div className="text-[11px] text-slate-400 tracking-wider uppercase">Domain</div>
                          <div className="mt-1 text-sm text-slate-200">
                            {domainKey || "—"} <span className="text-slate-500">({domainLabel})</span>
                          </div>
                        </div>

                        <div className="rounded-xl border border-slate-800 bg-slate-900/15 p-3">
                          <div className="flex items-center gap-2">
                            <FileText className="h-4 w-4 text-amber-300" />
                            <div className="text-[11px] text-slate-400 tracking-wider uppercase">Evidence</div>
                          </div>
                          <div className="mt-2 text-sm text-slate-200">
                            {preview ? preview.file_name : <span className="text-slate-500">No file selected</span>}
                          </div>
                          <div className="mt-2 text-[11px] text-slate-500">
                            SHA-256:{" "}
                            <span className="font-mono text-slate-300">
                              {sha ? `${sha.slice(0, 16)}…${sha.slice(-16)}` : "—"}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-xl border border-slate-800 bg-slate-900/15 overflow-hidden">
                        <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between">
                          <div className="text-xs text-slate-300">Local Preview</div>
                          <div className="text-[11px] text-slate-500">PDF-first</div>
                        </div>
                        <div className="h-[260px] bg-slate-950/20">
                          {blobUrl ? (
                            <object data={blobUrl} type="application/pdf" className="w-full h-full">
                              <div className="p-4 text-sm text-slate-400">
                                Preview unavailable. Use Download/Open after filing.
                              </div>
                            </object>
                          ) : (
                            <div className="h-full flex items-center justify-center text-sm text-slate-500">
                              Select a PDF to preview.
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="text-[11px] text-slate-500 leading-relaxed">
                        If the Minute Book registry ever says “no storage_path on primary document”, it means{" "}
                        <span className="text-slate-300">supporting_documents</span> didn’t get created for that entry_id.
                        (Your current RPC payload already fixes this.)
                      </div>
                    </div>

                    <div className="mt-3 flex items-center justify-between text-[10px] text-slate-500">
                      <span>Upload is the write entry point.</span>
                      <Link href="/ci-archive/minute-book" className="hover:text-slate-200">
                        Go to Registry →
                      </Link>
                    </div>
                  </div>
                </section>
              </div>
            </>
          )}

          <div className="mt-3 flex items-center justify-between text-[10px] text-slate-500">
            <span>CI-Archive · Oasis Digital Parliament</span>
            <span>ODP.AI · Governance Firmware</span>
          </div>
        </div>
      </div>
    </div>
  );
}
