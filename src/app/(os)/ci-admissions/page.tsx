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

function hashShort(x?: string | null) {
  const s = (x ?? "").trim();
  if (!s) return "—";
  if (s.length <= 16) return s;
  return `${s.slice(0, 10)}…${s.slice(-6)}`;
}

function safeArray(x: any): string[] {
  if (!x) return [];
  if (Array.isArray(x)) return x.map(String);
  return [];
}

export default function CIAdmissionsPage() {
  const entityCtx = useEntity() as any;
  useOsEnv();

  const activeEntitySlug = (entityCtx?.activeEntity as string) || "holdings";
  const activeEntityLabel = ENTITY_LABELS[activeEntitySlug] ?? activeEntitySlug;

  const [apps, setApps] = useState<ApplicationRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [events, setEvents] = useState<EventRow[]>([]);
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);

  const selected = useMemo(
    () => apps.find((a) => a.id === selectedId) ?? null,
    [apps, selectedId]
  );

  // 🔑 CANONICAL INBOX LOAD — ONLY CHANGE IN THIS FILE
  async function reload() {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("v_onboarding_admissions_inbox")
        .select("*")
        .eq("entity_slug", activeEntitySlug)
        .order("created_at", { ascending: false });

      if (error) throw error;

      setApps((data ?? []) as ApplicationRow[]);

      if (!selectedId && data?.length) {
        setSelectedId(data[0].id);
        loadRelated(data[0].id);
      }
    } catch (e: any) {
      console.error("Admissions load failed:", e?.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadRelated(applicationId: string) {
    const [ev, de, tk] = await Promise.all([
      supabase.from("onboarding_events").select("*").eq("application_id", applicationId),
      supabase.from("onboarding_decisions").select("*").eq("application_id", applicationId),
      supabase.from("onboarding_provisioning_tasks").select("*").eq("application_id", applicationId),
    ]);

    setEvents(ev.data ?? []);
    setDecisions(de.data ?? []);
    setTasks(tk.data ?? []);
  }

  useEffect(() => {
    reload();
  }, [activeEntitySlug]);

  return (
    <div className="h-full px-8 pt-6 pb-6">
      <h1 className="text-xl font-semibold text-slate-50">
        CI-Admissions · {activeEntityLabel}
      </h1>

      {loading ? (
        <div className="mt-6 text-slate-400">Loading…</div>
      ) : apps.length === 0 ? (
        <div className="mt-6 text-slate-500">No applications found.</div>
      ) : (
        <div className="mt-6 grid grid-cols-[360px_1fr] gap-6">
          <aside className="border border-slate-800 rounded-xl overflow-y-auto">
            {apps.map((a) => (
              <div
                key={a.id}
                onClick={() => {
                  setSelectedId(a.id);
                  loadRelated(a.id);
                }}
                className={cx(
                  "px-4 py-3 cursor-pointer border-b border-slate-800",
                  a.id === selectedId && "bg-slate-800/60"
                )}
              >
                <div className="text-sm font-semibold">
                  {a.organization_legal_name || a.applicant_name}
                </div>
                <div className="text-xs text-slate-400">
                  {a.applicant_email}
                </div>
              </div>
            ))}
          </aside>

          <section className="border border-slate-800 rounded-xl p-6">
            {selected ? (
              <>
                <h2 className="text-lg font-semibold">
                  {selected.organization_legal_name}
                </h2>
                <div className="mt-2 text-sm text-slate-400">
                  Status: {selected.status}
                </div>
              </>
            ) : (
              <div className="text-slate-500">Select an application</div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
