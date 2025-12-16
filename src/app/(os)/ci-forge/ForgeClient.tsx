"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";

type Props = { entitySlug: string };

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

export default function ForgeClient({ entitySlug }: Props) {
  const router = useRouter();

  const [queue, setQueue] = useState<ForgeQueueItem[]>([]);
  const [loadingQueue, setLoadingQueue] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    queue.find((q) => q.ledger_id === selectedId) ?? queue[0] ?? null;

  const [primarySignerName, setPrimarySignerName] = useState("");
  const [primarySignerEmail, setPrimarySignerEmail] = useState("");
  const [ccEmails, setCcEmails] = useState("");

  const [isSending, setIsSending] = useState(false);
  const [isSendingInvite, setIsSendingInvite] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Auth guard
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const checkAuth = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) router.replace("/login");
    };
    checkAuth();
  }, [router]);

  // ---------------------------------------------------------------------------
  // Load Forge queue
  // ---------------------------------------------------------------------------
  useEffect(() => {
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
              // "body", // enable if the view ever adds it
            ].join(", "),
          )
          .eq("entity_slug", entitySlug)
          .eq("ledger_status", "APPROVED")
          .order("created_at", { ascending: false })
          .returns<ForgeQueueItem[]>();

        if (error) {
          console.error("CI-Forge queue error:", error);
          setQueue([]);
          setSelectedId(null);
          setError("Unable to load Forge queue for this entity.");
          return;
        }

        const rows = (data ?? []) as ForgeQueueItem[];
        setQueue(rows);
        setSelectedId(rows[0]?.ledger_id ?? null);
      } catch (err) {
        console.error("CI-Forge queue exception:", err);
        setQueue([]);
        setSelectedId(null);
        setError("Unable to load Forge queue for this entity.");
      } finally {
        setLoadingQueue(false);
      }
    };

    fetchQueue();
  }, [entitySlug]);

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const formattedCreatedAt = (iso: string | null | undefined) => {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  const formattedLastSigned = (iso: string | null | undefined) => {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  const envelopeLocked =
    !!selected?.envelope_status &&
    selected.envelope_status !== "cancelled" &&
    selected.envelope_status !== "expired";

  const envelopeSigned = selected?.envelope_status === "completed";

  // ---------------------------------------------------------------------------
  // Risk engine (kept, Council-style UI consumes it)
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

  const riskLabel = (risk: RiskLevel) => {
    if (risk === "RED") return "Dormant";
    if (risk === "AMBER") return "Delayed";
    if (risk === "GREEN") return "Healthy";
    return "Idle";
  };

  const riskTitle = (risk: RiskLevel, item: ForgeQueueItem) => {
    const days = item.days_since_last_signature;
    const labelDays =
      days == null ? "No signatures yet" : `${days} day(s) since last signature`;
    if (risk === "RED") return `Dormant execution risk – ${labelDays}`;
    if (risk === "AMBER") return `Unsigned for several days – ${labelDays}`;
    if (risk === "GREEN") return `Healthy execution – ${labelDays}`;
    return labelDays;
  };

  const renderRiskLight = (item: ForgeQueueItem) => {
    const risk = computeRiskLevel(item);
    return (
      <span
        className={[
          "inline-flex h-2 w-2 rounded-full",
          "transition-transform duration-150",
          "group-hover:scale-110",
          riskLightClasses(risk),
        ].join(" ")}
        title={riskTitle(risk, item)}
      />
    );
  };

  // ---------------------------------------------------------------------------
  // Badges
  // ---------------------------------------------------------------------------
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
          ENVELOPE SIGNED
        </span>
      );
    }
    if (item.envelope_status === "pending" || item.envelope_status === "draft") {
      return (
        <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold border-amber-400/70 bg-amber-500/10 text-amber-200">
          ENVELOPE PENDING
        </span>
      );
    }
    if (item.envelope_status === "cancelled" || item.envelope_status === "expired") {
      return (
        <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold border-slate-500/70 bg-slate-500/10 text-slate-300">
          ENVELOPE {item.envelope_status.toUpperCase()}
        </span>
      );
    }
    return null;
  };

  // ---------------------------------------------------------------------------
  // start-signature
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
      };

      const { data, error } =
        await supabase.functions.invoke<StartSignatureResponse>("start-signature", {
          body: payload,
        });

      if (error) throw new Error(error.message ?? "Edge function error");
      if (!data?.ok) throw new Error(data?.error ?? "Edge returned ok: false");

      setInfo(
        data.reused
          ? "Existing signature envelope reused."
          : "Signature envelope created successfully.",
      );

      // reflect envelope state in UI (optimistic)
      if (data.envelope_id) {
        setQueue((prev) =>
          prev.map((item) =>
            item.ledger_id === selected.ledger_id
              ? { ...item, envelope_id: data.envelope_id!, envelope_status: "pending" }
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
  // send-signature-invite
  // ---------------------------------------------------------------------------
  const handleSendInviteNow = async () => {
    setIsSendingInvite(true);
    setError(null);
    setInfo(null);

    try {
      const { data, error } =
        await supabase.functions.invoke<SendInviteResponse>("send-signature-invite", {
          body: {},
        });

      if (error) throw new Error(error.message ?? "Edge function error");
      if (!data?.ok) throw new Error(data?.error ?? data?.message ?? "Invite failed");

      setInfo(data.message ?? "Signature invitation email sent (or no jobs pending).");
    } catch (err: any) {
      setError(err?.message ?? "Failed to trigger signature invite.");
    } finally {
      setIsSendingInvite(false);
    }
  };

  // ---------------------------------------------------------------------------
  // archive-signed-resolution
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
      const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (!baseUrl || !anonKey)
        throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY.");

      const res = await fetch(`${baseUrl}/functions/v1/archive-signed-resolution`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${anonKey}`,
        },
        body: JSON.stringify({ envelope_id: selected.envelope_id }),
      });

      const data: ArchiveSignedResolutionResponse = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(data?.error ?? "Failed to archive signed PDF into the minute book.");
      }

      setInfo(
        data.already_archived
          ? "Signed resolution is already archived in the minute book."
          : "Signed PDF archived to the minute book for this envelope.",
      );
    } catch (err: any) {
      setError(err?.message ?? "Failed to archive the signed PDF.");
    } finally {
      setIsArchiving(false);
    }
  };

  // ---------------------------------------------------------------------------
  // LEFT list row renderer (Council-style)
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
        className={[
          "group w-full text-left px-3 py-3 border-b border-slate-800 last:border-b-0",
          "transition",
          active
            ? "bg-slate-900/90 shadow-[0_0_0_1px_rgba(56,189,248,0.4)]"
            : "hover:bg-slate-900/60",
        ].join(" ")}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-slate-100 line-clamp-2">
              {item.title || "Untitled resolution"}
            </div>

            <div className="mt-1 text-[11px] text-slate-400 flex items-center gap-2">
              <span className="truncate">{item.entity_name}</span>
              <span className="w-1 h-1 rounded-full bg-slate-600 shrink-0" />
              <span className="text-slate-500 shrink-0">
                {formattedCreatedAt(item.created_at)}
              </span>
            </div>

            {item.last_signed_at && (
              <div className="mt-1 text-[10px] text-slate-500">
                Last signed: {formattedLastSigned(item.last_signed_at)} •{" "}
                {item.days_since_last_signature ?? "—"} day(s) ago
              </div>
            )}
          </div>

          <div className="shrink-0 flex flex-col items-end gap-1">
            <div className="flex items-center gap-2">
              <span
                className={[
                  "inline-flex h-2 w-2 rounded-full",
                  riskLightClasses(risk),
                ].join(" ")}
                title={riskTitle(risk, item)}
              />
              {renderEnvelopeBadge(item)}
            </div>
            <div className="text-[10px] text-slate-500">
              {item.ledger_status || "APPROVED"}
            </div>
            <div className="text-[9px] text-slate-500">
              Parties: {item.parties_signed ?? 0}/{item.parties_total ?? 0}
            </div>
          </div>
        </div>
      </button>
    );
  };

  // ---------------------------------------------------------------------------
  // Small summary label for selected
  // ---------------------------------------------------------------------------
  const selectedRisk = useMemo(() => {
    if (!selected) return null;
    const risk = computeRiskLevel(selected);
    const days = selected.days_since_last_signature;
    const labelDays = days == null ? "No signatures yet" : `${days} day(s) since last signature`;
    return { risk, label: riskLabel(risk), detail: labelDays };
  }, [selected]);

  // ---------------------------------------------------------------------------
  // UI (Council-exact grammar)
  // ---------------------------------------------------------------------------
  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      {/* Header under OS bar */}
      <div className="mb-4 shrink-0">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">
          CI-FORGE
        </div>
        <p className="mt-1 text-[11px] text-slate-400">
          Execution Console •{" "}
          <span className="font-semibold text-slate-200">
            ODP.AI – Signature + Archive Pipeline
          </span>
        </p>
      </div>

      {/* Main Window – fixed frame inside workspace */}
      <div className="flex-1 min-h-0 flex justify-center overflow-hidden">
        <div className="w-full max-w-[1400px] h-full rounded-3xl border border-slate-900 bg-black/60 shadow-[0_0_60px_rgba(15,23,42,0.9)] px-6 py-5 flex flex-col overflow-hidden">
          {/* Window Title */}
          <div className="flex items-start justify-between mb-4 shrink-0">
            <div>
              <h1 className="text-lg font-semibold text-slate-50">
                Forge – Execution & Signature Console
              </h1>
              <p className="mt-1 text-xs text-slate-400">
                <span className="font-semibold text-emerald-400">Left:</span>{" "}
                select an approved record and inspect its execution state.{" "}
                <span className="font-semibold text-sky-400">Right:</span>{" "}
                start signature, trigger invites, and archive completed PDFs into the minute book.
              </p>
            </div>
            <div className="hidden md:flex items-center text-[10px] uppercase tracking-[0.3em] text-slate-500">
              CI-FORGE • LIVE
            </div>
          </div>

          {/* TWO-COLUMN LAYOUT (Council-style) */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 flex-1 min-h-0">
            {/* LEFT – Queue & brief */}
            <section className="bg-slate-950/40 border border-slate-800 rounded-2xl p-4 flex flex-col min-h-0">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-semibold text-slate-200">
                  Execution Queue
                </div>
                <div className="text-[10px] uppercase tracking-[0.25em] text-slate-500">
                  {queue.length} items
                </div>
              </div>

              <div className="flex-1 min-h-0 grid grid-cols-[260px,minmax(0,1fr)] gap-4">
                {/* Queue list – only this scrolls */}
                <div className="flex-1 min-h-0 overflow-y-auto rounded-xl border border-slate-800/80 bg-slate-950/60">
                  {loadingQueue && (
                    <div className="p-3 text-[11px] text-slate-400">
                      Loading queue…
                    </div>
                  )}

                  {!loadingQueue && queue.length === 0 && !error && (
                    <div className="p-3 text-[11px] text-slate-400">
                      No approved records are waiting in Forge for this entity.
                    </div>
                  )}

                  {!loadingQueue && queue.length > 0 && <>{queue.map(renderQueueRow)}</>}
                </div>

                {/* Selected summary + viewer */}
                <div className="flex flex-col rounded-xl border border-slate-800/80 bg-slate-950/60 px-4 py-3 min-h-0">
                  {selected ? (
                    <>
                      <div className="flex items-center justify-between mb-2">
                        <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">
                          Selected Record
                        </div>
                        <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/40 text-[10px] uppercase tracking-[0.18em] text-emerald-300">
                          {selected.ledger_status?.toUpperCase() || "APPROVED"}
                        </span>
                      </div>

                      <div className="text-sm font-semibold text-slate-100 mb-1">
                        {selected.title || "Untitled resolution"}
                      </div>

                      <div className="text-[11px] text-slate-400 mb-3 space-y-1">
                        <div>
                          Entity:{" "}
                          <span className="text-slate-200">
                            {selected.entity_name}
                          </span>
                        </div>
                        <div>
                          Created:{" "}
                          <span className="text-slate-300">
                            {formattedCreatedAt(selected.created_at)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            <span className="text-slate-500">Envelope:</span>
                            {renderEnvelopeBadge(selected)}
                          </div>
                          <div className="flex items-center gap-2">
                            <span
                              className={[
                                "inline-flex h-2 w-2 rounded-full",
                                riskLightClasses(selectedRisk?.risk ?? "IDLE"),
                              ].join(" ")}
                              title={riskTitle(selectedRisk?.risk ?? "IDLE", selected)}
                            />
                            <span className="text-slate-300">
                              {selectedRisk?.label ?? "Idle"}
                            </span>
                          </div>
                        </div>
                        <div>
                          Parties:{" "}
                          <span className="text-slate-200">
                            {selected.parties_signed ?? 0}/{selected.parties_total ?? 0}
                          </span>
                        </div>
                        <div>
                          Last signed:{" "}
                          <span className="text-slate-200">
                            {formattedLastSigned(selected.last_signed_at)}
                          </span>
                        </div>
                      </div>

                      {/* Execution viewer */}
                      <div className="flex-1 min-h-0 flex flex-col">
                        <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500 mb-1">
                          Execution Monitor
                        </div>
                        <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/80 px-3 py-2 text-[11px] leading-relaxed">
                          <div className="text-slate-200 space-y-2">
                            <div>
                              <span className="text-slate-500">Envelope ID:</span>{" "}
                              <span className="font-mono text-[10px]">
                                {selected.envelope_id ?? "—"}
                              </span>
                            </div>
                            <div>
                              <span className="text-slate-500">Envelope Status:</span>{" "}
                              <span className="text-slate-200 font-semibold">
                                {selected.envelope_status ?? "READY (not started)"}
                              </span>
                            </div>
                            <div>
                              <span className="text-slate-500">Risk Detail:</span>{" "}
                              <span className="text-slate-300">
                                {selectedRisk?.detail ?? "—"}
                              </span>
                            </div>

                            <div className="mt-3 rounded-xl border border-slate-800 bg-black/30 p-3">
                              <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500 mb-2">
                                Operator Notes
                              </div>
                              <div className="text-slate-400">
                                (Optional) Add body preview once the queue view includes it.
                              </div>
                            </div>

                            {/* If your view later includes body */}
                            {typeof selected.body !== "undefined" && (
                              <div className="mt-3">
                                <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500 mb-2">
                                  Record Body
                                </div>
                                <pre className="whitespace-pre-wrap font-sans text-slate-200">
                                  {selected.body || "—"}
                                </pre>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="text-[11px] text-slate-400">
                      Select a record from the queue to see its execution details here.
                    </div>
                  )}
                </div>
              </div>
            </section>

            {/* RIGHT – Actions panel (Council decision analog) */}
            <section className="border border-slate-800 rounded-2xl bg-slate-950/40 p-4 flex flex-col min-h-0">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h2 className="text-sm font-semibold text-slate-200">
                    Execution Controls
                  </h2>
                  <p className="mt-1 text-[11px] text-slate-400 max-w-lg">
                    Start the signature envelope for the selected record, trigger invite dispatch, and archive completed PDFs into the minute book.
                  </p>
                </div>
                <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/40 text-[10px] uppercase tracking-[0.18em] text-emerald-300">
                  Ledger-Linked
                </span>
              </div>

              <form onSubmit={handleStartSignature} className="flex-1 min-h-0 flex flex-col">
                {/* Controls body scroll */}
                <div className="flex-1 min-h-0 overflow-y-auto">
                  <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500 mb-2">
                    Primary Signer
                  </div>

                  <div className="grid gap-3">
                    <input
                      className="w-full rounded-2xl border border-slate-700 bg-slate-900/70 px-3 py-2 text-sm text-slate-100 outline-none"
                      value={primarySignerName}
                      onChange={(e) => setPrimarySignerName(e.target.value)}
                      placeholder="Signer name"
                      disabled={!selected || envelopeLocked || isSending}
                    />
                    <input
                      className="w-full rounded-2xl border border-slate-700 bg-slate-900/70 px-3 py-2 text-sm text-slate-100 outline-none"
                      value={primarySignerEmail}
                      onChange={(e) => setPrimarySignerEmail(e.target.value)}
                      placeholder="Signer email"
                      type="email"
                      disabled={!selected || envelopeLocked || isSending}
                    />
                    <input
                      className="w-full rounded-2xl border border-slate-700 bg-slate-900/70 px-3 py-2 text-sm text-slate-100 outline-none"
                      value={ccEmails}
                      onChange={(e) => setCcEmails(e.target.value)}
                      placeholder="CC emails (optional)"
                      disabled={!selected || isSending}
                    />

                    <div className="text-[10px] text-slate-500">
                      CC is UI-only for now (wire once the Edge Function supports it).
                    </div>
                  </div>

                  <div className="mt-4">
                    <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500 mb-2">
                      Actions
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        onClick={handleSendInviteNow}
                        disabled={isSendingInvite}
                        className={`rounded-full px-4 py-1.5 text-[11px] font-semibold tracking-[0.18em] uppercase transition ${
                          isSendingInvite
                            ? "bg-emerald-500/20 text-emerald-200/60 cursor-not-allowed"
                            : "bg-transparent border border-emerald-500/70 text-emerald-300 hover:bg-emerald-500/10"
                        }`}
                      >
                        {isSendingInvite ? "Sending…" : "Send invite now"}
                      </button>

                      <button
                        type="button"
                        onClick={handleArchiveSignedPdf}
                        disabled={!selected || !envelopeSigned || isArchiving}
                        className={`rounded-full px-4 py-1.5 text-[11px] font-semibold tracking-[0.18em] uppercase transition ${
                          !selected || !envelopeSigned || isArchiving
                            ? "bg-sky-500/20 text-sky-200/60 cursor-not-allowed"
                            : "bg-sky-500 text-black hover:bg-sky-400"
                        }`}
                      >
                        {isArchiving ? "Archiving…" : "Archive signed PDF"}
                      </button>
                    </div>

                    <div className="mt-3 text-[10px] text-slate-500">
                      Archive is available once the envelope status is{" "}
                      <span className="text-slate-200 font-semibold">completed</span>.
                    </div>
                  </div>

                  {/* Forge notes (Council notes analog) */}
                  <div className="mt-5 flex flex-col min-h-[220px]">
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">
                        Forge Notes
                      </div>
                      <div className="text-[10px] text-slate-500">
                        (Local-only for now)
                      </div>
                    </div>
                    <textarea
                      className="flex-1 min-h-[160px] rounded-xl bg-slate-950/70 border border-slate-800 px-3 py-2 text-sm text-slate-100 resize-none"
                      placeholder="Track execution conditions, signer confirmations, and archiving notes..."
                    />
                  </div>
                </div>

                {/* Messages */}
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

                {/* Bottom bar + primary action */}
                <div className="mt-3 flex items-center justify-between text-[10px] text-slate-500">
                  <span>CI-Forge · Oasis Digital Parliament Ledger</span>
                  <button
                    type="submit"
                    disabled={isSending || !selected || envelopeLocked}
                    className={`rounded-full px-4 py-1.5 text-[11px] font-semibold tracking-[0.18em] uppercase transition ${
                      !selected || envelopeLocked || isSending
                        ? "bg-emerald-500/20 text-emerald-200/60 cursor-not-allowed"
                        : "bg-emerald-500 text-black hover:bg-emerald-400"
                    }`}
                  >
                    {envelopeLocked
                      ? "Envelope already created"
                      : isSending
                        ? "Starting…"
                        : "Start signature envelope"}
                  </button>
                </div>
              </form>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
