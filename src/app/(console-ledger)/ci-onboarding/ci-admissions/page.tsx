"use client";

export const dynamic = "force-dynamic";

/**
 * CI-ADMISSIONS — AUTHORITY CONSOLE (PRISTINE / LOCKED)
 * ---------------------------------------------------
 * Decision + intake ONLY.
 *
 * ❌ No auth invites
 * ❌ No provisioning execution
 * ❌ No Edge Functions
 *
 * ✅ Status transitions (RPC)
 * ✅ Decisions (RPC)
 * ✅ Request info (RPC)
 * ✅ Provisioning TASK CREATION ONLY (RPC)
 */

import { useEffect, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";

type InboxRow = {
  id: string;
  entity_slug: string | null;
  organization_legal_name: string | null;
  applicant_email: string | null;
  status: string | null;
  submitted_at: string | null;
};

type Decision = "APPROVED" | "DECLINED" | "NEEDS_INFO";

export default function AdmissionsAuthorityConsole() {
  // ----------------------------
  // ENTITY (NO CORPORATE FALLBACK)
  // ----------------------------
  const entityCtx = useEntity() as any;
  const entityKey: string =
    entityCtx?.entityKey ||
    entityCtx?.activeEntity ||
    entityCtx?.entity_slug ||
    "";

  // ----------------------------
  // ENV / LANE (DEFENSIVE READ)
  // ----------------------------
  const env = useOsEnv() as any;
  const isTest: boolean = Boolean(
    env?.is_test ??
      env?.isTest ??
      env?.lane_is_test ??
      env?.sandbox ??
      env?.isSandbox
  );

  const [rows, setRows] = useState<InboxRow[]>([]);
  const [selected, setSelected] = useState<InboxRow | null>(null);
  const [loading, setLoading] = useState(false);

  // ----------------------------
  // LOAD INBOX (VIEW-ONLY)
  // ----------------------------
  async function loadInbox() {
    setLoading(true);

    const { data, error } = await supabase
      .from("v_onboarding_admissions_inbox")
      .select("*")
      .eq("entity_slug", entityKey)
      .eq("lane_is_test", isTest)
      .order("submitted_at", { ascending: false });

    if (!error && data) setRows(data as InboxRow[]);
    setLoading(false);
  }

  useEffect(() => {
    if (entityKey) loadInbox();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityKey, isTest]);

  // ----------------------------
  // RPC ACTIONS (CANONICAL)
  // ----------------------------
  async function beginReview(id: string) {
    await supabase.rpc("admissions_begin_review", {
      p_application_id: id,
    });
    loadInbox();
  }

  async function setStatus(id: string, next: string) {
    await supabase.rpc("admissions_set_status", {
      p_application_id: id,
      p_next_status: next,
      p_note: null,
    });
    loadInbox();
  }

  async function recordDecision(
    id: string,
    decision: Decision,
    summary: string
  ) {
    await supabase.rpc("admissions_record_decision", {
      p_application_id: id,
      p_decision: decision,
      p_risk_tier: "medium",
      p_summary: summary,
      p_reason: null,
    });
    loadInbox();
  }

  async function requestInfo(id: string) {
    await supabase.rpc("admissions_request_info", {
      p_application_id: id,
      p_message: "Additional information required",
      p_channels: ["email"],
      p_due_at: null,
      p_next_status: "NEEDS_INFO",
    });
    loadInbox();
  }

  // ----------------------------
  // PROVISIONING TASK CREATION
  // (NO EXECUTION)
  // ----------------------------
  async function createProvisioningTasks(id: string) {
    await supabase.rpc("admissions_create_provisioning_tasks", {
      p_application_id: id,
      p_tasks: [
        {
          task_key: "portal_access",
          label: "Grant Portal Access",
          description: "Invite applicant to set password",
        },
        {
          task_key: "entity_provisioning",
          label: "Provision Entity",
          description: "Create entity and memberships",
        },
      ],
    });
  }

  // ----------------------------
  // RENDER
  // ----------------------------
  return (
    <div className="p-6 space-y-6">
      <h1 className="text-xl font-semibold">Admissions · Authority Console</h1>

      <div className="grid grid-cols-[320px_1fr] gap-6">
        {/* INBOX */}
        <div className="space-y-2">
          {rows.map((r) => (
            <button
              key={r.id}
              onClick={() => setSelected(r)}
              className={`w-full text-left rounded-xl p-4 border ${
                selected?.id === r.id
                  ? "border-amber-400/40 bg-black/40"
                  : "border-white/10"
              }`}
            >
              <div className="font-medium">
                {r.organization_legal_name || "—"}
              </div>
              <div className="text-xs text-white/60">
                {r.applicant_email || "—"}
              </div>
              <div className="text-xs mt-1 text-amber-300">
                {r.status || "—"}
              </div>
            </button>
          ))}

          {!loading && rows.length === 0 && (
            <div className="text-sm text-white/40 p-4">
              No applications found.
            </div>
          )}
        </div>

        {/* DETAIL */}
        {selected && (
          <div className="space-y-4">
            <div className="rounded-xl border border-white/10 p-4">
              <div className="font-medium">
                {selected.organization_legal_name}
              </div>
              <div className="text-sm text-white/60">
                {selected.applicant_email}
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <button className="btn" onClick={() => beginReview(selected.id)}>
                Begin Review
              </button>

              <button
                className="btn"
                onClick={() =>
                  recordDecision(
                    selected.id,
                    "APPROVED",
                    "Approved for onboarding"
                  )
                }
              >
                Approve
              </button>

              <button
                className="btn"
                onClick={() => requestInfo(selected.id)}
              >
                Needs Info
              </button>

              <button
                className="btn"
                onClick={() => setStatus(selected.id, "ARCHIVED")}
              >
                Archive
              </button>

              <button
                className="btn"
                onClick={() => createProvisioningTasks(selected.id)}
              >
                Create Provisioning Tasks
              </button>
            </div>

            <div className="text-xs text-white/40">
              Admissions is decision-only. Invite and activation run in
              CI-Provisioning.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
