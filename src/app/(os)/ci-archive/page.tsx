"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import Link from "next/link";
import {
  BookOpen,
  Building2,
  FileCheck2,
  FileSignature,
  FileText,
  Folder,
  Gavel,
  Landmark,
  Receipt,
  ScrollText,
  Search,
  ShieldCheck,
  Share2,
  Users,
} from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/browser";

/**
 * CI-Archive (Registry-only)
 * - Canonical 3-column Oasis OS surface (folders / entries / details)
 * - Minute Book tab is the DIGITAL MINUTE BOOK registry (folders + icons)
 * - Verified tab is the VERIFIED registry (signed/verified artifacts)
 * - Ledger tab is a READ-ONLY window into where Alchemy drafts live (governance_ledger)
 *   and whether a ledger record has been archived into the Minute Book (source_record_id).
 *
 * IMPORTANT: This page does NOT touch Forge logic. It only reads.
 */

type MinuteBookEntry = {
  id: string;
  title: string | null;
  entity_key: string | null;
  storage_path: string | null;
  file_name: string | null;
  entry_type: string | null;
  section_name: string | null;
  notes: string | null;
  pdf_hash: string | null;
  registry_status: string | null;
  source: string | null;

  // links minute book row back to governance_ledger (your verified fix)
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
  file_name: string | null;
  verified_by: string | null;
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

function safeLower(s: unknown) {
  return (typeof s === "string" ? s : "").toLowerCase();
}

/**
 * Normalize storage paths because over time we used both:
 * - holdings/AnnualReturns/x.pdf
 * - minute_book/holdings/AnnualReturns/x.pdf
 */
function normalizeMinuteBookPath(path: string | null) {
  if (!path) return "";
  return path.startsWith("minute_book/") ? path.slice("minute_book/".length) : path;
}

/** Folder inference: entity_key/FOLDER/filename.pdf (fallback: General) */
function inferFolderFromPath(pathRaw: string | null) {
  const path = normalizeMinuteBookPath(pathRaw);
  const parts = path.split("/").filter(Boolean);
  // parts[0] is usually entity_key (holdings/oil/oire)
  const folder = parts.length >= 2 ? parts[1] : "General";
  return folder || "General";
}

/** A stable enterprise folder taxonomy (always shown, even if empty) */
const CANONICAL_FOLDERS: Array<{
  key: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  // used to map legacy folder names -> canonical folder
  aliases: string[];
}> = [
  { key: "Incorporation", label: "Incorporation", icon: Building2, aliases: ["incorporation", "articles", "bylaws"] },
  { key: "AnnualReturns", label: "Annual Returns", icon: Receipt, aliases: ["annualreturns", "annual returns", "annual_return"] },
  { key: "Resolutions", label: "Resolutions", icon: ScrollText, aliases: ["resolutions", "resolution"] },
  { key: "Registers", label: "Registers", icon: BookOpen, aliases: ["registers", "register"] },
  { key: "DirectorsOfficers", label: "Directors & Officers", icon: Users, aliases: ["directors", "officers", "directorsofficers"] },
  { key: "ShareCapital", label: "Share Capital", icon: Share2, aliases: ["shares", "sharecapital", "share capital", "certificates"] },
  { key: "Banking", label: "Banking", icon: Landmark, aliases: ["bank", "banking"] },
  { key: "Tax", label: "Tax", icon: Receipt, aliases: ["tax", "cra", "hst", "corporate_tax"] },
  { key: "Contracts", label: "Contracts", icon: FileSignature, aliases: ["contracts", "agreements", "intercompany"] },
  { key: "Policies", label: "Policies", icon: ShieldCheck, aliases: ["policies", "compliance", "iso"] },
  { key: "General", label: "General", icon: Folder, aliases: ["general", "misc"] },
];

function canonicalizeFolder(folderRaw: string) {
  const f = safeLower(folderRaw).replace(/\s+/g, "");
  const found = CANONICAL_FOLDERS.find((c) => c.aliases.some((a) => safeLower(a).replace(/\s+/g, "") === f));
  // also match by key directly
  const byKey = CANONICAL_FOLDERS.find((c) => safeLower(c.key) === safeLower(folderRaw));
  return found ?? byKey ?? { key: folderRaw, label: folderRaw, icon: Folder, aliases: [folderRaw] };
}

function formatLocal(ts: string | null) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}

function shortId(id: string) {
  if (!id) return "";
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

function statusPill(status: string | null) {
  const s = safeLower(status);
  if (s === "approved") return { label: "Approved", tone: "bg-emerald-500/10 text-emerald-200 border-emerald-400/20" };
  if (s === "drafted" || s === "draft") return { label: "Draft", tone: "bg-slate-500/10 text-slate-200 border-slate-400/20" };
  if (s === "rejected") return { label: "Rejected", tone: "bg-rose-500/10 text-rose-200 border-rose-400/20" };
  if (s === "pending") return { label: "Pending", tone: "bg-amber-500/10 text-amber-200 border-amber-400/20" };
  return { label: status ?? "—", tone: "bg-white/5 text-white/70 border-white/10" };
}

export default function CIArchivePage() {
  const supabase = supabaseBrowser();

  const [activeTab, setActiveTab] = useState<TabKey>("minute_book");
  const [activeFolder, setActiveFolder] = useState<string>("All");
  const [search, setSearch] = useState("");

  const [minuteBook, setMinuteBook] = useState<MinuteBookEntry[]>([]);
  const [verified, setVerified] = useState<VerifiedDocument[]>([]);
  const [ledger, setLedger] = useState<GovernanceLedgerRow[]>([]);

  const [activeEntity, setActiveEntity] = useState<string>("holdings"); // keep OS-consistent default
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const hasLoadedRef = useRef(false);

  useEffect(() => {
    if (hasLoadedRef.current) return;
    hasLoadedRef.current = true;

    (async () => {
      setLoading(true);
      setErr(null);

      try {
        // Minute Book
        const mb = await supabase
          .from("minute_book_entries")
          .select(
            "id,title,entity_key,storage_path,file_name,entry_type,section_name,notes,pdf_hash,registry_status,source,source_record_id,source_envelope_id,created_at,updated_at"
          )
          .order("created_at", { ascending: false });

        if (mb.error) throw mb.error;

        // Verified
        const vd = await supabase
          .from("verified_documents")
          .select(
            "id,title,storage_bucket,storage_path,file_hash,file_name,verified_by,verification_level,envelope_id,signed_at,created_at,updated_at"
          )
          .order("created_at", { ascending: false });

        if (vd.error) throw vd.error;

        // Ledger (Alchemy drafts live here)
        const gl = await supabase
          .from("governance_ledger")
          .select("id,title,status,source,created_at")
          .eq("source", "ci-alchemy")
          .order("created_at", { ascending: false })
          .limit(200);

        if (gl.error) throw gl.error;

        setMinuteBook((mb.data ?? []) as MinuteBookEntry[]);
        setVerified((vd.data ?? []) as VerifiedDocument[]);
        setLedger((gl.data ?? []) as GovernanceLedgerRow[]);
      } catch (e: any) {
        setErr(e?.message ?? "Failed to load CI-Archive data.");
      } finally {
        setLoading(false);
      }
    })();
  }, [supabase]);

  // Which governance_ledger rows have been archived into minute_book_entries?
  const archivedLedgerIds = useMemo(() => {
    const set = new Set<string>();
    for (const r of minuteBook) {
      if (r.source_record_id) set.add(r.source_record_id);
    }
    return set;
  }, [minuteBook]);

  const tabRows = useMemo(() => {
    const q = safeLower(search).trim();

    if (activeTab === "minute_book") {
      const rows = minuteBook
        .filter((r) => safeLower(r.entity_key) === safeLower(activeEntity))
        .map((r) => {
          const folder = canonicalizeFolder(inferFolderFromPath(r.storage_path));
          return { kind: "minute_book" as const, folderKey: folder.key, folderLabel: folder.label, folderIcon: folder.icon, row: r };
        });

      return rows.filter(({ row, folderKey }) => {
        if (activeFolder !== "All" && folderKey !== activeFolder) return false;
        if (!q) return true;
        const hay = [
          row.title,
          row.storage_path,
          row.file_name,
          row.entry_type,
          row.section_name,
          row.registry_status,
          row.source,
          row.notes,
          row.pdf_hash,
          row.id,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      });
    }

    if (activeTab === "verified") {
      const rows = verified.map((r) => {
        // For verified docs, folder is inferred similarly from storage_path, but it might not include entity_key,
        // so we also allow "General".
        const folder = canonicalizeFolder(inferFolderFromPath(r.storage_path));
        return { kind: "verified" as const, folderKey: folder.key, folderLabel: folder.label, folderIcon: folder.icon, row: r };
      });

      return rows.filter(({ row, folderKey }) => {
        if (activeFolder !== "All" && folderKey !== activeFolder) return false;
        if (!q) return true;
        const hay = [
          row.title,
          row.storage_bucket,
          row.storage_path,
          row.file_name,
          row.file_hash,
          row.verification_level,
          row.verified_by,
          row.envelope_id,
          row.id,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      });
    }

    // ledger
    const rows = ledger.map((r) => {
      const status = safeLower(r.status);
      const folderKey =
        activeFolder === "All"
          ? "All"
          : activeFolder;
      // We build folders separately; here we just map
      return { kind: "ledger" as const, folderKey: status || "unknown", folderLabel: r.status ?? "Unknown", folderIcon: Gavel, row: r };
    });

    return rows.filter(({ row }) => {
      // folder filter for ledger is handled via derived folders below using activeFolder
      if (activeFolder !== "All") {
        const s = safeLower(row.status);
        if (activeFolder === "PendingArchive") {
          if (archivedLedgerIds.has(row.id)) return false;
        } else if (activeFolder === "Archived") {
          if (!archivedLedgerIds.has(row.id)) return false;
        } else if (activeFolder === "Approved") {
          if (s !== "approved") return false;
        } else if (activeFolder === "Draft") {
          if (s !== "drafted" && s !== "draft") return false;
        } else if (activeFolder === "Rejected") {
          if (s !== "rejected") return false;
        }
      }

      if (!q) return true;
      const hay = [row.title, row.status, row.source, row.id].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [activeTab, minuteBook, verified, ledger, activeEntity, activeFolder, search, archivedLedgerIds]);

  const folders = useMemo(() => {
    if (activeTab === "ledger") {
      const all = ledger.length;
      const approved = ledger.filter((r) => safeLower(r.status) === "approved").length;
      const drafted = ledger.filter((r) => ["drafted", "draft"].includes(safeLower(r.status))).length;
      const rejected = ledger.filter((r) => safeLower(r.status) === "rejected").length;
      const archived = ledger.filter((r) => archivedLedgerIds.has(r.id)).length;
      const pendingArchive = all - archived;

      return [
        { key: "All", label: "All", icon: Gavel, count: all },
        { key: "PendingArchive", label: "Pending Archive", icon: FileText, count: pendingArchive },
        { key: "Archived", label: "Archived", icon: FileCheck2, count: archived },
        { key: "Approved", label: "Approved", icon: ShieldCheck, count: approved },
        { key: "Draft", label: "Draft", icon: FileText, count: drafted },
        { key: "Rejected", label: "Rejected", icon: Gavel, count: rejected },
      ];
    }

    // Minute book / verified: enterprise taxonomy + counts from data
    const counts = new Map<string, number>();

    const relevant =
      activeTab === "minute_book"
        ? minuteBook.filter((r) => safeLower(r.entity_key) === safeLower(activeEntity)).map((r) => canonicalizeFolder(inferFolderFromPath(r.storage_path)).key)
        : verified.map((r) => canonicalizeFolder(inferFolderFromPath(r.storage_path)).key);

    for (const k of relevant) counts.set(k, (counts.get(k) ?? 0) + 1);

    // include any unknown folders as well (in case someone uploads to new folder)
    const discovered = Array.from(counts.keys())
      .filter((k) => !CANONICAL_FOLDERS.some((c) => c.key === k))
      .sort((a, b) => a.localeCompare(b))
      .map((k) => ({ key: k, label: k, icon: Folder, count: counts.get(k) ?? 0 }));

    const canonical = CANONICAL_FOLDERS.map((c) => ({
      key: c.key,
      label: c.label,
      icon: c.icon,
      count: counts.get(c.key) ?? 0,
    }));

    const allCount = relevant.length;

    return [{ key: "All", label: "All", icon: Folder, count: allCount }, ...canonical, ...discovered];
  }, [activeTab, minuteBook, verified, ledger, activeEntity, archivedLedgerIds]);

  // Keep selected row valid when switching tabs/folders/search
  useEffect(() => {
    if (!selectedId) return;
    const exists = tabRows.some((r: any) => r.row?.id === selectedId);
    if (!exists) setSelectedId(null);
  }, [tabRows, selectedId]);

  const selected = useMemo(() => {
    if (!selectedId) return null;
    const found = tabRows.find((r: any) => r.row?.id === selectedId);
    return found ?? null;
  }, [tabRows, selectedId]);

  // UI bits
  const TabButton = ({ k, label }: { k: TabKey; label: string }) => (
    <button
      onClick={() => {
        setActiveTab(k);
        setActiveFolder("All");
        setSelectedId(null);
        setSearch("");
      }}
      className={cx(
        "px-3 py-1.5 rounded-full text-xs border transition",
        activeTab === k
          ? "bg-[#d6b25e]/15 text-[#f3d68a] border-[#d6b25e]/30 shadow-[0_0_0_1px_rgba(214,178,94,0.12)]"
          : "bg-white/5 text-white/70 border-white/10 hover:bg-white/7"
      )}
    >
      {label}
    </button>
  );

  const FolderRow = ({
    folderKey,
    label,
    Icon,
    count,
  }: {
    folderKey: string;
    label: string;
    Icon: React.ComponentType<{ className?: string }>;
    count: number;
  }) => (
    <button
      onClick={() => {
        setActiveFolder(folderKey);
        setSelectedId(null);
      }}
      className={cx(
        "w-full flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition",
        activeFolder === folderKey
          ? "bg-[#d6b25e]/10 text-white border-[#d6b25e]/20 shadow-[0_0_0_1px_rgba(214,178,94,0.10)]"
          : "bg-white/3 text-white/70 border-white/10 hover:bg-white/5"
      )}
    >
      <Icon className={cx("h-4 w-4", activeFolder === folderKey ? "text-[#f3d68a]" : "text-white/55")} />
      <span className="flex-1 truncate text-left">{label}</span>
      <span className="text-xs px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-white/60">{count}</span>
    </button>
  );

  const EmptyState = ({ title, hint }: { title: string; hint?: string }) => (
    <div className="text-sm text-white/60 px-4 py-6">
      <div className="font-medium text-white/80">{title}</div>
      {hint ? <div className="mt-1 text-white/50">{hint}</div> : null}
    </div>
  );

  const pageShell = "min-h-[calc(100vh-88px)] p-4 md:p-6";
  const panelShell =
    "rounded-2xl border border-white/10 bg-gradient-to-b from-white/5 to-black/20 shadow-[0_20px_80px_rgba(0,0,0,0.45)] overflow-hidden";

  return (
    <div className={pageShell}>
      <div className={panelShell}>
        {/* Header */}
        <div className="px-5 py-4 border-b border-white/10 bg-gradient-to-r from-black/40 to-black/10">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm text-white/70">CI-Archive</div>
              <div className="text-xs text-white/45">Registry vault · strict three-column · Oasis OS signature</div>
            </div>

            <div className="flex items-center gap-2">
              <TabButton k="minute_book" label="Minute Book" />
              <TabButton k="verified" label="Verified" />
              <TabButton k="ledger" label="Ledger" />
              <Link
                href="/ci-archive/upload"
                className="px-3 py-1.5 rounded-full text-xs border bg-[#d6b25e]/15 text-[#f3d68a] border-[#d6b25e]/30 hover:bg-[#d6b25e]/20 transition"
              >
                Upload
              </Link>
            </div>
          </div>

          {/* Context banner */}
          {activeTab === "ledger" ? (
            <div className="mt-3 text-xs text-white/60 bg-black/20 border border-white/10 rounded-xl px-4 py-3">
              <span className="text-[#f3d68a] font-medium">Alchemy drafts live here.</span>{" "}
              Archive appears in <span className="text-white/80">Minute Book</span> only after signature routing creates a{" "}
              <code className="text-white/70">minute_book_entries</code> row linked by{" "}
              <code className="text-white/70">source_record_id</code>.
              <div className="mt-1 text-white/45">
                Pending archive (ci-alchemy stream):{" "}
                <span className="text-white/80 font-medium">{ledger.filter((r) => !archivedLedgerIds.has(r.id)).length}</span>
              </div>
            </div>
          ) : activeTab === "minute_book" ? (
            <div className="mt-3 text-xs text-white/60 bg-black/20 border border-white/10 rounded-xl px-4 py-3">
              <span className="text-[#f3d68a] font-medium">Digital Minute Book Registry.</span>{" "}
              These are the archived, indexed records of the corporation minute book (not drafts). Folder taxonomy is canonical and
              always visible for enterprise clarity.
            </div>
          ) : (
            <div className="mt-3 text-xs text-white/60 bg-black/20 border border-white/10 rounded-xl px-4 py-3">
              <span className="text-[#f3d68a] font-medium">Verified Registry.</span>{" "}
              Signed/verified artifacts with hashes, envelopes, and verification metadata (audit-ready).
            </div>
          )}
        </div>

        {/* Main 3-column surface */}
        <div className="grid grid-cols-12 gap-4 p-4 md:p-5">
          {/* Left: folders */}
          <div className="col-span-12 md:col-span-3">
            <div className="rounded-2xl border border-white/10 bg-black/25 overflow-hidden">
              <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
                <div className="text-xs text-white/55 tracking-wide">FOLDERS</div>
                {activeTab === "minute_book" ? (
                  <div className="text-[11px] text-white/50">
                    Entity: <span className="text-white/75 font-medium">{activeEntity}</span>
                  </div>
                ) : null}
              </div>

              <div className="p-2 space-y-2 max-h-[56vh] overflow-auto">
                {folders.map((f) => (
                  <FolderRow key={f.key} folderKey={f.key} label={f.label} Icon={f.icon} count={f.count} />
                ))}
              </div>

              {activeTab === "minute_book" ? (
                <div className="px-4 py-3 border-t border-white/10 text-[11px] text-white/45">
                  This is the <span className="text-white/70">minute book</span>. Not drafts. Drafts live in{" "}
                  <span className="text-white/70">Ledger</span>.
                </div>
              ) : null}
            </div>
          </div>

          {/* Middle: entries */}
          <div className="col-span-12 md:col-span-5">
            <div className="rounded-2xl border border-white/10 bg-black/25 overflow-hidden">
              <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between gap-3">
                <div className="text-xs text-white/55 tracking-wide">
                  ENTRIES <span className="text-white/35">·</span>{" "}
                  <span className="text-white/70">{tabRows.length}</span>
                </div>

                <div className="relative w-full max-w-[320px]">
                  <Search className="absolute left-3 top-2.5 h-4 w-4 text-white/35" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={
                      activeTab === "ledger"
                        ? "Search title, status, id…"
                        : activeTab === "verified"
                        ? "Search title, path, hash…"
                        : "Search title, folder, path, hash…"
                    }
                    className="w-full pl-9 pr-3 py-2 rounded-xl text-sm bg-black/40 border border-white/10 text-white/80 placeholder:text-white/35 focus:outline-none focus:ring-2 focus:ring-[#d6b25e]/20"
                  />
                </div>
              </div>

              <div className="max-h-[56vh] overflow-auto">
                {loading ? (
                  <EmptyState title="Loading registry…" />
                ) : err ? (
                  <EmptyState title="Failed to load CI-Archive." hint={err} />
                ) : tabRows.length === 0 ? (
                  <EmptyState
                    title="No entries found."
                    hint={
                      activeTab === "minute_book"
                        ? "If you expect items here, confirm minute_book_entries has rows for this entity_key."
                        : activeTab === "verified"
                        ? "If you expect items here, confirm verified_documents has rows."
                        : "If you expect items here, confirm governance_ledger rows exist for source = 'ci-alchemy'."
                    }
                  />
                ) : (
                  <div className="p-2 space-y-2">
                    {tabRows.map((item: any) => {
                      if (item.kind === "minute_book") {
                        const r: MinuteBookEntry = item.row;
                        const Icon = item.folderIcon ?? FileText;
                        const pill = statusPill(r.registry_status ?? r.entry_type ?? "—");
                        return (
                          <button
                            key={r.id}
                            onClick={() => setSelectedId(r.id)}
                            className={cx(
                              "w-full text-left rounded-2xl border px-4 py-3 transition",
                              selectedId === r.id
                                ? "bg-white/6 border-[#d6b25e]/25 shadow-[0_0_0_1px_rgba(214,178,94,0.12)]"
                                : "bg-white/3 border-white/10 hover:bg-white/5"
                            )}
                          >
                            <div className="flex items-start gap-3">
                              <div className="mt-0.5 h-8 w-8 rounded-xl bg-black/35 border border-white/10 flex items-center justify-center">
                                <Icon className="h-4 w-4 text-[#f3d68a]" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <div className="font-medium text-white/90 truncate">{r.title ?? "Untitled"}</div>
                                  <span className={cx("text-[11px] px-2 py-0.5 rounded-full border", pill.tone)}>
                                    {pill.label}
                                  </span>
                                </div>
                                <div className="mt-1 text-xs text-white/50 truncate">
                                  {normalizeMinuteBookPath(r.storage_path) || "—"}
                                </div>
                                <div className="mt-1 text-[11px] text-white/35">
                                  {item.folderLabel} · {formatLocal(r.created_at)}
                                </div>
                              </div>
                              <div className="text-[11px] text-white/40">{shortId(r.id)}</div>
                            </div>
                          </button>
                        );
                      }

                      if (item.kind === "verified") {
                        const r: VerifiedDocument = item.row;
                        const Icon = item.folderIcon ?? FileCheck2;
                        const pill = statusPill(r.verification_level ?? "Verified");
                        return (
                          <button
                            key={r.id}
                            onClick={() => setSelectedId(r.id)}
                            className={cx(
                              "w-full text-left rounded-2xl border px-4 py-3 transition",
                              selectedId === r.id
                                ? "bg-white/6 border-[#d6b25e]/25 shadow-[0_0_0_1px_rgba(214,178,94,0.12)]"
                                : "bg-white/3 border-white/10 hover:bg-white/5"
                            )}
                          >
                            <div className="flex items-start gap-3">
                              <div className="mt-0.5 h-8 w-8 rounded-xl bg-black/35 border border-white/10 flex items-center justify-center">
                                <Icon className="h-4 w-4 text-[#f3d68a]" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <div className="font-medium text-white/90 truncate">{r.title ?? "Untitled"}</div>
                                  <span className={cx("text-[11px] px-2 py-0.5 rounded-full border", pill.tone)}>
                                    {pill.label}
                                  </span>
                                </div>
                                <div className="mt-1 text-xs text-white/50 truncate">{r.storage_path ?? "—"}</div>
                                <div className="mt-1 text-[11px] text-white/35">
                                  {formatLocal(r.created_at)} · hash {r.file_hash ? shortId(r.file_hash) : "—"}
                                </div>
                              </div>
                              <div className="text-[11px] text-white/40">{shortId(r.id)}</div>
                            </div>
                          </button>
                        );
                      }

                      // ledger row
                      const r: GovernanceLedgerRow = item.row;
                      const pill = statusPill(r.status);
                      const archived = archivedLedgerIds.has(r.id);
                      return (
                        <button
                          key={r.id}
                          onClick={() => setSelectedId(r.id)}
                          className={cx(
                            "w-full text-left rounded-2xl border px-4 py-3 transition",
                            selectedId === r.id
                              ? "bg-white/6 border-[#d6b25e]/25 shadow-[0_0_0_1px_rgba(214,178,94,0.12)]"
                              : "bg-white/3 border-white/10 hover:bg-white/5"
                          )}
                        >
                          <div className="flex items-start gap-3">
                            <div className="mt-0.5 h-8 w-8 rounded-xl bg-black/35 border border-white/10 flex items-center justify-center">
                              <Gavel className="h-4 w-4 text-[#f3d68a]" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <div className="font-medium text-white/90 truncate">{r.title ?? "Untitled Draft"}</div>
                                <span className={cx("text-[11px] px-2 py-0.5 rounded-full border", pill.tone)}>{pill.label}</span>
                                <span
                                  className={cx(
                                    "text-[11px] px-2 py-0.5 rounded-full border",
                                    archived
                                      ? "bg-emerald-500/10 text-emerald-200 border-emerald-400/20"
                                      : "bg-white/5 text-white/60 border-white/10"
                                  )}
                                >
                                  {archived ? "Archived" : "Pending"}
                                </span>
                              </div>
                              <div className="mt-1 text-xs text-white/50 truncate">governance_ledger · source {r.source ?? "—"}</div>
                              <div className="mt-1 text-[11px] text-white/35">{formatLocal(r.created_at)}</div>
                            </div>
                            <div className="text-[11px] text-white/40">{shortId(r.id)}</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right: details */}
          <div className="col-span-12 md:col-span-4">
            <div className="rounded-2xl border border-white/10 bg-black/25 overflow-hidden">
              <div className="px-4 py-3 border-b border-white/10 text-xs text-white/55 tracking-wide">DETAILS</div>

              {!selected ? (
                <EmptyState title="Select an entry." hint="Registry-only view. No destructive actions here." />
              ) : selected.kind === "minute_book" ? (
                <MinuteBookDetails row={selected.row as MinuteBookEntry} />
              ) : selected.kind === "verified" ? (
                <VerifiedDetails row={selected.row as VerifiedDocument} />
              ) : (
                <LedgerDetails row={selected.row as GovernanceLedgerRow} archived={archivedLedgerIds.has((selected.row as GovernanceLedgerRow).id)} />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function DetailShell({ children }: { children: React.ReactNode }) {
  return <div className="p-4 space-y-3 text-sm text-white/80">{children}</div>;
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="text-xs text-white/45">{label}</div>
      <div className="text-xs text-white/80 text-right break-all">{value}</div>
    </div>
  );
}

function MinuteBookDetails({ row }: { row: MinuteBookEntry }) {
  const folder = canonicalizeFolder(inferFolderFromPath(row.storage_path));
  const pill = statusPill(row.registry_status ?? row.entry_type ?? "—");

  return (
    <DetailShell>
      <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-white/90 truncate">{row.title ?? "Untitled"}</div>
            <div className="mt-1 text-xs text-white/50 truncate">{normalizeMinuteBookPath(row.storage_path) || "—"}</div>
            <div className="mt-2 text-[11px] text-white/40">
              <span className="text-white/65">{folder.label}</span> · {formatLocal(row.created_at)}
            </div>
          </div>
          <span className={cx("text-[11px] px-2 py-0.5 rounded-full border", pill.tone)}>{pill.label}</span>
        </div>
      </div>

      <DetailRow label="Entry ID" value={row.id} />
      <DetailRow label="Entity" value={row.entity_key ?? "—"} />
      <DetailRow label="Folder" value={folder.label} />
      <DetailRow label="File name" value={row.file_name ?? "—"} />
      <DetailRow label="PDF hash" value={row.pdf_hash ? row.pdf_hash : "—"} />
      <DetailRow label="Source" value={row.source ?? "—"} />
      <DetailRow label="Source record (ledger)" value={row.source_record_id ?? "—"} />
      <DetailRow label="Envelope" value={row.source_envelope_id ?? "—"} />
      {row.notes ? (
        <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
          <div className="text-xs text-white/45">Notes</div>
          <div className="mt-2 text-xs text-white/75 whitespace-pre-wrap">{row.notes}</div>
        </div>
      ) : null}
    </DetailShell>
  );
}

function VerifiedDetails({ row }: { row: VerifiedDocument }) {
  const folder = canonicalizeFolder(inferFolderFromPath(row.storage_path));
  const pill = statusPill(row.verification_level ?? "Verified");

  return (
    <DetailShell>
      <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-white/90 truncate">{row.title ?? "Untitled"}</div>
            <div className="mt-1 text-xs text-white/50 truncate">{row.storage_path ?? "—"}</div>
            <div className="mt-2 text-[11px] text-white/40">
              <span className="text-white/65">{folder.label}</span> · {formatLocal(row.created_at)}
            </div>
          </div>
          <span className={cx("text-[11px] px-2 py-0.5 rounded-full border", pill.tone)}>{pill.label}</span>
        </div>
      </div>

      <DetailRow label="Verified ID" value={row.id} />
      <DetailRow label="Bucket" value={row.storage_bucket ?? "—"} />
      <DetailRow label="File name" value={row.file_name ?? "—"} />
      <DetailRow label="File hash" value={row.file_hash ?? "—"} />
      <DetailRow label="Verification level" value={row.verification_level ?? "—"} />
      <DetailRow label="Envelope" value={row.envelope_id ?? "—"} />
      <DetailRow label="Signed at" value={row.signed_at ? formatLocal(row.signed_at) : "—"} />
    </DetailShell>
  );
}

function LedgerDetails({ row, archived }: { row: GovernanceLedgerRow; archived: boolean }) {
  const pill = statusPill(row.status);

  return (
    <DetailShell>
      <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-white/90 truncate">{row.title ?? "Untitled Draft"}</div>
            <div className="mt-1 text-xs text-white/50 truncate">governance_ledger · source {row.source ?? "—"}</div>
            <div className="mt-2 text-[11px] text-white/40">{formatLocal(row.created_at)}</div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <span className={cx("text-[11px] px-2 py-0.5 rounded-full border", pill.tone)}>{pill.label}</span>
            <span
              className={cx(
                "text-[11px] px-2 py-0.5 rounded-full border",
                archived ? "bg-emerald-500/10 text-emerald-200 border-emerald-400/20" : "bg-white/5 text-white/60 border-white/10"
              )}
            >
              {archived ? "Archived" : "Not yet archived"}
            </span>
          </div>
        </div>
      </div>

      <DetailRow label="Ledger ID" value={row.id} />
      <DetailRow label="Status" value={row.status ?? "—"} />
      <DetailRow label="Source" value={row.source ?? "—"} />
      <div className="text-[11px] text-white/45">
        Ledger drafts preview happens in the drafting/sign flow (Forge/Council). CI-Archive remains registry-only.
      </div>
    </DetailShell>
  );
}
