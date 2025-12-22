"use client";
export const dynamic = "force-dynamic";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
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

  // optional if view includes it later
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
type Tab = "active" | "completed";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function norm(s?: string | null, fb = "—") {
  const x = (s || "").toString().trim();
  return x.length ? x : fb;
}

function fmtLocal(iso: string | null | undefined) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function ForgeClient() {
  const { activeEntity, entityKey } = useEntity() as any; // (keeps compatibility with your current context shape)

  // entity slug is what the Forge queue view expects
  const entitySlug: string = useMemo(() => {
    // prefer OS selector
    if (typeof activeEntity === "string" && activeEntity.trim()) return activeEntity.trim();
    // fallback to entityKey if it matches your slug naming
    if (typeof entityKey === "string" && entityKey.trim()) return entityKey.trim();
    return "holdings";
  }, [activeEntity, entityKey]);

  const [tab, setTab] = useState<Tab>("active");

  const [queue, setQueue] = useState<ForgeQueueItem[]>([]);
  const [loadingQueue, setLoadingQueue] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = queue.find((q) => q.ledger_id === selectedId) ?? queue[0] ?? null;

  const [primarySignerName, setPrimarySignerName] = useState("");
  const [primarySignerEmail, setPrimarySignerEmail] = useState("");
  const [ccEmails, setCcEmails] = useState("");

  const [isSending, setIsSending] = useState(false);
  const [isSendingInvite, setIsSendingInvite] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const envelopeLocked =
    !!selected?.envelope_status &&
    selected.envelope_status !== "cancelled" &&
    selected.envelope_status !== "expired";

  const envelopeSigned = selected?.envelope_status === "completed";

  // ---------------------------------------------------------------------------
  // Load Forge queue (entity-scoped)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let alive = true;

    const fetchQueue = async () => {
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
          .eq("entity_slug", entitySlug)
          .eq("ledger_status", "APPROVED")
          .order("created_at", { ascending: false });

        if (!alive) return;

        if (error) {
          console.error("CI-Forge queue error:", error);
          setQueue([]);
          setSelectedId(null);
          setError("Unable to load Forge queue for this entity.");
          return;
        }

        const rows = ((data ?? []) as unknown as ForgeQueueItem[]) ?? [];
        setQueue(rows);

        // preserve selection if possible
        const stillThere = rows.some((r) => r.ledger_id === selectedId);
        setSelectedId(stillThere ? selectedId : rows[0]?.ledger_id ?? null);
      } catch (err) {
        console.error("CI-Forge queue exception:", err);
        if (!alive) return;
        setQueue([]);
        setSelectedId(null);
        setError("Unable to load Forge queue for this entity.");
      } finally {
        if (alive) setLoadingQueue(false);
      }
    };

    fetchQueue();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entitySlug]);

  // ---------------------------------------------------------------------------
  // Risk engine (advisory only)
  // ---------------------------------------------------------------------------
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

  const renderEnvelopeBadge = (item: ForgeQueueItem) => {
    if (!item.envelope_status) {
      return (
        <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold border-sky-400/70 bg-sky-500/10 text-sky-200">
          READY
        </span>
      );
    }
    if (item.envelope_status === "completed") {
      return (
        <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold border-emerald-400/70 bg-emerald-500/10 text-emerald-300">
          COMPLETED
        </span>
      );
    }
    if (item.envelope_status === "pending" || item.envelope_status === "draft") {
      return (
        <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold border-amber-400/70 bg-amber-500/10 text-amber-200">
          PENDING
        </span>
      );
    }
    if (item.envelope_status === "cancelled" || item.envelope_status === "expired") {
      return (
        <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold border-slate-500/70 bg-slate-500/10 text-slate-300">
          {item.envelope_status.toUpperCase()}
        </span>
      );
    }
    return null;
  };

  // ---------------------------------------------------------------------------
  // Tabbed lists
  // ---------------------------------------------------------------------------
  const activeRows = useMemo(() => {
    // everything not completed
    return queue.filter((q) => q.envelope_status !== "completed");
  }, [queue]);

  const completedRows = useMemo(() => {
    return queue.filter((q) => q.envelope_status === "completed");
  }, [queue]);

  const tabRows = tab === "active" ? activeRows : completedRows;

  // keep selection valid within current tab
  useEffect(() => {
    if (!tabRows.length) {
      setSelectedId(null);
      return;
    }
    const ok = selectedId && tabRows.some((r) => r.ledger_id === selectedId);
    if (!ok) setSelectedId(tabRows[0]!.ledger_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, queue]);

  // ---------------------------------------------------------------------------
  // start-signature (wiring preserved)
  // ---------------------------------------------------------------------------
  const handleStartSignature = async (e: FormEvent) => {
    e.preventDefault();
    if (!selected) return;

    setIsSending(true);
    setError(null);
    setInfo(null);

    try {
      if (!primarySignerName.trim() || !primarySignerEmail.trim()) {
        throw new Error("Primary signer name and email are required.");
      }

      const parties = [
        {
          signer_email: primarySignerEmail.trim(),
          signer_name: primarySignerName.trim(),
          role: "primary_signer",
          signing_order: 1,
        },
      ];

      const payload = {
        document_id: selected.ledger_id,
        entity_slug: selected.entity_slug,
        record_title: selected.title,
        parties,
        cc_emails: ccEmails
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      };

      const { data, error } = await supabase.functions.invoke("start-signature", {
        body: payload,
      });

      const typed = data as StartSignatureResponse | null;

      if (error) throw new Error(error.message ?? "Edge function error");
      if (!typed?.ok) throw new Error(typed?.error ?? "Edge returned ok: false");

      setInfo(typed.reused ? "Existing signature envelope reused." : "Signature envelope created successfully.");

      if (typed.envelope_id) {
        setQueue((prev) =>
          prev.map((item) =>
            item.ledger_id === selected.ledger_id
              ? { ...item, envelope_id: typed.envelope_id!, envelope_status: "pending" }
              : item,
          ),
        );
      }
    } catch (err: any) {
      setError(err?.message ?? "Failed to start signature envelope.");
    } finally {
      setIsSending(false);
    }
  };

  // ---------------------------------------------------------------------------
  // send-signature-invite (wiring preserved)
  // ---------------------------------------------------------------------------
  const handleSendInviteNow = async () => {
    setIsSendingInvite(true);
    setError(null);
    setInfo(null);

    try {
      const { data, error } = await supabase.functions.invoke("send-signature-invite", {
        body: {},
      });

      const typed = data as SendInviteResponse | null;

      if (error) throw new Error(error.message ?? "Edge function error");
      if (!typed?.ok) throw new Error(typed?.error ?? typed?.message ?? "Invite failed");

      setInfo(typed.message ?? "Signature invitation email sent (or no jobs pending).");
    } catch (err: any) {
      setError(err?.message ?? "Failed to trigger signature invite.");
    } finally {
      setIsSendingInvite(false);
    }
  };

  // ---------------------------------------------------------------------------
  // archive-signed-resolution (FIXED: use session invoke, not anon-key fetch)
  // ---------------------------------------------------------------------------
  const handleArchiveSignedPdf = async () => {
    if (!selected?.envelope_id) {
      setError("No envelope ID found for this record.");
      return;
    }
    if (!envelopeSigned) {
      setError("Envelope is not completed yet. Wait for signature first.");
      return;
    }

    setIsArchiving(true);
    setError(null);
    setInfo(null);

    try {
      const { data, error } = await supabase.functions.invoke("archive-signed-resolution", {
        body: { envelope_id: selected.envelope_id },
      });

      const typed = data as ArchiveSignedResolutionResponse | null;

      if (error) throw new Error(error.message ?? "Edge function error");
      if (!typed?.ok) throw new Error(typed?.error ?? "Failed to archive signed PDF into the minute book.");

      setInfo(
        typed.already_archived
          ? "Signed resolution is already archived in the minute book."
          : "Signed PDF archived to the minute book.",
      );
    } catch (err: any) {
      setError(err?.message ?? "Failed to archive the signed PDF.");
    } finally {
      setIsArchiving(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Row renderer (Council-style)
  // ---------------------------------------------------------------------------
  const renderQueueRow = (item: ForgeQueueItem) => {
    const active = item.ledger_id === selected?.ledger_id;
    const risk = computeRiskLevel(item);

    return (
      <button
        key={item.ledger_id}
        type="button"
        onClick={() => {
          setSelectedId(item.ledger_id);
          setError(null);
          setInfo(null);
        }}
        className={cx(
          "group w-full text-left px-3 py-3 border-b border-slate-800 last:border-b-0 transition",
          active ? "bg-slate-900/90 shadow-[0_0_0_1px_rgba(245,158,11,0.25)]" : "hover:bg-slate-900/60",
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-slate-100 line-clamp-2">{item.title || "Untitled resolution"}</div>

            <div className="mt-1 text-[11px] text-slate-400 flex items-center gap-2">
              <span className="truncate">{item.entity_name}</span>
              <span className="w-1 h-1 rounded-full bg-slate-600 shrink-0" />
              <span className="text-slate-500 shrink-0">{fmtLocal(item.created_at)}</span>
            </div>

            {item.last_signed_at && (
              <div className="mt-1 text-[10px] text-slate-500">
                Last signed: {fmtLocal(item.last_signed_at)} • {item.days_since_last_signature ?? "—"} day(s) ago
              </div>
            )}
          </div>

          <div className="shrink-0 flex flex-col items-end gap-1">
            <div className="flex items-center gap-2">
              <span className={cx("inline-flex h-2 w-2 rounded-full", riskLightClasses(risk))} />
              {renderEnvelopeBadge(item)}
            </div>
            <div className="text-[10px] text-slate-500">{item.ledger_status || "APPROVED"}</div>
            <div className="text-[9px] text-slate-500">
              Parties: {item.parties_signed ?? 0}/{item.parties_total ?? 0}
            </div>
          </div>
        </div>
      </button>
    );
  };

  // ---------------------------------------------------------------------------
  // Quick routes
  // ---------------------------------------------------------------------------
  const signUrl = useMemo(() => {
    if (!selected?.envelope_id) return null;
    // If you have your own hosted sign page, swap this route to your canonical internal route.
    // Keeping it internal by default:
    return `/ci-sign?envelope_id=${encodeURIComponent(selected.envelope_id)}`;
  }, [selected?.envelope_id]);

  const minuteBookUrl = useMemo(() => {
    // Minute book is entity_key scoped; we pass entity_key so it opens at correct organism.
    if (!entityKey) return "/ci-archive/minute-book";
    return `/ci-archive/minute-book?entity_key=${encodeURIComponent(entityKey)}`;
  }, [entityKey]);

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------
  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      {/* Header under OS bar */}
      <div className="mb-4 shrink-0">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">CI-FORGE</div>
        <p className="mt-1 text-[11px] text-slate-400">
          Signature execution engine • <span className="font-semibold text-slate-200">signature-only</span> • entity-scoped
        </p>
      </div>

      {/* Main Window */}
      <div className="flex-1 min-h-0 flex justify-center overflow-hidden">
        <div className="w-full max-w-[1600px] h-full rounded-3xl border border-slate-900 bg-black/60 shadow-[0_0_60px_rgba(15,23,42,0.9)] px-6 py-5 flex flex-col overflow-hidden">
          {/* Title row */}
          <div className="flex items-start justify-between mb-4 shrink-0 gap-4">
            <div className="min-w-0">
              <h1 className="text-lg font-semibold text-slate-50 truncate">Forge • Execution Queue</h1>
              <p className="mt-1 text-xs text-slate-400">
                Approved records land here from Council. Forge handles <span className="text-amber-300 font-semibold">signature execution</span>, then
                archives artifacts into CI-Archive.
              </p>
            </div>

            <div className="shrink-0 flex items-center gap-2">
              <button
                type="button"
                onClick={handleSendInviteNow}
                disabled={isSendingInvite}
                className={cx(
                  "rounded-full border px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition",
                  isSendingInvite
                    ? "border-slate-800 bg-slate-900/40 text-slate-500 cursor-not-allowed"
                    : "border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/15",
                )}
              >
                {isSendingInvite ? "Sending…" : "Send Invites"}
              </button>

              <Link
                href={minuteBookUrl}
                className="rounded-full border border-slate-800 bg-slate-950/40 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60"
              >
                Open CI-Archive →
              </Link>
            </div>
          </div>

          {/* Status banners */}
          {(error || info) && (
            <div
              className={cx(
                "mb-4 rounded-2xl border px-4 py-3 text-sm shrink-0",
                error ? "border-red-900/60 bg-red-950/30 text-red-200" : "border-emerald-900/50 bg-emerald-950/25 text-emerald-200",
              )}
            >
              {error ?? info}
            </div>
          )}

          {/* Tabs */}
          <div className="mb-4 shrink-0 flex items-center gap-2 text-[11px]">
            <button
              type="button"
              onClick={() => setTab("active")}
              className={cx(
                "px-4 py-2 rounded-full border transition font-semibold tracking-[0.18em] uppercase",
                tab === "active"
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
                  : "border-slate-800 bg-slate-950/40 text-slate-300 hover:bg-slate-900/60",
              )}
            >
              Active ({activeRows.length})
            </button>
            <button
              type="button"
              onClick={() => setTab("completed")}
              className={cx(
                "px-4 py-2 rounded-full border transition font-semibold tracking-[0.18em] uppercase",
                tab === "completed"
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
                  : "border-slate-800 bg-slate-950/40 text-slate-300 hover:bg-slate-900/60",
              )}
            >
              Completed ({completedRows.length})
            </button>

            <div className="ml-auto text-[10px] uppercase tracking-[0.3em] text-slate-500">
              ENTITY • <span className="text-slate-200">{entitySlug}</span>
            </div>
          </div>

          {/* Workspace grid */}
          <div className="grid grid-cols-12 gap-6 flex-1 min-h-0">
            {/* LEFT: Queue */}
            <section className="col-span-12 lg:col-span-4 min-h-0 flex flex-col">
              <div className="bg-slate-950/40 border border-slate-800 rounded-2xl p-4 flex flex-col min-h-0">
                <div className="flex items-center justify-between mb-3 shrink-0">
                  <div>
                    <div className="text-sm font-semibold text-slate-200">{tab === "active" ? "Active Queue" : "Completed Envelopes"}</div>
                    <div className="text-[11px] text-slate-500">Source: v_forge_queue_latest</div>
                  </div>
                  <div className="text-[10px] uppercase tracking-[0.25em] text-slate-500">
                    {loadingQueue ? "…" : tabRows.length}
                  </div>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto rounded-xl border border-slate-800/80 bg-slate-950/60">
                  {loadingQueue && <div className="p-3 text-[11px] text-slate-400">Loading…</div>}
                  {!loadingQueue && tabRows.length === 0 && (
                    <div className="p-3 text-[11px] text-slate-400">
                      {tab === "active" ? "No active records awaiting execution." : "No completed envelopes yet."}
                    </div>
                  )}
                  {!loadingQueue && tabRows.map(renderQueueRow)}
                </div>
              </div>
            </section>

            {/* RIGHT: Execution + AXIOM advisory */}
            <section className="col-span-12 lg:col-span-8 min-h-0 flex flex-col">
              <div className="bg-slate-950/40 border border-slate-800 rounded-2xl p-4 flex flex-col min-h-0">
                {!selected ? (
                  <div className="text-sm text-slate-300">Select an item from the queue.</div>
                ) : (
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 flex-1 min-h-0">
                    {/* Execution panel */}
                    <div className="rounded-2xl border border-slate-800 bg-slate-950/50 p-4 flex flex-col min-h-0">
                      <div className="flex items-start justify-between gap-3 mb-3 shrink-0">
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-slate-100 line-clamp-2">{norm(selected.title, "Untitled resolution")}</div>
                          <div className="mt-1 text-[11px] text-slate-400">
                            Created: <span className="text-slate-200">{fmtLocal(selected.created_at)}</span>
                          </div>
                          <div className="mt-1 text-[11px] text-slate-400">
                            Envelope: <span className="text-slate-200">{selected.envelope_id ? selected.envelope_id : "—"}</span>
                          </div>
                        </div>

                        <div className="shrink-0 flex items-center gap-2">
                          {renderEnvelopeBadge(selected)}
                          <span
                            className={cx(
                              "inline-flex h-2 w-2 rounded-full",
                              riskLightClasses(computeRiskLevel(selected)),
                            )}
                            title="Advisory risk light (never blocks)"
                          />
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="rounded-xl border border-slate-800/80 bg-black/30 p-3 text-[11px] text-slate-300 shrink-0">
                        <div className="flex flex-wrap gap-2 items-center">
                          {signUrl && (
                            <Link
                              href={signUrl}
                              className="rounded-full border border-slate-700 bg-slate-900/40 px-3 py-1.5 text-[11px] font-semibold text-slate-100 hover:bg-slate-900/70"
                            >
                              Open Sign →
                            </Link>
                          )}

                          <Link
                            href={minuteBookUrl}
                            className="rounded-full border border-slate-700 bg-slate-900/40 px-3 py-1.5 text-[11px] font-semibold text-slate-100 hover:bg-slate-900/70"
                          >
                            Open Minute Book →
                          </Link>

                          <button
                            type="button"
                            disabled={!envelopeSigned || isArchiving}
                            onClick={handleArchiveSignedPdf}
                            className={cx(
                              "rounded-full border px-3 py-1.5 text-[11px] font-semibold transition",
                              envelopeSigned && !isArchiving
                                ? "border-amber-500/40 bg-amber-500 text-black hover:bg-amber-400"
                                : "border-slate-800 bg-slate-900/40 text-slate-500 cursor-not-allowed",
                            )}
                            title={!envelopeSigned ? "Complete signature first" : "Archive signed PDF to CI-Archive"}
                          >
                            {isArchiving ? "Archiving…" : "Archive Signed PDF"}
                          </button>
                        </div>

                        <div className="mt-2 text-[10px] text-slate-500 leading-relaxed">
                          Forge is signature-only. If Council approved “direct archive,” that route bypasses Forge (but still generates + archives PDFs).
                        </div>
                      </div>

                      {/* Start signature form (only if not locked) */}
                      <div className="mt-4 flex-1 min-h-0 overflow-y-auto">
                        <div className="text-[10px] uppercase tracking-[0.3em] text-slate-500 mb-2">
                          Execution Setup
                        </div>

                        {envelopeLocked ? (
                          <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4 text-[11px] text-slate-300">
                            Envelope is already created. Use <span className="text-slate-100 font-semibold">Open Sign</span> or finish signing, then archive.
                          </div>
                        ) : (
                          <form onSubmit={handleStartSignature} className="space-y-3">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                              <div>
                                <div className="text-[11px] text-slate-400 mb-1">Primary signer name</div>
                                <input
                                  value={primarySignerName}
                                  onChange={(e) => setPrimarySignerName(e.target.value)}
                                  className="w-full rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500/40"
                                  placeholder="Full name"
                                />
                              </div>
                              <div>
                                <div className="text-[11px] text-slate-400 mb-1">Primary signer email</div>
                                <input
                                  value={primarySignerEmail}
                                  onChange={(e) => setPrimarySignerEmail(e.target.value)}
                                  className="w-full rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500/40"
                                  placeholder="name@email.com"
                                />
                              </div>
                            </div>

                            <div>
                              <div className="text-[11px] text-slate-400 mb-1">CC emails (optional, comma separated)</div>
                              <input
                                value={ccEmails}
                                onChange={(e) => setCcEmails(e.target.value)}
                                className="w-full rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500/40"
                                placeholder="cc1@email.com, cc2@email.com"
                              />
                            </div>

                            <button
                              type="submit"
                              disabled={isSending}
                              className={cx(
                                "rounded-full border px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition",
                                isSending
                                  ? "border-slate-800 bg-slate-900/40 text-slate-500 cursor-not-allowed"
                                  : "border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/15",
                              )}
                            >
                              {isSending ? "Creating…" : "Create Envelope"}
                            </button>

                            <div className="text-[10px] text-slate-500 leading-relaxed">
                              This creates the envelope and parties. Signing/verification happens via CI-Sign.
                            </div>
                          </form>
                        )}
                      </div>
                    </div>

                    {/* AXIOM advisory panel (UI only, non-blocking) */}
                    <div className="rounded-2xl border border-slate-800 bg-slate-950/50 p-4 flex flex-col min-h-0">
                      <div className="flex items-start justify-between gap-3 mb-3 shrink-0">
                        <div>
                          <div className="text-sm font-semibold text-slate-100">AXIOM Advisory</div>
                          <div className="text-[11px] text-slate-500">Advisory-only. Never blocks execution.</div>
                        </div>
                        <span className="text-[10px] uppercase tracking-[0.3em] text-slate-500">Read-only</span>
                      </div>

                      <div className="rounded-2xl border border-slate-800 bg-black/30 p-4 text-[12px] text-slate-300 leading-relaxed overflow-y-auto">
                        <div className="text-[11px] text-slate-400">
                          This panel is where AXIOM will surface:
                        </div>
                        <ul className="mt-2 space-y-2 text-[12px]">
                          <li>• Execution risk flags (identity, missing artifacts, unsigned parties)</li>
                          <li>• Summary + “what you are signing” briefing</li>
                          <li>• Compliance cautions (ISO posture / audit notes)</li>
                          <li>• Non-repudiation checklist (audit trail present, hash present, timestamps)</li>
                        </ul>

                        <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/40 p-3 text-[11px] text-slate-400">
                          Next wiring step (later): connect to your existing summaries/analyses/advice views by record_id / ledger_id — but keep it advisory.
                        </div>
                      </div>

                      <div className="mt-3 text-[10px] text-slate-500">
                        Tone rule: AXIOM can warn loudly, but humans still decide.
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </section>
          </div>

          {/* Footer note */}
          <div className="mt-4 text-[10px] text-slate-600">
            Tip: “Completed” shows only envelopes that finished signing. Archiving is still a separate action (until the view exposes archived state).
          </div>
        </div>
      </div>
    </div>
  );
}
