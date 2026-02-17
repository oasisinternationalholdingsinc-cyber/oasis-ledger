// src/app/(console-ledger)/ci-archive/ledger/ledger.client.tsx
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
  Sparkles,
  ShieldAlert,
  RotateCw,
  Zap,
  List,
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
  approved_by_council?: boolean | null;
  archived?: boolean | null;
};

type DraftLink = {
  id: string;
  title: string | null;
  record_type: string | null;
  entity_slug: string | null;
  entity_id: string | null;
  is_test: boolean | null;
  finalized_record_id?: string | null;
};

type AxiomNote = {
  id: string;
  created_at: string | null;
  title: string | null;
  content: string | null;
  model: string | null;
  tokens_used: number | null;
  created_by: string | null;
  note_type?: string | null;
  scope_type?: string | null;
  scope_id?: string | null;
};

type DraftConflictsRow = {
  id: string;
  draft_id: string;
  entity_id: string;
  is_test: boolean;
  severity: string;
  conflicts_json: unknown;
  compared_at: string | null;
  compared_by: string | null;
};

type ResolutionFactsRow = {
  id: string;
  ledger_id: string;
  entity_id: string;
  is_test: boolean;
  verified_document_id: string | null;
  facts_json: any;
  model: string | null;
  extracted_at: string | null;
};

type AxiomListItem = {
  note_id: string;
  created_at: string | null;
  title: string | null;
  preview: string | null;
  draft_id: string;
  ledger_id: string;
};

type DraftRowForAxiom = {
  id: string;
  title?: string | null;
  finalized_record_id: string | null;
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

function severityBadge(sevRaw: string | null | undefined) {
  const sev = String(sevRaw || "").toLowerCase().trim();
  if (sev === "critical") return "border-rose-400/35 bg-rose-400/10 text-rose-100";
  if (sev === "warning") return "border-amber-400/35 bg-amber-400/10 text-amber-100";
  if (sev === "info") return "border-sky-400/30 bg-sky-400/10 text-sky-100";
  return "border-white/10 bg-white/5 text-slate-300";
}

function tryJsonStringify(v: unknown, limit = 10_000) {
  try {
    const s = JSON.stringify(v, null, 2);
    if (s.length <= limit) return s;
    return s.slice(0, limit) + "\n…";
  } catch {
    return String(v ?? "");
  }
}

function computeConflictsCount(v: unknown): number {
  try {
    if (!v) return 0;
    if (Array.isArray(v)) return v.length;

    if (typeof v === "object") {
      const o: any = v;

      if (Array.isArray(o.conflicts)) return o.conflicts.length;
      if (Array.isArray(o.items)) return o.items.length;
      if (Array.isArray(o.results)) return o.results.length;

      const vals = Object.values(o);
      const arrays = vals.filter(Array.isArray) as any[][];
      if (arrays.length) return arrays.reduce((acc, a) => acc + a.length, 0);
    }

    return 0;
  } catch {
    return 0;
  }
}

async function getInvokeHeaders() {
  const { data } = await supabase.auth.getSession();
  const jwt = data?.session?.access_token || "";
  const apikey =
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string | undefined) ||
    ((globalThis as any)?.__SUPABASE_ANON_KEY__ as string | undefined) ||
    "";

  const headers: Record<string, string> = {};
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  if (apikey) headers.apikey = apikey;

  return headers;
}

export default function ArchiveLedgerLifecyclePage() {
  const { activeEntity } = useEntity();
  const { env } = useOsEnv();

  const laneIsTest = String(env).toUpperCase() === "SANDBOX";

  const [entityId, setEntityId] = useState<string | null>(null);
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<Tab>("ALL");
  const [q, setQ] = useState("");

  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<LedgerRow | null>(null);

  const [draftLink, setDraftLink] = useState<DraftLink | null>(null);
  const [axiomNote, setAxiomNote] = useState<AxiomNote | null>(null);
  const [draftConflicts, setDraftConflicts] = useState<DraftConflictsRow | null>(null);
  const [resolutionFacts, setResolutionFacts] = useState<ResolutionFactsRow | null>(null);
  const [intelLoading, setIntelLoading] = useState(false);
  const [intelErr, setIntelErr] = useState<string | null>(null);

  const [axiomList, setAxiomList] = useState<AxiomListItem[]>([]);
  const [axiomListLoading, setAxiomListLoading] = useState(false);
  const [axiomListErr, setAxiomListErr] = useState<string | null>(null);

  const [extracting, setExtracting] = useState(false);
  const [extractErr, setExtractErr] = useState<string | null>(null);
  const [extractOk, setExtractOk] = useState<string | null>(null);

  // ✅ OS shell/header/body pattern (MATCH Verified + launchpads)
  const shell =
    "rounded-3xl border border-white/10 bg-black/20 shadow-[0_28px_120px_rgba(0,0,0,0.55)] overflow-hidden";
  const header =
    "border-b border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent px-4 sm:px-6 py-4 sm:py-5";
  const body = "px-4 sm:px-6 py-5 sm:py-6";

  const conflictsCount = useMemo(() => computeConflictsCount(draftConflicts?.conflicts_json), [draftConflicts]);

  // ✅ Entity UUID resolve (LOCKED to entities.slug — NO legacy fallback, NO ts-expect-error)
  useEffect(() => {
    let alive = true;

    async function resolveEntity() {
      const slug = String(activeEntity || "").trim();
      if (!slug) {
        if (alive) setEntityId(null);
        return;
      }

      const { data, error } = await supabase
        .from("entities")
        .select("id")
        .eq("slug", slug)
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

  // ✅ Ledger list (SECURITY DEFINER RPC)
  useEffect(() => {
    let alive = true;

    async function loadLedger() {
      if (!entityId) {
        setRows([]);
        return;
      }

      setLoading(true);

      const { data, error } = await supabase.rpc("ledger_scoped_v3", {
        p_entity_id: entityId,
        p_is_test: laneIsTest,
      });

      if (!alive) return;

      if (error) {
        console.error("ledger_scoped_v3 rpc error", error);
        setRows([]);
        setLoading(false);
        return;
      }

      setRows((data ?? []) as LedgerRow[]);
      setLoading(false);
    }

    loadLedger();
    return () => {
      alive = false;
    };
  }, [entityId, laneIsTest]);

  // ✅ Sidebar: latest AXIOM notes (best-effort; soft-fails on RLS)
  useEffect(() => {
    let alive = true;

    async function loadAxiomList() {
      if (!entityId) {
        setAxiomList([]);
        return;
      }

      setAxiomListLoading(true);
      setAxiomListErr(null);

      try {
        const { data: notes, error: nErr } = await supabase
          .from("ai_notes")
          .select("id,created_at,title,content,note_type,scope_type,scope_id")
          .eq("scope_type", "document")
          .eq("note_type", "summary")
          .order("created_at", { ascending: false })
          .limit(60);

        if (!alive) return;

        if (nErr) {
          console.warn("axiomList ai_notes read blocked/failed", nErr);
          setAxiomList([]);
          setAxiomListErr("AXIOM notes not readable in browser (RLS).");
          setAxiomListLoading(false);
          return;
        }

        const draftIds = (notes ?? [])
          .map((n: any) => String(n.scope_id || "").trim())
          .filter(Boolean);

        if (!draftIds.length) {
          setAxiomList([]);
          setAxiomListLoading(false);
          return;
        }

        const { data: drafts, error: dErr } = await supabase
          .from("governance_drafts")
          .select("id,title,finalized_record_id,entity_id,is_test")
          .in("id", draftIds)
          .eq("entity_id", entityId)
          .eq("is_test", laneIsTest);

        if (!alive) return;

        if (dErr) {
          console.warn("axiomList governance_drafts read blocked/failed", dErr);
          setAxiomList([]);
          setAxiomListErr("Draft links not readable in browser (RLS).");
          setAxiomListLoading(false);
          return;
        }

        const map = new Map<string, DraftRowForAxiom>();
        for (const d of (drafts ?? []) as any[]) map.set(String(d.id), d);

        const out: AxiomListItem[] = [];
        const seenLedger = new Set<string>();

        for (const n of (notes ?? []) as any[]) {
          const draft_id = String(n.scope_id || "").trim();
          const d = map.get(draft_id);
          const ledger_id = String(d?.finalized_record_id || "").trim();
          if (!ledger_id) continue;
          if (seenLedger.has(ledger_id)) continue;

          const text = String(n.content || "").trim();
          const preview = text ? (text.length > 160 ? text.slice(0, 160) + "…" : text) : null;

          out.push({
            note_id: String(n.id),
            created_at: n.created_at ?? null,
            title: (n.title ?? d?.title ?? null) as any,
            preview,
            draft_id,
            ledger_id,
          });

          seenLedger.add(ledger_id);
          if (out.length >= 5) break;
        }

        setAxiomList(out);
        setAxiomListLoading(false);
      } catch (e: any) {
        if (!alive) return;
        setAxiomList([]);
        setAxiomListErr(e?.message ? String(e.message) : "Failed to load AXIOM list.");
        setAxiomListLoading(false);
      }
    }

    loadAxiomList();
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

  const topIntel = useMemo(() => {
    const axiomNotesCount = axiomList.length;
    return {
      axiomNotesCount,
      resolutionFactsCount: resolutionFacts?.id ? 1 : 0,
      critical: draftConflicts?.severity?.toLowerCase() === "critical" ? 1 : 0,
      warning: draftConflicts?.severity?.toLowerCase() === "warning" ? 1 : 0,
    };
  }, [axiomList, resolutionFacts, draftConflicts]);

  async function loadLedgerIntel(ledgerId: string) {
    if (!ledgerId) return;

    setIntelLoading(true);
    setIntelErr(null);

    setDraftLink(null);
    setAxiomNote(null);
    setDraftConflicts(null);
    setResolutionFacts(null);

    try {
      const { data: dl, error: dlErr } = await supabase
        .from("governance_drafts")
        .select("id,title,record_type,entity_slug,entity_id,is_test,finalized_record_id")
        .eq("finalized_record_id", ledgerId)
        .limit(1)
        .maybeSingle();

      if (dlErr) console.warn("draftLink read failed", dlErr);
      const link = (dl ?? null) as DraftLink | null;
      setDraftLink(link);

      if (link?.id) {
        const { data: note, error: noteErr } = await supabase
          .from("ai_notes")
          .select("id,created_at,title,content,model,tokens_used,created_by,note_type,scope_type,scope_id")
          .eq("scope_type", "document")
          .eq("scope_id", link.id)
          .eq("note_type", "summary")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (noteErr) console.warn("axiomNote read failed", noteErr);
        else setAxiomNote((note ?? null) as any);

        // best-effort conflicts snapshot (soft fail if table missing / blocked)
        try {
          const { data: conf, error: cErr } = await supabase
            .from("draft_authority_conflicts")
            .select("id,draft_id,entity_id,is_test,severity,conflicts_json,compared_at,compared_by")
            .eq("draft_id", link.id)
            .eq("entity_id", entityId ?? link.entity_id ?? "")
            .eq("is_test", laneIsTest)
            .order("compared_at", { ascending: false })
            .limit(1)
            .maybeSingle();

          if (!cErr && conf) setDraftConflicts(conf as any);
        } catch {
          // ignore
        }
      }

      // archived-only resolution facts (soft fail if table missing)
      try {
        const { data: facts, error: fErr } = await supabase
          .from("governance_resolution_facts")
          .select("id,ledger_id,entity_id,is_test,verified_document_id,facts_json,model,extracted_at")
          .eq("ledger_id", ledgerId)
          .eq("entity_id", entityId ?? "")
          .eq("is_test", laneIsTest)
          .order("extracted_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!fErr && facts) setResolutionFacts(facts as any);
      } catch {
        // ignore
      }
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : "Failed to load advisory signals.";
      setIntelErr(msg);
    } finally {
      setIntelLoading(false);
    }
  }

  async function extractResolutionFacts(opts?: { force?: boolean }) {
    if (!selected?.id) return;

    setExtracting(true);
    setExtractErr(null);
    setExtractOk(null);

    try {
      const headers = await getInvokeHeaders();

      const payload: any = {
        ledger_id: selected.id,
        p_ledger_id: selected.id,
        is_test: laneIsTest,
        force: !!opts?.force,
      };

      const { data, error } = await supabase.functions.invoke("axiom-extract-resolution-facts", {
        body: payload,
        headers,
      });

      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error || "AXIOM extract failed.");

      setExtractOk(data?.message ? String(data.message) : "Extracted facts successfully.");
      await loadLedgerIntel(selected.id);
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : "AXIOM extract failed.";
      setExtractErr(msg);
    } finally {
      setExtracting(false);
    }
  }

  return (
    <div className="w-full">
      <div className="mx-auto w-full max-w-[1200px] px-4 pb-10 pt-4 sm:pt-6">
        <div className={shell}>
          <div className={header}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10px] sm:text-xs tracking-[0.3em] uppercase text-slate-500">CI • Archive</div>
                <h1 className="mt-1 text-lg sm:text-xl font-semibold text-slate-50">Drafts &amp; Approvals</h1>
                <p className="mt-1 max-w-3xl text-[11px] sm:text-xs text-slate-400 leading-relaxed">
                  Lifecycle surface for governance_ledger. Read-only monitor. Lane-safe. Entity-scoped. Use Council/Forge/Archive to execute.
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
            <div className="mb-4 rounded-3xl border border-white/10 bg-black/20 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">Intelligence</div>
                  <div className="mt-1 text-sm text-slate-200">
                    {axiomListLoading ? "Loading signals…" : axiomListErr ? "Signals partially available" : "Signals loaded"}
                  </div>
                  {axiomListErr ? <div className="mt-1 text-[11px] text-amber-200/80">{axiomListErr}</div> : null}
                </div>

                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-slate-200">
                    <Sparkles className="h-4 w-4 text-amber-300" />
                    AXIOM notes: <span className="font-semibold">{topIntel.axiomNotesCount}</span>
                  </span>

                  <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-slate-200">
                    <Zap className="h-4 w-4 text-sky-300" />
                    Resolution facts: <span className="font-semibold">{topIntel.resolutionFactsCount}</span>
                  </span>

                  <span className="inline-flex items-center gap-2 rounded-full border border-rose-400/20 bg-rose-400/5 px-3 py-1 text-rose-100">
                    Critical: <span className="font-semibold">{topIntel.critical}</span>
                  </span>
                  <span className="inline-flex items-center gap-2 rounded-full border border-amber-400/20 bg-amber-400/5 px-3 py-1 text-amber-100">
                    Warning: <span className="font-semibold">{topIntel.warning}</span>
                  </span>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-12 gap-4">
              {/* LEFT */}
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
                    Lane-safe: fetched server-side via <span className="text-slate-200">ledger_scoped_v3</span> RPC (SECURITY DEFINER).
                  </div>

                  <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 p-3 text-xs text-slate-500 leading-relaxed">
                    Intelligence is <span className="text-slate-200">advisory-only</span>. Badges below are derived from stored sidecars (no mutation).
                  </div>

                  <div className="mt-4 rounded-3xl border border-white/10 bg-black/20 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="text-sm font-semibold text-slate-200 inline-flex items-center gap-2">
                          <List className="h-4 w-4 text-amber-300" />
                          AXIOM Notes
                        </div>
                        <div className="text-[11px] text-slate-500">Latest 5 draft reviews</div>
                      </div>
                    </div>

                    {axiomListLoading ? (
                      <div className="mt-3 rounded-2xl border border-white/10 bg-black/30 p-3 text-xs text-slate-400">Loading…</div>
                    ) : axiomList.length === 0 ? (
                      <div className="mt-3 rounded-2xl border border-white/10 bg-black/30 p-3 text-xs text-slate-500">
                        No AXIOM notes surfaced for this lane/entity yet.
                      </div>
                    ) : (
                      <div className="mt-3 space-y-2">
                        {axiomList.map((n) => (
                          <button
                            key={n.note_id}
                            onClick={() => {
                              const r = rows.find((x) => x.id === n.ledger_id) || null;
                              setSelected(
                                r || {
                                  id: n.ledger_id,
                                  title: n.title ?? "Record",
                                  status: null,
                                  entity_id: entityId,
                                  is_test: laneIsTest,
                                  envelope_id: null,
                                  created_at: null,
                                }
                              );
                              setOpen(true);
                              void loadLedgerIntel(n.ledger_id);
                            }}
                            className="w-full text-left rounded-2xl border border-white/10 bg-black/30 px-3 py-2 hover:bg-black/35 transition"
                            title="Open linked record"
                          >
                            <div className="text-xs font-semibold text-slate-200 truncate">{n.title || "AXIOM • Draft review"}</div>
                            <div className="mt-1 text-[11px] text-slate-500 line-clamp-2">{n.preview || "—"}</div>
                            <div className="mt-1 font-mono text-[10px] text-slate-600">{n.ledger_id.slice(0, 12)}…</div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </section>

              {/* MIDDLE */}
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
                              void loadLedgerIntel(r.id);
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

              {/* RIGHT */}
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
                    This page is a monitor. Actions are performed in Council/Forge/Archive. Details modal includes safe copy, module jumps, and advisory signals.
                  </div>
                </div>
              </section>
            </div>

            <div className="mt-5 rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-[11px] text-slate-400">
              <div className="font-semibold text-slate-200">OS behavior</div>
              <div className="mt-1 leading-relaxed text-slate-400">
                Drafts &amp; Approvals inherits the OS shell. Lane-safe and entity-scoped. Intelligence is advisory-only and never mutates authority automatically.
              </div>
            </div>

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

      {/* DETAILS MODAL */}
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
            <div
              className="w-full max-w-[980px] rounded-3xl border border-white/10 bg-black/60 shadow-[0_40px_140px_rgba(0,0,0,0.65)] overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
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

                    <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
                      <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-slate-200">
                        <Sparkles className="h-4 w-4 text-amber-300" />
                        AXIOM advisory
                      </span>

                      {draftLink?.id ? (
                        <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-3 py-1 text-slate-300">
                          <span className="text-slate-500">draft:</span>
                          <span className="font-mono text-slate-200">{draftLink.id.slice(0, 8)}…</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-3 py-1 text-slate-500">
                          No Alchemy draft link
                        </span>
                      )}

                      {draftConflicts?.id ? (
                        <span className={cx("inline-flex items-center gap-2 rounded-full border px-3 py-1", severityBadge(draftConflicts.severity))}>
                          <ShieldAlert className="h-4 w-4" />
                          <span className="text-slate-200">{String(draftConflicts.severity || "info").toUpperCase()}</span>
                          <span className="opacity-70">· {conflictsCount} conflict(s)</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-3 py-1 text-slate-500">
                          No conflicts snapshot
                        </span>
                      )}

                      <button
                        onClick={() => void loadLedgerIntel(selected.id)}
                        className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7"
                        title="Reload advisory signals"
                      >
                        <RotateCw className={cx("h-4 w-4", intelLoading && "animate-spin")} />
                        Refresh
                      </button>
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
                  <div className="col-span-12 lg:col-span-6">
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

                        {draftLink?.id && (
                          <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">draft_id</div>
                                <div className="mt-1 font-mono break-all text-[12px] text-slate-200">{draftLink.id}</div>
                                <div className="mt-2 text-xs text-slate-400">
                                  {draftLink.record_type ? `Record type: ${draftLink.record_type}` : "Record type: —"}
                                </div>
                              </div>
                              <button
                                onClick={() => safeCopy(draftLink.id)}
                                className="shrink-0 rounded-full border border-white/10 bg-white/5 px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7 inline-flex items-center gap-2"
                                title="Copy draft_id"
                              >
                                <Copy className="h-4 w-4" />
                                Copy
                              </button>
                            </div>
                          </div>
                        )}
                      </div>

                      {intelErr && (
                        <div className="mt-3 rounded-2xl border border-amber-400/20 bg-amber-400/5 p-3 text-xs text-amber-100 leading-relaxed">
                          <div className="font-semibold tracking-[0.18em] uppercase text-[10px]">Advisory read warning</div>
                          <div className="mt-1 opacity-90">{intelErr}</div>
                          <div className="mt-2 text-amber-100/70">
                            If this persists, browser RLS likely blocks reading advisory tables. This UI does not require new SQL, but policy may.
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="col-span-12 lg:col-span-6">
                    <div className="rounded-3xl border border-white/10 bg-black/30 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-slate-200">AXIOM Advisory</div>
                          <div className="text-[11px] text-slate-500">
                            Draft-stage review + authority conflict snapshot + archived-only resolution facts (advisory-only)
                          </div>
                        </div>

                        <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[10px] tracking-[0.18em] uppercase text-slate-200">
                          {intelLoading ? "loading" : "advisory"}
                        </span>
                      </div>

                      <div className="mt-3 rounded-3xl border border-white/10 bg-black/20 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">Resolution facts</div>
                            <div className="mt-1 text-sm text-slate-200">
                              {resolutionFacts?.id ? (
                                <>
                                  Stored facts available{" "}
                                  {resolutionFacts.extracted_at ? <span className="text-slate-500">· {resolutionFacts.extracted_at}</span> : null}
                                </>
                              ) : (
                                <span className="text-slate-500">
                                  No resolution facts stored yet. (Only available once ledger record is ARCHIVED.)
                                </span>
                              )}
                            </div>
                            {resolutionFacts?.model ? (
                              <div className="mt-1 text-[11px] text-slate-500">
                                Model: <span className="text-slate-300">{resolutionFacts.model}</span>
                              </div>
                            ) : null}
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              onClick={() => void loadLedgerIntel(selected.id)}
                              className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7 inline-flex items-center gap-2"
                              title="Reload facts"
                            >
                              <RotateCw className={cx("h-4 w-4", intelLoading && "animate-spin")} />
                              Reload
                            </button>

                            <button
                              onClick={() => void extractResolutionFacts({ force: false })}
                              disabled={extracting}
                              className={cx(
                                "rounded-full border px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase inline-flex items-center gap-2",
                                extracting
                                  ? "border-white/10 bg-black/30 text-slate-500 cursor-not-allowed"
                                  : "border-amber-400/35 bg-amber-400/10 text-amber-100 hover:bg-amber-400/15"
                              )}
                              title="Extract archived-only facts via Edge Function"
                            >
                              <Zap className={cx("h-4 w-4", extracting && "animate-pulse")} />
                              Extract
                            </button>
                          </div>
                        </div>

                        {extractErr ? (
                          <div className="mt-3 rounded-2xl border border-rose-400/25 bg-rose-400/10 p-3 text-xs text-rose-100 leading-relaxed">
                            <div className="font-semibold tracking-[0.18em] uppercase text-[10px]">AXIOM extract error</div>
                            <div className="mt-1 opacity-90">{extractErr}</div>
                          </div>
                        ) : null}

                        {extractOk ? (
                          <div className="mt-3 rounded-2xl border border-emerald-400/25 bg-emerald-400/10 p-3 text-xs text-emerald-100 leading-relaxed">
                            <div className="font-semibold tracking-[0.18em] uppercase text-[10px]">AXIOM extract</div>
                            <div className="mt-1 opacity-90">{extractOk}</div>
                          </div>
                        ) : null}

                        {resolutionFacts?.facts_json ? (
                          <pre className="mt-3 max-h-[240px] overflow-auto rounded-2xl border border-white/10 bg-black/30 p-3 text-[11px] leading-relaxed text-slate-200 whitespace-pre-wrap">
                            {tryJsonStringify(resolutionFacts.facts_json, 24_000)}
                          </pre>
                        ) : (
                          <div className="mt-3 rounded-2xl border border-white/10 bg-black/30 p-3 text-xs text-slate-500">
                            Extract reads the final archived resolution + verified registry artifact and stores structured facts in{" "}
                            <span className="text-slate-200">public.governance_resolution_facts</span> (advisory-only).
                          </div>
                        )}
                      </div>

                      <div className="mt-4 rounded-3xl border border-white/10 bg-black/20 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">Authority conflicts</div>
                            <div className="mt-1 text-sm text-slate-200">
                              {draftConflicts?.id ? (
                                <>
                                  Severity:{" "}
                                  <span className={cx("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] ml-1", severityBadge(draftConflicts.severity))}>
                                    {String(draftConflicts.severity || "info").toUpperCase()}
                                  </span>
                                  <span className="text-slate-500"> · </span>
                                  <span className="text-slate-300">{conflictsCount} conflict(s)</span>
                                </>
                              ) : (
                                <span className="text-slate-500">No snapshot available for this ledger record.</span>
                              )}
                            </div>
                          </div>

                          {draftConflicts?.id && (
                            <button
                              onClick={() => safeCopy(tryJsonStringify(draftConflicts.conflicts_json))}
                              className="shrink-0 rounded-full border border-white/10 bg-white/5 px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7 inline-flex items-center gap-2"
                              title="Copy conflicts JSON"
                            >
                              <Copy className="h-4 w-4" />
                              Copy JSON
                            </button>
                          )}
                        </div>

                        {draftConflicts?.id ? (
                          <pre className="mt-3 max-h-[220px] overflow-auto rounded-2xl border border-white/10 bg-black/30 p-3 text-[11px] leading-relaxed text-slate-300 whitespace-pre-wrap">
                            {tryJsonStringify(draftConflicts.conflicts_json, 24_000)}
                          </pre>
                        ) : (
                          <div className="mt-3 rounded-2xl border border-white/10 bg-black/30 p-3 text-xs text-slate-500">
                            Conflicts are stored when the draft check function runs. If this ledger record wasn’t finalized from an Alchemy draft, there may be nothing to show (by design).
                          </div>
                        )}
                      </div>

                      <div className="mt-4 rounded-3xl border border-white/10 bg-black/20 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-[10px] tracking-[0.3em] uppercase text-slate-500">AXIOM draft review</div>
                            <div className="mt-1 text-sm text-slate-200">
                              {axiomNote?.id ? (
                                <>
                                  <span className="text-slate-200">{axiomNote.title || "AXIOM • Draft review"}</span>
                                  <span className="text-slate-500"> · </span>
                                  <span className="text-slate-400">{axiomNote.created_at || "—"}</span>
                                </>
                              ) : (
                                <span className="text-slate-500">No AXIOM note found for this record’s draft link.</span>
                              )}
                            </div>
                          </div>

                          {axiomNote?.content && (
                            <button
                              onClick={() => safeCopy(axiomNote.content || "")}
                              className="shrink-0 rounded-full border border-white/10 bg-white/5 px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7 inline-flex items-center gap-2"
                              title="Copy AXIOM note"
                            >
                              <Copy className="h-4 w-4" />
                              Copy Note
                            </button>
                          )}
                        </div>

                        {axiomNote?.content ? (
                          <pre className="mt-3 max-h-[320px] overflow-auto rounded-2xl border border-white/10 bg-black/30 p-3 text-[11px] leading-relaxed text-slate-200 whitespace-pre-wrap">
                            {axiomNote.content}
                          </pre>
                        ) : (
                          <div className="mt-3 rounded-2xl border border-white/10 bg-black/30 p-3 text-xs text-slate-500">
                            If you just ran the draft review, refresh. If it still doesn’t appear, it usually means the record wasn’t finalized from that draft (or browser RLS blocks reading ai_notes).
                          </div>
                        )}
                      </div>

                      <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-3 text-[11px] text-slate-400 leading-relaxed">
                        <span className="text-slate-200 font-semibold">Contract:</span> advisory only, lane-safe, entity-scoped. No automatic authority mutation.
                      </div>
                    </div>
                  </div>

                  <div className="col-span-12">
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

                      <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-2">
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
