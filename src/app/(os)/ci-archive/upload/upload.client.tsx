// src/app/(os)/ci-archive/upload/upload.client.tsx
"use client";

export const dynamic = "force-dynamic";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, UploadCloud, ShieldCheck, FileText, AlertTriangle, CheckCircle2 } from "lucide-react";

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
  const { entityKey } = useEntity(); // "holdings" | "real-estate" | "lounge"

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

  // Load taxonomy + entry types
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

  // Clean blob URL on file change/unmount
  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  const domainLabel = useMemo(() => {
    const d = domains.find((x) => x.key === domainKey);
    return d?.label ?? (domainKey || "—");
  }, [domains, domainKey]);

  const preview = useMemo(() => {
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

      // local preview
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
      // 1) Storage upload (bucket stays unchanged)
      const up = await supabase.storage.from("minute_book").upload(preview.storage_path, file, {
        cacheControl: "3600",
        upsert: false,
        contentType: preview.mime_type,
      });

      if (up.error) {
        // Friendly enterprise messaging for common cases
        const msg =
          up.error.message?.toLowerCase().includes("already exists")
            ? "Storage upload failed: The resource already exists (same path/hash). Delete the existing object or change the file."
            : `Storage upload failed: ${up.error.message}`;
        throw new Error(msg);
      }

      // 2) Register via canonical RPC (contract unchanged)
      setState({ status: "registering" });

      // IMPORTANT: pass p_pdf_hash + p_supporting (jsonb)
      // We send supporting as an ARRAY (safe for jsonb_array_elements patterns).
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
        p_supporting: supportingPayload as any, // jsonb
      });

      if (rpc.error) {
        throw new Error(`Register failed: ${rpc.error.message}`);
      }

      const entryId = rpc.data ? String(rpc.data) : undefined;

      setState({ status: "success", entryId });

      // reset file + content, keep domain/type/date
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

  return (
    <div className="min-h-[calc(100vh-72px)] px-4 py-6 md:px-8">
      <div className="mx-auto w-full max-w-[1400px]">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-2xl bg-slate-900/60 border border-slate-800 flex items-center justify-center">
                <UploadCloud className="h-5 w-5 text-amber-300" />
              </div>
              <div>
                <h1 className="text-xl md:text-2xl font-semibold text-slate-100">Minute Book Filing</h1>
                <p className="text-xs md:text-sm text-slate-400 mt-1 flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-emerald-300" />
                  <span>Enterprise Contract • SHA-256 enforced</span>
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Link
              href="/ci-archive"
              className="text-sm text-slate-300 hover:text-slate-100 inline-flex items-center gap-2"
              title="Back to CI-Archive Launchpad"
            >
              <ArrowLeft className="h-4 w-4" />
              <span className="opacity-80 hover:opacity-100">Launchpad</span>
            </Link>

            <button
              onClick={uploadAndRegister}
              disabled={!preview || busy}
              className={cx(
                "inline-flex items-center gap-2 rounded-2xl px-4 py-2.5 text-sm font-semibold transition border",
                preview && !busy
                  ? "bg-amber-500/90 text-slate-950 border-amber-400/40 hover:bg-amber-400"
                  : "bg-slate-900/40 text-slate-500 border-slate-800 cursor-not-allowed"
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

        {/* Status banner */}
        {(state.status === "error" || state.status === "success") && (
          <div
            className={cx(
              "mb-4 rounded-2xl border px-4 py-3 text-sm",
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
              <div className="leading-relaxed">
                {state.status === "error" ? (
                  <span>{state.message}</span>
                ) : (
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <span>
                      Upload + registration complete{state.entryId ? ` • Entry ID: ${state.entryId}` : ""}.
                    </span>
                    <Link
                      href={`/ci-archive/minute-book${entityKey ? `?entity_key=${encodeURIComponent(entityKey)}` : ""}`}
                      className="inline-flex items-center gap-2 rounded-xl border border-emerald-400/20 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-500/15"
                    >
                      View in Registry →
                    </Link>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Three-column console surface (Council-style) */}
        <div className="rounded-3xl border border-slate-800 bg-slate-950/35 shadow-[0_0_0_1px_rgba(15,23,42,0.35)]">
          <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
            <div className="text-xs text-slate-400">
              Upload is the sole write-entry point. Registry remains OS-native and read-only.
            </div>
            <div className="text-[10px] tracking-widest uppercase rounded-full border border-amber-400/30 bg-amber-500/10 text-amber-200 px-3 py-1">
              Enterprise Contract
            </div>
          </div>

          {/* IMPORTANT: prevent whole-page scroll, keep columns scrolling independently */}
          <div className="h-[calc(100vh-220px)] min-h-[520px] overflow-hidden">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-0 h-full">
              {/* LEFT: Filing Context */}
              <div className="h-full overflow-auto border-b lg:border-b-0 lg:border-r border-slate-800 p-5">
                <div className="text-[11px] tracking-widest uppercase text-slate-500">Filing Context</div>

                <div className="mt-4 space-y-4">
                  <div>
                    <div className="text-xs text-slate-400">Entity</div>
                    <div className="mt-1 rounded-2xl border border-slate-800 bg-slate-900/25 px-3 py-2 text-sm text-slate-200">
                      {entityKey || "—"}
                    </div>
                    <div className="mt-1 text-[11px] text-slate-500">Must match entity_key_enum.</div>
                  </div>

                  <div>
                    <div className="text-xs text-slate-400">Domain</div>
                    <select
                      value={domainKey}
                      onChange={(e) => setDomainKey(e.target.value)}
                      disabled={loadingMeta}
                      className="mt-1 w-full rounded-2xl border border-slate-800 bg-slate-900/25 px-3 py-2 text-sm text-slate-200 outline-none"
                    >
                      {domains.map((d) => (
                        <option key={d.key} value={d.key}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                    <div className="mt-1 text-[11px] text-slate-500">Source: governance_domains (15 domains)</div>
                  </div>

                  <div>
                    <div className="text-xs text-slate-400">Entry Type</div>
                    <select
                      value={entryType}
                      onChange={(e) => setEntryType(e.target.value)}
                      className="mt-1 w-full rounded-2xl border border-slate-800 bg-slate-900/25 px-3 py-2 text-sm text-slate-200 outline-none"
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
                    <div className="mt-1 text-[11px] text-slate-500">Source: entry_type_section_defaults</div>
                  </div>

                  <div>
                    <div className="text-xs text-slate-400">Date</div>
                    <input
                      type="date"
                      value={entryDate}
                      onChange={(e) => setEntryDate(e.target.value)}
                      className="mt-1 w-full rounded-2xl border border-slate-800 bg-slate-900/25 px-3 py-2 text-sm text-slate-200 outline-none"
                    />
                  </div>
                </div>
              </div>

              {/* MIDDLE: Filing Payload */}
              <div className="h-full overflow-auto border-b lg:border-b-0 lg:border-r border-slate-800 p-5">
                <div className="flex items-center justify-between">
                  <div className="text-[11px] tracking-widest uppercase text-slate-500">Filing Payload</div>
                  <div className="text-[11px] text-slate-500">
                    {state.status === "hashing"
                      ? "Hashing…"
                      : state.status === "uploading"
                      ? "Uploading…"
                      : state.status === "registering"
                      ? "Registering…"
                      : "Ready"}
                  </div>
                </div>

                <div className="mt-4 space-y-4">
                  <div>
                    <div className="text-xs text-slate-400">Title</div>
                    <input
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="e.g., Articles of Incorporation — Real Estate"
                      className="mt-1 w-full rounded-2xl border border-slate-800 bg-slate-900/25 px-3 py-2.5 text-sm text-slate-200 outline-none"
                    />
                  </div>

                  <div>
                    <div className="text-xs text-slate-400">Notes</div>
                    <textarea
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="Optional registry notes…"
                      rows={5}
                      className="mt-1 w-full rounded-2xl border border-slate-800 bg-slate-900/25 px-3 py-2.5 text-sm text-slate-200 outline-none resize-none"
                    />
                  </div>

                  <div>
                    <div className="text-xs text-slate-400">PDF</div>
                    <div className="mt-1 rounded-2xl border border-slate-800 bg-slate-900/20 px-3 py-3">
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

                  <div className="pt-2">
                    <div className="text-[11px] text-slate-500 leading-relaxed">
                      This page writes: <span className="text-slate-300">Storage upload → register_minute_book_upload()</span>.
                      The registry reads from <span className="text-slate-300">v_registry_minute_book_entries</span>.
                    </div>
                  </div>
                </div>
              </div>

              {/* RIGHT: Registry Projection */}
              <div className="h-full overflow-auto p-5">
                <div className="text-[11px] tracking-widest uppercase text-slate-500">Registry Projection</div>

                <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-900/20 p-4">
                  <div className="text-[11px] text-slate-400 tracking-wider uppercase">Storage Path</div>
                  <div className="mt-2 font-mono text-xs text-slate-200 break-all">
                    {preview ? preview.storage_path : <span className="text-slate-500">Fill fields + choose a PDF to compute path…</span>}
                  </div>

                  <div className="mt-4 grid grid-cols-1 gap-3">
                    <div className="rounded-2xl border border-slate-800 bg-slate-900/15 p-3">
                      <div className="text-[11px] text-slate-400 tracking-wider uppercase">Domain</div>
                      <div className="mt-1 text-sm text-slate-200">
                        {domainKey || "—"} <span className="text-slate-500">({domainLabel})</span>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-slate-800 bg-slate-900/15 p-3">
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
                </div>

                {/* Local PDF preview (client-only) */}
                <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-900/15 overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
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

                <div className="mt-4 text-[11px] text-slate-500 leading-relaxed">
                  The projection above is what the registry will display. If registry says “no storage_path on primary document”,
                  it means <span className="text-slate-300">supporting_documents</span> didn’t get created for that entry_id.
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer hint */}
        <div className="mt-4 text-[11px] text-slate-600">
          CI-Archive is registry-only (non-destructive). Upload is the write-entry point.
        </div>
      </div>
    </div>
  );
}
