"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/browser";

/**
 * CI-Archive (Registry-only)
 * - Canonical 3-column Oasis OS surface
 * - Minute Book + Verified + Ledger (draft/approved) view for clarity
 * - Ledger tab does NOT change Forge logic; it only reveals where Alchemy drafts live
 * - Archive status is inferred via minute_book_entries.source_record_id -> governance_ledger.id
 */

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

  // IMPORTANT: links minute book row back to governance_ledger (your fix)
  source_record_id: string | null;
  source_envelope_id: string | null;

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

type GovernanceLedgerRow = {
  id: string;
  title: string | null;
  status: string | null;
  source: string | null;
  created_at: string;
};

type TabKey = "minute_book" | "verified" | "ledger";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
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

function bytes(n: number | null | undefined) {
  if (!n || n <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function normalizeMinuteBookStoragePath(storagePath: string | null) {
  if (!storagePath) return null;
  return storagePath.replace(/^minute_book\//, "");
}

function safeFolderFromPath(path: string | null) {
  if (!path) return "Unsorted";
  const p = path.replace(/^\/+/, "");
  const first = p.split("/")[0]?.trim();
  return first && first.length > 0 ? first : "Unsorted";
}

function folderForMinuteBook(storagePath: string | null) {
  // Prevent “minute_book” showing up as a fake folder if some rows store prefixed paths
  const p = normalizeMinuteBookStoragePath(storagePath);
  return safeFolderFromPath(p);
}

function folderForGeneric(path: string | null) {
  return safeFolderFromPath(path);
}

/** Oasis OS Signature: icon + subtle glow + gold accent when verified/signed */
function RegistryGlyph({
  kind,
  verified,
}: {
  kind: "minute" | "verified" | "receipt" | "certificate" | "resolution" | "ledger" | "generic";
  verified?: boolean;
}) {
  const gold = !!verified;

  const ring = gold
    ? "ring-amber-200/25 bg-amber-200/10"
    : "ring-white/10 bg-white/5";

  const glow = gold
    ? "shadow-[0_0_0_1px_rgba(251,191,36,0.15),0_0_30px_rgba(251,191,36,0.10)]"
    : "";

  const stroke = gold ? "rgba(251,191,36,0.85)" : "rgba(255,255,255,0.65)";
  const fill = gold ? "rgba(251,191,36,0.10)" : "rgba(255,255,255,0.08)";

  const Icon = () => {
    switch (kind) {
      case "certificate":
        return (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M7 3h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" stroke={stroke} strokeWidth="1.6" />
            <path d="M9 7h6" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" />
            <path d="M9 10h8" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" />
            <path d="M9 13h5" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" />
            <path d="M12 16v5l2-1 2 1v-5" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        );
      case "resolution":
        return (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M7 3h7l3 3v15a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" stroke={stroke} strokeWidth="1.6" />
            <path d="M14 3v4a1 1 0 0 0 1 1h4" stroke={stroke} strokeWidth="1.6" />
            <path d="M8.5 12.2 10.6 14.3 15.5 9.4" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        );
      case "receipt":
        return (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M7 3h10a2 2 0 0 1 2 2v16l-2-1-2 1-2-1-2 1-2-1-2 1V5a2 2 0 0 1 2-2Z" stroke={stroke} strokeWidth="1.6" />
            <path d="M9 8h6" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" />
            <path d="M9 11h8" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" />
            <path d="M9 14h5" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        );
      case "minute":
        return (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M7 3h7l3 3v15a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" stroke={stroke} strokeWidth="1.6" />
            <path d="M14 3v4a1 1 0 0 0 1 1h4" stroke={stroke} strokeWidth="1.6" />
            <path d="M9 11h6" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" />
            <path d="M9 14h8" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" />
            <path d="M9 17h5" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        );
      case "ledger":
        return (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M6 4h11a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" stroke={stroke} strokeWidth="1.6" />
            <path d="M8 8h9" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" />
            <path d="M8 11h7" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" />
            <path d="M8 14h9" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        );
      case "verified":
      default:
        return (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 2l2.1 2.2 3-.2.9 2.9 2.6 1.4-1.3 2.6 1.3 2.6-2.6 1.4-.9 2.9-3-.2L12 22l-2.1-2.2-3 .2-.9-2.9-2.6-1.4 1.3-2.6-1.3-2.6L6 6.9 6.9 4l3 .2L12 2Z"
              stroke={stroke}
              strokeWidth="1.6"
              fill={fill}
            />
            <path d="M8.7 12.3 10.7 14.3 15.7 9.3" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        );
    }
  };

  return (
    <div className={cx("h-9 w-9 rounded-2xl ring-1 grid place-items-center", ring, glow)}>
      <Icon />
    </div>
  );
}

function isVerifiedMinuteBook(r: MinuteBookEntry) {
  const s = (r.registry_status || "").toLowerCase();
  const src = (r.source || "").toLowerCase();
  return s.includes("verified") || s.includes("signed") || src.includes("signed") || !!r.pdf_hash;
}

function minuteKind(r: MinuteBookEntry): "minute" | "resolution" | "generic" {
  const t = (r.entry_type || "").toLowerCase();
  const s = (r.section_name || "").toLowerCase();
  const title = (r.title || "").toLowerCase();
  if (t.includes("resolution") || title.includes("resolution")) return "resolution";
  if (s.includes("minutes") || title.includes("minutes")) return "minute";
  return "minute";
}

function verifiedKind(r: VerifiedDocument): "verified" | "certificate" | "receipt" | "generic" {
  const c = (r.document_class || "").toLowerCase();
  const p = (r.document_purpose || "").toLowerCase();
  const m = (r.mime_type || "").toLowerCase();
  const title = (r.title || "").toLowerCase();

  if (c.includes("certificate") || p.includes("certificate") || title.includes("certificate")) return "certificate";
  if (c.includes("receipt") || p.includes("receipt") || title.includes("receipt") || c.includes("invoice")) return "receipt";
  if (m.includes("pdf")) return "verified";
  return "verified";
}

function isVerifiedDoc(r: VerifiedDocument) {
  const v = (r.verification_level || "").toLowerCase();
  return v.includes("verified") || v.includes("signed") || !!r.signed_at || !!r.envelope_id || !!r.file_hash;
}

function ledgerStatusBadge(status: string | null) {
  const s = (status || "").toLowerCase();
  if (s.includes("approved")) return { label: "Approved", cls: "bg-amber-200/10 text-amber-200 ring-amber-200/20" };
  if (s.includes("draft")) return { label: "Drafted", cls: "bg-white/5 text-white/55 ring-white/10" };
  if (s.includes("rejected")) return { label: "Rejected", cls: "bg-red-400/10 text-red-300 ring-red-300/20" };
  return { label: status || "Unknown", cls: "bg-white/5 text-white/45 ring-white/10" };
}

export default function CIArchivePage() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const [tab, setTab] = useState<TabKey>("minute_book");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [minuteBook, setMinuteBook] = useState<MinuteBookEntry[]>([]);
  const [verified, setVerified] = useState<VerifiedDocument[]>([]);
  const [ledger, setLedger] = useState<GovernanceLedgerRow[]>([]);

  const [folder, setFolder] = useState<string>("All");
  const [query, setQuery] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const lastPdfKey = useRef<string | null>(null);

  // Map governance_ledger.id -> minute_book_entries row (archive evidence)
  const archiveByLedgerId = useMemo(() => {
    const m = new Map<string, MinuteBookEntry>();
    for (const r of minuteBook) {
      if (r.source_record_id) m.set(r.source_record_id, r);
    }
    return m;
  }, [minuteBook]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const mb = await supabase
          .from("minute_book_entries")
          .select(
            "id,title,storage_path,file_name,entity_key,entry_type,section_name,notes,pdf_hash,registry_status,source,source_record_id,source_envelope_id,created_at,updated_at"
          )
          .order("created_at", { ascending: false });

        if (mb.error) throw mb.error;

        const vd = await supabase
          .from("verified_documents")
          .select(
            "id,title,storage_bucket,storage_path,file_hash,file_size,mime_type,entity_slug,document_class,document_purpose,verification_level,envelope_id,signed_at,created_at,updated_at"
          )
          .order("created_at", { ascending: false });

        if (vd.error) throw vd.error;

        // Governance ledger: this is where CI-Alchemy drafts live.
        // Showing this tab removes the confusion without touching Forge.
        const gl = await supabase
          .from("governance_ledger")
          .select("id,title,status,source,created_at")
          .order("created_at", { ascending: false })
          .limit(250);

        if (gl.error) throw gl.error;

        if (!cancelled) {
          setMinuteBook((mb.data as MinuteBookEntry[]) ?? []);
          setVerified((vd.data as VerifiedDocument[]) ?? []);
          setLedger((gl.data as GovernanceLedgerRow[]) ?? []);
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

  useEffect(() => {
    setFolder("All");
    setQuery("");
    setSelectedId(null);
    setPdfUrl(null);
    lastPdfKey.current = null;
  }, [tab]);

  const activeRows = useMemo(() => {
    if (tab === "minute_book") return minuteBook;
    if (tab === "verified") return verified;
    return ledger;
  }, [tab, minuteBook, verified, ledger]);

  const folders = useMemo(() => {
    const set = new Set<string>();
    for (const r of activeRows as any[]) {
      const f =
        tab === "minute_book"
          ? folderForMinuteBook((r as MinuteBookEntry).storage_path)
          : tab === "verified"
          ? folderForGeneric((r as VerifiedDocument).storage_path)
          : "Ledger";
      set.add(f);
    }
    const list = Array.from(set).sort((a, b) => a.localeCompare(b));
    return ["All", ...list];
  }, [activeRows, tab]);

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();

    if (tab === "minute_book") {
      return (minuteBook ?? []).filter((r) => {
        const f = folderForMinuteBook(r.storage_path);
        if (folder !== "All" && f !== folder) return false;
        if (!q) return true;
        const hay = [
          r.title,
          normalizeMinuteBookStoragePath(r.storage_path),
          r.file_name,
          r.entity_key,
          r.entry_type,
          r.section_name,
          r.registry_status,
          r.source,
          r.source_record_id,
          r.source_envelope_id,
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

    if (tab === "verified") {
      return (verified ?? []).filter((r) => {
        const f = folderForGeneric(r.storage_path);
        if (folder !== "All" && f !== folder) return false;
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
    }

    // ledger
    return (ledger ?? []).filter((r) => {
      if (folder !== "All" && folder !== "Ledger") return false;
      if (!q) return true;
      const hay = [r.title, r.status, r.source, r.id].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [tab, folder, query, minuteBook, verified, ledger]);

  const selected = useMemo(() => {
    if (!selectedId) return null;
    if (tab === "minute_book") return minuteBook.find((x) => x.id === selectedId) ?? null;
    if (tab === "verified") return verified.find((x) => x.id === selectedId) ?? null;
    return ledger.find((x) => x.id === selectedId) ?? null;
  }, [tab, selectedId, minuteBook, verified, ledger]);

  // Build preview URL for minute_book + verified docs (ledger drafts do not preview here)
  useEffect(() => {
    let cancelled = false;

    async function buildSignedPdf() {
      setPdfUrl(null);
      setPdfBusy(false);
      if (!selected) return;

      // Only minute_book / verified have storage previews
      if (tab === "ledger") return;

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

  function openSignedInNewTab() {
    if (!pdfUrl) return;
    window.open(pdfUrl, "_blank", "noopener,noreferrer");
  }

  const ledgerPendingArchiveCount = useMemo(() => {
    // “Pending archive” = drafted/approved in governance_ledger with no minute_book entry referencing it yet
    let n = 0;
    for (const r of ledger) {
      const src = (r.source || "").toLowerCase();
      if (!src.includes("ci-alchemy")) continue; // only the stream you care about
      if (!archiveByLedgerId.has(r.id)) n++;
    }
    return n;
  }, [ledger, archiveByLedgerId]);

  return (
    <div className="min-h-[calc(100vh-72px)] w-full">
      {/* Header strip */}
      <div className="px-8 pt-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[13px] text-white/60">CI-Archive</div>
            <div className="text-[11px] text-white/35">Registry vault • strict three-column • Oasis OS signature</div>
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
              <button
                className={cx(
                  "px-3 py-1.5 text-[12px] rounded-full transition",
                  tab === "ledger" ? "bg-white/10 text-white" : "text-white/60 hover:text-white"
                )}
                onClick={() => setTab("ledger")}
              >
                Ledger
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

        {/* Clarity strip for your exact pain point */}
        {tab === "ledger" ? (
          <div className="mt-4 rounded-2xl bg-black/30 ring-1 ring-amber-200/10 px-4 py-3">
            <div className="text-[12px] text-white/70">
              <span className="text-amber-200">Alchemy drafts live here</span>. Archive appears in Minute Book only after signature routing creates a
              minute_book_entries row (linked by <span className="font-mono text-white/70">source_record_id</span>).
            </div>
            <div className="mt-1 text-[11px] text-white/35">
              Pending archive (ci-alchemy stream): <span className="text-white/70">{ledgerPendingArchiveCount}</span>
            </div>
          </div>
        ) : null}
      </div>

      {/* 3-column canonical surface */}
      <div className="px-8 pb-10 pt-5">
        <div className="rounded-3xl bg-black/30 ring-1 ring-white/10 shadow-[0_20px_80px_rgba(0,0,0,0.55)]">
          {/* Top bar */}
          <div className="flex items-center justify-between gap-3 px-5 py-4">
            <div className="flex items-center gap-3">
              <div className="h-2 w-2 rounded-full bg-amber-300/80" />
              <div className="text-[12px] text-white/70">
                {tab === "minute_book"
                  ? "Minute Book Registry"
                  : tab === "verified"
                  ? "Verified Registry"
                  : "Governance Ledger (Drafts / Approvals)"}
              </div>
            </div>

            <div className="w-[420px] max-w-full">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={
                  tab === "ledger"
                    ? "Search title, status, id…"
                    : "Search title, path, hash, status…"
                }
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

                      const title =
                        (r.title as string | null) ||
                        (r.storage_path as string | null) ||
                        "Untitled";

                      const path =
                        tab === "minute_book"
                          ? normalizeMinuteBookStoragePath((r as MinuteBookEntry).storage_path) || "—"
                          : tab === "verified"
                          ? (r.storage_path as string | null) || "—"
                          : "governance_ledger";

                      const verifiedAccent =
                        tab === "minute_book"
                          ? isVerifiedMinuteBook(r as MinuteBookEntry)
                          : tab === "verified"
                          ? isVerifiedDoc(r as VerifiedDocument)
                          : !!archiveByLedgerId.has(id);

                      const glyphKind =
                        tab === "minute_book"
                          ? minuteKind(r as MinuteBookEntry)
                          : tab === "verified"
                          ? verifiedKind(r as VerifiedDocument)
                          : "ledger";

                      const meta =
                        tab === "minute_book"
                          ? [
                              (r.registry_status as string | null) || "registered",
                              (r.entry_type as string | null) || "entry",
                              (r.entity_key as string | null) || null,
                            ]
                              .filter(Boolean)
                              .join(" • ")
                          : tab === "verified"
                          ? [
                              (r.document_class as string | null) || "document",
                              (r.verification_level as string | null) || null,
                              (r.entity_slug as string | null) || null,
                            ]
                              .filter(Boolean)
                              .join(" • ")
                          : [
                              (r.status as string | null) || "—",
                              (r.source as string | null) || null,
                              archiveByLedgerId.has(id) ? "archived" : "pending archive",
                            ]
                              .filter(Boolean)
                              .join(" • ");

                      const rightBadge =
                        tab === "ledger"
                          ? archiveByLedgerId.has(id)
                            ? { label: "Archived", cls: "bg-amber-200/10 text-amber-200 ring-amber-200/20" }
                            : { label: "Pending", cls: "bg-white/5 text-white/45 ring-white/10" }
                          : verifiedAccent
                          ? { label: "Verified", cls: "bg-amber-200/10 text-amber-200 ring-amber-200/20" }
                          : { label: "Registered", cls: "bg-white/5 text-white/40 ring-white/10" };

                      return (
                        <button
                          key={id}
                          onClick={() => setSelectedId(id)}
                          className={cx(
                            "w-full text-left rounded-2xl px-3 py-3 mb-2 transition ring-1",
                            isActive
                              ? "bg-amber-200/10 ring-amber-200/25"
                              : "bg-white/0 ring-white/5 hover:bg-white/5 hover:ring-white/10"
                          )}
                        >
                          <div className="flex items-start gap-3">
                            <RegistryGlyph
                              kind={glyphKind as any}
                              verified={verifiedAccent}
                            />

                            <div className="min-w-0 flex-1">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="truncate text-[13px] text-white/85">{title}</div>
                                  <div className="truncate text-[11px] text-white/35">{path}</div>
                                </div>

                                <div className="shrink-0 flex items-center gap-2">
                                  <span className={cx("rounded-full px-2 py-1 text-[10px] ring-1", rightBadge.cls)}>
                                    {rightBadge.label}
                                  </span>
                                  <span className="text-[11px] text-white/25">{shortId(id)}</span>
                                </div>
                              </div>

                              <div className="mt-2 text-[11px] text-white/40">{meta || "—"}</div>
                            </div>
                          </div>
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
                    {/* Title + badge */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="text-[14px] text-white/90">
                        {(selected as any).title || (selected as any).storage_path || "Untitled"}
                      </div>

                      {tab === "ledger" ? (
                        (() => {
                          const b = ledgerStatusBadge((selected as GovernanceLedgerRow).status);
                          return <span className={cx("rounded-full px-2 py-1 text-[10px] ring-1", b.cls)}>{b.label}</span>;
                        })()
                      ) : tab === "minute_book" ? (
                        isVerifiedMinuteBook(selected as MinuteBookEntry) ? (
                          <span className="rounded-full bg-amber-200/10 px-2 py-1 text-[10px] text-amber-200 ring-1 ring-amber-200/20">
                            Verified
                          </span>
                        ) : (
                          <span className="rounded-full bg-white/5 px-2 py-1 text-[10px] text-white/40 ring-1 ring-white/10">
                            Registered
                          </span>
                        )
                      ) : isVerifiedDoc(selected as VerifiedDocument) ? (
                        <span className="rounded-full bg-amber-200/10 px-2 py-1 text-[10px] text-amber-200 ring-1 ring-amber-200/20">
                          Verified
                        </span>
                      ) : (
                        <span className="rounded-full bg-white/5 px-2 py-1 text-[10px] text-white/40 ring-1 ring-white/10">
                          Registered
                        </span>
                      )}
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
                            <Field label="Ledger ID" value={(selected as MinuteBookEntry).source_record_id} mono span2 />
                            <Field label="Envelope" value={(selected as MinuteBookEntry).source_envelope_id} mono span2 />
                            <Field label="Hash" value={(selected as MinuteBookEntry).pdf_hash} mono span2 />
                            <Field
                              label="Storage Path"
                              value={normalizeMinuteBookStoragePath((selected as MinuteBookEntry).storage_path)}
                              mono
                              span2
                            />
                          </>
                        ) : tab === "verified" ? (
                          <>
                            <Field label="ID" value={(selected as VerifiedDocument).id} mono />
                            <Field label="Created" value={fmt((selected as VerifiedDocument).created_at)} />
                            <Field label="Signed" value={fmt((selected as VerifiedDocument).signed_at)} />
                            <Field label="Entity" value={(selected as VerifiedDocument).entity_slug} />
                            <Field label="Class" value={(selected as VerifiedDocument).document_class} />
                            <Field label="Purpose" value={(selected as VerifiedDocument).document_purpose} />
                            <Field label="Verify" value={(selected as VerifiedDocument).verification_level} />
                            <Field label="MIME" value={(selected as VerifiedDocument).mime_type} />
                            <Field label="Size" value={bytes((selected as VerifiedDocument).file_size)} />
                            <Field label="Envelope" value={(selected as VerifiedDocument).envelope_id} mono />
                            <Field label="Hash" value={(selected as VerifiedDocument).file_hash} mono span2 />
                            <Field label="Bucket" value={(selected as VerifiedDocument).storage_bucket} mono />
                            <Field label="Storage Path" value={(selected as VerifiedDocument).storage_path} mono span2 />
                          </>
                        ) : (
                          <>
                            <Field label="Ledger ID" value={(selected as GovernanceLedgerRow).id} mono span2 />
                            <Field label="Created" value={fmt((selected as GovernanceLedgerRow).created_at)} />
                            <Field label="Status" value={(selected as GovernanceLedgerRow).status} />
                            <Field label="Source" value={(selected as GovernanceLedgerRow).source} />
                            <Field
                              label="Archive"
                              value={
                                archiveByLedgerId.has((selected as GovernanceLedgerRow).id)
                                  ? `Archived as ${archiveByLedgerId.get((selected as GovernanceLedgerRow).id)!.id}`
                                  : "Not yet archived"
                              }
                              mono
                              span2
                            />
                          </>
                        )}
                      </div>

                      {tab === "minute_book" && (selected as MinuteBookEntry).notes ? (
                        <div className="mt-3 border-t border-white/10 pt-3">
                          <div className="text-[11px] text-white/40">Notes</div>
                          <div className="mt-1 text-[12px] leading-relaxed text-white/70 whitespace-pre-wrap">
                            {(selected as MinuteBookEntry).notes}
                          </div>
                        </div>
                      ) : null}
                    </div>

                    {/* Preview only for storage-backed tabs */}
                    {tab !== "ledger" ? (
                      <>
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

                        <div className="mt-3 overflow-hidden rounded-2xl ring-1 ring-white/10 bg-black/30">
                          <div className="px-3 py-2 text-[11px] text-white/45 border-b border-white/10">Preview</div>

                          {pdfUrl ? (
                            <iframe title="ci-archive-preview" src={pdfUrl} className="h-[360px] w-full" />
                          ) : (
                            <div className="px-3 py-8 text-[12px] text-white/35">
                              Select a record with a PDF to preview.
                            </div>
                          )}
                        </div>

                        <div className="mt-3 text-[11px] text-white/30">
                          If preview is blank: it’s almost always storage policy (SELECT) or a row path/bucket mismatch — not the UI.
                        </div>
                      </>
                    ) : (
                      <div className="mt-3 text-[11px] text-white/30">
                        Ledger drafts preview happens in the drafting/sign flow (Forge/Council). CI-Archive remains registry-only.
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="px-5 pb-5">
            <div className="h-px w-full bg-gradient-to-r from-transparent via-amber-200/10 to-transparent" />
            <div className="mt-3 text-[11px] text-white/30">Oasis Digital Parliament • CI-Archive • registry of record</div>
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
