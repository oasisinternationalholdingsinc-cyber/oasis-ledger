"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/browser";
import {
  Building2,
  FileText,
  Folder,
  Landmark,
  Scale,
  ShieldCheck,
  Users,
  Wallet,
  Briefcase,
  ScrollText,
  BadgeCheck,
  XCircle,
  Clock,
  CheckCircle2,
  Pencil,
} from "lucide-react";

/**
 * CI-Archive (Registry-only)
 * - Canonical 3-column Oasis OS surface (never stacked)
 * - Minute Book = digital minute book registry (canonical folders always visible)
 * - Verified = signed/verified artifacts registry (audit-ready)
 * - Ledger = visibility into where Alchemy drafts live (does NOT alter Forge/Council flows)
 *
 * IMPORTANT:
 * Supabase schemas/columns can drift. This page must NEVER rely on specific columns existing.
 * So: select("*") + safe mapping + client-side filtering.
 */

type AnyRow = Record<string, any>;

type TabKey = "minute_book" | "verified" | "ledger";

type CanonFolderKey =
  | "All"
  | "Incorporation"
  | "Annual Returns"
  | "Resolutions"
  | "Registers"
  | "Directors & Officers"
  | "Share Capital"
  | "Banking"
  | "Tax"
  | "Contracts"
  | "Policies"
  | "General";

const CANON_FOLDERS: Array<{
  key: CanonFolderKey;
  label: string;
  icon: any;
}> = [
  { key: "All", label: "All", icon: Folder },
  { key: "Incorporation", label: "Incorporation", icon: Building2 },
  { key: "Annual Returns", label: "Annual Returns", icon: ScrollText },
  { key: "Resolutions", label: "Resolutions", icon: FileText },
  { key: "Registers", label: "Registers", icon: Landmark },
  { key: "Directors & Officers", label: "Directors & Officers", icon: Users },
  { key: "Share Capital", label: "Share Capital", icon: Wallet },
  { key: "Banking", label: "Banking", icon: Landmark },
  { key: "Tax", label: "Tax", icon: Scale },
  { key: "Contracts", label: "Contracts", icon: Briefcase },
  { key: "Policies", label: "Policies", icon: ShieldCheck },
  { key: "General", label: "General", icon: Folder },
];

type LedgerFolderKey =
  | "All"
  | "Pending Archive"
  | "Archived"
  | "Approved"
  | "Draft"
  | "Rejected";

const LEDGER_FOLDERS: Array<{ key: LedgerFolderKey; icon: any }> = [
  { key: "All", icon: Folder },
  { key: "Pending Archive", icon: Clock },
  { key: "Archived", icon: CheckCircle2 },
  { key: "Approved", icon: BadgeCheck },
  { key: "Draft", icon: Pencil },
  { key: "Rejected", icon: XCircle },
];

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function safeLower(v: any) {
  return String(v ?? "").toLowerCase();
}

function getId(r: AnyRow) {
  return r.id ?? r.record_id ?? r.uuid ?? null;
}

function getTitle(r: AnyRow) {
  return (
    r.title ??
    r.name ??
    r.document_title ??
    r.file_title ??
    r.filename ??
    r.file_name ??
    r.storage_path ??
    "Untitled"
  );
}

function getCreatedAt(r: AnyRow) {
  return r.created_at ?? r.createdAt ?? r.inserted_at ?? r.updated_at ?? null;
}

function getStoragePath(r: AnyRow) {
  return r.storage_path ?? r.path ?? r.file_path ?? r.storagePath ?? r.object_path ?? null;
}

function getHash(r: AnyRow) {
  return r.pdf_hash ?? r.file_hash ?? r.hash ?? r.sha256 ?? r.document_hash ?? null;
}

function getSourceRecordId(r: AnyRow) {
  // minute_book_entries link back to governance_ledger via this field (your fix)
  return r.source_record_id ?? r.sourceRecordId ?? null;
}

function getEntityKeyFromRow(r: AnyRow) {
  // could be entity_key, entity_slug, entity, or nothing
  return r.entity_key ?? r.entityKey ?? r.entity_slug ?? r.entitySlug ?? r.entity ?? null;
}

function normalizeEntityKey(v: any) {
  const s = String(v ?? "").trim();
  return s.length ? s : null;
}

/**
 * Classify a storage_path into canonical minute book folders.
 * Works with:
 * - holdings/AnnualReturns/...
 * - holdings/Resolutions/...
 * - minute_book/holdings/...
 * - OIH/Resolutions/...
 */
function classifyCanonicalFolderFromPath(storagePath: string | null): CanonFolderKey {
  if (!storagePath) return "General";

  const p = storagePath.replace(/\\/g, "/");
  const parts = p.split("/").filter(Boolean);

  // Remove optional "minute_book" prefix
  const cleaned = parts[0] === "minute_book" ? parts.slice(1) : parts;

  const joined = cleaned.join("/").toLowerCase();

  const has = (needle: string) => joined.includes(needle.toLowerCase());

  if (has("incorporation") || has("incorp") || has("articles")) return "Incorporation";
  if (has("annualreturns") || has("annual_returns") || has("annual return")) return "Annual Returns";
  if (has("resolutions") || has("/resolution")) return "Resolutions";
  if (has("register") || has("registers")) return "Registers";
  if (has("directors") || has("officers")) return "Directors & Officers";
  if (has("share") || has("capital") || has("securities")) return "Share Capital";
  if (has("bank") || has("banking")) return "Banking";
  if (has("tax") || has("hst") || has("cra")) return "Tax";
  if (has("contract") || has("agreement") || has("loa") || has("nda")) return "Contracts";
  if (has("policy") || has("policies")) return "Policies";

  return "General";
}

function ledgerStatusKey(r: AnyRow): string {
  return String(r.status ?? r.ledger_status ?? r.state ?? "").toUpperCase();
}

function isLedgerApproved(r: AnyRow) {
  const s = ledgerStatusKey(r);
  return s === "APPROVED";
}

function isLedgerDraft(r: AnyRow) {
  const s = ledgerStatusKey(r);
  return s === "DRAFT" || s === "DRAFTED";
}

function isLedgerRejected(r: AnyRow) {
  const s = ledgerStatusKey(r);
  return s === "REJECTED";
}

export default function CIArchivePage() {
  const supabase = supabaseBrowser();

  // Entity selection: try URL first, then localStorage, then default to holdings
  const [entityKey, setEntityKey] = useState<string>("holdings");

  useEffect(() => {
    const url = new URL(window.location.href);
    const qEntity = url.searchParams.get("entity");
    const lsEntity = window.localStorage.getItem("oasis_entity_key") || window.localStorage.getItem("entity_key");
    setEntityKey((qEntity || lsEntity || "holdings").trim() || "holdings");
  }, []);

  const [tab, setTab] = useState<TabKey>("minute_book");
  const [folderCanon, setFolderCanon] = useState<CanonFolderKey>("All");
  const [folderLedger, setFolderLedger] = useState<LedgerFolderKey>("All");
  const [query, setQuery] = useState("");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [minuteRows, setMinuteRows] = useState<AnyRow[]>([]);
  const [verifiedRows, setVerifiedRows] = useState<AnyRow[]>([]);
  const [ledgerRows, setLedgerRows] = useState<AnyRow[]>([]);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Reset folder when switching tabs
  useEffect(() => {
    setQuery("");
    if (tab === "minute_book") setFolderCanon("All");
    if (tab === "verified") setFolderCanon("All");
    if (tab === "ledger") setFolderLedger("All");
  }, [tab]);

  // Load all registries safely
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        // 1) Minute book entries
        // IMPORTANT: do not select explicit columns (schema drift). Use "*".
        const mb = await supabase
          .from("minute_book_entries")
          .select("*")
          .order("created_at", { ascending: false });

        if (mb.error) throw mb.error;

        // 2) Verified documents
        // IMPORTANT: schema drift. Use "*".
        const vd = await supabase
          .from("verified_documents")
          .select("*")
          .order("created_at", { ascending: false });

        // Some environments may not have verified_documents yet:
        // In that case, don't fail the whole screen.
        const verifiedData = vd.error ? [] : (vd.data ?? []);

        // 3) Governance ledger (Alchemy drafts live here)
        const gl = await supabase
          .from("governance_ledger")
          .select("*")
          .order("created_at", { ascending: false });

        const ledgerData = gl.error ? [] : (gl.data ?? []);

        if (!cancelled && mounted.current) {
          setMinuteRows((mb.data as AnyRow[]) ?? []);
          setVerifiedRows((verifiedData as AnyRow[]) ?? []);
          setLedgerRows((ledgerData as AnyRow[]) ?? []);
        }
      } catch (e: any) {
        if (!cancelled && mounted.current) {
          setError(e?.message ?? "Failed to load CI-Archive.");
        }
      } finally {
        if (!cancelled && mounted.current) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  // Build archived set (minute_book_entries.source_record_id -> governance_ledger.id)
  const archivedLedgerIds = useMemo(() => {
    const s = new Set<string>();
    for (const r of minuteRows) {
      const id = getSourceRecordId(r);
      if (id) s.add(String(id));
    }
    return s;
  }, [minuteRows]);

  // Filter by entity where possible (client-side, because schemas drift)
  const minuteRowsScoped = useMemo(() => {
    const ek = normalizeEntityKey(entityKey);
    if (!ek) return minuteRows;

    return minuteRows.filter((r) => {
      const rk = normalizeEntityKey(getEntityKeyFromRow(r));
      // If row has entity key, enforce match; if not, allow (older rows)
      return rk ? rk === ek : true;
    });
  }, [minuteRows, entityKey]);

  const verifiedRowsScoped = useMemo(() => {
    const ek = normalizeEntityKey(entityKey);
    if (!ek) return verifiedRows;

    return verifiedRows.filter((r) => {
      const rk = normalizeEntityKey(getEntityKeyFromRow(r));
      // If verified docs store only entity_id (uuid), we can't match; allow row but it will still classify by path.
      return rk ? rk === ek : true;
    });
  }, [verifiedRows, entityKey]);

  const ledgerRowsScoped = useMemo(() => {
    const ek = normalizeEntityKey(entityKey);
    if (!ek) return ledgerRows;

    return ledgerRows.filter((r) => {
      const rk = normalizeEntityKey(getEntityKeyFromRow(r));
      return rk ? rk === ek : true;
    });
  }, [ledgerRows, entityKey]);

  // Canonical folder counts (Minute/Verified share same folder list)
  function buildCanonCounts(rows: AnyRow[]) {
    const counts: Record<CanonFolderKey, number> = {} as any;
    for (const f of CANON_FOLDERS) counts[f.key] = 0;

    for (const r of rows) {
      const key = classifyCanonicalFolderFromPath(getStoragePath(r));
      counts[key] += 1;
      counts["All"] += 1;
    }
    return counts;
  }

  const canonCountsMinute = useMemo(() => buildCanonCounts(minuteRowsScoped), [minuteRowsScoped]);
  const canonCountsVerified = useMemo(() => buildCanonCounts(verifiedRowsScoped), [verifiedRowsScoped]);

  const ledgerCounts = useMemo(() => {
    const c: Record<LedgerFolderKey, number> = {
      All: 0,
      "Pending Archive": 0,
      Archived: 0,
      Approved: 0,
      Draft: 0,
      Rejected: 0,
    };

    for (const r of ledgerRowsScoped) {
      const id = String(getId(r) ?? "");
      const archived = id && archivedLedgerIds.has(id);

      c.All += 1;
      if (archived) c.Archived += 1;
      if (isLedgerApproved(r)) c.Approved += 1;
      if (isLedgerDraft(r)) c.Draft += 1;
      if (isLedgerRejected(r)) c.Rejected += 1;

      // Pending Archive = APPROVED but not yet archived
      if (isLedgerApproved(r) && !archived) c["Pending Archive"] += 1;
    }

    return c;
  }, [ledgerRowsScoped, archivedLedgerIds]);

  // Build visible entries list
  const visibleRows = useMemo(() => {
    const q = safeLower(query);

    if (tab === "minute_book") {
      const rows = minuteRowsScoped.filter((r) => {
        const path = getStoragePath(r);
        const f = classifyCanonicalFolderFromPath(path);
        if (folderCanon !== "All" && f !== folderCanon) return false;

        const hay = [
          getTitle(r),
          path,
          getHash(r),
          getId(r),
          getEntityKeyFromRow(r),
          getSourceRecordId(r),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        return q ? hay.includes(q) : true;
      });

      return rows;
    }

    if (tab === "verified") {
      const rows = verifiedRowsScoped.filter((r) => {
        const path = getStoragePath(r);
        const f = classifyCanonicalFolderFromPath(path);
        if (folderCanon !== "All" && f !== folderCanon) return false;

        const hay = [getTitle(r), path, getHash(r), getId(r), getEntityKeyFromRow(r)]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        return q ? hay.includes(q) : true;
      });

      return rows;
    }

    // ledger
    const rows = ledgerRowsScoped.filter((r) => {
      const id = String(getId(r) ?? "");
      const archived = id && archivedLedgerIds.has(id);

      if (folderLedger === "Archived" && !archived) return false;
      if (folderLedger === "Pending Archive" && !(isLedgerApproved(r) && !archived)) return false;
      if (folderLedger === "Approved" && !isLedgerApproved(r)) return false;
      if (folderLedger === "Draft" && !isLedgerDraft(r)) return false;
      if (folderLedger === "Rejected" && !isLedgerRejected(r)) return false;

      const hay = [
        getTitle(r),
        r.status,
        r.source,
        getId(r),
        getEntityKeyFromRow(r),
        archived ? "archived" : "not archived",
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return q ? hay.includes(q) : true;
    });

    return rows;
  }, [
    tab,
    query,
    folderCanon,
    folderLedger,
    minuteRowsScoped,
    verifiedRowsScoped,
    ledgerRowsScoped,
    archivedLedgerIds,
  ]);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selectedRow = useMemo(() => {
    if (!selectedId) return null;
    return visibleRows.find((r) => String(getId(r)) === String(selectedId)) ?? null;
  }, [selectedId, visibleRows]);

  useEffect(() => {
    setSelectedId(null);
  }, [tab, folderCanon, folderLedger, query]);

  // UI helpers
  const bannerTitle =
    tab === "minute_book"
      ? "Digital Minute Book Registry."
      : tab === "verified"
        ? "Verified Registry."
        : "Alchemy drafts live here.";

  const bannerBody =
    tab === "minute_book"
      ? "These are the archived, indexed records (not drafts). Canonical folder taxonomy is always visible for enterprise clarity."
      : tab === "verified"
        ? "Signed/verified artifacts with hashes + verification metadata (audit-ready)."
        : "Archive appears in Minute Book only after signature routing creates a minute_book_entries row linked by source_record_id.";

  const pendingArchiveCount =
    tab === "ledger" ? ledgerCounts["Pending Archive"] : 0;

  // Styling (Oasis dark + gold)
  const Shell = ({ children }: { children: React.ReactNode }) => (
    <div className="min-h-[calc(100vh-96px)] w-full px-6 py-6">
      <div className="mx-auto w-full max-w-[1400px]">{children}</div>
    </div>
  );

  return (
    <Shell>
      <div className="rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.06] to-white/[0.02] shadow-[0_0_0_1px_rgba(255,255,255,0.04),0_30px_80px_-40px_rgba(0,0,0,0.8)]">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-white/10 px-6 py-5">
          <div>
            <div className="text-[14px] font-semibold text-white/90">CI-Archive</div>
            <div className="text-[12px] text-white/55">
              Registry vault • strict three-column • Oasis OS signature
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-full border border-white/10 bg-white/[0.03] p-1">
              <button
                onClick={() => setTab("minute_book")}
                className={cx(
                  "rounded-full px-3 py-1.5 text-[12px] transition",
                  tab === "minute_book"
                    ? "bg-[rgba(212,175,55,0.18)] text-[rgb(212,175,55)] shadow-[0_0_0_1px_rgba(212,175,55,0.25)]"
                    : "text-white/70 hover:text-white"
                )}
              >
                Minute Book
              </button>
              <button
                onClick={() => setTab("verified")}
                className={cx(
                  "rounded-full px-3 py-1.5 text-[12px] transition",
                  tab === "verified"
                    ? "bg-[rgba(212,175,55,0.18)] text-[rgb(212,175,55)] shadow-[0_0_0_1px_rgba(212,175,55,0.25)]"
                    : "text-white/70 hover:text-white"
                )}
              >
                Verified
              </button>
              <button
                onClick={() => setTab("ledger")}
                className={cx(
                  "rounded-full px-3 py-1.5 text-[12px] transition",
                  tab === "ledger"
                    ? "bg-[rgba(212,175,55,0.18)] text-[rgb(212,175,55)] shadow-[0_0_0_1px_rgba(212,175,55,0.25)]"
                    : "text-white/70 hover:text-white"
                )}
              >
                Ledger
              </button>
            </div>

            <Link
              href="/ci-archive/upload"
              className="rounded-full border border-[rgba(212,175,55,0.25)] bg-[rgba(212,175,55,0.10)] px-4 py-2 text-[12px] font-semibold text-[rgb(212,175,55)] hover:bg-[rgba(212,175,55,0.14)]"
            >
              Upload
            </Link>
          </div>
        </div>

        {/* Banner */}
        <div className="px-6 py-4">
          <div className="rounded-xl border border-[rgba(212,175,55,0.18)] bg-[rgba(212,175,55,0.06)] px-4 py-3">
            <div className="text-[13px] font-semibold text-[rgb(212,175,55)]">
              {bannerTitle}{" "}
              <span className="font-normal text-white/70">{bannerBody}</span>
            </div>
            {tab === "ledger" ? (
              <div className="mt-1 text-[12px] text-white/60">
                Pending archive (ci-alchemy stream):{" "}
                <span className="text-white/85">{pendingArchiveCount}</span>
              </div>
            ) : (
              <div className="mt-1 text-[12px] text-white/60">
                Entity: <span className="text-white/85">{entityKey}</span>
              </div>
            )}
          </div>

          {error ? (
            <div className="mt-3 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-[12px] text-red-200">
              <div className="font-semibold">Failed to load CI-Archive.</div>
              <div className="opacity-90">{error}</div>
            </div>
          ) : null}
        </div>

        {/* 3-column layout */}
        <div className="grid grid-cols-[360px_1fr_420px] gap-4 px-6 pb-6">
          {/* LEFT: FOLDERS */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-3">
            <div className="mb-2 flex items-center justify-between px-2">
              <div className="text-[11px] font-semibold tracking-wide text-white/55">
                FOLDERS
              </div>
              <div className="text-[11px] text-white/45">
                {tab === "ledger" ? `Entity: ${entityKey}` : `Entity: ${entityKey}`}
              </div>
            </div>

            <div className="max-h-[520px] overflow-auto pr-1">
              {tab === "ledger" ? (
                <div className="space-y-1">
                  {LEDGER_FOLDERS.map((f) => {
                    const Icon = f.icon;
                    const count = ledgerCounts[f.key];
                    const active = folderLedger === f.key;
                    return (
                      <button
                        key={f.key}
                        onClick={() => setFolderLedger(f.key)}
                        className={cx(
                          "flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left transition",
                          active
                            ? "border-[rgba(212,175,55,0.28)] bg-[rgba(212,175,55,0.08)]"
                            : "border-white/10 bg-white/[0.01] hover:bg-white/[0.03]"
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <Icon
                            size={16}
                            className={cx(
                              active ? "text-[rgb(212,175,55)]" : "text-white/55"
                            )}
                          />
                          <div className={cx("text-[13px]", active ? "text-white" : "text-white/80")}>
                            {f.key}
                          </div>
                        </div>
                        <div className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[11px] text-white/70">
                          {count}
                        </div>
                      </button>
                    );
                  })}
                  <div className="px-2 pt-2 text-[11px] text-white/50">
                    Ledger visibility only. Forge/Council flows remain unchanged.
                  </div>
                </div>
              ) : (
                <div className="space-y-1">
                  {(tab === "minute_book" ? CANON_FOLDERS : CANON_FOLDERS).map((f) => {
                    const Icon = f.icon;
                    const counts = tab === "minute_book" ? canonCountsMinute : canonCountsVerified;
                    const count = counts[f.key];
                    const active = folderCanon === f.key;
                    return (
                      <button
                        key={f.key}
                        onClick={() => setFolderCanon(f.key)}
                        className={cx(
                          "flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left transition",
                          active
                            ? "border-[rgba(212,175,55,0.28)] bg-[rgba(212,175,55,0.08)]"
                            : "border-white/10 bg-white/[0.01] hover:bg-white/[0.03]"
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <Icon
                            size={16}
                            className={cx(
                              active ? "text-[rgb(212,175,55)]" : "text-white/55"
                            )}
                          />
                          <div className={cx("text-[13px]", active ? "text-white" : "text-white/80")}>
                            {f.label}
                          </div>
                        </div>
                        <div className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[11px] text-white/70">
                          {count}
                        </div>
                      </button>
                    );
                  })}
                  <div className="px-2 pt-2 text-[11px] text-white/50">
                    {tab === "minute_book"
                      ? "This is the minute book. Not drafts. Drafts live in Ledger."
                      : "Verified artifacts are audit-ready. Registry-only view."}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* MIDDLE: ENTRIES */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-3">
            <div className="mb-2 flex items-center justify-between gap-3 px-2">
              <div className="text-[11px] font-semibold tracking-wide text-white/55">
                ENTRIES • {loading ? "…" : visibleRows.length}
              </div>

              <div className="relative w-[420px] max-w-full">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={
                    tab === "ledger"
                      ? "Search title, status, id…"
                      : "Search title, folder, path, hash…"
                  }
                  className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-[12px] text-white/85 placeholder:text-white/35 outline-none focus:border-[rgba(212,175,55,0.28)]"
                />
              </div>
            </div>

            <div className="max-h-[560px] overflow-auto pr-1">
              {loading ? (
                <div className="px-2 py-6 text-[12px] text-white/55">Loading…</div>
              ) : visibleRows.length === 0 ? (
                <div className="px-2 py-6 text-[12px] text-white/55">No entries found.</div>
              ) : (
                <div className="space-y-2">
                  {visibleRows.map((r) => {
                    const id = String(getId(r) ?? "");
                    const title = getTitle(r);
                    const path = getStoragePath(r);
                    const createdAt = getCreatedAt(r);
                    const hash = getHash(r);

                    // ledger extras
                    const archived = tab === "ledger" ? archivedLedgerIds.has(id) : false;
                    const status = tab === "ledger" ? (r.status ?? r.ledger_status ?? r.state ?? "") : null;

                    const active = selectedId === id;

                    return (
                      <button
                        key={id}
                        onClick={() => setSelectedId(id)}
                        className={cx(
                          "w-full rounded-2xl border p-3 text-left transition",
                          active
                            ? "border-[rgba(212,175,55,0.28)] bg-[rgba(212,175,55,0.06)]"
                            : "border-white/10 bg-white/[0.01] hover:bg-white/[0.03]"
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-[13px] font-semibold text-white/90">
                              {title}
                            </div>
                            <div className="mt-0.5 truncate text-[11px] text-white/55">
                              {path ?? (tab === "ledger" ? "governance_ledger" : "—")}
                            </div>

                            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-white/50">
                              {tab !== "ledger" ? (
                                <>
                                  {hash ? <span className="truncate">hash: {String(hash).slice(0, 12)}…</span> : null}
                                  {createdAt ? <span>• {String(createdAt)}</span> : null}
                                </>
                              ) : (
                                <>
                                  {status ? <span className="uppercase">status: {String(status)}</span> : null}
                                  <span className="text-white/35">•</span>
                                  <span className={archived ? "text-[rgb(212,175,55)]" : "text-white/60"}>
                                    {archived ? "Archived" : "Not yet archived"}
                                  </span>
                                </>
                              )}
                            </div>
                          </div>

                          {tab === "verified" ? (
                            <span className="rounded-full border border-[rgba(212,175,55,0.25)] bg-[rgba(212,175,55,0.10)] px-2 py-0.5 text-[10px] font-semibold text-[rgb(212,175,55)]">
                              Verified
                            </span>
                          ) : null}

                          {tab === "ledger" ? (
                            <span
                              className={cx(
                                "rounded-full border px-2 py-0.5 text-[10px] font-semibold",
                                archived
                                  ? "border-[rgba(212,175,55,0.25)] bg-[rgba(212,175,55,0.10)] text-[rgb(212,175,55)]"
                                  : "border-white/10 bg-white/[0.03] text-white/70"
                              )}
                            >
                              {archived ? "Archived" : "Pending"}
                            </span>
                          ) : null}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* RIGHT: DETAILS */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
            {!selectedRow ? (
              <>
                <div className="text-[12px] font-semibold text-white/80">DETAILS</div>
                <div className="mt-2 rounded-xl border border-white/10 bg-white/[0.01] p-4 text-[12px] text-white/55">
                  <div className="font-semibold text-white/75">Select an entry.</div>
                  <div className="mt-1">Registry-only view. No destructive actions here.</div>
                </div>
              </>
            ) : (
              <>
                <div className="text-[12px] font-semibold text-white/80">DETAILS</div>

                <div className="mt-2 rounded-xl border border-white/10 bg-white/[0.01] p-4">
                  <div className="text-[13px] font-semibold text-white/90">
                    {getTitle(selectedRow)}
                  </div>

                  <div className="mt-2 grid grid-cols-2 gap-3 text-[12px]">
                    <div>
                      <div className="text-white/45">ID</div>
                      <div className="mt-0.5 break-all text-white/80">{String(getId(selectedRow))}</div>
                    </div>

                    <div>
                      <div className="text-white/45">Entity</div>
                      <div className="mt-0.5 text-white/80">
                        {String(getEntityKeyFromRow(selectedRow) ?? entityKey)}
                      </div>
                    </div>

                    <div className="col-span-2">
                      <div className="text-white/45">Storage Path</div>
                      <div className="mt-0.5 break-all text-white/80">
                        {getStoragePath(selectedRow) ?? "—"}
                      </div>
                    </div>

                    <div className="col-span-2">
                      <div className="text-white/45">Hash</div>
                      <div className="mt-0.5 break-all text-white/80">{String(getHash(selectedRow) ?? "—")}</div>
                    </div>

                    {tab === "minute_book" ? (
                      <div className="col-span-2">
                        <div className="text-white/45">Source Record Link (Ledger)</div>
                        <div className="mt-0.5 break-all text-white/80">
                          {String(getSourceRecordId(selectedRow) ?? "—")}
                        </div>
                        <div className="mt-1 text-[11px] text-white/55">
                          This is the link that proves a signed workflow was routed into the Minute Book.
                        </div>
                      </div>
                    ) : null}

                    {tab === "ledger" ? (
                      <div className="col-span-2">
                        <div className="text-white/45">Archive Status</div>
                        <div className="mt-0.5 text-white/80">
                          {archivedLedgerIds.has(String(getId(selectedRow) ?? ""))
                            ? "Archived (exists in minute_book_entries via source_record_id)"
                            : "Not yet archived"}
                        </div>
                        <div className="mt-1 text-[11px] text-white/55">
                          Ledger drafts preview happens in Forge/Council flow. CI-Archive remains registry-only.
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="border-t border-white/10 px-6 py-4 text-center text-[11px] text-white/35">
          Oasis Digital Parliament • CI-Archive • registry of record
        </div>
      </div>
    </Shell>
  );
}
