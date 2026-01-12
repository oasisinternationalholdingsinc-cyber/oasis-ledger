"use client";

export const dynamic = "force-dynamic";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";

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

/** ===== Calendar (UI-only, Supabase-ready) ===== */
type CalEvent = {
  id: string;
  title: string;
  kind?: "meeting" | "deadline" | "reminder" | "block";
  startAt?: string; // ISO
  endAt?: string; // ISO
};

function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function endOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}
function startOfWeek(d: Date) {
  const x = new Date(d);
  const day = x.getDay(); // 0=Sun
  x.setDate(x.getDate() - day);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d: Date, days: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}
function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function ymd(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function monthLabel(d: Date) {
  return d.toLocaleString(undefined, { month: "long", year: "numeric" });
}
function dowShort(i: number) {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][i] ?? "";
}

function CalendarInstrument({
  className,
}: {
  className?: string;
}) {
  const [cursor, setCursor] = useState<Date>(() => new Date());
  const [selected, setSelected] = useState<Date>(() => new Date());

  // UI-only events for now (Supabase-ready hook point later)
  const eventsByDay = useMemo(() => {
    // Later: fetch from Supabase for month range and group by ymd(date)
    const map = new Map<string, CalEvent[]>();
    // empty by default – calm instrument
    return map;
  }, []);

  const monthStart = useMemo(() => startOfMonth(cursor), [cursor]);
  const monthEnd = useMemo(() => endOfMonth(cursor), [cursor]);

  const gridStart = useMemo(() => startOfWeek(monthStart), [monthStart]);
  const gridDays = useMemo(() => {
    // 6 weeks grid (42 days) for stable layout
    return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  }, [gridStart]);

  const selectedKey = useMemo(() => ymd(selected), [selected]);
  const selectedEvents = useMemo(() => eventsByDay.get(selectedKey) || [], [eventsByDay, selectedKey]);

  return (
    <aside
      className={cx(
        "relative overflow-hidden rounded-3xl border border-white/10 bg-black/25 shadow-[0_28px_120px_rgba(0,0,0,0.55)] backdrop-blur-xl",
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-6 py-5">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.28em] text-amber-300/85">Calendar</div>
          <div className="mt-1 text-xs text-slate-400">Operator planning instrument</div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              const prev = new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1);
              setCursor(prev);
            }}
            className="rounded-full border border-white/10 bg-black/35 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:border-amber-300/25 hover:bg-black/45"
          >
            ←
          </button>
          <button
            type="button"
            onClick={() => {
              const next = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
              setCursor(next);
            }}
            className="rounded-full border border-white/10 bg-black/35 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:border-amber-300/25 hover:bg-black/45"
          >
            →
          </button>
        </div>
      </div>

      <div className="px-6 pb-5">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-100">{monthLabel(cursor)}</div>
          <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">
            {ymd(monthStart)} — {ymd(monthEnd)}
          </div>
        </div>

        {/* DOW */}
        <div className="mt-4 grid grid-cols-7 gap-2">
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} className="px-1 text-center text-[10px] uppercase tracking-[0.22em] text-slate-500">
              {dowShort(i)}
            </div>
          ))}
        </div>

        {/* Grid */}
        <div className="mt-2 grid grid-cols-7 gap-2">
          {gridDays.map((d) => {
            const inMonth = d.getMonth() === cursor.getMonth();
            const isToday = sameDay(d, new Date());
            const isSelected = sameDay(d, selected);
            const k = ymd(d);
            const dots = Math.min(3, (eventsByDay.get(k) || []).length);

            return (
              <button
                key={k}
                type="button"
                onClick={() => setSelected(d)}
                className={cx(
                  "relative flex h-11 flex-col items-center justify-center rounded-2xl border text-xs transition",
                  inMonth ? "border-white/10 bg-black/20" : "border-white/5 bg-black/10",
                  "hover:border-amber-300/20 hover:bg-black/30",
                  isSelected && "border-amber-300/25 bg-amber-950/10",
                  isToday && "shadow-[0_0_0_1px_rgba(250,204,21,0.10)]"
                )}
              >
                <span className={cx("font-semibold", inMonth ? "text-slate-200" : "text-slate-500")}>{d.getDate()}</span>

                {/* dots */}
                <div className="mt-1 flex items-center gap-1">
                  {Array.from({ length: dots }, (_, i) => (
                    <span key={i} className="h-1 w-1 rounded-full bg-amber-300/70" />
                  ))}
                </div>

                {/* today ring */}
                {isToday ? (
                  <span className="pointer-events-none absolute inset-0 rounded-2xl border border-amber-300/15" />
                ) : null}
              </button>
            );
          })}
        </div>

        {/* Detail panel */}
        <div className="mt-5 overflow-hidden rounded-2xl border border-white/10 bg-black/20">
          <div className="flex items-start justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Selected</div>
              <div className="mt-1 text-sm font-semibold text-slate-100">
                {selected.toLocaleString(undefined, { weekday: "long", month: "long", day: "numeric" })}
              </div>
            </div>

            <button
              type="button"
              disabled
              className="rounded-full border border-white/10 bg-black/20 px-3 py-1.5 text-xs font-semibold text-slate-500"
              title="Supabase-backed soon"
            >
              Add note (soon)
            </button>
          </div>

          <div className="px-4 pb-4">
            {selectedEvents.length === 0 ? (
              <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-slate-400">
                No items scheduled. (Supabase-backed soon.)
              </div>
            ) : (
              <div className="space-y-2">
                {selectedEvents.map((e) => (
                  <div key={e.id} className="rounded-2xl border border-white/10 bg-black/20 p-3">
                    <div className="text-sm font-semibold text-slate-100">{e.title}</div>
                    <div className="mt-1 text-xs text-slate-500">{e.kind || "reminder"}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* subtle radial */}
        <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-amber-400/5 blur-3xl" />
        <div className="pointer-events-none absolute -left-28 -bottom-28 h-72 w-72 rounded-full bg-sky-400/4 blur-3xl" />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[1px] bg-gradient-to-r from-transparent via-amber-300/20 to-transparent" />
      </div>
    </aside>
  );
}

/** ===== Tiles ===== */
type Tile = {
  eyebrow: string;
  title: string;
  description: string;
  href: string;
  badge?: string;
  cta: string;
  disabled?: boolean;
  external?: boolean;
};

function TileCard(t: Tile) {
  const disabled = Boolean(t.disabled);

  const base =
    "group relative overflow-hidden rounded-3xl border border-white/10 bg-black/25 p-7 " +
    "shadow-[0_28px_120px_rgba(0,0,0,0.55)] backdrop-blur-xl transition";

  const hover =
    "hover:border-amber-300/25 hover:bg-black/30 " +
    "hover:shadow-[0_0_0_1px_rgba(250,204,21,0.12),0_34px_140px_rgba(0,0,0,0.70)] " +
    "hover:-translate-y-[1px]";

  const disabledFx =
    "opacity-55 cursor-not-allowed hover:translate-y-0 hover:shadow-[0_28px_120px_rgba(0,0,0,0.55)]";

  const Inner = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="text-[10px] uppercase tracking-[0.28em] text-slate-500">{t.eyebrow}</div>
        {t.badge ? (
          <div className="rounded-full border border-amber-300/20 bg-amber-950/10 px-3 py-1 text-[10px] uppercase tracking-[0.22em] text-amber-200">
            {t.badge}
          </div>
        ) : null}
      </div>

      <div className="mt-3 text-xl font-semibold text-slate-100">{t.title}</div>
      <div className="mt-2 text-sm leading-relaxed text-slate-400">{t.description}</div>

      <div
        className={cx(
          "mt-6 inline-flex items-center gap-2 rounded-full border px-4 py-2 text-xs font-semibold transition",
          disabled
            ? "border-white/10 bg-black/20 text-slate-400"
            : "border-amber-300/25 bg-amber-950/10 text-amber-200 group-hover:bg-amber-950/15"
        )}
      >
        {t.cta}
        <span className="opacity-80">→</span>
      </div>

      {/* subtle radial */}
      <div className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-amber-400/5 blur-3xl" />
      <div className="pointer-events-none absolute -left-28 -bottom-28 h-64 w-64 rounded-full bg-sky-400/4 blur-3xl" />

      {/* interactive sheen */}
      <div className="pointer-events-none absolute inset-0 opacity-0 transition group-hover:opacity-100">
        <div className="absolute inset-x-0 top-0 h-[1px] bg-gradient-to-r from-transparent via-amber-300/25 to-transparent" />
        <div className="absolute -top-24 left-1/2 h-48 w-96 -translate-x-1/2 rounded-full bg-white/5 blur-3xl" />
      </div>
    </>
  );

  if (disabled) {
    return (
      <div className={cx(base, disabledFx)}>
        {Inner}
        <div className="pointer-events-none absolute inset-0 bg-black/10" />
      </div>
    );
  }

  if (t.external) {
    return (
      <a href={t.href} target="_blank" rel="noreferrer" className={cx(base, hover)}>
        {Inner}
      </a>
    );
  }

  return (
    <Link href={t.href} className={cx(base, hover)}>
      {Inner}
    </Link>
  );
}

export default function ConsoleLaunchpadPage() {
  const router = useRouter();
  const pathname = usePathname();
  const now = useSystemClock();

  const [booting, setBooting] = useState(true);
  const [email, setEmail] = useState<string>("");

  // ✅ Authenticated entrance (LAUNCHPAD only). Does NOT touch Ledger internals.
  useEffect(() => {
    let alive = true;

    const bounceToLogin = (p?: string | null) => {
      const raw = p && p.startsWith("/") && !p.startsWith("//") ? p : "/console-launchpad";
      const next = encodeURIComponent(raw);
      router.replace(`/login?next=${next}`);
    };

    (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!alive) return;

      if (!session) {
        bounceToLogin(pathname || "/console-launchpad");
        return;
      }

      setEmail(session.user?.email || "Authenticated");
      setBooting(false);
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((_event: AuthChangeEvent, session: Session | null) => {
      if (!session) bounceToLogin(pathname || "/console-launchpad");
    });

    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, [router, pathname]);

  const systemTime = useMemo(() => {
    return `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  }, [now]);

  // ✅ Your new tile plan (no CI shortcuts here)
  const tiles: Tile[] = useMemo(
    () => [
      {
        eyebrow: "Operator Console",
        title: "Enter Ledger",
        description: "Operator home. From there the OS Dock governs all CI modules (Council, Forge, Archive, etc.).",
        // IMPORTANT: keep your working route. You had /console; do not change wiring here.
        href: "/console",
        badge: "SOURCE OF TRUTH",
        cta: "Enter",
      },
      {
        eyebrow: "Client Surface",
        title: "Client Console",
        description: "Client-facing execution console (separate deployment).",
        href: "https://ledger.oasisintlholdings.com",
        badge: "CLIENT",
        cta: "Open",
        external: true,
      },
      {
        eyebrow: "Future Workstream",
        title: "Operations",
        description: "Reserved. Internal operations module (disabled until defined).",
        href: "#",
        badge: "SOON",
        cta: "Disabled",
        disabled: true,
      },
      {
        eyebrow: "Institutional Face",
        title: "Holdings",
        description: "Suit-and-tie public authority surface.",
        href: "https://oasisintlholdings.com",
        badge: "PUBLIC",
        cta: "Open",
        external: true,
      },
      {
        eyebrow: "Market Surface",
        title: "Real Estate",
        description: "Client-facing listings and leasing surface.",
        href: "https://oasisintlrealestate.com",
        badge: "PUBLIC",
        cta: "Open",
        external: true,
      },
    ],
    []
  );

  async function signOut() {
    try {
      await supabase.auth.signOut();
    } finally {
      window.location.href = "/login?next=%2Fconsole-launchpad";
    }
  }

  return (
    // ✅ SCROLL + VIBE: ink base with ambient blush, natural document scroll
    <div className="min-h-screen w-full bg-[#020617]">
      {/* Ambient background (fixed, calm) */}
      <div className="pointer-events-none fixed inset-0">
        <div className="absolute -left-48 -top-56 h-[560px] w-[560px] rounded-full bg-amber-400/7 blur-3xl" />
        <div className="absolute -right-56 -top-72 h-[620px] w-[620px] rounded-full bg-sky-400/6 blur-3xl" />
        <div className="absolute left-1/2 top-[28%] h-[520px] w-[720px] -translate-x-1/2 rounded-full bg-fuchsia-400/4 blur-3xl" />
        <div className="absolute inset-x-0 top-0 h-[1px] bg-gradient-to-r from-transparent via-white/10 to-transparent" />
      </div>

      <div className="relative mx-auto w-full max-w-6xl px-6 pb-20 pt-6">
        {/* ✅ STICKY + INTERACTIVE HEADER */}
        <div className="sticky top-4 z-50">
          <div
            className={cx(
              "relative overflow-hidden rounded-[28px] border border-white/10 bg-black/25 shadow-[0_30px_140px_rgba(0,0,0,0.65)] backdrop-blur-xl transition",
              "hover:border-amber-300/20 hover:bg-black/30 hover:shadow-[0_0_0_1px_rgba(250,204,21,0.10),0_34px_160px_rgba(0,0,0,0.72)]"
            )}
          >
            <div className="flex flex-col gap-4 px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
              {/* Left */}
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-[0.28em] text-amber-300">OASIS OS</div>
                <div className="mt-1 text-xs text-slate-400">Operator Console • Launchpad</div>
              </div>

              {/* Center clock */}
              <div className="flex items-center justify-start sm:justify-center">
                <div className="rounded-full border border-white/10 bg-black/35 px-4 py-2 transition hover:border-amber-300/20 hover:bg-black/45">
                  <div className="text-[10px] uppercase tracking-[0.28em] text-slate-500">System Time</div>
                  <div className="mt-1 text-sm font-semibold tracking-[0.22em] text-slate-100">{systemTime}</div>
                </div>
              </div>

              {/* Right session */}
              <div className="flex items-center justify-between gap-3 sm:justify-end">
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-[0.28em] text-slate-500">Session</div>
                  <div className="mt-1 truncate text-sm text-slate-200">{email || "—"}</div>
                </div>

                <button
                  onClick={signOut}
                  className={cx(
                    "shrink-0 rounded-full border border-white/10 bg-black/35 px-4 py-2 text-xs font-semibold text-slate-200 transition",
                    "hover:border-amber-300/25 hover:bg-black/45 hover:-translate-y-[1px]"
                  )}
                >
                  Sign out
                </button>
              </div>
            </div>

            {/* subtle top glow */}
            <div className="pointer-events-none absolute inset-x-0 top-0 h-[1px] bg-gradient-to-r from-transparent via-amber-300/20 to-transparent" />
            <div className="pointer-events-none absolute -left-32 -top-40 h-96 w-96 rounded-full bg-amber-400/6 blur-3xl" />
            <div className="pointer-events-none absolute -right-40 -top-56 h-[420px] w-[420px] rounded-full bg-sky-400/5 blur-3xl" />
          </div>
        </div>

        {/* Hero */}
        <div className="mt-10 max-w-3xl">
          <div className="text-[11px] uppercase tracking-[0.28em] text-slate-500">Private Authority Surface</div>
          <h1 className="mt-3 text-3xl font-semibold text-slate-100">Deliberate access to institutional systems.</h1>
          <p className="mt-4 text-sm leading-relaxed text-slate-400">
            This console is an entrance — not a workspace. It routes to sovereign chambers. Gold indicates verified state
            and authority actions — never decoration.
          </p>
        </div>

        {/* ✅ Tiles + Calendar (Apple OS vibe, never overpowering) */}
        <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-12">
          {/* Tiles */}
          <div className="lg:col-span-7">
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              {tiles.map((t) => (
                <TileCard key={t.title} {...t} />
              ))}
            </div>

            {/* Bottom fade hint (feels intentional when scrolling) */}
            <div className="pointer-events-none mt-10 h-10 w-full bg-gradient-to-b from-transparent to-[#020617]" />
          </div>

          {/* Calendar instrument */}
          <div className="lg:col-span-5">
            <CalendarInstrument className="lg:sticky lg:top-[104px]" />
          </div>
        </div>

        {/* Authority footer */}
        <div className="mt-14">
          <div className="rounded-3xl border border-white/10 bg-black/20 px-6 py-5 shadow-[0_24px_120px_rgba(0,0,0,0.45)] backdrop-blur-xl">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-xs text-slate-400">
                <span className="text-slate-200">Oasis International Holdings Inc</span> • Operator Launchpad
              </div>
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
                {booting ? "Authenticating…" : "Authenticated"} • Read-first • Authority-gated
              </div>
              <div className="text-xs text-slate-400">Gold = authority signal • Never decoration</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
