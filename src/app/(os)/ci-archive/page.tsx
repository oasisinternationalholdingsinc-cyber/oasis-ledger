"use client";
export const dynamic = "force-dynamic";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Archive, BadgeCheck, BookOpen, UploadCloud, ArrowRight, Shield } from "lucide-react";

import { supabaseBrowser } from "@/lib/supabase/browser";
import { useEntity } from "@/components/OsEntityContext";

type Counts = {
  minuteBook: number | null;
  verified: number | null;
  ledger: number | null;
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

export default function CIArchiveLaunchpad() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const { activeEntity } = useEntity();

  const [loading, setLoading] = useState(true);
  const [counts, setCounts] = useState<Counts>({ minuteBook: null, verified: null, ledger: null });

  // IMPORTANT:
  // Auth gating belongs to (os)/layout or os-auth-gate.
  // Do NOT redirect to /login from inside CI modules (prevents false "logout" due to session hydration timing).

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
      const [minuteBook, verified, ledger] = await Promise.all([
        safeCount("minute_book_entries"),
        safeCount("verified_documents"),
        safeCount("governance_ledger"),
      ]);

      if (!cancelled) {
        setCounts({ minuteBook, verified, ledger });
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
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">CI-ARCHIVE</div>
        <p className="mt-1 text-[11px] text-slate-400">
          Registry vault • <span className="font-semibold text-slate-200">strict three-column surfaces</span> • Oasis OS signature
        </p>
      </div>

      <div className="flex-1 min-h-0 flex justify-center overflow-hidden">
        <div className="w-full max-w-[1400px] h-full rounded-3xl border border-slate-900 bg-black/60 shadow-[0_0_60px_rgba(15,23,42,0.9)] px-6 py-5 flex flex-col overflow-hidden">
          <div className="flex items-start justify-between mb-4 shrink-0">
            <div>
              <h1 className="text-lg font-semibold text-slate-50">CI-Archive Launchpad</h1>
              <p className="mt-1 text-xs text-slate-400 max-w-3xl">
                CI-Archive is <span className="font-semibold text-amber-300">registry-only</span>. No bucket UI. No destructive actions.
              </p>
            </div>

            <div className="hidden md:flex items-center gap-2">
              <CountPill label="Minute Book" value={counts.minuteBook} loading={loading} />
              <CountPill label="Verified" value={counts.verified} loading={loading} />
              <CountPill label="Ledger" value={counts.ledger} loading={loading} />
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 flex-1 min-h-0 overflow-y-auto pr-1">
            <Tile
              href={`/ci-archive/minute-book${scopeQuery}`}
              tag="Digital Minute Book"
              title="Minute Book Registry"
              subtitle="Canonical domain taxonomy with Oasis OS signatures. Archived & indexed records only."
              icon={
                <div className="h-10 w-10 rounded-xl bg-amber-500/10 border border-amber-500/25 flex items-center justify-center">
                  <BookOpen className="h-5 w-5 text-amber-300" />
                </div>
              }
            />

            <Tile
              href={`/ci-archive/verified${scopeQuery}`}
              tag="Verified Vault"
              title="Verified Registry"
              subtitle="Signed/verified artifacts with hashes, envelopes, and audit metadata."
              icon={
                <div className="h-10 w-10 rounded-xl bg-emerald-500/10 border border-emerald-500/25 flex items-center justify-center">
                  <BadgeCheck className="h-5 w-5 text-emerald-300" />
                </div>
              }
            />

            <Tile
              href={`/ci-archive/ledger${scopeQuery}`}
              tag="Ledger Visibility"
              title="Drafts & Approvals"
              subtitle="Read-only visibility into ledger records. Archive linking occurs when minute_book_entries.source_record_id exists."
              icon={
                <div className="h-10 w-10 rounded-xl bg-sky-500/10 border border-sky-500/25 flex items-center justify-center">
                  <Archive className="h-5 w-5 text-sky-300" />
                </div>
              }
            />

            <Tile
              href={`/ci-archive/upload${scopeQuery}`}
              tag="Upload & Index"
              title="Upload to Registry"
              subtitle="Domain-driven filing flow. Upload PDF → hash → register → appears under Minute Book / Verified."
              icon={
                <div className="h-10 w-10 rounded-xl bg-violet-500/10 border border-violet-500/25 flex items-center justify-center">
                  <UploadCloud className="h-5 w-5 text-violet-300" />
                </div>
              }
            />
          </div>

          <div className="mt-4 shrink-0 flex items-center justify-between text-[10px] text-slate-500">
            <span className="inline-flex items-center gap-2">
              <Shield className="h-3.5 w-3.5 text-amber-300/80" />
              CI-Archive · registry of record · non-destructive
            </span>
            <span>Oasis Digital Parliament · Governance Firmware</span>
          </div>
        </div>
      </div>
    </div>
  );
}
