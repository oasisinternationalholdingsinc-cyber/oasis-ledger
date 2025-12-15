// src/app/(os)/ci-forge/page.tsx
"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";

type ForgeQueueItem = {
  ledger_id: string;
  title: string;
  ledger_status: string; // from view: ledger_status
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

export default function CIForgePage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Entity from OS header (?entity=holdings|lounge|real-estate)
  const entitySlug = searchParams.get("entity") ?? "holdings";

  const [queue, setQueue] = useState<ForgeQueueItem[]>([]);
  const [loadingQueue, setLoadingQueue] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<ForgeQueueItem | null>(null);

  const [primarySignerName, setPrimarySignerName] = useState("");
  const [primarySignerEmail, setPrimarySignerEmail] = useState("");
  const [ccEmails, setCcEmails] = useState("");

  const [isSending, setIsSending] = useState(false);
  const [isSendingInvite, setIsSendingInvite] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);

  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // ---------------------------------------------------------------------------
  // Auth guard – same pattern as CI-Council
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const checkAuth = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        router.replace("/login");
      }
    };
    checkAuth();
  }, [router]);

  // ---------------------------------------------------------------------------
  // Load Forge queue (deduped latest envelopes per ledger)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const fetchQueue = async () => {
      setLoadingQueue(true);
      setError("");
      setSuccess("");

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

        console.log("Forge queue latest result", { data, error });

        if (error) {
          console.error("Forge queue error", error);
          setQueue([]);
          setError("Unable to load Forge queue for this entity.");
          return;
        }

        const rows = (data ?? []) as ForgeQueueItem[];
        setQueue(rows);

        if (rows.length > 0) {
          setSelectedId(rows[0].ledger_id);
          setSelectedItem(rows[0]);
        } else {
          setSelectedId(null);
          setSelectedItem(null);
        }
      } catch (err) {
        console.error("Error loading Forge queue", err);
        setQueue([]);
        setError("Unable to load Forge queue for this entity.");
      } finally {
        setLoadingQueue(false);
      }
    };

    fetchQueue();
  }, [entitySlug]);

  // Formatting helpers
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
      const d = new Date(iso);
      return d.toLocaleString();
    } catch {
      return iso;
    }
  };

  // Envelope locked once not cancelled/expired
  const envelopeLocked =
    !!selectedItem?.envelope_status &&
    selectedItem.envelope_status !== "cancelled" &&
    selectedItem.envelope_status !== "expired";

  const envelopeSigned = selectedItem?.envelope_status === "completed";

  // ---------------------------------------------------------------------------
  // Risk engine (traffic lights based on idle days + status)
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
      case "IDLE":
      default:
        return "bg-slate-500 shadow-[0_0_8px_rgba(148,163,184,0.9)]";
    }
  };

  const riskLightTitle = (risk: RiskLevel, item: ForgeQueueItem) => {
    const days = item.days_since_last_signature;
    const labelDays =
      days == null ? "No signatures yet" : `${days} day(s) since last signature`;

    if (risk === "RED") {
      return `Dormant execution risk – ${labelDays}`;
    }
    if (risk === "AMBER") {
      return `Unsigned for several days – ${labelDays}`;
    }
    if (risk === "GREEN") {
      return `Healthy execution – ${labelDays}`;
    }
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
        title={riskLightTitle(risk, item)}
      />
    );
  };

  // ---------------------------------------------------------------------------
  // Edge function: start-signature
  // ---------------------------------------------------------------------------
  const handleStartSignature = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedItem) return;

    setIsSending(true);
    setError("");
    setSuccess("");

    try {
      if (!primarySignerName.trim() || !primarySignerEmail.trim()) {
        throw new Error("Primary signer name and email are required.");
      }

      const parties: {
        signer_email: string;
        signer_name: string;
        role?: string;
        signing_order?: number;
      }[] = [
        {
          signer_email: primarySignerEmail.trim(),
          signer_name: primarySignerName.trim(),
          role: "primary_signer",
          signing_order: 1,
        },
      ];

      const payload = {
        document_id: selectedItem.ledger_id,
        entity_slug: selectedItem.entity_slug,
        record_title: selectedItem.title,
        parties,
      };

      const { data, error } =
        await supabase.functions.invoke<StartSignatureResponse>(
          "start-signature",
          { body: payload },
        );

      console.log("start-signature result", { data, error });

      if (error) {
        throw new Error(error.message ?? "Edge function error");
      }

      if (!data?.ok) {
        throw new Error(data?.error ?? "Edge function returned ok: false");
      }

      const msg = data.reused
        ? "Existing signature envelope reused."
        : "Signature envelope created successfully.";
      setSuccess(msg);

      if (data.envelope_id) {
        setQueue((prev) =>
          prev.map((item) =>
            item.ledger_id === selectedItem.ledger_id
              ? {
                  ...item,
                  envelope_id: data.envelope_id ?? item.envelope_id,
                  envelope_status: "pending",
                }
              : item,
          ),
        );

        setSelectedItem((prev) =>
          prev
            ? {
                ...prev,
                envelope_id: data.envelope_id ?? prev.envelope_id,
                envelope_status: "pending",
              }
            : prev,
        );
      }
    } catch (err: any) {
      console.error("Failed to start signature envelope", err);
      setError(
        err?.message ??
          "Failed to send a request to the Edge Function. Please try again.",
      );
    } finally {
      setIsSending(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Manual "send invite now" using worker
  // ---------------------------------------------------------------------------
  const handleSendInviteNow = async () => {
    setIsSendingInvite(true);
    setError("");
    setSuccess("");

    try {
      const { data, error } =
        await supabase.functions.invoke<SendInviteResponse>(
          "send-signature-invite",
          { body: {} },
        );

      console.log("send-signature-invite result", { data, error });

      if (error) {
        throw new Error(error.message ?? "Edge function error");
      }

      if (!data?.ok) {
        throw new Error(data?.error ?? data?.message ?? "Invite failed");
      }

      setSuccess(
        data.message ?? "Signature invitation email sent (or no jobs pending).",
      );
    } catch (err: any) {
      console.error("Failed to send invite", err);
      setError(
        err?.message ??
          "Failed to trigger signature invite. Please try again.",
      );
    } finally {
      setIsSendingInvite(false);
    }
  };

  // ---------------------------------------------------------------------------
  // "Archive signed PDF" → archive-signed-resolution -> minute_book_entries
  // ---------------------------------------------------------------------------
  const handleArchiveSignedPdf = async () => {
    if (!selectedItem?.envelope_id) {
      setError("No envelope ID found for this record.");
      return;
    }

    if (!envelopeSigned) {
      setError("Envelope is not completed yet. Wait for signature first.");
      return;
    }

    setIsArchiving(true);
    setError("");
    setSuccess("");

    try {
      const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

      if (!baseUrl || !anonKey) {
        throw new Error(
          "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY.",
        );
      }

      const res = await fetch(
        `${baseUrl}/functions/v1/archive-signed-resolution`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${anonKey}`,
          },
          body: JSON.stringify({
            envelope_id: selectedItem.envelope_id,
          }),
        },
      );

      const data: ArchiveSignedResolutionResponse = await res.json();
      console.log("archive-signed-resolution response", data);

      if (!res.ok || !data.ok) {
        throw new Error(
          data?.error ??
            "Failed to archive signed PDF into the minute book.",
        );
      }

      if (data.already_archived) {
        setSuccess("Signed resolution is already archived in the minute book.");
      } else {
        setSuccess(
          "Signed PDF archived to the minute book for this envelope.",
        );
      }
    } catch (err: any) {
      console.error("Failed to archive signed PDF", err);
      setError(
        err?.message ??
          "Failed to archive the signed PDF to the minute book. Please try again.",
      );
    } finally {
      setIsArchiving(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Envelope status badges
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

    if (
      item.envelope_status === "pending" ||
      item.envelope_status === "draft"
    ) {
      return (
        <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold border-amber-400/70 bg-amber-500/10 text-amber-200">
          ENVELOPE PENDING
        </span>
      );
    }

    if (
      item.envelope_status === "cancelled" ||
      item.envelope_status === "expired"
    ) {
      return (
        <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold border-slate-500/70 bg-slate-500/10 text-slate-300">
          ENVELOPE {item.envelope_status.toUpperCase()}
        </span>
      );
    }

    return null;
  };

  // ---------------------------------------------------------------------------
  // Queue row – keep same “webmail” scroll feel as CI-Council
  // ---------------------------------------------------------------------------
  const renderQueueRow = (item: ForgeQueueItem) => {
    const active = item.ledger_id === selectedId;

    return (
      <button
        key={item.ledger_id}
        type="button"
        onClick={() => {
          setSelectedId(item.ledger_id);
          setSelectedItem(item);
          setSuccess("");
          setError("");
        }}
        className={[
          "group w-full text-left px-3 py-3 border-b border-slate-800 last:border-b-0",
          "transition",
          active
            ? "bg-slate-900/90 shadow-[0_0_0_1px_rgba(52,211,153,0.5)]"
            : "hover:bg-slate-900/60",
        ].join(" ")}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col">
            <span className="text-xs font-semibold text-slate-100 line-clamp-2">
              {item.title || "Untitled resolution"}
            </span>
            <span className="mt-1 text-[11px] text-slate-400 flex items-center gap-2">
              <span>{item.entity_name}</span>
              <span className="w-1 h-1 rounded-full bg-slate-600" />
              <span className="text-slate-500">
                {formattedCreatedAt(item.created_at)}
              </span>
            </span>
            {item.last_signed_at && (
              <span className="mt-0.5 text-[10px] text-slate-500">
                Last signed: {formattedLastSigned(item.last_signed_at)} •{" "}
                {item.days_since_last_signature} day(s) ago
              </span>
            )}
          </div>
          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-2">
              {renderRiskLight(item)}
              {renderEnvelopeBadge(item)}
            </div>
            <span className="text-[10px] text-slate-500">
              {item.ledger_status || "APPROVED"}
            </span>
            <span className="text-[9px] text-slate-500">
              Parties: {item.parties_signed ?? 0}/{item.parties_total ?? 0}
            </span>
          </div>
        </div>
      </button>
    );
  };

  // ---------------------------------------------------------------------------
  // Page layout – mirrored to CI-Council
  // ---------------------------------------------------------------------------
  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      {/* Header under OS bar – mirrors CI-Council */}
      <div className="mb-4 shrink-0">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">
          CI-FORGE
        </div>
        <p className="mt-1 text-[11px] text-slate-400">
          Execution &amp; Signature Forge •{" "}
          <span className="font-semibold text-slate-200">
            ODP.AI – Governance Firmware
          </span>
        </p>
      </div>

      {/* Main window frame – same proportions as Council */}
      <div className="flex-1 min-h-0 flex justify-center overflow-hidden">
        <div className="w-full max-w-[1400px] h-full rounded-3xl border border-slate-900 bg-black/60 shadow-[0_0_60px_rgba(15,23,42,0.9)] px-6 py-5 flex flex-col overflow-hidden">
          {/* Window title */}
          <div className="flex items-start justify-between mb-4 shrink-0">
            <div>
              <h1 className="text-lg font-semibold text-slate-50">
                CI-Forge – Execution &amp; Signature Console
              </h1>
              <p className="mt-1 text-xs text-slate-400">
                <span className="font-semibold text-emerald-400">Left:</span>{" "}
                council-approved ledger records ready for execution.{" "}
                <span className="font-semibold text-sky-400">Right:</span> launch
                and manage signature envelopes for each record.
              </p>
            </div>
            <div className="hidden md:flex items-center text-[10px] uppercase tracking-[0.3em] text-slate-500">
              CI-FORGE • LIVE
            </div>
          </div>

          {/* TWO-COLUMN LAYOUT */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 flex-1 min-h-0">
            {/* LEFT – Execution queue & selected summary */}
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
                {/* Queue list – scroll like CI-Council */}
                <div className="queue-scroll flex-1 min-h-0 overflow-y-auto rounded-xl border border-slate-800/80 bg-slate-950/60">
                  {loadingQueue && (
                    <div className="p-3 text-[11px] text-slate-400">
                      Loading council-approved records…
                    </div>
                  )}

                  {!loadingQueue && queue.length === 0 && !error && (
                    <div className="p-3 text-[11px] text-slate-400">
                      No council-approved records ready for execution for this
                      entity.
                    </div>
                  )}

                  {!loadingQueue && queue.length > 0 && (
                    <>{queue.map(renderQueueRow)}</>
                  )}
                </div>

                {/* Selected record summary */}
                <div className="flex flex-col rounded-xl border border-slate-800/80 bg-slate-950/60 px-4 py-3">
                  {selectedItem ? (
                    <>
                      <div className="flex items-center justify-between mb-2">
                        <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">
                          Selected Record
                        </div>
                        <div className="flex flex-col items-end gap-1">
                          <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/40 text-[10px] uppercase tracking-[0.18em] text-emerald-300">
                            {selectedItem.ledger_status || "APPROVED"}
                          </span>
                          <div className="flex items-center gap-2">
                            {renderRiskLight(selectedItem)}
                            {renderEnvelopeBadge(selectedItem)}
                          </div>
                        </div>
                      </div>

                      <div className="text-sm font-semibold text-slate-100 mb-1">
                        {selectedItem.title || "Untitled resolution"}
                      </div>

                      <div className="text-[11px] text-slate-400 mb-3 space-y-1">
                        <div>
                          Entity:{" "}
                          <span className="text-slate-200">
                            {selectedItem.entity_name}
                          </span>
                        </div>
                        <div>
                          Created:{" "}
                          <span className="text-slate-300">
                            {formattedCreatedAt(selectedItem.created_at)}
                          </span>
                        </div>
                        <div>
                          Envelope ID:{" "}
                          <span className="text-slate-300">
                            {selectedItem.envelope_id ?? "Not created yet"}
                          </span>
                        </div>
                        <div>
                          Last signed:{" "}
                          <span className="text-slate-300">
                            {formattedLastSigned(selectedItem.last_signed_at)}
                          </span>
                        </div>
                        <div>
                          Parties:{" "}
                          <span className="text-slate-300">
                            {selectedItem.parties_signed ?? 0}/
                            {selectedItem.parties_total ?? 0}
                          </span>
                        </div>
                      </div>

                      <p className="mt-1 text-[11px] text-emerald-400/90">
                        Over time, this pane will surface the executed record,
                        certificate status, and direct links to signed PDFs for
                        board-ready packs.
                      </p>
                    </>
                  ) : (
                    <div className="text-[11px] text-slate-400">
                      Select a ledger record from the queue to prepare its
                      signature envelope.
                    </div>
                  )}
                </div>
              </div>
            </section>

            {/* RIGHT – Signature envelope panel */}
            <section className="border border-slate-800 rounded-2xl bg-slate-950/40 p-4 flex flex-col min-h-0">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h2 className="text-sm font-semibold text-slate-200">
                    Signature Envelope
                  </h2>
                  <p className="mt-1 text-[11px] text-slate-400 max-w-lg">
                    Configure the{" "}
                    <span className="font-semibold text-emerald-400">
                      primary signer
                    </span>{" "}
                    and optional{" "}
                    <span className="font-semibold text-sky-400">
                      CC observers
                    </span>
                    , then start or reuse an envelope linked to this ledger
                    record.
                  </p>
                </div>
                {selectedItem && (
                  <span className="px-2 py-0.5 rounded-full bg-slate-800/70 border border-slate-600/70 text-[10px] uppercase tracking-[0.18em] text-slate-300">
                    Preparing: {selectedItem.title}
                  </span>
                )}
              </div>

              {error && (
                <div className="mb-3 rounded-xl border border-rose-500/60 bg-rose-900/30 px-3 py-2 text-[11px] text-rose-100">
                  {error}
                </div>
              )}

              {success && (
                <div className="mb-3 rounded-xl border border-emerald-500/60 bg-emerald-900/30 px-3 py-2 text-[11px] text-emerald-100">
                  {success}
                </div>
              )}

              {!selectedItem ? (
                <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-950/60 text-[11px] text-slate-500">
                  Select a council-approved record from the left to prepare its
                  signature envelope.
                </div>
              ) : (
                <form
                  onSubmit={handleStartSignature}
                  className="flex flex-1 flex-col gap-4"
                >
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <label
                        className="text-[11px] font-medium uppercase tracking-[0.16em] text-slate-400"
                        htmlFor="primary-signer-name"
                      >
                        Primary signer name
                      </label>
                      <input
                        id="primary-signer-name"
                        name="primary-signer-name"
                        type="text"
                        className="w-full rounded-2xl border border-slate-700 bg-slate-900/70 px-3 py-2 text-sm text-slate-100 outline-none ring-0 focus:border-emerald-400"
                        value={primarySignerName}
                        onChange={(e) => setPrimarySignerName(e.target.value)}
                        placeholder="e.g. Board Chair or Signing Officer"
                        required
                      />
                    </div>

                    <div className="space-y-2">
                      <label
                        className="text-[11px] font-medium uppercase tracking-[0.16em] text-slate-400"
                        htmlFor="primary-signer-email"
                      >
                        Primary signer email
                      </label>
                      <input
                        id="primary-signer-email"
                        name="primary-signer-email"
                        type="email"
                        className="w-full rounded-2xl border border-slate-700 bg-slate-900/70 px-3 py-2 text-sm text-slate-100 outline-none ring-0 focus:border-emerald-400"
                        value={primarySignerEmail}
                        onChange={(e) => setPrimarySignerEmail(e.target.value)}
                        placeholder="signer@clientcompany.com"
                        required
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label
                      className="text-[11px] font-medium uppercase tracking-[0.16em] text-slate-400"
                      htmlFor="cc-emails"
                    >
                      CC emails (optional)
                    </label>
                    <input
                      id="cc-emails"
                      name="cc-emails"
                      type="text"
                      placeholder="Comma-separated for directors / observers"
                      className="w-full rounded-2xl border border-slate-700 bg-slate-900/70 px-3 py-2 text-sm text-slate-100 outline-none ring-0 placeholder:text-slate-500 focus:border-emerald-400"
                      value={ccEmails}
                      onChange={(e) => setCcEmails(e.target.value)}
                    />
                  </div>

                  <div className="mt-auto flex flex-wrap items-center justify-end gap-3 pt-2">
                    <button
                      type="button"
                      onClick={handleSendInviteNow}
                      disabled={isSendingInvite}
                      className="inline-flex items-center rounded-full border border-emerald-500/70 bg-transparent px-4 py-2 text-xs font-semibold text-emerald-300 shadow-md shadow-emerald-500/20 transition hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isSendingInvite ? "Sending…" : "Send invite now"}
                    </button>

                    <button
                      type="button"
                      onClick={handleArchiveSignedPdf}
                      disabled={!envelopeSigned || isArchiving}
                      className="inline-flex items-center rounded-full border border-sky-400/70 bg-sky-500/10 px-4 py-2 text-xs font-semibold text-sky-100 shadow-md shadow-sky-500/20 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isArchiving
                        ? "Archiving…"
                        : envelopeSigned
                        ? "Archive signed PDF"
                        : "Archive (wait for signature)"}
                    </button>

                    <button
                      type="submit"
                      disabled={isSending || !selectedItem || envelopeLocked}
                      className="inline-flex items-center rounded-full bg-emerald-500 px-5 py-2 text-sm font-semibold text-emerald-950 shadow-lg shadow-emerald-500/30 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-emerald-700/60"
                    >
                      {envelopeLocked
                        ? "Envelope already created"
                        : isSending
                        ? "Starting…"
                        : "Start signature envelope"}
                    </button>
                  </div>

                  <div className="mt-3 text-[10px] text-slate-500 flex items-center justify-between">
                    <span>
                      CI-Forge · Linked to{" "}
                      <span className="font-semibold text-slate-300">
                        governance_ledger
                      </span>
                    </span>
                    <span>ODP.AI · Execution Session</span>
                  </div>
                </form>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
