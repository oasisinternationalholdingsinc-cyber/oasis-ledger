// src/app/(console-ledger)/ci-onboarding/ci-admissions/page.tsx
"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";

function cx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function normStatus(s: string | null | undefined) {
  return (s || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
}

type InboxRow = {
  id: string;
  status: string | null;

  submitted_at: string | null;
  triaged_at: string | null;
  decided_at: string | null;
  provisioned_at: string | null;
  created_at: string | null;
  updated_at: string | null;

  applicant_type: string | null;
  applicant_name: string | null;
  applicant_email: string | null;
  applicant_phone: string | null;

  organization_legal_name: string | null;
  organization_trade_name: string | null;
  organization_email: string | null;

  website: string | null;
  incorporation_number: string | null;
  jurisdiction_country: string | null;
  jurisdiction_region: string | null;

  intent: string | null;
  requested_services: any | null;
  expected_start_date: string | null;

  risk_tier: string | null;
  risk_notes: string | null;

  entity_id: string | null;
  entity_slug: string | null;

  primary_contact_user_id: string | null;
  assigned_to: string | null;
  decided_by: string | null;
  created_by: string | null;

  metadata: any | null;

  // view may or may not expose this; we handle both
  is_test?: boolean | null;
};

type Tab = "INTAKE" | "ALL" | "ARCHIVED";
type Quick = "BOTH" | "INTAKE" | "PROVISIONED";

function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "rounded-full px-3 py-1 text-[11px] font-medium transition",
        active
          ? "bg-white/8 text-white/85 ring-1 ring-white/12"
          : "text-white/55 hover:text-white/75"
      )}
    >
      {children}
    </button>
  );
}

function Field({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="text-xs uppercase tracking-[0.22em] text-white/35">{k}</div>
      <div
        className={cx(
          "max-w-[68%] text-right text-sm text-white/80",
          mono && "font-mono text-[12px] leading-5 text-white/70"
        )}
      >
        {v}
      </div>
    </div>
  );
}

// ---------- Oasis OS Modal (replaces browser prompt, no wiring change) ----------
type ModalProps = {
  open: boolean;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  onClose: () => void;
};

function OsModal({ open, title, subtitle, children, footer, onClose }: ModalProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100]">
      {/* backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-[6px]"
        onClick={onClose}
      />
      {/* dialog */}
      <div className="absolute inset-0 flex items-center justify-center p-4">
        <div className="relative w-full max-w-[560px] overflow-hidden rounded-3xl border border-white/10 bg-black/45 shadow-[0_35px_160px_rgba(0,0,0,0.75)]">
          {/* subtle glow */}
          <div className="pointer-events-none absolute -top-28 left-1/2 h-56 w-[520px] -translate-x-1/2 rounded-full bg-amber-300/10 blur-3xl" />
          <div className="relative border-b border-white/10 p-5">
            <div className="text-[11px] uppercase tracking-[0.28em] text-white/45">
              Authority • Decision Window
            </div>
            <div className="mt-1 text-xl font-semibold text-white/90">{title}</div>
            {subtitle ? (
              <div className="mt-1 text-sm text-white/55">{subtitle}</div>
            ) : null}
          </div>

          <div className="relative p-5">{children}</div>

          <div className="relative border-t border-white/10 p-4">
            <div className="flex items-center justify-between gap-3">
              <button
                onClick={onClose}
                className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs font-medium text-white/70 hover:bg-white/7"
              >
                Cancel
              </button>
              {footer}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Input({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <div className="text-xs uppercase tracking-[0.22em] text-white/35">{label}</div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-2 w-full rounded-2xl border border-white/10 bg-black/35 px-4 py-3 text-sm text-white/85 placeholder:text-white/35 outline-none focus:border-amber-300/25"
      />
    </label>
  );
}

function Textarea({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <div className="text-xs uppercase tracking-[0.22em] text-white/35">{label}</div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={4}
        className="mt-2 w-full resize-none rounded-2xl border border-white/10 bg-black/35 px-4 py-3 text-sm text-white/85 placeholder:text-white/35 outline-none focus:border-amber-300/25"
      />
    </label>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="block">
      <div className="text-xs uppercase tracking-[0.22em] text-white/35">{label}</div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-2 w-full rounded-2xl border border-white/10 bg-black/35 px-4 py-3 text-sm text-white/85 outline-none focus:border-amber-300/25"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function CiAdmissionsPage() {
  // ---- entity (defensive, global bar only) ----
  const ec = useEntity() as any;
  const entityKey: string =
    (ec?.entityKey as string) ||
    (ec?.activeEntity as string) ||
    (ec?.entity_slug as string) ||
    "";

  const entityName: string =
    (ec?.entityName as string) ||
    (ec?.activeEntityName as string) ||
    (ec?.entities?.find?.((x: any) => x?.slug === entityKey || x?.key === entityKey)?.name as string) ||
    entityKey;

  // ---- env lane (defensive) ----
  const env = useOsEnv() as any;
  const isTest: boolean = Boolean(
    env?.is_test ?? env?.isTest ?? env?.lane_is_test ?? env?.sandbox ?? env?.isSandbox
  );

  const [rows, setRows] = useState<InboxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>("INTAKE");
  const [quick, setQuick] = useState<Quick>("BOTH");
  const [q, setQ] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // ----- OS modals (instead of browser prompt) -----
  const [approveOpen, setApproveOpen] = useState(false);
  const [needsInfoOpen, setNeedsInfoOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // approve form
  const [approveSummary, setApproveSummary] = useState("Approved for provisioning.");
  const [approveReason, setApproveReason] = useState("Meets intake requirements.");
  const [approveRisk, setApproveRisk] = useState("medium");

  // needs info form
  const [niMessage, setNiMessage] = useState("Please provide missing information.");
  const [niChannels, setNiChannels] = useState("email");
  const [niDueIso, setNiDueIso] = useState(""); // optional ISO string

  // archive form
  const [archiveNote, setArchiveNote] = useState("Archived by operator.");

  // delete form
  const [deleteReason, setDeleteReason] = useState("Test data cleanup.");

  const selected = useMemo(
    () => rows.find((r) => r.id === selectedId) || null,
    [rows, selectedId]
  );

  // ---- load inbox (lane-safe via is_test if available, else fallback) ----
  useEffect(() => {
    let alive = true;

    (async () => {
      setLoading(true);
      setErr(null);

      try {
        const cols = [
          "id",
          "status",
          "submitted_at",
          "triaged_at",
          "decided_at",
          "provisioned_at",
          "created_at",
          "updated_at",
          "applicant_type",
          "applicant_name",
          "applicant_email",
          "applicant_phone",
          "organization_legal_name",
          "organization_trade_name",
          "organization_email",
          "website",
          "incorporation_number",
          "jurisdiction_country",
          "jurisdiction_region",
          "intent",
          "requested_services",
          "expected_start_date",
          "risk_tier",
          "risk_notes",
          "entity_id",
          "entity_slug",
          "primary_contact_user_id",
          "assigned_to",
          "decided_by",
          "created_by",
          "metadata",
        ];

        const tryWithLane = async () => {
          const { data, error } = await supabase
            .from("v_onboarding_admissions_inbox")
            .select([...cols, "is_test"].join(","))
            .eq("entity_slug", entityKey)
            .eq("is_test", isTest)
            .order("created_at", { ascending: false });

          return { data, error };
        };

        const tryWithoutLane = async () => {
          const { data, error } = await supabase
            .from("v_onboarding_admissions_inbox")
            .select(cols.join(","))
            .eq("entity_slug", entityKey)
            .order("created_at", { ascending: false });

          return { data, error };
        };

        let res = await tryWithLane();
        if (res.error && /is_test|42703|undefined column/i.test(res.error.message)) {
          res = await tryWithoutLane();
        }
        if (res.error) throw res.error;

        if (!alive) return;
        const list = (res.data || []) as InboxRow[];
        setRows(list);

        if (!selectedId && list.length) setSelectedId(list[0].id);
        else if (selectedId && !list.some((r) => r.id === selectedId)) setSelectedId(list[0]?.id ?? null);
      } catch (e: any) {
        if (!alive) return;
        setErr(e?.message || "Failed to load admissions inbox.");
      } finally {
        if (!alive) return;
        setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityKey, isTest, refreshKey]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = rows;

    const st = (r: InboxRow) => normStatus(r.status);

    if (tab === "INTAKE") {
      const allow = new Set(["SUBMITTED", "IN_REVIEW", "NEEDS_INFO"]);
      list = list.filter((r) => allow.has(st(r)));
    } else if (tab === "ARCHIVED") {
      list = list.filter((r) => st(r) === "ARCHIVED");
    }

    if (quick === "INTAKE") {
      const allow = new Set(["SUBMITTED", "IN_REVIEW", "NEEDS_INFO"]);
      list = list.filter((r) => allow.has(st(r)));
    } else if (quick === "PROVISIONED") {
      const allow = new Set(["PROVISIONED"]);
      list = list.filter((r) => allow.has(st(r)));
    }

    if (!needle) return list;

    return list.filter((r) => {
      const blob = [
        r.organization_legal_name,
        r.organization_trade_name,
        r.applicant_name,
        r.applicant_email,
        r.organization_email,
        r.status,
        r.applicant_type,
        r.intent,
        r.id,
      ]
        .filter(Boolean)
        .join(" • ")
        .toLowerCase();
      return blob.includes(needle);
    });
  }, [rows, tab, quick, q]);

  const title = useMemo(() => {
    if (!selected) return "Select an application";
    return (
      selected.organization_trade_name ||
      selected.organization_legal_name ||
      selected.applicant_email ||
      selected.id
    );
  }, [selected]);

  async function rpc(name: string, args: any) {
    setBusy(true);
    try {
      const { error } = await supabase.rpc(name, args);
      if (error) throw error;
      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "RPC failed.");
    } finally {
      setBusy(false);
    }
  }

  async function beginReview() {
    if (!selected) return;
    await rpc("admissions_begin_review", { p_application_id: selected.id });
  }

  // ✅ FIXED: onboarding_decision enum values are lowercase
  async function approveForProvisioningConfirmed() {
    if (!selected) return;

    // trim + validate
    const summary = approveSummary.trim();
    const reason = approveReason.trim();
    const risk = approveRisk.trim();

    if (!summary) return alert("Decision summary is required.");
    if (!reason) return alert("Reason / rationale is required.");
    if (!risk) return alert("Risk tier is required.");

    await rpc("admissions_record_decision", {
      p_application_id: selected.id,
      p_decision: "approve", // ✅ enum-correct
      p_risk_tier: risk, // backend expects lowercase like "medium"
      p_summary: summary,
      p_reason: reason,
    });

    setApproveOpen(false);
  }

  async function needsInfoConfirmed() {
    if (!selected) return;

    const msg = niMessage.trim();
    if (!msg) return alert("Message is required.");

    const channels = (niChannels || "email")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const dueStr = (niDueIso ?? "").trim();
    const dueAt =
      dueStr.length > 0 ? new Date(dueStr).toISOString() : null; // ✅ build-safe (never Date(null))

    await rpc("admissions_request_info", {
      p_application_id: selected.id,
      p_message: msg,
      p_channels: channels,
      p_due_at: dueAt,
      p_next_status: "NEEDS_INFO",
    });

    setNeedsInfoOpen(false);
  }

  async function archiveSoftConfirmed() {
    if (!selected) return;
    await rpc("admissions_set_status", {
      p_application_id: selected.id,
      p_next_status: "ARCHIVED",
      p_note: archiveNote || "",
    });
    setArchiveOpen(false);
  }

  async function hardDeleteConfirmed() {
    if (!selected) return;

    const reason = deleteReason.trim();
    if (!reason) return alert("Deletion reason is required.");

    await rpc("admissions_delete_application", {
      p_application_id: selected.id,
      p_reason: reason,
    });

    setDeleteOpen(false);
  }

  const status = normStatus(selected?.status);
  const canBeginReview = !!selected && ["SUBMITTED", "NEEDS_INFO"].includes(status);
  const canApprove = !!selected && ["IN_REVIEW", "NEEDS_INFO"].includes(status);
  const canNeedsInfo = !!selected && ["IN_REVIEW", "SUBMITTED"].includes(status);
  const canArchive = !!selected && status !== "ARCHIVED";
  const canHardDelete = !!selected && ["DECLINED", "WITHDRAWN", "ARCHIVED"].includes(status);

  const statusBadge = useMemo(() => {
    if (!selected) return null;
    const s = normStatus(selected.status);
    const cls =
      s === "PROVISIONED"
        ? "border-emerald-300/20 bg-emerald-400/10 text-emerald-200"
        : s === "NEEDS_INFO"
        ? "border-amber-300/18 bg-amber-400/10 text-amber-200"
        : s === "IN_REVIEW"
        ? "border-sky-300/18 bg-sky-400/10 text-sky-200"
        : s === "ARCHIVED"
        ? "border-white/10 bg-white/5 text-white/65"
        : "border-white/10 bg-white/5 text-white/70";

    return (
      <span className={cx("rounded-full border px-3 py-1 text-[11px] font-medium", cls)}>
        {selected.status || "—"}
      </span>
    );
  }, [selected]);

  return (
    <div className="h-full w-full">
      {/* --- OS Modals --- */}
      <OsModal
        open={approveOpen}
        onClose={() => setApproveOpen(false)}
        title="Approve for Provisioning"
        subtitle="This enables credential binding (Set Password) and portal activation."
        footer={
          <button
            onClick={approveForProvisioningConfirmed}
            disabled={busy}
            className={cx(
              "rounded-full border px-5 py-2 text-xs font-semibold transition",
              !busy
                ? "border-amber-300/22 bg-amber-400/10 text-amber-200 hover:bg-amber-400/14"
                : "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
            )}
          >
            Approve & Continue
          </button>
        }
      >
        <div className="space-y-4">
          <div className="rounded-2xl border border-white/10 bg-black/25 p-4 text-sm text-white/65">
            <div className="text-[11px] uppercase tracking-[0.22em] text-white/35">Application</div>
            <div className="mt-2 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-white/85">{title}</div>
                <div className="mt-1 truncate text-xs text-white/45">
                  {selected?.applicant_email || selected?.organization_email || "—"}
                </div>
              </div>
              {statusBadge}
            </div>
          </div>

          <Input
            label="Decision summary"
            value={approveSummary}
            onChange={setApproveSummary}
            placeholder="Approved for provisioning."
          />
          <Textarea
            label="Rationale (required)"
            value={approveReason}
            onChange={setApproveReason}
            placeholder="Meets intake requirements."
          />
          <Select
            label="Risk tier"
            value={approveRisk}
            onChange={setApproveRisk}
            options={[
              { value: "low", label: "low" },
              { value: "medium", label: "medium" },
              { value: "high", label: "high" },
            ]}
          />

          <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-xs text-white/55">
            Enforced by RPC. No direct table updates.
          </div>
        </div>
      </OsModal>

      <OsModal
        open={needsInfoOpen}
        onClose={() => setNeedsInfoOpen(false)}
        title="Request Information"
        subtitle="Sends a formal request and moves the application to NEEDS_INFO."
        footer={
          <button
            onClick={needsInfoConfirmed}
            disabled={busy}
            className={cx(
              "rounded-full border px-5 py-2 text-xs font-semibold transition",
              !busy
                ? "border-amber-300/18 bg-amber-400/10 text-amber-200 hover:bg-amber-400/14"
                : "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
            )}
          >
            Send Request
          </button>
        }
      >
        <div className="space-y-4">
          <Textarea
            label="Message (required)"
            value={niMessage}
            onChange={setNiMessage}
            placeholder="Please provide missing information."
          />
          <Input
            label="Channels (comma-separated)"
            value={niChannels}
            onChange={setNiChannels}
            placeholder="email,sms"
          />
          <Input
            label="Due at (optional ISO)"
            value={niDueIso}
            onChange={setNiDueIso}
            placeholder="2026-01-20T17:00:00Z"
          />
          <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-xs text-white/55">
            Tip: leave Due at empty to omit a deadline.
          </div>
        </div>
      </OsModal>

      <OsModal
        open={archiveOpen}
        onClose={() => setArchiveOpen(false)}
        title="Archive Application"
        subtitle="Soft archive. Keeps record for audit and removes from intake focus."
        footer={
          <button
            onClick={archiveSoftConfirmed}
            disabled={busy}
            className={cx(
              "rounded-full border px-5 py-2 text-xs font-semibold transition",
              !busy
                ? "border-white/10 bg-white/6 text-white/80 hover:bg-white/8 hover:border-amber-300/15"
                : "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
            )}
          >
            Archive
          </button>
        }
      >
        <div className="space-y-4">
          <Textarea
            label="Archive note (optional)"
            value={archiveNote}
            onChange={setArchiveNote}
            placeholder="Archived by operator."
          />
          <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-xs text-white/55">
            Uses admissions_set_status (RPC-only).
          </div>
        </div>
      </OsModal>

      <OsModal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Hard Delete (Irreversible)"
        subtitle="Only allowed for terminal statuses (DECLINED/WITHDRAWN/ARCHIVED)."
        footer={
          <button
            onClick={hardDeleteConfirmed}
            disabled={busy || !canHardDelete}
            className={cx(
              "rounded-full border px-5 py-2 text-xs font-semibold transition",
              canHardDelete && !busy
                ? "border-rose-300/20 bg-rose-400/10 text-rose-200 hover:bg-rose-400/14"
                : "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
            )}
          >
            Delete
          </button>
        }
      >
        <div className="space-y-4">
          <Textarea
            label="Deletion reason (required)"
            value={deleteReason}
            onChange={setDeleteReason}
            placeholder="Test data cleanup."
          />
          <div className="rounded-2xl border border-rose-300/15 bg-rose-400/10 p-4 text-xs text-rose-100/90">
            This cannot be undone.
          </div>
        </div>
      </OsModal>

      {/* --- Page --- */}
      <div className="mx-auto w-full max-w-[1400px] px-4 pb-10 pt-6">
        <div className="mb-5 flex items-end justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.28em] text-white/45">
              CI • Admissions
            </div>
            <div className="mt-1 text-2xl font-semibold text-white/90">
              Admissions Console
            </div>
            <div className="mt-1 text-sm text-white/50">
              Entity-scoped:{" "}
              <span className="text-white/70">{entityName || entityKey}</span> • Lane:{" "}
              <span className="text-white/70">{isTest ? "SANDBOX" : "RoT"}</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setRefreshKey((n) => n + 1)}
              className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs font-medium text-white/80 hover:border-amber-300/20 hover:bg-white/7"
            >
              Refresh
            </button>
          </div>
        </div>

        <div className="grid grid-cols-12 gap-4">
          {/* LEFT: queue */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs font-semibold tracking-wide text-white/80">
                    Inbox
                  </div>
                  <div className="flex items-center gap-2">
                    <Pill active={tab === "INTAKE"} onClick={() => setTab("INTAKE")}>
                      Intake
                    </Pill>
                    <Pill active={tab === "ALL"} onClick={() => setTab("ALL")}>
                      All
                    </Pill>
                    <Pill active={tab === "ARCHIVED"} onClick={() => setTab("ARCHIVED")}>
                      Archived
                    </Pill>
                  </div>
                </div>

                <div className="mt-3 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Pill active={quick === "BOTH"} onClick={() => setQuick("BOTH")}>
                      BOTH
                    </Pill>
                    <Pill active={quick === "INTAKE"} onClick={() => setQuick("INTAKE")}>
                      INTAKE
                    </Pill>
                    <Pill
                      active={quick === "PROVISIONED"}
                      onClick={() => setQuick("PROVISIONED")}
                    >
                      PROVISIONED
                    </Pill>
                  </div>
                </div>

                <div className="mt-3">
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search org / applicant / email / status"
                    className="w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-2 text-sm text-white/85 placeholder:text-white/35 outline-none focus:border-amber-300/25"
                  />
                </div>
              </div>

              <div className="max-h-[560px] overflow-auto p-2">
                {loading ? (
                  <div className="p-4 text-sm text-white/50">Loading…</div>
                ) : err ? (
                  <div className="p-4 text-sm text-rose-200">{err}</div>
                ) : filtered.length === 0 ? (
                  <div className="p-4 text-sm text-white/50">No applications found.</div>
                ) : (
                  <div className="space-y-2 p-2">
                    {filtered.map((r) => {
                      const active = r.id === selectedId;
                      const name =
                        r.organization_trade_name ||
                        r.organization_legal_name ||
                        r.applicant_email ||
                        r.id;

                      const badge = r.status || "—";
                      const sub = r.applicant_email || r.organization_email || "—";

                      return (
                        <button
                          key={r.id}
                          onClick={() => setSelectedId(r.id)}
                          className={cx(
                            "w-full rounded-2xl border p-4 text-left transition",
                            active
                              ? "border-amber-300/25 bg-black/35 shadow-[0_0_0_1px_rgba(250,204,21,0.10)]"
                              : "border-white/10 bg-black/15 hover:border-white/16 hover:bg-black/22"
                          )}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-semibold text-white/88">
                                {name}
                              </div>
                              <div className="mt-1 truncate text-xs text-white/45">
                                {sub}
                              </div>
                            </div>
                            <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-medium text-white/70">
                              {badge}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="border-t border-white/10 p-4 text-[11px] text-white/35">
                Lane note: UI is lane-aware via OS env. Query is lane-filtered only if the view exposes lane columns.
              </div>
            </div>
          </div>

          {/* MIDDLE: application */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-xs font-semibold tracking-wide text-white/80">
                      Application
                    </div>
                    <div className="mt-1 truncate text-sm text-white/60">{title}</div>
                  </div>
                  {statusBadge}
                </div>
              </div>

              <div className="p-4">
                {!selected ? (
                  <div className="text-sm text-white/50">Select an application.</div>
                ) : (
                  <div className="space-y-4">
                    <div className="space-y-3 rounded-2xl border border-white/10 bg-black/20 p-4">
                      <Field k="Org (legal)" v={selected.organization_legal_name || "—"} />
                      <Field k="Org (trade)" v={selected.organization_trade_name || "—"} />
                      <Field k="Applicant" v={selected.applicant_email || "—"} />
                      <Field k="Org email" v={selected.organization_email || "—"} />
                      <Field k="Type" v={selected.applicant_type || "—"} />
                      <Field k="App ID" v={selected.id} mono />
                      <Field k="Created" v={selected.created_at || "—"} />
                      <Field k="Updated" v={selected.updated_at || "—"} />
                    </div>

                    <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                      <div className="text-xs font-semibold tracking-wide text-white/80">
                        Request / Intent
                      </div>
                      <div className="mt-2 whitespace-pre-wrap text-sm text-white/75">
                        {selected.intent || "—"}
                      </div>

                      <div className="mt-3 text-xs text-white/45">
                        Requested services:{" "}
                        <span className="text-white/70">
                          {selected.requested_services
                            ? JSON.stringify(selected.requested_services)
                            : "—"}
                        </span>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-xs font-semibold tracking-wide text-white/80">
                          Metadata
                        </div>
                        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] text-white/65">
                          jsonb
                        </span>
                      </div>

                      <div className="mt-3 space-y-2 text-xs text-white/60">
                        <div className="flex justify-between gap-4">
                          <div className="text-white/35 uppercase tracking-[0.22em]">
                            source
                          </div>
                          <div className="text-white/75">
                            {selected.metadata?.source || "—"}
                          </div>
                        </div>
                        <div className="flex justify-between gap-4">
                          <div className="text-white/35 uppercase tracking-[0.22em]">
                            request_brief
                          </div>
                          <div className="text-white/75 text-right">
                            {selected.metadata?.request_brief || "—"}
                          </div>
                        </div>
                        <div className="flex justify-between gap-4">
                          <div className="text-white/35 uppercase tracking-[0.22em]">
                            notes
                          </div>
                          <div className="text-white/75 text-right">
                            {selected.metadata?.notes || "—"}
                          </div>
                        </div>

                        <div className="mt-3 rounded-2xl border border-white/10 bg-black/30 p-3 font-mono text-[11px] leading-5 text-white/65">
                          {selected.metadata ? JSON.stringify(selected.metadata, null, 2) : "null"}
                        </div>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-white/10 bg-black/18 p-4 text-sm text-white/60">
                      <div className="font-semibold text-white/80">Read-only</div>
                      <div className="mt-1">
                        Admissions is authority-only. Invite/activation is handled in{" "}
                        <span className="text-white/75">CI-Provisioning</span>. Evidence review is
                        separate.
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* RIGHT: authority panel */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="text-xs font-semibold tracking-wide text-white/80">
                  Authority Panel
                </div>
                <div className="mt-1 text-sm text-white/60">Review • Decisions • Archive</div>
              </div>

              <div className="p-4">
                {!selected ? (
                  <div className="text-sm text-white/50">Select an application.</div>
                ) : (
                  <>
                    <div className="flex flex-col gap-2">
                      <button
                        onClick={beginReview}
                        disabled={!canBeginReview || busy}
                        className={cx(
                          "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                          canBeginReview && !busy
                            ? "border-emerald-300/20 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/14"
                            : "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                        )}
                      >
                        Begin Review
                      </button>

                      <button
                        onClick={() => {
                          // seed defaults with current row, so it feels intelligent
                          setApproveSummary("Approved for provisioning.");
                          setApproveReason("Meets intake requirements.");
                          setApproveRisk((selected?.risk_tier || "medium") as string);
                          setApproveOpen(true);
                        }}
                        disabled={!canApprove || busy}
                        className={cx(
                          "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                          canApprove && !busy
                            ? "border-white/10 bg-white/5 text-white/85 hover:border-amber-300/20 hover:bg-white/7"
                            : "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                        )}
                      >
                        Approve (for Provisioning)
                      </button>

                      <button
                        onClick={() => {
                          setNiMessage("Please provide missing information.");
                          setNiChannels("email");
                          setNiDueIso("");
                          setNeedsInfoOpen(true);
                        }}
                        disabled={!canNeedsInfo || busy}
                        className={cx(
                          "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                          canNeedsInfo && !busy
                            ? "border-amber-300/18 bg-amber-400/10 text-amber-200 hover:bg-amber-400/14"
                            : "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                        )}
                      >
                        Needs Info
                      </button>

                      <button
                        onClick={() => setArchiveOpen(true)}
                        disabled={!canArchive || busy}
                        className={cx(
                          "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                          canArchive && !busy
                            ? "border-white/10 bg-white/4 text-white/75 hover:bg-white/6"
                            : "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                        )}
                      >
                        Archive (soft)
                      </button>

                      <button
                        onClick={() => setDeleteOpen(true)}
                        disabled={!canHardDelete || busy}
                        className={cx(
                          "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                          canHardDelete && !busy
                            ? "border-rose-300/20 bg-rose-400/10 text-rose-200 hover:bg-rose-400/14"
                            : "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                        )}
                      >
                        Hard Delete
                      </button>
                    </div>

                    <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-4">
                      <div className="text-[11px] uppercase tracking-[0.22em] text-white/35">
                        Audit trail
                      </div>
                      <div className="mt-2 text-xs text-white/55">
                        Mutations are RPC-only. No raw updates. Use CI-Provisioning for
                        invite/activation.
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-5 text-[10px] text-white/35">
          Source: public.v_onboarding_admissions_inbox • entity_slug={entityKey} • lane={isTest ? "SANDBOX" : "RoT"}
        </div>
      </div>
    </div>
  );
}
