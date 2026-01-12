"use client";

// src/app/console-launchpad/page.tsx
// ✅ FINAL PRISTINE (APPLE × OASIS OS) — COSMETIC ONLY, NO WIRING CHANGES
// ✅ Fixes scroll (main is scroll container)
// ✅ Restores royal navy field + softer vignette (no “too black”)
// ✅ Scroll-reactive glass header (gets “gold-transparent” feel when scrolling)
// ✅ Calendar is interactive: prev/next months + selectable day (cosmetic)
// ✅ Tiles feel tactile (lift + specular sweep + refined glow)
// 🔒 Keep HREFS as-is to avoid any routing/wiring changes

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

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
  primary?: boolean;
};

const HREFS = {
  // 🔒 NO WIRING CHANGES: keep these exactly as your current routes/domains
  enterLedger: "/(console-ledger)",
  clientConsole: "https://ledger.oasisintlholdings.com",
  holdingsPublic: "https://oasisintlholdings.com",
  operations: "/console/operations",
};

function TopBar({ elevated }: { elevated: boolean }) {
  const now = useSystemClock();

  const time = useMemo(() => {
    const h = pad2(now.getHours());
    const m = pad2(now.getMinutes());
    const s = pad2(now.getSeconds());
    return `${h}:${m}:${s}`;
  }, [now]);

  return (
    <div className="relative z-20 mx-auto w-full max-w-7xl px-6 pt-8">
      <div
        className={cx(
          "rounded-[28px] border backdrop-blur-xl transition duration-300",
          elevated
            ? "border-amber-200/18 bg-[#070f24]/48 shadow-[0_40px_160px_rgba(0,0,0,0.62),0_0_0_1px_rgba(250,204,21,0.06)]"
            : "border-white/10 bg-[#070f24]/32 shadow-[0_30px_140px_rgba(0,0,0,0.55),0_0_0_1px_rgba(99,102,241,0.06)]"
        )}
      >
        {/* top hairline */}
        <div
          className={cx(
            "pointer-events-none absolute inset-x-6 top-0 h-px transition duration-300",
            elevated
              ? "bg-gradient-to-r from-transparent via-amber-200/25 to-transparent"
              : "bg-gradient-to-r from-transparent via-white/12 to-transparent"
          )}
        />

        <div className="grid grid-cols-12 items-center gap-4 px-6 py-5">
          <div className="col-span-12 md:col-span-4">
            <div className="text-[11px] tracking-[0.38em] text-amber-200/80">OASIS OS</div>
            <div className="mt-1 text-sm text-white/70">Operator Console · Launchpad</div>
          </div>

          <div className="col-span-12 md:col-span-4 flex justify-center">
            <div
              className={cx(
                "rounded-full border px-5 py-3 backdrop-blur-md transition duration-300",
                elevated ? "border-amber-200/16 bg-black/14" : "border-white/10 bg-black/10",
                "shadow-[0_16px_80px_rgba(0,0,0,0.45),0_0_0_1px_rgba(250,204,21,0.05)]"
              )}
            >
              <div className="text-[10px] tracking-[0.35em] text-white/45 text-center">
                SYSTEM TIME
              </div>
              <div className="mt-1 text-center font-semibold text-white/90 tabular-nums">{time}</div>
            </div>
          </div>

          <div className="col-span-12 md:col-span-4 flex items-center justify-end gap-3">
            <div className="text-right">
              <div className="text-[10px] tracking-[0.35em] text-white/45">SESSION</div>
              {/* keep static to avoid wiring changes */}
              <div className="mt-1 text-sm text-white/85">abbas1167@hotmail.com</div>
            </div>

            {/* Keep your real signout wiring if you already have it elsewhere */}
            <button
              type="button"
              className={cx(
                "rounded-full border px-4 py-2 text-sm transition",
                elevated
                  ? "border-amber-200/16 bg-amber-200/6 text-amber-100/90 hover:border-amber-300/30 hover:bg-amber-200/9"
                  : "border-white/10 bg-white/5 text-white/85 hover:border-amber-300/25 hover:bg-white/7",
                "hover:shadow-[0_0_0_1px_rgba(250,204,21,0.10)]"
              )}
              onClick={() => {
                // safe placeholder; swap back to your real signout handler if needed
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

  const base =
    "group relative overflow-hidden rounded-3xl border p-7 backdrop-blur-xl transition duration-300";
  const surface = t.primary
    ? "border-amber-200/20 bg-[#070f24]/26 shadow-[0_34px_160px_rgba(0,0,0,0.62)]"
    : "border-white/10 bg-[#070f24]/22 shadow-[0_26px_120px_rgba(0,0,0,0.55)]";

  const hover = !t.disabled
    ? t.primary
      ? "hover:border-amber-300/34 hover:bg-[#070f24]/30 hover:shadow-[0_0_0_1px_rgba(250,204,21,0.12),0_40px_190px_rgba(0,0,0,0.74)]"
      : "hover:border-amber-300/25 hover:bg-[#070f24]/28 hover:shadow-[0_0_0_1px_rgba(250,204,21,0.10),0_34px_150px_rgba(0,0,0,0.72)]"
    : "";

  return (
    <div className={cx(base, surface, hover, !t.disabled && "hover:-translate-y-[1px]", t.disabled && "opacity-55")}>
      {/* Specular sweep */}
      <div className="pointer-events-none absolute inset-0 opacity-0 transition duration-300 group-hover:opacity-100">
        <div className="absolute -left-1/2 top-0 h-full w-[160%] rotate-[10deg] bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.06),transparent)] translate-x-[-25%] group-hover:translate-x-[25%] transition duration-700" />
      </div>

      {/* Oasis glow */}
      <div className="pointer-events-none absolute inset-0 opacity-0 transition duration-300 group-hover:opacity-100">
        <div className="absolute -inset-28 bg-[radial-gradient(circle_at_28%_18%,rgba(99,102,241,0.18),transparent_56%),radial-gradient(circle_at_74%_26%,rgba(56,189,248,0.14),transparent_55%),radial-gradient(circle_at_30%_20%,rgba(250,204,21,0.10),transparent_58%)]" />
      </div>

      <div className="relative z-10 flex items-start justify-between gap-3">
        <div className="text-[11px] tracking-[0.35em] text-white/45">{t.eyebrow}</div>

        {t.badge ? (
          <div
            className={cx(
              "rounded-full border px-3 py-1 text-[10px] tracking-[0.25em]",
              t.primary
                ? "border-amber-200/26 bg-amber-200/7 text-amber-200/85"
                : "border-amber-200/20 bg-amber-200/5 text-amber-200/80"
            )}
          >
            {t.badge}
          </div>
        ) : null}
      </div>

      <div className="relative z-10 mt-5">
        <div className={cx("text-2xl font-semibold text-white/92", t.primary && "tracking-[-0.01em]")}>
          {t.title}
        </div>
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
                "inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm transition duration-300",
                t.primary
                  ? "border-amber-200/28 bg-amber-200/9 text-amber-100/95 hover:border-amber-300/40 hover:bg-amber-200/12 hover:shadow-[0_0_0_1px_rgba(250,204,21,0.14)]"
                  : "border-amber-200/20 bg-amber-200/6 text-amber-100/90 hover:border-amber-300/35 hover:bg-amber-200/9 hover:shadow-[0_0_0_1px_rgba(250,204,21,0.12)]",
                "active:translate-y-[1px]"
              )}
            >
              {t.cta}
              <span className="transition group-hover:translate-x-[2px]">→</span>
            </Shell>
          )}
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
    </div>
  );
}

function CalendarPanel() {
  const baseNow = useMemo(() => new Date(), []);
  const [monthOffset, setMonthOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);

  const view = useMemo(() => {
    const d = new Date(baseNow.getFullYear(), baseNow.getMonth() + monthOffset, 1);
    return { year: d.getFullYear(), month: d.getMonth() };
  }, [baseNow, monthOffset]);

  const monthLabel = useMemo(() => {
    return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(
      new Date(view.year, view.month, 1)
    );
  }, [view.year, view.month]);

  const rangeLabel = useMemo(() => {
    const start = new Date(view.year, view.month, 1);
    const end = new Date(view.year, view.month + 1, 0);
    return `${start.getFullYear()}-${pad2(start.getMonth() + 1)}-01 — ${end.getFullYear()}-${pad2(
      end.getMonth() + 1
    )}-${pad2(end.getDate())}`;
  }, [view.year, view.month]);

  const isCurrentMonth = useMemo(() => {
    return view.year === baseNow.getFullYear() && view.month === baseNow.getMonth();
  }, [view.year, view.month, baseNow]);

  const days = useMemo(() => {
    const first = new Date(view.year, view.month, 1);
    const startDow = (first.getDay() + 6) % 7; // Monday=0
    const last = new Date(view.year, view.month + 1, 0).getDate();

    const cells: Array<{ key: string; day: number; muted: boolean }> = [];
    for (let i = 0; i < startDow; i++) cells.push({ key: `b${i}`, day: 0, muted: true });
    for (let d = 1; d <= last; d++) {
      const key = `${view.year}-${pad2(view.month + 1)}-${pad2(d)}`;
      cells.push({ key, day: d, muted: false });
    }
    while (cells.length % 7 !== 0) cells.push({ key: `a${cells.length}`, day: 0, muted: true });
    return cells;
  }, [view.year, view.month]);

  const todayKey = useMemo(() => {
    const y = baseNow.getFullYear();
    const m = pad2(baseNow.getMonth() + 1);
    const d = pad2(baseNow.getDate());
    return `${y}-${m}-${d}`;
  }, [baseNow]);

  return (
    <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-[#070f24]/22 p-7 backdrop-blur-xl shadow-[0_26px_120px_rgba(0,0,0,0.55)]">
      {/* panel glow */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -inset-24 opacity-60 bg-[radial-gradient(circle_at_80%_10%,rgba(56,189,248,0.12),transparent_56%),radial-gradient(circle_at_20%_20%,rgba(99,102,241,0.12),transparent_58%)]" />
      </div>

      <div className="relative z-10 flex items-center justify-between">
        <div>
          <div className="text-[11px] tracking-[0.35em] text-amber-200/80">CALENDAR</div>
          <div className="mt-1 text-sm text-white/60">Operator planning instrument</div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            className="h-9 w-9 rounded-full border border-white/10 bg-white/5 text-white/80 transition hover:border-amber-300/25 hover:bg-white/7 hover:shadow-[0_0_0_1px_rgba(250,204,21,0.10)] active:translate-y-[1px]"
            aria-label="Previous month"
            onClick={() => setMonthOffset((v) => v - 1)}
          >
            ←
          </button>
          <button
            type="button"
            className="h-9 w-9 rounded-full border border-white/10 bg-white/5 text-white/80 transition hover:border-amber-300/25 hover:bg-white/7 hover:shadow-[0_0_0_1px_rgba(250,204,21,0.10)] active:translate-y-[1px]"
            aria-label="Next month"
            onClick={() => setMonthOffset((v) => v + 1)}
          >
            →
          </button>
        </div>
      </div>

      <div className="relative z-10 mt-6 flex items-center justify-between">
        <div className="text-base font-semibold text-white/90">{monthLabel}</div>
        <div className="text-xs tracking-[0.20em] text-white/35">{rangeLabel}</div>
      </div>

      <div className="relative z-10 mt-5 grid grid-cols-7 gap-2">
        {["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"].map((d) => (
          <div key={d} className="text-[10px] tracking-[0.25em] text-white/35 text-center">
            {d}
          </div>
        ))}

        {days.map((c) => {
          const isToday = !c.muted && isCurrentMonth && c.key === todayKey;
          const isSelected = !c.muted && selected === c.key;

          return (
            <button
              key={c.key}
              type="button"
              disabled={c.muted}
              onClick={() => !c.muted && setSelected(c.key)}
              className={cx(
                "h-11 rounded-2xl border text-center text-sm tabular-nums transition",
                c.muted
                  ? "cursor-default border-white/5 bg-white/0 text-white/15"
                  : "border-white/10 bg-white/5 text-white/85 hover:border-amber-300/25 hover:bg-amber-200/6 hover:shadow-[0_0_0_1px_rgba(250,204,21,0.10)] active:translate-y-[1px]",
                isToday && "border-amber-300/25 bg-amber-200/10",
                isSelected && "border-amber-200/30 bg-amber-200/12 shadow-[0_0_0_1px_rgba(250,204,21,0.12)]"
              )}
              aria-label={c.muted ? "Empty" : `Select ${c.key}`}
            >
              {c.day ? c.day : ""}
            </button>
          );
        })}
      </div>

      <div className="relative z-10 mt-5 flex items-center justify-between">
        <div className="text-xs text-white/45">
          {selected ? (
            <>
              Selected: <span className="text-white/75 tabular-nums">{selected}</span>
            </>
          ) : (
            <>Select a day (cosmetic)</>
          )}
        </div>

        <button
          type="button"
          className="text-xs rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-white/70 transition hover:border-amber-300/25 hover:bg-white/7 active:translate-y-[1px]"
          onClick={() => {
            setMonthOffset(0);
            setSelected(null);
          }}
        >
          Today
        </button>
      </div>
    </div>
  );
}

export default function ConsoleLaunchpadPage() {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [elevated, setElevated] = useState(false);

  const tiles: Tile[] = [
    {
      eyebrow: "OPERATOR CONSOLE",
      title: "Enter Ledger",
      description:
        "Operator home. From there the OS Dock governs all CI modules (Council, Forge, Archive, etc.).",
      href: HREFS.enterLedger,
      badge: "SOURCE OF TRUTH",
      cta: "Enter",
      primary: true,
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
    <div className="relative h-[100svh] w-full overflow-hidden bg-[#040816]">
      {/* Royal Navy Oasis Field */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_22%_14%,rgba(56,189,248,0.18),transparent_48%),radial-gradient(circle_at_78%_22%,rgba(99,102,241,0.16),transparent_52%),radial-gradient(circle_at_46%_92%,rgba(255,255,255,0.07),transparent_58%),radial-gradient(circle_at_18%_12%,rgba(250,204,21,0.11),transparent_44%)]" />
        <div className="absolute inset-0 bg-gradient-to-b from-[#040816]/26 via-[#040816]/62 to-[#02040c]" />
      </div>

      <TopBar elevated={elevated} />

      {/* ✅ MAIN is the scroll region (scroll-reactive header listens here) */}
      <div
        ref={scrollRef}
        className="relative z-10 mt-8 h-[calc(100svh-140px)] overflow-y-auto"
        onScroll={(e) => {
          const top = (e.currentTarget as HTMLDivElement).scrollTop;
          // small threshold so it “clicks” into glassy elevated mode
          setElevated(top > 8);
        }}
      >
        <div className="mx-auto w-full max-w-7xl px-6 pb-24">
          <div className="mt-8">
            <div className="text-[11px] tracking-[0.40em] text-white/35">
              PRIVATE AUTHORITY SURFACE
            </div>
            <h1 className="mt-4 text-4xl md:text-5xl font-semibold tracking-tight text-white/92">
              Deliberate access to institutional systems.
            </h1>
            <p className="mt-4 max-w-3xl text-base leading-7 text-white/60">
              This console is an entrance — not a workspace. It routes to sovereign chambers. Gold indicates
              verified state and authority actions — never decoration.
            </p>
          </div>

          {/* Depth plate behind the grid (subtle royal floor) */}
          <div className="relative mt-10">
            <div className="pointer-events-none absolute -inset-6 rounded-[40px] bg-[#060d22]/22 blur-0" />

            <div className="relative grid grid-cols-1 lg:grid-cols-12 gap-6">
              <div className="lg:col-span-8 grid grid-cols-1 md:grid-cols-2 gap-6">
                {tiles.map((t) => (
                  <TileCard key={t.title} {...t} />
                ))}
              </div>

              <div className="lg:col-span-4">
                <CalendarPanel />
              </div>
            </div>
          </div>

          <div className="mt-12 rounded-3xl border border-white/10 bg-[#070f24]/18 p-6 text-sm text-white/55 backdrop-blur-xl">
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
              <div className="text-[11px] tracking-[0.35em] text-white/35">OASIS COMMAND CONSOLE</div>
              <div className="text-white/55">Authority routing only · No execution occurs on this surface.</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
