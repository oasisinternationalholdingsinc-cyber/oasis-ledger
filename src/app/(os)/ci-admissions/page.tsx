// src/app/(os)/ci-admissions/page.tsx
"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";

type StatusTab = "ALL" | string;

/**
 * IMPORTANT: v_onboarding_admissions_inbox columns (confirmed):
 * id, status, submitted_at, triaged_at, decided_at, provisioned_at, created_at, updated_at,
 * applicant_type, applicant_name, applicant_email, applicant_phone,
 * organization_legal_name, organization_trade_name,
 * website, incorporation_number, jurisdiction_country, jurisdiction_region,
 * intent, requested_services, expected_start_date,
 * risk_tier, risk_notes,
 * created_by, assigned_to, decided_by,
 * entity_id, entity_slug, metadata
 */

type ApplicationRow = {
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

  website: string | null;
  incorporation_number: string | null;
  jurisdiction_country: string | null;
  jurisdiction_region: string | null;

  intent: string | null;
  requested_services: string[] | null;
  expected_start_date: string | null;

  risk_tier: string | null;
  risk_notes: string | null;

  created_by: string | null;
  assigned_to: string | null;
  decided_by: string | null;

  entity_id: string | null;
  entity_slug: string | null;

  metadata: any | null;
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

/** Admissions enums are Postgres enums in this project; normalize to lowercase for RPC payloads. */
function enumLower(x: string) {
  return String(x || "").trim().toLowerCase();
}

function statusPill(st?: string | null) {
  const s = (st ?? "").toUpperCase();
  if (s.includes("APPROV")) return "bg-emerald-500/18 text-emerald-100 border-emerald-300/45";
  if (s.includes("DECLIN") || s.includes("REJECT")) return "bg-rose-500/16 text-rose-100 border-rose-300/45";
  if (s.includes("ARCHIV")) return "bg-slate-700/30 text-slate-100 border-slate-500/45";
  if (s.includes("NEED") || s.includes("INFO")) return "bg-amber-500/18 text-amber-100 border-amber-300/45";
  if (s.includes("PROVISION")) return "bg-sky-500/18 text-sky-100 border-sky-300/45";
  if (s.includes("TRIAG") || s.includes("REVIEW")) return "bg-indigo-500/18 text-indigo-100 border-indigo-300/45";
  if (s.includes("SUBMIT") || s.includes("DRAFT")) return "bg-slate-700/25 text-slate-100 border-slate-500/40";
  return "bg-slate-700/20 text-slate-100 border-slate-500/35";
}

function safeArray(x: any): string[] {
  if (!x) return [];
  if (Array.isArray(x)) return x.map(String);
  return [];
}

type UiProvisionTask = {
  enabled: boolean; // checkbox == include this task in payload
  task_key: string;
  title: string;
  notes: string;
  required: boolean;
  channels: Array<"email" | "sms">;
  due_at: string | null; // ISO string
};

const TASK_TEMPLATES: Array<Omit<UiProvisionTask, "enabled">> = [
  {
    task_key: "collect_incorporation_documents",
    title: "Provide incorporation documents",
    notes: "Upload Articles of Incorporation + any incorporation proof.",
    required: true,
    channels: ["email"],
    due_at: null,
  },
  {
    task_key: "collect_registry_proof",
    title: "Provide registry proof",
    notes: "Provide corporate registry extract / proof of status.",
    required: true,
    channels: ["email"],
    due_at: null,
  },
  {
    task_key: "collect_authority_to_act",
    title: "Provide authority to act",
    notes: "Provide director/officer authorization to submit and sign.",
    required: true,
    channels: ["email"],
    due_at: null,
  },
  {
    task_key: "collect_beneficial_owners",
    title: "Provide beneficial owners",
    notes: "List beneficial owners and control persons (if applicable).",
    required: false,
    channels: ["email"],
    due_at: null,
  },
  {
    task_key: "provision_portal_access",
    title: "Provision portal access",
    notes: "Create portal routing / invite (delivery layer later).",
    required: true,
    channels: ["email"],
    due_at: null,
  },
  {
    task_key: "assign_operator",
    title: "Assign admissions operator",
    notes: "Assign internal owner + reviewer.",
    required: true,
    channels: [],
    due_at: null,
  },
];

function mkTask(t: Omit<UiProvisionTask, "enabled">): UiProvisionTask {
  return { enabled: true, ...t };
}

function normalizeTaskKey(x: string) {
  return String(x || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isInviteSentStatus(st?: string | null) {
  const s = String(st ?? "").trim().toUpperCase();
  return ["SENT", "COMPLETED", "DONE", "SUCCESS", "OK"].includes(s);
}

function taskStatusPill(st?: string | null) {
  const s = String(st ?? "").trim().toUpperCase();
  if (s.includes("COMPLET") || s === "DONE" || s === "SUCCESS") return "bg-emerald-500/14 text-emerald-100 border-emerald-400/35";
  if (s.includes("SENT")) return "bg-amber-500/12 text-amber-100 border-amber-400/35";
  if (s.includes("RUN") || s.includes("PROCESS")) return "bg-sky-500/12 text-sky-100 border-sky-400/35";
  if (s.includes("FAIL") || s.includes("ERR")) return "bg-rose-500/12 text-rose-100 border-rose-400/35";
  return "bg-slate-700/20 text-slate-100 border-slate-500/35";
}

function eventTypeLabel(x?: string | null) {
  const s = String(x ?? "").trim();
  if (!s) return "EVENT";
  return s.replace(/_/g, " ").toUpperCase();
}

export default function CIAdmissionsPage() {
  const entityCtx = useEntity() as any;
  useOsEnv(); // kept for OS consistency (even if admissions ignores is_test)

  const activeEntitySlug = (entityCtx?.activeEntity as string) || "holdings";
  const activeEntityLabel = useMemo(() => ENTITY_LABELS[activeEntitySlug] ?? activeEntitySlug, [activeEntitySlug]);

  const [entityId, setEntityId] = useState<string | null>((entityCtx?.activeEntityId as string) || null);

  // UI state
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | "status" | "review" | "decision" | "info" | "tasks" | "run_task" | "delete">(null);
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);

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
  const [requestInfoFields, setRequestInfoFields] = useState<string>(""); // optional JSON overrides

  // ---- Task builder UI state (replaces JSON textarea) ----
  const [taskDrafts, setTaskDrafts] = useState<UiProvisionTask[]>(() => {
    const defaults = [TASK_TEMPLATES[0], TASK_TEMPLATES[1], TASK_TEMPLATES[2], TASK_TEMPLATES[4]].filter(Boolean) as Array<
      Omit<UiProvisionTask, "enabled">
    >;
    return defaults.map(mkTask);
  });

  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [newTaskKey, setNewTaskKey] = useState("");
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskNotes, setNewTaskNotes] = useState("");
  const [newTaskRequired, setNewTaskRequired] = useState(true);
  const [newTaskChannels, setNewTaskChannels] = useState<Array<"email" | "sms">>(["email"]);
  const [newTaskDueAt, setNewTaskDueAt] = useState<string>(""); // datetime-local string

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
        "id,status,submitted_at,triaged_at,decided_at,provisioned_at,created_at,updated_at,applicant_type,applicant_name,applicant_email,applicant_phone,organization_legal_name,organization_trade_name,website,incorporation_number,jurisdiction_country,jurisdiction_region,intent,requested_services,expected_start_date,risk_tier,risk_notes,created_by,assigned_to,decided_by,entity_id,entity_slug,metadata";

      const VIEW = "v_onboarding_admissions_inbox";

      const tryByEntityId = async () => {
        const { data, error } = await supabase
          .from(VIEW)
          .select(baseSelect)
          .eq("entity_id", eid)
          .order("created_at", { ascending: false });
        if (error) throw error;
        return (data ?? []) as ApplicationRow[];
      };

      const tryByEntitySlug = async () => {
        const { data, error } = await supabase
          .from(VIEW)
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

      const filteredByTab = tab === "ALL" ? rows : rows.filter((r) => (r.status ?? "").toUpperCase() === String(tab).toUpperCase());

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
  async function beginReview() {
    if (!selected?.id) return flashError("Select an application first.");
    setBusy("review");
    setError(null);
    setInfo(null);

    try {
      const { data, error } = await supabase.rpc("admissions_begin_review", {
        p_application_id: selected.id,
      });
      if (error) throw error;
      if ((data as any)?.ok === false) throw new Error((data as any)?.error ?? "RPC failed.");

      flashInfo("Admissions: begin review.");
      await reload(true);
    } catch (e: any) {
      flashError(e?.message ?? "Failed to begin review (RPC).");
    } finally {
      setBusy(null);
    }
  }

  async function setAdmissionsStatus(nextStatus: string, note?: string) {
    if (!selected?.id) return flashError("Select an application first.");
    setBusy("status");
    setError(null);
    setInfo(null);

    try {
      const next = enumLower(nextStatus);
      const { data, error } = await supabase.rpc("admissions_set_status", {
        p_application_id: selected.id,
        p_next_status: next, // ✅ lowercase enum payload
        p_note: (note ?? "Admissions status update").trim(),
      });
      if (error) throw error;
      if ((data as any)?.ok === false) throw new Error((data as any)?.error ?? "RPC failed.");

      flashInfo(`Admissions: status → ${String(nextStatus).toUpperCase()}.`);
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
      const decision = enumLower(decisionKind.trim() || "approved");
      const rt = riskTier.trim() ? enumLower(riskTier.trim()) : null;

      const { data, error } = await supabase.rpc("admissions_record_decision", {
        p_application_id: selected.id,
        p_decision: decision, // ✅ lowercase enum payload
        p_risk_tier: rt,
        p_summary: decisionSummary.trim(),
        p_reason: decisionConditions.trim(),
      });

      if (error) throw error;
      if ((data as any)?.ok === false) throw new Error((data as any)?.error ?? "RPC failed.");

      flashInfo(`Decision recorded: ${String(decisionKind).toUpperCase()}.`);
      await reload(true);
      await loadRelated(selected.id);
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
      let channels: string[] = ["email"];
      let dueAt: string | null = null;
      let nextStatus = "needs_info";

      const raw = requestInfoFields.trim();
      if (raw) {
        let j: any;
        try {
          j = JSON.parse(raw);
        } catch {
          return flashError("Optional JSON must be valid JSON (or empty).");
        }

        if (Array.isArray(j?.channels)) channels = j.channels.map(String);
        if (typeof j?.due_at === "string" && j.due_at.trim()) dueAt = j.due_at.trim();
        if (typeof j?.next_status === "string" && j.next_status.trim()) nextStatus = enumLower(j.next_status.trim());
      }

      const { data, error } = await supabase.rpc("admissions_request_info", {
        p_application_id: selected.id,
        p_message: msg,
        p_channels: channels,
        p_due_at: dueAt,
        p_next_status: nextStatus, // ✅ lowercase enum payload
      });

      if (error) throw error;
      if ((data as any)?.ok === false) throw new Error((data as any)?.error ?? "RPC failed.");

      flashInfo("Information request recorded.");
      setRequestInfoMsg("");
      await loadRelated(selected.id);
      await reload(true);
    } catch (e: any) {
      flashError(e?.message ?? "Failed to request info (RPC).");
    } finally {
      setBusy(null);
    }
  }

  // ---- Provisioning tasks (RPC-only) ----
  async function createProvisioningTasks() {
    if (!selected?.id) return flashError("Select an application first.");
    setBusy("tasks");
    setError(null);
    setInfo(null);

    try {
      const enabled = taskDrafts.filter((t) => t.enabled);
      if (enabled.length === 0) return flashError("Select at least one task.");

      const payload = enabled.map((t) => ({
        task_key: normalizeTaskKey(t.task_key || t.title || "task"),
        title: (t.title || "").trim() || undefined,
        notes: (t.notes || "").trim() || undefined,
        required: !!t.required,
        channels: (t.channels ?? []).map(String),
        due_at: t.due_at ? String(t.due_at) : null,
      }));

      const { data, error } = await supabase.rpc("admissions_create_provisioning_tasks", {
        p_application_id: selected.id,
        p_tasks: payload, // ✅ JSON array
      });

      if (error) throw error;
      if ((data as any)?.ok === false) throw new Error((data as any)?.error ?? "RPC failed.");

      flashInfo("Provisioning tasks created.");
      await loadRelated(selected.id);
      await reload(true);
    } catch (e: any) {
      flashError(e?.message ?? "Failed to create provisioning tasks (RPC).");
    } finally {
      setBusy(null);
    }
  }

  // ---- Task execution (Edge Function) ----
  async function runProvisioningTask(t: TaskRow) {
    if (!selected?.id) return flashError("Select an application first.");
    if (!t?.id) return flashError("Task id missing.");

    setBusy("run_task");
    setRunningTaskId(t.id);
    setError(null);
    setInfo(null);

    try {
      const orgEmail =
        (selected.metadata?.organization_email as string) ||
        (selected.metadata?.org_email as string) ||
        (selected.metadata?.contact_email as string) ||
        null;

      const inviteEmail =
        (orgEmail && String(orgEmail).trim()) ||
        (selected.applicant_email && String(selected.applicant_email).trim()) ||
        null;

      if (!inviteEmail) {
        throw new Error("No invite email found (metadata.organization_email or applicant_email).");
      }

      const { data, error } = await supabase.functions.invoke("admissions-provision-portal-access", {
        body: {
          application_id: selected.id,
          task_id: t.id,
          task_key: t.task_key,
          entity_slug: activeEntitySlug,
          invite_email: inviteEmail,
          applicant_name: selected.applicant_name,
          organization_legal_name: selected.organization_legal_name,
          organization_trade_name: selected.organization_trade_name,
        },
      });

      if (error) throw error;
      if ((data as any)?.ok === false) throw new Error((data as any)?.error ?? "Task runner failed.");

      flashInfo("Task executed (invite sent).");
      await loadRelated(selected.id);
      await reload(true);
    } catch (e: any) {
      flashError(e?.message ?? "Failed to run provisioning task.");
      if (selected?.id) {
        await loadRelated(selected.id);
      }
    } finally {
      setBusy(null);
      setRunningTaskId(null);
    }
  }

  // ✅ ALWAYS-VISIBLE authoritative invite runner
  const portalTask = useMemo(() => {
    return tasks.find((t) => normalizeTaskKey(t.task_key ?? "") === "provision_portal_access") ?? null;
  }, [tasks]);

  async function runInviteAuthoritative() {
    if (!selected?.id) return flashError("Select an application first.");

    if (portalTask?.id) {
      return runProvisioningTask(portalTask);
    }

    setBusy("tasks");
    setError(null);
    setInfo(null);

    try {
      const payload = [
        {
          task_key: "provision_portal_access",
          title: "Provision portal access",
          notes: "Create portal routing / invite (delivery layer later).",
          required: true,
          channels: ["email"],
          due_at: null,
        },
      ];

      const { data, error } = await supabase.rpc("admissions_create_provisioning_tasks", {
        p_application_id: selected.id,
        p_tasks: payload,
      });

      if (error) throw error;
      if ((data as any)?.ok === false) throw new Error((data as any)?.error ?? "RPC failed.");

      const { data: tk, error: tkErr } = await supabase
        .from("onboarding_provisioning_tasks")
        .select("id,application_id,task_key,status,attempts,result,last_error,created_at,updated_at")
        .eq("application_id", selected.id)
        .order("created_at", { ascending: false })
        .limit(50);

      if (tkErr) throw tkErr;

      const newestPortal = (tk ?? []).find((t) => normalizeTaskKey((t as any).task_key ?? "") === "provision_portal_access") as TaskRow | undefined;

      await loadRelated(selected.id);

      if (!newestPortal?.id) {
        throw new Error("Portal invite task could not be created/found.");
      }

      setBusy(null);
      return runProvisioningTask(newestPortal);
    } catch (e: any) {
      flashError(e?.message ?? "Failed to create/run invite task.");
    } finally {
      setBusy((b) => (b === "tasks" ? null : b));
    }
  }

  async function hardDeleteSelected() {
    if (!selected?.id) return flashError("Select an application first.");
    setBusy("delete");
    setError(null);
    setInfo(null);

    try {
      const { data, error } = await supabase.rpc("admissions_delete_application", {
        p_application_id: selected.id,
        p_reason: deleteReason.trim() || null,
      });

      if (error) throw error;
      if ((data as any)?.ok === false) throw new Error((data as any)?.error ?? "RPC failed.");

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

  // ✅ IMPORTANT: normalize ONCE as lowercase; use for any gating
  const statusNorm = String(selected?.status ?? "").trim().toLowerCase();

  // ✅ HARD BOOLEAN (fixes your TS error: no "" leaks)
  const beginReviewDisabled: boolean = !selected || busy !== null || statusNorm !== "submitted";

  const statusUpper = (selected?.status ?? "").toUpperCase();
  const canHardDelete = ["DECLINED", "WITHDRAWN", "ARCHIVED"].includes(statusUpper);

  const selectedTaskCount = useMemo(() => taskDrafts.filter((t) => t.enabled).length, [taskDrafts]);

  function toggleTaskEnabled(ix: number) {
    setTaskDrafts((prev) => prev.map((t, i) => (i === ix ? { ...t, enabled: !t.enabled } : t)));
  }

  function setTaskField(ix: number, patch: Partial<UiProvisionTask>) {
    setTaskDrafts((prev) => prev.map((t, i) => (i === ix ? { ...t, ...patch } : t)));
  }

  function addTemplate(tpl: Omit<UiProvisionTask, "enabled">) {
    setTaskDrafts((prev) => {
      const key = normalizeTaskKey(tpl.task_key);
      const exists = prev.some((x) => normalizeTaskKey(x.task_key) === key);
      if (exists) {
        return prev.map((x) => (normalizeTaskKey(x.task_key) === key ? { ...x, enabled: true } : x));
      }
      return [mkTask(tpl), ...prev];
    });
  }

  function removeDraft(ix: number) {
    setTaskDrafts((prev) => prev.filter((_, i) => i !== ix));
  }

  function resetDraftsToDefault() {
    const defaults = [TASK_TEMPLATES[0], TASK_TEMPLATES[1], TASK_TEMPLATES[2], TASK_TEMPLATES[4]].filter(Boolean) as Array<
      Omit<UiProvisionTask, "enabled">
    >;
    setTaskDrafts(defaults.map(mkTask));
  }

  function openNewTaskModal() {
    setTaskModalOpen(true);
    setNewTaskKey("");
    setNewTaskTitle("");
    setNewTaskNotes("");
    setNewTaskRequired(true);
    setNewTaskChannels(["email"]);
    setNewTaskDueAt("");
  }

  function addCustomTask() {
    const title = newTaskTitle.trim();
    if (!title) return flashError("Task title is required.");

    const key = normalizeTaskKey(newTaskKey.trim() || title);
    const dueIso = newTaskDueAt.trim() ? new Date(newTaskDueAt).toISOString() : null;

    const t: UiProvisionTask = {
      enabled: true,
      task_key: key,
      title,
      notes: newTaskNotes.trim(),
      required: !!newTaskRequired,
      channels: newTaskChannels,
      due_at: dueIso,
    };

    setTaskDrafts((prev) => [t, ...prev]);
    setTaskModalOpen(false);
  }

  function toggleChannel(ix: number, ch: "email" | "sms") {
    setTaskDrafts((prev) =>
      prev.map((t, i) => {
        if (i !== ix) return t;
        const has = t.channels.includes(ch);
        const next = has ? t.channels.filter((x) => x !== ch) : [...t.channels, ch];
        return { ...t, channels: next };
      })
    );
  }

  // Invite button label/status (authoritative)
  const portalTaskStatus = String(portalTask?.status ?? "").trim().toUpperCase();
  const portalAlreadySent = isInviteSentStatus(portalTaskStatus);

  // A tiny enhancement: show the *invite target* we will use (pure UI, no wiring)
  const computedOrgEmail =
    (selected?.metadata?.organization_email as string) ||
    (selected?.metadata?.org_email as string) ||
    (selected?.metadata?.contact_email as string) ||
    null;

  const computedInviteEmail =
    (computedOrgEmail && String(computedOrgEmail).trim()) ||
    (selected?.applicant_email && String(selected?.applicant_email).trim()) ||
    null;

  const showInviteTarget = !!selected;

  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      {/* Header under OS bar */}
      <div className="mb-4 shrink-0">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">CI • Admissions</div>

        <div className="mt-1 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-slate-50">Admissions · Authority Console</h1>
            <p className="mt-1 text-[13px] leading-5 text-slate-400 max-w-3xl">
              Institutional intake is non-custodial. This console performs{" "}
              <span className="text-amber-200 font-semibold">review</span>, records{" "}
              <span className="text-emerald-300 font-semibold">decisions</span>, and manages{" "}
              <span className="text-slate-200 font-semibold">archive</span> + provisioning — strictly via{" "}
              <span className="text-slate-200 font-semibold">RPC</span> (no raw updates).
            </p>

            <div className="mt-2 text-[13px] text-slate-400">
              Entity: <span className="text-emerald-300 font-medium">{activeEntityLabel}</span>
              <span className="mx-2 text-slate-700">•</span>
              Intake is auditable. Archive is reversible (status). Hard delete is explicit.
            </div>
          </div>

          <div className="shrink-0 flex items-center gap-2">
            <button
              onClick={() => setDrawerOpen((v) => !v)}
              className="rounded-full border border-slate-800 bg-slate-950/40 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/50"
            >
              {drawerOpen ? "Hide Queue" : "Show Queue"}
            </button>

            <button
              onClick={() => reload(true)}
              className="rounded-full border border-slate-800 bg-slate-950/40 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/50"
            >
              Refresh
            </button>

            <Link
              href="/ci-council"
              className="rounded-full border border-slate-700 bg-black/30 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/50"
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
        <div className="w-full max-w-[1540px] h-full rounded-3xl border border-slate-900/80 bg-black/45 shadow-[0_0_70px_rgba(15,23,42,0.75)] px-6 py-5 flex flex-col overflow-hidden">
          {/* Top strip */}
          <div className="shrink-0 mb-4 flex items-center justify-between gap-4">
            <div className="inline-flex rounded-full bg-slate-950/45 border border-slate-800/80 p-1 overflow-hidden">
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

            <div className="text-[11px] text-slate-500">Queue is entity-scoped. Archive is a tab. Hard delete is guarded.</div>
          </div>

          {/* Workspace */}
          <div className="flex-1 min-h-0 flex gap-4 overflow-hidden">
            {/* Left queue drawer */}
            {drawerOpen && (
              <aside className="w-[390px] shrink-0 min-h-0 rounded-2xl border border-slate-800/70 bg-slate-900/18 flex flex-col overflow-hidden">
                <div className="shrink-0 p-4 border-b border-slate-800/60 bg-white/[0.02]">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-300">
                      Queue · {filtered.length}/{apps.length}
                    </div>

                    <button
                      onClick={() => {
                        setTab("ALL");
                        setQuery("");
                      }}
                      className="rounded-full border border-slate-700/70 bg-slate-950/30 px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/45"
                    >
                      Reset
                    </button>
                  </div>

                  <input
                    className="mt-3 w-full rounded-2xl border border-slate-700/60 bg-slate-950/25 px-4 py-3 text-[14px] text-slate-100 placeholder:text-slate-500 outline-none focus:border-emerald-400/70"
                    placeholder="Search… applicant / org / email / intent"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto">
                  {loading ? (
                    <div className="p-4 text-[14px] text-slate-300">Loading…</div>
                  ) : filtered.length === 0 ? (
                    <div className="p-4 text-[14px] text-slate-400">No applications for this filter.</div>
                  ) : (
                    <ul className="py-2">
                      {filtered.map((a) => {
                        const st = (a.status ?? "—").toUpperCase();
                        const title = a.organization_legal_name || a.organization_trade_name || a.applicant_name || "(unnamed)";
                        const sub = a.applicant_email || a.applicant_phone || a.website || "—";

                        const selectedRow = a.id === selectedId;

                        return (
                          <li key={a.id} className="px-2">
                            <button
                              type="button"
                              onClick={() => handleSelect(a)}
                              className={cx(
                                "w-full text-left rounded-2xl px-4 py-3 transition",
                                "hover:bg-white/[0.05] focus:outline-none focus:ring-2 focus:ring-emerald-400/30",
                                selectedRow ? "bg-white/[0.07] ring-1 ring-emerald-400/25" : "bg-transparent"
                              )}
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0 flex-1">
                                  <div className={cx("truncate text-[14px] font-semibold", selectedRow ? "text-slate-50" : "text-slate-100")}>
                                    {title}
                                  </div>
                                  <div className="mt-1 text-[12px] text-slate-400 truncate">{sub}</div>

                                  <div className="mt-2 text-[12px] text-slate-500">
                                    {fmtShort(a.created_at)} <span className="mx-2 text-slate-700">•</span>
                                    {a.applicant_type ?? "—"}
                                  </div>
                                </div>

                                <span
                                  className={cx(
                                    "shrink-0 rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.18em]",
                                    statusPill(st)
                                  )}
                                >
                                  {st}
                                </span>
                              </div>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </aside>
            )}

            {/* Center */}
            <section className="flex-1 min-w-0 min-h-0 rounded-2xl border border-slate-800/70 bg-slate-950/28 flex flex-col overflow-hidden">
              <div className="shrink-0 px-5 py-4 border-b border-slate-800/60 bg-white/[0.02] flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-300">Application</div>
                  <div className="mt-1 text-[13px] text-slate-400">
                    Entity: <span className="text-emerald-300 font-semibold">{activeEntityLabel}</span>
                    <span className="mx-2 text-slate-700">•</span>
                    Status: <span className="text-slate-100 font-semibold">{(selected?.status ?? "—").toUpperCase()}</span>
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
                    className="rounded-full border border-slate-700/70 bg-slate-950/25 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/45 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Copy ID
                  </button>

                  <Link
                    href="/ci-archive/verified"
                    className="rounded-full border border-slate-700/70 bg-slate-950/25 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/45"
                    title="Reference registries (separate from admissions)"
                  >
                    Verified Registry
                  </Link>
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-hidden p-5">
                {!selected ? (
                  <div className="h-full w-full rounded-2xl border border-slate-800/60 bg-black/10 flex items-center justify-center text-slate-400">
                    Select an application from the queue.
                  </div>
                ) : (
                  <div className="h-full w-full rounded-2xl border border-slate-800/60 bg-black/12 overflow-hidden flex flex-col">
                    <div className="shrink-0 px-5 py-4 border-b border-slate-800/60 bg-white/[0.02]">
                      <div className="text-[11px] uppercase tracking-[0.22em] text-slate-400">Snapshot</div>

                      <div className="mt-2 flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-[16px] font-semibold text-slate-50 truncate">
                            {selected.organization_legal_name || selected.organization_trade_name || selected.applicant_name || "(untitled)"}
                          </div>
                          <div className="mt-1 text-[13px] text-slate-400">
                            Submitted: {fmtShort(selected.submitted_at || selected.created_at)}
                            <span className="mx-2 text-slate-700">•</span>
                            Applicant: {selected.applicant_type ?? "—"}
                          </div>
                        </div>

                        <span
                          className={cx(
                            "shrink-0 rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.18em]",
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
                          ["Jurisdiction", `${selected.jurisdiction_region ?? "—"} · ${selected.jurisdiction_country ?? "—"}`],
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

                      <InfoBlock title="Risk" rows={[["Tier", selected.risk_tier ?? "—"], ["Notes", selected.risk_notes ?? "—"]]} />

                      <InfoBlock
                        title="Lifecycle"
                        rows={[
                          ["Created", fmtShort(selected.created_at)],
                          ["Reviewed", fmtShort(selected.triaged_at)],
                          ["Decided", fmtShort(selected.decided_at)],
                          ["Provisioned", fmtShort(selected.provisioned_at)],
                        ]}
                      />

                      {(error || info) && (
                        <div className="text-[13px]">
                          {error && (
                            <div className="rounded-2xl border border-red-500/60 bg-red-500/10 px-4 py-3 text-red-200">{error}</div>
                          )}
                          {info && !error && (
                            <div className="rounded-2xl border border-emerald-500/60 bg-emerald-500/10 px-4 py-3 text-emerald-200">
                              {info}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="shrink-0 px-5 py-4 border-t border-slate-800/60 text-[11px] text-slate-500 flex items-center justify-between bg-white/[0.02]">
                      <span>Read-only surface. Mutations are RPC-only.</span>
                      <span>Oasis OS · Institutional Intake</span>
                    </div>
                  </div>
                )}
              </div>
            </section>

            {/* Right */}
            <aside className="w-[440px] shrink-0 min-h-0 rounded-2xl border border-slate-800/70 bg-slate-950/28 flex flex-col overflow-hidden">
              <div className="shrink-0 px-5 py-4 border-b border-slate-800/60 bg-white/[0.02]">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-300">Authority Panel</div>
                    <div className="mt-1 text-[13px] text-slate-400">Review · Decisions · Requests · Archive · Provisioning</div>
                  </div>

                  {selected && (
                    <span className={cx("rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.18em]", statusPill(selected.status))}>
                      {(selected.status ?? "—").toUpperCase()}
                    </span>
                  )}
                </div>

                <div className="mt-4 grid grid-cols-2 gap-2">
                  <button
                    onClick={beginReview}
                    disabled={beginReviewDisabled}
                    className="rounded-2xl border border-emerald-400/45 bg-emerald-500/12 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-emerald-100 hover:bg-emerald-500/16 disabled:opacity-50 disabled:cursor-not-allowed"
                    title={
                      beginReviewDisabled && selected
                        ? `Begin review allowed only from status "submitted" (current: ${statusNorm || "—"})`
                        : "Begins review (RPC)"
                    }
                  >
                    {busy === "review" ? "…" : "Begin Review"}
                  </button>

                  <button
                    onClick={() => setAdmissionsStatus("NEEDS_INFO")}
                    disabled={!selected || busy !== null}
                    className="rounded-2xl border border-amber-400/45 bg-amber-500/12 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-amber-100 hover:bg-amber-500/16 disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Moves to Needs Info (RPC)"
                  >
                    {busy === "status" ? "…" : "Needs Info"}
                  </button>
                </div>

                <div className="mt-2 grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setAdmissionsStatus("ARCHIVED")}
                    disabled={!selected || busy !== null}
                    className="rounded-2xl border border-slate-600/50 bg-white/[0.03] px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-100 hover:bg-white/[0.05] disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Soft archive: status → archived (RPC)"
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
                    className="rounded-2xl border border-rose-400/35 bg-rose-500/10 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-rose-100 hover:bg-rose-500/14 disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Hard delete (RPC) — terminal statuses only"
                  >
                    Hard Delete
                  </button>
                </div>

                {/* ✅ AUTHORITATIVE INVITE — ALWAYS VISIBLE */}
                <div className="mt-3 rounded-2xl border border-slate-800/60 bg-black/12 px-4 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] uppercase tracking-[0.22em] text-amber-100">Portal Invite</div>
                    <span
                      className={cx(
                        "rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.18em]",
                        portalAlreadySent ? "border-emerald-400/35 bg-emerald-500/10 text-emerald-100" : "border-slate-700/60 bg-white/[0.03] text-slate-200"
                      )}
                    >
                      {portalTask ? `status: ${portalTaskStatus || "—"}` : "status: —"}
                    </span>
                  </div>

                  {showInviteTarget && (
                    <div className="mt-2 text-[11px] text-slate-500">
                      Target:{" "}
                      <span className="text-slate-200 font-mono">{computedInviteEmail ? computedInviteEmail : "—"}</span>
                      <span className="mx-2 text-slate-700">•</span>
                      Task: <span className="font-mono">provision_portal_access</span>
                    </div>
                  )}

                  <button
                    onClick={runInviteAuthoritative}
                    disabled={!selected || busy !== null}
                    className={cx(
                      "mt-3 w-full rounded-2xl border px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase transition",
                      "disabled:opacity-50 disabled:cursor-not-allowed",
                      "border-amber-400/45 bg-amber-500/10 text-amber-100 hover:bg-amber-500/14"
                    )}
                    title={
                      !selected
                        ? "Select an application first."
                        : portalTask
                        ? `Runs provisioning task: provision_portal_access (status: ${portalTaskStatus || "—"})`
                        : "Creates the portal invite task (RPC) then runs it (Edge Function)."
                    }
                  >
                    {busy === "run_task" || busy === "tasks" ? "Sending…" : portalAlreadySent ? "Re-send Invite" : "Run Invite"}
                  </button>

                  <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
                    <span>attempts: {portalTask?.attempts ?? 0}</span>
                    <span className="text-slate-400">{portalTask?.updated_at ? `updated: ${fmtShort(portalTask.updated_at)}` : ""}</span>
                  </div>
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto px-5 py-5 space-y-4">
                {/* Decision */}
                <div className="rounded-2xl border border-slate-800/60 bg-black/12 px-4 py-4">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-slate-200">Decision (RPC)</div>

                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <select
                      value={decisionKind}
                      onChange={(e) => setDecisionKind(e.target.value)}
                      disabled={!selected || busy !== null}
                      className="w-full rounded-2xl border border-slate-700/60 bg-slate-950/20 px-3 py-3 text-[13px] text-slate-100 outline-none focus:border-emerald-400/60 disabled:opacity-50"
                    >
                      <option value="APPROVED">APPROVED</option>
                      <option value="DECLINED">DECLINED</option>
                    </select>

                    <input
                      value={riskTier}
                      onChange={(e) => setRiskTier(e.target.value)}
                      disabled={!selected || busy !== null}
                      placeholder="risk_tier (optional)"
                      className="w-full rounded-2xl border border-slate-700/60 bg-slate-950/20 px-3 py-3 text-[13px] text-slate-100 outline-none focus:border-emerald-400/60 disabled:opacity-50"
                    />
                  </div>

                  <textarea
                    value={decisionSummary}
                    onChange={(e) => setDecisionSummary(e.target.value)}
                    disabled={!selected || busy !== null}
                    placeholder="Decision summary (what / why)"
                    className="mt-2 w-full min-h-[92px] resize-none rounded-2xl border border-slate-700/60 bg-slate-950/20 px-4 py-3 text-[13px] text-slate-100 outline-none focus:border-emerald-400/60 disabled:opacity-50"
                  />

                  <textarea
                    value={decisionConditions}
                    onChange={(e) => setDecisionConditions(e.target.value)}
                    disabled={!selected || busy !== null}
                    placeholder="Conditions / reason (optional)"
                    className="mt-2 w-full min-h-[72px] resize-none rounded-2xl border border-slate-700/60 bg-slate-950/20 px-4 py-3 text-[13px] text-slate-100 outline-none focus:border-emerald-400/60 disabled:opacity-50"
                  />

                  <textarea
                    value={riskNotes}
                    onChange={(e) => setRiskNotes(e.target.value)}
                    disabled={!selected || busy !== null}
                    placeholder="risk_notes (optional)"
                    className="mt-2 w-full min-h-[64px] resize-none rounded-2xl border border-slate-700/60 bg-slate-950/20 px-4 py-3 text-[13px] text-slate-100 outline-none focus:border-emerald-400/60 disabled:opacity-50"
                  />

                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button
                      onClick={recordDecision}
                      disabled={!selected || busy !== null}
                      className="rounded-2xl border border-emerald-400/45 bg-emerald-500/12 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-emerald-100 hover:bg-emerald-500/16 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {busy === "decision" ? "Recording…" : "Record"}
                    </button>

                    <button
                      onClick={() => setAdmissionsStatus(decisionKind)}
                      disabled={!selected || busy !== null}
                      className="rounded-2xl border border-slate-700/60 bg-white/[0.03] px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-100 hover:bg-white/[0.05] disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Convenience: set status to match decision (RPC)"
                    >
                      {busy === "status" ? "…" : "Set Status"}
                    </button>
                  </div>

                  <div className="mt-3 text-[11px] text-slate-500">
                    Writes to <span className="font-mono">onboarding_decisions</span>.
                  </div>
                </div>

                {/* Request info */}
                <div className="rounded-2xl border border-slate-800/60 bg-black/12 px-4 py-4">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-amber-100">Request Info (RPC)</div>

                  <textarea
                    value={requestInfoMsg}
                    onChange={(e) => setRequestInfoMsg(e.target.value)}
                    disabled={!selected || busy !== null}
                    placeholder="Message to applicant (what you need / why / deadline)"
                    className="mt-3 w-full min-h-[96px] resize-none rounded-2xl border border-slate-700/60 bg-slate-950/20 px-4 py-3 text-[13px] text-slate-100 outline-none focus:border-amber-400/60 disabled:opacity-50"
                  />

                  <textarea
                    value={requestInfoFields}
                    onChange={(e) => setRequestInfoFields(e.target.value)}
                    disabled={!selected || busy !== null}
                    placeholder='Optional JSON overrides: {"channels":["email"],"due_at":"2026-01-10T17:00:00Z","next_status":"needs_info"}'
                    className="mt-2 w-full min-h-[72px] resize-none rounded-2xl border border-slate-700/60 bg-slate-950/20 px-4 py-3 text-[12px] text-slate-100 outline-none focus:border-amber-400/60 disabled:opacity-50 font-mono"
                  />

                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button
                      onClick={requestInfo}
                      disabled={!selected || busy !== null}
                      className="rounded-2xl border border-amber-400/45 bg-amber-500/12 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-amber-100 hover:bg-amber-500/16 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {busy === "info" ? "Sending…" : "Request Info"}
                    </button>

                    <button
                      onClick={() => setAdmissionsStatus("NEEDS_INFO")}
                      disabled={!selected || busy !== null}
                      className="rounded-2xl border border-slate-700/60 bg-white/[0.03] px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-100 hover:bg-white/[0.05] disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {busy === "status" ? "…" : "Mark Needs Info"}
                    </button>
                  </div>

                  <div className="mt-3 text-[11px] text-slate-500">
                    Writes to <span className="font-mono">onboarding_events</span>.
                  </div>
                </div>

                {/* Provisioning tasks (NEW UI) */}
                <div className="rounded-2xl border border-slate-800/60 bg-black/12 px-4 py-4">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-[11px] uppercase tracking-[0.22em] text-sky-100">Provisioning Tasks (RPC)</div>
                      <div className="mt-1 text-[12px] text-slate-500">Select tasks, edit details, then create (server stores tasks).</div>
                    </div>
                    <span className="rounded-full border border-slate-700/60 bg-white/[0.03] px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-200">
                      selected: {selectedTaskCount}
                    </span>
                  </div>

                  {/* Template quick-add */}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {TASK_TEMPLATES.map((tpl) => (
                      <button
                        key={tpl.task_key}
                        type="button"
                        onClick={() => addTemplate(tpl)}
                        className="rounded-full border border-slate-700/60 bg-slate-950/15 px-3 py-2 text-[10px] font-semibold tracking-[0.16em] uppercase text-slate-200 hover:bg-white/[0.05]"
                        title={tpl.notes}
                      >
                        + {tpl.title}
                      </button>
                    ))}
                  </div>

                  <div className="mt-3 grid grid-cols-3 gap-2">
                    <button
                      type="button"
                      onClick={openNewTaskModal}
                      disabled={busy !== null}
                      className="rounded-2xl border border-sky-400/35 bg-sky-500/10 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-sky-100 hover:bg-sky-500/14 disabled:opacity-50"
                    >
                      Add Custom
                    </button>

                    <button
                      type="button"
                      onClick={resetDraftsToDefault}
                      disabled={busy !== null}
                      className="rounded-2xl border border-slate-700/60 bg-white/[0.03] px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-100 hover:bg-white/[0.05] disabled:opacity-50"
                    >
                      Reset Defaults
                    </button>

                    <button
                      type="button"
                      onClick={createProvisioningTasks}
                      disabled={!selected || busy !== null}
                      className="rounded-2xl border border-emerald-400/35 bg-emerald-500/10 px-3 py-3 text-center text-[11px] font-semibold tracking-[0.18em] uppercase text-emerald-100 hover:bg-emerald-500/14 disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Creates tasks via admissions_create_provisioning_tasks (RPC)"
                    >
                      {busy === "tasks" ? "Creating…" : "Create Tasks"}
                    </button>
                  </div>

                  {/* Draft list */}
                  <div className="mt-4 space-y-2">
                    {taskDrafts.length === 0 ? (
                      <div className="text-[12px] text-slate-400">No task drafts.</div>
                    ) : (
                      taskDrafts.map((t, ix) => (
                        <div key={`${t.task_key}-${ix}`} className="rounded-2xl border border-slate-800/60 bg-black/10 px-4 py-4">
                          <div className="flex items-start justify-between gap-3">
                            <label className="flex items-start gap-3 min-w-0">
                              <input
                                type="checkbox"
                                checked={t.enabled}
                                onChange={() => toggleTaskEnabled(ix)}
                                className="mt-1 h-4 w-4 accent-amber-300"
                              />
                              <div className="min-w-0">
                                <div className="text-[13px] font-semibold text-slate-100 truncate">{t.title || "(untitled task)"}</div>
                                <div className="mt-1 text-[11px] text-slate-500 font-mono truncate">{normalizeTaskKey(t.task_key || t.title)}</div>
                              </div>
                            </label>

                            <div className="shrink-0 flex items-center gap-2">
                              <span
                                className={cx(
                                  "rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.18em]",
                                  t.required ? "border-amber-400/35 bg-amber-500/10 text-amber-100" : "border-slate-700/60 bg-white/[0.03] text-slate-200"
                                )}
                              >
                                {t.required ? "Required" : "Optional"}
                              </span>

                              <button
                                type="button"
                                onClick={() => removeDraft(ix)}
                                disabled={busy !== null}
                                className="rounded-full border border-slate-700/60 bg-slate-950/15 px-3 py-2 text-[10px] font-semibold tracking-[0.16em] uppercase text-slate-200 hover:bg-white/[0.05] disabled:opacity-50"
                              >
                                Remove
                              </button>
                            </div>
                          </div>

                          <div className="mt-3 grid grid-cols-2 gap-2">
                            <input
                              value={t.title}
                              onChange={(e) => setTaskField(ix, { title: e.target.value })}
                              disabled={busy !== null}
                              className="w-full rounded-2xl border border-slate-700/60 bg-slate-950/20 px-3 py-3 text-[13px] text-slate-100 outline-none focus:border-sky-400/60 disabled:opacity-50"
                              placeholder="Title"
                            />

                            <input
                              value={t.task_key}
                              onChange={(e) => setTaskField(ix, { task_key: e.target.value })}
                              disabled={busy !== null}
                              className="w-full rounded-2xl border border-slate-700/60 bg-slate-950/20 px-3 py-3 text-[12px] text-slate-100 outline-none focus:border-sky-400/60 disabled:opacity-50 font-mono"
                              placeholder="task_key"
                            />
                          </div>

                          <textarea
                            value={t.notes}
                            onChange={(e) => setTaskField(ix, { notes: e.target.value })}
                            disabled={busy !== null}
                            className="mt-2 w-full min-h-[72px] resize-none rounded-2xl border border-slate-700/60 bg-slate-950/20 px-4 py-3 text-[13px] text-slate-100 outline-none focus:border-sky-400/60 disabled:opacity-50"
                            placeholder="Notes (what the applicant must provide)"
                          />

                          <div className="mt-2 grid grid-cols-2 gap-2">
                            <label className="flex items-center gap-3 rounded-2xl border border-slate-800/60 bg-black/10 px-4 py-3">
                              <input
                                type="checkbox"
                                checked={t.required}
                                onChange={(e) => setTaskField(ix, { required: e.target.checked })}
                                className="h-4 w-4 accent-amber-300"
                              />
                              <span className="text-[12px] text-slate-200">
                                Required <span className="text-slate-500">(unchecked = optional)</span>
                              </span>
                            </label>

                            <div className="rounded-2xl border border-slate-800/60 bg-black/10 px-4 py-3">
                              <div className="text-[10px] uppercase tracking-[0.22em] text-slate-400">Channels</div>
                              <div className="mt-2 flex gap-2">
                                <button
                                  type="button"
                                  onClick={() => toggleChannel(ix, "email")}
                                  className={cx(
                                    "rounded-full border px-3 py-2 text-[10px] font-semibold tracking-[0.16em] uppercase",
                                    t.channels.includes("email")
                                      ? "border-emerald-400/45 bg-emerald-500/10 text-emerald-100"
                                      : "border-slate-700/60 bg-slate-950/15 text-slate-200 hover:bg-white/[0.05]"
                                  )}
                                >
                                  Email
                                </button>

                                <button
                                  type="button"
                                  onClick={() => toggleChannel(ix, "sms")}
                                  className={cx(
                                    "rounded-full border px-3 py-2 text-[10px] font-semibold tracking-[0.16em] uppercase",
                                    t.channels.includes("sms")
                                      ? "border-sky-400/45 bg-sky-500/10 text-sky-100"
                                      : "border-slate-700/60 bg-slate-950/15 text-slate-200 hover:bg-white/[0.05]"
                                  )}
                                >
                                  SMS
                                </button>
                              </div>
                            </div>
                          </div>

                          <div className="mt-2 rounded-2xl border border-slate-800/60 bg-black/10 px-4 py-3">
                            <div className="text-[10px] uppercase tracking-[0.22em] text-slate-400">Due (optional)</div>
                            <input
                              type="datetime-local"
                              value={t.due_at ? new Date(t.due_at).toISOString().slice(0, 16) : ""}
                              onChange={(e) => {
                                const raw = e.target.value.trim();
                                const iso = raw ? new Date(raw).toISOString() : null;
                                setTaskField(ix, { due_at: iso });
                              }}
                              disabled={busy !== null}
                              className="mt-2 w-full rounded-2xl border border-slate-700/60 bg-slate-950/20 px-4 py-3 text-[13px] text-slate-100 outline-none focus:border-sky-400/60 disabled:opacity-50"
                            />
                            <div className="mt-2 text-[11px] text-slate-500">Sent to RPC as ISO timestamptz; server decides enforcement.</div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>

                  <div className="mt-3 text-[11px] text-slate-500">
                    Creates rows in <span className="font-mono">onboarding_provisioning_tasks</span>. Run actions below use the existing Edge Function runner.
                  </div>
                </div>

                {/* Activity rails */}
                <div className="rounded-2xl border border-slate-800/60 bg-black/12 px-4 py-4">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-slate-200">Recent Tasks (DB)</div>
                  <div className="mt-3 space-y-2">
                    {!selected ? (
                      <div className="text-[12px] text-slate-400">Select an application.</div>
                    ) : tasks.length === 0 ? (
                      <div className="text-[12px] text-slate-400">No tasks yet.</div>
                    ) : (
                      tasks.slice(0, 12).map((t) => {
                        const st = String(t.status ?? "").toUpperCase();
                        const isRunning = busy === "run_task" && runningTaskId === t.id;
                        const key = normalizeTaskKey(t.task_key ?? "");
                        return (
                          <div key={t.id} className="rounded-2xl border border-slate-800/60 bg-black/10 px-4 py-3">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="text-[12px] text-slate-100 font-semibold truncate">{key || "(task)"}</div>
                                <div className="mt-1 text-[11px] text-slate-500">
                                  created: {fmtShort(t.created_at)} <span className="mx-2 text-slate-700">•</span> attempts: {t.attempts ?? 0}
                                </div>
                              </div>

                              <span className={cx("shrink-0 rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.18em]", taskStatusPill(st))}>
                                {st || "—"}
                              </span>
                            </div>

                            {t.last_error ? (
                              <div className="mt-2 text-[11px] text-rose-200/90 whitespace-pre-wrap">{t.last_error}</div>
                            ) : null}

                            <div className="mt-2 flex items-center justify-between gap-2">
                              <button
                                type="button"
                                onClick={() => runProvisioningTask(t)}
                                disabled={!selected || busy !== null}
                                className="rounded-full border border-amber-400/35 bg-amber-500/10 px-3 py-2 text-[10px] font-semibold tracking-[0.16em] uppercase text-amber-100 hover:bg-amber-500/14 disabled:opacity-50"
                                title="Runs task via Edge Function (no DB updates here)"
                              >
                                {isRunning ? "Running…" : "Run"}
                              </button>

                              <button
                                type="button"
                                onClick={async () => {
                                  try {
                                    await navigator.clipboard.writeText(t.id);
                                    flashInfo("Copied task id.");
                                  } catch {
                                    flashError("Copy failed.");
                                  }
                                }}
                                disabled={!selected}
                                className="rounded-full border border-slate-700/60 bg-slate-950/15 px-3 py-2 text-[10px] font-semibold tracking-[0.16em] uppercase text-slate-200 hover:bg-white/[0.05] disabled:opacity-50"
                              >
                                Copy Task ID
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-800/60 bg-black/12 px-4 py-4">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-slate-200">Recent Decisions</div>
                  <div className="mt-3 space-y-2">
                    {!selected ? (
                      <div className="text-[12px] text-slate-400">Select an application.</div>
                    ) : decisions.length === 0 ? (
                      <div className="text-[12px] text-slate-400">No decisions recorded.</div>
                    ) : (
                      decisions.slice(0, 6).map((d) => (
                        <div key={d.id} className="rounded-2xl border border-slate-800/60 bg-black/10 px-4 py-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-[12px] font-semibold text-slate-100 truncate">{String(d.decision ?? "—").toUpperCase()}</div>
                              <div className="mt-1 text-[11px] text-slate-500">decided: {fmtShort(d.decided_at)}</div>
                            </div>
                            <span className={cx("shrink-0 rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.18em]", statusPill(d.decision))}>
                              {String(d.decision ?? "—").toUpperCase()}
                            </span>
                          </div>
                          {d.summary ? <div className="mt-2 text-[12px] text-slate-300 whitespace-pre-wrap">{d.summary}</div> : null}
                          {d.conditions ? <div className="mt-2 text-[11px] text-slate-500 whitespace-pre-wrap">{d.conditions}</div> : null}
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-800/60 bg-black/12 px-4 py-4">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-slate-200">Recent Events</div>
                  <div className="mt-3 space-y-2">
                    {!selected ? (
                      <div className="text-[12px] text-slate-400">Select an application.</div>
                    ) : events.length === 0 ? (
                      <div className="text-[12px] text-slate-400">No events recorded.</div>
                    ) : (
                      events.slice(0, 10).map((e) => (
                        <div key={e.id} className="rounded-2xl border border-slate-800/60 bg-black/10 px-4 py-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-[11px] font-semibold text-slate-100 uppercase tracking-[0.18em] truncate">
                                {eventTypeLabel(e.event_type)}
                              </div>
                              <div className="mt-1 text-[11px] text-slate-500">{fmtShort(e.created_at)}</div>
                            </div>
                            <span className="rounded-full border border-slate-700/60 bg-white/[0.03] px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-200">
                              {hashShort(e.actor_id)}
                            </span>
                          </div>
                          {e.message ? <div className="mt-2 text-[12px] text-slate-300 whitespace-pre-wrap">{e.message}</div> : null}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>

              <div className="shrink-0 px-5 py-4 border-t border-slate-800/60 text-[11px] text-slate-500 flex items-center justify-between bg-white/[0.02]">
                <span>Admissions mutations are RPC-only.</span>
                <span>Oasis OS · Authority Gateway</span>
              </div>
            </aside>
          </div>
        </div>
      </div>

      {/* Low-presence footer rail */}
      <div
        className="mt-5 rounded-2xl border border-slate-900/80 bg-black/30 px-5 py-4 text-[11px] text-slate-500 flex items-center justify-between"
        style={{ opacity: 0.38 + wake * 0.62, transform: `translateY(${(1 - wake) * 6}px)` }}
      >
        <span className="tracking-[0.18em] uppercase">Verified Intake · Auditable Decisions · Archive Discipline</span>
        <span className="text-slate-600">© {new Date().getFullYear()} Oasis International Holdings</span>
      </div>

      {/* Hard Delete Modal */}
      {deleteOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 px-6">
          <div className="w-full max-w-[640px] rounded-3xl border border-slate-800/70 bg-slate-950/80 shadow-[0_0_90px_rgba(0,0,0,0.6)] overflow-hidden">
            <div className="px-6 py-5 border-b border-slate-800/60 bg-white/[0.02]">
              <div className="text-[11px] uppercase tracking-[0.22em] text-rose-100">Hard Delete (Production)</div>
              <div className="mt-2 text-[13px] text-slate-200">
                This permanently removes the application and its related rows. A tombstone snapshot should exist server-side.
              </div>
              <div className="mt-2 text-[12px] text-slate-400">
                Allowed only when status is <span className="text-slate-100 font-semibold">DECLINED / WITHDRAWN / ARCHIVED</span>.
              </div>
            </div>

            <div className="px-6 py-5 space-y-3">
              <div className="rounded-2xl border border-slate-800/60 bg-black/12 px-4 py-4">
                <div className="text-[11px] uppercase tracking-[0.22em] text-slate-400">Target</div>
                <div className="mt-2 text-[13px] text-slate-100">
                  {(selected?.organization_legal_name || selected?.organization_trade_name || selected?.applicant_email || "—") ?? "—"}
                </div>
                <div className="mt-1 text-[12px] text-slate-400">
                  id: <span className="font-mono">{selected?.id ?? "—"}</span> · status:{" "}
                  <span className="text-slate-100 font-semibold">{(selected?.status ?? "—").toUpperCase()}</span>
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
                className="w-full min-h-[90px] resize-none rounded-2xl border border-slate-700/60 bg-slate-950/20 px-4 py-3 text-[13px] text-slate-100 outline-none focus:border-rose-400/60"
                placeholder="Reason (recommended)."
              />

              <input
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                className="w-full rounded-2xl border border-slate-700/60 bg-slate-950/20 px-4 py-3 text-[13px] text-slate-100 outline-none focus:border-rose-400/60"
                placeholder='Type "DELETE" to confirm'
              />
            </div>

            <div className="px-6 py-4 border-t border-slate-800/60 flex items-center justify-between bg-white/[0.02]">
              <button
                onClick={() => {
                  setDeleteOpen(false);
                  setDeleteReason("");
                  setDeleteConfirmText("");
                }}
                className="rounded-full border border-slate-700/70 bg-slate-950/25 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/45"
              >
                Cancel
              </button>

              <button
                onClick={hardDeleteSelected}
                disabled={!selected || !canHardDelete || deleteConfirmText.trim().toUpperCase() !== "DELETE" || busy !== null}
                className="rounded-full border border-rose-400/45 bg-rose-500/10 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-rose-100 hover:bg-rose-500/14 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {busy === "delete" ? "Deleting…" : "Hard Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Task Modal (NEW) */}
      {taskModalOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 px-6">
          <div className="w-full max-w-[720px] rounded-3xl border border-slate-800/70 bg-slate-950/80 shadow-[0_0_90px_rgba(0,0,0,0.6)] overflow-hidden">
            <div className="px-6 py-5 border-b border-slate-800/60 bg-white/[0.02]">
              <div className="text-[11px] uppercase tracking-[0.22em] text-sky-100">Add Provisioning Task</div>
              <div className="mt-2 text-[13px] text-slate-200">Create a task without typing JSON. The UI will generate the RPC payload.</div>
            </div>

            <div className="px-6 py-5 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <input
                  value={newTaskTitle}
                  onChange={(e) => setNewTaskTitle(e.target.value)}
                  className="w-full rounded-2xl border border-slate-700/60 bg-slate-950/20 px-4 py-3 text-[13px] text-slate-100 outline-none focus:border-sky-400/60"
                  placeholder="Title (required)"
                />

                <input
                  value={newTaskKey}
                  onChange={(e) => setNewTaskKey(e.target.value)}
                  className="w-full rounded-2xl border border-slate-700/60 bg-slate-950/20 px-4 py-3 text-[13px] text-slate-100 outline-none focus:border-sky-400/60 font-mono"
                  placeholder="task_key (optional; auto-derived)"
                />
              </div>

              <textarea
                value={newTaskNotes}
                onChange={(e) => setNewTaskNotes(e.target.value)}
                className="w-full min-h-[110px] resize-none rounded-2xl border border-slate-700/60 bg-slate-950/20 px-4 py-3 text-[13px] text-slate-100 outline-none focus:border-sky-400/60"
                placeholder="Notes (what the applicant must provide)"
              />

              <div className="grid grid-cols-2 gap-3">
                <label className="flex items-center gap-3 rounded-2xl border border-slate-800/60 bg-black/10 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={newTaskRequired}
                    onChange={(e) => setNewTaskRequired(e.target.checked)}
                    className="h-4 w-4 accent-amber-300"
                  />
                  <span className="text-[12px] text-slate-200">
                    Required <span className="text-slate-500">(unchecked = optional)</span>
                  </span>
                </label>

                <div className="rounded-2xl border border-slate-800/60 bg-black/10 px-4 py-3">
                  <div className="text-[10px] uppercase tracking-[0.22em] text-slate-400">Channels (delivery later)</div>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={() => setNewTaskChannels((prev) => (prev.includes("email") ? prev.filter((x) => x !== "email") : [...prev, "email"]))}
                      className={cx(
                        "rounded-full border px-3 py-2 text-[10px] font-semibold tracking-[0.16em] uppercase",
                        newTaskChannels.includes("email")
                          ? "border-emerald-400/45 bg-emerald-500/10 text-emerald-100"
                          : "border-slate-700/60 bg-slate-950/15 text-slate-200 hover:bg-white/[0.05]"
                      )}
                    >
                      Email
                    </button>

                    <button
                      type="button"
                      onClick={() => setNewTaskChannels((prev) => (prev.includes("sms") ? prev.filter((x) => x !== "sms") : [...prev, "sms"]))}
                      className={cx(
                        "rounded-full border px-3 py-2 text-[10px] font-semibold tracking-[0.16em] uppercase",
                        newTaskChannels.includes("sms")
                          ? "border-sky-400/45 bg-sky-500/10 text-sky-100"
                          : "border-slate-700/60 bg-slate-950/15 text-slate-200 hover:bg-white/[0.05]"
                      )}
                    >
                      SMS
                    </button>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-800/60 bg-black/10 px-4 py-3">
                <div className="text-[10px] uppercase tracking-[0.22em] text-slate-400">Due (optional)</div>
                <input
                  type="datetime-local"
                  value={newTaskDueAt}
                  onChange={(e) => setNewTaskDueAt(e.target.value)}
                  className="mt-2 w-full rounded-2xl border border-slate-700/60 bg-slate-950/20 px-4 py-3 text-[13px] text-slate-100 outline-none focus:border-sky-400/60"
                />
                <div className="mt-2 text-[11px] text-slate-500">Stored as ISO timestamptz in payload (server decides enforcement).</div>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-slate-800/60 flex items-center justify-between bg-white/[0.02]">
              <button
                onClick={() => setTaskModalOpen(false)}
                className="rounded-full border border-slate-700/70 bg-slate-950/25 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900/45"
              >
                Cancel
              </button>

              <button
                onClick={addCustomTask}
                className="rounded-full border border-sky-400/45 bg-sky-500/12 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-sky-100 hover:bg-sky-500/16"
              >
                Add Task
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
          ? "bg-emerald-500/14 border border-emerald-400/55 text-slate-50"
          : "bg-transparent border border-transparent hover:bg-white/[0.05] text-slate-200"
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
    <div className="rounded-2xl border border-slate-800/60 bg-black/10 px-5 py-5">
      <div className="text-[10px] uppercase tracking-[0.22em] text-slate-400">{title}</div>
      <div className="mt-3 space-y-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-start justify-between gap-6">
            <div className="text-[12px] text-slate-400">{k}</div>
            <div className="text-[13px] text-slate-100 text-right whitespace-pre-wrap max-w-[70%]">{v || "—"}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
