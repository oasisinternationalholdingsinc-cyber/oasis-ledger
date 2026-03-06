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

import { supabaseBrowser as supabaseBrowserImport } from "@/lib/supabase/browser";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";

/**
 * CI-Archive → Upload (OS CONSISTENT — NO WIRING CHANGES)
 * ✅ SAME contract + wiring:
 *    - governance_domains
 *    - entry_type_section_defaults
 *    - SHA-256 client-side
 *    - bucket minute_book
 *    - storage path: <entity>/<domain>/<entry_type>/<YYYY-MM-DD>/<sha>-<filename>
 *    - RPC: register_minute_book_upload (with p_supporting array)
 *
 * ✅ No hardcoding:
 *    - entityKey comes ONLY from OsEntityContext
 *
 * ✅ NEW (UI + p_source_record_id only; NO backend rewiring):
 *    - Filing Mode toggle:
 *        1) Standalone Archive
 *        2) Linked to Ledger
 *    - Linked mode loads governance_ledger rows for active entity + active lane only
 *    - RPC now passes p_source_record_id = selected governance_ledger.id when linked
 *    - Standalone remains default, preserving current upload behavior
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

type LedgerOption = {
  id: string;
  title: string | null;
  status: string | null;
  is_test: boolean | null;
  created_at: string | null;
};

type FilingMode = "standalone" | "ledger";

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

function shortId(id: string | null | undefined) {
  const s = String(id || "").trim();
  if (!s) return "—";
  if (s.length <= 16) return s;
  return `${s.slice(0, 8)}…${s.slice(-6)}`;
}

function prettyLedgerStatus(s: string | null | undefined) {
  const v = String(s || "")
    .trim()
    .toUpperCase()
    .replace(/[_-]+/g, " ");
  return v || "—";
}

async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buf);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ✅ supports BOTH exports:
// - function supabaseBrowser(): SupabaseClient
// - const supabaseBrowser: SupabaseClient
function getSupabaseClient() {
  const anyRef: any = supabaseBrowserImport as any;
  return typeof anyRef === "function" ? anyRef() : anyRef;
}

export default function UploadClient() {
  const supabase = useMemo(() => getSupabaseClient(), []);
  const { entityKey } = useEntity();
  const { env } = useOsEnv();

  const laneIsTest = env === "SANDBOX";

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [domains, setDomains] = useState<GovernanceDomain[]>([]);
  const [entryTypeDefaults, setEntryTypeDefaults] = useState<EntryTypeDefault[]>([]);
  const [loadingMeta, setLoadingMeta] = useState(true);

  const [filingMode, setFilingMode] = useState<FilingMode>("standalone");
  const [ledgerOptions, setLedgerOptions] = useState<LedgerOption[]>([]);
  const [loadingLedger, setLoadingLedger] = useState(false);
  const [sourceRecordId, setSourceRecordId] = useState<string>("");

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

  // ✅ Load eligible governance_ledger records for linked mode (entity + lane safe)
  useEffect(() => {
    let cancelled = false;

    async function loadLedgerOptions() {
      setLedgerOptions([]);
      setSourceRecordId("");

      if (!entityKey) return;

      setLoadingLedger(true);

      try {
        const entityRes = await supabase
          .from("entities")
          .select("id")
          .eq("slug", entityKey)
          .limit(1)
          .maybeSingle();

        if (cancelled) return;

        if (entityRes.error || !entityRes.data?.id) {
          setLedgerOptions([]);
          setLoadingLedger(false);
          return;
        }

        const ledgerRes = await supabase
          .from("governance_ledger")
          .select("id,title,status,is_test,created_at")
          .eq("entity_id", entityRes.data.id)
          .eq("is_test", laneIsTest)
          .order("created_at", { ascending: false })
          .limit(100);

        if (cancelled) return;

        if (ledgerRes.error) {
          setLedgerOptions([]);
        } else {
          setLedgerOptions((ledgerRes.data ?? []) as LedgerOption[]);
        }
      } catch {
        if (!cancelled) setLedgerOptions([]);
      } finally {
        if (!cancelled) setLoadingLedger(false);
      }
    }

    loadLedgerOptions();

    return () => {
      cancelled = true;
    };
  }, [supabase, entityKey, laneIsTest]);

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

  const selectedLedger = useMemo(() => {
    return ledgerOptions.find((x) => x.id === sourceRecordId) ?? null;
  }, [ledgerOptions, sourceRecordId]);

  const preview = useMemo(() => {
    if (!entityKey || !domainKey || !entryType || !entryDate || !title.trim() || !file || !sha) {
      return null;
    }

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
      source_record_id: filingMode === "ledger" ? sourceRecordId.trim() || null : null,
    };
  }, [
    entityKey,
    domainKey,
    entryType,
    entryDate,
    title,
    notes,
    file,
    sha,
    filingMode,
    sourceRecordId,
  ]);

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
      setState({
        status: "error",
        message: "Missing required fields (title, pdf, or hashing not complete).",
      });
      return;
    }

    if (filingMode === "ledger" && !preview.source_record_id) {
      setState({
        status: "error",
        message: "Select a governance ledger record before filing in linked mode.",
      });
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

      // 2) Register via canonical RPC (NO CHANGE except p_source_record_id wiring)
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
        p_source_record_id: preview.source_record_id,
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
      setFilingMode("standalone");
      setSourceRecordId("");

      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
        setBlobUrl(null);
      }
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (e: any) {
      setState({ status: "error", message: e?.message ?? "Upload failed." });
    }
  }

  const busy =
    state.status === "hashing" || state.status === "uploading" || state.status === "registering";

  const statusLabel =
    state.status === "hashing"
      ? "Hashing…"
      : state.status === "uploading"
      ? "Uploading…"
      : state.status === "registering"
      ? "Registering…"
      : "Ready";

  const canSubmit = Boolean(
    preview &&
      !busy &&
      entityKey &&
      (filingMode === "standalone" || (filingMode === "ledger" && sourceRecordId.trim()))
  );

  // ✅ OS shell/header/body pattern (MATCH CI-ARCHIVE launchpad)
  const shell =
    "rounded-3xl border border-white/10 bg-black/20 shadow-[0_28px_120px_rgba(0,0,0,0.55)] overflow-hidden";
  const header =
    "border-b border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent px-4 sm:px-6 py-4 sm:py-5";
  const body = "px-4 sm:px-6 py-5 sm:py-6";

  return (
    <div className="w-full">
      <div className="mx-auto w-full max-w-[1200px] px-4 pb-10 pt-4 sm:pt-6">
        <div className={shell}>
          {/* OS-aligned header (matches Archive/Parliament/Onboarding launchpads) */}
          <div className={header}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10px] sm:text-xs tracking-[0.3em] uppercase text-slate-500">
                  CI • Archive
                </div>
                <h1 className="mt-1 text-lg sm:text-xl font-semibold text-slate-50">Upload</h1>
                <p className="mt-1 max-w-3xl text-[11px] sm:text-xs text-slate-400 leading-relaxed">
                  Domain-driven filing intake. SHA-256 enforced. Storage upload → register_minute_book_upload().
                </p>
              </div>

              <div className="shrink-0 flex items-center gap-2">
                <Link
                  href="/ci-archive"
                  className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7 inline-flex items-center gap-2"
                  title="Back to CI-Archive Launchpad"
                >
                  <ArrowLeft className="h-4 w-4" />
                  Launchpad
                </Link>

                <button
                  onClick={uploadAndRegister}
                  disabled={!canSubmit}
                  className={cx(
                    "rounded-full border px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase transition inline-flex items-center gap-2",
                    canSubmit
                      ? "border-amber-500/40 bg-amber-500 text-black hover:bg-amber-400"
                      : "border-white/10 bg-white/5 text-slate-500 cursor-not-allowed"
                  )}
                >
                  <UploadCloud className="h-4 w-4" />
                  {state.status === "uploading"
                    ? "Uploading…"
                    : state.status === "registering"
                    ? "Registering…"
                    : state.status === "hashing"
                    ? "Hashing…"
                    : "File"}
                </button>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-400">
              <span className="inline-flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-emerald-300" />
                <span>Enterprise contract • SHA-256 enforced</span>
              </span>
              <span className="text-slate-700">•</span>
              <span>
                State: <span className="text-slate-200 font-medium">{statusLabel}</span>
              </span>
              <span className="text-slate-700">•</span>
              <span>
                Lane:{" "}
                <span className={cx("font-medium", laneIsTest ? "text-amber-200" : "text-slate-200")}>
                  {laneIsTest ? "SANDBOX" : "RoT"}
                </span>
              </span>
              <span className="text-slate-700">•</span>
              <span className="text-slate-500">OS module surface</span>
            </div>
          </div>

          <div className={body}>
            {(state.status === "error" || state.status === "success") && (
              <div
                className={cx(
                  "mb-4 rounded-3xl border px-4 py-3 text-sm",
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
                          href={`/ci-archive/minute-book${
                            entityKey ? `?entity_key=${encodeURIComponent(entityKey)}` : ""
                          }`}
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

            {!entityKey ? (
              <div className="rounded-3xl border border-white/10 bg-black/20 px-4 py-4 text-sm text-slate-300">
                Select an entity in the OS bar to file Minute Book records.
              </div>
            ) : (
              <>
                <div className="grid grid-cols-12 gap-4">
                  {/* Filing Context */}
                  <section className="col-span-12 lg:col-span-3">
                    <div className="rounded-3xl border border-white/10 bg-black/20 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-slate-200">Filing Context</div>
                          <div className="text-[11px] text-slate-500">Entity + Domain + Type + Date</div>
                        </div>
                        <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[10px] tracking-[0.18em] uppercase text-slate-200">
                          context
                        </span>
                      </div>

                      <div className="mt-3 space-y-4">
                        <div>
                          <div className="text-xs text-slate-400">Entity</div>
                          <div className="mt-1 rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-200">
                            {entityKey}
                          </div>
                          <div className="mt-1 text-[11px] text-slate-500">Must match entity_key_enum.</div>
                        </div>

                        {/* ✅ NEW: filing mode toggle */}
                        <div>
                          <div className="text-xs text-slate-400">Filing Mode</div>
                          <div className="mt-1 grid grid-cols-2 gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setFilingMode("standalone");
                                setSourceRecordId("");
                              }}
                              className={cx(
                                "rounded-2xl border px-3 py-2 text-sm transition",
                                filingMode === "standalone"
                                  ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
                                  : "border-white/10 bg-white/5 text-slate-200 hover:bg-white/7"
                              )}
                            >
                              Standalone Archive
                            </button>

                            <button
                              type="button"
                              onClick={() => setFilingMode("ledger")}
                              className={cx(
                                "rounded-2xl border px-3 py-2 text-sm transition",
                                filingMode === "ledger"
                                  ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
                                  : "border-white/10 bg-white/5 text-slate-200 hover:bg-white/7"
                              )}
                            >
                              Linked to Ledger
                            </button>
                          </div>
                          <div className="mt-1 text-[11px] text-slate-500">
                            Standalone remains the default. Linked mode attaches this filing to an existing governance_ledger record.
                          </div>
                        </div>

                        {filingMode === "ledger" ? (
                          <div>
                            <div className="text-xs text-slate-400">Ledger Record</div>
                            <select
                              value={sourceRecordId}
                              onChange={(e) => setSourceRecordId(e.target.value)}
                              disabled={loadingLedger}
                              className="mt-1 w-full rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-200 outline-none focus:border-amber-500/40"
                            >
                              <option value="">
                                {loadingLedger ? "Loading ledger records…" : "Select governance record…"}
                              </option>
                              {ledgerOptions.map((r) => (
                                <option key={r.id} value={r.id}>
                                  {(r.title || "Untitled record").trim()} • {prettyLedgerStatus(r.status)} • {shortId(r.id)}
                                </option>
                              ))}
                            </select>

                            <div className="mt-1 text-[11px] text-slate-500">
                              Source: governance_ledger • entity scoped • {laneIsTest ? "SANDBOX" : "RoT"} lane only
                            </div>

                            {filingMode === "ledger" && !loadingLedger && ledgerOptions.length === 0 ? (
                              <div className="mt-2 rounded-2xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
                                No eligible governance records found for this entity/lane.
                              </div>
                            ) : null}

                            {selectedLedger ? (
                              <div className="mt-2 rounded-2xl border border-white/10 bg-black/20 p-3">
                                <div className="text-[11px] text-slate-400 tracking-wider uppercase">Linked Record</div>
                                <div className="mt-1 text-sm text-slate-200">
                                  {selectedLedger.title || "Untitled record"}
                                </div>
                                <div className="mt-1 text-[11px] text-slate-500">
                                  {prettyLedgerStatus(selectedLedger.status)} • {shortId(selectedLedger.id)}
                                </div>
                              </div>
                            ) : null}
                          </div>
                        ) : null}

                        <div>
                          <div className="text-xs text-slate-400">Domain</div>
                          <select
                            value={domainKey}
                            onChange={(e) => setDomainKey(e.target.value)}
                            disabled={loadingMeta}
                            className="mt-1 w-full rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-200 outline-none focus:border-amber-500/40"
                          >
                            {domains.map((d: GovernanceDomain) => (
                              <option key={d.key} value={d.key}>
                                {d.label}
                              </option>
                            ))}
                          </select>
                          <div className="mt-1 text-[11px] text-slate-500">Source: governance_domains</div>
                        </div>

                        <div>
                          <div className="text-xs text-slate-400">Entry Type</div>
                          <select
                            value={entryType}
                            onChange={(e) => setEntryType(e.target.value)}
                            className="mt-1 w-full rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-200 outline-none focus:border-amber-500/40"
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
                          <div className="mt-1 text-[11px] text-slate-500">
                            Source: entry_type_section_defaults
                          </div>
                        </div>

                        <div>
                          <div className="text-xs text-slate-400">Date</div>
                          <input
                            type="date"
                            value={entryDate}
                            onChange={(e) => setEntryDate(e.target.value)}
                            className="mt-1 w-full rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-200 outline-none focus:border-amber-500/40"
                          />
                        </div>

                        <div className="text-[10px] text-slate-500 flex items-center justify-between">
                          <span>
                            Domain: <span className="text-slate-200">{domainLabel}</span>
                          </span>
                          <span className="text-slate-600">
                            {filingMode === "ledger" ? "linked" : "standalone"}
                          </span>
                        </div>
                      </div>
                    </div>
                  </section>

                  {/* Filing Payload */}
                  <section className="col-span-12 lg:col-span-5">
                    <div className="rounded-3xl border border-white/10 bg-black/20 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-slate-200">Filing Payload</div>
                          <div className="text-[11px] text-slate-500">Title • Notes • PDF • Hash</div>
                        </div>
                        <span className="px-2 py-0.5 rounded-full bg-sky-500/10 border border-sky-500/30 text-[10px] uppercase tracking-[0.18em] text-sky-200">
                          writer
                        </span>
                      </div>

                      <div className="mt-3 space-y-4">
                        <div>
                          <div className="text-xs text-slate-400">Title</div>
                          <input
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder="e.g., Articles of Incorporation — Real Estate"
                            className="mt-1 w-full rounded-2xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-amber-500/40"
                          />
                        </div>

                        <div>
                          <div className="text-xs text-slate-400">Notes</div>
                          <textarea
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            placeholder="Optional registry notes…"
                            rows={6}
                            className="mt-1 w-full rounded-2xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-slate-200 outline-none resize-none focus:border-amber-500/40"
                          />
                        </div>

                        <div>
                          <div className="text-xs text-slate-400">PDF</div>
                          <div className="mt-1 rounded-2xl border border-white/10 bg-white/5 px-3 py-3">
                            <input
                              ref={fileInputRef}
                              type="file"
                              accept="application/pdf,.pdf"
                              onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
                              className="block w-full text-sm text-slate-200 file:mr-3 file:rounded-xl file:border-0 file:bg-white/10 file:px-3 file:py-2 file:text-slate-200 hover:file:bg-white/15"
                            />
                            <div className="mt-2 text-[11px] text-slate-500 flex items-center justify-between gap-3 flex-wrap">
                              <span>
                                Bucket: <span className="text-slate-200">minute_book</span>
                              </span>
                              <span className="inline-flex items-center gap-2">
                                <span className="text-emerald-300">#</span>
                                <span>SHA-256 enforced</span>
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                          <div className="text-[11px] text-slate-500 leading-relaxed">
                            This page writes:{" "}
                            <span className="text-slate-200">
                              Storage upload → register_minute_book_upload()
                            </span>
                            .
                            <br />
                            The registry reads evidence from{" "}
                            <span className="text-slate-200">
                              minute_book_entries + supporting_documents
                            </span>
                            .
                            <br />
                            <span className="text-slate-200">
                              {filingMode === "ledger"
                                ? "Linked mode will attach source_record_id to the selected governance record."
                                : "Standalone mode will file a pristine Minute Book upload with no governance link."}
                            </span>
                          </div>
                        </div>

                        {/* Mobile-friendly secondary CTA */}
                        <button
                          onClick={uploadAndRegister}
                          disabled={!canSubmit}
                          className={cx(
                            "w-full sm:hidden rounded-full border px-4 py-3 text-[10px] font-semibold tracking-[0.18em] uppercase transition inline-flex items-center justify-center gap-2",
                            canSubmit
                              ? "border-amber-500/40 bg-amber-500 text-black hover:bg-amber-400"
                              : "border-white/10 bg-white/5 text-slate-500 cursor-not-allowed"
                          )}
                        >
                          <UploadCloud className="h-4 w-4" />
                          {state.status === "uploading"
                            ? "Uploading…"
                            : state.status === "registering"
                            ? "Registering…"
                            : state.status === "hashing"
                            ? "Hashing…"
                            : filingMode === "ledger"
                            ? "File into Minute Book + Link"
                            : "File into Minute Book"}
                        </button>
                      </div>
                    </div>
                  </section>

                  {/* Registry Projection */}
                  <section className="col-span-12 lg:col-span-4">
                    <div className="rounded-3xl border border-white/10 bg-black/20 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-slate-200">Registry Projection</div>
                          <div className="text-[11px] text-slate-500">Path + Evidence + Local Preview</div>
                        </div>
                        <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[10px] tracking-[0.18em] uppercase text-slate-200">
                          projection
                        </span>
                      </div>

                      <div className="mt-3 space-y-3">
                        <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
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
                          <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                            <div className="text-[11px] text-slate-400 tracking-wider uppercase">Mode</div>
                            <div className="mt-1 text-sm text-slate-200">
                              {filingMode === "ledger" ? "Linked to Ledger" : "Standalone Archive"}
                            </div>
                            <div className="mt-1 text-[11px] text-slate-500">
                              {filingMode === "ledger"
                                ? selectedLedger
                                  ? `${selectedLedger.title || "Untitled record"} • ${prettyLedgerStatus(selectedLedger.status)}`
                                  : "No governance record selected"
                                : "No source_record_id will be attached"}
                            </div>
                          </div>

                          <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                            <div className="text-[11px] text-slate-400 tracking-wider uppercase">Domain</div>
                            <div className="mt-1 text-sm text-slate-200">
                              {domainKey || "—"}{" "}
                              <span className="text-slate-500">({domainLabel})</span>
                            </div>
                          </div>

                          <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                            <div className="flex items-center gap-2">
                              <FileText className="h-4 w-4 text-amber-300" />
                              <div className="text-[11px] text-slate-400 tracking-wider uppercase">Evidence</div>
                            </div>
                            <div className="mt-2 text-sm text-slate-200">
                              {preview ? preview.file_name : <span className="text-slate-500">No file selected</span>}
                            </div>
                            <div className="mt-2 text-[11px] text-slate-500">
                              SHA-256:{" "}
                              <span className="font-mono text-slate-200">
                                {sha ? `${sha.slice(0, 16)}…${sha.slice(-16)}` : "—"}
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className="rounded-2xl border border-white/10 bg-black/20 overflow-hidden">
                          <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between">
                            <div className="text-xs text-slate-200">Local Preview</div>
                            <div className="text-[11px] text-slate-500">PDF-first</div>
                          </div>
                          <div className="h-[260px] bg-black/10">
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
                          <span className="text-slate-200">supporting_documents</span> didn’t get created for that
                          entry_id.
                          <br />
                          <span className="text-slate-200">
                            This upload page now supports both pristine standalone filings and optional ledger-linked filings.
                          </span>
                        </div>

                        <div className="flex items-center justify-between text-[10px] text-slate-500">
                          <span>Upload is the write entry point.</span>
                          <Link href="/ci-archive/minute-book" className="hover:text-slate-200">
                            Go to Registry →
                          </Link>
                        </div>
                      </div>
                    </div>
                  </section>
                </div>

                <div className="mt-5 rounded-3xl border border-white/10 bg-black/20 px-4 py-3 text-[11px] text-slate-400">
                  <div className="font-semibold text-slate-200">OS behavior</div>
                  <div className="mt-1 leading-relaxed text-slate-400">
                    CI-Archive Upload inherits the OS shell. No module-owned window frames. This surface remains the sole
                    write entry point for Minute Book records. Standalone preserves existing upload behavior; linked mode
                    only adds an optional governance_ledger bridge via source_record_id.
                  </div>
                </div>
              </>
            )}

            <div className="mt-5 flex items-center justify-between text-[10px] text-slate-600">
              <span>CI-Archive · Oasis Digital Parliament</span>
              <span>ODP.AI · Governance Firmware</span>
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            href="/ci-archive"
            className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7"
          >
            CI-Archive
          </Link>
          <Link
            href="/ci-archive/minute-book"
            className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7"
          >
            Minute Book
          </Link>
          <Link
            href="/ci-archive/verified"
            className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7"
          >
            Verified
          </Link>
        </div>
      </div>
    </div>
  );
}