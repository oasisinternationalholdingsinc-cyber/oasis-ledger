```tsx
// src/app/(console-ledger)/ci-onboarding/ci-admissions/page.tsx
"use client";
export const dynamic = "force-dynamic";

/**
 * CI • Admissions (LOCKED CONTRACT — NO REGRESSIONS)
 * ✅ Queue source: public.v_onboarding_admissions_inbox (same as CI-Provisioning)
 * ✅ Lane-safe: tries lane_is_test filter, falls back if view doesn't expose it
 * ✅ Restores ALL authority modals:
 *    - Request Info (RPC: admissions_request_info)
 *    - Create Tasks (RPC: admissions_create_provisioning_tasks) + PRELOADED templates
 *    - Record Decision (RPC: admissions_record_decision)
 *    - Set Status (RPC: admissions_set_status)
 *    - Approve = Record Decision + Set Status approved (two calls; no blur)
 *
 * ✅ Adds (NO wiring changes to RPC names / flow):
 *    - Create Tasks now supports per-task metadata:
 *        due_at (date), required (toggle), notes (text)
 *      while keeping preloaded chips + custom tasks.
 *    - Payload is jsonb array (objects) so portal can display Due/Required/Notes.
 *
 * ❌ Removes any selection of non-existent columns (e.g. request_brief)
 */

import React, { useEffect, useMemo, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";

function cx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function normStatusUpper(s: string | null | undefined) {
  return (s || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
}

// DB enums are lowercase (submitted/needs_info/approved/...)
function statusEnumLower(s: string) {
  return (s || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
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

type MainTab = "INBOX" | "INTAKE" | "ALL" | "ARCHIVED";
type IntakePill = "BOTH" | "INTAKE" | "PROVISIONED";

type ModalKind =
  | "NONE"
  | "REQUEST_INFO"
  | "CREATE_TASKS"
  | "RECORD_DECISION"
  | "SET_STATUS"
  | "APPROVE"
  | "ARCHIVE_APP"
  | "HARD_DELETE_APP";

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
      <div className="absolute left-1/2 top-1/2 w-[94vw] max-w-[620px] -translate-x-1/2 -translate-y-1/2">
        <div className="relative overflow-hidden rounded-3xl border border-white/12 bg-[#070A12]/80 shadow-[0_40px_160px_rgba(0,0,0,0.70)]">
          <div className="pointer-events-none absolute inset-0 opacity-60 [background:radial-gradient(900px_500px_at_70%_-20%,rgba(250,204,21,0.14),transparent_55%),radial-gradient(700px_420px_at_10%_0%,rgba(56,189,248,0.10),transparent_50%)]" />
          <div className="relative border-b border-white/10 p-5">
            <div className="text-[11px] uppercase tracking-[0.28em] text-white/45">
              Authority • Action
            </div>
            <div className="mt-2 text-xl font-semibold text-white/90">{title}</div>
            {subtitle ? <div className="mt-1 text-sm text-white/55">{subtitle}</div> : null}
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
          Mutations are RPC/Functions only • Lane-safe via OsEnv + view lane column when present
        </div>
      </div>
    </div>
  );
}

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

// ---- Task meta model (client-only; sent to RPC as jsonb) ----
type TaskMeta = {
  due_date?: string; // YYYY-MM-DD from <input type="date">
  required?: boolean;
  notes?: string;
};

function taskTokenId(t: string) {
  return (t || "").trim().toUpperCase();
}

function dateToDueAtISO(yyyy_mm_dd: string) {
  const d = (yyyy_mm_dd || "").trim();
  if (!d) return null;
  // stable, lane-agnostic: interpret as end-of-day UTC
  return `${d}T23:59:59.000Z`;
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

  // ---- state ----
  const [apps, setApps] = useState<InboxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [tab, setTab] = useState<MainTab>("INBOX");
  const [intakePill, setIntakePill] = useState<IntakePill>("BOTH");
  const [q, setQ] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // ---- modals ----
  const [modal, setModal] = useState<ModalKind>("NONE");

  // Request Info inputs
  const [reqMessage, setReqMessage] = useState("Please upload the requested evidence so we can complete review.");
  const [reqChannels, setReqChannels] = useState<Array<"email" | "sms">>(["email"]);
  const [reqDays, setReqDays] = useState(7);
  const [reqNextStatus, setReqNextStatus] = useState("needs_info");

  // Tasks inputs
  const [taskList, setTaskList] = useState<string[]>([]);
  const [customTask, setCustomTask] = useState<string>("");
  const [taskMetaById, setTaskMetaById] = useState<Record<string, TaskMeta>>({});

  // Archive / delete inputs
  const [archiveNote, setArchiveNote] = useState<string>("Archived by authority.");
  const [deleteReason, setDeleteReason] = useState<string>("");

  // Decision inputs
  const [decision, setDecision] = useState<"approved" | "declined">("approved");
  const [riskTier, setRiskTier] = useState<string>("low");
  const [decisionSummary, setDecisionSummary] = useState<string>("Approved for onboarding.");
  const [decisionReason, setDecisionReason] = useState<string>("Evidence appears sufficient for admission.");

  // Set status inputs
  const [statusNext, setStatusNext] = useState<string>("in_review");
  const [statusNote, setStatusNote] = useState<string>("");

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

  // ---- preload templates (restored) ----
  const PRELOADED_TASKS: Array<{ label: string; value: string; hint: string }> = [
    { label: "Create entity record", value: "CREATE_ENTITY", hint: "Provision entity row + canonical slug/key" },
    { label: "Create memberships", value: "CREATE_MEMBERSHIPS", hint: "Owner/admin memberships for applicant contact" },
    { label: "Send portal access invite", value: "SEND_PORTAL_INVITE", hint: "Auth-only invite so they can upload evidence" },
    { label: "Evidence checklist", value: "EVIDENCE_CHECKLIST", hint: "Governance + incorporation docs request packet" },
    { label: "Schedule verification", value: "SCHEDULE_VERIFICATION", hint: "Queue hash/verify + registry followup" },
  ];

  const PRELOADED_MAP = useMemo(() => {
    const m = new Map<string, { label: string; value: string; hint: string }>();
    for (const t of PRELOADED_TASKS) m.set(t.value.toUpperCase(), t);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function uniqTasks(xs: string[]) {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of xs) {
      const v = (raw || "").trim();
      if (!v) continue;
      const k = v.toUpperCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(v);
    }
    return out;
  }

  function ensureMetaDefaultsForTask(taskValue: string) {
    const id = taskTokenId(taskValue);
    if (!id) return;
    setTaskMetaById((prev) => {
      if (prev[id]) return prev;
      return { ...prev, [id]: { required: true } };
    });
  }

  function toggleTask(v: string) {
    const key = (v || "").trim();
    if (!key) return;
    setTaskList((prev) => {
      const has = prev.some((x) => (x || "").trim().toUpperCase() === key.toUpperCase());
      if (has) return prev.filter((x) => (x || "").trim().toUpperCase() !== key.toUpperCase());
      return uniqTasks([...prev, key]);
    });
    ensureMetaDefaultsForTask(key);
  }

  function addCustomTask() {
    const v = (customTask || "").trim();
    if (!v) return;
    setTaskList((prev) => uniqTasks([...prev, v]));
    ensureMetaDefaultsForTask(v);
    setCustomTask("");
  }

  function removeTask(v: string) {
    const keyUpper = (v || "").trim().toUpperCase();
    setTaskList((prev) => prev.filter((x) => (x || "").trim().toUpperCase() !== keyUpper));
    setTaskMetaById((prev) => {
      const next = { ...prev };
      delete next[keyUpper];
      return next;
    });
  }

  function resetModalPayload(kind: ModalKind) {
    // keep defaults calm + deterministic; preload from selected when possible
    setNote(null);

    if (kind === "REQUEST_INFO") {
      setReqMessage("Please upload the requested evidence so we can complete review.");
      setReqChannels(["email"]);
      setReqDays(7);
      setReqNextStatus("needs_info");
    }

    if (kind === "CREATE_TASKS") {
      // default preloaded suggestions (restored)
      const defaults = ["SEND_PORTAL_INVITE", "EVIDENCE_CHECKLIST"];
      setTaskList(defaults);
      setCustomTask("");
      // meta defaults (required true, due/notes empty)
      const base: Record<string, TaskMeta> = {};
      for (const t of defaults) base[taskTokenId(t)] = { required: true };
      setTaskMetaById(base);
    }

    if (kind === "RECORD_DECISION") {
      setDecision("approved");
      setRiskTier("low");
      setDecisionSummary("Approved for onboarding.");
      setDecisionReason("Evidence appears sufficient for admission.");
    }

    if (kind === "APPROVE") {
      // Approve is a composed action: record_decision + set_status(approved)
      setDecision("approved");
      setRiskTier("low");
      setDecisionSummary("Approved for onboarding.");
      setDecisionReason("Evidence appears sufficient for admission.");
      setStatusNext("approved");
      setStatusNote("Approved by authority.");
    }

    if (kind === "SET_STATUS") {
      const st = normStatusUpper(selected?.status);
      // small smart default: if submitted -> in_review, otherwise leave in_review
      setStatusNext(st === "SUBMITTED" ? "in_review" : "in_review");
      setStatusNote("");
    }

    if (kind === "ARCHIVE_APP") {
      setArchiveNote("Archived by authority.");
    }

    if (kind === "HARD_DELETE_APP") {
      setDeleteReason("");
    }
  }

  function openModal(kind: ModalKind) {
    resetModalPayload(kind);
    setModal(kind);
  }

  // ---- load queue (MUST MATCH CI-Provisioning) ----
  useEffect(() => {
    let alive = true;

    (async () => {
      setLoading(true);
      setErr(null);

      try {
        // IMPORTANT: only select columns that actually exist on the view
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
    let list = apps;

    // Main tabs
    if (tab === "INBOX") {
      // Active queue (exclude archived/withdrawn/declined if present)
      list = list.filter((a) => {
        const st = normStatusUpper(a.status);
        return !["ARCHIVED", "WITHDRAWN", "DECLINED"].includes(st);
      });
    } else if (tab === "ARCHIVED") {
      list = list.filter((a) => normStatusUpper(a.status) === "ARCHIVED");
    } else if (tab === "INTAKE") {
      // intake pills (restored)
      list = list.filter((a) => {
        const st = normStatusUpper(a.status);
        const isProvisioned = st === "PROVISIONED";
        const isIntake = ["SUBMITTED", "TRIAGE", "IN_REVIEW", "NEEDS_INFO", "APPROVED", "PROVISIONING"].includes(st);

        if (intakePill === "BOTH") return isIntake || isProvisioned;
        if (intakePill === "INTAKE") return isIntake && !isProvisioned;
        return isProvisioned;
      });
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
  }, [apps, tab, intakePill, q]);

  // ---------------------------
  // RPC Actions (NO REGRESSION)
  // ---------------------------

  async function rpcRequestInfo() {
    if (!selected) return;
    setBusy(true);
    setNote(null);
    try {
      const { error } = await supabase.rpc("admissions_request_info", {
        p_application_id: selected.id,
        p_message: reqMessage,
        p_channels: reqChannels,
        p_due_at: new Date(Date.now() + reqDays * 24 * 60 * 60 * 1000).toISOString(),
        p_next_status: statusEnumLower(reqNextStatus),
      });
      if (error) throw error;

      setNote("Request sent. Application updated to NEEDS_INFO (if configured).");
      setModal("NONE");
      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "Request Info failed.");
    } finally {
      setBusy(false);
    }
  }

  function taskDisplay(t: string) {
    const raw = (t || "").trim();
    const id = taskTokenId(raw);
    const pre = PRELOADED_MAP.get(id);
    return {
      id,
      raw,
      isPreloaded: Boolean(pre),
      label: pre?.label || raw,
      hint: pre?.hint || "",
      // for preloaded: stable key; for custom: let SQL generate by sending key='custom'
      keyForRPC: pre ? pre.value : "custom",
      titleForRPC: pre ? pre.label : raw,
    };
  }

  async function rpcCreateTasks() {
    if (!selected) return;

    const rawTasks = (taskList || []).map((t) => (t || "").trim()).filter(Boolean);
    if (!rawTasks.length) {
      alert("Add at least one task.");
      return;
    }

    // Build jsonb array of task objects:
    // [{key,title,notes,due_at,required}, ...]
    const payload = rawTasks.map((t) => {
      const d = taskDisplay(t);
      const meta = taskMetaById[d.id] || {};
      const notes = (meta.notes || "").trim();
      const due_at = meta.due_date ? dateToDueAtISO(meta.due_date) : null;
      const required = meta.required ?? true;

      return {
        key: d.keyForRPC,                // preloaded key or "custom"
        title: d.titleForRPC,            // what client sees
        notes: notes || null,
        due_at,
        required,
      };
    });

    setBusy(true);
    setNote(null);
    try {
      const { error } = await supabase.rpc("admissions_create_provisioning_tasks", {
        p_application_id: selected.id,
        p_tasks: payload, // ✅ jsonb array
      });
      if (error) throw error;

      setNote("Tasks created (with due date / required / notes).");
      setModal("NONE");
      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "Create Tasks failed.");
    } finally {
      setBusy(false);
    }
  }

  async function rpcRecordDecisionOnly() {
    if (!selected) return;
    setBusy(true);
    setNote(null);
    try {
      const { error } = await supabase.rpc("admissions_record_decision", {
        p_application_id: selected.id,
        p_decision: decision, // enum should accept 'approved'/'declined' (lowercase)
        p_risk_tier: riskTier, // must match your enum labels
        p_summary: decisionSummary,
        p_reason: decisionReason,
      });
      if (error) throw error;

      setNote("Decision recorded.");
      setModal("NONE");
      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "Record Decision failed.");
    } finally {
      setBusy(false);
    }
  }

  async function rpcSetStatusOnly() {
    if (!selected) return;
    setBusy(true);
    setNote(null);
    try {
      const { error } = await supabase.rpc("admissions_set_status", {
        p_application_id: selected.id,
        p_next_status: statusEnumLower(statusNext),
        p_note: statusNote || null,
      });
      if (error) throw error;

      setNote(`Status set → ${statusNext.toUpperCase()}`);
      setModal("NONE");
      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "Set Status failed.");
    } finally {
      setBusy(false);
    }
  }

  async function rpcArchiveApplication() {
    if (!selected) return;
    setBusy(true);
    setNote(null);
    try {
      const { error } = await supabase.rpc("admissions_set_status", {
        p_application_id: selected.id,
        p_next_status: "archived",
        p_note: (archiveNote || "").trim() || "Archived by authority.",
      });
      if (error) throw error;

      setNote("Application archived.");
      setModal("NONE");
      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "Archive failed.");
    } finally {
      setBusy(false);
    }
  }

  async function rpcHardDeleteApplication() {
    if (!selected) return;

    const reason = (deleteReason || "").trim();
    if (!reason) {
      alert("Reason is required for hard delete.");
      return;
    }

    setBusy(true);
    setNote(null);
    try {
      const { error } = await supabase.rpc("admissions_delete_application", {
        p_application_id: selected.id,
        p_reason: reason,
      });
      if (error) throw error;

      setNote("Application deleted.");
      setModal("NONE");
      setSelectedId(null);
      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "Hard delete failed.");
    } finally {
      setBusy(false);
    }
  }

  async function rpcApproveComposed() {
    // ✅ APPROVE = record_decision + set_status(approved)
    if (!selected) return;
    setBusy(true);
    setNote(null);
    try {
      const { error: e1 } = await supabase.rpc("admissions_record_decision", {
        p_application_id: selected.id,
        p_decision: "approved",
        p_risk_tier: riskTier,
        p_summary: decisionSummary,
        p_reason: decisionReason,
      });
      if (e1) throw e1;

      const { error: e2 } = await supabase.rpc("admissions_set_status", {
        p_application_id: selected.id,
        p_next_status: "approved",
        p_note: statusNote || "Approved by authority.",
      });
      if (e2) throw e2;

      setNote("Approved: decision recorded + status set to APPROVED.");
      setModal("NONE");
      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "Approve failed.");
    } finally {
      setBusy(false);
    }
  }

  const statusBadge = (stRaw: string | null) => {
    const st = normStatusUpper(stRaw);
    const base = "rounded-full border px-3 py-1 text-[11px] font-medium";
    if (st === "NEEDS_INFO") return `${base} border-amber-300/18 bg-amber-400/10 text-amber-100/90`;
    if (st === "IN_REVIEW" || st === "UNDER_REVIEW" || st === "TRIAGE")
      return `${base} border-sky-300/18 bg-sky-400/10 text-sky-100/90`;
    if (st === "APPROVED" || st === "PROVISIONING")
      return `${base} border-amber-300/18 bg-amber-400/10 text-amber-100/90`;
    if (st === "PROVISIONED") return `${base} border-emerald-300/18 bg-emerald-400/10 text-emerald-100/90`;
    if (st === "ARCHIVED") return `${base} border-white/10 bg-white/5 text-white/55`;
    return `${base} border-white/10 bg-white/5 text-white/70`;
  };

  // modal routing
  const modalOpen = modal !== "NONE";

  const modalTitle = useMemo(() => {
    if (modal === "REQUEST_INFO") return "Request additional information";
    if (modal === "CREATE_TASKS") return "Create provisioning tasks";
    if (modal === "RECORD_DECISION") return "Record authority decision";
    if (modal === "SET_STATUS") return "Set application status";
    if (modal === "APPROVE") return "Approve application";
    if (modal === "ARCHIVE_APP") return "Archive application";
    if (modal === "HARD_DELETE_APP") return "Hard delete application";
    return "Authority action";
  }, [modal]);

  const modalConfirm = useMemo(() => {
    if (busy) return "Working…";
    if (modal === "REQUEST_INFO") return "Send request";
    if (modal === "CREATE_TASKS") return "Create tasks";
    if (modal === "RECORD_DECISION") return "Record decision";
    if (modal === "SET_STATUS") return "Set status";
    if (modal === "APPROVE") return "Approve";
    if (modal === "ARCHIVE_APP") return "Archive";
    if (modal === "HARD_DELETE_APP") return "Delete";
    return "Confirm";
  }, [modal, busy]);

  const modalDanger = modal === "HARD_DELETE_APP";

  async function onModalConfirm() {
    if (modal === "REQUEST_INFO") return rpcRequestInfo();
    if (modal === "CREATE_TASKS") return rpcCreateTasks();
    if (modal === "RECORD_DECISION") return rpcRecordDecisionOnly();
    if (modal === "SET_STATUS") return rpcSetStatusOnly();
    if (modal === "APPROVE") return rpcApproveComposed();
    if (modal === "ARCHIVE_APP") return rpcArchiveApplication();
    if (modal === "HARD_DELETE_APP") return rpcHardDeleteApplication();
  }

  function setTaskMeta(taskValue: string, patch: Partial<TaskMeta>) {
    const id = taskTokenId(taskValue);
    if (!id) return;
    setTaskMetaById((prev) => {
      const cur = prev[id] || { required: true };
      return { ...prev, [id]: { ...cur, ...patch } };
    });
  }

  // ---------------------------
  // UI
  // ---------------------------
  return (
    <div className="h-full w-full">
      <div className="mx-auto w-full max-w-[1400px] px-4 pb-10 pt-6">
        {/* Header */}
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
          {/* Left: inbox */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="text-xs font-semibold tracking-wide text-white/80">Inbox</div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <Pill active={tab === "INBOX"} onClick={() => setTab("INBOX")}>
                    Inbox
                  </Pill>
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

                {tab === "INTAKE" ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Pill active={intakePill === "BOTH"} onClick={() => setIntakePill("BOTH")}>
                      BOTH
                    </Pill>
                    <Pill active={intakePill === "INTAKE"} onClick={() => setIntakePill("INTAKE")}>
                      INTAKE
                    </Pill>
                    <Pill active={intakePill === "PROVISIONED"} onClick={() => setIntakePill("PROVISIONED")}>
                      PROVISIONED
                    </Pill>
                  </div>
                ) : null}

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
                              <div className="mt-1 truncate text-xs text-white/45">{a.applicant_email || "—"}</div>
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
                Source: public.v_onboarding_admissions_inbox • entity_slug={entityKey} • lane={isTest ? "SANDBOX" : "RoT"}
              </div>
            </div>
          </div>

          {/* Middle: application */}
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

                    <div className="rounded-2xl border border-white/10 bg-black/18 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-xs font-semibold tracking-wide text-white/80">Metadata</div>
                        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-medium text-white/60">
                          jsonb
                        </span>
                      </div>

                      <div className="mt-3 space-y-3">
                        <Row k="source" v={meta?.source ? String(meta.source) : "—"} />
                        <Row k="notes" v={meta?.notes ? String(meta.notes) : "—"} />

                        <div className="mt-3 rounded-2xl border border-white/10 bg-black/25 p-3">
                          <div className="text-[10px] uppercase tracking-[0.22em] text-white/35">raw</div>
                          <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-white/70">
                            {safePrettyJSON(selected.metadata)}
                          </pre>
                        </div>
                      </div>
                    </div>

                    {note ? (
                      <div className="rounded-2xl border border-white/10 bg-black/20 p-3 text-xs text-white/70">
                        {note}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right: authority */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="text-xs font-semibold tracking-wide text-white/80">Authority Panel</div>
                <div className="mt-1 truncate text-sm text-white/60">Review • Requests • Tasks • Decisions</div>
              </div>

              <div className="p-4">
                {!selected ? (
                  <div className="text-sm text-white/50">Select an application to access authority actions.</div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <button
                      onClick={() => openModal("REQUEST_INFO")}
                      disabled={busy}
                      className={cx(
                        "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                        busy
                          ? "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                          : "border-sky-300/18 bg-sky-400/10 text-sky-100 hover:bg-sky-400/14"
                      )}
                    >
                      Request Info
                    </button>

                    <button
                      onClick={() => openModal("CREATE_TASKS")}
                      disabled={busy}
                      className={cx(
                        "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                        busy
                          ? "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                          : "border-white/10 bg-white/5 text-white/85 hover:border-amber-300/18 hover:bg-white/7"
                      )}
                    >
                      Create Tasks
                    </button>

                    <button
                      onClick={() => openModal("RECORD_DECISION")}
                      disabled={busy}
                      className={cx(
                        "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                        busy
                          ? "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                          : "border-white/10 bg-white/5 text-white/85 hover:border-amber-300/18 hover:bg-white/7"
                      )}
                    >
                      Record Decision
                    </button>

                    <button
                      onClick={() => openModal("SET_STATUS")}
                      disabled={busy}
                      className={cx(
                        "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                        busy
                          ? "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                          : "border-white/10 bg-white/5 text-white/85 hover:border-amber-300/18 hover:bg-white/7"
                      )}
                    >
                      Set Status
                    </button>

                    <div className="mt-2 h-px w-full bg-white/10" />

                    <button
                      onClick={() => openModal("APPROVE")}
                      disabled={busy}
                      className={cx(
                        "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                        busy
                          ? "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                          : "border-amber-300/20 bg-amber-400/12 text-amber-100 hover:bg-amber-400/16"
                      )}
                    >
                      Approve (Decision + Status)
                    </button>

                    {/* ✅ Lifecycle section (Archive + Hard Delete) */}
                    <div className="mt-3 rounded-2xl border border-white/10 bg-black/18 p-4">
                      <div className="text-[10px] uppercase tracking-[0.22em] text-white/35">Lifecycle</div>
                      <div className="mt-3 flex flex-col gap-2">
                        <button
                          onClick={() => openModal("ARCHIVE_APP")}
                          disabled={busy}
                          className={cx(
                            "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                            busy
                              ? "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                              : "border-white/10 bg-white/5 text-white/85 hover:border-amber-300/18 hover:bg-white/7"
                          )}
                        >
                          Archive Application
                        </button>

                        {(() => {
                          const st = normStatusUpper(selected.status);
                          const disabled = busy || ["PROVISIONED", "PROVISIONING"].includes(st);

                          return (
                            <div>
                              <button
                                onClick={() => openModal("HARD_DELETE_APP")}
                                disabled={disabled}
                                className={cx(
                                  "w-full rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                                  disabled
                                    ? "cursor-not-allowed border-rose-300/10 bg-rose-500/5 text-rose-200/30"
                                    : "border-rose-300/20 bg-rose-500/12 text-rose-100 hover:bg-rose-500/16"
                                )}
                              >
                                Hard Delete (Application Only)
                              </button>

                              {["PROVISIONED", "PROVISIONING"].includes(st) ? (
                                <div className="mt-2 text-xs text-white/45">
                                  Disabled: identity may already exist. Use{" "}
                                  <span className="text-white/70 font-semibold">Archive</span>.
                                </div>
                              ) : null}
                            </div>
                          );
                        })()}
                      </div>
                    </div>

                    <div className="mt-2 rounded-2xl border border-white/10 bg-black/18 p-4 text-sm text-white/60">
                      <div className="font-semibold text-white/80">No regressions</div>
                      <div className="mt-1">
                        Approve logs a decision{" "}
                        <span className="text-white/85 font-semibold">and</span> sets status to approved.
                        “Set Status” remains a separate operational control.
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* footer */}
        <div className="mt-5 text-[10px] text-white/35">
          Source: public.v_onboarding_admissions_inbox • entity_slug={entityKey} • lane={isTest ? "SANDBOX" : "RoT"}
        </div>
      </div>

      {/* MODAL BODY */}
      <OsModal
        open={modalOpen}
        title={modalTitle}
        subtitle={selected ? appTitle : undefined}
        confirmText={modalConfirm}
        cancelText="Cancel"
        danger={modalDanger}
        busy={busy}
        onClose={() => (!busy ? setModal("NONE") : null)}
        onConfirm={onModalConfirm}
      >
        {modal === "REQUEST_INFO" ? (
          <div className="space-y-3">
            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <div className="text-xs uppercase tracking-[0.22em] text-white/35">message</div>
              <textarea
                value={reqMessage}
                onChange={(e) => setReqMessage(e.target.value)}
                className="mt-2 w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white/85 outline-none focus:border-amber-300/25"
                rows={4}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <div className="text-xs uppercase tracking-[0.22em] text-white/35">channels</div>
                <div className="mt-2 flex gap-2">
                  {(["email", "sms"] as const).map((c) => {
                    const active = reqChannels.includes(c);
                    return (
                      <button
                        key={c}
                        onClick={() =>
                          setReqChannels((prev) =>
                            active ? prev.filter((x) => x !== c) : [...prev, c]
                          )
                        }
                        className={cx(
                          "rounded-full border px-3 py-1 text-[11px] font-medium transition",
                          active
                            ? "border-amber-300/20 bg-amber-400/12 text-amber-100"
                            : "border-white/10 bg-white/5 text-white/70 hover:bg-white/7"
                        )}
                      >
                        {c.toUpperCase()}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <div className="text-xs uppercase tracking-[0.22em] text-white/35">due</div>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    value={reqDays}
                    onChange={(e) => setReqDays(Math.max(1, Number(e.target.value || 7)))}
                    className="w-20 rounded-xl border border-white/10 bg-black/25 px-3 py-2 text-sm text-white/85 outline-none focus:border-amber-300/25"
                  />
                  <div className="text-sm text-white/65">days</div>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <div className="text-xs uppercase tracking-[0.22em] text-white/35">next status</div>
              <input
                value={reqNextStatus}
                onChange={(e) => setReqNextStatus(e.target.value)}
                placeholder="needs_info"
                className="mt-2 w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-2 text-sm text-white/85 outline-none focus:border-amber-300/25"
              />
              <div className="mt-2 text-xs text-white/45">
                Sent to RPC as lowercase enum (e.g. <span className="text-white/65">needs_info</span>).
              </div>
            </div>
          </div>
        ) : null}

        {modal === "CREATE_TASKS" ? (
          <div className="space-y-3">
            {/* Preloaded chips */}
            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <div className="text-xs uppercase tracking-[0.22em] text-white/35">preloaded tasks</div>
              <div className="mt-3 flex flex-wrap gap-2">
                {PRELOADED_TASKS.map((t) => {
                  const active = taskList.some((x) => taskTokenId(x) === t.value.toUpperCase());
                  return (
                    <button
                      key={t.value}
                      onClick={() => toggleTask(t.value)}
                      className={cx(
                        "rounded-full border px-3 py-1 text-[11px] font-medium transition",
                        active
                          ? "border-amber-300/20 bg-amber-400/12 text-amber-100"
                          : "border-white/10 bg-white/5 text-white/70 hover:bg-white/7"
                      )}
                      title={t.hint}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Custom task input */}
            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <div className="text-xs uppercase tracking-[0.22em] text-white/35">custom task</div>
              <div className="mt-2 flex items-center gap-2">
                <input
                  value={customTask}
                  onChange={(e) => setCustomTask(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addCustomTask();
                    }
                  }}
                  placeholder="e.g. Driver License Verification, Corporate Profile, Director List…"
                  className="w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-2 text-sm text-white/85 placeholder:text-white/35 outline-none focus:border-amber-300/25"
                />
                <button
                  type="button"
                  onClick={addCustomTask}
                  className="shrink-0 rounded-full border border-amber-300/20 bg-amber-400/12 px-4 py-2 text-xs font-semibold text-amber-100 hover:bg-amber-400/16"
                >
                  Add
                </button>
              </div>
              <div className="mt-2 text-xs text-white/45">
                Custom tasks are treated as first-class evidence requests. You can set due date, required, and notes below.
              </div>
            </div>

            {/* Selected (upgraded: metadata per task) */}
            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs uppercase tracking-[0.22em] text-white/35">selected</div>
                <div className="text-[11px] text-white/45">
                  {taskList.length ? `${taskList.length} selected` : "—"}
                </div>
              </div>

              {taskList.length ? (
                <div className="mt-3 space-y-2">
                  {taskList.map((t) => {
                    const d = taskDisplay(t);
                    const m = taskMetaById[d.id] || { required: true };

                    return (
                      <div
                        key={d.id}
                        className="rounded-2xl border border-white/10 bg-black/25 p-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold text-white/85">{d.label}</div>
                            <div className="mt-1 text-[11px] text-white/45">
                              {d.isPreloaded ? (
                                <>
                                  Key: <span className="text-white/70 font-semibold">{d.keyForRPC}</span>
                                </>
                              ) : (
                                <>
                                  Key: <span className="text-white/70 font-semibold">custom (auto)</span>
                                </>
                              )}
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={() => removeTask(t)}
                            className="shrink-0 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-medium text-white/70 hover:border-white/16 hover:bg-white/7"
                            title="Remove"
                          >
                            Remove <span className="ml-1 text-white/35">×</span>
                          </button>
                        </div>

                        <div className="mt-3 grid grid-cols-12 gap-2">
                          {/* Required */}
                          <div className="col-span-12 sm:col-span-4">
                            <div className="text-[10px] uppercase tracking-[0.22em] text-white/35">
                              required
                            </div>
                            <button
                              type="button"
                              onClick={() => setTaskMeta(t, { required: !(m.required ?? true) })}
                              className={cx(
                                "mt-2 w-full rounded-2xl border px-3 py-2 text-xs font-semibold transition",
                                (m.required ?? true)
                                  ? "border-amber-300/18 bg-amber-400/10 text-amber-100 hover:bg-amber-400/14"
                                  : "border-white/10 bg-white/5 text-white/70 hover:bg-white/7 hover:border-white/15"
                              )}
                            >
                              {(m.required ?? true) ? "Required" : "Optional"}
                            </button>
                          </div>

                          {/* Due date */}
                          <div className="col-span-12 sm:col-span-4">
                            <div className="text-[10px] uppercase tracking-[0.22em] text-white/35">
                              due date
                            </div>
                            <input
                              type="date"
                              value={m.due_date || ""}
                              onChange={(e) => setTaskMeta(t, { due_date: e.target.value })}
                              className="mt-2 w-full rounded-2xl border border-white/10 bg-black/25 px-3 py-2 text-xs text-white/85 outline-none focus:border-amber-300/25"
                            />
                          </div>

                          {/* Notes */}
                          <div className="col-span-12 sm:col-span-4">
                            <div className="text-[10px] uppercase tracking-[0.22em] text-white/35">
                              notes
                            </div>
                            <input
                              value={m.notes || ""}
                              onChange={(e) => setTaskMeta(t, { notes: e.target.value })}
                              placeholder="e.g. clear photo, both sides"
                              className="mt-2 w-full rounded-2xl border border-white/10 bg-black/25 px-3 py-2 text-xs text-white/85 placeholder:text-white/35 outline-none focus:border-amber-300/25"
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="mt-2 text-sm text-white/60">—</div>
              )}

              <div className="mt-3 text-xs text-white/45">
                RPC receives a jsonb[] of task objects (key/title/required/due_at/notes). Portal will display due date and notes.
              </div>
            </div>

            {/* small safety note */}
            <div className="rounded-2xl border border-white/10 bg-black/18 p-4 text-xs text-white/55">
              <span className="text-white/75 font-semibold">No regression:</span> preloaded chips still work exactly the same.
              This only adds optional metadata so clients see <span className="text-white/75 font-semibold">Due</span> and <span className="text-white/75 font-semibold">Required</span>.
            </div>
          </div>
        ) : null}

        {modal === "RECORD_DECISION" || modal === "APPROVE" ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <div className="text-xs uppercase tracking-[0.22em] text-white/35">decision</div>
                <select
                  value={decision}
                  onChange={(e) => setDecision(e.target.value as any)}
                  className="mt-2 w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-2 text-sm text-white/85 outline-none focus:border-amber-300/25"
                >
                  <option value="approved">approved</option>
                  <option value="declined">declined</option>
                </select>
              </div>

              <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <div className="text-xs uppercase tracking-[0.22em] text-white/35">risk tier</div>
                <input
                  value={riskTier}
                  onChange={(e) => setRiskTier(e.target.value)}
                  placeholder="low"
                  className="mt-2 w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-2 text-sm text-white/85 outline-none focus:border-amber-300/25"
                />
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <div className="text-xs uppercase tracking-[0.22em] text-white/35">summary</div>
              <input
                value={decisionSummary}
                onChange={(e) => setDecisionSummary(e.target.value)}
                className="mt-2 w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-2 text-sm text-white/85 outline-none focus:border-amber-300/25"
              />
            </div>

            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <div className="text-xs uppercase tracking-[0.22em] text-white/35">reason</div>
              <textarea
                value={decisionReason}
                onChange={(e) => setDecisionReason(e.target.value)}
                className="mt-2 w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white/85 outline-none focus:border-amber-300/25"
                rows={4}
              />
            </div>

            {modal === "APPROVE" ? (
              <div className="rounded-2xl border border-amber-300/15 bg-amber-400/10 p-4">
                <div className="text-xs uppercase tracking-[0.22em] text-amber-100/70">also sets status</div>
                <div className="mt-2 text-sm text-amber-100/90">
                  This action will also call <span className="font-semibold">admissions_set_status → approved</span>.
                </div>
                <div className="mt-3">
                  <div className="text-xs uppercase tracking-[0.22em] text-amber-100/70">status note</div>
                  <input
                    value={statusNote}
                    onChange={(e) => setStatusNote(e.target.value)}
                    className="mt-2 w-full rounded-2xl border border-amber-300/20 bg-black/25 px-4 py-2 text-sm text-amber-50/90 outline-none focus:border-amber-300/35"
                    placeholder="Approved by authority."
                  />
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {modal === "SET_STATUS" ? (
          <div className="space-y-3">
            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <div className="text-xs uppercase tracking-[0.22em] text-white/35">next status</div>
              <input
                value={statusNext}
                onChange={(e) => setStatusNext(e.target.value)}
                placeholder="in_review / needs_info / approved / archived"
                className="mt-2 w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-2 text-sm text-white/85 outline-none focus:border-amber-300/25"
              />
              <div className="mt-2 text-xs text-white/45">
                Sent to RPC as lowercase enum (e.g. <span className="text-white/65">approved</span>).
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <div className="text-xs uppercase tracking-[0.22em] text-white/35">note</div>
              <textarea
                value={statusNote}
                onChange={(e) => setStatusNote(e.target.value)}
                className="mt-2 w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white/85 outline-none focus:border-amber-300/25"
                rows={4}
              />
            </div>
          </div>
        ) : null}

        {modal === "ARCHIVE_APP" ? (
          <div className="space-y-3">
            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <div className="text-xs uppercase tracking-[0.22em] text-white/35">archive note</div>
              <textarea
                value={archiveNote}
                onChange={(e) => setArchiveNote(e.target.value)}
                className="mt-2 w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white/85 outline-none focus:border-amber-300/25"
                rows={4}
              />
              <div className="mt-2 text-xs text-white/45">
                Archives the application (status → <span className="text-white/70">archived</span>). No entity data is deleted.
              </div>
            </div>
          </div>
        ) : null}

        {modal === "HARD_DELETE_APP" ? (
          <div className="space-y-3">
            <div className="rounded-2xl border border-rose-300/15 bg-rose-500/10 p-4">
              <div className="text-xs uppercase tracking-[0.22em] text-rose-100/70">warning</div>
              <div className="mt-2 text-sm text-rose-100/90">
                This permanently deletes the application record. Use only for spam, duplicates, or mistakes{" "}
                <span className="font-semibold">before</span> identity/entity creation.
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <div className="text-xs uppercase tracking-[0.22em] text-white/35">reason (required)</div>
              <textarea
                value={deleteReason}
                onChange={(e) => setDeleteReason(e.target.value)}
                className="mt-2 w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white/85 outline-none focus:border-rose-300/25"
                rows={4}
                placeholder="e.g. sandbox smoke test / duplicate submission / spam"
              />
              <div className="mt-2 text-xs text-white/45">Confirm is blocked until a reason is provided.</div>
            </div>
          </div>
        ) : null}
      </OsModal>
    </div>
  );
}
```
