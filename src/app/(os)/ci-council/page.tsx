// src/app/(os)/ci-council/page.tsx
"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";

type CouncilTab = "pending" | "approved" | "rejected";
type ExecMode = "signature_required" | "direct_archive";

type CouncilRecord = {
  id: string;
  entity_id: string | null;
  title: string | null;
  body: string | null;
  record_type: string | null;
  status: string | null;
  created_at: string | null;

  // optional fields if your view exposes them
  draft_id?: string | null;
  envelope_id?: string | null;
  signer_url?: string | null;
  viewer_url?: string | null;
  verify_url?: string | null;
  certificate_url?: string | null;
};

const ENTITY_LABELS: Record<string, string> = {
  holdings: "Oasis International Holdings Inc.",
  lounge: "Oasis International Lounge Inc.",
  "real-estate": "Oasis International Real Estate Inc.",
};

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function fmtShort(iso: string | null) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function statusPill(status: string | null) {
  const s = (status ?? "").toUpperCase();
  if (s === "PENDING") return "bg-amber-500/15 text-amber-200 border-amber-400/40";
  if (s === "APPROVED") return "bg-emerald-500/15 text-emerald-200 border-emerald-400/40";
  if (s === "REJECTED") return "bg-rose-500/15 text-rose-200 border-rose-400/40";
  if (s === "SIGNING") return "bg-sky-500/15 text-sky-200 border-sky-400/40";
  if (s === "SIGNED") return "bg-emerald-500/10 text-emerald-200 border-emerald-400/30";
  if (s === "ARCHIVED") return "bg-slate-700/30 text-slate-200 border-slate-500/30";
  return "bg-slate-800/40 text-slate-200 border-slate-600/40";
}

export default function CICouncilPage() {
  const { activeEntity } = useEntity();
  const activeEntityLabel = useMemo(
    () => ENTITY_LABELS[activeEntity] ?? activeEntity,
    [activeEntity]
  );

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [tab, setTab] = useState<CouncilTab>("pending");
  const [query, setQuery] = useState("");
  const [records, setRecords] = useState<CouncilRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [axiomOpen, setAxiomOpen] = useState(true);

  // “decision mode” is UI-only (safe + non-blocking)
  const [execMode, setExecMode] = useState<ExecMode>("signature_required");

  // Reader modal
  const [readerOpen, setReaderOpen] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const selected = useMemo(
    () => records.find((r) => r.id === selectedId) ?? null,
    [records, selectedId]
  );

  const filtered = useMemo(() => {
    let list = [...records];

    // Tabs map to “status”
    const want =
      tab === "pending" ? "PENDING" : tab === "approved" ? "APPROVED" : "REJECTED";
    list = list.filter((r) => (r.status ?? "").toUpperCase() === want);

    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter((r) => {
        const hay = `${r.title ?? ""}\n${r.body ?? ""}\n${r.record_type ?? ""}`.toLowerCase();
        return hay.includes(q);
      });
    }

    return list;
  }, [records, tab, query]);

  function flashError(msg: string) {
    console.error(msg);
    setError(msg);
    setTimeout(() => setError(null), 5500);
  }

  function flashInfo(msg: string) {
    setInfo(msg);
    setTimeout(() => setInfo(null), 3000);
  }

  async function loadRecords() {
    setLoading(true);
    setError(null);

    // Prefer your v3 scoped view (canonical)
    const tryView = async () => {
      const { data, error } = await supabase
        .from("v_governance_ledger_scoped_v3")
        .select(
          `
          id,
          entity_id,
          title,
          body,
          record_type,
          status,
          created_at,
          draft_id,
          envelope_id,
          signer_url,
          viewer_url,
          verify_url,
          certificate_url
        `
        )
        .eq("entity_slug", activeEntity) // view usually exposes entity_slug; if it doesn't, it will error and we fallback
        .order("created_at", { ascending: false });

      if (error) throw error;
      return (data ?? []) as CouncilRecord[];
    };

    // Fallback: raw governance_ledger (entity scoped via entity_id lookup)
    const fallback = async () => {
      const { data: ent, error: entErr } = await supabase
        .from("entities")
        .select("id")
        .eq("slug", activeEntity)
        .single();

      if (entErr || !ent?.id) throw entErr ?? new Error("Entity not found.");

      const { data, error } = await supabase
        .from("governance_ledger")
        .select("id, entity_id, title, body, record_type, status, created_at")
        .eq("entity_id", ent.id)
        .order("created_at", { ascending: false });

      if (error) throw error;
      return (data ?? []) as CouncilRecord[];
    };

    try {
      let rows: CouncilRecord[] = [];
      try {
        rows = await tryView();
      } catch (e) {
        // view not present or missing entity_slug — fall back
        rows = await fallback();
      }

      setRecords(rows);

      // preserve selection if possible
      if (selectedId) {
        const still = rows.find((r) => r.id === selectedId);
        if (still) return;
      }

      // default select newest pending (if any)
      const pending = rows.find((r) => (r.status ?? "").toUpperCase() === "PENDING");
      if (pending) setSelectedId(pending.id);
      else setSelectedId(rows[0]?.id ?? null);
    } catch (err: any) {
      flashError(err?.message ?? "Failed to load council queue.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      await loadRecords();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEntity]);

  async function updateStatus(next: "APPROVED" | "REJECTED") {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setInfo(null);

    try {
      // minimal/no-rewire update: status only
      const { data, error } = await supabase
        .from("governance_ledger")
        .update({
          status: next,
          // if your table has decided_at/updated_at, this is safe-ish; if not, it will be ignored by PostgREST only if column exists.
          // But PostgREST will error on unknown columns, so we keep it minimal.
        })
        .eq("id", selected.id)
        .select("id, status")
        .single();

      if (error) throw error;

      setRecords((prev) =>
        prev.map((r) => (r.id === selected.id ? { ...r, status: (data as any)?.status ?? next } : r))
      );

      flashInfo(next === "APPROVED" ? "Approved." : "Rejected.");
    } catch (err: any) {
      flashError(
        err?.message ??
          "Could not update status. (If governance_ledger is immutable here, keep Council as read-only and drive execution via Forge.)"
      );
    } finally {
      setBusy(false);
    }
  }

  const canDecide = useMemo(() => {
    if (!selected) return false;
    return (selected.status ?? "").toUpperCase() === "PENDING";
  }, [selected]);

  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      {/* Header */}
      <div className="mb-4 shrink-0">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">
          Oasis Digital Parliament
        </div>
        <h1 className="mt-1 text-xl font-semibold text-slate-50">
          CI-Council · Approval & Authority Gate
        </h1>
        <p className="mt-1 text-xs text-slate-400 max-w-3xl">
          Council is the authority that decides execution mode:{" "}
          <span className="text-slate-200 font-semibold">Signature-required</span>{" "}
          (Forge) or{" "}
          <span className="text-slate-200 font-semibold">Direct archive</span>{" "}
          (PDF + Archive discipline). Advisory is non-blocking.
        </p>
        <div className="mt-2 text-xs text-slate-400">
          Entity:{" "}
          <span className="text-emerald-300 font-medium">{activeEntityLabel}</span>
        </div>
      </div>

      {/* Main OS window */}
      <div className="flex-1 min-h-0 flex justify-center overflow-hidden">
        <div className="w-full max-w-[1500px] h-full rounded-3xl border border-slate-900 bg-black/60 shadow-[0_0_60px_rgba(15,23,42,0.9)] px-6 py-5 flex flex-col overflow-hidden">
          {/* Top tabs + controls */}
          <div className="shrink-0 mb-4 flex items-center justify-between gap-4">
            <div className="inline-flex rounded-full bg-slate-950/70 border border-slate-800 p-1">
              <TabButton
                label="Pending"
                description="Awaiting decision"
                active={tab === "pending"}
                onClick={() => setTab("pending")}
              />
              <TabButton
                label="Approved"
                description="Authorized"
                active={tab === "approved"}
                onClick={() => setTab("approved")}
              />
              <TabButton
                label="Rejected"
                description="Declined"
                active={tab === "rejected"}
                onClick={() => setTab("rejected")}
              />
            </div>

            <div className="flex items-center gap-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search queue…"
                className="hidden md:block w-[320px] rounded-full border border-slate-800 bg-slate-950/60 px-4 py-2 text-xs text-slate-100 outline-none focus:border-emerald-400"
              />

              <button
                onClick={() => loadRecords()}
                disabled={loading || busy}
                className="rounded-full border border-slate-800 bg-slate-950/60 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60 disabled:opacity-50"
              >
                Refresh
              </button>

              <button
                onClick={() => setAxiomOpen((v) => !v)}
                className="rounded-full border border-slate-800 bg-slate-950/60 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60"
              >
                {axiomOpen ? "Hide AXIOM" : "Show AXIOM"}
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 min-h-0 flex gap-4 overflow-hidden">
            {/* Left: Queue */}
            <div className="w-[34%] min-w-[360px] h-full rounded-2xl border border-slate-800 bg-slate-950/40 flex flex-col overflow-hidden">
              <div className="shrink-0 px-5 py-4 border-b border-slate-800 flex items-center justify-between">
                <div>
                  <div className="text-xs font-semibold text-slate-100">Council Queue</div>
                  <div className="text-[11px] text-slate-400">
                    {tab.toUpperCase()} · {filtered.length}/{records.length}
                  </div>
                </div>
                <div className="md:hidden w-[160px]">
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search…"
                    className="w-full rounded-full border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs text-slate-100 outline-none focus:border-emerald-400"
                  />
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto">
                {loading ? (
                  <div className="p-5 text-xs text-slate-400">Loading…</div>
                ) : filtered.length === 0 ? (
                  <div className="p-5 text-xs text-slate-500">No items in this tab.</div>
                ) : (
                  <ul className="divide-y divide-slate-800">
                    {filtered.map((r) => (
                      <li
                        key={r.id}
                        onClick={() => setSelectedId(r.id)}
                        className={cx(
                          "cursor-pointer px-5 py-4 hover:bg-slate-900/50 transition",
                          r.id === selectedId && "bg-slate-900/70"
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-semibold text-slate-100 truncate">
                              {r.title || "(untitled)"}
                            </div>
                            <div className="mt-1 text-[11px] text-slate-500 flex items-center gap-2">
                              <span>{fmtShort(r.created_at)}</span>
                              <span className="w-1 h-1 rounded-full bg-slate-700" />
                              <span className="uppercase tracking-[0.18em]">
                                {r.record_type || "resolution"}
                              </span>
                            </div>
                            <div className="mt-2 line-clamp-2 text-xs text-slate-400">
                              {r.body || "—"}
                            </div>
                          </div>

                          <span
                            className={cx(
                              "shrink-0 rounded-full border px-3 py-1 text-[10px] uppercase tracking-[0.18em]",
                              statusPill(r.status)
                            )}
                          >
                            {(r.status ?? "—").toUpperCase()}
                          </span>
                        </div>

                        {(r.envelope_id || r.verify_url) && (
                          <div className="mt-3 rounded-xl border border-slate-800 bg-black/30 px-3 py-2 text-[11px] text-slate-300">
                            Signature artifacts available
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {/* Middle: Decision panel (contained) */}
            <div className="flex-1 min-w-0 h-full rounded-2xl border border-slate-800 bg-slate-950/40 flex flex-col overflow-hidden">
              <div className="shrink-0 px-5 py-4 border-b border-slate-800 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
                    Selected record
                  </div>
                  <div className="mt-1 text-sm font-semibold text-slate-100 truncate">
                    {selected?.title || "Select an item in the queue"}
                  </div>
                  <div className="mt-1 text-xs text-slate-400 flex items-center gap-2">
                    <span className="uppercase tracking-[0.18em]">
                      {(selected?.record_type || "resolution").toUpperCase()}
                    </span>
                    <span className="w-1 h-1 rounded-full bg-slate-700" />
                    <span>{fmtShort(selected?.created_at ?? null)}</span>
                    {selected?.status && (
                      <>
                        <span className="w-1 h-1 rounded-full bg-slate-700" />
                        <span className="text-slate-300 font-semibold">
                          {(selected.status ?? "").toUpperCase()}
                        </span>
                      </>
                    )}
                  </div>
                </div>

                {selected && (
                  <span
                    className={cx(
                      "shrink-0 rounded-full border px-3 py-1 text-[10px] uppercase tracking-[0.18em]",
                      statusPill(selected.status)
                    )}
                  >
                    {(selected.status ?? "—").toUpperCase()}
                  </span>
                )}
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto px-5 py-5">
                {/* Execution mode (Council authority) */}
                <div className="rounded-2xl border border-slate-800 bg-black/30 p-4">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
                    Council decision
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setExecMode("signature_required")}
                      className={cx(
                        "rounded-full px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase border transition",
                        execMode === "signature_required"
                          ? "border-emerald-400/70 bg-emerald-500/15 text-emerald-200"
                          : "border-slate-800 bg-slate-950/40 text-slate-300 hover:bg-slate-900/60"
                      )}
                    >
                      Signature required (Forge)
                    </button>
                    <button
                      type="button"
                      onClick={() => setExecMode("direct_archive")}
                      className={cx(
                        "rounded-full px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase border transition",
                        execMode === "direct_archive"
                          ? "border-sky-400/70 bg-sky-500/15 text-sky-200"
                          : "border-slate-800 bg-slate-950/40 text-slate-300 hover:bg-slate-900/60"
                      )}
                    >
                      Direct archive (PDF discipline)
                    </button>
                  </div>

                  <div className="mt-3 text-xs text-slate-400 leading-relaxed">
                    This toggle is <span className="text-slate-200 font-semibold">authority intent</span>.
                    Execution is handled by Forge (signature path) or Archive (direct path) — neither path may bypass PDF + hash + registry discipline.
                  </div>
                </div>

                {/* Actions */}
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setReaderOpen(true)}
                    disabled={!selected}
                    className="rounded-full px-5 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase border border-slate-800 bg-slate-950/40 text-slate-200 hover:bg-slate-900/60 disabled:opacity-50"
                  >
                    Open Reader
                  </button>

                  <div className="flex-1" />

                  <button
                    type="button"
                    onClick={() => updateStatus("REJECTED")}
                    disabled={!selected || !canDecide || busy}
                    className="rounded-full px-5 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase border border-rose-400/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/15 disabled:opacity-50"
                  >
                    Reject
                  </button>

                  <button
                    type="button"
                    onClick={() => updateStatus("APPROVED")}
                    disabled={!selected || !canDecide || busy}
                    className="rounded-full px-5 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase bg-emerald-500 text-black hover:bg-emerald-400 transition disabled:opacity-50"
                  >
                    Approve
                  </button>
                </div>

                {/* Artifact links (if present) */}
                {selected && (selected.verify_url || selected.certificate_url || selected.signer_url) && (
                  <div className="mt-4 rounded-2xl border border-slate-800 bg-black/30 p-4">
                    <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
                      Portal links
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                      {selected.signer_url && (
                        <a
                          href={selected.signer_url}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-full border border-slate-800 bg-slate-950/40 px-4 py-2 text-slate-200 hover:bg-slate-900/60"
                        >
                          Signer
                        </a>
                      )}
                      {selected.verify_url && (
                        <a
                          href={selected.verify_url}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-full border border-slate-800 bg-slate-950/40 px-4 py-2 text-slate-200 hover:bg-slate-900/60"
                        >
                          Verify
                        </a>
                      )}
                      {selected.certificate_url && (
                        <a
                          href={selected.certificate_url}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-full border border-slate-800 bg-slate-950/40 px-4 py-2 text-slate-200 hover:bg-slate-900/60"
                        >
                          Certificate
                        </a>
                      )}
                    </div>
                    <div className="mt-3 text-xs text-slate-500">
                      These are generated via your portal config + <span className="text-slate-300 font-semibold">ci_portal_urls(envelope_id)</span>.
                    </div>
                  </div>
                )}

                {(error || info) && (
                  <div className="mt-4">
                    {error && (
                      <div className="rounded-2xl border border-red-500/50 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                        {error}
                      </div>
                    )}
                    {info && !error && (
                      <div className="rounded-2xl border border-emerald-500/50 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
                        {info}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="shrink-0 px-5 py-3 border-t border-slate-800 text-[10px] text-slate-500 flex items-center justify-between">
                <span>CI-Council · Authority gate</span>
                <span>Approved ≠ Archived · execution produces identical PDF artifacts</span>
              </div>
            </div>

            {/* Right: AXIOM advisory (non-blocking) */}
            {axiomOpen && (
              <div className="w-[320px] min-w-[320px] h-full rounded-2xl border border-slate-800 bg-slate-950/40 flex flex-col overflow-hidden">
                <div className="shrink-0 px-5 py-4 border-b border-slate-800">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                    AXIOM Advisory
                  </div>
                  <div className="mt-2 text-xs text-slate-300 leading-relaxed">
                    Read-only guidance: missing clauses, risk flags, execution recommendations.
                  </div>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto px-5 py-5">
                  <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
                    Advisory only. Authority remains Evidence-Bound.
                  </div>

                  <div className="mt-4 rounded-2xl border border-slate-800 bg-black/25 px-4 py-4">
                    <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
                      What AXIOM would check
                    </div>
                    <ul className="mt-3 space-y-2 text-xs text-slate-300">
                      <li>• Correct entity naming + signing authority</li>
                      <li>• Missing “WHEREAS” recitals / scope definition</li>
                      <li>• Execution mode fit: signature vs direct archive</li>
                      <li>• Conflicts with prior resolutions (ledger history)</li>
                      <li>• Required attachments / exhibits / evidence</li>
                    </ul>
                    <div className="mt-4 text-[11px] text-slate-500">
                      (Later) this panel can be wired to ai_analyses / ai_advice for this record.
                    </div>
                  </div>
                </div>

                <div className="shrink-0 px-5 py-3 border-t border-slate-800 text-[10px] text-slate-500">
                  AXIOM · non-blocking intelligence layer
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Reader modal */}
      {readerOpen && selected && (
        <div className="fixed inset-0 z-[90] bg-black/70 flex items-center justify-center p-6">
          <div className="w-full max-w-[980px] h-[85vh] rounded-3xl border border-slate-800 bg-black/80 shadow-2xl shadow-black/60 flex flex-col overflow-hidden">
            <div className="shrink-0 px-6 py-4 border-b border-slate-800 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
                  Reader
                </div>
                <div className="mt-1 text-lg font-semibold text-slate-100 truncate">
                  {selected.title || "(untitled)"}
                </div>
                <div className="mt-1 text-xs text-slate-400 flex items-center gap-2">
                  <span>{fmtShort(selected.created_at)}</span>
                  <span className="w-1 h-1 rounded-full bg-slate-700" />
                  <span className="uppercase tracking-[0.18em]">{selected.record_type || "resolution"}</span>
                  <span className="w-1 h-1 rounded-full bg-slate-700" />
                  <span className="text-slate-300 font-semibold">{(selected.status ?? "").toUpperCase()}</span>
                </div>
              </div>

              <button
                onClick={() => setReaderOpen(false)}
                className="rounded-full border border-slate-700 bg-slate-950/60 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60"
              >
                Close
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-6 py-6">
              <div className="rounded-2xl border border-slate-800 bg-slate-950/35 px-6 py-6">
                <pre className="whitespace-pre-wrap font-sans text-[13px] leading-[1.7] text-slate-100">
                  {selected.body || "—"}
                </pre>
              </div>
            </div>

            <div className="shrink-0 px-6 py-4 border-t border-slate-800 text-[10px] text-slate-500 flex items-center justify-between">
              <span>CI-Council Reader</span>
              <span>Evidence-Bound · Advisory is non-blocking</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TabButton({
  label,
  description,
  active,
  onClick,
}: {
  label: string;
  description: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "px-4 py-2 rounded-full text-left transition min-w-[150px]",
        active
          ? "bg-emerald-500/15 border border-emerald-400/70 text-slate-50"
          : "bg-transparent border border-transparent hover:bg-slate-900/60 text-slate-300"
      )}
    >
      <div className="text-xs font-semibold">{label}</div>
      <div className="text-[10px] text-slate-400">{description}</div>
    </button>
  );
}
