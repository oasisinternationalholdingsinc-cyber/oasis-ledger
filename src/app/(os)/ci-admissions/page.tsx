// src/app/(os)/ci-admissions/page.tsx
"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";

type StatusTab = "ALL" | string;

type ApplicationRow = {
  id: string;

  // core
  status: string | null;
  applicant_type: string | null;
  applicant_name: string | null;
  applicant_email: string | null;
  applicant_phone: string | null;

  organization_legal_name: string | null;
  organization_trade_name: string | null;

  jurisdiction_country: string | null;
  jurisdiction_region: string | null;
  incorporation_number: string | null;
  website: string | null;

  intent: string | null;
  requested_services: string[] | null;
  expected_start_date: string | null;

  risk_tier: string | null;
  risk_notes: string | null;

  submitted_at: string | null;
  triaged_at: string | null;
  decided_at: string | null;
  provisioned_at: string | null;

  created_by: string | null;
  assigned_to: string | null;
  decided_by: string | null;

  entity_id: string | null;
  entity_slug: string | null;

  primary_contact_user_id: string | null;
  metadata: any | null;

  created_at: string | null;
  updated_at: string | null;
};

type DecisionRow = {
  id: string;
  application_id: string;
  decision: string | null;
  summary: string | null;
  conditions: string | null;
  decided_by: string | null;
  decided_at: string | null;
  metadata: any | null;
};

type EventRow = {
  id: string;
  application_id: string;
  event_type: string | null;
  message: string | null;
  actor_id: string | null;
  context: any | null;
  created_at: string | null;
};

type TaskRow = {
  id: string;
  application_id: string;
  task_key: string | null;
  status: string | null;
  attempts: number | null;
  result: any | null;
  last_error: string | null;
  created_at: string | null;
  updated_at: string | null;
};

const ENTITY_LABELS: Record<string, string> = {
  holdings: "Oasis International Holdings Inc.",
  lounge: "Oasis International Lounge Inc.",
  "real-estate": "Oasis International Real Estate Inc.",
};

const STATUS_ORDER = [
  "ALL",
  "DRAFT",
  "SUBMITTED",
  "TRIAGE",
  "IN_REVIEW",
  "NEEDS_INFO",
  "APPROVED",
  "DECLINED",
  "WITHDRAWN",
  "PROVISIONING",
  "PROVISIONED",
  "ARCHIVED",
] as const;

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

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function hashShort(x?: string | null) {
  const s = (x ?? "").trim();
  if (!s) return "—";
  if (s.length <= 16) return s;
  return `${s.slice(0, 10)}…${s.slice(-6)}`;
}

function isMissingColumnErr(err: unknown) {
  const msg = String((err as any)?.message ?? "").toLowerCase();
  return msg.includes("does not exist") && msg.includes("column");
}

async function rpcFirstOk<T = any>(fn: string, shapes: Array<Record<string, any>>): Promise<T> {
  let lastErr: any = null;
  for (const params of shapes) {
    const { data, error } = await supabase.rpc(fn as any, params as any);
    if (!error) {
      const ok = (data as any)?.ok;
      if (ok === false) throw new Error((data as any)?.error ?? "RPC failed.");
      return data as T;
    }
    lastErr = error;
  }
  throw lastErr ?? new Error("RPC failed.");
}

function statusPill(st?: string | null) {
  const s = (st ?? "").toUpperCase();
  if (s.includes("APPROV")) return "bg-emerald-500/15 text-emerald-200 border-emerald-400/40";
  if (s.includes("DECLIN") || s.includes("REJECT")) return "bg-rose-500/15 text-rose-200 border-rose-400/40";
  if (s.includes("ARCHIV")) return "bg-slate-700/30 text-slate-200 border-slate-600/40";
  if (s.includes("NEED") || s.includes("INFO")) return "bg-amber-500/15 text-amber-200 border-amber-400/40";
  if (s.includes("PROVISION")) return "bg-sky-500/15 text-sky-200 border-sky-400/40";
  if (s.includes("TRIAG")) return "bg-indigo-500/15 text-indigo-200 border-indigo-400/40";
  if (s.includes("SUBMIT")) return "bg-slate-700/30 text-slate-200 border-slate-600/40";
  return "bg-slate-700/25 text-slate-200 border-slate-600/40";
}

function safeArray(x: any): string[] {
  if (!x) return [];
  if (Array.isArray(x)) return x.map(String);
  return [];
}

export default function CIAdmissionsPage() {
  const entityCtx = useEntity() as any;
  useOsEnv(); // kept for OS consistency (even if admissions ignores is_test)

  const activeEntitySlug = (entityCtx?.activeEntity as string) || "holdings";
  const activeEntityLabel = useMemo(
    () => ENTITY_LABELS[activeEntitySlug] ?? activeEntitySlug,
    [activeEntitySlug]
  );

  const [entityId, setEntityId] = useState<string | null>((entityCtx?.activeEntityId as string) || null);

  // UI state
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | "status" | "decision" | "info" | "tasks" | "delete">(null);

  const [drawerOpen, setDrawerOpen] = useState(true);
  const [tab, setTab] = useState<StatusTab>("ALL");
  const [query, setQuery] = useState("");

  const [apps, setApps] = useState<ApplicationRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // detail rails
  const [events, setEvents] = useState<EventRow[]>([]);
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);

  // action drafts
  const [decisionKind, setDecisionKind] = useState<string>("APPROVED");
  const [decisionSummary, setDecisionSummary] = useState<string>("");
  const [decisionConditions, setDecisionConditions] = useState<string>("");
  const [riskTier, setRiskTier] = useState<string>("");
  const [riskNotes, setRiskNotes] = useState<string>("");

  const [requestInfoMsg, setRequestInfoMsg] = useState<string>("");
  const [requestInfoFields, setRequestInfoFields] = useState<string>(""); // JSON string

  const [tasksJson, setTasksJson] = useState<string>(
    JSON.stringify(
      {
        tasks: [
          { task_key: "create_entity_profile", notes: "Create internal entity profile + scoping." },
          { task_key: "assign_operator", notes: "Assign admissions owner + reviewer." },
          { task_key: "provision_portal_access", notes: "Provision portal routing / invite." },
          { task_key: "collect_evidence", notes: "Request incorporation proof + registry contact." },
        ],
      },
      null,
      2
    )
  );

  // Delete modal
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteReason, setDeleteReason] = useState("");
  const [deleteConfirmText, setDeleteConfirmText] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const lastAutoPickRef = useRef<string | null>(null);

  function flashError(msg: string) {
    console.error(msg);
    setError(msg);
    setTimeout(() => setError(null), 7000);
  }
  function flashInfo(msg: string) {
    setInfo(msg);
    setTimeout(() => setInfo(null), 3500);
  }

  const selected = useMemo(() => apps.find((a) => a.id === selectedId) ?? null, [apps, selectedId]);

  async function ensureEntityId(slug: string) {
    if (entityId) return entityId;

    const ctxId = (entityCtx?.activeEntityId as string) || null;
    if (ctxId) {
      setEntityId(ctxId);
      return ctxId;
    }

    const { data, error } = await supabase.from("entities").select("id, slug").eq("slug", slug).single();
    if (error || !data?.id) throw error ?? new Error("Entity lookup failed.");
    setEntityId(data.id);
    return data.id as string;
  }

  async function reload(preserveSelection = true) {
    setLoading(true);
    setError(null);

    try {
      const eid = await ensureEntityId(activeEntitySlug);

      const baseSelect =
        "id,status,applicant_type,applicant_name,applicant_email,applicant_phone,organization_legal_name,organization_trade_name,jurisdiction_country,jurisdiction_region,incorporation_number,website,intent,requested_services,expected_start_date,risk_tier,risk_notes,submitted_at,triaged_at,decided_at,provisioned_at,created_by,assigned_to,decided_by,entity_id,entity_slug,primary_contact_user_id,metadata,created_at,updated_at";

      const tryByEntityId = async () => {
        const { data, error } = await supabase
          .from("v_onboarding_admissions_inbox")
          .select(baseSelect)
          .eq("entity_id", eid)
          .order("created_at", { ascending: false });
        if (error) throw error;
        return (data ?? []) as ApplicationRow[];
      };

      const tryByEntitySlug = async () => {
        const { data, error } = await supabase
          .from("onboarding_applications")
          .select(baseSelect)
          .eq("entity_slug", activeEntitySlug)
          .order("created_at", { ascending: false });
        if (error) throw error;
        return (data ?? []) as ApplicationRow[];
      };

      let rows: ApplicationRow[] = [];
      try {
        rows = await tryByEntityId();
        if (rows.length === 0) rows = await tryByEntitySlug();
      } catch (e: any) {
        if (isMissingColumnErr(e)) rows = await tryByEntitySlug();
        else rows = await tryByEntitySlug();
      }

      setApps(rows);

      if (preserveSelection && selectedId) {
        const still = rows.find((r) => r.id === selectedId);
        if (still) {
          await loadRelated(selectedId);
          return;
        }
      }

      const filteredByTab =
        tab === "ALL"
          ? rows
          : rows.filter((r) => (r.status ?? "").toUpperCase() === String(tab).toUpperCase());

      const pick = filteredByTab[0] ?? rows[0] ?? null;
      if (pick) {
        if (lastAutoPickRef.current !== pick.id) {
          lastAutoPickRef.current = pick.id;
          setSelectedId(pick.id);
          await loadRelated(pick.id);
        }
      } else {
        setSelectedId(null);
        setEvents([]);
        setDecisions([]);
        setTasks([]);
      }
    } catch (e: any) {
      flashError(e?.message ?? "Failed to load admissions queue.");
    } finally {
      setLoading(false);
    }
  }

  async function loadRelated(applicationId: string) {
    try {
      const [ev, de, tk] = await Promise.all([
        supabase
          .from("onboarding_events")
          .select("id,application_id,event_type,message,actor_id,context,created_at")
          .eq("application_id", applicationId)
          .order("created_at", { ascending: false })
          .limit(100),

        supabase
          .from("onboarding_decisions")
          .select("id,application_id,decision,summary,conditions,decided_by,decided_at,metadata")
          .eq("application_id", applicationId)
          .order("decided_at", { ascending: false })
          .limit(20),

        supabase
          .from("onboarding_provisioning_tasks")
          .select("id,application_id,task_key,status,attempts,result,last_error,created_at,updated_at")
          .eq("application_id", applicationId)
          .order("created_at", { ascending: false })
          .limit(50),
      ]);

      if (ev.error) throw ev.error;
      if (de.error) throw de.error;
      if (tk.error) throw tk.error;

      setEvents((ev.data ?? []) as EventRow[]);
      setDecisions((de.data ?? []) as DecisionRow[]);
      setTasks((tk.data ?? []) as TaskRow[]);
    } catch (e: any) {
      console.warn("Admissions related-load warning:", e?.message ?? e);
    }
  }

  // Tabs: stable order + always include ARCHIVED
  const statusTabs = useMemo(() => {
    const present = new Set<string>();
    for (const a of apps) {
      const s = (a.status ?? "").trim();
      if (s) present.add(s.toUpperCase());
    }

    const ordered = STATUS_ORDER.filter((s) => s === "ALL" || present.has(s) || s === "ARCHIVED");
    // also include any weird/unknown statuses at end (rare)
    const extras = Array.from(present)
      .filter((s) => !STATUS_ORDER.includes(s as any))
      .sort((a, b) => a.localeCompare(b));

    return [...ordered, ...extras] as StatusTab[];
  }, [apps]);

  const filtered = useMemo(() => {
    let list = apps;

    if (tab !== "ALL") {
      const want = String(tab).toUpperCase();
      list = list.filter((a) => (a.status ?? "").toUpperCase() === want);
    }

    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter((a) => {
        const hay = [
          a.applicant_name,
          a.applicant_email,
          a.organization_legal_name,
          a.organization_trade_name,
          a.intent,
          (a.requested_services ?? []).join(", "),
        ]
          .filter(Boolean)
          .join("\n")
          .toLowerCase();
        return hay.includes(q);
      });
    }

    return list;
  }, [apps, tab, query]);

  function handleSelect(a: ApplicationRow) {
    setSelectedId(a.id);
    setError(null);
    setInfo(null);

    setRiskTier((a.risk_tier ?? "").toString());
    setRiskNotes((a.risk_notes ?? "").toString());
    setDecisionSummary("");
    setDecisionConditions("");
    setRequestInfoMsg("");
    setRequestInfoFields("");

    void loadRelated(a.id);
  }

  // ---- RPC actions (NO RAW UPDATES) ----
  async function setAdmissionsStatus(nextStatus: string) {
    if (!selected?.id) return flashError("Select an application first.");
    setBusy("status");
    setError(null);
    setInfo(null);

    try {
      const appId = selected.id;

      const shapes = [
        { p_application_id: appId, p_next_status: nextStatus },
        { application_id: appId, next_status: nextStatus },
        { p_application_id: appId, p_status: nextStatus },
        { application_id: appId, status: nextStatus },
        { p_application_id: appId, p_next_status: nextStatus, p_note: "Admissions status update" },
        { application_id: appId, next_status: nextStatus, note: "Admissions status update" },
      ];

      await rpcFirstOk("admissions_set_status", shapes);

      flashInfo(`Admissions: status → ${nextStatus}.`);
      await reload(true);
    } catch (e: any) {
      flashError(e?.message ?? "Failed to set status (RPC).");
    } finally {
      setBusy(null);
    }
  }

  async function recordDecision() {
    if (!selected?.id) return flashError("Select an application first.");
    setBusy("decision");
    setError(null);
    setInfo(null);

    try {
      const appId = selected.id;

      const decision = decisionKind.trim() || "APPROVED";
      const summary = decisionSummary.trim();
      const conditions = decisionConditions.trim();
      const rt = riskTier.trim() || null;
      const rn = riskNotes.trim() || null;

      const shapes = [
        { p_application_id: appId, p_decision: decision, p_summary: summary, p_conditions: conditions, p_risk_tier: rt, p_risk_notes: rn },
        { application_id: appId, decision, summary, conditions, risk_tier: rt, risk_notes: rn },
        { p_application_id: appId, p_decision: decision, p_summary: summary, p_conditions: conditions },
        { application_id: appId, decision, summary, conditions },
      ];

      await rpcFirstOk("admissions_record_decision", shapes);

      flashInfo(`Decision recorded: ${decision}.`);
      await reload(true);
      await loadRelated(appId);
    } catch (e: any) {
      flashError(e?.message ?? "Failed to record decision (RPC).");
    } finally {
      setBusy(null);
    }
  }

  async function requestInfo() {
    if (!selected?.id) return flashError("Select an application first.");
    const msg = requestInfoMsg.trim();
    if (!msg) return flashError("Write a message for the information request.");
    setBusy("info");
    setError(null);
    setInfo(null);

    try {
      const appId = selected.id;

      let fields: any = null;
      const raw = requestInfoFields.trim();
      if (raw) {
        try {
          fields = JSON.parse(raw);
        } catch {
          return flashError("Request fields must be valid JSON (or empty).");
        }
      }

      const shapes = [
        { p_application_id: appId, p_message: msg, p_fields: fields },
        { application_id: appId, message: msg, fields },
        { p_application_id: appId, p_message: msg },
        { application_id: appId, message: msg },
      ];

      await rpcFirstOk("admissions_request_info", shapes);

      flashInfo("Information request recorded.");
      setRequestInfoMsg("");
      await loadRelated(appId);
      await reload(true);
    } catch (e: any) {
      flashError(e?.message ?? "Failed to request info (RPC).");
    } finally {
      setBusy(null);
    }
  }

  async function createProvisioningTasks() {
    if (!selected?.id) return flashError("Select an application first.");
    setBusy("tasks");
    setError(null);
    setInfo(null);

    try {
      const appId = selected.id;

      let payload: any = null;
      try {
        payload = JSON.parse(tasksJson);
      } catch {
        return flashError("Provisioning payload must be valid JSON.");
      }

      const shapes = [
        { p_application_id: appId, p_tasks: payload },
        { application_id: appId, tasks: payload },
        { p_application_id: appId, p_payload: payload },
        { application_id: appId, payload },
        { p_application_id: appId, p_tasks_json: payload },
      ];

      await rpcFirstOk("admissions_create_provisioning_tasks", shapes);

      flashInfo("Provisioning tasks created.");
      await loadRelated(appId);
      await reload(true);
    } catch (e: any) {
      flashError(e?.message ?? "Failed to create provisioning tasks (RPC).");
    } finally {
      setBusy(null);
    }
  }

  async function hardDeleteSelected() {
    if (!selected?.id) return flashError("Select an application first.");
    setBusy("delete");
    setError(null);
    setInfo(null);

    try {
      const appId = selected.id;

      const shapes = [
        { p_application_id: appId, p_reason: deleteReason.trim() || null },
        { application_id: appId, reason: deleteReason.trim() || null },
      ];

      await rpcFirstOk("admissions_delete_application", shapes);

      flashInfo("Application hard-deleted (tombstoned).");
      setDeleteOpen(false);
      setDeleteReason("");
      setDeleteConfirmText("");
      setSelectedId(null);
      await reload(false);
    } catch (e: any) {
      flashError(e?.message ?? "Failed to hard delete (RPC).");
    } finally {
      setBusy(null);
    }
  }

  // Boot + entity switch
  useEffect(() => {
    setTab("ALL");
    setQuery("");
    setSelectedId(null);
    setEvents([]);
    setDecisions([]);
    setTasks([]);
    void reload(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEntitySlug]);

  // Footer rail “wake”
  const [wake, setWake] = useState(0);
  useEffect(() => {
    const onScroll = () => {
      const doc = document.documentElement;
      const scrollTop = window.scrollY || doc.scrollTop || 0;
      const viewportH = window.innerHeight || 0;
      const docH = Math.max(doc.scrollHeight, doc.offsetHeight);
      const dist = docH - (scrollTop + viewportH);

      const start = 560;
      const end = 160;
      const raw = 1 - (dist - end) / (start - end);
      setWake(clamp(raw, 0, 1));
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const showNoEntityWarning = !entityId;

  const statusUpper = (selected?.status ?? "").toUpperCase();
  const canHardDelete = ["DECLINED", "WITHDRAWN", "ARCHIVED"].includes(statusUpper);

  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      {/* Header under OS bar */}
      <div className="mb-4 shrink-0">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">CI • Admissions</div>

        <div className="mt-1 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-slate-50">Admissions · Authority Console</h1>
            <p className="mt-1 text-xs text-slate-400 max-w-3xl">
              Institutional intake is non-custodial. This console performs{" "}
              <span className="text-amber-200 font-semibold">triage</span>, records{" "}
              <span className="text-emerald-300 font-semibold">decisions</span>, and manages{" "}
              <span className="text-slate-200 font-semibold">archive</span> + provisioning — strictly via{" "}
              <span className="text-slate-200 font-semibold">RPC</span> (no raw updates).
            </p>

            <div className="mt-2 text-xs text-slate-400">
              Entity: <span className="text-emerald-300 font-medium">{activeEntityLabel}</span>
              <span className="mx-2 text-slate-700">•</span>
              Intake is auditable. Archive is reversible (status). Hard delete is explicit.
            </div>
          </div>

          <div className="shrink-0 flex items-center gap-2">
            <button
              onClick={() => setDrawerOpen((v) => !v)}
              className="rounded-full border border-slate-800 bg-slate-950/60 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60"
            >
              {drawerOpen ? "Hide Queue" : "Show Queue"}
            </button>

            <button
              onClick={() => reload(true)}
              className="rounded-full border border-slate-800 bg-slate-950/60 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60"
            >
              Refresh
            </button>

            <Link
              href="/ci-council"
              className="rounded-full border border-slate-700 bg-black/40 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60"
              title="Reference: Council authority console"
            >
              Council
            </Link>
          </div>
        </div>

        {showNoEntityWarning && (
          <div className="mt-3 rounded-2xl border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-[12px] text-amber-200">
            OS Context: <b>activeEntityId</b> missing; admissions will fallback to <code>entity_slug</code> scoping.
          </div>
        )}
      </div>

      {/* Main OS window frame */}
      <div className="flex-1 min-h-0 flex justify-center overflow-hidden">
        <div className="w-full max-w-[1500px] h-full rounded-3xl border border-slate-900 bg-black/60 shadow-[0_0_60px_rgba(15,23,42,0.9)] px-6 py-5 flex flex-col overflow-hidden">
          {/* Top strip */}
          <div className="shrink-0 mb-4 flex items-center justify-between gap-4">
            <div className="inline-flex rounded-full bg-slate-950/70 border border-slate-800 p-1 overflow-hidden">
              {statusTabs.map((s) => (
                <StatusTabButton
                  key={s}
                  label={s === "ALL" ? "All" : s}
                  value={s}
                  active={String(tab) === String(s)}
                  onClick={() => setTab(s)}
                />
              ))}
            </div>

            <div className="text-[10px] text-slate-500">
              Queue is entity-scoped. Archive is a tab. Hard delete is guarded.
            </div>
          </div>

          {/* Workspace */}
          <div className="flex-1 min-h-0 flex gap-4 overflow-hidden">
            {/* Left queue drawer */}
            {drawerOpen && (
              <aside className="w-[380px] shrink-0 min-h-0 rounded-2xl border border-slate-800 bg-slate-950/40 flex flex-col overflow-hidden">
                <div className="shrink-0 p-4 border-b border-slate-800">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                      Queue · {filtered.length}/{apps.length}
                    </div>

                    <button
                      onClick={() => {
                        setTab("ALL");
                        setQuery("");
                      }}
                      className="rounded-full border border-slate-800 bg-slate-950/60 px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60"
                    >
                      Reset
                    </button>
                  </div>

                  <input
                    className="mt-3 w-full rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-[13px] text-slate-100 outline-none focus:border-emerald-400"
                    placeholder="Search… applicant / org / email / intent"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto">
                  {loading ? (
                    <div className="p-4 text-[13px] text-slate-400">Loading…</div>
                  ) : filtered.length === 0 ? (
                    <div className="p-4 text-[13px] text-slate-500">No applications for this filter.</div>
                  ) : (
                    <ul className="divide-y divide-slate-800">
                      {filtered.map((a) => {
                        const st = (a.status ?? "—").toUpperCase();
                        const title =
                          a.organization_legal_name || a.organization_trade_name || a.applicant_name || "(unnamed)";
                        const sub = a.applicant_email || a.applicant_phone || a.website || "—";

                        return (
                          <li
                            key={a.id}
                            onClick={() => handleSelect(a)}
                            className={cx(
                              "cursor-pointer px-4 py-3 transition hover:bg-slate-800/60",
                              a.id === selectedId && "bg-slate-800/80"
                            )}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-[13px] font-semibold text-slate-100">{title}</div>
                                <div className="mt-1 text-[11px] text-slate-500 truncate">{sub}</div>

                                <div className="mt-2 text-[11px] text-slate-500">
                                  {fmtShort(a.created_at)} <span className="mx-2 text-slate-700">•</span>
                                  {a.applicant_type ?? "—"}
                                </div>
                              </div>

                              <span
                                className={cx(
                                  "shrink-0 rounded-full border px-2 py-1 text-[9px] uppercase tracking-[0.18em]",
                                  statusPill(st)
                                )}
                              >
                                {st}
                              </span>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </aside>
            )}

            {/* Center: Application details */}
            <section className="flex-1 min-w-0 min-h-0 rounded-2xl border border-slate-800 bg-slate-950/40 flex flex-col overflow-hidden">
              <div className="shrink-0 px-5 py-4 border-b border-slate-800 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">Application</div>
                  <div className="mt-1 text-[12px] text-slate-500">
                    Entity: <span className="text-emerald-300 font-semibold">{activeEntityLabel}</span>
                    <span className="mx-2 text-slate-700">•</span>
                    Status: <span className="text-slate-200 font-semibold">{(selected?.status ?? "—").toUpperCase()}</span>
                  </div>
                </div>

                <div className="shrink-0 flex items-center gap-2">
                  <button
                    onClick={async () => {
                      if (!selected?.id) return;
                      try {
                        await navigator.clipboard.writeText(selected.id);
                        flashInfo("Copied application id.");
                      } catch {
                        flashError("Copy failed.");
                      }
                    }}
                    disabled={!selected}
                    className="rounded-full border border-slate-800 bg-slate-950/60 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Copy ID
                  </button>

                  <Link
                    href="/ci-archive/verified"
                    className="rounded-full border border-slate-700 bg-black/40 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60"
                    title="Reference registries (separate from admissions)"
                  >
                    Verified Registry
                  </Link>
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-hidden p-5">
                {!selected ? (
                  <div className="h-full w-full rounded-2xl border border-slate-800 bg-black/20 flex items-center justify-center text-slate-500">
                    Select an application from the queue.
                  </div>
                ) : (
                  <div className="h-full w-full rounded-2xl border border-slate-800 bg-black/30 overflow-hidden flex flex-col">
                    <div className="shrink-0 px-5 py-4 border-b border-slate-800">
                      <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Snapshot</div>

                      <div className="mt-2 flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-[15px] font-semibold text-slate-100 truncate">
                            {selected.organization_legal_name ||
                              selected.organization_trade_name ||
                              selected.applicant_name ||
                              "(untitled)"}
                          </div>
                          <div className="mt-1 text-[11px] text-slate-500">
                            Submitted: {fmtShort(selected.submitted_at || selected.created_at)}
                            <span className="mx-2 text-slate-700">•</span>
                            Applicant: {selected.applicant_type ?? "—"}
                          </div>
                        </div>

                        <span
                          className={cx(
                            "shrink-0 rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.18em]",
                            statusPill(selected.status)
                          )}
                        >
                          {(selected.status ?? "—").toUpperCase()}
                        </span>
                      </div>
                    </div>

                    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-4">
                      <InfoBlock
                        title="Contact"
                        rows={[
                          ["Applicant", selected.applicant_name ?? "—"],
                          ["Email", selected.applicant_email ?? "—"],
                          ["Phone", selected.applicant_phone ?? "—"],
                          ["Org Email", (selected.metadata?.organization_email as string) ?? "—"],
                        ]}
                      />

                      <InfoBlock
                        title="Organization"
                        rows={[
                          ["Legal Name", selected.organization_legal_name ?? "—"],
                          ["Trade Name", selected.organization_trade_name ?? "—"],
                          ["Website", selected.website ?? "—"],
                          ["Incorporation #", selected.incorporation_number ?? "—"],
                          [
                            "Jurisdiction",
                            `${selected.jurisdiction_region ?? "—"} · ${selected.jurisdiction_country ?? "—"}`,
                          ],
                        ]}
                      />

                      <InfoBlock
                        title="Request"
                        rows={[
                          ["Intent", selected.intent ?? "—"],
                          ["Services", safeArray(selected.requested_services).join(", ") || "—"],
                          ["Expected Start", selected.expected_start_date ?? "—"],
                        ]}
                      />

                      <InfoBlock
                        title="Risk (Admissions)"
                        rows={[
                          ["Tier", selected.risk_tier ?? "—"],
                          ["Notes", selected.risk_notes ?? "—"],
                        ]}
                      />

                      <InfoBlock
                        title="Lifecycle"
                        rows={[
                          ["Created", fmtShort(selected.created_at)],
                          ["Triaged", fmtShort(selected.triaged_at)],
                          ["Decided", fmtShort(selected.decided_at)],
                          ["Provisioned", fmtShort(selected.provisioned_at)],
                        ]}
                      />

                      {(error || info) && (
                        <div className="text-[13px]">
                          {error && (
                            <div className="rounded-2xl border border-red-500/60 bg-red-500/10 px-4 py-3 text-red-200">
                              {error}
                            </div>
                          )}
                          {info && !error && (
                            <div className="rounded-2xl border border-emerald-500/60 bg-emerald-500/10 px-4 py-3 text-emerald-200">
                              {info}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="shrink-0 px-5 py-4 border-t border-slate-800 text-[10px] text-slate-500 flex items-center justify-between">
                      <span>Read-only surface. Mutations are RPC-only.</span>
                      <span>Oasis OS · Institutional Intake</span>
                    </div>
                  </div>
                )}
              </div>
            </section>

            {/* Right: Authority + Audit */}
            <aside className="w-[430px] shrink-0 min-h-0 rounded-2xl border border-slate-800 bg-slate-950/40 flex flex-col overflow-hidden">
              <div className="shrink-0 px-5 py-4 border-b border-slate-800">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                      Authority Panel
                    </div>
                    <div className="mt-1 text-[12px] text-slate-500">Triage · Decisions · Requests · Archive · Provisioning</div>
                  </div>

                  {selected && (
                    <span
                      className={cx(
                        "rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.18em]",
                        statusPill(selected.status)
                      )}
                    >
                      {(selected.status ?? "—").toUpperCase()}
                    </span>
                  )}
                </div>

                <div className="mt-4 grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setAdmissionsStatus("TRIAGE")}
                    disabled={!selected || busy !== null}
                    className="rounded-2xl border border-indigo-400/50 bg-indigo-500/10 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-indigo-200 hover:bg-indigo-500/15 disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Marks the application triaged (RPC)"
                  >
                    {busy === "status" ? "…" : "Triage"}
                  </button>

                  <button
                    onClick={() => setAdmissionsStatus("NEEDS_INFO")}
                    disabled={!selected || busy !== null}
                    className="rounded-2xl border border-amber-400/50 bg-amber-500/10 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-amber-200 hover:bg-amber-500/15 disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Moves to Needs Info (RPC)"
                  >
                    {busy === "status" ? "…" : "Needs Info"}
                  </button>
                </div>

                <div className="mt-2 grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setAdmissionsStatus("ARCHIVED")}
                    disabled={!selected || busy !== null}
                    className="rounded-2xl border border-slate-600/50 bg-slate-900/30 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/45 disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Soft archive: status → ARCHIVED (RPC)"
                  >
                    {busy === "status" ? "…" : "Archive"}
                  </button>

                  <button
                    onClick={() => {
                      if (!selected) return;
                      setDeleteOpen(true);
                      setDeleteReason("");
                      setDeleteConfirmText("");
                    }}
                    disabled={!selected || busy !== null}
                    className="rounded-2xl border border-rose-400/40 bg-rose-500/10 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-rose-200 hover:bg-rose-500/15 disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Hard delete (RPC) — terminal statuses only"
                  >
                    Hard Delete
                  </button>
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto px-5 py-5 space-y-4">
                {/* Decision */}
                <div className="rounded-2xl border border-slate-800 bg-black/25 px-4 py-4">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-slate-300">Record Decision (RPC)</div>

                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <select
                      value={decisionKind}
                      onChange={(e) => setDecisionKind(e.target.value)}
                      disabled={!selected || busy !== null}
                      className="w-full rounded-2xl border border-slate-800 bg-slate-950/60 px-3 py-3 text-[12px] text-slate-100 outline-none focus:border-emerald-400 disabled:opacity-50"
                    >
                      <option value="APPROVED">APPROVED</option>
                      <option value="DECLINED">DECLINED</option>
                      <option value="CONDITIONAL">CONDITIONAL</option>
                      <option value="DEFERRED">DEFERRED</option>
                    </select>

                    <input
                      value={riskTier}
                      onChange={(e) => setRiskTier(e.target.value)}
                      disabled={!selected || busy !== null}
                      placeholder="risk_tier (optional)"
                      className="w-full rounded-2xl border border-slate-800 bg-slate-950/60 px-3 py-3 text-[12px] text-slate-100 outline-none focus:border-emerald-400 disabled:opacity-50"
                    />
                  </div>

                  <textarea
                    value={decisionSummary}
                    onChange={(e) => setDecisionSummary(e.target.value)}
                    disabled={!selected || busy !== null}
                    placeholder="Decision summary (what / why)"
                    className="mt-2 w-full min-h-[88px] resize-none rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-[12px] text-slate-100 outline-none focus:border-emerald-400 disabled:opacity-50"
                  />

                  <textarea
                    value={decisionConditions}
                    onChange={(e) => setDecisionConditions(e.target.value)}
                    disabled={!selected || busy !== null}
                    placeholder="Conditions (optional)"
                    className="mt-2 w-full min-h-[72px] resize-none rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-[12px] text-slate-100 outline-none focus:border-emerald-400 disabled:opacity-50"
                  />

                  <textarea
                    value={riskNotes}
                    onChange={(e) => setRiskNotes(e.target.value)}
                    disabled={!selected || busy !== null}
                    placeholder="risk_notes (optional)"
                    className="mt-2 w-full min-h-[64px] resize-none rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-[12px] text-slate-100 outline-none focus:border-emerald-400 disabled:opacity-50"
                  />

                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button
                      onClick={recordDecision}
                      disabled={!selected || busy !== null}
                      className="rounded-2xl border border-emerald-400/50 bg-emerald-500/10 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-emerald-200 hover:bg-emerald-500/15 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {busy === "decision" ? "Recording…" : "Record"}
                    </button>

                    <button
                      onClick={() => setAdmissionsStatus(decisionKind)}
                      disabled={!selected || busy !== null}
                      className="rounded-2xl border border-amber-400/50 bg-amber-500/10 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-amber-200 hover:bg-amber-500/15 disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Convenience: set status to match decision (RPC)"
                    >
                      {busy === "status" ? "…" : "Set Status"}
                    </button>
                  </div>

                  <div className="mt-3 text-[10px] text-slate-600">
                    Decision is auditable: writes to <span className="font-mono">onboarding_decisions</span>.
                  </div>
                </div>

                {/* Request info */}
                <div className="rounded-2xl border border-slate-800 bg-black/25 px-4 py-4">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-amber-200">Request Information (RPC)</div>

                  <textarea
                    value={requestInfoMsg}
                    onChange={(e) => setRequestInfoMsg(e.target.value)}
                    disabled={!selected || busy !== null}
                    placeholder="Message to applicant (what you need / why / deadline)"
                    className="mt-3 w-full min-h-[92px] resize-none rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-[12px] text-slate-100 outline-none focus:border-amber-400 disabled:opacity-50"
                  />

                  <textarea
                    value={requestInfoFields}
                    onChange={(e) => setRequestInfoFields(e.target.value)}
                    disabled={!selected || busy !== null}
                    placeholder='Optional JSON fields (e.g. {"need":["incorporation_number","registry_email"]})'
                    className="mt-2 w-full min-h-[72px] resize-none rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-[12px] text-slate-100 outline-none focus:border-amber-400 disabled:opacity-50 font-mono"
                  />

                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button
                      onClick={requestInfo}
                      disabled={!selected || busy !== null}
                      className="rounded-2xl border border-amber-400/50 bg-amber-500/10 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-amber-200 hover:bg-amber-500/15 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {busy === "info" ? "Sending…" : "Request Info"}
                    </button>

                    <button
                      onClick={() => setAdmissionsStatus("NEEDS_INFO")}
                      disabled={!selected || busy !== null}
                      className="rounded-2xl border border-slate-700 bg-slate-950/40 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {busy === "status" ? "…" : "Mark Needs Info"}
                    </button>
                  </div>

                  <div className="mt-3 text-[10px] text-slate-600">
                    Request is auditable: writes to <span className="font-mono">onboarding_events</span>.
                  </div>
                </div>

                {/* Provisioning tasks */}
                <div className="rounded-2xl border border-slate-800 bg-black/25 px-4 py-4">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-sky-200">Provisioning Tasks (RPC)</div>

                  <textarea
                    value={tasksJson}
                    onChange={(e) => setTasksJson(e.target.value)}
                    disabled={!selected || busy !== null}
                    className="mt-3 w-full min-h-[160px] resize-none rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-[12px] text-slate-100 outline-none focus:border-sky-400 disabled:opacity-50 font-mono"
                  />

                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button
                      onClick={createProvisioningTasks}
                      disabled={!selected || busy !== null}
                      className="rounded-2xl border border-sky-400/50 bg-sky-500/10 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-sky-200 hover:bg-sky-500/15 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {busy === "tasks" ? "Creating…" : "Create Tasks"}
                    </button>

                    <button
                      onClick={() => setAdmissionsStatus("PROVISIONING")}
                      disabled={!selected || busy !== null}
                      className="rounded-2xl border border-slate-700 bg-slate-950/40 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60 disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Moves status into provisioning phase (RPC)"
                    >
                      {busy === "status" ? "…" : "Set Provisioning"}
                    </button>
                  </div>

                  <div className="mt-3 text-[10px] text-slate-600">
                    Tasks live in <span className="font-mono">onboarding_provisioning_tasks</span>.
                  </div>
                </div>

                {/* Audit rails */}
                <div className="rounded-2xl border border-slate-800 bg-black/25 overflow-hidden">
                  <div className="px-4 py-4 border-b border-slate-800">
                    <div className="text-[11px] uppercase tracking-[0.22em] text-slate-300">Audit Trail</div>
                    <div className="mt-1 text-[11px] text-slate-500">
                      Events: {events.length} · Decisions: {decisions.length} · Tasks: {tasks.length}
                    </div>
                  </div>

                  <div className="max-h-[360px] overflow-y-auto divide-y divide-slate-800">
                    {decisions.length > 0 && (
                      <div className="p-4">
                        <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Decisions</div>
                        <div className="mt-2 space-y-2">
                          {decisions.slice(0, 6).map((d) => (
                            <div key={d.id} className="rounded-2xl border border-slate-800 bg-black/25 px-3 py-3">
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <div className="text-[12px] font-semibold text-slate-100">
                                    {(d.decision ?? "—").toUpperCase()}
                                  </div>
                                  <div className="mt-1 text-[10px] text-slate-500">
                                    {fmtShort(d.decided_at)} <span className="mx-2 text-slate-700">•</span> by{" "}
                                    {hashShort(d.decided_by)}
                                  </div>
                                </div>
                              </div>
                              {d.summary && <div className="mt-2 text-[12px] text-slate-300 whitespace-pre-wrap">{d.summary}</div>}
                              {d.conditions && (
                                <div className="mt-2 text-[11px] text-slate-400 whitespace-pre-wrap">
                                  <span className="text-slate-500">Conditions: </span>
                                  {d.conditions}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {tasks.length > 0 && (
                      <div className="p-4">
                        <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Provisioning Tasks</div>
                        <div className="mt-2 space-y-2">
                          {tasks.slice(0, 8).map((t) => (
                            <div key={t.id} className="rounded-2xl border border-slate-800 bg-black/25 px-3 py-3">
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <div className="text-[12px] font-semibold text-slate-100 truncate">{t.task_key ?? "(task)"}</div>
                                  <div className="mt-1 text-[10px] text-slate-500">
                                    {fmtShort(t.created_at)} <span className="mx-2 text-slate-700">•</span> status:{" "}
                                    <span className="text-slate-200 font-semibold">{(t.status ?? "—").toUpperCase()}</span>
                                    <span className="mx-2 text-slate-700">•</span> attempts: {t.attempts ?? 0}
                                  </div>
                                </div>
                              </div>

                              {t.last_error && (
                                <div className="mt-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200">
                                  {t.last_error}
                                </div>
                              )}

                              {t.result && (
                                <pre className="mt-2 whitespace-pre-wrap font-mono text-[10px] text-slate-300 rounded-xl border border-slate-800 bg-black/25 px-3 py-2 max-h-[140px] overflow-y-auto">
                                  {JSON.stringify(t.result, null, 2)}
                                </pre>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {events.length > 0 && (
                      <div className="p-4">
                        <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Events</div>
                        <div className="mt-2 space-y-2">
                          {events.slice(0, 10).map((e) => (
                            <div key={e.id} className="rounded-2xl border border-slate-800 bg-black/25 px-3 py-3">
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <div className="text-[11px] font-semibold text-slate-200">
                                    {(e.event_type ?? "event").toUpperCase()}
                                  </div>
                                  <div className="mt-1 text-[10px] text-slate-500">
                                    {fmtShort(e.created_at)} <span className="mx-2 text-slate-700">•</span> actor{" "}
                                    {hashShort(e.actor_id)}
                                  </div>
                                </div>
                              </div>
                              {e.message && <div className="mt-2 text-[12px] text-slate-300 whitespace-pre-wrap">{e.message}</div>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {events.length === 0 && decisions.length === 0 && tasks.length === 0 && (
                      <div className="p-4 text-[12px] text-slate-500">No audit entries yet for this application.</div>
                    )}
                  </div>
                </div>
              </div>

              <div className="shrink-0 px-5 py-3 border-t border-slate-800 text-[10px] text-slate-500 flex items-center justify-between">
                <span>Admissions mutations are RPC-only.</span>
                <span>Oasis OS · Authority Gateway</span>
              </div>
            </aside>
          </div>
        </div>
      </div>

      {/* Low-presence footer rail (wake near bottom) */}
      <div
        className="mt-5 rounded-2xl border border-slate-900 bg-black/40 px-5 py-4 text-[11px] text-slate-500 flex items-center justify-between"
        style={{
          opacity: 0.35 + wake * 0.65,
          transform: `translateY(${(1 - wake) * 6}px)`,
        }}
      >
        <span className="tracking-[0.18em] uppercase">Verified Intake · Auditable Decisions · Archive Discipline</span>
        <span className="text-slate-600">© {new Date().getFullYear()} Oasis International Holdings</span>
      </div>

      {/* Hard Delete Modal */}
      {deleteOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 px-6">
          <div className="w-full max-w-[640px] rounded-3xl border border-slate-800 bg-slate-950/80 shadow-[0_0_80px_rgba(0,0,0,0.6)] overflow-hidden">
            <div className="px-6 py-5 border-b border-slate-800">
              <div className="text-[11px] uppercase tracking-[0.22em] text-rose-200">Hard Delete (Production)</div>
              <div className="mt-2 text-[13px] text-slate-300">
                This permanently removes the application and its related rows. A tombstone snapshot should exist server-side.
              </div>
              <div className="mt-2 text-[12px] text-slate-500">
                Allowed only when status is <span className="text-slate-200 font-semibold">DECLINED / WITHDRAWN / ARCHIVED</span>.
              </div>
            </div>

            <div className="px-6 py-5 space-y-3">
              <div className="rounded-2xl border border-slate-800 bg-black/25 px-4 py-4">
                <div className="text-[11px] uppercase tracking-[0.22em] text-slate-400">Target</div>
                <div className="mt-2 text-[12px] text-slate-200">
                  {(selected?.organization_legal_name || selected?.organization_trade_name || selected?.applicant_email || "—") ?? "—"}
                </div>
                <div className="mt-1 text-[11px] text-slate-500">
                  id: <span className="font-mono">{selected?.id ?? "—"}</span> · status:{" "}
                  <span className="text-slate-200 font-semibold">{(selected?.status ?? "—").toUpperCase()}</span>
                </div>
              </div>

              {!canHardDelete && (
                <div className="rounded-2xl border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-[12px] text-amber-200">
                  Hard delete is blocked for this status. Archive first, or set terminal status.
                </div>
              )}

              <textarea
                value={deleteReason}
                onChange={(e) => setDeleteReason(e.target.value)}
                className="w-full min-h-[90px] resize-none rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-[12px] text-slate-100 outline-none focus:border-rose-400"
                placeholder="Reason (recommended)."
              />

              <input
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                className="w-full rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-[12px] text-slate-100 outline-none focus:border-rose-400"
                placeholder='Type DELETE to confirm'
              />
            </div>

            <div className="px-6 py-4 border-t border-slate-800 flex items-center justify-between">
              <button
                onClick={() => {
                  setDeleteOpen(false);
                  setDeleteReason("");
                  setDeleteConfirmText("");
                }}
                className="rounded-full border border-slate-800 bg-slate-950/60 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/60"
              >
                Cancel
              </button>

              <button
                onClick={hardDeleteSelected}
                disabled={!selected || !canHardDelete || deleteConfirmText.trim().toUpperCase() !== "DELETE" || busy !== null}
                className="rounded-full border border-rose-400/50 bg-rose-500/10 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-rose-200 hover:bg-rose-500/15 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {busy === "delete" ? "Deleting…" : "Hard Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusTabButton({
  label,
  value,
  active,
  onClick,
}: {
  label: string;
  value: StatusTab;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "px-4 py-2 rounded-full text-left transition min-w-[110px]",
        active
          ? "bg-emerald-500/15 border border-emerald-400/70 text-slate-50"
          : "bg-transparent border border-transparent hover:bg-slate-900/60 text-slate-300"
      )}
      title={String(value)}
    >
      <div className="text-xs font-semibold">{label}</div>
      <div className="text-[10px] text-slate-400 uppercase tracking-[0.18em]">{String(value)}</div>
    </button>
  );
}

function InfoBlock({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-black/35 px-5 py-5">
      <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">{title}</div>
      <div className="mt-3 space-y-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-start justify-between gap-6">
            <div className="text-[11px] text-slate-500">{k}</div>
            <div className="text-[12px] text-slate-100 text-right whitespace-pre-wrap max-w-[70%]">{v || "—"}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
