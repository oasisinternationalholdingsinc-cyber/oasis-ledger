// src/app/(console-ledger)/ci-archive/verified/page.tsx
"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";
import {
  ArrowLeft,
  FileText,
  ShieldCheck,
  Search,
  CheckCircle2,
  X,
  ExternalLink,
  Download,
  Copy,
  Loader2,
  Mail,
} from "lucide-react";

type VerifiedRow = {
  id: string;
  entity_id: string | null;
  entity_slug: string | null;
  title: string;
  document_class: string;
  source_table: string | null;
  source_record_id: string | null;
  storage_bucket: string;
  storage_path: string;
  file_hash: string | null;
  envelope_id: string | null;
  signed_at: string | null;
  created_at: string | null;
  verification_level: string;
  is_archived: boolean;

  // derived (joined)
  lane_is_test?: boolean | null;
  ledger_status?: string | null;
};

type Tab = "ALL" | "SIGNED" | "ARCHIVED";

function cx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function shortHash(h: string | null | undefined) {
  if (!h) return "—";
  if (h.length <= 20) return h;
  return `${h.slice(0, 16)}…${h.slice(-16)}`;
}

function normalizeSlashes(s: string) {
  return s.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function looksLikeNotFound(err: unknown) {
  const msg = (err as any)?.message ? String((err as any).message) : "";
  return /not\s*found/i.test(msg) || (/object/i.test(msg) && /not\s*found/i.test(msg));
}

/**
 * ✅ Lane inference for non-ledger sources (UI-only, no schema changes)
 * Promoted Minute Book entries use source_table='minute_book_entries' and do not join governance_ledger.
 * We infer lane from verified_documents.storage_bucket.
 */
function inferLaneFromBucket(bucket?: string | null): boolean | null {
  const b = String(bucket || "").trim();
  if (!b) return null;
  if (b === "governance_sandbox") return true;
  if (b === "governance_truth") return false;
  return null;
}

/**
 * Signed URL helper (kept) — includes mild repair by listing dir & selecting best PDF candidate.
 * NO wiring change: still uses verified_documents.storage_bucket + storage_path as canonical pointers.
 */
async function signedUrlForVerified(bucket: string, path: string, downloadName?: string | null) {
  const p = normalizeSlashes(path).replace(/^\/+/, "");
  const opts: { download?: string } | undefined = downloadName ? { download: downloadName } : undefined;

  // 1) exact path
  {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(p, 60 * 10, opts);
    if (!error && data?.signedUrl) return data.signedUrl;
    if (error && !looksLikeNotFound(error)) throw error;
  }

  // 2) mild repair: try same dir listing and pick a PDF with same prefix
  const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
  const base = p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p;

  const uuidPrefix =
    base.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i)?.[1] ?? null;

  if (!dir) throw new Error(`Object not found in bucket "${bucket}" for "${p}".`);

  const { data: list, error: listErr } = await supabase.storage.from(bucket).list(dir, {
    limit: 200,
    sortBy: { column: "updated_at", order: "desc" },
  });

  if (listErr || !list?.length) throw new Error(`Object not found in bucket "${bucket}" for "${p}".`);

  const pdfs = (list as any[])
    .map((it) => (it?.name ? `${dir}/${it.name}` : null))
    .filter(Boolean) as string[];

  let candidates = pdfs.filter((x) => x.toLowerCase().endsWith(".pdf"));

  if (uuidPrefix) {
    const up = uuidPrefix.toLowerCase();
    candidates = candidates.filter((x) => x.split("/").pop()!.toLowerCase().startsWith(up));
  } else {
    const stem = base.toLowerCase().replace(/\.pdf$/i, "");
    candidates = candidates.filter((x) => x.split("/").pop()!.toLowerCase().includes(stem));
  }

  const best = candidates.find((x) => x.toLowerCase().includes("-signed")) || candidates[0];
  if (!best) throw new Error(`Object not found in bucket "${bucket}" for "${p}".`);

  const { data: data2, error: err2 } = await supabase.storage.from(bucket).createSignedUrl(best, 60 * 10, opts);
  if (err2) throw err2;
  if (!data2?.signedUrl) throw new Error("Signed URL generation failed.");
  return data2.signedUrl;
}

function safeFilename(name: string) {
  const n = String(name || "document")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return n.length ? n : "document";
}

export default function VerifiedRegistryPage() {
  const { activeEntity } = useEntity(); // IMPORTANT: slug/key string (e.g. "holdings")
  const { env } = useOsEnv();
  const laneIsTest = env === "SANDBOX";

  const [entityId, setEntityId] = useState<string | null>(null);
  const [rows, setRows] = useState<VerifiedRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<Tab>("ALL");
  const [q, setQ] = useState("");

  // open state (busy + error)
  const [openBusyId, setOpenBusyId] = useState<string | null>(null);
  const [openErr, setOpenErr] = useState<string | null>(null);

  // ✅ Minute-Book-style Reader Sheet state (NO routing / NO 404)
  const [readerOpen, setReaderOpen] = useState(false);
  const [readerDoc, setReaderDoc] = useState<VerifiedRow | null>(null);

  // ✅ TWO URLS: preview (inline) + download (attachment)
  const [readerUrl, setReaderUrl] = useState<string | null>(null); // iframe preview (no download hint)
  const [readerDownloadUrl, setReaderDownloadUrl] = useState<string | null>(null); // download link (with filename)

  const [readerLoading, setReaderLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  // ✅ Email Verified Copy (Minute Book only)
  const [emailOpen, setEmailOpen] = useState(false);
  const [emailTo, setEmailTo] = useState("");
  const [emailName, setEmailName] = useState("");
  const [emailMsg, setEmailMsg] = useState("");
  const [emailIncludeDownload, setEmailIncludeDownload] = useState(true);

  const [emailSending, setEmailSending] = useState(false);
  const [emailOk, setEmailOk] = useState<string | null>(null);
  const [emailErr, setEmailErr] = useState<string | null>(null);

  const canEmailMinuteBook =
    !!readerDoc &&
    String(readerDoc.source_table || "").trim() === "minute_book_entries" &&
    !!readerDoc.source_record_id;

  function closeReader() {
    setReaderOpen(false);
    setReaderDoc(null);
    setReaderUrl(null);
    setReaderDownloadUrl(null);
    setReaderLoading(false);
    setCopied(false);

    // ✅ also close/clear email modal state (no regression to existing reader behavior)
    setEmailOpen(false);
    setEmailSending(false);
    setEmailOk(null);
    setEmailErr(null);
  }

  async function sendVerifiedCopyEmail() {
    if (!canEmailMinuteBook || !readerDoc) return;

    const to = emailTo.trim();
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      setEmailErr("Enter a valid recipient email.");
      return;
    }

    setEmailErr(null);
    setEmailOk(null);
    setEmailSending(true);

    try {
      const { data, error } = await supabase.functions.invoke("email-minute-book-entry", {
        body: {
          entry_id: readerDoc.source_record_id,
          is_test: laneIsTest, // ✅ lane hint for mismatch guard
          to_email: to,
          to_name: emailName.trim() || null,
          message: emailMsg.trim() || null,
          include_download: !!emailIncludeDownload,
          // expires_in optional (defaults to 10 min in Edge Function)
        },
      });

      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error || "SEND_FAILED");

      setEmailOk(`Sent to ${to}`);
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : "Failed to send email.";
      setEmailErr(msg);
    } finally {
      setEmailSending(false);
    }
  }

  // Resolve entity UUID from entities table using slug (NO CHANGE)
  useEffect(() => {
    let alive = true;

    async function resolveEntity() {
      if (!activeEntity) {
        if (alive) setEntityId(null);
        return;
      }

      const { data, error } = await supabase
        .from("entities")
        .select("id")
        .eq("slug", String(activeEntity))
        .limit(1)
        .maybeSingle();

      if (!alive) return;

      if (error) {
        console.error("resolveEntity error", error);
        setEntityId(null);
        return;
      }

      setEntityId(data?.id ?? null);
    }

    resolveEntity();
    return () => {
      alive = false;
    };
  }, [activeEntity]);

  // Load verified_documents + join lane/status (NO CHANGE to source; just lane-safe fix for non-ledger sources)
  useEffect(() => {
    let alive = true;

    async function load() {
      if (!entityId) {
        setRows([]);
        return;
      }

      setLoading(true);

      const { data: vd, error: vdErr } = await supabase
        .from("verified_documents")
        .select(
          "id,entity_id,entity_slug,title,document_class,source_table,source_record_id,storage_bucket,storage_path,file_hash,envelope_id,signed_at,created_at,verification_level,is_archived"
        )
        .eq("entity_id", entityId)
        .order("created_at", { ascending: false })
        .limit(300);

      if (!alive) return;

      if (vdErr) {
        console.error("verified_documents load error", vdErr);
        setRows([]);
        setLoading(false);
        return;
      }

      // ✅ Only join governance_ledger for rows that actually reference it.
      // Historical compatibility: treat null/empty source_table as ledger-backed.
      const ledgerBacked = (vd ?? []).filter((r: any) => {
        const st = String(r.source_table ?? "").trim();
        return !st || st === "governance_ledger";
      });

      const recordIds = ledgerBacked.map((r: any) => r.source_record_id).filter(Boolean) as string[];

      const laneMap = new Map<string, { is_test: boolean; status: string }>();

      if (recordIds.length) {
        const { data: gl, error: glErr } = await supabase
          .from("governance_ledger")
          .select("id,is_test,status")
          .in("id", recordIds);

        if (!glErr && gl) {
          for (const r of gl as any[]) {
            laneMap.set(r.id, { is_test: !!r.is_test, status: String(r.status ?? "") });
          }
        }
      }

      const merged: VerifiedRow[] = (vd ?? []).map((r: any) => {
        const st = String(r.source_table ?? "").trim();
        const isLedgerBacked = !st || st === "governance_ledger";

        const m = isLedgerBacked && r.source_record_id ? laneMap.get(r.source_record_id) : null;

        // ✅ If not ledger-backed (e.g., minute_book_entries promotion), infer lane from storage bucket
        const inferredLane = !isLedgerBacked ? inferLaneFromBucket(r.storage_bucket) : null;

        return {
          ...(r as VerifiedRow),
          lane_is_test: m?.is_test ?? inferredLane ?? null,
          ledger_status: m?.status ?? null,
        };
      });

      // ✅ Lane filter (NOW safe for promoted docs too)
      const laneFiltered = merged.filter((r) => {
        if (r.lane_is_test === null || r.lane_is_test === undefined) return true;
        return r.lane_is_test === laneIsTest;
      });

      setRows(laneFiltered);
      setLoading(false);
    }

    load();
    return () => {
      alive = false;
    };
  }, [entityId, laneIsTest]);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();

    return rows.filter((r) => {
      if (tab === "SIGNED" && !r.signed_at) return false;
      if (tab === "ARCHIVED" && !r.is_archived) return false;

      if (!qq) return true;
      const hay = `${r.title} ${r.document_class} ${r.storage_path} ${r.file_hash ?? ""}`.toLowerCase();
      return hay.includes(qq);
    });
  }, [rows, tab, q]);

  /**
   * ✅ Open Verified -> Reader Sheet (iPhone-first)
   * ✅ preview uses inline URL (no download disposition) so iframe renders.
   * ✅ Download uses attachment URL (with filename).
   * NO routing. NO 404 pages.
   */
  async function openVerified(r: VerifiedRow) {
    setOpenErr(null);
    setOpenBusyId(r.id);
    setCopied(false);

    try {
      const bucket = String(r.storage_bucket || "").trim();
      const path = String(r.storage_path || "").trim();
      if (!bucket || !path) throw new Error("Missing storage_bucket/storage_path on verified record.");

      const name = `${safeFilename(r.title || "document")}.pdf`;

      setReaderDoc(r);
      setReaderOpen(true);
      setReaderLoading(true);
      setReaderUrl(null);
      setReaderDownloadUrl(null);

      // ✅ reset email modal state per-open (no surprises)
      setEmailOpen(false);
      setEmailSending(false);
      setEmailOk(null);
      setEmailErr(null);

      // ✅ preview URL (NO download hint) => iframe renders
      const previewUrl = await signedUrlForVerified(bucket, path, null);

      // ✅ download URL (with filename) => Download button is consistent
      const dlUrl = await signedUrlForVerified(bucket, path, name);

      setReaderUrl(previewUrl);
      setReaderDownloadUrl(dlUrl);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to open verified document.";
      setOpenErr(msg);
      setReaderOpen(false);
      setReaderDoc(null);
      setReaderUrl(null);
      setReaderDownloadUrl(null);
    } finally {
      setReaderLoading(false);
      setOpenBusyId(null);
    }
  }

  function openInNewTab() {
    if (!readerUrl) return;
    window.open(readerUrl, "_blank", "noopener,noreferrer");
  }

  function downloadNow() {
    if (!readerDownloadUrl || !readerDoc) return;

    const a = document.createElement("a");
    a.href = readerDownloadUrl;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.download = `${safeFilename(readerDoc.title || "document")}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function copyLink() {
    if (!readerUrl) return;
    try {
      await navigator.clipboard.writeText(readerUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  // OS shell/header/body pattern (MATCH CI-ARCHIVE launchpad + Upload)
  const shell =
    "rounded-3xl border border-white/10 bg-black/20 shadow-[0_28px_120px_rgba(0,0,0,0.55)] overflow-hidden";
  const header =
    "border-b border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent px-4 sm:px-6 py-4 sm:py-5";
  const body = "px-4 sm:px-6 py-5 sm:py-6";

  return (
    <div className="w-full">
      <div className="mx-auto w-full max-w-[1200px] px-4 pb-10 pt-4 sm:pt-6">
        <div className={shell}>
          {/* OS-aligned header */}
          <div className={header}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10px] sm:text-xs tracking-[0.3em] uppercase text-slate-500">CI • Archive</div>
                <h1 className="mt-1 text-lg sm:text-xl font-semibold text-slate-50">Verified Registry</h1>
                <p className="mt-1 max-w-3xl text-[11px] sm:text-xs text-slate-400 leading-relaxed">
                  Certified outputs ready for public trust surfaces. Read-only. Lane-safe. Entity-scoped.
                </p>

                <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-400">
                  <span className="inline-flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-emerald-300" />
                    <span>Registry surface • No destructive actions</span>
                  </span>
                  <span className="text-slate-700">•</span>
                  <span>
                    Lane:{" "}
                    <span className={cx("font-semibold", laneIsTest ? "text-amber-300" : "text-sky-300")}>
                      {laneIsTest ? "SANDBOX" : "RoT"}
                    </span>
                  </span>
                  <span className="text-slate-700">•</span>
                  <span>
                    Entity: <span className="text-emerald-300 font-medium">{String(activeEntity ?? "—")}</span>
                  </span>
                </div>
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
              </div>
            </div>
          </div>

          <div className={body}>
            {openErr ? (
              <div className="mb-4 rounded-2xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-[11px] text-red-200">
                {openErr}
              </div>
            ) : null}

            {/* iPhone-first surface: stacks; desktop: 3 columns */}
            <div className="grid grid-cols-12 gap-4">
              {/* LEFT: Filters */}
              <section className="col-span-12 lg:col-span-3">
                <div className="rounded-3xl border border-white/10 bg-black/20 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-200">Filters</div>
                      <div className="text-[11px] text-slate-500">View + search</div>
                    </div>
                    <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[10px] tracking-[0.18em] uppercase text-slate-200">
                      filters
                    </span>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {(["ALL", "SIGNED", "ARCHIVED"] as Tab[]).map((t) => (
                      <button
                        key={t}
                        onClick={() => setTab(t)}
                        className={cx(
                          "rounded-full border px-3 py-1 text-xs transition",
                          tab === t
                            ? "border-amber-400/40 bg-amber-400/10 text-amber-100"
                            : "border-white/10 bg-white/5 text-slate-200/80 hover:bg-white/7"
                        )}
                      >
                        {t}
                      </button>
                    ))}
                  </div>

                  <div className="mt-4">
                    <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">Search</div>
                    <div className="mt-2 relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                      <input
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder="title, hash, path..."
                        className="w-full rounded-2xl border border-white/10 bg-white/5 pl-10 pr-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-500 focus:border-amber-400/30"
                      />
                    </div>
                  </div>

                  <div className="mt-4 text-xs text-slate-400">{loading ? "Loading…" : `${filtered.length} result(s)`}</div>

                  <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 p-3 text-xs text-slate-400">
                    Lane-safe: ledger-backed docs gate by{" "}
                    <span className="text-slate-200">governance_ledger.is_test</span>; promoted docs gate by{" "}
                    <span className="text-slate-200">storage_bucket</span>.
                  </div>
                </div>
              </section>

              {/* MIDDLE: Documents */}
              <section className="col-span-12 lg:col-span-6">
                <div className="rounded-3xl border border-white/10 bg-black/20 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-200">Documents</div>
                      <div className="text-[11px] text-slate-500">Certified outputs</div>
                    </div>
                    <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[10px] tracking-[0.18em] uppercase text-slate-200">
                      registry
                    </span>
                  </div>

                  <div className="mt-3 space-y-2">
                    {filtered.length === 0 ? (
                      <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-slate-400">
                        {loading ? "Loading registry…" : "No documents match this view."}
                      </div>
                    ) : (
                      filtered.map((r) => (
                        <div
                          key={r.id}
                          className="rounded-3xl border border-white/10 bg-black/20 p-3 hover:bg-black/25 transition"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-sm font-medium text-slate-100 truncate">{r.title}</div>
                              <div className="mt-1 text-xs text-slate-400">
                                {r.document_class} · {r.verification_level}
                                {r.ledger_status ? ` · Ledger: ${r.ledger_status}` : ""}
                              </div>
                              <div className="mt-2 font-mono break-all text-[11px] text-slate-500">{r.storage_path}</div>

                              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                                <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1">
                                  <FileText className="h-4 w-4 text-amber-300" />
                                  <span className="text-slate-200">{r.storage_bucket}</span>
                                </span>

                                <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1">
                                  <CheckCircle2 className="h-4 w-4 text-emerald-300" />
                                  <span className="text-slate-200">{r.is_archived ? "ARCHIVED" : "VERIFIED"}</span>
                                </span>

                                <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1">
                                  <span className="text-slate-500">hash:</span>
                                  <span className="font-mono text-slate-200">{shortHash(r.file_hash)}</span>
                                </span>
                              </div>
                            </div>

                            <div className="flex flex-col items-end gap-2 shrink-0">
                              <span
                                className={cx(
                                  "rounded-full border px-2 py-1 text-[11px]",
                                  r.signed_at
                                    ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100"
                                    : "border-white/10 bg-white/5 text-slate-400"
                                )}
                              >
                                {r.signed_at ? "SIGNED" : "DRAFT"}
                              </span>

                              <button
                                type="button"
                                onClick={() => openVerified(r)}
                                disabled={openBusyId === r.id}
                                className={cx(
                                  "rounded-full border px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase transition",
                                  openBusyId === r.id
                                    ? "border-white/10 bg-white/5 text-slate-500 cursor-not-allowed"
                                    : "border-amber-400/20 bg-amber-400/10 text-amber-100 hover:bg-amber-400/15"
                                )}
                                title="Open verified PDF (Reader Sheet)"
                              >
                                {openBusyId === r.id ? "Opening…" : "Open →"}
                              </button>
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </section>

              {/* RIGHT: Guidance */}
              <section className="col-span-12 lg:col-span-3">
                <div className="rounded-3xl border border-white/10 bg-black/20 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-200">Validity path</div>
                      <div className="text-[11px] text-slate-500">How outputs become certified</div>
                    </div>
                    <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[10px] tracking-[0.18em] uppercase text-slate-200">
                      guide
                    </span>
                  </div>

                  <div className="mt-3 space-y-3 text-sm text-slate-300">
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                      1) Council approves → <span className="text-slate-200">approved_by_council = true</span>
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                      2) Forge completes envelope →{" "}
                      <span className="text-slate-200">signature_envelopes.status = completed</span>
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                      3) Seal/Archive (service role) → writes{" "}
                      <span className="text-slate-200">verified_documents</span> + minute book evidence
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                      4) verify_governance_archive(record_id) → VALID
                    </div>
                  </div>

                  <div className="mt-4 text-[11px] text-slate-500 leading-relaxed">
                    Verified is read-only. Use Council/Forge for execution and Archive for sealing. This surface is the trust
                    registry.
                  </div>
                </div>
              </section>
            </div>

            {/* OS behavior footnote (matches launchpads) */}
            <div className="mt-5 rounded-3xl border border-white/10 bg-black/20 px-4 py-3 text-[11px] text-slate-400">
              <div className="font-semibold text-slate-200">OS behavior</div>
              <div className="mt-1 leading-relaxed text-slate-400">
                CI-Archive Verified inherits the OS shell. No module-owned window frames. Lane-safe and entity-scoped.
              </div>
            </div>

            <div className="mt-5 flex items-center justify-between text-[10px] text-slate-600">
              <span>CI-Archive · Oasis Digital Parliament</span>
              <span>ODP.AI · Governance Firmware</span>
            </div>
          </div>
        </div>

        {/* optional quick links row (same grammar as Archive launchpad) */}
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
            href="/ci-archive/upload"
            className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7"
          >
            Upload
          </Link>
        </div>
      </div>

      {/* ✅ Reader Sheet (iPhone-first, desktop centered) */}
      {readerOpen ? (
        <div className="fixed inset-0 z-[80]">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-md" onClick={closeReader} aria-hidden="true" />
          <div className="absolute inset-0 p-0 sm:p-6 flex items-end sm:items-center justify-center">
            <div className="w-full sm:max-w-[980px] h-[92vh] sm:h-[88vh] rounded-none sm:rounded-3xl border border-white/10 bg-black/30 shadow-[0_28px_120px_rgba(0,0,0,0.65)] overflow-hidden relative">
              <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3 border-b border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent">
                <div className="min-w-0">
                  <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">Verified • Reader</div>
                  <div className="mt-0.5 text-sm sm:text-base font-semibold text-slate-100 truncate">
                    {readerDoc?.title ?? "Document"}
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-400 truncate">
                    {readerDoc?.storage_bucket ?? "—"} · {readerDoc?.document_class ?? "—"}
                  </div>
                </div>

                <div className="shrink-0 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={copyLink}
                    disabled={!readerUrl}
                    className={cx(
                      "rounded-full border px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase inline-flex items-center gap-2 transition",
                      !readerUrl
                        ? "border-white/10 bg-white/5 text-slate-500 cursor-not-allowed"
                        : copied
                        ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100"
                        : "border-white/10 bg-white/5 text-slate-200 hover:bg-white/7"
                    )}
                    title="Copy signed link"
                  >
                    <Copy className="h-4 w-4" />
                    {copied ? "Copied" : "Copy"}
                  </button>

                  <button
                    type="button"
                    onClick={openInNewTab}
                    disabled={!readerUrl}
                    className={cx(
                      "rounded-full border px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase inline-flex items-center gap-2 transition",
                      !readerUrl
                        ? "border-white/10 bg-white/5 text-slate-500 cursor-not-allowed"
                        : "border-white/10 bg-white/5 text-slate-200 hover:bg-white/7"
                    )}
                    title="Open in new tab"
                  >
                    <ExternalLink className="h-4 w-4" />
                    Open
                  </button>

                  <button
                    type="button"
                    onClick={downloadNow}
                    disabled={!readerDownloadUrl}
                    className={cx(
                      "rounded-full border px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase inline-flex items-center gap-2 transition",
                      !readerDownloadUrl
                        ? "border-white/10 bg-white/5 text-slate-500 cursor-not-allowed"
                        : "border-amber-400/20 bg-amber-400/10 text-amber-100 hover:bg-amber-400/15"
                    )}
                    title="Download PDF"
                  >
                    <Download className="h-4 w-4" />
                    Download
                  </button>

                  {/* ✅ Email (Minute Book verified records only) */}
                  <button
                    type="button"
                    onClick={() => {
                      setEmailOpen(true);
                      setEmailOk(null);
                      setEmailErr(null);
                      setEmailTo("");
                      setEmailName("");
                      setEmailMsg("");
                      setEmailIncludeDownload(true);
                    }}
                    disabled={!canEmailMinuteBook}
                    className={cx(
                      "rounded-full border px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase inline-flex items-center gap-2 transition",
                      !canEmailMinuteBook
                        ? "border-white/10 bg-white/5 text-slate-500 cursor-not-allowed"
                        : "border-white/10 bg-white/5 text-slate-200 hover:bg-white/7"
                    )}
                    title={
                      canEmailMinuteBook ? "Email verified copy" : "Email is available for Minute Book verified records only"
                    }
                  >
                    <Mail className="h-4 w-4" />
                    Email
                  </button>

                  <button
                    type="button"
                    onClick={closeReader}
                    className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7 inline-flex items-center gap-2"
                    title="Close"
                  >
                    <X className="h-4 w-4" />
                    Close
                  </button>
                </div>
              </div>

              <div className="h-[calc(100%-56px)] sm:h-[calc(100%-60px)] bg-black/20">
                {readerLoading ? (
                  <div className="h-full w-full flex items-center justify-center text-slate-300">
                    <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-black/20 px-4 py-3">
                      <Loader2 className="h-5 w-5 animate-spin text-amber-300" />
                      <span className="text-sm">Generating secure preview…</span>
                    </div>
                  </div>
                ) : readerUrl ? (
                  <iframe key={readerUrl} src={readerUrl} className="h-full w-full" title="Verified PDF Preview" />
                ) : (
                  <div className="h-full w-full flex items-center justify-center text-slate-400">
                    <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm">
                      Preview unavailable. Try “Open” or “Download”.
                    </div>
                  </div>
                )}
              </div>

              {/* ✅ Email Modal (inside Reader, UI-only) */}
              {emailOpen ? (
                <div className="absolute inset-0 z-[90]">
                  <div
                    className="absolute inset-0 bg-black/60 backdrop-blur-sm"
                    onClick={() => setEmailOpen(false)}
                    aria-hidden="true"
                  />
                  <div className="absolute inset-0 p-4 sm:p-6 flex items-end sm:items-center justify-center">
                    <div className="w-full sm:max-w-[720px] rounded-3xl border border-white/10 bg-black/40 shadow-[0_28px_120px_rgba(0,0,0,0.65)] overflow-hidden">
                      <div className="px-4 sm:px-5 py-4 border-b border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent">
                        <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">Email • Verified Copy</div>
                        <div className="mt-1 text-sm sm:text-base font-semibold text-slate-100 truncate">
                          {readerDoc?.title ?? "Document"}
                        </div>
                        <div className="mt-1 text-[11px] text-slate-400">
                          Sends hash-first verification link (+ optional time-limited download)
                        </div>
                      </div>

                      <div className="p-4 sm:p-5 space-y-3">
                        {emailErr ? (
                          <div className="rounded-2xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-[11px] text-red-200">
                            {emailErr}
                          </div>
                        ) : null}
                        {emailOk ? (
                          <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-200">
                            {emailOk}
                          </div>
                        ) : null}

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">To Email</div>
                            <input
                              value={emailTo}
                              onChange={(e) => setEmailTo(e.target.value)}
                              placeholder="recipient@domain.com"
                              className="mt-2 w-full rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-500 focus:border-amber-400/30"
                            />
                          </div>

                          <div>
                            <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">Recipient Name</div>
                            <input
                              value={emailName}
                              onChange={(e) => setEmailName(e.target.value)}
                              placeholder="Optional"
                              className="mt-2 w-full rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-500 focus:border-amber-400/30"
                            />
                          </div>
                        </div>

                        <div>
                          <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">Message</div>
                          <textarea
                            value={emailMsg}
                            onChange={(e) => setEmailMsg(e.target.value)}
                            placeholder="Optional note to include above the hash + QR…"
                            rows={4}
                            className="mt-2 w-full rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-500 focus:border-amber-400/30 resize-none"
                          />
                        </div>

                        <label className="flex items-center gap-2 text-sm text-slate-300">
                          <input
                            type="checkbox"
                            checked={emailIncludeDownload}
                            onChange={(e) => setEmailIncludeDownload(e.target.checked)}
                            className="h-4 w-4"
                          />
                          <span>Include time-limited download link</span>
                        </label>

                        <div className="pt-1 flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => setEmailOpen(false)}
                            className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7"
                          >
                            Cancel
                          </button>

                          <button
                            type="button"
                            onClick={sendVerifiedCopyEmail}
                            disabled={emailSending || !canEmailMinuteBook}
                            className={cx(
                              "rounded-full border px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase inline-flex items-center gap-2 transition",
                              emailSending || !canEmailMinuteBook
                                ? "border-white/10 bg-white/5 text-slate-500 cursor-not-allowed"
                                : "border-amber-400/20 bg-amber-400/10 text-amber-100 hover:bg-amber-400/15"
                            )}
                          >
                            {emailSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                            {emailSending ? "Sending…" : "Send"}
                          </button>
                        </div>

                        {!canEmailMinuteBook ? (
                          <div className="text-[11px] text-slate-500">
                            Email is enabled for promoted Minute Book verified records only.
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
