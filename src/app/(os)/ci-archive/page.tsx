"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/browser";

/**
 * CI-Archive (Registry-only)
 * - Canonical 3-column Oasis OS surface (never stacked).
 * - Minute Book = "digital minute book" view with ALWAYS-visible canonical folders.
 * - Verified = signed/verified artifacts (audit-ready).
 * - Ledger = where CI-Alchemy drafts live (read-only visibility; does NOT touch Forge).
 * - Upload is a separate page.
 *
 * IMPORTANT:
 * - Do NOT depend on columns that may not exist (ex: verified_documents.file_name).
 * - Fail gracefully: keep UI + folder taxonomy visible even if a query errors.
 */

type MinuteBookEntry = {
  id: string;
  entity_key: string | null;
  title: string | null;
  storage_path: string | null;
  pdf_hash: string | null;
  registry_status: string | null;
  source: string | null;
  source_record_id: string | null;
  source_envelope_id: string | null;
  created_at: string;
  updated_at: string | null;
};

type VerifiedDoc = {
  id: string;
  entity_key: string | null;
  title: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
  file_hash: string | null;
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

function fmtDT(iso: string | null | undefined) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function shortId(id: string | null | undefined) {
  if (!id) return "";
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

type CanonFolder = {
  key:
    | "all"
    | "incorporation"
    | "annual_returns"
    | "resolutions"
    | "registers"
    | "directors_officers"
    | "share_capital"
    | "banking"
    | "tax"
    | "contracts"
    | "policies"
    | "general";
  label: string;
  icon: string;
  hint?: string;
};

const CANON_FOLDERS: CanonFolder[] = [
  { key: "all", label: "All", icon: "📁" },
  { key: "incorporation", label: "Incorporation", icon: "🏛️" },
  { key: "annual_returns", label: "Annual Returns", icon: "🗓️" },
  { key: "resolutions", label: "Resolutions", icon: "🧾" },
  { key: "registers", label: "Registers", icon: "📚" },
  { key: "directors_officers", label: "Directors & Officers", icon: "👥" },
  { key: "share_capital", label: "Share Capital", icon: "🧩" },
  { key: "banking", label: "Banking", icon: "🏦" },
  { key: "tax", label: "Tax", icon: "🧮" },
  { key: "contracts", label: "Contracts", icon: "📜" },
  { key: "policies", label: "Policies", icon: "🛡️" },
  { key: "general", label: "General", icon: "🗂️" },
];

function normalizeFolderName(raw: string): CanonFolder["key"] {
  const s = (raw || "").trim().toLowerCase();

  // common variants that already exist in your storage_path
  if (s === "annualreturns" || s === "annual_returns" || s === "annual-returns" || s === "annual return" || s === "annual returns")
    return "annual_returns";
  if (s === "incorporation" || s === "incorp") return "incorporation";
  if (s === "resolutions" || s === "resolution") return "resolutions";
  if (s === "registers" || s === "registry" || s === "register") return "registers";
  if (s === "directors" || s === "officers" || s === "directorsandofficers" || s === "directors_officers" || s === "directors-officers")
    return "directors_officers";
  if (s === "sharecapital" || s === "share_capital" || s === "share-capital") return "share_capital";
  if (s === "banking" || s === "bank") return "banking";
  if (s === "tax" || s === "taxes") return "tax";
  if (s === "contracts" || s === "contract") return "contracts";
  if (s === "policies" || s === "policy") return "policies";
  if (!s) return "general";

  // fallback: if something unknown shows up, keep it under General for “minute book clarity”
  return "general";
}

function extractFolderKeyFromStoragePath(storagePath: string | null, entityKey: string | null): CanonFolder["key"] {
  if (!storagePath) return "general";
  let p = storagePath.trim();

  // tolerate both patterns:
  //   holdings/AnnualReturns/...
  //   minute_book/holdings/...
  if (p.startsWith("minute_book/")) p = p.slice("minute_book/".length);

  const ek = (entityKey || "").trim();
  if (ek && p.startsWith(`${ek}/`)) p = p.slice(ek.length + 1);

  const seg = p.split("/")[0] || "";
  return normalizeFolderName(seg);
}

function looksLikeResolutionFolder(storagePath: string | null): boolean {
  if (!storagePath) return false;
  return storagePath.toLowerCase().includes("/resolutions/");
}

function oasisCardBase() {
  return cx(
    "rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.06] to-white/[0.02]",
    "shadow-[0_8px_50px_-20px_rgba(0,0,0,0.75)] backdrop-blur"
  );
}

function pill(active: boolean) {
  return cx(
    "px-3 py-1.5 rounded-full text-xs font-semibold tracking-wide border transition",
    active
      ? "bg-[#caa24b]/20 border-[#caa24b]/40 text-[#f3d58a]"
      : "bg-white/5 border-white/10 text-white/70 hover:bg-white/8"
  );
}

function badge(kind: "gold" | "muted" | "warn") {
  const base = "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] border";
  if (kind === "gold") return cx(base, "bg-[#caa24b]/15 border-[#caa24b]/40 text-[#f3d58a]");
  if (kind === "warn") return cx(base, "bg-amber-500/10 border-amber-400/30 text-amber-200");
  return cx(base, "bg-white/5 border-white/10 text-white/70");
}

export default function CIArchivePage() {
  const supabase = useMemo(() => supabaseBrowser(), []);

  // you already have an entity selector in top bar (Holdings/Lounge/etc).
  // this page stays registry-only; we use entity_key filtering.
  const [entityKey, setEntityKey] = useState<string>("holdings");

  const [tab, setTab] = useState<TabKey>("minute_book");
  const [folderKey, setFolderKey] = useState<CanonFolder["key"]>("all");

  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [errText, setErrText] = useState<string | null>(null);

  const [minuteBook, setMinuteBook] = useState<MinuteBookEntry[]>([]);
  const [verified, setVerified] = useState<VerifiedDoc[]>([]);
  const [ledger, setLedger] = useState<GovernanceLedgerRow[]>([]);

  const [selected, setSelected] = useState<{ kind: TabKey; id: string } | null>(null);

  const abortRef = useRef({ cancelled: false });

  useEffect(() => {
    abortRef.current.cancelled = false;
    return () => {
      abortRef.current.cancelled = true;
    };
  }, []);

  // Load everything needed for CI-Archive view (read-only)
  useEffect(() => {
    const run = async () => {
      setLoading(true);
      setErrText(null);

      try {
        // 1) Minute book entries (digital minute book registry)
        const mb = await supabase
          .from("minute_book_entries")
          .select(
            "id,title,entity_key,storage_path,pdf_hash,registry_status,source,source_record_id,source_envelope_id,created_at,updated_at"
          )
          .eq("entity_key", entityKey)
          .order("created_at", { ascending: false });

        if (mb.error) throw mb.error;

        // 2) Verified docs (signed/verified artifacts)
        // NOTE: Do NOT select file_name (your prod error).
        const vd = await supabase
          .from("verified_documents")
          .select(
            "id,title,entity_key,storage_bucket,storage_path,file_hash,verification_level,envelope_id,signed_at,created_at,updated_at"
          )
          .eq("entity_key", entityKey)
          .order("created_at", { ascending: false });

        if (vd.error) throw vd.error;

        // 3) Governance ledger (where Alchemy drafts live)
        const gl = await supabase
          .from("governance_ledger")
          .select("id,title,status,source,created_at")
          .eq("source", "ci-alchemy")
          .order("created_at", { ascending: false })
          .limit(250);

        if (gl.error) throw gl.error;

        if (!abortRef.current.cancelled) {
          setMinuteBook((mb.data as MinuteBookEntry[]) || []);
          setVerified((vd.data as VerifiedDoc[]) || []);
          setLedger((gl.data as GovernanceLedgerRow[]) || []);
        }
      } catch (e: any) {
        if (!abortRef.current.cancelled) {
          setErrText(e?.message || "Failed to load CI-Archive.");
          // keep lists stable; do not wipe folders UI
          setMinuteBook([]);
          setVerified([]);
          setLedger([]);
        }
      } finally {
        if (!abortRef.current.cancelled) setLoading(false);
      }
    };

    run();
  }, [supabase, entityKey]);

  // Reset selection when switching tabs or entity/folder
  useEffect(() => {
    setSelected(null);
  }, [tab, entityKey, folderKey]);

  // Counts per canonical folder for Minute Book
  const minuteBookCounts = useMemo(() => {
    const counts: Record<CanonFolder["key"], number> = {
      all: 0,
      incorporation: 0,
      annual_returns: 0,
      resolutions: 0,
      registers: 0,
      directors_officers: 0,
      share_capital: 0,
      banking: 0,
      tax: 0,
      contracts: 0,
      policies: 0,
      general: 0,
    };
    for (const row of minuteBook) {
      counts.all += 1;
      const fk = extractFolderKeyFromStoragePath(row.storage_path, row.entity_key || entityKey);
      counts[fk] += 1;
    }
    return counts;
  }, [minuteBook, entityKey]);

  // Counts per canonical folder for Verified
  const verifiedCounts = useMemo(() => {
    const counts: Record<CanonFolder["key"], number> = {
      all: 0,
      incorporation: 0,
      annual_returns: 0,
      resolutions: 0,
      registers: 0,
      directors_officers: 0,
      share_capital: 0,
      banking: 0,
      tax: 0,
      contracts: 0,
      policies: 0,
      general: 0,
    };
    for (const row of verified) {
      counts.all += 1;
      const fk = extractFolderKeyFromStoragePath(row.storage_path, row.entity_key || entityKey);
      counts[fk] += 1;
    }
    return counts;
  }, [verified, entityKey]);

  // Ledger folders are status-based
  const ledgerFolders = useMemo(() => {
    const base = [
      { key: "all", label: "All", icon: "📌" },
      { key: "pending", label: "Pending Archive", icon: "⏳" },
      { key: "archived", label: "Archived", icon: "✅" },
      { key: "approved", label: "Approved", icon: "🛡️" },
      { key: "drafted", label: "Draft", icon: "📝" },
      { key: "rejected", label: "Rejected", icon: "⛔" },
    ] as const;

    const counts: Record<string, number> = {};
    for (const f of base) counts[f.key] = 0;

    // archived is inferred by existence of minute_book_entries.source_record_id = governance_ledger.id
    const archivedSet = new Set(minuteBook.map((m) => m.source_record_id).filter(Boolean) as string[]);

    for (const row of ledger) {
      counts.all += 1;
      const st = (row.status || "").toUpperCase();
      if (archivedSet.has(row.id)) {
        counts.archived += 1;
      } else {
        counts.pending += 1;
      }
      if (st === "APPROVED") counts.approved += 1;
      else if (st === "DRAFTED" || st === "DRAFT") counts.drafted += 1;
      else if (st === "REJECTED") counts.rejected += 1;
    }

    return { base, counts, archivedSet };
  }, [ledger, minuteBook]);

  const headerBlurb = useMemo(() => {
    if (tab === "minute_book") {
      return (
        <>
          <span className="text-[#f3d58a] font-semibold">Digital Minute Book Registry.</span>{" "}
          <span className="text-white/70">
            These are archived, indexed records (not drafts). Canonical folder taxonomy is always visible for enterprise clarity.
          </span>
        </>
      );
    }
    if (tab === "verified") {
      return (
        <>
          <span className="text-[#f3d58a] font-semibold">Verified Registry.</span>{" "}
          <span className="text-white/70">Signed/verified artifacts with hashes & envelope metadata (audit-ready).</span>
        </>
      );
    }
    return (
      <>
        <span className="text-[#f3d58a] font-semibold">Alchemy drafts live here.</span>{" "}
        <span className="text-white/70">
          Archive appears in Minute Book only after signature routing creates a <code className="text-white/80">minute_book_entries</code>{" "}
          row linked by <code className="text-white/80">source_record_id</code>.
        </span>
      </>
    );
  }, [tab]);

  const activeRows = useMemo(() => {
    const query = q.trim().toLowerCase();

    if (tab === "minute_book") {
      let rows = minuteBook.slice();

      if (folderKey !== "all") {
        rows = rows.filter((r) => extractFolderKeyFromStoragePath(r.storage_path, r.entity_key || entityKey) === folderKey);
      }

      if (query) {
        rows = rows.filter((r) => {
          const a = (r.title || "").toLowerCase();
          const b = (r.storage_path || "").toLowerCase();
          const c = (r.pdf_hash || "").toLowerCase();
          return a.includes(query) || b.includes(query) || c.includes(query);
        });
      }

      return rows;
    }

    if (tab === "verified") {
      let rows = verified.slice();
      if (folderKey !== "all") {
        rows = rows.filter((r) => extractFolderKeyFromStoragePath(r.storage_path, r.entity_key || entityKey) === folderKey);
      }
      if (query) {
        rows = rows.filter((r) => {
          const a = (r.title || "").toLowerCase();
          const b = (r.storage_path || "").toLowerCase();
          const c = (r.file_hash || "").toLowerCase();
          return a.includes(query) || b.includes(query) || c.includes(query);
        });
      }
      return rows;
    }

    // ledger tab uses status folders (folderKey repurposed)
    const archivedSet = ledgerFolders.archivedSet;
    let rows = ledger.slice();

    const lk = folderKey as any;
    if (lk && lk !== "all") {
      if (lk === "pending") rows = rows.filter((r) => !archivedSet.has(r.id));
      else if (lk === "archived") rows = rows.filter((r) => archivedSet.has(r.id));
      else if (lk === "approved") rows = rows.filter((r) => (r.status || "").toUpperCase() === "APPROVED");
      else if (lk === "drafted") rows = rows.filter((r) => ["DRAFT", "DRAFTED"].includes((r.status || "").toUpperCase()));
      else if (lk === "rejected") rows = rows.filter((r) => (r.status || "").toUpperCase() === "REJECTED");
    }

    if (query) {
      rows = rows.filter((r) => {
        const a = (r.title || "").toLowerCase();
        const b = (r.status || "").toLowerCase();
        const c = (r.id || "").toLowerCase();
        return a.includes(query) || b.includes(query) || c.includes(query);
      });
    }

    return rows;
  }, [tab, minuteBook, verified, ledger, q, folderKey, entityKey, ledgerFolders]);

  const selectedRow = useMemo(() => {
    if (!selected) return null;
    if (selected.kind === "minute_book") return minuteBook.find((x) => x.id === selected.id) || null;
    if (selected.kind === "verified") return verified.find((x) => x.id === selected.id) || null;
    return ledger.find((x) => x.id === selected.id) || null;
  }, [selected, minuteBook, verified, ledger]);

  const pendingArchiveCount = useMemo(() => {
    // ledger "pending archive" = alchemy + not archived yet
    return ledgerFolders.counts.pending || 0;
  }, [ledgerFolders]);

  return (
    <div className="min-h-[calc(100vh-72px)] px-6 py-6 text-white">
      <div className={cx(oasisCardBase(), "p-5")}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-sm font-semibold tracking-wide text-white/85">CI-Archive</div>
            <div className="text-xs text-white/55">Registry vault • strict three-column • Oasis OS signature</div>
          </div>

          <div className="flex items-center gap-2">
            <button className={pill(tab === "minute_book")} onClick={() => (setTab("minute_book"), setFolderKey("all"))}>
              Minute Book
            </button>
            <button className={pill(tab === "verified")} onClick={() => (setTab("verified"), setFolderKey("all"))}>
              Verified
            </button>
            <button className={pill(tab === "ledger")} onClick={() => (setTab("ledger"), setFolderKey("all" as any))}>
              Ledger
            </button>
            <Link href="/ci-archive/upload" className={cx(pill(false), "border-[#caa24b]/35 text-[#f3d58a] hover:bg-[#caa24b]/10")}>
              Upload
            </Link>
          </div>
        </div>

        <div className={cx("mt-4 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm")}>{headerBlurb}</div>

        {tab === "ledger" && (
          <div className="mt-2 text-xs text-white/55">
            Pending archive (ci-alchemy stream): <span className="text-white/75">{pendingArchiveCount}</span>
          </div>
        )}

        {errText && (
          <div className={cx("mt-4 rounded-xl border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100")}>
            <div className="font-semibold">Failed to load CI-Archive.</div>
            <div className="opacity-90">{errText}</div>
          </div>
        )}
      </div>

      {/* 3-column canonical layout */}
      <div className={cx(oasisCardBase(), "mt-6 p-5")}>
        <div className="grid grid-cols-12 gap-4">
          {/* LEFT: folders */}
          <div className="col-span-12 md:col-span-3">
            <div className="flex items-center justify-between">
              <div className="text-[11px] tracking-widest text-white/50">FOLDERS</div>
              <div className="text-[11px] text-white/50">Entity: {entityKey}</div>
            </div>

            <div className={cx("mt-3 rounded-2xl border border-white/10 bg-white/[0.03] p-2", "max-h-[540px] overflow-auto")}>
              {tab !== "ledger" &&
                CANON_FOLDERS.map((f) => {
                  const cnt = tab === "minute_book" ? minuteBookCounts[f.key] : verifiedCounts[f.key];
                  const active = folderKey === f.key;
                  return (
                    <button
                      key={f.key}
                      className={cx(
                        "w-full text-left px-3 py-2 rounded-xl border transition flex items-center justify-between gap-3",
                        active ? "border-[#caa24b]/35 bg-[#caa24b]/10" : "border-white/0 hover:border-white/10 hover:bg-white/5"
                      )}
                      onClick={() => setFolderKey(f.key)}
                    >
                      <div className="flex items-center gap-2">
                        <span className="opacity-90">{f.icon}</span>
                        <span className={cx("text-sm", active ? "text-[#f3d58a]" : "text-white/80")}>{f.label}</span>
                      </div>
                      <span className={cx("text-xs px-2 py-0.5 rounded-full border", active ? "border-[#caa24b]/35 text-[#f3d58a]" : "border-white/10 text-white/55")}>
                        {cnt || 0}
                      </span>
                    </button>
                  );
                })}

              {tab === "ledger" && (
                <>
                  {ledgerFolders.base.map((f) => {
                    const active = (folderKey as any) === f.key;
                    const cnt = ledgerFolders.counts[f.key] || 0;
                    return (
                      <button
                        key={f.key}
                        className={cx(
                          "w-full text-left px-3 py-2 rounded-xl border transition flex items-center justify-between gap-3",
                          active ? "border-[#caa24b]/35 bg-[#caa24b]/10" : "border-white/0 hover:border-white/10 hover:bg-white/5"
                        )}
                        onClick={() => setFolderKey(f.key as any)}
                      >
                        <div className="flex items-center gap-2">
                          <span className="opacity-90">{f.icon}</span>
                          <span className={cx("text-sm", active ? "text-[#f3d58a]" : "text-white/80")}>{f.label}</span>
                        </div>
                        <span className={cx("text-xs px-2 py-0.5 rounded-full border", active ? "border-[#caa24b]/35 text-[#f3d58a]" : "border-white/10 text-white/55")}>
                          {cnt}
                        </span>
                      </button>
                    );
                  })}
                </>
              )}

              <div className="mt-3 px-2 text-[11px] text-white/45">
                {tab === "minute_book" && <>This is the minute book. Not drafts. Drafts live in Ledger.</>}
                {tab === "verified" && <>Verified artifacts are audit-ready. Registry-only view.</>}
                {tab === "ledger" && <>Ledger visibility only. Forge/Council flows remain unchanged.</>}
              </div>
            </div>
          </div>

          {/* MIDDLE: entries */}
          <div className="col-span-12 md:col-span-6">
            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] tracking-widest text-white/50">
                ENTRIES • <span className="text-white/70">{activeRows.length}</span>
              </div>

              <div className="relative w-full max-w-[420px]">
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={
                    tab === "minute_book" ? "Search title, folder, path, hash…" : tab === "verified" ? "Search title, path, hash…" : "Search title, status, id…"
                  }
                  className={cx(
                    "w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2 text-sm outline-none",
                    "placeholder:text-white/35 focus:border-[#caa24b]/35 focus:bg-white/[0.05]"
                  )}
                />
              </div>
            </div>

            <div className={cx("mt-3 rounded-2xl border border-white/10 bg-white/[0.02] p-2", "max-h-[540px] overflow-auto")}>
              {loading && (
                <div className="p-4 text-sm text-white/60">
                  Loading registry…
                </div>
              )}

              {!loading && activeRows.length === 0 && (
                <div className="p-6 text-sm text-white/55">
                  No entries found.
                </div>
              )}

              {!loading &&
                tab === "minute_book" &&
                (activeRows as MinuteBookEntry[]).map((r) => {
                  const isActive = selected?.kind === "minute_book" && selected.id === r.id;
                  const fk = extractFolderKeyFromStoragePath(r.storage_path, r.entity_key || entityKey);
                  const folderLabel = CANON_FOLDERS.find((f) => f.key === fk)?.label || "General";

                  const isRes = looksLikeResolutionFolder(r.storage_path);
                  const title = r.title || (isRes ? "Resolution" : "Minute Book Entry");

                  return (
                    <button
                      key={r.id}
                      onClick={() => setSelected({ kind: "minute_book", id: r.id })}
                      className={cx(
                        "w-full text-left rounded-xl border p-3 transition mb-2",
                        isActive ? "border-[#caa24b]/40 bg-[#caa24b]/10" : "border-white/10 bg-white/[0.02] hover:bg-white/[0.04]"
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="opacity-85">{isRes ? "🧾" : "📄"}</span>
                            <div className="truncate text-sm font-semibold text-white/90">{title}</div>
                          </div>
                          <div className="mt-1 text-xs text-white/55 truncate">{r.storage_path || ""}</div>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <span className={badge("muted")}>{folderLabel}</span>
                            {r.registry_status ? <span className={badge("gold")}>{r.registry_status}</span> : <span className={badge("muted")}>registered</span>}
                            {r.source_record_id ? <span className={badge("gold")}>linked</span> : <span className={badge("muted")}>manual</span>}
                          </div>
                        </div>

                        <div className="shrink-0 text-xs text-white/45">{fmtDT(r.created_at)}</div>
                      </div>
                    </button>
                  );
                })}

              {!loading &&
                tab === "verified" &&
                (activeRows as VerifiedDoc[]).map((r) => {
                  const isActive = selected?.kind === "verified" && selected.id === r.id;
                  const fk = extractFolderKeyFromStoragePath(r.storage_path, r.entity_key || entityKey);
                  const folderLabel = CANON_FOLDERS.find((f) => f.key === fk)?.label || "General";
                  const title = r.title || "Verified Document";

                  return (
                    <button
                      key={r.id}
                      onClick={() => setSelected({ kind: "verified", id: r.id })}
                      className={cx(
                        "w-full text-left rounded-xl border p-3 transition mb-2",
                        isActive ? "border-[#caa24b]/40 bg-[#caa24b]/10" : "border-white/10 bg-white/[0.02] hover:bg-white/[0.04]"
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="opacity-85">🛡️</span>
                            <div className="truncate text-sm font-semibold text-white/90">{title}</div>
                          </div>
                          <div className="mt-1 text-xs text-white/55 truncate">{r.storage_path || ""}</div>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <span className={badge("muted")}>{folderLabel}</span>
                            <span className={badge("gold")}>verified</span>
                            {r.envelope_id ? <span className={badge("muted")}>env {shortId(r.envelope_id)}</span> : <span className={badge("muted")}>no envelope</span>}
                          </div>
                        </div>

                        <div className="shrink-0 text-xs text-white/45">{fmtDT(r.created_at)}</div>
                      </div>
                    </button>
                  );
                })}

              {!loading &&
                tab === "ledger" &&
                (activeRows as GovernanceLedgerRow[]).map((r) => {
                  const isActive = selected?.kind === "ledger" && selected.id === r.id;
                  const archived = ledgerFolders.archivedSet.has(r.id);
                  const st = (r.status || "").toUpperCase() || "UNKNOWN";

                  return (
                    <button
                      key={r.id}
                      onClick={() => setSelected({ kind: "ledger", id: r.id })}
                      className={cx(
                        "w-full text-left rounded-xl border p-3 transition mb-2",
                        isActive ? "border-[#caa24b]/40 bg-[#caa24b]/10" : "border-white/10 bg-white/[0.02] hover:bg-white/[0.04]"
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="opacity-85">🧪</span>
                            <div className="truncate text-sm font-semibold text-white/90">{r.title || "Ledger Draft"}</div>
                          </div>
                          <div className="mt-1 text-xs text-white/55 truncate">governance_ledger • {r.id}</div>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <span className={badge("muted")}>{st}</span>
                            {archived ? <span className={badge("gold")}>archived</span> : <span className={badge("warn")}>pending archive</span>}
                            <span className={badge("muted")}>{r.source || "unknown source"}</span>
                          </div>
                        </div>

                        <div className="shrink-0 text-xs text-white/45">{fmtDT(r.created_at)}</div>
                      </div>
                    </button>
                  );
                })}
            </div>
          </div>

          {/* RIGHT: details */}
          <div className="col-span-12 md:col-span-3">
            <div className="text-[11px] tracking-widest text-white/50">DETAILS</div>

            <div className={cx("mt-3 rounded-2xl border border-white/10 bg-white/[0.02] p-4", "min-h-[540px]")}>
              {!selectedRow && (
                <div className="text-sm text-white/65">
                  <div className="font-semibold text-white/85">Select an entry.</div>
                  <div className="mt-1">Registry-only view. No destructive actions here.</div>
                </div>
              )}

              {!!selectedRow && tab === "minute_book" && (() => {
                const r = selectedRow as MinuteBookEntry;
                const fk = extractFolderKeyFromStoragePath(r.storage_path, r.entity_key || entityKey);
                const folderLabel = CANON_FOLDERS.find((f) => f.key === fk)?.label || "General";
                const isRes = looksLikeResolutionFolder(r.storage_path);
                return (
                  <div className="space-y-3">
                    <div className="text-sm font-semibold text-white/90">{r.title || (isRes ? "Resolution" : "Minute Book Entry")}</div>
                    <div className="text-xs text-white/55 break-words">{r.storage_path || ""}</div>

                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
                        <div className="text-white/45">Folder</div>
                        <div className="mt-1 text-white/80">{folderLabel}</div>
                      </div>
                      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
                        <div className="text-white/45">Registry</div>
                        <div className="mt-1 text-white/80">{r.registry_status || "registered"}</div>
                      </div>
                      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
                        <div className="text-white/45">Source</div>
                        <div className="mt-1 text-white/80">{r.source || "manual_upload"}</div>
                      </div>
                      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
                        <div className="text-white/45">Created</div>
                        <div className="mt-1 text-white/80">{fmtDT(r.created_at)}</div>
                      </div>
                    </div>

                    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3 text-xs">
                      <div className="text-white/45">Link to Ledger (if routed)</div>
                      <div className="mt-1 text-white/80">
                        {r.source_record_id ? (
                          <span>
                            source_record_id: <span className="text-[#f3d58a]">{r.source_record_id}</span>
                          </span>
                        ) : (
                          <span className="text-white/55">Not linked (manual minute book entry).</span>
                        )}
                      </div>
                    </div>

                    {r.pdf_hash && (
                      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3 text-xs">
                        <div className="text-white/45">PDF Hash</div>
                        <div className="mt-1 text-white/80 break-words">{r.pdf_hash}</div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {!!selectedRow && tab === "verified" && (() => {
                const r = selectedRow as VerifiedDoc;
                const fk = extractFolderKeyFromStoragePath(r.storage_path, r.entity_key || entityKey);
                const folderLabel = CANON_FOLDERS.find((f) => f.key === fk)?.label || "General";
                return (
                  <div className="space-y-3">
                    <div className="text-sm font-semibold text-white/90">{r.title || "Verified Document"}</div>
                    <div className="text-xs text-white/55 break-words">{r.storage_path || ""}</div>

                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
                        <div className="text-white/45">Folder</div>
                        <div className="mt-1 text-white/80">{folderLabel}</div>
                      </div>
                      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
                        <div className="text-white/45">Verification</div>
                        <div className="mt-1 text-white/80">{r.verification_level || "verified"}</div>
                      </div>
                      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
                        <div className="text-white/45">Envelope</div>
                        <div className="mt-1 text-white/80">{r.envelope_id ? shortId(r.envelope_id) : "—"}</div>
                      </div>
                      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
                        <div className="text-white/45">Signed At</div>
                        <div className="mt-1 text-white/80">{r.signed_at ? fmtDT(r.signed_at) : "—"}</div>
                      </div>
                    </div>

                    {r.file_hash && (
                      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3 text-xs">
                        <div className="text-white/45">File Hash</div>
                        <div className="mt-1 text-white/80 break-words">{r.file_hash}</div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {!!selectedRow && tab === "ledger" && (() => {
                const r = selectedRow as GovernanceLedgerRow;
                const archived = ledgerFolders.archivedSet.has(r.id);
                const st = (r.status || "").toUpperCase() || "UNKNOWN";
                return (
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="text-sm font-semibold text-white/90">{r.title || "Ledger Draft"}</div>
                      <span className={badge(st === "APPROVED" ? "gold" : st === "REJECTED" ? "warn" : "muted")}>{st}</span>
                    </div>

                    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3 text-xs space-y-1">
                      <div>
                        <span className="text-white/45">Ledger ID</span>: <span className="text-white/80">{r.id}</span>
                      </div>
                      <div>
                        <span className="text-white/45">Created</span>: <span className="text-white/80">{fmtDT(r.created_at)}</span>
                      </div>
                      <div>
                        <span className="text-white/45">Source</span>: <span className="text-white/80">{r.source || "unknown"}</span>
                      </div>
                      <div>
                        <span className="text-white/45">Archive</span>:{" "}
                        <span className={archived ? "text-[#f3d58a]" : "text-white/70"}>{archived ? "Archived to Minute Book" : "Not yet archived"}</span>
                      </div>
                    </div>

                    <div className="text-xs text-white/55">
                      Ledger drafts preview happens in the drafting/sign flow (Forge/Council). CI-Archive remains registry-only.
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      </div>

      {/* bottom hint */}
      <div className="mt-4 text-center text-[11px] text-white/35">
        Oasis Digital Parliament • CI-Archive • registry of record
      </div>
    </div>
  );
}
