// src/app/(console-ledger)/ci-archive/ledger/page.tsx
"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";
import {
  ArrowLeft,
  Search,
  Shield,
  FileText,
  CheckCircle2,
  ExternalLink,
  Copy,
  X,
  ArrowRight,
} from "lucide-react";

type Tab = "ALL" | "PENDING" | "APPROVED" | "SIGNING" | "SIGNED" | "ARCHIVED";

type LedgerRow = {
  id: string;
  title: string | null;
  status: string | null;

  entity_id: string | null;
  is_test: boolean | null;

  envelope_id: string | null;
  created_at: string | null;

  // optional (safe if missing)
  approved_by_council?: boolean | null;
  archived_at?: string | null;
};

function cx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function normStatusUpper(s: string | null | undefined) {
  return (s || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
}

function prettyStatus(s: string | null | undefined) {
  const u = normStatusUpper(s);
  if (!u) return "—";
  return u.replace(/_/g, " ");
}

function badgeForStatus(statusRaw: string | null | undefined) {
  const s = normStatusUpper(statusRaw);

  if (s === "PENDING") return "border-sky-400/30 bg-sky-400/10 text-sky-100";
  if (s === "APPROVED") return "border-emerald-400/30 bg-emerald-400/10 text-emerald-100";
  if (s === "SIGNING" || s === "IN_SIGNING") return "border-amber-400/30 bg-amber-400/10 text-amber-100";
  if (s === "SIGNED") return "border-emerald-400/30 bg-emerald-400/10 text-emerald-100";
  if (s === "ARCHIVED") return "border-white/10 bg-white/5 text-slate-300";

  return "border-white/10 bg-white/5 text-slate-400";
}

function safeCopy(text: string) {
  try {
    navigator.clipboard?.writeText(text);
  } catch {}
}

export default function ArchiveLedgerLifecyclePage() {
  const { activeEntity } = useEntity(); // slug/key string
  const { env } = useOsEnv();
  const laneIsTest = env === "SANDBOX";

  const [entityId, setEntityId] = useState<string | null>(null);

  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [loading, setLoading] = useState(false);

  const [tab, setTab] = useState<Tab>("ALL");
  const [q, setQ] = useState("");

  // modal (details)
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<LedgerRow | null>(null);

  // Resolve entity UUID from entities table using slug (NO hardcoding)
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

  // Load governance_ledger (entity-scoped + lane-safe)
  useEffect(() => {
    let alive = true;

    async function load() {
      if (!entityId) {
        setRows([]);
        return;
      }

      setLoading(true);

      // Keep select conservative (no schema guessing). Optional columns are fine if they exist.
      let qry = supabase
        .from("governance_ledger")
        .select("id,title,status,entity_id,is_test,envelope_id,created_at,approved_by_council,archived_at")
        .eq("entity_id", entityId);

      // ✅ lane boundary (sacred):
      // - SANDBOX shows ONLY is_test = true
      // - RoT shows is_test = false OR legacy null (treated as RoT, never as sandbox)
      if (laneIsTest) {
        qry = qry.eq("is_test", true);
      } else {
        qry = qry.or("is_test.eq.false,is_test.is.null");
      }

      const { data, error } = await qry.order("created_at", { ascending: false }).limit(400);

      if (!alive) return;

      if (error) {
        console.error("governance_ledger load error", error);
        setRows([]);
        setLoading(false);
        return;
      }

      setRows((data ?? []) as any);
      setLoading(false);
    }

    load();
    return () => {
      alive = false;
    };
  }, [entityId, laneIsTest]);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();

    return (rows ?? []).filter((r) => {
      const s = normStatusUpper(r.status);

      if (tab !== "ALL") {
        if (tab === "PENDING" && s !== "PENDING") return false;
        if (tab === "APPROVED" && s !== "APPROVED") return false;
        if (tab === "SIGNING" && !(s === "SIGNING" || s === "IN_SIGNING")) return false;
        if (tab === "SIGNED" && s !== "SIGNED") return false;
        if (tab === "ARCHIVED" && s !== "ARCHIVED") return false;
      }

      if (!qq) return true;
      const hay = `${r.id} ${r.title ?? ""} ${r.status ?? ""} ${r.envelope_id ?? ""}`.toLowerCase();
      return hay.includes(qq);
    });
  }, [rows, tab, q]);

  const counts = useMemo(() => {
    const c = { ALL: rows.length, PENDING: 0, APPROVED: 0, SIGNING: 0, SIGNED: 0, ARCHIVED: 0 } as Record<Tab, number>;
    for (const r of rows) {
      const s = normStatusUpper(r.status);
      if (s === "PENDING") c.PENDING++;
      else if (s === "APPROVED") c.APPROVED++;
      else if (s === "SIGNING" || s === "IN_SIGNING") c.SIGNING++;
      else if (s === "SIGNED") c.SIGNED++;
      else if (s === "ARCHIVED") c.ARCHIVED++;
    }
    return c;
  }, [rows]);

  // OS shell/header/body pattern (MATCH Verified Registry)
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
                <h1 className="mt-1 text-lg sm:text-xl font-semibold text-slate-50">Drafts &amp; Approvals</h1>
                <p className="mt-1 max-w-3xl text-[11px] sm:text-xs text-slate-400 leading-relaxed">
                  Lifecycle surface for governance_ledger. Read-only monitor. Lane-safe. Entity-scoped. Use Council/Forge/Archive
                  to execute.
                </p>

                <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-400">
                  <span className="inline-flex items-center gap-2">
                    <Shield className="h-4 w-4 text-emerald-300" />
                    <span>Registry monitor • No destructive actions</span>
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
            {/* iPhone-first surface: stacks; desktop: 3 columns */}
            <div className="grid grid-cols-12 gap-4">
              {/* LEFT: Filters */}
              <section className="col-span-12 lg:col-span-3">
                <div className="rounded-3xl border border-white/10 bg-black/20 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-200">Filters</div>
                      <div className="text-[11px] text-slate-500">Status + search</div>
                    </div>
                    <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[10px] tracking-[0.18em] uppercase text-slate-200">
                      filters
                    </span>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {(["ALL", "PENDING", "APPROVED", "SIGNING", "SIGNED", "ARCHIVED"] as Tab[]).map((t) => (
                      <button
                        key={t}
                        onClick={() => setTab(t)}
                        className={cx(
                          "rounded-full border px-3 py-1 text-xs transition",
                          tab === t
                            ? "border-amber-400/40 bg-amber-400/10 text-amber-100"
                            : "border-white/10 bg-white/5 text-slate-200/80 hover:bg-white/7"
                        )}
                        title={`${t} (${counts[t] ?? 0})`}
                      >
                        {t} <span className="opacity-70">({counts[t] ?? 0})</span>
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
                        placeholder="title, id, status..."
                        className="w-full rounded-2xl border border-white/10 bg-white/5 pl-10 pr-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-500 focus:border-amber-400/30"
                      />
                    </div>
                  </div>

                  <div className="mt-4 text-xs text-slate-400">{loading ? "Loading…" : `${filtered.length} result(s)`}</div>

                  <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 p-3 text-xs text-slate-400">
                    Lane-safe: filters by <span className="text-slate-200">governance_ledger.is_test</span> and{" "}
                    <span className="text-slate-200">entity_id</span>. RoT includes legacy NULL (treated as RoT).
                  </div>
                </div>
              </section>

              {/* MIDDLE: Records */}
              <section className="col-span-12 lg:col-span-6">
                <div className="rounded-3xl border border-white/10 bg-black/20 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-200">Records</div>
                      <div className="text-[11px] text-slate-500">Lifecycle queue</div>
                    </div>
                    <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[10px] tracking-[0.18em] uppercase text-slate-200">
                      ledger
                    </span>
                  </div>

                  <div className="mt-3 space-y-2">
                    {filtered.length === 0 ? (
                      <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-slate-400">
                        {loading ? "Loading ledger…" : "No records match this view."}
                      </div>
                    ) : (
                      filtered.map((r) => {
                        const statusClass = badgeForStatus(r.status);
                        const s = normStatusUpper(r.status);
                        const canGoCouncil = s === "PENDING" || s === "APPROVED";
                        const canGoForge = s === "APPROVED" || s === "SIGNING" || s === "IN_SIGNING" || s === "SIGNED";
                        const canGoArchive = s === "SIGNED" || s === "ARCHIVED";

                        return (
                          <button
                            key={r.id}
                            onClick={() => {
                              setSelected(r);
                              setOpen(true);
                            }}
                            className="w-full text-left rounded-3xl border border-white/10 bg-black/20 p-3 hover:bg-black/25 transition"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="text-sm font-medium text-slate-100 truncate">{r.title || "Untitled record"}</div>
                                <div className="mt-1 text-xs text-slate-400">
                                  Status: {prettyStatus(r.status)}
                                  {r.envelope_id ? " · Envelope attached" : ""}
                                </div>

                                <div className="mt-2 font-mono break-all text-[11px] text-slate-500">{r.id}</div>

                                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                                  <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1">
                                    <FileText className="h-4 w-4 text-amber-300" />
                                    <span className="text-slate-200">governance_ledger</span>
                                  </span>

                                  <span className={cx("inline-flex items-center gap-2 rounded-full border px-3 py-1", statusClass)}>
                                    <CheckCircle2 className="h-4 w-4" />
                                    <span className="text-slate-200">{prettyStatus(r.status)}</span>
                                  </span>

                                  <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1">
                                    <span className="text-slate-500">lane:</span>
                                    <span className={cx("font-semibold", laneIsTest ? "text-amber-200" : "text-sky-200")}>
                                      {laneIsTest ? "SANDBOX" : "RoT"}
                                    </span>
                                  </span>
                                </div>
                              </div>

                              <div className="flex flex-col items-end gap-2 shrink-0">
                                <span className={cx("rounded-full border px-2 py-1 text-[11px]", statusClass)}>{prettyStatus(r.status)}</span>

                                <div className="flex items-center gap-2">
                                  <span
                                    className={cx(
                                      "rounded-full border px-2 py-1 text-[10px] tracking-[0.18em] uppercase",
                                      canGoCouncil ? "border-white/10 bg-white/5 text-slate-200" : "border-white/10 bg-black/20 text-slate-500"
                                    )}
                                  >
                                    Council
                                  </span>
                                  <span
                                    className={cx(
                                      "rounded-full border px-2 py-1 text-[10px] tracking-[0.18em] uppercase",
                                      canGoForge ? "border-white/10 bg-white/5 text-slate-200" : "border-white/10 bg-black/20 text-slate-500"
                                    )}
                                  >
                                    Forge
                                  </span>
                                  <span
                                    className={cx(
                                      "rounded-full border px-2 py-1 text-[10px] tracking-[0.18em] uppercase",
                                      canGoArchive ? "border-white/10 bg-white/5 text-slate-200" : "border-white/10 bg-black/20 text-slate-500"
                                    )}
                                  >
                                    Archive
                                  </span>
                                </div>
                              </div>
                            </div>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              </section>

              {/* RIGHT: Guidance */}
              <section className="col-span-12 lg:col-span-3">
                <div className="rounded-3xl border border-white/10 bg-black/20 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-200">Lifecycle</div>
                      <div className="text-[11px] text-slate-500">What to do next</div>
                    </div>
                    <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[10px] tracking-[0.18em] uppercase text-slate-200">
                      guide
                    </span>
                  </div>

                  <div className="mt-3 space-y-3 text-sm text-slate-300">
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                      <span className="text-slate-200">PENDING</span> → review &amp; approve in <span className="text-slate-200">Council</span>
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                      <span className="text-slate-200">APPROVED</span> → execute via <span className="text-slate-200">Forge</span> (signature-only)
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                      <span className="text-slate-200">SIGNED</span> → seal via <span className="text-slate-200">Archive</span> (idempotent)
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                      <span className="text-slate-200">ARCHIVED</span> → record is sealed; no action required
                    </div>
                  </div>

                  <div className="mt-4 text-[11px] text-slate-500 leading-relaxed">
                    This page is a monitor. Actions are performed in Council/Forge/Archive. Details modal includes safe copy and jump links.
                  </div>
                </div>
              </section>
            </div>

            {/* OS behavior footnote */}
            <div className="mt-5 rounded-3xl border border-white/10 bg-black/20 px-4 py-3 text-[11px] text-slate-400">
              <div className="font-semibold text-slate-200">OS behavior</div>
              <div className="mt-1 leading-relaxed text-slate-400">
                Drafts &amp; Approvals inherits the OS shell. Lane-safe and entity-scoped. No module-owned window frames.
              </div>
            </div>

            <div className="mt-5 flex items-center justify-between text-[10px] text-slate-600">
              <span>CI-Archive · Oasis Digital Parliament</span>
              <span>ODP.AI · Governance Firmware</span>
            </div>
          </div>
        </div>

        {/* optional quick links row */}
        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            href="/ci-archive"
            className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7"
          >
            CI-Archive
          </Link>
          <Link
            href="/ci-council"
            className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7"
          >
            Council
          </Link>
          <Link
            href="/ci-forge"
            className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7"
          >
            Forge
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

      {/* DETAILS MODAL (OS modern) */}
      {open && selected && (
        <div className="fixed inset-0 z-[80]">
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => {
              setOpen(false);
              setSelected(null);
            }}
          />
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <div className="w-full max-w-[860px] rounded-3xl border border-white/10 bg-black/60 shadow-[0_40px_140px_rgba(0,0,0,0.65)] overflow-hidden">
              <div className="border-b border-white/10 bg-gradient-to-b from-white/[0.08] to-transparent px-5 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">Record</div>
                    <div className="mt-1 text-lg font-semibold text-slate-50 truncate">{selected.title || "Untitled record"}</div>
                    <div className="mt-1 text-xs text-slate-400">
                      Status: <span className="text-slate-200">{prettyStatus(selected.status)}</span>
                      {" · "}
                      Lane:{" "}
                      <span className={cx("font-semibold", laneIsTest ? "text-amber-300" : "text-sky-300")}>
                        {laneIsTest ? "SANDBOX" : "RoT"}
                      </span>
                      {" · "}
                      Entity: <span className="text-emerald-300">{String(activeEntity ?? "—")}</span>
                    </div>
                  </div>

                  <button
                    onClick={() => {
                      setOpen(false);
                      setSelected(null);
                    }}
                    className="rounded-full border border-white/10 bg-white/5 p-2 hover:bg-white/7"
                    aria-label="Close"
                  >
                    <X className="h-4 w-4 text-slate-200" />
                  </button>
                </div>
              </div>

              <div className="px-5 py-5">
                <div className="grid grid-cols-12 gap-4">
                  <div className="col-span-12 lg:col-span-7">
                    <div className="rounded-3xl border border-white/10 bg-black/30 p-4">
                      <div className="text-sm font-semibold text-slate-200">Identifiers</div>

                      <div className="mt-3 space-y-3 text-sm text-slate-300">
                        <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                          <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">ledger_id</div>
                          <div className="mt-1 font-mono break-all text-[12px] text-slate-200">{selected.id}</div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            <button
                              onClick={() => safeCopy(selected.id)}
                              className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7 inline-flex items-center gap-2"
                            >
                              <Copy className="h-4 w-4" />
                              Copy ID
                            </button>

                            {selected.envelope_id && (
                              <button
                                onClick={() => safeCopy(String(selected.envelope_id))}
                                className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7 inline-flex items-center gap-2"
                              >
                                <Copy className="h-4 w-4" />
                                Copy Envelope
                              </button>
                            )}
                          </div>
                        </div>

                        {selected.envelope_id ? (
                          <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                            <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">envelope_id</div>
                            <div className="mt-1 font-mono break-all text-[12px] text-slate-200">{selected.envelope_id}</div>
                          </div>
                        ) : (
                          <div className="rounded-2xl border border-white/10 bg-black/20 p-3 text-sm text-slate-400">
                            No envelope linked yet (signature not started).
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="col-span-12 lg:col-span-5">
                    <div className="rounded-3xl border border-white/10 bg-black/30 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-slate-200">Jump to module</div>
                          <div className="text-[11px] text-slate-500">Perform actions in the right place</div>
                        </div>
                        <span className={cx("rounded-full border px-2 py-1 text-[11px]", badgeForStatus(selected.status))}>
                          {prettyStatus(selected.status)}
                        </span>
                      </div>

                      <div className="mt-4 space-y-2">
                        <Link
                          href="/ci-council"
                          className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-200 hover:bg-white/7 inline-flex items-center justify-between"
                        >
                          <span className="inline-flex items-center gap-2">
                            <Shield className="h-4 w-4 text-sky-300" />
                            Council
                          </span>
                          <ArrowRight className="h-4 w-4" />
                        </Link>

                        <Link
                          href="/ci-forge"
                          className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-200 hover:bg-white/7 inline-flex items-center justify-between"
                        >
                          <span className="inline-flex items-center gap-2">
                            <ExternalLink className="h-4 w-4 text-amber-300" />
                            Forge
                          </span>
                          <ArrowRight className="h-4 w-4" />
                        </Link>

                        <Link
                          href="/ci-archive/minute-book"
                          className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-200 hover:bg-white/7 inline-flex items-center justify-between"
                        >
                          <span className="inline-flex items-center gap-2">
                            <FileText className="h-4 w-4 text-emerald-300" />
                            Minute Book
                          </span>
                          <ArrowRight className="h-4 w-4" />
                        </Link>
                      </div>

                      <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-3 text-[11px] text-slate-400">
                        This modal is informational + safe copy only. No deletes, no direct mutations.
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="border-t border-white/10 bg-black/30 px-5 py-4 flex flex-wrap items-center justify-between gap-2">
                <div className="text-[11px] text-slate-500">Tip: use Forge for signature execution, Archive for sealing, Council for approval gate.</div>
                <button
                  onClick={() => {
                    setOpen(false);
                    setSelected(null);
                  }}
                  className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
