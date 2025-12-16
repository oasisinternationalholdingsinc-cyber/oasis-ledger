"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";

export default function ForgeClient({ entitySlug }: { entitySlug: string }) {
  // ✅ delete: const searchParams = useSearchParams();
  // ✅ delete: const entitySlug = searchParams.get("entity") ?? "holdings";

  // ...rest of your file stays the same
}

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

export default function ForgeClient() {
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

  useEffect(() => {
    const checkAuth = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) router.replace("/login");
    };
    checkAuth();
  }, [router]);

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
          .order("created_at", { ascending: false })
          .returns<ForgeQueueItem[]>();

        if (error) {
          setQueue([]);
          setError("Unable to load Forge queue for this entity.");
          return;
        }

        const rows = ((data ?? []) as unknown) as ForgeQueueItem[];
        setQueue(rows);

        if (rows.length > 0) {
          setSelectedId(rows[0].ledger_id);
          setSelectedItem(rows[0]);
        } else {
          setSelectedId(null);
          setSelectedItem(null);
        }
      } catch {
        setQueue([]);
        setError("Unable to load Forge queue for this entity.");
      } finally {
        setLoadingQueue(false);
      }
    };

    fetchQueue();
  }, [entitySlug]);

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
    !!selectedItem?.envelope_status &&
    selectedItem.envelope_status !== "cancelled" &&
    selectedItem.envelope_status !== "expired";

  const envelopeSigned = selectedItem?.envelope_status === "completed";

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

  const riskLightTitle = (risk: RiskLevel, item: ForgeQueueItem) => {
    const days = item.days_since_last_signature;
    const labelDays = days == null ? "No signatures yet" : `${days} day(s) since last signature`;
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
        title={riskLightTitle(risk, item)}
      />
    );
  };

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

      const parties = [
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

      const { data, error } = await supabase.functions.invoke<StartSignatureResponse>(
        "start-signature",
        { body: payload },
      );

      if (error) throw new Error(error.message ?? "Edge function error");
      if (!data?.ok) throw new Error(data?.error ?? "Edge returned ok: false");

      setSuccess(data.reused ? "Existing signature envelope reused." : "Signature envelope created successfully.");

      if (data.envelope_id) {
        setQueue((prev) =>
          prev.map((item) =>
            item.ledger_id === selectedItem.ledger_id
              ? { ...item, envelope_id: data.envelope_id ?? item.envelope_id, envelope_status: "pending" }
              : item,
          ),
        );

        setSelectedItem((prev) =>
          prev ? { ...prev, envelope_id: data.envelope_id ?? prev.envelope_id, envelope_status: "pending" } : prev,
        );
      }
    } catch (err: any) {
      setError(err?.message ?? "Failed to start signature envelope.");
    } finally {
      setIsSending(false);
    }
  };

  const handleSendInviteNow = async () => {
    setIsSendingInvite(true);
    setError("");
    setSuccess("");

    try {
      const { data, error } = await supabase.functions.invoke<SendInviteResponse>(
        "send-signature-invite",
        { body: {} },
      );

      if (error) throw new Error(error.message ?? "Edge function error");
      if (!data?.ok) throw new Error(data?.error ?? data?.message ?? "Invite failed");

      setSuccess(data.message ?? "Signature invitation email sent (or no jobs pending).");
    } catch (err: any) {
      setError(err?.message ?? "Failed to trigger signature invite.");
    } finally {
      setIsSendingInvite(false);
    }
  };

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
      if (!baseUrl || !anonKey) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY.");

      const res = await fetch(`${baseUrl}/functions/v1/archive-signed-resolution`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${anonKey}`,
        },
        body: JSON.stringify({ envelope_id: selectedItem.envelope_id }),
      });

      const data: ArchiveSignedResolutionResponse = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(data?.error ?? "Failed to archive signed PDF into the minute book.");
      }

      setSuccess(
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
          active ? "bg-slate-900/90 shadow-[0_0_0_1px_rgba(52,211,153,0.5)]" : "hover:bg-slate-900/60",
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
              <span className="text-slate-500">{formattedCreatedAt(item.created_at)}</span>
            </span>
            {item.last_signed_at && (
              <span className="mt-0.5 text-[10px] text-slate-500">
                Last signed: {formattedLastSigned(item.last_signed_at)} • {item.days_since_last_signature} day(s) ago
              </span>
            )}
          </div>
          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-2">
              {renderRiskLight(item)}
              {renderEnvelopeBadge(item)}
            </div>
            <span className="text-[10px] text-slate-500">{item.ledger_status || "APPROVED"}</span>
            <span className="text-[9px] text-slate-500">
              Parties: {item.parties_signed ?? 0}/{item.parties_total ?? 0}
            </span>
          </div>
        </div>
      </button>
    );
  };

  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      {/* KEEP your full UI below exactly as you had it */}
      {/* ... (rest of your JSX unchanged) ... */}

      {/* ✅ I’m not re-pasting the remaining JSX here to save your scroll,
          but copy/paste the entire return() block from your current file
          starting from <div className="h-full ..."> down to the end. */}
    </div>
  );
}
