"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";

/* =====================================================================================
   NOTE — CANONICAL ADMISSIONS READ CONTRACT (LOCKED)
   -------------------------------------------------------------------------------------
   ✅ Inbox READS ONLY from: v_onboarding_admissions_inbox
   ❌ NEVER read onboarding_applications directly in UI
   ===================================================================================== */

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

function cx(...c: Array<string | false | null | undefined>) {
  return c.filter(Boolean).join(" ");
}

function fmtShort(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export default function CIAdmissionsPage() {
  const entityCtx = useEntity() as any;
  useOsEnv(); // admissions ignores is_test by design

  const activeEntitySlug = entityCtx?.activeEntity ?? "holdings";
  const activeEntityLabel = ENTITY_LABELS[activeEntitySlug] ?? activeEntitySlug;

  const [apps, setApps] = useState<ApplicationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<StatusTab>("ALL");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const lastPickRef = useRef<string | null>(null);

  /* =====================================================================================
     🔑 SINGLE SOURCE OF TRUTH — INBOX LOAD
     ===================================================================================== */
  async function reload() {
    setLoading(true);

    const { data, error } = await supabase
      .from("v_onboarding_admissions_inbox") // ✅ FIXED
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      console.error(error);
      setApps([]);
      setLoading(false);
      return;
    }

    setApps(data ?? []);

    if (!selectedId && data?.length) {
      if (lastPickRef.current !== data[0].id) {
        lastPickRef.current = data[0].id;
        setSelectedId(data[0].id);
      }
    }

    setLoading(false);
  }

  useEffect(() => {
    setSelectedId(null);
    setTab("ALL");
    setQuery("");
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEntitySlug]);

  const filtered = useMemo(() => {
    let rows = apps;

    if (tab !== "ALL") {
      rows = rows.filter(
        (a) => (a.status ?? "").toUpperCase() === tab.toUpperCase()
      );
    }

    if (query.trim()) {
      const q = query.toLowerCase();
      rows = rows.filter((a) =>
        [
          a.applicant_name,
          a.applicant_email,
          a.organization_legal_name,
          a.organization_trade_name,
          a.intent,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(q)
      );
    }

    return rows;
  }, [apps, tab, query]);

  const selected = apps.find((a) => a.id === selectedId) ?? null;

  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      <div className="mb-4">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">
          CI • Admissions
        </div>
        <h1 className="text-xl font-semibold text-slate-50">
          Admissions · Authority Console
        </h1>
        <div className="text-xs text-slate-400 mt-1">
          Entity:{" "}
          <span className="text-emerald-300 font-semibold">
            {activeEntityLabel}
          </span>
        </div>
      </div>

      <div className="flex-1 flex gap-4 overflow-hidden">
        {/* Queue */}
        <aside className="w-[380px] border border-slate-800 rounded-2xl bg-slate-950/40 overflow-hidden">
          <div className="p-4 border-b border-slate-800">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search admissions…"
              className="w-full rounded-xl bg-black/40 border border-slate-800 px-3 py-2 text-sm"
            />
          </div>

          <div className="overflow-y-auto">
            {loading ? (
              <div className="p-4 text-slate-500">Loading…</div>
            ) : filtered.length === 0 ? (
              <div className="p-4 text-slate-500">No applications.</div>
            ) : (
              <ul className="divide-y divide-slate-800">
                {filtered.map((a) => (
                  <li
                    key={a.id}
                    onClick={() => setSelectedId(a.id)}
                    className={cx(
                      "px-4 py-3 cursor-pointer hover:bg-slate-800/60",
                      a.id === selectedId && "bg-slate-800/80"
                    )}
                  >
                    <div className="text-sm font-semibold text-slate-100 truncate">
                      {a.organization_legal_name ??
                        a.organization_trade_name ??
                        a.applicant_name ??
                        "(unnamed)"}
                    </div>
                    <div className="text-xs text-slate-500">
                      {fmtShort(a.created_at)} ·{" "}
                      {(a.status ?? "—").toUpperCase()}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        {/* Detail */}
        <section className="flex-1 border border-slate-800 rounded-2xl bg-slate-950/40 flex items-center justify-center">
          {!selected ? (
            <div className="text-slate-500">
              Select an application from the queue.
            </div>
          ) : (
            <div className="text-slate-200">
              <div className="text-lg font-semibold">
                {selected.organization_legal_name ??
                  selected.organization_trade_name ??
                  selected.applicant_name}
              </div>
              <div className="text-sm text-slate-400 mt-2">
                Status: {(selected.status ?? "—").toUpperCase()}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
