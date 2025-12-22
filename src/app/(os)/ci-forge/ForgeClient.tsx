"use client";
export const dynamic = "force-dynamic";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  Clock,
  FileText,
  Shield,
  Send,
  ExternalLink,
  Archive,
  RefreshCw,
} from "lucide-react";

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

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function norm(s?: string | null, fb = "—") {
  const x = (s || "").toString().trim();
  return x.length ? x : fb;
}

function fmtDate(iso?: string | null) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function ForgeClient() {
  const router = useRouter();

  // OS entity scope (canonical)
  const entityCtx: any = useEntity();
  const entityKey: string =
    entityCtx?.entityKey ??
    entityCtx?.activeEntity ??
    entityCtx?.entity_slug ??
    "holdings";

  const [tab, setTab] = useState<TabKey>("active");

  const [queue, setQueue] = useState<ForgeQueueItem[]>([]);
  const [loadingQueue, setLoadingQueue] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(
    () => queue.find((q) => q.ledger_id === selectedId) ?? queue[0] ?? null,
    [queue, selectedId],
  );

  const [primarySignerName, setPrimarySignerName] = useState("");
  const [primarySignerEmail, setPrimarySignerEmail] = useState("");
  const [ccEmails, setCcEmails] = useState("");

  const [isSending, setIsSending] = useState(false);
  const [isSendingInvite, setIsSendingInvite] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // IMPORTANT:
  // Auth gating belongs to (os)/layout or os-auth-gate.
  // Do NOT redirect to /login from inside CI modules.

  // ---------------------------------------------------------------------------
  // Risk engine
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

  const envelopeSigned = selected?.envelope_status === "completed";

  // ---------------------------------------------------------------------------
  // Load Forge queue (entity-scoped)
  // ---------------------------------------------------------------------------
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
        // entity scope MUST follow OS selector
        .eq("entity_slug", entityKey)
        .order("created_at", { ascending: false });

      if (error) {
        console.error("CI-Forge queue error:", error);
        setQueue([]);
        setSelectedId(null);
        setError("Unable to load Forge queue for this entity.");
        return;
      }

      const rows = ((data ?? []) as unknown as ForgeQueueItem[]) ?? [];
      setQueue(rows);

      // keep selection stable if possible
      const stillThere = rows.some((r) => r.ledger_id === selectedId);
      setSelectedId(stillThere ? selectedId : rows[0]?.ledger_id ?? null);
    } catch (err) {
      console.error("CI-Forge queue exception:", err);
      setQueue([]);
      setSelectedId(null);
      setError("Unable to load Forge queue for this entity.");
    } finally {
      setLoadingQueue(false);
    }
  };

  useEffect(() => {
    fetchQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityKey]);

  // ---------------------------------------------------------------------------
  // Tabs: Active vs Completed
  // ---------------------------------------------------------------------------
  const { activeItems, completedItems } = useMemo(() => {
    const completed = queue.filter((q) => q.envelope_status === "completed");
    const active = queue.filter((q) => q.ledger_status === "APPROVED" && q.envelope_status !== "completed");
    return { activeItems: active, completedItems: completed };
  }, [queue]);

  const scopedList = tab === "active" ? activeItems : completedItems;

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
        entity_slug: entityKey,
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
  // send-signature-invite
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
  // archive-signed-resolution (uses user token, not anon)
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
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) throw new Error("No session token available.");

      const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      if (!baseUrl) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL.");

      const res = await fetch(`${baseUrl}/functions/v1/archive-signed-resolution`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ envelope_id: selected.envelope_id }),
      });

      const data: ArchiveSignedResolutionResponse = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(data?.error ?? "Failed to archive signed PDF into the minute book.");
      }

      setInfo(data.already_archived ? "Already archived in Minute Book." : "Signed PDF archived to Minute Book.");
      await fetchQueue();
      setTab("completed");
    } catch (err: any) {
      setError(err?.message ?? "Failed to archive the signed PDF.");
    } finally {
      setIsArchiving(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Links: Sign + Certificate entrypoint
  // (kept as LINKS only — no new wiring)
  // ---------------------------------------------------------------------------
  const signUrl = useMemo(() => {
    if (!selected?.envelope_id) return null;
    // internal OS route (if you later map it) — safe even if unused today
    return `/ci-sign?envelope_id=${encodeURIComponent(selected.envelope_id)}`;
  }, [selected?.envelope_id]);

  const certificateUrl = useMemo(() => {
    if (!selected?.envelope_id) return null;
    // sign app certificate view (works once your certificate page uses envelope_id)
    return `https://sign.oasisintlholdings.com/certificate.html?envelope_id=${encodeURIComponent(selected.envelope_id)}`;
  }, [selected?.envelope_id]);

  // ---------------------------------------------------------------------------
  // Row renderer (Council-style)
  // ---------------------------------------------------------------------------
  const renderRow = (item: ForgeQueueItem) => {
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
          active ? "bg-slate-900/90 shadow-[0_0_0_1px_rgba(245,158,11,0.22)]" : "hover:bg-slate-900/60",
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-slate-100 line-clamp-2">
              {item.title || "Untitled resolution"}
            </div>
            <div className="mt-1 text-[11px] text-slate-400 flex items-center gap-2">
              <span className="truncate">{item.entity_name}</span>
              <span className="w-1 h-1 rounded-full bg-slate-600 shrink-0" />
              <span className="text-slate-500 shrink-0">{fmtDate(item.created_at)}</span>
            </div>
            {item.last_signed_at && (
              <div className="mt-1 text-[10px] text-slate-500">
                Last signed: {fmtDate(item.last_signed_at)} • {item.days_since_last_signature ?? "—"} day(s) ago
              </div>
            )}
          </div>

          <div className="shrink-0 flex flex-col items-end gap-1">
            <div className="flex items-center gap-2">
              <span className={cx("inline-flex h-2 w-2 rounded-full", riskLightClasses(risk))} />
              {renderEnvelopeBadge(item)}
            </div>
            <div className="text-[10px] text-slate-500">{item.ledger_status || "—"}</div>
            <div className="text-[9px] text-slate-500">
              Parties: {item.parties_signed ?? 0}/{item.parties_total ?? 0}
            </div>
          </div>
        </div>
      </button>
    );
  };

  const activeCount = activeItems.length;
  const completedCount = completedItems.length;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      {/* Header under OS bar */}
      <div className="mb-4 shrink-0">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">CI-FORGE</div>
        <p className="mt-1 text-[11px] text-slate-400">
          Signature execution engine • <span className="font-semibold text-slate-200">entity-scoped</span> •{" "}
          <span className="text-slate-500">Council releases APPROVED → Forge executes</span>
        </p>
      </div>

      {/* Main Window – OS/Council framed */}
      <div className="flex-1 min-h-0 flex justify-center overflow-hidden">
        <div className="w-full max-w-[1600px] h-full rounded-3xl border border-slate-900 bg-black/60 shadow-[0_0_60px_rgba(15,23,42,0.9)] px-6 py-5 flex flex-col overflow-hidden">
          {/* Title row */}
          <div className="flex items-start justify-between mb-4 shrink-0">
            <div className="min-w-0">
              <h1 className="text-lg font-semibold text-slate-50 truncate">Forge • Execution Queue</h1>
              <p className="mt-1 text-xs text-slate-400">
                <span className="text-amber-300 font-semibold">Active</span> needs signatures.{" "}
                <span className="text-emerald-300 font-semibold">Completed</span> is ready for archive + certificate.
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={fetchQueue}
                className="rounded-full border border-slate-800 bg-slate-950/60 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60 inline-flex items-center gap-2"
                title="Refresh queue"
              >
                <RefreshCw className="h-4 w-4" />
                Refresh
              </button>

              <button
                type="button"
                onClick={handleSendInviteNow}
                disabled={isSendingInvite}
                className={cx(
                  "rounded-full border px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase inline-flex items-center gap-2 transition",
                  isSendingInvite
                    ? "border-slate-800 bg-slate-900/40 text-slate-500 cursor-not-allowed"
                    : "border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/15",
                )}
                title="Trigger invite job (manual)"
              >
                <Send className="h-4 w-4" />
                Send Invites
              </button>

              <div className="hidden md:flex items-center text-[10px] uppercase tracking-[0.3em] text-slate-500">
                CI-FORGE • LIVE
              </div>
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
          <div className="mb-4 shrink-0 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setTab("active")}
              className={cx(
                "rounded-full border px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition",
                tab === "active"
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
                  : "border-slate-800 bg-slate-950/40 text-slate-300 hover:bg-slate-900/50",
              )}
            >
              <Clock className="inline-block h-4 w-4 -mt-0.5 mr-2" />
              Active ({activeCount})
            </button>

            <button
              type="button"
              onClick={() => setTab("completed")}
              className={cx(
                "rounded-full border px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition",
                tab === "completed"
                  ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-200"
                  : "border-slate-800 bg-slate-950/40 text-slate-300 hover:bg-slate-900/50",
              )}
            >
              <CheckCircle2 className="inline-block h-4 w-4 -mt-0.5 mr-2" />
              Completed ({completedCount})
            </button>

            <div className="ml-auto text-[11px] text-slate-500">
              Entity scope: <span className="text-slate-200 font-semibold">{entityKey}</span>
            </div>
          </div>

          {/* 3-column OS surface */}
          <div className="grid grid-cols-12 gap-6 flex-1 min-h-0">
            {/* LEFT: Queue */}
            <section className="col-span-12 lg:col-span-4 min-h-0 flex flex-col">
              <div className="bg-slate-950/40 border border-slate-800 rounded-2xl p-4 flex flex-col min-h-0">
                <div className="flex items-center justify-between mb-3 shrink-0">
                  <div className="text-sm font-semibold text-slate-200">Queue</div>
                  <div className="text-[10px] uppercase tracking-[0.25em] text-slate-500">
                    {loadingQueue ? "loading" : `${scopedList.length} items`}
                  </div>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto rounded-xl border border-slate-800/80 bg-slate-950/60">
                  {loadingQueue && <div className="p-3 text-[11px] text-slate-400">Loading…</div>}

                  {!loadingQueue && scopedList.length === 0 && (
                    <div className="p-3 text-[11px] text-slate-400">
                      {tab === "active"
                        ? "No active items. Council approvals will appear here."
                        : "No completed envelopes yet."}
                    </div>
                  )}

                  {!loadingQueue && scopedList.map(renderRow)}
                </div>
              </div>
            </section>

            {/* MIDDLE: Details */}
            <section className="col-span-12 lg:col-span-4 min-h-0 flex flex-col">
              <div className="bg-slate-950/40 border border-slate-800 rounded-2xl p-4 flex flex-col min-h-0">
                <div className="flex items-center justify-between mb-3 shrink-0">
                  <div className="text-sm font-semibold text-slate-200">Record</div>
                  <div className="text-[10px] uppercase tracking-[0.25em] text-slate-500">
                    {selected ? "selected" : "—"}
                  </div>
                </div>

                {!selected ? (
                  <div className="text-[11px] text-slate-400">Select an item to view.</div>
                ) : (
                  <div className="flex-1 min-h-0 overflow-y-auto rounded-xl border border-slate-800/80 bg-slate-950/60 p-4">
                    <div className="text-sm font-semibold text-slate-100">{norm(selected.title, "Untitled")}</div>
                    <div className="mt-2 text-[11px] text-slate-400 flex items-center gap-2">
                      <span className="text-slate-300 font-semibold">{norm(selected.entity_name, entityKey)}</span>
                      <span className="w-1 h-1 rounded-full bg-slate-600" />
                      <span className="text-slate-500">Created: {fmtDate(selected.created_at)}</span>
                    </div>

                    <div className="mt-4 grid grid-cols-2 gap-3">
                      <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                        <div className="text-[10px] uppercase tracking-[0.25em] text-slate-500">Ledger Status</div>
                        <div className="mt-1 text-xs font-semibold text-slate-200">{norm(selected.ledger_status, "—")}</div>
                      </div>

                      <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                        <div className="text-[10px] uppercase tracking-[0.25em] text-slate-500">Envelope</div>
                        <div className="mt-1 text-xs font-semibold text-slate-200">{norm(selected.envelope_status, "none")}</div>
                      </div>

                      <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                        <div className="text-[10px] uppercase tracking-[0.25em] text-slate-500">Parties</div>
                        <div className="mt-1 text-xs font-semibold text-slate-200">
                          {selected.parties_signed ?? 0}/{selected.parties_total ?? 0}
                        </div>
                      </div>

                      <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                        <div className="text-[10px] uppercase tracking-[0.25em] text-slate-500">Last Signed</div>
                        <div className="mt-1 text-xs font-semibold text-slate-200">{fmtDate(selected.last_signed_at)}</div>
                      </div>
                    </div>

                    <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                      <div className="text-[10px] uppercase tracking-[0.25em] text-slate-500">AXIOM (advisory)</div>
                      <div className="mt-1 text-[11px] text-slate-300 leading-relaxed">
                        Advisory-only. Never blocking. Severity flags are informational (Council remains authority).
                        <span className="text-slate-500"> (Panel wiring comes after Forge stabilization.)</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </section>

            {/* RIGHT: Actions */}
            <section className="col-span-12 lg:col-span-4 min-h-0 flex flex-col">
              <div className="bg-slate-950/40 border border-slate-800 rounded-2xl p-4 flex flex-col min-h-0">
                <div className="flex items-center justify-between mb-3 shrink-0">
                  <div className="text-sm font-semibold text-slate-200">Execution</div>
                  <div className="text-[10px] uppercase tracking-[0.25em] text-slate-500">actions</div>
                </div>

                {!selected ? (
                  <div className="text-[11px] text-slate-400">Select an item to execute.</div>
                ) : (
                  <div className="flex-1 min-h-0 overflow-y-auto rounded-xl border border-slate-800/80 bg-slate-950/60 p-4">
                    {/* Start signature form (only meaningful on Active tab / not completed) */}
                    <form onSubmit={handleStartSignature} className="space-y-3">
                      <div className="text-[10px] uppercase tracking-[0.25em] text-slate-500 flex items-center gap-2">
                        <Shield className="h-4 w-4" />
                        Start Signature (creates envelope)
                      </div>

                      <input
                        value={primarySignerName}
                        onChange={(e) => setPrimarySignerName(e.target.value)}
                        placeholder="Primary signer name"
                        className="w-full rounded-xl border border-slate-800 bg-black/40 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600"
                      />

                      <input
                        value={primarySignerEmail}
                        onChange={(e) => setPrimarySignerEmail(e.target.value)}
                        placeholder="Primary signer email"
                        className="w-full rounded-xl border border-slate-800 bg-black/40 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600"
                      />

                      <input
                        value={ccEmails}
                        onChange={(e) => setCcEmails(e.target.value)}
                        placeholder="CC emails (comma-separated, optional)"
                        className="w-full rounded-xl border border-slate-800 bg-black/40 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600"
                      />

                      <button
                        type="submit"
                        disabled={isSending || selected.envelope_status === "completed"}
                        className={cx(
                          "w-full rounded-full border px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase inline-flex items-center justify-center gap-2 transition",
                          isSending || selected.envelope_status === "completed"
                            ? "border-slate-800 bg-slate-900/40 text-slate-500 cursor-not-allowed"
                            : "border-amber-500/40 bg-amber-500 text-black hover:bg-amber-400",
                        )}
                      >
                        <FileText className="h-4 w-4" />
                        {isSending ? "Creating…" : selected.envelope_id ? "Recreate / Reuse Envelope" : "Create Envelope"}
                      </button>
                    </form>

                    <div className="mt-5 space-y-2">
                      <div className="text-[10px] uppercase tracking-[0.25em] text-slate-500">Artifact Links</div>

                      <div className="grid grid-cols-1 gap-2">
                        <Link
                          href="/ci-archive"
                          className="rounded-xl border border-slate-800 bg-black/40 px-3 py-2 text-[11px] text-slate-200 hover:bg-slate-900/40 inline-flex items-center justify-between"
                        >
                          <span>Open CI-Archive (registry)</span>
                          <ExternalLink className="h-4 w-4 text-slate-500" />
                        </Link>

                        {signUrl && (
                          <Link
                            href={signUrl}
                            className="rounded-xl border border-slate-800 bg-black/40 px-3 py-2 text-[11px] text-slate-200 hover:bg-slate-900/40 inline-flex items-center justify-between"
                          >
                            <span>Open CI-Sign (envelope)</span>
                            <ExternalLink className="h-4 w-4 text-slate-500" />
                          </Link>
                        )}

                        {certificateUrl && (
                          <a
                            href={certificateUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="rounded-xl border border-slate-800 bg-black/40 px-3 py-2 text-[11px] text-slate-200 hover:bg-slate-900/40 inline-flex items-center justify-between"
                          >
                            <span>Open Certificate (verified)</span>
                            <ExternalLink className="h-4 w-4 text-slate-500" />
                          </a>
                        )}
                      </div>
                    </div>

                    <div className="mt-5 space-y-2">
                      <div className="text-[10px] uppercase tracking-[0.25em] text-slate-500">Finalize</div>

                      <button
                        type="button"
                        onClick={handleArchiveSignedPdf}
                        disabled={isArchiving || !envelopeSigned}
                        className={cx(
                          "w-full rounded-full border px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase inline-flex items-center justify-center gap-2 transition",
                          isArchiving || !envelopeSigned
                            ? "border-slate-800 bg-slate-900/40 text-slate-500 cursor-not-allowed"
                            : "border-emerald-500/35 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/15",
                        )}
                        title={!envelopeSigned ? "Complete signature first." : "Archive signed PDF into Minute Book."}
                      >
                        <Archive className="h-4 w-4" />
                        {isArchiving ? "Archiving…" : "Archive Signed PDF → Minute Book"}
                      </button>

                      <div className="text-[11px] text-slate-500 leading-relaxed">
                        Archive is the discipline layer: signed PDF + hash + registry entry. Council decides whether a
                        record requires signature or direct archive — but both end in the same archive-quality artifact.
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
