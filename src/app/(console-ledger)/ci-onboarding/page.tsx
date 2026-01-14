"use client";
export const dynamic = "force-dynamic";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ClipboardList, FileCheck2, UserCog, ArrowRight, Shield, Inbox } from "lucide-react";

import { supabaseBrowser } from "@/lib/supabase/browser";
import { useEntity } from "@/components/OsEntityContext";

type Counts = {
  admissions: number | null;
  evidence: number | null;
  provisioning: number | null;
};

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function CountPill({
  label,
  value,
  loading,
}: {
  label: string;
  value: number | null;
  loading: boolean;
}) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-950/50 px-3 py-1">
      <span className="text-[10px] uppercase tracking-[0.22em] text-slate-500">{label}</span>
      <span className="text-[11px] font-semibold text-slate-200">{loading ? "…" : value ?? "—"}</span>
    </div>
  );
}

function Tile({
  href,
  title,
  subtitle,
  icon,
  tag,
}: {
  href: string;
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  tag: string;
}) {
  return (
    <Link
      href={href}
      className={cx(
        "group relative overflow-hidden rounded-3xl",
        "border border-slate-900 bg-black/60",
        "shadow-[0_0_60px_rgba(15,23,42,0.75)]",
        "transition hover:border-amber-500/30 hover:shadow-[0_0_80px_rgba(245,158,11,0.12)]"
      )}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-amber-500/10 to-transparent opacity-0 transition group-hover:opacity-100" />
      <div className="p-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <span className="text-[10px] uppercase tracking-[0.28em] text-slate-500">{tag}</span>
          <div className="mt-2 text-lg font-semibold text-slate-50">{title}</div>
          <p className="mt-2 text-[12px] leading-relaxed text-slate-400">{subtitle}</p>
          <div className="mt-5 inline-flex items-center gap-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-amber-300">
            Open <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
          </div>
        </div>

        <div
          className={cx(
            "shrink-0 rounded-2xl border border-slate-800/80 bg-slate-950/70",
            "p-3 shadow-[inset_0_0_0_1px_rgba(148,163,184,0.06)]"
          )}
        >
          {icon}
        </div>
      </div>
    </Link>
  );
}

export default function CIOnboardingLaunchpad() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const { activeEntity } = useEntity();

  const [loading, setLoading] = useState(true);
  const [counts, setCounts] = useState<Counts>({ admissions: null, evidence: null, provisioning: null });

  // IMPORTANT:
  // Auth gating belongs to (os)/layout or os-auth-gate.
  // Do NOT redirect to /login from inside CI modules.

  useEffect(() => {
    let cancelled = false;

    const safeCount = async (table: string) => {
      try {
        const { count, error } = await supabase.from(table).select("id", { count: "exact", head: true });
        if (error) return null;
        return typeof count === "number" ? count : null;
      } catch {
        return null;
      }
    };

    const loadCounts = async () => {
      setLoading(true);

      // NOTE: keep counts "best-effort". If RLS hides rows, counts may be null/0 — UI still works.
      // admissions: onboarding_applications
      // evidence: onboarding_evidence
      // provisioning: onboarding_applications (same table; separate surface in UI)
      const [admissions, evidence, provisioning] = await Promise.all([
        safeCount("onboarding_applications"),
        safeCount("onboarding_evidence"),
        safeCount("onboarding_applications"),
      ]);

      if (!cancelled) {
        setCounts({ admissions, evidence, provisioning });
        setLoading(false);
      }
    };

    loadCounts();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  // keep entity scoping consistent everywhere
  const scopeQuery = `?entity_key=${encodeURIComponent(activeEntity)}`;

  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      <div className="mb-4 shrink-0">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">CI-ONBOARDING</div>
        <p className="mt-1 text-[11px] text-slate-400">
          Institutional intake • <span className="font-semibold text-slate-200">authority-only mutations</span> • evidence gated
        </p>
      </div>

      <div className="flex-1 min-h-0 flex justify-center overflow-hidden">
        <div className="w-full max-w-[1400px] h-full rounded-3xl border border-slate-900 bg-black/60 shadow-[0_0_60px_rgba(15,23,42,0.9)] px-6 py-5 flex flex-col overflow-hidden">
          <div className="flex items-start justify-between mb-4 shrink-0">
            <div>
              <h1 className="text-lg font-semibold text-slate-50">CI-Onboarding Launchpad</h1>
              <p className="mt-1 text-xs text-slate-400 max-w-3xl">
                Queue → Review → Decision → Provisioning → Evidence verification.{" "}
                <span className="font-semibold text-amber-300">Portal handles submissions.</span>
              </p>
            </div>

            <div className="hidden md:flex items-center gap-2">
              <CountPill label="Admissions" value={counts.admissions} loading={loading} />
              <CountPill label="Evidence" value={counts.evidence} loading={loading} />
              <CountPill label="Provisioning" value={counts.provisioning} loading={loading} />
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 flex-1 min-h-0 overflow-y-auto pr-1">
            <Tile
              href={`/ci-onboarding/ci-admissions${scopeQuery}`}
              tag="Admissions Queue"
              title="Admissions Console"
              subtitle="Begin review, request information, record decisions, and drive application state transitions via RPC-only mutations."
              icon={
                <div className="h-10 w-10 rounded-xl bg-amber-500/10 border border-amber-500/25 flex items-center justify-center">
                  <Inbox className="h-5 w-5 text-amber-300" />
                </div>
              }
            />

            <Tile
              href={`/ci-onboarding/ci-evidence${scopeQuery}`}
              tag="Evidence Vault"
              title="Evidence Review"
              subtitle="Verify submitted artifacts (ID, incorporation, address, tax). Evidence is read-only unless verified/flagged by authority."
              icon={
                <div className="h-10 w-10 rounded-xl bg-emerald-500/10 border border-emerald-500/25 flex items-center justify-center">
                  <FileCheck2 className="h-5 w-5 text-emerald-300" />
                </div>
              }
            />

            <Tile
              href={`/ci-onboarding/ci-admissions${scopeQuery}`}
              tag="Provisioning"
              title="Provisioning & Access"
              subtitle="Issue portal access, complete provisioning, and confirm entity + memberships. Uses server-side guards and idempotent RPCs."
              icon={
                <div className="h-10 w-10 rounded-xl bg-sky-500/10 border border-sky-500/25 flex items-center justify-center">
                  <UserCog className="h-5 w-5 text-sky-300" />
                </div>
              }
            />

            <Tile
              href={`/ci-archive${scopeQuery}`}
              tag="Registry of Record"
              title="Archive & Verified Registry"
              subtitle="Once provisioned, artifacts and downstream governance outputs live in CI-Archive as the long-term registry of record."
              icon={
                <div className="h-10 w-10 rounded-xl bg-violet-500/10 border border-violet-500/25 flex items-center justify-center">
                  <ClipboardList className="h-5 w-5 text-violet-300" />
                </div>
              }
            />
          </div>

          <div className="mt-4 shrink-0 flex items-center justify-between text-[10px] text-slate-500">
            <span className="inline-flex items-center gap-2">
              <Shield className="h-3.5 w-3.5 text-amber-300/80" />
              CI-Onboarding · intake authority · RPC-only mutations
            </span>
            <span>Oasis Digital Parliament · Authority Gateway</span>
          </div>
        </div>
      </div>
    </div>
  );
}
