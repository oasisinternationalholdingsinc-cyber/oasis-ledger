// src/app/(os)/ci-archive/page.tsx
"use client";

import { useEffect, useMemo, useState, FormEvent } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity, EntityKey } from "@/components/OsEntityContext";

type ViewMode = "minute_book" | "verified";

type ArchiveEntry = {
  id: string;
  entity_key?: string | null;
  entry_date: string | null;
  entry_type: string | null;
  title: string | null;
  notes: string | null;
  file_name: string | null;
  section_name: string | null;
  storage_path: string | null;
  created_at: string | null;

  // verification / hash (mostly for verified view)
  is_verified?: boolean;
  verification_level?: string | null;
  document_class?: string | null;
  envelope_id?: string | null;
  verify_url?: string | null;
  file_hash?: string | null;
};

type GetSignedDocumentResponse = {
  ok: boolean;
  signed_url?: string;
  error?: string;
};

type VerifyStatus = {
  valid: boolean;
  reason?: string | null;
  status?: string | null;
  hash_match?: boolean | null;
};

const ENTITY_LABELS: Record<EntityKey, string> = {
  holdings: "Oasis International Holdings Inc.",
  lounge: "Oasis International Lounge Inc.",
  "real-estate": "Oasis International Real Estate Inc.",
};

// 🔐 Exact folder set from minute_book bucket / storage-init
const SECTION_DEFS = [
  { id: "all", label: "All sections", icon: "🗂️" },
  { id: "AnnualReturns", label: "Annual Returns", icon: "📅" },
  { id: "ByLaws", label: "By-Laws", icon: "📜" },
  { id: "Certificates", label: "Certificates", icon: "🎖️" },
  { id: "Compliance", label: "Compliance", icon: "⚖️" },
  { id: "ComplianceReviews", label: "Compliance Reviews", icon: "📝" },
  { id: "DirectorRegisters", label: "Director Registers", icon: "📘" },
  { id: "GovernanceMemos", label: "Governance Memos", icon: "💼" },
  { id: "Incorporation", label: "Incorporation", icon: "🏛️" },
  { id: "OfficerRegisters", label: "Officer Registers", icon: "📒" },
  { id: "Resolutions", label: "Resolutions", icon: "📘" },
  { id: "SpecialResolutions", label: "Special Resolutions", icon: "📗" },
  { id: "ShareCertificates", label: "Share Certificates", icon: "🪪" },
  { id: "ShareRegisters", label: "Share Registers", icon: "📚" },
  { id: "SupportingDocs", label: "Supporting Documents", icon: "📎" },
  { id: "Templates", label: "Templates", icon: "🧩" },
  { id: "AI_Advice", label: "AI – Advice", icon: "🤖" },
  { id: "AI_Summaries", label: "AI – Summaries", icon: "🧠" },
];

const MINUTE_BOOK_BUCKET =
  process.env.NEXT_PUBLIC_MINUTE_BOOK_BUCKET ?? "minute_book";

export default function CIArchivePage() {
  const { activeEntity } = useEntity();

  const [viewMode, setViewMode] = useState<ViewMode>("minute_book");
  const [activeSectionId, setActiveSectionId] = useState<string>("all");

  const [entries, setEntries] = useState<ArchiveEntry[]>([]);
  const [loadingEntries, setLoadingEntries] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<ArchiveEntry | null>(null);

  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);
  const [isOpening, setIsOpening] = useState(false);

  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [verifyLoading, setVerifyLoading] = useState(false);
  const [verifyStatus, setVerifyStatus] = useState<VerifyStatus | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  // Upload modal state
  const [showUpload, setShowUpload] = useState(false);
  const [uploadSection, setUploadSection] = useState<string>("Resolutions");
  const [uploadTitle, setUploadTitle] = useState<string>("");
  const [uploadNotes, setUploadNotes] = useState<string>("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Auth guard
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const checkAuth = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) window.location.href = "/login";
    };
    checkAuth();
  }, []);

  const activeEntityLabel = useMemo(
    () => ENTITY_LABELS[activeEntity] ?? "",
    [activeEntity],
  );

  // ---------------------------------------------------------------------------
  // Load entries for active entity + mode (+ folder for minute_book)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const fetchEntries = async () => {
      setLoadingEntries(true);
      setError("");
      setSuccess("");
      setVerifyError(null);
      setVerifyStatus(null);

      try {
        if (viewMode === "minute_book") {
          let query = supabase
            .from("minute_book_entries")
            .select(
              [
                "id",
                "entity_key",
                "entry_date",
                "entry_type",
                "title",
                "notes",
                "file_name",
                "section_name",
                "storage_path",
                "created_at",
              ].join(", "),
            )
            .eq("entity_key", activeEntity)
            .order("entry_date", { ascending: false });

          const activeSection = SECTION_DEFS.find(
            (s) => s.id === activeSectionId,
          );

          if (activeSection && activeSection.id !== "all") {
            query = query.eq("section_name", activeSection.id);
          }

          const { data, error } = await query;

          console.log("CI-Archive minute_book_entries", { data, error });

          if (error) {
            console.error("Minute book load error", error);
            setEntries([]);
            setError("Unable to load minute book for this entity.");
            setLoadingEntries(false);
            return;
          }

          const rows = (data ?? []) as any[];

          const mapped: ArchiveEntry[] = rows.map((row) => ({
            id: row.id,
            entity_key: row.entity_key,
            entry_date: row.entry_date,
            entry_type: row.entry_type,
            title: row.title,
            notes: row.notes,
            file_name: row.file_name,
            section_name: row.section_name,
            storage_path: row.storage_path,
            created_at: row.created_at,
            is_verified: false,
          }));

          setEntries(mapped);

          if (mapped.length > 0) {
            setSelectedEntryId(mapped[0].id);
            setSelectedEntry(mapped[0]);
          } else {
            setSelectedEntryId(null);
            setSelectedEntry(null);
            setViewerUrl(null);
          }
        } else {
          // VERIFIED MODE – v_verified_documents
          const { data, error } = await supabase
            .from("v_verified_documents")
            .select(
              [
                "id",
                "entity_id",
                "entity_slug",
                "entity_name",
                "title",
                "document_class",
                "storage_path",
                "file_hash",
                "verification_level",
                "envelope_id",
                "verify_url",
                "signed_at",
                "created_at",
              ].join(", "),
            )
            .eq("entity_slug", activeEntity)
            .order("signed_at", { ascending: false })
            .order("created_at", { ascending: false });

          console.log("CI-Archive v_verified_documents", { data, error });

          if (error) {
            console.error("Verified docs load error", error);
            setEntries([]);
            setError("Unable to load verified documents for this entity.");
            setLoadingEntries(false);
            return;
          }

          const rows = (data ?? []) as any[];

          const mapped: ArchiveEntry[] = rows.map((row) => {
            const storagePath: string | null = row.storage_path ?? null;
            const fileName =
              storagePath && storagePath.includes("/")
                ? storagePath.split("/").slice(-1)[0]
                : storagePath;

            return {
              id: row.id,
              entity_key: row.entity_slug,
              entry_date: row.signed_at ?? row.created_at,
              entry_type: row.document_class,
              title: row.title ?? "Signed document",
              notes: null,
              file_name: fileName,
              section_name: row.document_class,
              storage_path: storagePath,
              created_at: row.created_at,
              file_hash: row.file_hash ?? null,
              is_verified: true,
              verification_level: row.verification_level ?? null,
              document_class: row.document_class ?? null,
              envelope_id: row.envelope_id ?? null,
              verify_url: row.verify_url ?? null,
            };
          });

          setEntries(mapped);

          if (mapped.length > 0) {
            setSelectedEntryId(mapped[0].id);
            setSelectedEntry(mapped[0]);
          } else {
            setSelectedEntryId(null);
            setSelectedEntry(null);
            setViewerUrl(null);
          }
        }
      } catch (err) {
        console.error("Error loading archive entries", err);
        setEntries([]);
        setError("Unable to load archive for this entity.");
      } finally {
        setLoadingEntries(false);
      }
    };

    fetchEntries();
  }, [activeEntity, activeSectionId, viewMode, reloadKey]);

  // Auto-load viewer whenever the selected entry changes
  useEffect(() => {
    if (selectedEntry && selectedEntry.storage_path) {
      void handleOpenInViewer(selectedEntry);
    } else {
      setViewerUrl(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEntry?.id, selectedEntry?.storage_path]);

  const formattedDate = (iso: string | null | undefined) => {
    if (!iso) return "—";
    try {
      const d = new Date(iso);
      return d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
      });
    } catch {
      return iso;
    }
  };

  const formattedDateTime = (iso: string | null | undefined) => {
    if (!iso) return "—";
    try {
      const d = new Date(iso);
      return d.toLocaleString();
    } catch {
      return iso;
    }
  };

  const truncateHash = (hash: string | null | undefined) => {
    if (!hash) return null;
    const h = String(hash);
    if (h.length <= 18) return h;
    return `${h.slice(0, 10)}…${h.slice(-6)}`;
  };

  const handleCopyHash = async (hash: string | null | undefined) => {
    if (!hash) return;
    try {
      await navigator.clipboard.writeText(hash);
    } catch (e) {
      console.error("Failed to copy hash", e);
    }
  };

  // ---------------------------------------------------------------------------
  // Ensure signed URL (viewer + new tab)
  // ---------------------------------------------------------------------------
  const ensureSignedUrl = async (
    entry: ArchiveEntry,
  ): Promise<string | null> => {
    if (!entry.storage_path) {
      setError("No storage path found for this entry.");
      return null;
    }

    setIsOpening(true);
    setViewerLoading(true);
    setError("");
    setSuccess("");

    try {
      const { data, error } =
        await supabase.functions.invoke<GetSignedDocumentResponse>(
          "get-signed-document-url",
          {
            body: {
              bucket: MINUTE_BOOK_BUCKET,
              storage_path: entry.storage_path,
            },
          },
        );

      console.log("get-signed-document-url result", { data, error });

      if (error) throw new Error(error.message ?? "Edge function error");
      if (!data?.ok || !data.signed_url) {
        throw new Error(
          data?.error ?? "No signed URL was returned for this document.",
        );
      }

      setViewerUrl(data.signed_url);
      setSuccess("Signed URL generated from minute_book storage.");
      return data.signed_url;
    } catch (err: any) {
      console.error("Failed to get signed URL", err);
      setError(
        err?.message ??
          "Failed to open this document. Please try again or verify storage path.",
      );
      setViewerUrl(null);
      return null;
    } finally {
      setIsOpening(false);
      setViewerLoading(false);
    }
  };

  const handleOpenInViewer = async (entry: ArchiveEntry | null) => {
    if (!entry) return;
    await ensureSignedUrl(entry);
  };

  const handleOpenInNewTab = async (entry: ArchiveEntry | null) => {
    if (!entry) return;
    let url = viewerUrl;
    if (!url) {
      url = await ensureSignedUrl(entry);
    }
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  };

  // ---------------------------------------------------------------------------
  // Verify selected (verified mode)
  // ---------------------------------------------------------------------------
  const handleVerifySelected = async () => {
    if (!selectedEntry) return;

    setVerifyLoading(true);
    setVerifyError(null);
    setVerifyStatus(null);

    try {
      const envelopeId = selectedEntry.envelope_id;
      const verifyUrl = selectedEntry.verify_url;

      if (!envelopeId && verifyUrl) {
        window.open(verifyUrl, "_blank", "noopener,noreferrer");
        setVerifyLoading(false);
        return;
      }

      if (!envelopeId) {
        setVerifyError(
          "This document is marked as verified, but no verification envelope is linked.",
        );
        setVerifyLoading(false);
        return;
      }

      const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace("/rest/v1", "");
      if (!base) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL env var.");

      const res = await fetch(
        `${base}/functions/v1/verify-certificate?envelope_id=${encodeURIComponent(
          envelopeId,
        )}`,
        { method: "GET" },
      );

      const data = await res.json();

      if (!res.ok || !data?.ok) {
        setVerifyError(
          data?.error ??
            "Verification failed. The certificate function returned an error.",
        );
      } else {
        const status: VerifyStatus = {
          valid: !!data.valid,
          reason: data.reason ?? null,
          status: data.status ?? null,
          hash_match:
            typeof data.hash_match === "boolean"
              ? data.hash_match
              : null,
        };
        setVerifyStatus(status);
      }
    } catch (e: any) {
      console.error(e);
      setVerifyError(e?.message ?? "Unexpected verification error.");
    } finally {
      setVerifyLoading(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Upload to minute_book
  // ---------------------------------------------------------------------------
  const openUploadModal = () => {
    const fallbackSection =
      selectedEntry?.section_name && selectedEntry.section_name !== "all"
        ? selectedEntry.section_name
        : activeSectionId !== "all"
          ? activeSectionId
          : "Resolutions";

    setUploadSection(fallbackSection);
    setUploadTitle("");
    setUploadNotes("");
    setUploadFile(null);
    setUploadError(null);
    setShowUpload(true);
  };

  const handleUpload = async (e: FormEvent) => {
    e.preventDefault();
    setUploadError(null);

    if (!uploadFile) {
      setUploadError("Please select a file to upload.");
      return;
    }
    if (uploadSection === "all") {
      setUploadError("Please select a specific section.");
      return;
    }

    setUploading(true);

    try {
      const entityKey = activeEntity as EntityKey;
      const ts = Date.now();
      const safeName = uploadFile.name.replace(/\s+/g, "-").toLowerCase();

      const storagePath = `${entityKey}/${uploadSection}/${ts}-${safeName}`;

      const { error: uploadErr } = await supabase.storage
        .from(MINUTE_BOOK_BUCKET)
        .upload(storagePath, uploadFile);

      if (uploadErr) {
        console.error(uploadErr);
        setUploadError(uploadErr.message);
        setUploading(false);
        return;
      }

      const entryDate = new Date().toISOString().slice(0, 10);
      const titleToUse = uploadTitle.trim() || uploadFile.name;

      const { error: insertErr } = await supabase
        .from("minute_book_entries")
        .insert([
          {
            entity_key: activeEntity,
            entry_date: entryDate,
            title: titleToUse,
            notes: uploadNotes || null,
            section_name: uploadSection,
            storage_path: storagePath,
            source: "manual_upload",
          },
        ]);

      if (insertErr) {
        console.error(insertErr);
        setUploadError(insertErr.message);
        setUploading(false);
        return;
      }

      setShowUpload(false);
      setUploading(false);
      setSuccess("Document uploaded into minute book.");
      setReloadKey((k) => k + 1);
    } catch (err: any) {
      console.error(err);
      setUploadError(err?.message ?? "Unexpected error during upload.");
      setUploading(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Render helpers – folder tree & rows
  // ---------------------------------------------------------------------------
  const renderFolderButton = (section: (typeof SECTION_DEFS)[number]) => {
    const active = section.id === activeSectionId;
    const count =
      section.id === "all"
        ? entries.length
        : entries.filter((e) => e.section_name === section.id).length;

    return (
      <button
        key={section.id}
        type="button"
        onClick={() => {
          setActiveSectionId(section.id);
          setSuccess("");
          setError("");
        }}
        className={[
          "flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-[11px] transition",
          active
            ? "bg-emerald-500/15 border border-emerald-400/70 text-emerald-100 shadow-[0_0_0_1px_rgba(52,211,153,0.6)]"
            : "bg-slate-950/40 border border-slate-800 hover:bg-slate-900/70 hover:border-slate-600",
        ].join(" ")}
      >
        <span className="flex items-center gap-2">
          <span className="text-base leading-none">{section.icon}</span>
          <span className="truncate">{section.label}</span>
        </span>
        <span className="rounded-full bg-slate-900/70 px-2 py-0.5 text-[10px] text-slate-400">
          {count}
        </span>
      </button>
    );
  };

  const renderEntryRow = (entry: ArchiveEntry) => {
    const active = entry.id === selectedEntryId;
    const isVerified =
      viewMode === "verified" || !!entry.is_verified || !!entry.verification_level;

    return (
      <button
        key={entry.id}
        type="button"
        onClick={() => {
          setSelectedEntryId(entry.id);
          setSelectedEntry(entry);
          setError("");
          setSuccess("");
          setVerifyError(null);
          setVerifyStatus(null);
        }}
        className={[
          "group flex w-full flex-col border-b border-slate-900 px-3 py-3 text-left last:border-b-0",
          active
            ? "bg-slate-900/90 shadow-[0_0_0_1px_rgba(56,189,248,0.6)]"
            : "hover:bg-slate-900/60",
        ].join(" ")}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col">
            <span className="text-xs font-semibold text-slate-100 line-clamp-2">
              {entry.title || entry.file_name || "Untitled document"}
            </span>
            <span className="mt-1 flex items-center gap-2 text-[11px] text-slate-400">
              <span>{entry.section_name || entry.document_class || "Unsectioned"}</span>
              <span className="h-1 w-1 rounded-full bg-slate-600" />
              <span className="text-slate-500">
                {formattedDate(entry.entry_date ?? entry.created_at)}
              </span>
            </span>
          </div>
          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-2">
              <span className="rounded-full border border-sky-400/70 bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold text-sky-100">
                {entry.entry_type || entry.document_class || "Record"}
              </span>
              {isVerified && (
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/60 bg-emerald-500/10 px-2 py-0.5 text-[9px] font-semibold text-emerald-100">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  Verified
                </span>
              )}
            </div>
            <span className="max-w-[180px] truncate text-[9px] text-slate-500">
              {entry.file_name || entry.storage_path || "No file name"}
            </span>
          </div>
        </div>
      </button>
    );
  };

  const isVerifiedMode = viewMode === "verified";

  // ---------------------------------------------------------------------------
  // UI – THREE PANES (left / middle / right)
  // ---------------------------------------------------------------------------
  return (
    <div className="flex h-full flex-col px-8 pt-6 pb-6">
      {/* Header */}
      <div className="mb-4 shrink-0">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">
          CI-ARCHIVE
        </div>
        <h1 className="mt-1 text-lg font-semibold text-emerald-300">
          CI-Archive – Minute Book Console
        </h1>
        <p className="mt-1 text-[11px] text-slate-400">
          <span className="font-semibold text-emerald-400">Left:</span>{" "}
          structured minute book folders per entity.{" "}
          <span className="font-semibold text-sky-400">Center:</span> indexed
          entries and the selected record.{" "}
          <span className="font-semibold text-amber-400">Right:</span> full
          document viewer, cryptographic status, and download controls.
        </p>
        <p className="mt-0.5 text-[10px] text-slate-500">
          Minute Book &amp; Governance Archive •{" "}
          <span className="text-slate-300">{activeEntityLabel}</span>
        </p>
      </div>

      {/* Main frame */}
      <div className="flex min-h-0 flex-1 justify-center overflow-hidden">
        <div className="flex h-full w-full max-w-[1400px] flex-col overflow-hidden rounded-3xl border border-slate-900 bg-black/60 px-6 py-5 shadow-[0_0_60px_rgba(15,23,42,0.9)]">
          {/* Title bar + toggle */}
          <div className="mb-4 flex shrink-0 items-start justify-between">
            <div className="text-xs text-slate-400">
              Signed minutes and governance artifacts stored under{" "}
              <span className="font-semibold text-slate-200">
                {MINUTE_BOOK_BUCKET}
              </span>{" "}
              bucket, resolved through ODP.AI.
            </div>
            <div className="flex items-center gap-2 text-[10px]">
              <div className="inline-flex rounded-full border border-slate-700 bg-slate-950/70 p-1">
                <button
                  type="button"
                  onClick={() => setViewMode("minute_book")}
                  className={[
                    "rounded-full px-3 py-1 font-semibold transition",
                    viewMode === "minute_book"
                      ? "bg-emerald-500 text-emerald-950 shadow-md shadow-emerald-500/40"
                      : "text-slate-400 hover:text-slate-100",
                  ].join(" ")}
                >
                  Minute book
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode("verified")}
                  className={[
                    "rounded-full px-3 py-1 font-semibold transition",
                    viewMode === "verified"
                      ? "bg-sky-500 text-sky-950 shadow-md shadow-sky-500/40"
                      : "text-slate-400 hover:text-slate-100",
                  ].join(" ")}
                >
                  Verified
                </button>
              </div>
              <span className="rounded-full bg-slate-900/80 px-2 py-0.5 text-[10px] text-slate-400">
                CI-Archive • LIVE
              </span>
            </div>
          </div>

          {/* Banners */}
          {error && (
            <div className="mb-3 rounded-xl border border-rose-500/60 bg-rose-900/30 px-3 py-2 text-[11px] text-rose-100">
              {error}
            </div>
          )}
          {success && (
            <div className="mb-3 rounded-xl border border-emerald-500/60 bg-emerald-900/30 px-3 py-2 text-[11px] text-emerald-100">
              {success}
            </div>
          )}

          {/* Three columns */}
          <div className="flex min-h-0 flex-1 flex-row gap-4">
            {/* LEFT: folders */}
            <section className="flex min-h-0 w-[260px] flex-shrink-0 flex-col rounded-2xl border border-slate-800 bg-slate-950/50 p-3">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Minute book folders
                </div>
              </div>
              <div className="min-h-0 flex-1 space-y-1 overflow-y-auto rounded-xl bg-slate-950/60 p-1">
                {SECTION_DEFS.map((section) => renderFolderButton(section))}
              </div>
            </section>

            {/* CENTER: selected entry + entries list (slim-medium) */}
            <section className="flex min-h-0 flex-[1.1] flex-col rounded-2xl border border-slate-800 bg-slate-950/50 p-3">
              {/* Selected entry card */}
              <div className="mb-3 rounded-2xl border border-slate-800 bg-slate-950/80 px-4 py-3">
                {selectedEntry ? (
                  <>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">
                          Selected entry
                        </div>
                        <div className="mt-1 text-sm font-semibold text-amber-300">
                          {selectedEntry.title ||
                            selectedEntry.file_name ||
                            "Untitled document"}
                        </div>
                        <div className="mt-1 space-y-1 text-[11px] text-slate-400">
                          <div>
                            Entity:{" "}
                            <span className="text-slate-200">
                              {activeEntityLabel}
                            </span>
                          </div>
                          <div>
                            Section:{" "}
                            <span className="text-slate-200">
                              {selectedEntry.section_name ??
                                selectedEntry.document_class ??
                                "Unknown"}
                            </span>
                          </div>
                          <div>
                            Entry date:{" "}
                            <span className="text-slate-300">
                              {formattedDate(
                                selectedEntry.entry_date ??
                                  selectedEntry.created_at,
                              )}
                            </span>
                          </div>
                          <div>
                            Created at:{" "}
                            <span className="text-slate-300">
                              {formattedDateTime(selectedEntry.created_at)}
                            </span>
                          </div>
                          <div>
                            Type:{" "}
                            <span className="text-slate-300">
                              {selectedEntry.entry_type ??
                                selectedEntry.document_class ??
                                "Record"}
                            </span>
                          </div>
                          {selectedEntry.file_hash && (
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-slate-400">File hash:</span>
                              <span className="font-mono text-[10px] text-amber-200">
                                {truncateHash(selectedEntry.file_hash)}
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  handleCopyHash(selectedEntry.file_hash)
                                }
                                className="text-[10px] text-slate-300 hover:text-amber-200"
                              >
                                Copy
                              </button>
                            </div>
                          )}
                          {isVerifiedMode && (
                            <div className="flex flex-wrap items-center gap-2 text-[10px]">
                              {selectedEntry.verification_level && (
                                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/60 bg-emerald-500/10 px-2 py-[2px] text-emerald-100">
                                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                                  {selectedEntry.verification_level}
                                </span>
                              )}
                              {selectedEntry.envelope_id && (
                                <span className="text-slate-500">
                                  Envelope:{" "}
                                  <span className="font-mono text-[9px] text-slate-300">
                                    {truncateHash(selectedEntry.envelope_id)}
                                  </span>
                                </span>
                              )}
                            </div>
                          )}
                          <div className="break-all text-[10px] text-slate-500">
                            Storage path:{" "}
                            <span>{selectedEntry.storage_path ?? "—"}</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {selectedEntry.notes && (
                      <div className="mt-2 rounded-xl border border-slate-700 bg-slate-950/80 px-3 py-2 text-[11px] text-slate-200">
                        {selectedEntry.notes}
                      </div>
                    )}

                    {isVerifiedMode && (verifyStatus || verifyError) && (
                      <div className="mt-2 space-y-1 text-[10px]">
                        {verifyStatus && (
                          <div
                            className={
                              verifyStatus.valid
                                ? "text-emerald-300"
                                : "text-amber-300"
                            }
                          >
                            {verifyStatus.valid
                              ? "Verification: valid"
                              : "Verification: not yet fully valid"}
                          </div>
                        )}
                        {verifyStatus?.hash_match === false && (
                          <div className="text-red-300">
                            Hash mismatch between stored certificate and current
                            PDF.
                          </div>
                        )}
                        {verifyStatus?.reason && (
                          <div className="text-slate-400">
                            Reason: {verifyStatus.reason}
                          </div>
                        )}
                        {verifyError && (
                          <div className="text-red-300">{verifyError}</div>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-[11px] text-slate-500">
                    Select a record from the list below to inspect its
                    metadata.
                  </div>
                )}
              </div>

              {/* Entries list */}
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-sm font-semibold text-slate-200">
                    {isVerifiedMode
                      ? "Verified documents"
                      : "Minute book entries"}
                  </div>
                  <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">
                    {entries.length} record(s)
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-slate-800/80 bg-slate-950/60">
                  {loadingEntries && (
                    <div className="px-3 py-2 text-[11px] text-slate-400">
                      {isVerifiedMode
                        ? "Loading verified documents…"
                        : "Loading minute book entries…"}
                    </div>
                  )}
                  {!loadingEntries && entries.length === 0 && !error && (
                    <div className="px-3 py-2 text-[11px] text-slate-400">
                      {isVerifiedMode
                        ? "No verified documents found for this entity."
                        : "No entries found for this folder and entity."}
                    </div>
                  )}
                  {!loadingEntries && entries.length > 0 && (
                    <>{entries.map(renderEntryRow)}</>
                  )}
                </div>
              </div>
            </section>

            {/* RIGHT: viewer + controls (wider) */}
            <section className="flex min-h-0 flex-[1.4] flex-shrink-0 flex-col rounded-2xl border border-slate-800 bg-slate-950/50 px-4 py-3">
              {/* Viewer */}
              <div className="relative flex min-h-0 flex-1 rounded-xl border border-slate-800 bg-slate-950/70 overflow-hidden">
                {viewerLoading && (
                  <div className="flex h-full w-full items-center justify-center text-[11px] text-slate-400">
                    Loading document…
                  </div>
                )}
                {!viewerLoading && viewerUrl && selectedEntry && (
                  <>
                    <iframe
                      key={viewerUrl}
                      src={viewerUrl}
                      className="h-full w-full"
                      title={selectedEntry.title ?? "Document"}
                    />
                    {/* Hover pill for new tab */}
                    <button
                      type="button"
                      onClick={() => handleOpenInNewTab(selectedEntry)}
                      className="group absolute right-2 top-2 rounded-full bg-slate-950/80 px-2.5 py-1 text-[10px] text-slate-200 shadow-lg shadow-black/60 hover:bg-slate-900"
                    >
                      <span className="opacity-80 group-hover:opacity-100">
                        Open in new tab
                      </span>
                    </button>
                  </>
                )}
                {!viewerLoading && !viewerUrl && (
                  <div className="flex h-full w-full items-center justify-center text-[11px] text-slate-500">
                    Select a record with a storage path to render the PDF
                    preview here.
                  </div>
                )}
              </div>

              {/* Actions row */}
              <div className="mt-3 flex items-center justify-between gap-3">
                <div className="max-w-[55%] text-[10px] text-slate-500">
                  Signed URLs are issued from the{" "}
                  <span className="font-semibold text-slate-200">
                    minute_book
                  </span>{" "}
                  bucket to keep your chain-of-custody internal to{" "}
                  <span className="text-emerald-300">ODP.AI</span>.
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleOpenInNewTab(selectedEntry)}
                    disabled={!selectedEntry || isOpening || viewerLoading}
                    className="inline-flex items-center rounded-full bg-sky-500 px-3 py-1.5 text-[11px] font-semibold text-sky-950 shadow-lg shadow-sky-500/40 transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-sky-700/60"
                  >
                    Download signed PDF
                  </button>
                  {viewMode === "minute_book" && (
                    <button
                      type="button"
                      onClick={openUploadModal}
                      className="inline-flex items-center rounded-full border border-emerald-500/70 bg-emerald-500/10 px-3 py-1.5 text-[11px] font-semibold text-emerald-100 hover:bg-emerald-500/20"
                    >
                      ＋ Upload
                    </button>
                  )}
                  {isVerifiedMode &&
                    (selectedEntry?.envelope_id || selectedEntry?.verify_url) && (
                      <button
                        type="button"
                        onClick={handleVerifySelected}
                        disabled={verifyLoading}
                        className="inline-flex items-center rounded-full border border-emerald-500/70 bg-emerald-500/10 px-3 py-1.5 text-[11px] font-semibold text-emerald-100 hover:bg-emerald-500/20 disabled:opacity-60"
                      >
                        {verifyLoading ? "Verifying…" : "Verify"}
                      </button>
                    )}
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>

      {/* Upload modal */}
      {showUpload && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-md space-y-4 rounded-2xl border border-slate-800 bg-[#020617] p-5 shadow-2xl">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-slate-100">
                  Upload minute book document
                </h2>
                <p className="text-[11px] text-slate-400">
                  File will be stored under{" "}
                  <span className="font-semibold text-slate-200">
                    {activeEntity}/{uploadSection}
                  </span>{" "}
                  and indexed in the minute book.
                </p>
              </div>
              <button
                onClick={() => !uploading && setShowUpload(false)}
                className="text-xs text-slate-500 hover:text-slate-300"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleUpload} className="space-y-3 text-xs">
              <div className="space-y-1">
                <label className="block text-[11px] text-slate-400">
                  Entity
                </label>
                <div className="rounded-lg border border-slate-700 bg-slate-900/70 px-2.5 py-1.5 text-xs text-slate-200">
                  {activeEntityLabel}
                </div>
              </div>

              <div className="space-y-1">
                <label className="block text-[11px] text-slate-400">
                  Section
                </label>
                <select
                  value={uploadSection}
                  onChange={(e) => setUploadSection(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900/70 px-2.5 py-1.5 text-xs text-slate-100"
                >
                  {SECTION_DEFS.filter((s) => s.id !== "all").map((section) => (
                    <option key={section.id} value={section.id}>
                      {section.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="block text-[11px] text-slate-400">
                  Title (optional)
                </label>
                <input
                  value={uploadTitle}
                  onChange={(e) => setUploadTitle(e.target.value)}
                  placeholder="If empty, file name will be used"
                  className="w-full rounded-lg border border-slate-700 bg-slate-900/70 px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-400/70"
                />
              </div>

              <div className="space-y-1">
                <label className="block text-[11px] text-slate-400">
                  Notes (optional)
                </label>
                <textarea
                  value={uploadNotes}
                  onChange={(e) => setUploadNotes(e.target.value)}
                  rows={2}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900/70 px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-400/70"
                  placeholder="Context, source, or internal notes…"
                />
              </div>

              <div className="space-y-1">
                <label className="block text-[11px] text-slate-400">
                  File
                </label>
                <input
                  type="file"
                  accept="application/pdf"
                  onChange={(e) =>
                    setUploadFile(e.target.files?.[0] ?? null)
                  }
                  className="block w-full text-[11px] text-slate-300 file:mr-2 file:rounded-md file:border-0 file:bg-emerald-400/20 file:px-2 file:py-1 file:text-[11px] file:text-emerald-100 hover:file:bg-emerald-400/30"
                />
                <p className="mt-1 text-[10px] text-slate-500">
                  PDFs are recommended for long-term governance storage.
                </p>
              </div>

              {uploadError && (
                <div className="rounded-lg border border-red-700/60 bg-red-900/30 px-2 py-1 text-[11px] text-red-300">
                  {uploadError}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  disabled={uploading}
                  onClick={() => setShowUpload(false)}
                  className="rounded-lg border border-slate-700 px-3 py-1.5 text-[11px] text-slate-300 hover:bg-slate-800/80 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={uploading}
                  className="rounded-lg bg-emerald-400/80 px-3 py-1.5 text-[11px] font-medium text-black hover:bg-emerald-400 disabled:opacity-50"
                >
                  {uploading ? "Uploading…" : "Upload"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
