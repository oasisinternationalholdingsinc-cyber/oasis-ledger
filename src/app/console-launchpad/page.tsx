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

function TileCard(t: Tile) {
  const content = (
    <div
      className={cx(
        "group relative overflow-hidden rounded-3xl border border-white/10 bg-black/25 p-7",
        "shadow-[0_28px_120px_rgba(0,0,0,0.55)] backdrop-blur-xl transition",
        t.disabled
          ? "opacity-55 cursor-not-allowed"
          : "hover:border-amber-300/25 hover:bg-black/30 hover:shadow-[0_0_0_1px_rgba(250,204,21,0.12),0_34px_140px_rgba(0,0,0,0.70)]"
      )}
    >
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
          "mt-6 inline-flex items-center gap-2 rounded-full border border-amber-300/25 bg-amber-950/10 px-4 py-2 text-xs font-semibold text-amber-200 transition",
          !t.disabled && "group-hover:bg-amber-950/15"
        )}
      >
        {t.cta}
        <span className="opacity-80">→</span>
      </div>

      {/* subtle radial */}
      <div className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-amber-400/5 blur-3xl" />
      <div className="pointer-events-none absolute -left-28 -bottom-28 h-64 w-64 rounded-full bg-sky-400/4 blur-3xl" />
    </div>
  );

  if (t.disabled) return <div aria-disabled="true">{content}</div>;

  if (t.external) {
    return (
      <a href={t.href} target="_blank" rel="noreferrer" className="block">
        {content}
      </a>
    );
  }

  return (
    <Link href={t.href} className="block">
      {content}
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

    const { data: sub } = supabase.auth.onAuthStateChange(
      (_event: AuthChangeEvent, session: Session | null) => {
        if (!session) bounceToLogin(pathname || "/console-launchpad");
      }
    );

    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, [router, pathname]);

  const systemTime = useMemo(() => {
    return `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  }, [now]);

  // ✅ FINAL TILE MAP (no 404s)
  // - Enter Ledger -> /console (your operator home inside this same repo)
  // - Client Console -> external (ledger.oasis... project)
  // - Operations -> disabled for now
  // - Holdings -> external
  // - Real Estate -> external
  const tiles: Tile[] = useMemo(
    () => [
      {
        eyebrow: "Operator Console",
        title: "Enter Ledger",
        description: "Operator home. From here the OS Dock governs all CI modules (Council, Forge, Archive, etc.).",
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
        eyebrow: "Real Estate",
        title: "Real Estate",
        description: "Oasis International Real Estate.",
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
    <div className="min-h-[calc(100vh-1px)] w-full">
      <div className="mx-auto w-full max-w-6xl px-6 pb-16 pt-8">
        {/* Stocky glass header */}
        <div className="relative overflow-hidden rounded-[28px] border border-white/10 bg-black/25 shadow-[0_30px_140px_rgba(0,0,0,0.65)] backdrop-blur-xl">
          <div className="flex flex-col gap-4 px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
            {/* Left */}
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-[0.28em] text-amber-300">OASIS OS</div>
              <div className="mt-1 text-xs text-slate-400">Operator Console • Launchpad</div>
            </div>

            {/* Center clock */}
            <div className="flex items-center justify-start sm:justify-center">
              <div className="rounded-full border border-white/10 bg-black/35 px-4 py-2">
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
                  "hover:border-amber-300/25 hover:bg-black/45"
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

        {/* Hero */}
        <div className="mt-10 max-w-3xl">
          <div className="text-[11px] uppercase tracking-[0.28em] text-slate-500">Private Authority Surface</div>
          <h1 className="mt-3 text-3xl font-semibold text-slate-100">Deliberate access to institutional systems.</h1>
          <p className="mt-4 text-sm leading-relaxed text-slate-400">
            This console is an entrance — not a workspace. It routes to sovereign chambers. Gold indicates verified state
            and authority actions — never decoration.
          </p>
        </div>

        {/* Tiles */}
        <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-2">
          {tiles.map((t) => (
            <TileCard key={t.title} {...t} />
          ))}
        </div>

        <div className="mt-14 text-center text-xs text-slate-500">
          {booting ? "Authenticating…" : "Authenticated"} • Execution remains chamber-bound • Console performs no writes
        </div>
      </div>
    </div>
  );
}
