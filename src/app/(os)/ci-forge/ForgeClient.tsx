"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";

type ForgeQueueItem = {
  ledger_id: string;
  title: string;
  ledger_status: string;
  created_at: string;
  entity_id: string;
  entity_name: string;
  entity_slug: string;

  envelope_id: string | null;
  envelope_status: string | null;

  parties_total: number | null;
  parties_signed: number | null;
  last_signed_at: string | null;
  days_since_last_signature: number | null;

  // Optional: if your view adds later
  body?: string | null;
};

type StartSignatureResponse = {
  ok: boolean;
  envelope_id?: string;
  record_id?: string;
  entity_slug?: string;
  reused?: boolean;
  error?: string;
};

type SendInviteResponse = {
  ok: boolean;
  message?: string;
  error?: string;
};

type ArchiveSignedResolutionResponse = {
  ok: boolean;
  minute_book_entry_id?: string;
  governance_document_id?: string;
  already_archived?: boolean;
  error?: string;
};

type RiskLevel = "GREEN" | "AMBER" | "RED" | "IDLE";
type TabKey = "active" | "completed";

function fmt(iso: string | null | undefined) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function clamp(s: string, n: number) {
  const t = (s ?? "").trim();
  if (!t) return "";
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

export default function ForgeClient() {
  const { activeEntity } = useEntity();

  const [tab, setTab] = useState<TabKey>("active");

  const [queue, setQueue] = useState<ForgeQueueItem[]>([]);
  const [loadingQueue, setLoadingQueue] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [primarySignerName, setPrimarySignerName] = useState("");
  const [primarySignerEmail, setPrimarySignerEmail] = useState("");
  const [ccEmails, setCcEmails] = useState("");

  const [isStarting, setIsStarting] = useState(false);
  const [isSendingInvite, setIsSendingInvite] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // --------------------------
  // Load Forge queue (entity-scoped, OS selector)
  // --------------------------
  useEffect(() => {
    let cancelled = false;

    async function fetchQueue() {
      setLoadingQueue(true);
      setError(null);
      setInfo(null);

      try {
        const { data, error } = await supabase
          .from("v_forge_queue_latest")
          .select(
            [
              "ledger_id",
              "title",
              "ledger_status",
              "created_at",
              "entity_id",
              "entity_name",
              "entity_slug",
              "envelope_id",
              "envelope_status",
              "parties_total",
              "parties_signed",
              "last_signed_at",
              "days_since_last_signature",
            ].join(", "),
          )
          .eq("entity_slug", activeEntity)
          .order("created_at", { ascending: false });

        if (cancelled) return;

        if (error) {
          console.error("CI-Forge queue error:", error);
          setQueue([]);
          setSelectedId(null);
          setError("Unable to load Forge queue for this entity.");
          return;
        }

        const rows = ((data ?? []) as unknown as ForgeQueueItem[]) ?? [];
        setQueue(rows);
        setSelectedId(rows[0]?.ledger_id ?? null);
      } catch (err) {
        console.error("CI-Forge queue exception:", err);
        if (cancelled) return;
        setQueue([]);
        setSelectedId(null);
        setError("Unable to load Forge queue for this entity.");
      } finally {
        if (!cancelled) setLoadingQueue(false);
      }
    }

    fetchQueue();
    return () => {
      cancelled = true;
    };
  }, [activeEntity]);

  // --------------------------
  // Split queue into Active vs Completed
  // --------------------------
  const isCompleted = (item: ForgeQueueItem) => item.envelope_status === "completed";

  const activeQueue = useMemo(() => queue.filter((q) => !isCompleted(q)), [queue]);
  const completedQueue = useMemo(() => queue.filter((q) => isCompleted(q)), [queue]);

  const visibleQueue = tab === "active" ? activeQueue : completedQueue;

  useEffect(() => {
    // When switching tabs, auto-select first item in that tab
    setSelectedId(visibleQueue[0]?.ledger_id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const selected =
    visibleQueue.find((q) => q.ledger_id === selectedId) ??
    visibleQueue[0] ??
    null;

  const envelopeLocked =
    !!selected?.envelope_status &&
    selected.envelope_status !== "cancelled" &&
    selected.envelope_status !== "expired";

  const envelopeSigned = selected?.envelope_status === "completed";

  // --------------------------
  // Risk engine (advisory-only)
  // --------------------------
  const computeRiskLevel = (item: ForgeQueueItem): RiskLevel => {
    const days = item.days_since_last_signature ?? null;
    const status = item.envelope_status;

    if (!status || status === "draft" || status === "pending") {
      if (days == null) return "IDLE";
      if (days >= 7) return "RED";
      if (days >= 3) return "AMBER";
      return "GREEN";
    }

    if (status === "completed") {
      if (days != null && days >= 7) return "AMBER";
      return "GREEN";
    }

    if (status === "cancelled" || status === "expired") return "IDLE";
    return "IDLE";
  };

  const riskLightClasses = (risk: RiskLevel) => {
    switch (risk) {
      case "GREEN":
        return "bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.9)]";
      case "AMBER":
        return "bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.9)]";
      case "RED":
        return "bg-rose-500 shadow-[0_0_10px_rgba(248,113,113,0.9)]";
      default:
        return "bg-slate-500 shadow-[0_0_8px_rgba(148,163,184,0.9)]";
    }
  };

  const riskLabel = (risk: RiskLevel) => {
    if (risk === "RED") return "Dormant";
    if (risk === "AMBER") return "Delayed";
    if (risk === "GREEN") return "Healthy";
    return "Idle";
  };

  function flashError(msg: string) {
    console.error(msg);
    setError(msg);
    setTimeout(() => setError(null), 6000);
  }

  function flashInfo(msg: string) {
    setInfo(msg);
    setTimeout(() => setInfo(null), 4500);
  }

  // --------------------------
  // Actions (keep existing wiring)
  // --------------------------
  async function refreshQueueKeepSelection(keepLedgerId?: string | null) {
    try {
      const { data, error } = await supabase
        .from("v_forge_queue_latest")
        .select(
          [
            "ledger_id",
            "title",
            "ledger_status",
            "created_at",
            "entity_id",
            "entity_name",
            "entity_slug",
            "envelope_id",
            "envelope_status",
            "parties_total",
            "parties_signed",
            "last_signed_at",
            "days_since_last_signature",
          ].join(", "),
        )
        .eq("entity_slug", activeEntity)
        .order("created_at", { ascending: false });

      if (error) throw error;

      const rows = ((data ?? []) as unknown as ForgeQueueItem[]) ?? [];
      setQueue(rows);

      const nextVisible = tab === "active" ? rows.filter((r) => !isCompleted(r)) : rows.filter((r) => isCompleted(r));
      const fallback = nextVisible[0]?.ledger_id ?? null;
      const desired = keepLedgerId && nextVisible.some((x) => x.ledger_id === keepLedgerId) ? keepLedgerId : fallback;
      setSelectedId(desired);
    } catch (e) {
      console.error("refreshQueue error", e);
    }
  }

  async function onStartEnvelope(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);

    if (!selected) return;
    if (envelopeLocked) {
      flashInfo("Envelope already exists for this record.");
      return;
    }
    if (!primarySignerEmail.trim() || !primarySignerName.trim()) {
      flashError("Signer name + email are required.");
      return;
    }

    setIsStarting(true);
    try {
      const { data, error } = await supabase.functions.invoke("start-signature", {
        body: {
          record_id: selected.ledger_id,
          entity_slug: selected.entity_slug,
          signer_name: primarySignerName.trim(),
          signer_email: primarySignerEmail.trim(),
          cc_emails: ccEmails
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
        },
      });

      if (error) throw error;
      const res = data as StartSignatureResponse;

      if (!res?.ok) {
        flashError(res?.error ?? "Unable to start envelope.");
        return;
      }

      flashInfo(res.reused ? "Existing envelope reused." : "Envelope started.");
      await refreshQueueKeepSelection(selected.ledger_id);
    } catch (err) {
      console.error("start-signature error", err);
      flashError("Unable to start envelope.");
    } finally {
      setIsStarting(false);
    }
  }

  async function onSendInvite() {
    setError(null);
    setInfo(null);

    if (!selected?.envelope_id) {
      flashError("No envelope found for this record.");
      return;
    }

    setIsSendingInvite(true);
    try {
      const { data, error } = await supabase.functions.invoke("send-signature-invite", {
        body: { envelope_id: selected.envelope_id },
      });

      if (error) throw error;
      const res = data as SendInviteResponse;

      if (!res?.ok) {
        flashError(res?.error ?? "Unable to send invite.");
        return;
      }

      flashInfo(res.message ?? "Invite sent.");
      await refreshQueueKeepSelection(selected.ledger_id);
    } catch (err) {
      console.error("send-signature-invite error", err);
      flashError("Unable to send invite.");
    } finally {
      setIsSendingInvite(false);
    }
  }

  async function onArchiveSigned() {
    setError(null);
    setInfo(null);

    if (!selected?.envelope_id) {
      flashError("No envelope found for this record.");
      return;
    }
    if (!envelopeSigned) {
      flashError("Envelope is not completed yet.");
      return;
    }

    setIsArchiving(true);
    try {
      const { data, error } = await supabase.functions.invoke("archive-signed-resolution", {
        body: { envelope_id: selected.envelope_id },
      });

      if (error) throw error;
      const res = data as ArchiveSignedResolutionResponse;

      if (!res?.ok) {
        flashError(res?.error ?? "Unable to archive signed resolution.");
        return;
      }

      if (res.already_archived) flashInfo("Already archived.");
      else flashInfo("Archived into CI-Archive Minute Book.");

      await refreshQueueKeepSelection(selected.ledger_id);
    } catch (err) {
      console.error("archive-signed-resolution error", err);
      flashError("Unable to archive signed resolution.");
    } finally {
      setIsArchiving(false);
    }
  }

  // --------------------------
  // AXIOM advisory (UI only, never blocking)
  // --------------------------
  const axiomAdvisory = useMemo(() => {
    if (!selected) return { severity: "IDLE" as RiskLevel, bullets: ["Select an execution record to view intelligence."] };

    const risk = computeRiskLevel(selected);
    const bullets: string[] = [];

    if (!selected.envelope_id) bullets.push("No envelope exists yet. If Council approved signature-required execution, start the envelope.");
    if (selected.envelope_id && !envelopeSigned) bullets.push("Envelope is active. Monitor signer progress; resend invite if stalled.");
    if (envelopeSigned) bullets.push("Envelope completed. Next action is Archive Now to generate archive-grade artifacts + registry entry.");

    if (!primarySignerEmail.trim() || !primarySignerName.trim()) {
      bullets.push("Signer identity fields are empty in UI. Ensure signer name + email are correct before starting execution.");
    }

    bullets.push("AXIOM is advisory-only: it never blocks human authority.");

    return { severity: risk, bullets };
  }, [selected, envelopeSigned, primarySignerEmail, primarySignerName]);

  // --------------------------
  // UI helpers
  // --------------------------
  const tabBtn = (k: TabKey, label: string, count: number) => (
    <button
      type="button"
      onClick={() => setTab(k)}
      className={[
        "rounded-full px-3 py-1.5 text-[11px] font-semibold transition border",
        tab === k
          ? "bg-slate-100 text-slate-950 border-white/20 shadow-md shadow-white/10"
          : "bg-slate-950/40 text-slate-300 border-slate-800 hover:border-slate-700 hover:text-slate-100",
      ].join(" ")}
    >
      {label} <span className="ml-1 text-[10px] opacity-70">({count})</span>
    </button>
  );

  return (
    <div className="flex h-full flex-col px-8 pt-6 pb-6">
      {/* Header */}
      <div className="mb-4 shrink-0">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">CI-FORGE</div>
        <h1 className="mt-1 text-lg font-semibold text-amber-300">Execution — Signature-required</h1>
        <p className="mt-1 text-[11px] text-slate-400">
          Entity-scoped via OS selector. Forge is signature-only. Archive quality artifacts are produced after completion.
        </p>
      </div>

      {/* Main frame */}
      <div className="flex min-h-0 flex-1 justify-center overflow-hidden">
        <div className="flex h-full w-full max-w-[1400px] flex-col overflow-hidden rounded-3xl border border-slate-900 bg-black/60 px-6 py-5 shadow-[0_0_60px_rgba(15,23,42,0.9)]">
          {/* Title bar */}
          <div className="mb-4 flex shrink-0 items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <div className="text-[11px] text-slate-400">
                Active Entity: <span className="font-semibold text-slate-100">{activeEntity}</span>
              </div>
              <div className="text-[11px] text-slate-500">
                Queue is sourced from <span className="text-slate-300">v_forge_queue_latest</span>.
              </div>
            </div>

            <div className="flex items-center gap-2">
              {tabBtn("active", "Active", activeQueue.length)}
              {tabBtn("completed", "Completed", completedQueue.length)}
              <button
                type="button"
                onClick={() => refreshQueueKeepSelection(selected?.ledger_id ?? null)}
                className="rounded-full border border-slate-800 bg-slate-950/50 px-3 py-1.5 text-[11px] font-semibold text-slate-200 hover:border-slate-700 hover:text-slate-100 transition"
              >
                Refresh
              </button>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 gap-5 overflow-hidden">
            {/* Left column: queue */}
            <section className="w-[320px] shrink-0 overflow-hidden rounded-2xl border border-slate-900 bg-slate-950/40">
              <div className="border-b border-slate-900 px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
                  {tab === "active" ? "Active Execution Queue" : "Completed Envelopes"}
                </div>
                <div className="mt-1 text-[11px] text-slate-400">
                  {loadingQueue ? "Loading…" : `${visibleQueue.length} record(s)`}
                </div>
              </div>

              <div className="h-full overflow-y-auto px-2 py-2">
                {!visibleQueue.length && !loadingQueue ? (
                  <div className="px-3 py-3 text-[11px] text-slate-500">
                    Nothing here yet. When Council approves signature-required execution, it will appear in Forge.
                  </div>
                ) : null}

                {visibleQueue.map((q) => {
                  const risk = computeRiskLevel(q);
                  const selectedRow = q.ledger_id === selected?.ledger_id;

                  return (
                    <button
                      key={q.ledger_id}
                      type="button"
                      onClick={() => setSelectedId(q.ledger_id)}
                      className={[
                        "w-full text-left rounded-xl border px-3 py-2 mb-2 transition",
                        selectedRow
                          ? "border-amber-500/50 bg-amber-500/10"
                          : "border-slate-900 bg-black/30 hover:border-slate-800 hover:bg-black/40",
                      ].join(" ")}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-[12px] font-semibold text-slate-100">
                            {clamp(q.title || "Untitled", 52)}
                          </div>
                          <div className="mt-1 text-[10px] text-slate-500">
                            {q.envelope_status ? `Envelope: ${q.envelope_status}` : "No envelope yet"}
                          </div>
                        </div>

                        <div className="flex flex-col items-end gap-2">
                          <div className={["h-2.5 w-2.5 rounded-full", riskLightClasses(risk)].join(" ")} title={riskLabel(risk)} />
                          <div className="text-[10px] text-slate-500">
                            {q.parties_signed ?? 0}/{q.parties_total ?? 0}
                          </div>
                        </div>
                      </div>

                      <div className="mt-2 flex items-center justify-between text-[10px] text-slate-500">
                        <span>{q.ledger_status}</span>
                        <span>{fmt(q.created_at)}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* Middle column: execution */}
            <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-slate-900 bg-slate-950/30">
              <div className="border-b border-slate-900 px-5 py-4">
                <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Execution</div>
                <div className="mt-1 text-sm font-semibold text-slate-100">
                  {selected ? selected.title : "No record selected"}
                </div>
                <div className="mt-1 text-[11px] text-slate-500">
                  Ledger Status: <span className="text-slate-300">{selected?.ledger_status ?? "—"}</span>{" "}
                  • Envelope: <span className="text-slate-300">{selected?.envelope_status ?? "—"}</span>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {!selected ? (
                  <div className="text-[11px] text-slate-500">Select a record from the queue.</div>
                ) : (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div className="rounded-2xl border border-slate-900 bg-black/30 p-4">
                        <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500 mb-2">
                          Signer
                        </div>

                        <div className="space-y-2">
                          <div>
                            <div className="text-[10px] text-slate-500 mb-1">Full name</div>
                            <input
                              value={primarySignerName}
                              onChange={(e) => setPrimarySignerName(e.target.value)}
                              className="w-full rounded-xl bg-slate-950/70 border border-slate-800 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500/50"
                              placeholder="Signer name"
                            />
                          </div>

                          <div>
                            <div className="text-[10px] text-slate-500 mb-1">Email</div>
                            <input
                              value={primarySignerEmail}
                              onChange={(e) => setPrimarySignerEmail(e.target.value)}
                              className="w-full rounded-xl bg-slate-950/70 border border-slate-800 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500/50"
                              placeholder="signer@email.com"
                            />
                          </div>

                          <div>
                            <div className="text-[10px] text-slate-500 mb-1">CC (comma-separated)</div>
                            <input
                              value={ccEmails}
                              onChange={(e) => setCcEmails(e.target.value)}
                              className="w-full rounded-xl bg-slate-950/70 border border-slate-800 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500/50"
                              placeholder="cc1@email.com, cc2@email.com"
                            />
                          </div>
                        </div>
                      </div>

                      <div className="rounded-2xl border border-slate-900 bg-black/30 p-4">
                        <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500 mb-2">
                          Actions
                        </div>

                        <div className="flex flex-col gap-2">
                          <form onSubmit={onStartEnvelope}>
                            <button
                              type="submit"
                              disabled={isStarting || envelopeLocked}
                              className={[
                                "w-full rounded-xl px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition",
                                isStarting || envelopeLocked
                                  ? "bg-emerald-500/20 text-emerald-200/60 cursor-not-allowed"
                                  : "bg-emerald-500 text-black hover:bg-emerald-400",
                              ].join(" ")}
                            >
                              {envelopeLocked ? "Envelope already created" : isStarting ? "Starting…" : "Start envelope"}
                            </button>
                          </form>

                          <button
                            type="button"
                            onClick={onSendInvite}
                            disabled={isSendingInvite || !selected.envelope_id}
                            className={[
                              "w-full rounded-xl px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition border",
                              isSendingInvite || !selected.envelope_id
                                ? "border-slate-800 bg-slate-950/30 text-slate-500 cursor-not-allowed"
                                : "border-slate-700 bg-slate-950/60 text-slate-200 hover:border-amber-500/40 hover:text-slate-100",
                            ].join(" ")}
                          >
                            {isSendingInvite ? "Sending…" : "Send invite"}
                          </button>

                          <button
                            type="button"
                            onClick={onArchiveSigned}
                            disabled={isArchiving || !envelopeSigned}
                            className={[
                              "w-full rounded-xl px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition border",
                              isArchiving || !envelopeSigned
                                ? "border-slate-800 bg-slate-950/30 text-slate-500 cursor-not-allowed"
                                : "border-amber-500/60 bg-amber-500/10 text-amber-200 hover:bg-amber-500/15",
                            ].join(" ")}
                          >
                            {isArchiving ? "Archiving…" : "Archive now"}
                          </button>
                        </div>

                        <div className="mt-3 text-[11px] text-slate-500">
                          Forge does not bypass archive discipline. Both paths must produce archive-quality PDF + hash.
                        </div>
                      </div>
                    </div>

                    {error && (
                      <div className="mt-3 text-[11px] text-red-400 bg-red-950/40 border border-red-800/60 rounded-xl px-3 py-2">
                        {error}
                      </div>
                    )}

                    {info && !error && (
                      <div className="mt-3 text-[11px] text-emerald-300 bg-emerald-950/40 border border-emerald-700/60 rounded-xl px-3 py-2">
                        {info}
                      </div>
                    )}
                  </>
                )}
              </div>

              <div className="border-t border-slate-900 px-5 py-3 text-[10px] text-slate-500 flex items-center justify-between">
                <span>CI-Forge · Oasis Digital Parliament Ledger</span>
                <span>{tab === "active" ? "Active tab" : "Completed tab"}</span>
              </div>
            </section>

            {/* Right column: AXIOM + artifacts */}
            <section className="w-[360px] shrink-0 overflow-hidden rounded-2xl border border-slate-900 bg-slate-950/35">
              <div className="border-b border-slate-900 px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Intelligence + Artifacts</div>
                <div className="mt-1 text-[11px] text-slate-400">
                  AXIOM is advisory-only. Humans execute.
                </div>
              </div>

              <div className="h-full overflow-y-auto px-4 py-4 space-y-3">
                {/* AXIOM panel */}
                <div className="rounded-2xl border border-slate-900 bg-black/30 p-4">
                  <div className="flex items-center justify-between">
                    <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">AXIOM Advisory</div>
                    <div className="flex items-center gap-2">
                      <div className={["h-2.5 w-2.5 rounded-full", riskLightClasses(axiomAdvisory.severity)].join(" ")} />
                      <div className="text-[10px] text-slate-400">{riskLabel(axiomAdvisory.severity)}</div>
                    </div>
                  </div>

                  <ul className="mt-2 space-y-2 text-[11px] text-slate-300 list-disc pl-4">
                    {axiomAdvisory.bullets.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>

                  <div className="mt-3 text-[10px] text-slate-500">
                    Later: “Run review” can generate summaries/analysis/advice into AXIOM timeline for this ledger_id.
                  </div>
                </div>

                {/* Artifacts panel (minimal, no guessing fields) */}
                <div className="rounded-2xl border border-slate-900 bg-black/30 p-4">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Artifacts</div>

                  <div className="mt-2 grid grid-cols-1 gap-2 text-[11px] text-slate-300">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">Envelope ID</span>
                      <span className="font-mono text-[10px] text-slate-300">
                        {selected?.envelope_id ? clamp(selected.envelope_id, 12) : "—"}
                      </span>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">Envelope Status</span>
                      <span className="text-slate-200">{selected?.envelope_status ?? "—"}</span>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">Last Signed</span>
                      <span className="text-slate-200">{fmt(selected?.last_signed_at)}</span>
                    </div>

                    <div className="mt-2 flex gap-2">
                      <a
                        href="/ci-archive/minute-book"
                        className="flex-1 text-center rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2 text-[11px] font-semibold text-slate-200 hover:border-amber-500/40 hover:text-slate-100 transition"
                      >
                        Open CI-Archive
                      </a>

                      <a
                        href="/ci-sign"
                        className="flex-1 text-center rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2 text-[11px] font-semibold text-slate-200 hover:border-amber-500/40 hover:text-slate-100 transition"
                      >
                        Open CI-Sign
                      </a>
                    </div>

                    <div className="text-[10px] text-slate-500 mt-1">
                      Signed PDF + certificate deep-links can be surfaced here once your view exposes storage paths / IDs.
                    </div>
                  </div>
                </div>

                {/* Notes */}
                <div className="rounded-2xl border border-slate-900 bg-black/30 p-4">
                  <div className="flex items-center justify-between">
                    <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Forge Notes</div>
                    <div className="text-[10px] text-slate-500">(Local-only)</div>
                  </div>
                  <textarea
                    className="mt-2 w-full min-h-[160px] rounded-xl bg-slate-950/70 border border-slate-800 px-3 py-2 text-sm text-slate-100 resize-none"
                    placeholder="Track execution conditions, signer confirmations, and archiving notes."
                  />
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
