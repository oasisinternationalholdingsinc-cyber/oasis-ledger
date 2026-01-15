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

function safePrettyJSON(x: any) {
  try {
    if (x == null) return "—";
    return JSON.stringify(x, null, 2);
  } catch {
    return "—";
  }
}

type InboxRow = {
  id: string;
  status: string | null;

  applicant_email: string | null;
  applicant_name?: string | null;

  organization_legal_name: string | null;
  organization_trade_name: string | null;

  primary_contact_user_id: string | null;

  entity_slug: string | null;
  created_at: string | null;
  updated_at?: string | null;

  requested_services?: any | null;
  metadata?: any | null;

  // optional lane exposure from view
  lane_is_test?: boolean | null;
};

type TopTab = "INBOX" | "INTAKE" | "ALL" | "ARCHIVED";
type SubTab = "BOTH" | "INTAKE" | "PROVISIONED";

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
          : "text-white/55 hover:text-white/80"
      )}
    >
      {children}
    </button>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="text-xs uppercase tracking-[0.22em] text-white/35">{k}</div>
      <div className="max-w-[70%] text-right text-sm text-white/80">{v}</div>
    </div>
  );
}

/** Minimal OS Modal (no external deps, consistent glass + gold restraint) */
function OsModal({
  open,
  title,
  subtitle,
  children,
  confirmText = "Confirm",
  cancelText = "Cancel",
  danger,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  busy?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100]">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-[6px]"
        onClick={busy ? undefined : onClose}
      />
      <div className="absolute left-1/2 top-1/2 w-[94vw] max-w-[560px] -translate-x-1/2 -translate-y-1/2">
        <div className="relative overflow-hidden rounded-3xl border border-white/12 bg-[#070A12]/80 shadow-[0_40px_160px_rgba(0,0,0,0.70)]">
          <div className="pointer-events-none absolute inset-0 opacity-60 [background:radial-gradient(900px_500px_at_70%_-20%,rgba(250,204,21,0.14),transparent_55%),radial-gradient(700px_420px_at_10%_0%,rgba(56,189,248,0.10),transparent_50%)]" />
          <div className="relative border-b border-white/10 p-5">
            <div className="text-[11px] uppercase tracking-[0.28em] text-white/45">
              Authority • Action
            </div>
            <div className="mt-2 text-xl font-semibold text-white/90">{title}</div>
            {subtitle ? (
              <div className="mt-1 text-sm text-white/55">{subtitle}</div>
            ) : null}
          </div>

          <div className="relative p-5">{children}</div>

          <div className="relative flex items-center justify-end gap-2 border-t border-white/10 p-4">
            <button
              disabled={busy}
              onClick={onClose}
              className={cx(
                "rounded-full border px-4 py-2 text-xs font-semibold transition",
                busy
                  ? "border-white/10 bg-white/3 text-white/35"
                  : "border-white/10 bg-white/5 text-white/75 hover:bg-white/7 hover:border-white/15"
              )}
            >
              {cancelText}
            </button>
            <button
              disabled={busy}
              onClick={onConfirm}
              className={cx(
                "rounded-full border px-4 py-2 text-xs font-semibold transition",
                danger
                  ? busy
                    ? "border-rose-300/15 bg-rose-500/10 text-rose-200/40"
                    : "border-rose-300/20 bg-rose-500/12 text-rose-100 hover:bg-rose-500/16"
                  : busy
                  ? "border-amber-300/15 bg-amber-400/10 text-amber-100/40"
                  : "border-amber-300/20 bg-amber-400/12 text-amber-100 hover:bg-amber-400/16"
              )}
            >
              {confirmText}
            </button>
          </div>
        </div>

        <div className="mt-3 text-center text-[10px] text-white/35">
          Mutations are RPC-only • Lane-safe via OsEnv + view lane column when present
        </div>
      </div>
    </div>
  );
}

export default function CiAdmissionsPage() {
  // ---- entity (defensive) ----
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

  const [apps, setApps] = useState<InboxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [topTab, setTopTab] = useState<TopTab>("INBOX");
  const [subTab, setSubTab] = useState<SubTab>("BOTH");
  const [q, setQ] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // ---- modals ----
  const [approveOpen, setApproveOpen] = useState(false);
  const [needsInfoOpen, setNeedsInfoOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const [approveRisk, setApproveRisk] = useState("medium");
  const [approveSummary, setApproveSummary] = useState("Approved for provisioning.");
  const [approveReason, setApproveReason] = useState("");

  const [infoMessage, setInfoMessage] = useState("");
  const [infoDue, setInfoDue] = useState<string>("");
  const [infoChannels, setInfoChannels] = useState<{ email: boolean; sms: boolean }>({
    email: true,
    sms: false,
  });

  const [archiveNote, setArchiveNote] = useState("Archived by authority.");
  const [deleteReason, setDeleteReason] = useState("Hard delete (test / duplicate).");

  const selected = useMemo(
    () => apps.find((a) => a.id === selectedId) || null,
    [apps, selectedId]
  );

  const appTitle = useMemo(() => {
    if (!selected) return "Select an application";
    return (
      selected.organization_trade_name ||
      selected.organization_legal_name ||
      selected.applicant_email ||
      selected.id
    );
  }, [selected]);

  const meta = useMemo(() => {
    const m = selected?.metadata;
    return (m && typeof m === "object" ? (m as any) : {}) as any;
  }, [selected?.metadata]);

  // ---- load inbox (lane-safe if column exists, else fallback) ----
  useEffect(() => {
    let alive = true;

    (async () => {
      setLoading(true);
      setErr(null);

      try {
        const cols = [
          "id",
          "status",
          "applicant_email",
          "applicant_name",
          "organization_legal_name",
          "organization_trade_name",
          "primary_contact_user_id",
          "entity_slug",
          "created_at",
          "updated_at",
          "requested_services",
          "metadata",
        ];

        const tryWithLane = async () => {
          const { data, error } = await supabase
            .from("v_onboarding_admissions_inbox")
            .select([...cols, "lane_is_test"].join(","))
            .eq("entity_slug", entityKey)
            .eq("lane_is_test", isTest)
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
        if (res.error && /lane_is_test|42703|undefined column/i.test(res.error.message)) {
          res = await tryWithoutLane();
        }

        if (res.error) throw res.error;
        if (!alive) return;

        const list = (res.data || []) as InboxRow[];
        setApps(list);

        if (!selectedId && list.length) setSelectedId(list[0].id);
        else if (selectedId && !list.some((r) => r.id === selectedId))
          setSelectedId(list[0]?.id ?? null);
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
    let list = apps;

    // top tabs
    if (topTab === "INBOX") {
      list = list.filter((a) => {
        const st = normStatus(a.status);
        return !["ARCHIVED"].includes(st);
      });
    } else if (topTab === "INTAKE") {
      list = list.filter((a) => {
        const st = normStatus(a.status);
        return ["SUBMITTED", "TRIAGE", "UNDER_REVIEW", "NEEDS_INFO", "needs_info"].includes(st);
      });
    } else if (topTab === "ARCHIVED") {
      list = list.filter((a) => normStatus(a.status) === "ARCHIVED");
    }

    // sub tabs (in INBOX view)
    if (topTab === "INBOX") {
      if (subTab === "INTAKE") {
        list = list.filter((a) => {
          const st = normStatus(a.status);
          return !["PROVISIONED"].includes(st);
        });
      } else if (subTab === "PROVISIONED") {
        list = list.filter((a) => normStatus(a.status) === "PROVISIONED");
      }
    }

    if (!needle) return list;

    return list.filter((a) => {
      const blob = [
        a.organization_trade_name,
        a.organization_legal_name,
        a.applicant_name,
        a.applicant_email,
        a.status,
        a.id,
      ]
        .filter(Boolean)
        .join(" • ")
        .toLowerCase();
      return blob.includes(needle);
    });
  }, [apps, topTab, subTab, q]);

  async function rpcBeginReview() {
    if (!selected) return;
    setBusy(true);
    setNote(null);
    try {
      const { error } = await supabase.rpc("admissions_begin_review", {
        p_application_id: selected.id,
      });
      if (error) throw error;
      setNote("Review started.");
      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "Begin Review failed.");
    } finally {
      setBusy(false);
    }
  }

  async function rpcApprove() {
    if (!selected) return;
    setBusy(true);
    setNote(null);
    try {
      // ✅ SAFE WRAPPER (enum-proof + idempotent)
      const { data, error } = await supabase.rpc("admissions_record_decision_safe", {
        p_application_id: selected.id,
        p_decision_text: "approve",
        p_risk_tier_text: approveRisk,
        p_summary: approveSummary || "Approved for provisioning.",
        p_reason: approveReason || null,
      });
      if (error) throw error;

      const msg =
        data?.idempotent ? "Already decided (no-op)." : "Approved for provisioning.";
      setNote(msg);
      setApproveOpen(false);
      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "Approve failed.");
    } finally {
      setBusy(false);
    }
  }

  async function rpcNeedsInfo() {
    if (!selected) return;
    const channels: string[] = [];
    if (infoChannels.email) channels.push("email");
    if (infoChannels.sms) channels.push("sms");

    if (!infoMessage.trim()) {
      alert("Message is required.");
      return;
    }

    setBusy(true);
    setNote(null);
    try {
      const dueAt =
        infoDue && infoDue.trim()
          ? new Date(`${infoDue}T23:59:00`).toISOString()
          : null;

      const { error } = await supabase.rpc("admissions_request_info", {
        p_application_id: selected.id,
        p_message: infoMessage.trim(),
        p_channels: channels,
        p_due_at: dueAt,
        // ✅ use lowercase enum label that exists in your list
        p_next_status: "needs_info",
      });

      if (error) throw error;

      setNote("Needs Info sent.");
      setNeedsInfoOpen(false);
      setInfoMessage("");
      setInfoDue("");
      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "Needs Info failed.");
    } finally {
      setBusy(false);
    }
  }

  async function rpcArchiveSoft() {
    if (!selected) return;
    setBusy(true);
    setNote(null);
    try {
      const { error } = await supabase.rpc("admissions_set_status", {
        p_application_id: selected.id,
        p_next_status: "archived",
        p_note: archiveNote || "Archived by authority.",
      });
      if (error) throw error;

      setNote("Archived.");
      setArchiveOpen(false);
      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "Archive failed.");
    } finally {
      setBusy(false);
    }
  }

  async function rpcHardDelete() {
    if (!selected) return;
    setBusy(true);
    setNote(null);
    try {
      const { error } = await supabase.rpc("admissions_delete_application", {
        p_application_id: selected.id,
        p_reason: deleteReason || "Hard delete.",
      });
      if (error) throw error;

      setNote("Deleted.");
      setDeleteOpen(false);
      setSelectedId(null);
      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "Hard Delete failed.");
    } finally {
      setBusy(false);
    }
  }

  const statusBadge = (stRaw: string | null) => {
    const st = normStatus(stRaw);
    const base =
      "rounded-full border px-3 py-1 text-[11px] font-medium";
    if (st === "NEEDS_INFO") return `${base} border-amber-300/18 bg-amber-400/10 text-amber-100/90`;
    if (st === "UNDER_REVIEW") return `${base} border-sky-300/18 bg-sky-400/10 text-sky-100/90`;
    if (st === "PROVISIONED") return `${base} border-emerald-300/18 bg-emerald-400/10 text-emerald-100/90`;
    if (st === "ARCHIVED") return `${base} border-white/10 bg-white/5 text-white/55`;
    return `${base} border-white/10 bg-white/5 text-white/70`;
  };

  return (
    <div className="h-full w-full">
      <div className="mx-auto w-full max-w-[1400px] px-4 pb-10 pt-6">
        {/* Header */}
        <div className="mb-5 flex items-end justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.28em] text-white/45">
              CI • Admissions
            </div>
            <div className="mt-1 text-2xl font-semibold text-white/90">
              Admissions Console
            </div>
            <div className="mt-1 text-sm text-white/50">
              Entity-scoped: <span className="text-white/70">{entityName || entityKey}</span> • Lane:{" "}
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
          {/* Left: inbox */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="text-xs font-semibold tracking-wide text-white/80">
                  Inbox
                </div>

                <div className="mt-3 flex items-center justify-between gap-2">
                  <div className="flex flex-wrap gap-2">
                    <Pill active={topTab === "INBOX"} onClick={() => setTopTab("INBOX")}>
                      Inbox
                    </Pill>
                    <Pill active={topTab === "INTAKE"} onClick={() => setTopTab("INTAKE")}>
                      Intake
                    </Pill>
                    <Pill active={topTab === "ALL"} onClick={() => setTopTab("ALL")}>
                      All
                    </Pill>
                    <Pill active={topTab === "ARCHIVED"} onClick={() => setTopTab("ARCHIVED")}>
                      Archived
                    </Pill>
                  </div>
                </div>

                {topTab === "INBOX" && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Pill active={subTab === "BOTH"} onClick={() => setSubTab("BOTH")}>
                      BOTH
                    </Pill>
                    <Pill active={subTab === "INTAKE"} onClick={() => setSubTab("INTAKE")}>
                      INTAKE
                    </Pill>
                    <Pill active={subTab === "PROVISIONED"} onClick={() => setSubTab("PROVISIONED")}>
                      PROVISIONED
                    </Pill>
                  </div>
                )}

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
                    {filtered.map((a) => {
                      const active = a.id === selectedId;
                      const name =
                        a.organization_trade_name ||
                        a.organization_legal_name ||
                        a.applicant_email ||
                        a.id;
                      return (
                        <button
                          key={a.id}
                          onClick={() => setSelectedId(a.id)}
                          className={cx(
                            "w-full rounded-2xl border p-4 text-left transition",
                            active
                              ? "border-amber-300/25 bg-black/35 shadow-[0_0_0_1px_rgba(250,204,21,0.10)]"
                              : "border-white/10 bg-black/15 hover:border-white/16 hover:bg-black/22"
                          )}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-semibold text-white/88">{name}</div>
                              <div className="mt-1 truncate text-xs text-white/45">
                                {a.applicant_email || "—"}
                              </div>
                            </div>
                            <span className={statusBadge(a.status)}>{a.status || "—"}</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="border-t border-white/10 p-3 text-[10px] text-white/35">
                Lane note: UI is lane-aware via OS env. Query is lane-filtered only if the view exposes lane columns.
              </div>
            </div>
          </div>

          {/* Middle: application details */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="text-xs font-semibold tracking-wide text-white/80">
                  Application
                </div>
                <div className="mt-1 truncate text-sm text-white/60">
                  {selected ? appTitle : "Select an application"}
                </div>
              </div>

              <div className="p-4">
                {!selected ? (
                  <div className="text-sm text-white/50">Select an application.</div>
                ) : (
                  <div className="space-y-4">
                    <div className="space-y-3 rounded-2xl border border-white/10 bg-black/20 p-4">
                      <Row k="Org (legal)" v={selected.organization_legal_name || "—"} />
                      <Row k="Org (trade)" v={selected.organization_trade_name || "—"} />
                      <Row k="Applicant" v={selected.applicant_email || "—"} />
                      <Row k="Status" v={selected.status || "—"} />
                      <Row k="App ID" v={selected.id} />
                      <Row k="Created" v={selected.created_at || "—"} />
                      <Row k="Updated" v={selected.updated_at || "—"} />
                    </div>

                    <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                      <div className="text-xs font-semibold tracking-wide text-white/80">
                        Request / Intent
                      </div>
                      <div className="mt-2 text-sm text-white/75 whitespace-pre-wrap">
                        {meta?.request_brief ? String(meta.request_brief) : "—"}
                      </div>
                      <div className="mt-2 text-xs text-white/45">
                        Requested services:{" "}
                        <span className="text-white/70">
                          {selected.requested_services ? JSON.stringify(selected.requested_services) : "—"}
                        </span>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-white/10 bg-black/18 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-xs font-semibold tracking-wide text-white/80">
                          Metadata
                        </div>
                        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-medium text-white/60">
                          jsonb
                        </span>
                      </div>

                      <div className="mt-3 space-y-3">
                        <Row k="source" v={meta?.source ? String(meta.source) : "—"} />
                        <Row k="notes" v={meta?.notes ? String(meta.notes) : "—"} />

                        <div className="mt-3 rounded-2xl border border-white/10 bg-black/25 p-3">
                          <div className="text-[10px] uppercase tracking-[0.22em] text-white/35">
                            raw
                          </div>
                          <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-white/70">
                            {safePrettyJSON(selected.metadata)}
                          </pre>
                        </div>
                      </div>
                    </div>

                    {note && (
                      <div className="rounded-2xl border border-white/10 bg-black/20 p-3 text-xs text-white/70">
                        {note}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right: authority */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="text-xs font-semibold tracking-wide text-white/80">
                  Authority Panel
                </div>
                <div className="mt-1 truncate text-sm text-white/60">
                  Review • Decisions • Archive
                </div>
              </div>

              <div className="p-4">
                <div className="flex flex-col gap-2">
                  <button
                    onClick={rpcBeginReview}
                    disabled={!selected || busy}
                    className={cx(
                      "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                      selected && !busy
                        ? "border-white/10 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/14 hover:border-emerald-300/25"
                        : "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                    )}
                  >
                    Begin Review
                  </button>

                  <button
                    onClick={() => setApproveOpen(true)}
                    disabled={!selected || busy}
                    className={cx(
                      "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                      selected && !busy
                        ? "border-white/10 bg-white/5 text-white/85 hover:border-amber-300/20 hover:bg-white/7"
                        : "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                    )}
                  >
                    Approve (for Provisioning)
                  </button>

                  <button
                    onClick={() => setNeedsInfoOpen(true)}
                    disabled={!selected || busy}
                    className={cx(
                      "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                      selected && !busy
                        ? "border-white/10 bg-white/5 text-white/85 hover:border-amber-300/20 hover:bg-white/7"
                        : "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                    )}
                  >
                    Needs Info
                  </button>

                  <button
                    onClick={() => setArchiveOpen(true)}
                    disabled={!selected || busy}
                    className={cx(
                      "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                      selected && !busy
                        ? "border-white/10 bg-white/5 text-white/70 hover:border-white/16 hover:bg-white/7"
                        : "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                    )}
                  >
                    Archive (soft)
                  </button>

                  <button
                    onClick={() => setDeleteOpen(true)}
                    disabled={!selected || busy}
                    className={cx(
                      "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                      selected && !busy
                        ? "border-rose-300/18 bg-rose-500/10 text-rose-100 hover:bg-rose-500/14"
                        : "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                    )}
                  >
                    Hard Delete
                  </button>

                  <div className="mt-2 rounded-2xl border border-white/10 bg-black/18 p-4 text-sm text-white/60">
                    <div className="font-semibold text-white/80">Audit Trail</div>
                    <div className="mt-1">
                      Mutations are RPC-only. Enums are normalized server-side (decision-safe wrapper).
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* footer */}
        <div className="mt-5 text-[10px] text-white/35">
          Source: public.v_onboarding_admissions_inbox • entity_slug={entityKey} • lane={isTest ? "SANDBOX" : "RoT"}
        </div>
      </div>

      {/* Approve modal */}
      <OsModal
        open={approveOpen}
        title="Approve for provisioning"
        subtitle={selected ? appTitle : undefined}
        confirmText={busy ? "Working…" : "Approve"}
        cancelText="Cancel"
        busy={busy}
        onClose={() => (!busy ? setApproveOpen(false) : null)}
        onConfirm={rpcApprove}
      >
        <div className="space-y-4">
          <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs font-semibold tracking-wide text-white/80">Risk tier</div>
            <select
              value={approveRisk}
              onChange={(e) => setApproveRisk(e.target.value)}
              className="mt-2 w-full rounded-2xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white/85 outline-none focus:border-amber-300/25"
            >
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs font-semibold tracking-wide text-white/80">Decision summary</div>
            <input
              value={approveSummary}
              onChange={(e) => setApproveSummary(e.target.value)}
              className="mt-2 w-full rounded-2xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white/85 outline-none focus:border-amber-300/25"
              placeholder="Approved for provisioning."
            />
            <div className="mt-3 text-xs text-white/40">
              Uses <span className="font-mono text-white/65">admissions_record_decision_safe</span> (enum-proof + idempotent).
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs font-semibold tracking-wide text-white/80">Reason (optional)</div>
            <textarea
              value={approveReason}
              onChange={(e) => setApproveReason(e.target.value)}
              className="mt-2 min-h-[88px] w-full rounded-2xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white/85 outline-none focus:border-amber-300/25"
              placeholder="Operator rationale (optional)."
            />
          </div>
        </div>
      </OsModal>

      {/* Needs info modal */}
      <OsModal
        open={needsInfoOpen}
        title="Request additional information"
        subtitle={selected ? appTitle : undefined}
        confirmText={busy ? "Working…" : "Send request"}
        cancelText="Cancel"
        busy={busy}
        onClose={() => (!busy ? setNeedsInfoOpen(false) : null)}
        onConfirm={rpcNeedsInfo}
      >
        <div className="space-y-4">
          <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs font-semibold tracking-wide text-white/80">Message</div>
            <textarea
              value={infoMessage}
              onChange={(e) => setInfoMessage(e.target.value)}
              className="mt-2 min-h-[110px] w-full rounded-2xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white/85 outline-none focus:border-amber-300/25"
              placeholder="What do you need from the applicant?"
            />
          </div>

          <div className="grid grid-cols-12 gap-3">
            <div className="col-span-12 md:col-span-6 rounded-2xl border border-white/10 bg-black/20 p-4">
              <div className="text-xs font-semibold tracking-wide text-white/80">Channels</div>
              <label className="mt-2 flex items-center gap-2 text-sm text-white/75">
                <input
                  type="checkbox"
                  checked={infoChannels.email}
                  onChange={(e) => setInfoChannels((s) => ({ ...s, email: e.target.checked }))}
                />
                Email
              </label>
              <label className="mt-2 flex items-center gap-2 text-sm text-white/75">
                <input
                  type="checkbox"
                  checked={infoChannels.sms}
                  onChange={(e) => setInfoChannels((s) => ({ ...s, sms: e.target.checked }))}
                />
                SMS
              </label>
            </div>

            <div className="col-span-12 md:col-span-6 rounded-2xl border border-white/10 bg-black/20 p-4">
              <div className="text-xs font-semibold tracking-wide text-white/80">Due date (optional)</div>
              <input
                type="date"
                value={infoDue}
                onChange={(e) => setInfoDue(e.target.value)}
                className="mt-2 w-full rounded-2xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white/85 outline-none focus:border-amber-300/25"
              />
              <div className="mt-2 text-xs text-white/40">Sets due_at to end-of-day UTC.</div>
            </div>
          </div>
        </div>
      </OsModal>

      {/* Archive modal */}
      <OsModal
        open={archiveOpen}
        title="Archive application (soft)"
        subtitle={selected ? appTitle : undefined}
        confirmText={busy ? "Working…" : "Archive"}
        cancelText="Cancel"
        busy={busy}
        onClose={() => (!busy ? setArchiveOpen(false) : null)}
        onConfirm={rpcArchiveSoft}
      >
        <div className="space-y-3 rounded-2xl border border-white/10 bg-black/20 p-4">
          <div className="text-xs font-semibold tracking-wide text-white/80">Note</div>
          <input
            value={archiveNote}
            onChange={(e) => setArchiveNote(e.target.value)}
            className="mt-2 w-full rounded-2xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white/85 outline-none focus:border-amber-300/25"
            placeholder="Archived by authority."
          />
          <div className="text-xs text-white/40">
            Sets status to <span className="font-mono text-white/65">archived</span> via RPC.
          </div>
        </div>
      </OsModal>

      {/* Delete modal */}
      <OsModal
        open={deleteOpen}
        title="Hard delete (irreversible)"
        subtitle={selected ? appTitle : undefined}
        confirmText={busy ? "Working…" : "Delete"}
        cancelText="Cancel"
        danger
        busy={busy}
        onClose={() => (!busy ? setDeleteOpen(false) : null)}
        onConfirm={rpcHardDelete}
      >
        <div className="space-y-3 rounded-2xl border border-rose-300/15 bg-rose-500/10 p-4">
          <div className="text-xs font-semibold tracking-wide text-rose-100/90">Reason</div>
          <input
            value={deleteReason}
            onChange={(e) => setDeleteReason(e.target.value)}
            className="mt-2 w-full rounded-2xl border border-rose-300/15 bg-black/30 px-3 py-2 text-sm text-rose-50/90 outline-none focus:border-rose-300/25"
            placeholder="Why is this being deleted?"
          />
          <div className="text-xs text-rose-100/70">
            This calls <span className="font-mono">admissions_delete_application</span>. Use only for test/duplicates.
          </div>
        </div>
      </OsModal>
    </div>
  );
}
