// src/app/(os)/ci-onboarding/ci-admissions/page.tsx
"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";

function cx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function normStatus(s: string | null | undefined) {
  return (s || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
}

function toLowerEnum(s: string) {
  return s.trim().toLowerCase().replace(/\s+/g, "_");
}

function nowPlusDays(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

type InboxRow = {
  id: string;
  entity_id: string | null;
  entity_slug: string | null;
  status: string | null;

  applicant_type: string | null;
  organization_legal_name: string | null;
  organization_trade_name: string | null;
  applicant_email: string | null;
  organization_email: string | null;

  request_brief?: string | null;
  intent?: string | null;
  services_label?: string | null;
  metadata?: any | null;

  created_at: string | null;
  updated_at: string | null;

  lane_is_test?: boolean | null;
};

type DecisionRow = {
  decision: string | null;
  risk_tier: string | null;
  summary: string | null;
  reason: string | null;
  created_at: string | null;
};

type Tab = "INBOX" | "INTAKE" | "ALL" | "ARCHIVED";
type LaneFilter = "BOTH" | "INTAKE" | "PROVISIONED";

type ActionModal =
  | { kind: "BEGIN_REVIEW" }
  | { kind: "NEEDS_INFO" }
  | { kind: "TASKS" }
  | { kind: "APPROVE" }
  | { kind: "ARCHIVE" }
  | { kind: "HARD_DELETE" }
  | null;

type TaskItem = {
  id: string;
  label: string;
  done: boolean;
};

function FieldLabel({ children }: { children: string }) {
  return <div className="text-[11px] uppercase tracking-[0.28em] text-white/40">{children}</div>;
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="text-xs uppercase tracking-[0.22em] text-white/35">{k}</div>
      <div
        className={cx(
          "max-w-[70%] text-right text-sm text-white/80",
          mono && "font-mono text-[12px] leading-5 text-white/70"
        )}
      >
        {v}
      </div>
    </div>
  );
}

function ModalShell({
  title,
  subtitle,
  children,
  danger,
  onClose,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  danger?: boolean;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/65 backdrop-blur-sm" onClick={onClose} />
      <div
        className={cx(
          "relative w-full max-w-[560px] overflow-hidden rounded-3xl border shadow-[0_40px_180px_rgba(0,0,0,0.70)]",
          danger ? "border-rose-300/20 bg-[#12060b]/90" : "border-white/12 bg-[#071018]/92"
        )}
      >
        <div className="border-b border-white/10 px-6 py-5">
          <div className="text-[11px] uppercase tracking-[0.28em] text-white/45">
            Authority • Action
          </div>
          <div className="mt-1 text-xl font-semibold text-white/90">{title}</div>
          {subtitle ? <div className="mt-1 text-sm text-white/55">{subtitle}</div> : null}
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

export default function CiAdmissionsPage() {
  // --- Entity / Env (defensive; NO corporate fallbacks) ---
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

  const env = useOsEnv() as any;
  const isTest: boolean = Boolean(
    env?.is_test ?? env?.isTest ?? env?.lane_is_test ?? env?.sandbox ?? env?.isSandbox
  );

  // --- Inbox ---
  const [rows, setRows] = useState<InboxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>("INBOX");
  const [laneFilter, setLaneFilter] = useState<LaneFilter>("BOTH");
  const [q, setQ] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(() => rows.find((r) => r.id === selectedId) || null, [rows, selectedId]);

  // --- Decision snapshot (audit layer) ---
  const [latestDecision, setLatestDecision] = useState<DecisionRow | null>(null);
  const [decisionErr, setDecisionErr] = useState<string | null>(null);

  // --- Modal ---
  const [modal, setModal] = useState<ActionModal>(null);
  const [busy, setBusy] = useState(false);

  const [refreshKey, setRefreshKey] = useState(0);

  // --- Needs Info (message) ---
  const [needsInfoMsg, setNeedsInfoMsg] = useState(
    "Please upload the requested incorporation and governance evidence."
  );
  const [needsInfoDueDays, setNeedsInfoDueDays] = useState(7);

  // --- Tasks (doc checklist) ---
  const defaultTasksRef = useRef<TaskItem[]>([
    { id: "incorp", label: "Articles of Incorporation (or equivalent formation document)", done: true },
    { id: "good", label: "Certificate of Status / Good Standing (recent)", done: true },
    { id: "dir", label: "Directors / Officers register (current)", done: false },
    { id: "share", label: "Share register / cap table snapshot (current)", done: false },
    { id: "res", label: "Initial organizing resolutions / bylaws / operating agreement", done: false },
    { id: "auth", label: "Authorized signer evidence (who can sign / bind)", done: false },
    { id: "id", label: "Signer identity evidence (gov ID) for primary operator", done: false },
  ]);
  const [tasks, setTasks] = useState<TaskItem[]>(() => defaultTasksRef.current);
  const [customTask, setCustomTask] = useState("");

  // --- Approve (decision) ---
  const [riskTier, setRiskTier] = useState("medium");
  const [decisionSummary, setDecisionSummary] = useState("Meets intake requirements.");
  const [decisionReason, setDecisionReason] = useState("");

  // --- Archive/Delete reasons ---
  const [archiveReason, setArchiveReason] = useState("Operator archived this application.");
  const [deleteReason, setDeleteReason] = useState("Operator hard-deleted a terminal onboarding record.");

  const appTitle = useMemo(() => {
    if (!selected) return "No application selected";
    return (
      selected.organization_trade_name ||
      selected.organization_legal_name ||
      selected.applicant_email ||
      selected.id
    );
  }, [selected]);

  // -------- load inbox (entity + lane scoped when available) --------
  useEffect(() => {
    let alive = true;

    (async () => {
      setLoading(true);
      setErr(null);

      try {
        const baseCols = [
          "id",
          "entity_id",
          "entity_slug",
          "status",
          "applicant_type",
          "organization_legal_name",
          "organization_trade_name",
          "applicant_email",
          "organization_email",
          "request_brief",
          "intent",
          "services_label",
          "metadata",
          "created_at",
          "updated_at",
        ];

        const tryWithLane = async () => {
          const { data, error } = await supabase
            .from("v_onboarding_admissions_inbox")
            .select([...baseCols, "lane_is_test"].join(","))
            .eq("entity_slug", entityKey)
            .eq("lane_is_test", isTest)
            .order("created_at", { ascending: false });

          return { data, error };
        };

        const tryWithoutLane = async () => {
          const { data, error } = await supabase
            .from("v_onboarding_admissions_inbox")
            .select(baseCols.join(","))
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

        const data = (res.data || []) as InboxRow[];
        setRows(data);

        if (!selectedId && data.length) setSelectedId(data[0].id);
        else if (selectedId && !data.some((r) => r.id === selectedId)) setSelectedId(data[0]?.id ?? null);
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

  // -------- load latest decision (audit layer) --------
  useEffect(() => {
    let alive = true;

    (async () => {
      setLatestDecision(null);
      setDecisionErr(null);
      if (!selectedId) return;

      try {
        const { data, error } = await supabase
          .from("onboarding_decisions")
          .select("decision,risk_tier,summary,reason,created_at")
          .eq("application_id", selectedId)
          .order("created_at", { ascending: false })
          .limit(1);

        if (error) throw error;
        if (!alive) return;

        setLatestDecision((data?.[0] as DecisionRow) || null);
      } catch (e: any) {
        if (!alive) return;
        // non-fatal (audit layer shouldn’t break console)
        setDecisionErr(e?.message || "Could not load decision history.");
      }
    })();

    return () => {
      alive = false;
    };
  }, [selectedId, refreshKey]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let data = rows;

    const st = (r: InboxRow) => normStatus(r.status);

    // Tab
    if (tab === "INBOX") {
      // active working set
      const hide = new Set(["ARCHIVED", "WITHDRAWN", "DECLINED"]);
      data = data.filter((r) => !hide.has(st(r)));
    } else if (tab === "INTAKE") {
      const allow = new Set(["SUBMITTED", "TRIAGE", "IN_REVIEW", "NEEDS_INFO"]);
      data = data.filter((r) => allow.has(st(r)));
    } else if (tab === "ARCHIVED") {
      data = data.filter((r) => st(r) === "ARCHIVED");
    } // ALL keeps everything

    // Lane Filter chip (UI-level)
    if (laneFilter === "INTAKE") {
      const allow = new Set(["SUBMITTED", "TRIAGE", "IN_REVIEW", "NEEDS_INFO"]);
      data = data.filter((r) => allow.has(st(r)));
    } else if (laneFilter === "PROVISIONED") {
      const allow = new Set(["APPROVED", "PROVISIONING", "PROVISIONED"]);
      data = data.filter((r) => allow.has(st(r)));
    }

    if (!needle) return data;

    return data.filter((r) => {
      const blob = [
        r.organization_legal_name,
        r.organization_trade_name,
        r.applicant_email,
        r.organization_email,
        r.status,
        r.applicant_type,
        r.id,
      ]
        .filter(Boolean)
        .join(" • ")
        .toLowerCase();
      return blob.includes(needle);
    });
  }, [rows, q, tab, laneFilter]);

  function closeModal() {
    if (busy) return;
    setModal(null);
  }

  // --- RPC helpers (NO new wiring; use existing RPCs) ---
  async function rpcBeginReview() {
    if (!selected) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc("admissions_begin_review", {
        p_application_id: selected.id,
      });
      if (error) throw error;
      setModal(null);
      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "Begin Review failed.");
    } finally {
      setBusy(false);
    }
  }

  async function rpcNeedsInfo() {
    if (!selected) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc("admissions_request_info", {
        p_application_id: selected.id,
        p_message: needsInfoMsg,
        p_channels: ["email"],
        p_due_at: new Date(nowPlusDays(Math.max(1, Number(needsInfoDueDays) || 7))),
        p_next_status: "needs_info", // enum in prod is lowercase
      });
      if (error) throw error;
      setModal(null);
      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "Needs Info failed.");
    } finally {
      setBusy(false);
    }
  }

  async function rpcCreateTasks() {
    if (!selected) return;
    setBusy(true);
    try {
      const cleaned = tasks
        .map((t) => ({ id: t.id, label: t.label, required: true, checked: t.done }))
        .filter((t) => t.label.trim().length > 0);

      // JSONB payload; keep stable shape for auditability
      const payload = {
        checklist: cleaned,
        created_from: "ci-admissions",
        note: "Document checklist tasks created by operator.",
      };

      const { error } = await supabase.rpc("admissions_create_provisioning_tasks", {
        p_application_id: selected.id,
        p_tasks: payload,
      });
      if (error) throw error;

      setModal(null);
      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "Create Tasks failed.");
    } finally {
      setBusy(false);
    }
  }

  async function rpcApproveDecision() {
    if (!selected) return;
    setBusy(true);
    try {
      // ✅ Decision layer for audit (onboarding_decisions)
      // Use SAFE wrapper (text) so we don’t fight enum casing in UI.
      const { error: e1 } = await supabase.rpc("admissions_record_decision_safe", {
        p_application_id: selected.id,
        p_risk_tier_text: String(riskTier || "medium"),
        p_decision_text: "approved",
        p_summary: decisionSummary || "Meets intake requirements.",
        p_reason: decisionReason || "",
      });
      if (e1) throw e1;

      // ✅ Status flip (this is what you’re missing right now)
      // Status enum in prod is lowercase (approved/provisioning/etc.)
      const { error: e2 } = await supabase.rpc("admissions_set_status_enum", {
        p_application_id: selected.id,
        p_next_status: "approved",
        p_note: "Approved for provisioning.",
      });
      if (e2) throw e2;

      setModal(null);
      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "Approve failed.");
    } finally {
      setBusy(false);
    }
  }

  async function rpcArchiveSoft() {
    if (!selected) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc("admissions_archive_application", {
        p_application_id: selected.id,
        p_reason: archiveReason || "Operator archived.",
      });
      if (error) throw error;
      setModal(null);
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
    try {
      // You have both delete variants in your function inventory; hard delete is terminal-only by design.
      const { error } = await supabase.rpc("admissions_hard_delete_application", {
        p_application_id: selected.id,
        p_reason: deleteReason || "Operator hard delete.",
      });
      if (error) throw error;

      setModal(null);
      // after delete, refresh list
      setSelectedId(null);
      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "Hard delete failed.");
    } finally {
      setBusy(false);
    }
  }

  // --- Derived banner: decision recorded but status didn’t flip (for visibility) ---
  const statusNorm = normStatus(selected?.status);
  const decisionNorm = normStatus(latestDecision?.decision);
  const showsDecisionMismatch =
    !!selected &&
    !!latestDecision &&
    decisionNorm === "APPROVED" &&
    statusNorm !== "APPROVED" &&
    statusNorm !== "PROVISIONING" &&
    statusNorm !== "PROVISIONED";

  return (
    <div className="h-full w-full">
      <div className="mx-auto w-full max-w-[1400px] px-4 pb-10 pt-6">
        <div className="mb-5 flex items-end justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.28em] text-white/45">CI • Admissions</div>
            <div className="mt-1 text-2xl font-semibold text-white/90">Admissions Console</div>
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
          {/* Left: Inbox */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-semibold tracking-wide text-white/80">Inbox</div>

                  <div className="flex gap-2">
                    {(["INBOX", "INTAKE", "ALL", "ARCHIVED"] as Tab[]).map((t) => (
                      <button
                        key={t}
                        onClick={() => setTab(t)}
                        className={cx(
                          "rounded-full px-3 py-1 text-[11px] font-medium",
                          tab === t
                            ? "bg-white/8 text-white/85 ring-1 ring-white/12"
                            : "text-white/55 hover:text-white/75"
                        )}
                      >
                        {t === "INBOX" ? "Inbox" : t === "INTAKE" ? "Intake" : t === "ALL" ? "All" : "Archived"}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  {(["BOTH", "INTAKE", "PROVISIONED"] as LaneFilter[]).map((f) => (
                    <button
                      key={f}
                      onClick={() => setLaneFilter(f)}
                      className={cx(
                        "rounded-full px-3 py-1 text-[11px] font-medium",
                        laneFilter === f
                          ? "bg-emerald-400/10 text-emerald-200 ring-1 ring-emerald-300/20"
                          : "text-white/55 hover:text-white/75"
                      )}
                    >
                      {f}
                    </button>
                  ))}
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
                      const name = r.organization_trade_name || r.organization_legal_name || r.applicant_email || r.id;
                      const status = r.status || "—";
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
                              <div className="truncate text-sm font-semibold text-white/88">{name}</div>
                              <div className="mt-1 truncate text-xs text-white/45">
                                {r.applicant_email || r.organization_email || "—"}
                              </div>
                            </div>
                            <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-medium text-white/70">
                              {status}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="border-t border-white/10 p-4 text-[11px] text-white/40">
                Lane note: UI is lane-aware via OS env. Query is lane-filtered only if the view exposes lane columns.
              </div>
            </div>
          </div>

          {/* Middle: Application */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="text-xs font-semibold tracking-wide text-white/80">Application</div>
                <div className="mt-1 truncate text-sm text-white/60">
                  {selected ? appTitle : "Select an application"}
                </div>
              </div>

              <div className="p-4">
                {!selected ? (
                  <div className="text-sm text-white/50">Select an application to review.</div>
                ) : (
                  <>
                    {showsDecisionMismatch ? (
                      <div className="mb-4 rounded-2xl border border-amber-300/20 bg-amber-400/10 p-4">
                        <div className="text-sm font-semibold text-amber-200">
                          Decision recorded • status not flipped
                        </div>
                        <div className="mt-1 text-xs text-white/60">
                          Latest decision is <span className="text-white/80">APPROVED</span>, but application status
                          remains <span className="text-white/80">{selected.status || "—"}</span>. Use{" "}
                          <span className="text-white/80">Approve (Decision)</span> again or set status via authority
                          action (RPC-only).
                        </div>
                      </div>
                    ) : null}

                    <div className="space-y-3 rounded-2xl border border-white/10 bg-black/20 p-4">
                      <KV k="Org (Legal)" v={selected.organization_legal_name || "—"} />
                      <KV k="Org (Trade)" v={selected.organization_trade_name || "—"} />
                      <KV k="Applicant" v={selected.applicant_email || "—"} />
                      <KV k="Status" v={selected.status || "—"} />
                      <KV k="App ID" v={selected.id} mono />
                      <KV k="Created" v={selected.created_at || "—"} />
                      <KV k="Updated" v={selected.updated_at || "—"} />
                    </div>

                    <div className="mt-4 rounded-2xl border border-white/10 bg-black/18 p-4">
                      <FieldLabel>Request / Intent</FieldLabel>
                      <div className="mt-2 text-sm text-white/75">
                        {selected.request_brief || selected.intent || "—"}
                      </div>

                      {selected.services_label ? (
                        <div className="mt-2 text-xs text-white/45">
                          Requested services:{" "}
                          <span className="text-white/70">{selected.services_label}</span>
                        </div>
                      ) : null}
                    </div>

                    <div className="mt-4 rounded-2xl border border-white/10 bg-black/18 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <FieldLabel>Decision (audit)</FieldLabel>
                          <div className="mt-2 text-sm text-white/75">
                            {latestDecision ? (
                              <>
                                <span className="text-white/90 font-semibold">
                                  {latestDecision.decision || "—"}
                                </span>
                                {latestDecision.risk_tier ? (
                                  <span className="ml-2 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-white/70">
                                    {latestDecision.risk_tier}
                                  </span>
                                ) : null}
                              </>
                            ) : (
                              "No decision recorded yet."
                            )}
                          </div>
                          {latestDecision?.summary ? (
                            <div className="mt-2 text-xs text-white/55">{latestDecision.summary}</div>
                          ) : null}
                          {latestDecision?.reason ? (
                            <div className="mt-2 text-xs text-white/45">{latestDecision.reason}</div>
                          ) : null}
                          {decisionErr ? <div className="mt-2 text-xs text-rose-200">{decisionErr}</div> : null}
                        </div>

                        <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] text-white/60">
                          RPC-only
                        </div>
                      </div>
                    </div>

                    <div className="mt-4 text-xs text-white/40">
                      (No raw JSON panel here — keeping the operator surface calm.)
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Right: Authority Panel */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="text-xs font-semibold tracking-wide text-white/80">Authority Panel</div>
                <div className="mt-1 text-sm text-white/55">Review • Requests • Tasks • Decisions</div>
              </div>

              <div className="p-4">
                {!selected ? (
                  <div className="text-sm text-white/50">Select an application to access authority actions.</div>
                ) : (
                  <>
                    <div className="space-y-2">
                      <button
                        onClick={() => setModal({ kind: "BEGIN_REVIEW" })}
                        className="w-full rounded-2xl border border-emerald-300/18 bg-emerald-500/10 px-4 py-3 text-sm font-semibold text-emerald-100 hover:bg-emerald-500/14"
                      >
                        Begin Review
                      </button>

                      <button
                        onClick={() => {
                          setTasks(defaultTasksRef.current.map((t) => ({ ...t })));
                          setCustomTask("");
                          setModal({ kind: "TASKS" });
                        }}
                        className="w-full rounded-2xl border border-amber-300/14 bg-amber-400/10 px-4 py-3 text-sm font-semibold text-amber-100 hover:bg-amber-400/14"
                      >
                        Request Documents (Tasks)
                      </button>

                      <button
                        onClick={() => setModal({ kind: "NEEDS_INFO" })}
                        className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-semibold text-white/85 hover:border-white/16 hover:bg-white/7"
                      >
                        Needs Info (Message)
                      </button>

                      <button
                        onClick={() => setModal({ kind: "APPROVE" })}
                        className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-semibold text-white/85 hover:border-white/16 hover:bg-white/7"
                      >
                        Approve (Decision)
                      </button>

                      <button
                        onClick={() => setModal({ kind: "ARCHIVE" })}
                        className="w-full rounded-2xl border border-white/10 bg-white/4 px-4 py-3 text-sm font-semibold text-white/75 hover:border-white/16 hover:bg-white/6"
                      >
                        Archive (soft)
                      </button>

                      <button
                        onClick={() => setModal({ kind: "HARD_DELETE" })}
                        className="w-full rounded-2xl border border-rose-300/18 bg-rose-500/10 px-4 py-3 text-sm font-semibold text-rose-100 hover:bg-rose-500/14"
                      >
                        Hard Delete
                      </button>
                    </div>

                    <div className="mt-4 rounded-2xl border border-white/10 bg-black/18 p-4 text-xs text-white/50">
                      <div className="text-white/70 font-semibold">Contract</div>
                      <div className="mt-2">
                        Tasks feed client portal evidence. Mutations are RPC-only. Lane is read from OS env; inbox is
                        lane-filtered when the view exposes lane columns.
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

      {/* --- Modals --- */}
      {modal?.kind === "BEGIN_REVIEW" && selected ? (
        <ModalShell title="Begin review" subtitle={appTitle} onClose={closeModal}>
          <div className="rounded-2xl border border-emerald-300/15 bg-emerald-500/10 p-4 text-sm text-emerald-100">
            This moves the application into <span className="font-semibold">IN_REVIEW</span> (RPC-only).
          </div>

          <div className="mt-5 flex items-center justify-end gap-2">
            <button
              onClick={closeModal}
              className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs font-semibold text-white/75 hover:bg-white/7"
            >
              Cancel
            </button>
            <button
              disabled={busy}
              onClick={rpcBeginReview}
              className={cx(
                "rounded-full border border-emerald-300/18 bg-emerald-500/12 px-4 py-2 text-xs font-semibold text-emerald-100",
                busy && "opacity-60"
              )}
            >
              {busy ? "Working…" : "Begin Review"}
            </button>
          </div>
        </ModalShell>
      ) : null}

      {modal?.kind === "NEEDS_INFO" && selected ? (
        <ModalShell title="Needs info" subtitle={appTitle} onClose={closeModal}>
          <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
            <FieldLabel>Message</FieldLabel>
            <textarea
              value={needsInfoMsg}
              onChange={(e) => setNeedsInfoMsg(e.target.value)}
              rows={4}
              className="mt-2 w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white/85 placeholder:text-white/35 outline-none focus:border-amber-300/25"
              placeholder="What do you need from the applicant?"
            />

            <div className="mt-3 flex items-center gap-3">
              <div className="flex-1">
                <FieldLabel>Due (days)</FieldLabel>
                <input
                  value={String(needsInfoDueDays)}
                  onChange={(e) => setNeedsInfoDueDays(Number(e.target.value || 7))}
                  className="mt-2 w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-2 text-sm text-white/85 outline-none focus:border-amber-300/25"
                />
              </div>
              <div className="flex-1">
                <FieldLabel>Channel</FieldLabel>
                <div className="mt-2 rounded-2xl border border-white/10 bg-black/25 px-4 py-2 text-sm text-white/70">
                  email
                </div>
              </div>
            </div>
          </div>

          <div className="mt-5 flex items-center justify-end gap-2">
            <button
              onClick={closeModal}
              className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs font-semibold text-white/75 hover:bg-white/7"
            >
              Cancel
            </button>
            <button
              disabled={busy}
              onClick={rpcNeedsInfo}
              className={cx(
                "rounded-full border border-white/12 bg-white/8 px-4 py-2 text-xs font-semibold text-white/85 hover:bg-white/10",
                busy && "opacity-60"
              )}
            >
              {busy ? "Working…" : "Send Needs Info"}
            </button>
          </div>
        </ModalShell>
      ) : null}

      {modal?.kind === "TASKS" && selected ? (
        <ModalShell title="Request documents (tasks)" subtitle={appTitle} onClose={closeModal}>
          <div className="rounded-2xl border border-amber-300/12 bg-amber-400/10 p-4 text-sm text-amber-100">
            This creates a checklist task payload for provisioning/evidence. (RPC-only)
          </div>

          <div className="mt-4 rounded-2xl border border-white/10 bg-black/25 p-4">
            <FieldLabel>Checklist</FieldLabel>
            <div className="mt-3 space-y-2">
              {tasks.map((t) => (
                <label
                  key={t.id}
                  className="flex cursor-pointer items-center justify-between gap-3 rounded-2xl border border-white/10 bg-black/15 px-4 py-3 hover:border-white/14"
                >
                  <div className="text-sm text-white/80">{t.label}</div>
                  <input
                    type="checkbox"
                    checked={t.done}
                    onChange={(e) =>
                      setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, done: e.target.checked } : x)))
                    }
                    className="h-4 w-4 accent-amber-300"
                  />
                </label>
              ))}
            </div>

            <div className="mt-4 flex items-center gap-2">
              <input
                value={customTask}
                onChange={(e) => setCustomTask(e.target.value)}
                placeholder="Add custom checklist item…"
                className="flex-1 rounded-2xl border border-white/10 bg-black/25 px-4 py-2 text-sm text-white/85 placeholder:text-white/35 outline-none focus:border-amber-300/25"
              />
              <button
                onClick={() => {
                  const v = customTask.trim();
                  if (!v) return;
                  setTasks((prev) => [
                    { id: `custom_${Date.now()}`, label: v, done: false },
                    ...prev,
                  ]);
                  setCustomTask("");
                }}
                className="rounded-2xl border border-white/10 bg-white/5 px-4 py-2 text-xs font-semibold text-white/80 hover:bg-white/7"
              >
                Add
              </button>
            </div>
          </div>

          <div className="mt-5 flex items-center justify-end gap-2">
            <button
              onClick={closeModal}
              className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs font-semibold text-white/75 hover:bg-white/7"
            >
              Cancel
            </button>
            <button
              disabled={busy}
              onClick={rpcCreateTasks}
              className={cx(
                "rounded-full border border-amber-300/16 bg-amber-400/12 px-4 py-2 text-xs font-semibold text-amber-100 hover:bg-amber-400/14",
                busy && "opacity-60"
              )}
            >
              {busy ? "Working…" : "Create Tasks"}
            </button>
          </div>
        </ModalShell>
      ) : null}

      {modal?.kind === "APPROVE" && selected ? (
        <ModalShell title="Approve (decision)" subtitle={appTitle} onClose={closeModal}>
          <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
            <FieldLabel>Decision</FieldLabel>
            <div className="mt-2 text-sm text-white/75">
              This writes an auditable decision record and flips application status to{" "}
              <span className="text-white/90 font-semibold">APPROVED</span>.
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3">
              <div>
                <FieldLabel>Risk tier</FieldLabel>
                <select
                  value={riskTier}
                  onChange={(e) => setRiskTier(e.target.value)}
                  className="mt-2 w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-2 text-sm text-white/85 outline-none focus:border-amber-300/25"
                >
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </select>
              </div>
              <div>
                <FieldLabel>Decision</FieldLabel>
                <div className="mt-2 rounded-2xl border border-white/10 bg-black/25 px-4 py-2 text-sm text-white/70">
                  approved
                </div>
              </div>
            </div>

            <div className="mt-4">
              <FieldLabel>Summary</FieldLabel>
              <input
                value={decisionSummary}
                onChange={(e) => setDecisionSummary(e.target.value)}
                className="mt-2 w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-2 text-sm text-white/85 outline-none focus:border-amber-300/25"
                placeholder="Short decision summary for audit."
              />
            </div>

            <div className="mt-4">
              <FieldLabel>Reason (optional)</FieldLabel>
              <textarea
                value={decisionReason}
                onChange={(e) => setDecisionReason(e.target.value)}
                rows={3}
                className="mt-2 w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white/85 outline-none focus:border-amber-300/25"
                placeholder="Optional rationale."
              />
            </div>
          </div>

          <div className="mt-5 flex items-center justify-end gap-2">
            <button
              onClick={closeModal}
              className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs font-semibold text-white/75 hover:bg-white/7"
            >
              Cancel
            </button>
            <button
              disabled={busy}
              onClick={rpcApproveDecision}
              className={cx(
                "rounded-full border border-white/12 bg-white/8 px-4 py-2 text-xs font-semibold text-white/90 hover:bg-white/10",
                busy && "opacity-60"
              )}
            >
              {busy ? "Working…" : "Approve"}
            </button>
          </div>
        </ModalShell>
      ) : null}

      {modal?.kind === "ARCHIVE" && selected ? (
        <ModalShell title="Archive (soft)" subtitle={appTitle} onClose={closeModal}>
          <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
            <div className="text-sm text-white/75">
              Soft archive moves the record to <span className="text-white/90 font-semibold">ARCHIVED</span> and keeps
              audit history. (RPC-only)
            </div>

            <div className="mt-4">
              <FieldLabel>Reason</FieldLabel>
              <textarea
                value={archiveReason}
                onChange={(e) => setArchiveReason(e.target.value)}
                rows={3}
                className="mt-2 w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white/85 outline-none focus:border-amber-300/25"
              />
            </div>
          </div>

          <div className="mt-5 flex items-center justify-end gap-2">
            <button
              onClick={closeModal}
              className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs font-semibold text-white/75 hover:bg-white/7"
            >
              Cancel
            </button>
            <button
              disabled={busy}
              onClick={rpcArchiveSoft}
              className={cx(
                "rounded-full border border-white/12 bg-white/8 px-4 py-2 text-xs font-semibold text-white/85 hover:bg-white/10",
                busy && "opacity-60"
              )}
            >
              {busy ? "Working…" : "Archive"}
            </button>
          </div>
        </ModalShell>
      ) : null}

      {modal?.kind === "HARD_DELETE" && selected ? (
        <ModalShell title="Hard delete" subtitle={appTitle} danger onClose={closeModal}>
          <div className="rounded-2xl border border-rose-300/18 bg-rose-500/12 p-4 text-sm text-rose-100">
            Hard delete is operator-only and intended for terminal statuses (DECLINED / WITHDRAWN / ARCHIVED).
            This action is irreversible.
          </div>

          <div className="mt-4 rounded-2xl border border-white/10 bg-black/25 p-4">
            <FieldLabel>Reason</FieldLabel>
            <textarea
              value={deleteReason}
              onChange={(e) => setDeleteReason(e.target.value)}
              rows={3}
              className="mt-2 w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white/85 outline-none focus:border-rose-300/25"
            />
          </div>

          <div className="mt-5 flex items-center justify-end gap-2">
            <button
              onClick={closeModal}
              className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs font-semibold text-white/75 hover:bg-white/7"
            >
              Cancel
            </button>
            <button
              disabled={busy}
              onClick={rpcHardDelete}
              className={cx(
                "rounded-full border border-rose-300/18 bg-rose-500/14 px-4 py-2 text-xs font-semibold text-rose-100 hover:bg-rose-500/18",
                busy && "opacity-60"
              )}
            >
              {busy ? "Working…" : "Delete permanently"}
            </button>
          </div>
        </ModalShell>
      ) : null}
    </div>
  );
}
