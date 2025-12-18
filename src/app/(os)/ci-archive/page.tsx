"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/browser";

type MinuteBookEntry = {
  id: string;
  title: string | null;
  storage_path: string | null;
  file_name: string | null;
  entity_key: string | null;
  entry_type: string | null;
  section_name: string | null;
  notes: string | null;
  pdf_hash: string | null;
  registry_status: string | null;
  source: string | null;
  created_at: string;
  updated_at: string | null;
};

type VerifiedDocument = {
  id: string;
  title: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
  file_hash: string | null;
  file_size: number | null;
  mime_type: string | null;
  entity_slug: string | null;
  document_class: string | null;
  document_purpose: string | null;
  verification_level: string | null;
  envelope_id: string | null;
  signed_at: string | null;
  created_at: string;
  updated_at: string | null;
};

type TabKey = "minute_book" | "verified";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function safeFolderFromPath(path: string | null) {
  if (!path) return "Unsorted";
  const p = path.replace(/^\/+/, "");
  const first = p.split("/")[0]?.trim();
  return first && first.length > 0 ? first : "Unsorted";
}

function normalizeMinuteBookStoragePath(storagePath: string | null) {
  // minute_book_entries.storage_path should be relative to the "minute_book" bucket.
  // Some legacy rows might include "minute_book/" prefix; strip it.
  if (!storagePath) return null;
  return storagePath.replace(/^minute_book\//, "");
}

function shortId(id: string) {
  return id.length > 10 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function fmt(dt: string | null | undefined) {
  if (!dt) return "—";
  const d = new Date(dt);
  if (Number.isNaN(d.getTime())) return dt;
  return d.toLocaleString();
}

export default function CIArchivePage() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const [tab, setTab] = useState<TabKey>("minute_book");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [minuteBook, setMinuteBook] = useState<MinuteBookEntry[]>([]);
  const [verified, setVerified] = useState<VerifiedDocument[]>([]);

  const [folder, setFolder] = useState<string>("All");
  const [query, setQuery] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const lastPdfKey = useRef<string | null>(null);

  // ---- Load data ----
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        // Minute Book
        const mb = await supabase
          .from("minute_book_entries")
          .select(
            "id,title,storage_path,file_name,entity_key,entry_type,section_name,notes,pdf_hash,registry_status,source,created_at,updated_at"
          )
          .order("created_at", { ascending: false });

        if (mb.error) throw mb.error;

        // Verified Docs
        const vd = await supabase
          .from("verified_documents")
          .select(
            "id,title,storage_bucket,storage_path,file_hash,file_size,mime_type,entity_slug,document_class,document_purpose,verification_level,envelope_id,signed_at,created_at,updated_at"
          )
          .order("created_at", { ascending: false });

        if (vd.error) throw vd.error;

        if (!cancelled) {
          setMinuteBook((mb.data as MinuteBookEntry[]) ?? []);
          setVerified((vd.data as VerifiedDocument[]) ?? []);
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "Failed to load archive.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  // Reset folder + selection when tab changes
  useEffect(() => {
    setFolder("All");
    setQuery("");
    setSelectedId(null);
    setPdfUrl(null);
    lastPdfKey.current = null;
  }, [tab]);

  const activeRows = useMemo(() => {
    return tab === "minute_book" ? minuteBook : verified;
  }, [tab, minuteBook, verified]);

  const folders = useMemo(() => {
    const set = new Set<string>();
    for (const r of activeRows as any[]) {
      const f =
        tab === "minute_book"
          ? safeFolderFromPath((r as MinuteBookEntry).storage_path)
          : safeFolderFromPath((r as VerifiedDocument).storage_path);
      set.add(f);
    }
    return ["All", ...Array.from(set).sort((a, b) => a.localeCompare(b))];
  }, [activeRows, tab]);

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const inFolder = (p: string | null) => {
      if (folder === "All") return true;
      return safeFolderFromPath(p) === folder;
    };

    if (tab === "minute_book") {
      return (minuteBook ?? []).filter((r) => {
        if (!inFolder(r.storage_path)) return false;
        if (!q) return true;
        const hay = [
          r.title,
          r.storage_path,
          r.file_name,
          r.entity_key,
          r.entry_type,
          r.section_name,
          r.registry_status,
          r.source,
          r.notes,
          r.pdf_hash,
          r.id,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      });
    }

    return (verified ?? []).filter((r) => {
      if (!inFolder(r.storage_path)) return false;
      if (!q) return true;
      const hay = [
        r.title,
        r.storage_bucket,
        r.storage_path,
        r.entity_slug,
        r.document_class,
        r.document_purpose,
        r.verification_level,
        r.mime_type,
        r.file_hash,
        r.envelope_id,
        r.id,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [tab, folder, query, minuteBook, verified]);

  const selected = useMemo(() => {
    if (!selectedId) return null;
    if (tab === "minute_book") return minuteBook.find((x) => x.id === selectedId) ?? null;
    return verified.find((x) => x.id === selectedId) ?? null;
  }, [tab, selectedId, minuteBook, verified]);

  // ---- PDF signed URL generation ----
  useEffect(() => {
    let cancelled = false;

    async function buildSignedPdf() {
      setPdfUrl(null);
      setPdfBusy(false);

      if (!selected) return;

      // Minute Book PDF preview/download: always bucket "minute_book"
      if (tab === "minute_book") {
        const row = selected as MinuteBookEntry;
        const raw = row.storage_path;
        const path = normalizeMinuteBookStoragePath(raw);
        if (!path) return;

        const key = `minute_book::${path}`;
        if (lastPdfKey.current === key) return;
        lastPdfKey.current = key;

        setPdfBusy(true);
        const { data, error } = await supabase.storage.from("minute_book").createSignedUrl(path, 60 * 15);
        setPdfBusy(false);

        if (cancelled) return;
        if (error) {
          setPdfUrl(null);
          return;
        }
        setPdfUrl(data?.signedUrl ?? null);
        return;
      }

      // Verified: use row.storage_bucket (fallback "verified_documents")
      const row = selected as VerifiedDocument;
      const bucket = row.storage_bucket || "verified_documents";
      const path = row.storage_path;
      if (!path) return;

      const key = `${bucket}::${path}`;
      if (lastPdfKey.current === key) return;
      lastPdfKey.current = key;

      setPdfBusy(true);
      const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 15);
      setPdfBusy(false);

      if (cancelled) return;
      if (error) {
        setPdfUrl(null);
        return;
      }
      setPdfUrl(data?.signedUrl ?? null);
    }

    buildSignedPdf();
    return () => {
      cancelled = true;
    };
  }, [selected, tab, supabase]);

  function onSelectRow(id: string) {
    setSelectedId(id);
  }

  function openSignedInNewTab() {
    if (!pdfUrl) return;
    window.open(pdfUrl, "_blank", "noopener,noreferrer");
  }

  // ---- UI ----
  return (
    <div className="min-h-[calc(100vh-72px)] w-full">
      {/* Header strip (OS-consistent, minimal) */}
      <div className="px-8 pt-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[13px] text-white/60">CI-Archive</div>
            <div className="text-[11px] text-white/35">Registry vault • canonical three-column layout</div>
          </div>

          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-full bg-white/5 p-1 ring-1 ring-white/10">
              <button
                className={cx(
                  "px-3 py-1.5 text-[12px] rounded-full transition",
                  tab === "minute_book" ? "bg-white/10 text-white" : "text-white/60 hover:text-white"
                )}
                onClick={() => setTab("minute_book")}
              >
                Minute Book
              </button>
              <button
                className={cx(
                  "px-3 py-1.5 text-[12px] rounded-full transition",
                  tab === "verified" ? "bg-white/10 text-white" : "text-white/60 hover:text-white"
                )}
                onClick={() => setTab("verified")}
              >
                Verified
              </button>
            </div>

            <Link
              href="/ci-archive/upload"
              className="rounded-full bg-amber-300/10 px-3 py-1.5 text-[12px] text-amber-200 ring-1 ring-amber-200/20 hover:bg-amber-300/15"
            >
              Upload
            </Link>
          </div>
        </div>
      </div>

      {/* 3-column canonical surface */}
      <div className="px-8 pb-10 pt-5">
        <div className="rounded-3xl bg-black/30 ring-1 ring-white/10 shadow-[0_20px_80px_rgba(0,0,0,0.55)]">
          {/* Top bar */}
          <div className="flex items-center justify-between gap-3 px-5 py-4">
            <div className="flex items-center gap-3">
              <div className="h-2 w-2 rounded-full bg-amber-300/80" />
              <div className="text-[12px] text-white/70">
                {tab === "minute_book" ? "Minute Book Registry" : "Verified Documents Registry"}
              </div>
            </div>

            <div className="w-[420px] max-w-full">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search title, path, hash, status…"
                className="w-full rounded-xl bg-white/5 px-4 py-2 text-[12px] text-white/80 placeholder:text-white/30 ring-1 ring-white/10 focus:outline-none focus:ring-amber-200/20"
              />
            </div>
          </div>

          <div className="grid grid-cols-12 gap-0 px-5 pb-5">
            {/* LEFT: Folders */}
            <div className="col-span-3 pr-4">
              <div className="rounded-2xl bg-white/3 ring-1 ring-amber-200/10">
                <div className="px-4 py-3 text-[11px] tracking-wide text-white/45">FOLDERS</div>
                <div className="px-2 pb-2">
                  {folders.map((f) => (
                    <button
                      key={f}
                      onClick={() => setFolder(f)}
                      className={cx(
                        "w-full text-left rounded-xl px-3 py-2 text-[12px] transition",
                        folder === f
                          ? "bg-amber-200/10 text-amber-200 ring-1 ring-amber-200/20"
                          : "text-white/70 hover:bg-white/5"
                      )}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* MID: Entries */}
            <div className="col-span-5 pr-4">
              <div className="rounded-2xl bg-white/3 ring-1 ring-amber-200/10">
                <div className="flex items-center justify-between px-4 py-3">
                  <div className="text-[11px] tracking-wide text-white/45">ENTRIES</div>
                  <div className="text-[11px] text-white/35">{filteredRows.length} items</div>
                </div>

                <div className="max-h-[66vh] overflow-auto px-2 pb-2">
                  {loading ? (
                    <div className="px-3 py-6 text-[12px] text-white/40">Loading…</div>
                  ) : error ? (
                    <div className="px-3 py-6 text-[12px] text-red-300/80">{error}</div>
                  ) : filteredRows.length === 0 ? (
                    <div className="px-3 py-6 text-[12px] text-white/35">No entries found.</div>
                  ) : (
                    (filteredRows as any[]).map((r) => {
                      const id = r.id as string;
                      const isActive = selectedId === id;

                      const title = (r.title as string | null) || (r.storage_path as string | null) || "Untitled";
                      const path = (r.storage_path as string | null) || "—";
                      const meta =
                        tab === "minute_book"
                          ? [
                              (r.registry_status as string | null) || "unclassified",
                              (r.entry_type as string | null) || "entry",
                              (r.entity_key as string | null) || null,
                            ]
                              .filter(Boolean)
                              .join(" • ")
                          : [
                              (r.document_class as string | null) || "document",
                              (r.verification_level as string | null) || null,
                              (r.entity_slug as string | null) || null,
                            ]
                              .filter(Boolean)
                              .join(" • ");

                      return (
                        <button
                          key={id}
                          onClick={() => onSelectRow(id)}
                          className={cx(
                            "w-full text-left rounded-2xl px-3 py-3 mb-2 transition ring-1",
                            isActive
                              ? "bg-amber-200/10 ring-amber-200/25"
                              : "bg-white/0 ring-white/5 hover:bg-white/5 hover:ring-white/10"
                          )}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="truncate text-[13px] text-white/85">{title}</div>
                              <div className="truncate text-[11px] text-white/35">{path}</div>
                            </div>
                            <div className="shrink-0 text-[11px] text-white/25">{shortId(id)}</div>
                          </div>
                          <div className="mt-2 text-[11px] text-white/40">{meta || "—"}</div>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            </div>

            {/* RIGHT: Details */}
            <div className="col-span-4">
              <div className="rounded-2xl bg-white/3 ring-1 ring-amber-200/10">
                <div className="px-4 py-3 text-[11px] tracking-wide text-white/45">DETAILS</div>

                {!selected ? (
                  <div className="px-4 pb-4 text-[12px] text-white/35">Select an entry.</div>
                ) : (
                  <div className="px-4 pb-4">
                    <div className="text-[14px] text-white/90">
                      {(selected as any).title || (selected as any).storage_path || "Untitled"}
                    </div>

                    <div className="mt-2 rounded-xl bg-black/30 p-3 ring-1 ring-white/10">
                      <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-[11px]">
                        {tab === "minute_book" ? (
                          <>
                            <Field label="ID" value={(selected as MinuteBookEntry).id} mono />
                            <Field label="Created" value={fmt((selected as MinuteBookEntry).created_at)} />
                            <Field label="Updated" value={fmt((selected as MinuteBookEntry).updated_at)} />
                            <Field label="Entity" value={(selected as MinuteBookEntry).entity_key} />
                            <Field label="Entry Type" value={(selected as MinuteBookEntry).entry_type} />
                            <Field label="Section" value={(selected as MinuteBookEntry).section_name} />
                            <Field label="Registry" value={(selected as MinuteBookEntry).registry_status} />
                            <Field label="Source" value={(selected as MinuteBookEntry).source} />
                            <Field
                              label="Hash"
                              value={(selected as MinuteBookEntry).pdf_hash}
                              mono
                              span2
                            />
                            <Field
                              label="Storage Path"
                              value={normalizeMinuteBookStoragePath((selected as MinuteBookEntry).storage_path)}
                              mono
                              span2
                            />
                          </>
                        ) : (
                          <>
                            <Field label="ID" value={(selected as VerifiedDocument).id} mono />
                            <Field label="Created" value={fmt((selected as VerifiedDocument).created_at)} />
                            <Field label="Signed" value={fmt((selected as VerifiedDocument).signed_at)} />
                            <Field label="Entity" value={(selected as VerifiedDocument).entity_slug} />
                            <Field label="Class" value={(selected as VerifiedDocument).document_class} />
                            <Field label="Purpose" value={(selected as VerifiedDocument).document_purpose} />
                            <Field label="Verify" value={(selected as VerifiedDocument).verification_level} />
                            <Field label="MIME" value={(selected as VerifiedDocument).mime_type} />
                            <Field label="Size" value={(selected as VerifiedDocument).file_size?.toString()} />
                            <Field label="Envelope" value={(selected as VerifiedDocument).envelope_id} mono />
                            <Field label="Hash" value={(selected as VerifiedDocument).file_hash} mono span2 />
                            <Field label="Bucket" value={(selected as VerifiedDocument).storage_bucket} mono />
                            <Field label="Storage Path" value={(selected as VerifiedDocument).storage_path} mono span2 />
                          </>
                        )}
                      </div>

                      {(tab === "minute_book" && (selected as MinuteBookEntry).notes) ? (
                        <div className="mt-3 border-t border-white/10 pt-3">
                          <div className="text-[11px] text-white/40">Notes</div>
                          <div className="mt-1 text-[12px] leading-relaxed text-white/70 whitespace-pre-wrap">
                            {(selected as MinuteBookEntry).notes}
                          </div>
                        </div>
                      ) : null}
                    </div>

                    <div className="mt-3 flex items-center gap-2">
                      <button
                        onClick={openSignedInNewTab}
                        disabled={!pdfUrl || pdfBusy}
                        className={cx(
                          "rounded-xl px-3 py-2 text-[12px] ring-1 transition",
                          pdfUrl && !pdfBusy
                            ? "bg-white/5 text-white/80 ring-white/15 hover:bg-white/8"
                            : "bg-white/3 text-white/35 ring-white/10 cursor-not-allowed"
                        )}
                      >
                        {pdfBusy ? "Preparing…" : "Open PDF"}
                      </button>

                      <div className="text-[11px] text-white/30">
                        {pdfUrl ? "Signed URL ready (15 min)" : "No preview yet"}
                      </div>
                    </div>

                    {/* Preview */}
                    <div className="mt-3 overflow-hidden rounded-2xl ring-1 ring-white/10 bg-black/30">
                      <div className="px-3 py-2 text-[11px] text-white/45 border-b border-white/10">
                        Preview
                      </div>

                      {pdfUrl ? (
                        <iframe
                          title="ci-archive-preview"
                          src={pdfUrl}
                          className="h-[360px] w-full"
                        />
                      ) : (
                        <div className="px-3 py-8 text-[12px] text-white/35">
                          Upload/index a PDF and select it to preview.
                        </div>
                      )}
                    </div>

                    <div className="mt-3 text-[11px] text-white/30">
                      If preview is blank, it’s almost always **storage policy** (SELECT) or the row’s
                      `storage_path/bucket` mismatch—not the UI.
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Footer strip */}
          <div className="px-5 pb-5">
            <div className="h-px w-full bg-gradient-to-r from-transparent via-amber-200/10 to-transparent" />
            <div className="mt-3 text-[11px] text-white/30">
              Oasis Digital Parliament • CI-Archive • governance firmware
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  mono,
  span2,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
  span2?: boolean;
}) {
  return (
    <div className={cx(span2 && "col-span-2")}>
      <div className="text-[10px] uppercase tracking-wide text-white/35">{label}</div>
      <div className={cx("mt-0.5 text-[12px] text-white/80", mono && "font-mono text-[11px] text-white/70")}>
        {value && value.length > 0 ? value : "—"}
      </div>
    </div>
  );
}
