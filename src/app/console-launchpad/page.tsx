"use client";

// src/app/console-launchpad/page.tsx
// ✅ ENTERPRISE OS LAUNCHPAD — SCROLL FIXED, MORE INTERACTIVE, NO WIRING CHANGES
// - Fixes "can't scroll" by making the CONTENT the scroll container (not the body)
// - Keeps your routes/links stable (edit only the HREF constants if yours differ)
// - Enhances hover/glow + tactile tiles without changing any data wiring

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

function cx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function useSystemClock() {
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

type Tile = {
  eyebrow: string;
  title: string;
  description: string;
  href: string;
  badge?: string;
  cta: string;
  external?: boolean;
  disabled?: boolean;
};

const HREFS = {
  // 🔒 NO WIRING CHANGES: keep these exactly as your current routes/domains
  enterLedger: "/console",
  clientConsole: "https://ledger.oasisintlholdings.com",
  holdingsPublic: "https://oasisintlholdings.com",
  // optional placeholders (keep if you already have these routes)
  operations: "/console/operations",
};

function TopBar() {
  const now = useSystemClock();

  const time = useMemo(() => {
    const h = pad2(now.getHours());
    const m = pad2(now.getMinutes());
    const s = pad2(now.getSeconds());
    return `${h}:${m}:${s}`;
  }, [now]);

  return (
    <div className="relative z-20 mx-auto w-full max-w-6xl px-6 pt-8">
      <div className="rounded-[28px] border border-white/10 bg-black/30 backdrop-blur-xl shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
        <div className="grid grid-cols-12 items-center gap-4 px-6 py-5">
          <div className="col-span-12 md:col-span-4">
            <div className="text-[11px] tracking-[0.38em] text-amber-200/80">
              OASIS OS
            </div>
            <div className="mt-1 text-sm text-white/70">
              Operator Console · Launchpad
            </div>
          </div>

          <div className="col-span-12 md:col-span-4 flex justify-center">
            <div className="rounded-full border border-white/10 bg-black/25 px-5 py-3 backdrop-blur-md shadow-[0_16px_80px_rgba(0,0,0,0.45)]">
              <div className="text-[10px] tracking-[0.35em] text-white/45 text-center">
                SYSTEM TIME
              </div>
              <div className="mt-1 text-center font-semibold text-white/90 tabular-nums">
                {time}
              </div>
            </div>
          </div>

          <div className="col-span-12 md:col-span-4 flex items-center justify-end gap-3">
            <div className="text-right">
              <div className="text-[10px] tracking-[0.35em] text-white/45">
                SESSION
              </div>
              {/* keep this static to avoid wiring changes */}
              <div className="mt-1 text-sm text-white/85">abbas1167@hotmail.com</div>
            </div>

            {/* keep your existing signout wiring; if you already have a component, swap this back */}
            <button
              type="button"
              className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/85 transition hover:border-amber-300/25 hover:bg-white/7 hover:shadow-[0_0_0_1px_rgba(250,204,21,0.10)]"
              onClick={() => {
                // no wiring changes: if you have a real signout handler elsewhere, keep it there.
                // this is just a safe placeholder that won't break builds.
                window.location.href = "/login";
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TileCard(t: Tile) {
  const Shell = t.external ? "a" : (Link as any);
  const hrefProps = t.external
    ? { href: t.href, target: "_blank", rel: "noreferrer" }
    : { href: t.href };

  return (
    <div
      className={cx(
        "group relative overflow-hidden rounded-3xl border border-white/10 bg-black/20 p-7",
        "shadow-[0_26px_120px_rgba(0,0,0,0.55)] backdrop-blur-xl",
        "transition duration-300",
        !t.disabled &&
          "hover:border-amber-300/25 hover:bg-black/28 hover:shadow-[0_0_0_1px_rgba(250,204,21,0.10),0_34px_150px_rgba(0,0,0,0.72)]",
        !t.disabled && "hover:-translate-y-[1px]",
        t.disabled && "opacity-55"
      )}
    >
      {/* Glow */}
      <div className="pointer-events-none absolute inset-0 opacity-0 transition duration-300 group-hover:opacity-100">
        <div className="absolute -inset-24 bg-[radial-gradient(circle_at_30%_20%,rgba(250,204,21,0.12),transparent_55%),radial-gradient(circle_at_70%_30%,rgba(255,255,255,0.06),transparent_50%)]" />
      </div>

      <div className="relative z-10 flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] tracking-[0.35em] text-white/45">
            {t.eyebrow}
          </div>
        </div>

        {t.badge ? (
          <div className="rounded-full border border-amber-200/20 bg-amber-200/5 px-3 py-1 text-[10px] tracking-[0.25em] text-amber-200/80">
            {t.badge}
          </div>
        ) : null}
      </div>

      <div className="relative z-10 mt-5">
        <div className="text-2xl font-semibold text-white/92">{t.title}</div>
        <div className="mt-3 text-sm leading-6 text-white/65">{t.description}</div>

        <div className="mt-6">
          {t.disabled ? (
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/60">
              {t.cta}
              <span className="opacity-60">→</span>
            </div>
          ) : (
            <Shell
              {...hrefProps}
              className={cx(
                "inline-flex items-center gap-2 rounded-full border border-amber-200/20 bg-amber-200/5 px-4 py-2 text-sm text-amber-100/90",
                "transition duration-300",
                "hover:border-amber-300/35 hover:bg-amber-200/8 hover:shadow-[0_0_0_1px_rgba(250,204,21,0.12)]"
              )}
            >
              {t.cta}
              <span className="transition group-hover:translate-x-[2px]">→</span>
            </Shell>
          )}
        </div>
      </div>

      {/* subtle bottom rail */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
    </div>
  );
}

function CalendarPanel() {
  // minimal static calendar grid to match your screenshot, no external deps
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-index

  const monthLabel = useMemo(() => {
    return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(
      new Date(year, month, 1)
    );
  }, [year, month]);

  const days = useMemo(() => {
    const first = new Date(year, month, 1);
    const startDow = (first.getDay() + 6) % 7; // Monday=0
    const last = new Date(year, month + 1, 0).getDate();

    const cells: Array<{ day: number; muted: boolean }> = [];
    // leading blanks
    for (let i = 0; i < startDow; i++) cells.push({ day: 0, muted: true });
    // month days
    for (let d = 1; d <= last; d++) cells.push({ day: d, muted: false });
    // trailing to complete rows
    while (cells.length % 7 !== 0) cells.push({ day: 0, muted: true });
    return cells;
  }, [year, month]);

  const today = now.getDate();

  return (
    <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-black/20 p-7 backdrop-blur-xl shadow-[0_26px_120px_rgba(0,0,0,0.55)]">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[11px] tracking-[0.35em] text-amber-200/80">CALENDAR</div>
          <div className="mt-1 text-sm text-white/60">Operator planning instrument</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="h-9 w-9 rounded-full border border-white/10 bg-white/5 text-white/70 transition hover:border-amber-300/25 hover:bg-white/7"
            aria-label="Previous"
            disabled
          >
            ←
          </button>
          <button
            type="button"
            className="h-9 w-9 rounded-full border border-white/10 bg-white/5 text-white/70 transition hover:border-amber-300/25 hover:bg-white/7"
            aria-label="Next"
            disabled
          >
            →
          </button>
        </div>
      </div>

      <div className="mt-6 flex items-center justify-between">
        <div className="text-base font-semibold text-white/90">{monthLabel}</div>
        <div className="text-xs tracking-[0.20em] text-white/35">
          {year}-{pad2(month + 1)}-01 — {year}-{pad2(month + 1)}-{pad2(days.filter((d) => !d.muted).length)}
        </div>
      </div>

      <div className="mt-5 grid grid-cols-7 gap-2">
        {["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"].map((d) => (
          <div key={d} className="text-[10px] tracking-[0.25em] text-white/35 text-center">
            {d}
          </div>
        ))}

        {days.map((c, idx) => {
          const isToday = !c.muted && c.day === today;
          return (
            <div
              key={idx}
              className={cx(
                "h-11 rounded-2xl border text-center text-sm tabular-nums",
                c.muted
                  ? "border-white/5 bg-white/0 text-white/15"
                  : "border-white/10 bg-white/5 text-white/85",
                !c.muted &&
                  "transition hover:border-amber-300/25 hover:bg-amber-200/6 hover:shadow-[0_0_0_1px_rgba(250,204,21,0.10)]",
                isToday && "border-amber-300/25 bg-amber-200/8"
              )}
            >
              <div className="flex h-full items-center justify-center">{c.day ? c.day : ""}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function ConsoleLaunchpadPage() {
  const tiles: Tile[] = [
    {
      eyebrow: "OPERATOR CONSOLE",
      title: "Enter Ledger",
      description:
        "Operator home. From there the OS Dock governs all CI modules (Council, Forge, Archive, etc.).",
      href: HREFS.enterLedger,
      badge: "SOURCE OF TRUTH",
      cta: "Enter",
    },
    {
      eyebrow: "CLIENT SURFACE",
      title: "Client Console",
      description: "Client-facing execution console (separate deployment).",
      href: HREFS.clientConsole,
      badge: "CLIENT",
      cta: "Open",
      external: true,
    },
    {
      eyebrow: "FUTURE WORKSTREAM",
      title: "Operations",
      description: "Reserved. Internal operations module (not active).",
      href: HREFS.operations,
      badge: "SOON",
      cta: "Coming soon",
      disabled: true,
    },
    {
      eyebrow: "INSTITUTIONAL FACE",
      title: "Holdings",
      description: "Suit-and-tie public authority surface.",
      href: HREFS.holdingsPublic,
      badge: "PUBLIC",
      cta: "Open",
      external: true,
    },
  ];

  return (
    // ✅ SCROLL FIX:
    // Make the *page* a fixed-height viewport container, and make MAIN the scroll container.
    // This bypasses any global body/html overflow locks without touching wiring or global CSS.
    <div className="relative h-[100svh] w-full overflow-hidden bg-black">
      {/* background (fixed) */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_12%,rgba(250,204,21,0.10),transparent_42%),radial-gradient(circle_at_78%_18%,rgba(56,189,248,0.10),transparent_46%),radial-gradient(circle_at_42%_90%,rgba(255,255,255,0.06),transparent_55%)]" />
        <div className="absolute inset-0 bg-gradient-to-b from-black via-black/96 to-black" />
      </div>

      {/* Top bar (fixed, non-scrolling) */}
      <TopBar />

      {/* ✅ MAIN is the scroll region */}
      <main className="relative z-10 mt-8 h-[calc(100svh-140px)] overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl px-6 pb-24">
          <div className="mt-8">
            <div className="text-[11px] tracking-[0.40em] text-white/35">
              PRIVATE AUTHORITY SURFACE
            </div>
            <h1 className="mt-4 text-4xl md:text-5xl font-semibold tracking-tight text-white/92">
              Deliberate access to institutional systems.
            </h1>
            <p className="mt-4 max-w-3xl text-base leading-7 text-white/60">
              This console is an entrance — not a workspace. It routes to sovereign chambers.
              Gold indicates verified state and authority actions — never decoration.
            </p>
          </div>

          <div className="mt-10 grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-8 grid grid-cols-1 md:grid-cols-2 gap-6">
              {tiles.map((t) => (
                <TileCard key={t.title} {...t} />
              ))}
            </div>

            <div className="lg:col-span-4">
              <CalendarPanel />
            </div>
          </div>

          {/* footer rail */}
          <div className="mt-12 rounded-3xl border border-white/10 bg-black/20 p-6 text-sm text-white/55 backdrop-blur-xl">
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
              <div className="text-[11px] tracking-[0.35em] text-white/35">
                OASIS COMMAND CONSOLE
              </div>
              <div className="text-white/55">
                Authority routing only · No execution occurs on this surface.
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
