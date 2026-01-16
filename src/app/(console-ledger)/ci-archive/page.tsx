// src/app/(os)/ci-archive/page.tsx
"use client";
export const dynamic = "force-dynamic";

import Link from "next/link";
import { useMemo } from "react";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";

function cx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

export default function CIArchiveLaunchpadPage() {
  const entityCtx = useEntity() as any;
  const osEnv = useOsEnv() as any;

  // ✅ contamination-safe: never hardcode corporate entity names
  const entitySlug = (entityCtx?.activeEntity as string) || (entityCtx?.entitySlug as string) || "entity";
  const entityLabel = useMemo(() => {
    const fromCtx =
      (entityCtx?.entityName as string) ||
      (entityCtx?.activeEntityName as string) ||
      (entityCtx?.label as string) ||
      (entityCtx?.name as string);
    return fromCtx?.trim() ? fromCtx : entitySlug;
  }, [entityCtx, entitySlug]);

  const isSandbox = !!osEnv?.isSandbox;
  const envLabel = isSandbox ? "SANDBOX" : "RoT";

  const tiles: Array<{
    title: string;
    subtitle: string;
    href: string;
    badge: string;
    tone: "emerald" | "amber" | "sky" | "slate";
  }> = [
    {
      title: "Minute Book",
      subtitle: "Registry of corporate records and supporting evidence.",
      href: "/ci-archive/minute-book",
      badge: "Registry",
      tone: "emerald",
    },
    {
      title: "Verified",
      subtitle: "Certified outputs ready for public trust surfaces.",
      href: "/ci-archive/verified",
      badge: "Certified",
      tone: "sky",
    },
    {
      title: "Ledger",
      subtitle: "Execution visibility over governance_ledger lifecycle.",
      href: "/ci-archive/ledger",
      badge: "Visibility",
      tone: "slate",
    },
    {
      title: "Upload",
      subtitle: "Domain-driven filing intake (enterprise flow).",
      href: "/ci-archive/upload",
      badge: "Intake",
      tone: "amber",
    },
  ];

  const shell =
    "rounded-3xl border border-white/10 bg-black/20 shadow-[0_28px_120px_rgba(0,0,0,0.55)] overflow-hidden";
  const header =
    "border-b border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent px-4 sm:px-6 py-4 sm:py-5";
  const body = "px-4 sm:px-6 py-5 sm:py-6";

  const toneRing: Record<string, string> = {
    emerald: "ring-emerald-400/25 hover:ring-emerald-300/35",
    sky: "ring-sky-400/25 hover:ring-sky-300/35",
    amber: "ring-amber-400/25 hover:ring-amber-300/35",
    slate: "ring-white/10 hover:ring-white/15",
  };

  const toneBadge: Record<string, string> = {
    emerald: "border-emerald-400/25 bg-emerald-500/10 text-emerald-200",
    sky: "border-sky-400/25 bg-sky-500/10 text-sky-200",
    amber: "border-amber-400/25 bg-amber-500/10 text-amber-200",
    slate: "border-white/10 bg-white/5 text-slate-200",
  };

  return (
    <div className="w-full">
      <div className="mx-auto w-full max-w-[1200px] px-4 pb-10 pt-4 sm:pt-6">
        {/* OS-aligned page header */}
        <div className={shell}>
          <div className={header}>
            <div className="text-[10px] sm:text-xs tracking-[0.3em] uppercase text-slate-500">CI • Archive</div>
            <h1 className="mt-1 text-lg sm:text-xl font-semibold text-slate-50">Registry Launchpad</h1>
            <p className="mt-1 max-w-3xl text-[11px] sm:text-xs text-slate-400 leading-relaxed">
              One archive surface. Multiple registries. Lane-safe. Entity-scoped. OS-native.
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-400">
              <span>
                Entity: <span className="text-emerald-300 font-medium">{entityLabel}</span>
              </span>
              <span className="text-slate-700">•</span>
              <span>
                Lane:{" "}
                <span className={cx("font-semibold", isSandbox ? "text-amber-300" : "text-sky-300")}>
                  {envLabel}
                </span>
              </span>
              <span className="text-slate-700">•</span>
              <span className="text-slate-500">OS module surface</span>
            </div>
          </div>

          <div className={body}>
            {/* iPhone-first tiles: 2 cols on mobile, 4 cols on desktop */}
            <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 lg:grid-cols-4">
              {tiles.map((t) => (
                <Link
                  key={t.href}
                  href={t.href}
                  className={cx(
                    "group relative rounded-3xl border border-white/10 bg-black/25 hover:bg-black/30 transition",
                    "p-3 sm:p-4",
                    "ring-1 ring-transparent",
                    toneRing[t.tone]
                  )}
                >
                  {/* subtle gold signal */}
                  <div className="pointer-events-none absolute inset-0 rounded-3xl opacity-0 group-hover:opacity-100 transition">
                    <div className="absolute -top-20 -right-20 h-40 w-40 rounded-full bg-amber-500/10 blur-2xl" />
                  </div>

                  <div className="relative flex flex-col gap-2 min-h-[120px] sm:min-h-[150px]">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-[13px] sm:text-[14px] font-semibold text-slate-100">
                          {t.title}
                        </div>
                        <div className="mt-1 line-clamp-2 text-[11px] sm:text-[12px] leading-relaxed text-slate-400">
                          {t.subtitle}
                        </div>
                      </div>

                      <span
                        className={cx(
                          "shrink-0 rounded-full border px-2 py-1 text-[9px] uppercase tracking-[0.18em]",
                          toneBadge[t.tone]
                        )}
                      >
                        {t.badge}
                      </span>
                    </div>

                    <div className="mt-auto pt-2">
                      <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 group-hover:bg-white/7">
                        Open
                        <span className="text-slate-500 group-hover:text-slate-400">→</span>
                      </div>
                      <div className="mt-2 text-[10px] text-slate-600">
                        {entitySlug} • {envLabel}
                      </div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>

            {/* Compact footnote (mobile-friendly) */}
            <div className="mt-5 rounded-3xl border border-white/10 bg-black/20 px-4 py-3 text-[11px] text-slate-400">
              <div className="font-semibold text-slate-200">OS behavior</div>
              <div className="mt-1 leading-relaxed text-slate-400">
                CI-Archive inherits the OS shell. No module-owned window frames. Registries render as lane-safe,
                entity-scoped surfaces.
              </div>
            </div>
          </div>
        </div>

        {/* Optional: quick links row for desktop (stays iPhone-safe) */}
        <div className="mt-4 flex flex-wrap gap-2">
          {tiles.map((t) => (
            <Link
              key={`${t.href}-pill`}
              href={t.href}
              className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7"
            >
              {t.title}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
