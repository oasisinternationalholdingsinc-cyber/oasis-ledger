// src/app/(console-ledger)/ci-parliament/page.tsx
"use client";
export const dynamic = "force-dynamic";

/**
 * CI • Parliament (OS Launchpad Surface — NO REGRESSION)
 * ✅ Wiring preserved: same routes (/ci-council, /ci-amendments, /ci-votes, /ci-constitution)
 * ✅ No RPC changes, no authority changes, no data flow changes
 * ✅ OS-matched calm launchpad pattern (same TileCard grammar as CI-Onboarding)
 * ✅ Mobile-safe: stacks vertically on iPhone, 2x2 on large screens
 */

import Link from "next/link";
import { useMemo } from "react";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";

function cx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

type Tile = {
  eyebrow: string;
  title: string;
  description: string;
  href: string;
  badge?: string;
  cta: string;
  disabled?: boolean;
};

function TileCard(t: Tile) {
  const shell =
    "group relative overflow-hidden rounded-3xl border border-white/10 bg-black/20 p-7 shadow-[0_28px_120px_rgba(0,0,0,0.55)] transition";
  const hover =
    "hover:border-amber-300/25 hover:bg-black/28 hover:shadow-[0_0_0_1px_rgba(250,204,21,0.12),0_34px_140px_rgba(0,0,0,0.70)]";
  const glow =
    "before:pointer-events-none before:absolute before:inset-0 before:opacity-0 before:transition before:duration-500 " +
    "before:bg-[radial-gradient(900px_circle_at_20%_0%,rgba(250,204,21,0.14),transparent_55%),radial-gradient(700px_circle_at_80%_120%,rgba(59,130,246,0.12),transparent_60%)] " +
    "group-hover:before:opacity-100";
  const topLine = "absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent";

  const content = (
    <div className={cx(shell, !t.disabled && hover, glow, t.disabled && "opacity-60")}>
      <div className={topLine} />

      <div className="relative z-10">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.28em] text-white/45">{t.eyebrow}</div>
            <div className="mt-2 text-xl font-semibold text-white/90">{t.title}</div>
          </div>

          {t.badge ? (
            <span className="rounded-full border border-amber-300/20 bg-amber-300/10 px-3 py-1 text-[11px] font-medium text-amber-100">
              {t.badge}
            </span>
          ) : null}
        </div>

        <p className="mt-4 max-w-[56ch] text-sm leading-6 text-white/55">{t.description}</p>

        <div className="mt-6 flex items-center justify-between">
          <div className="text-xs text-white/35">Legislative Authority</div>
          <div
            className={cx(
              "inline-flex items-center gap-2 rounded-full border px-4 py-2 text-xs font-semibold transition",
              t.disabled
                ? "border-white/10 bg-white/5 text-white/35"
                : "border-amber-300/20 bg-amber-300/10 text-amber-100 group-hover:bg-amber-300/14"
            )}
          >
            {t.cta}
            <span aria-hidden className={cx("transition", t.disabled ? "" : "group-hover:translate-x-0.5")}>
              →
            </span>
          </div>
        </div>
      </div>
    </div>
  );

  if (t.disabled) return <div>{content}</div>;

  return (
    <Link href={t.href} className="block">
      {content}
    </Link>
  );
}

export default function CIParliamentPage() {
  // Entity (defensive — same pattern you used in CI-Onboarding / CI-Evidence)
  const ec = useEntity() as any;
  const entityKey: string =
    (ec?.entityKey as string) || (ec?.activeEntity as string) || (ec?.entity_slug as string) || "";

  const entityName: string =
    (ec?.entityName as string) ||
    (ec?.activeEntityName as string) ||
    (ec?.entities?.find?.((x: any) => x?.slug === entityKey || x?.key === entityKey)?.name as string) ||
    entityKey;

  // Lane (defensive — same pattern you used in CI-Onboarding / CI-Evidence)
  const env = useOsEnv() as any;
  const isTest: boolean = Boolean(env?.is_test ?? env?.isTest ?? env?.lane_is_test ?? env?.sandbox ?? env?.isSandbox);

  const tiles: Tile[] = useMemo(
    () => [
      {
        eyebrow: "CI • Parliament",
        title: "CI-Council",
        description:
          "Deliberation console for drafted resolutions and governance records. Review, approve, or reject — then hand off to Forge for signature execution.",
        href: "/ci-council",
        badge: "Authority",
        cta: "Open Council",
      },
      {
        eyebrow: "CI • Parliament",
        title: "CI-Amendments",
        description:
          "Legislative timeline of governed schema changes. Proposals, classifications, and when changes became active law under constitutional rules.",
        href: "/ci-amendments",
        badge: "Timeline",
        cta: "Open Amendments",
      },
      {
        eyebrow: "CI • Parliament",
        title: "CI-Votes",
        description:
          "Official record of approvals and rejections: who voted, in what role, and when. The democratic ledger backing every governed change.",
        href: "/ci-votes",
        badge: "Record",
        cta: "Open Votes",
      },
      {
        eyebrow: "CI • Parliament",
        title: "CI-Constitution",
        description:
          "Catalogue of protected objects designated constitutional. Changes require amendments + votes approval before they can take effect in the ledger.",
        href: "/ci-constitution",
        badge: "Protected",
        cta: "Open Constitution",
      },
    ],
    []
  );

  return (
    <div className="h-full w-full">
      <div className="mx-auto w-full max-w-[1400px] px-4 pb-12 pt-8">
        <div className="mb-7 flex items-end justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.28em] text-white/45">Oasis Digital Parliament</div>
            <div className="mt-1 text-3xl font-semibold text-white/90">Launchpad</div>
            <div className="mt-2 text-sm text-white/50">
              Entity-scoped: <span className="text-white/70">{entityName || entityKey || "—"}</span> • Lane:{" "}
              <span className="text-white/70">{isTest ? "SANDBOX" : "RoT"}</span>
            </div>
          </div>

          <div className="hidden sm:flex items-center gap-2">
            <span className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs text-white/60">
              Proposals → Amendments → Votes → Constitutional Law
            </span>
          </div>
        </div>

        {/* Mobile-first: stacks; Large: 2x2 calm grid */}
        <div className="grid grid-cols-12 gap-4">
          <div className="col-span-12 lg:col-span-6">
            <TileCard {...tiles[0]} />
          </div>
          <div className="col-span-12 lg:col-span-6">
            <TileCard {...tiles[1]} />
          </div>
          <div className="col-span-12 lg:col-span-6">
            <TileCard {...tiles[2]} />
          </div>
          <div className="col-span-12 lg:col-span-6">
            <TileCard {...tiles[3]} />
          </div>
        </div>

        <div className="mt-6 text-[10px] text-white/35">
          Parliament is the legislative and constitutional authority surface. Operational execution remains inside the dedicated consoles
          (Council, Amendments, Votes, Constitution) — this page is the calm entry point.
        </div>
      </div>
    </div>
  );
}
