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
};

function TileCard(t: Tile) {
  return (
    <Link
      href={t.href}
      className={cx(
        "group relative overflow-hidden rounded-3xl border border-white/10 bg-black/25 p-7",
        "shadow-[0_28px_120px_rgba(0,0,0,0.55)] backdrop-blur-xl transition",
        "hover:border-amber-300/25 hover:bg-black/30 hover:shadow-[0_0_0_1px_rgba(250,204,21,0.12),0_34px_140px_rgba(0,0,0,0.70)]"
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

      <div className="mt-6 inline-flex items-center gap-2 rounded-full border border-amber-300/25 bg-amber-950/10 px-4 py-2 text-xs font-semibold text-amber-200 transition group-hover:bg-amber-950/15">
        {t.cta}
        <span className="opacity-80">→</span>
      </div>

      {/* subtle radial */}
      <div className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-amber-400/5 blur-3xl" />
      <div className="pointer-events-none absolute -left-28 -bottom-28 h-64 w-64 rounded-full bg-sky-400/4 blur-3xl" />
    </Link>
  );
}

export default function ConsolePage() {
  const router = useRouter();
  const pathname = usePathname();
  const now = useSystemClock();

  const [booting, setBooting] = useState(true);
  const [email, setEmail] = useState<string>("");

  // ✅ Authenticated entrance (console only). DOES NOT TOUCH (os).
  useEffect(() => {
    let alive = true;

    (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!alive) return;

      if (!session) {
        const next = encodeURIComponent(pathname || "/console");
        router.replace(`/login?next=${next}`);
        return;
      }

      const u = session.user;
      setEmail(u?.email || "Authenticated");
      setBooting(false);
    })();

    const { data: sub } = supabase.auth.onAuthStateChange(
      (_evt: AuthChangeEvent, sess: Session | null) => {
        if (!sess) {
          const next = encodeURIComponent(pathname || "/console");
          router.replace(`/login?next=${next}`);
        }
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

  const tiles: Tile[] = useMemo(
    () => [
      {
        eyebrow: "Institutional Record",
        title: "Digital Parliament Ledger",
        description:
          "Canonical system of record for governance, resolutions, compliance, signatures, and archive discipline.",
        href: "/ci-council",
        badge: "SOURCE OF TRUTH",
        cta: "Enter Ledger",
      },
      {
        eyebrow: "Admission Authority",
        title: "CI-Admissions",
        description: "Review intake, request evidence, record decisions, and provision entities under mandate.",
        href: "/ci-admissions",
        badge: "QUEUE",
        cta: "Open Admissions",
      },
      {
        eyebrow: "Execution Chamber",
        title: "CI-Forge",
        description: "Signature-required execution only. Envelopes, signing ceremonies, and controlled sealing.",
        href: "/ci-forge",
        badge: "SIGNATURE",
        cta: "Open Forge",
      },
      {
        eyebrow: "Registry of Record",
        title: "CI-Archive",
        description: "Minute Book registry, verified documents, and immutable archive surfaces. Repair-safe.",
        href: "/ci-archive/minute-book",
        badge: "SEALED",
        cta: "Access Archive",
      },
    ],
    []
  );

  async function signOut() {
    try {
      await supabase.auth.signOut();
    } finally {
      window.location.href = "/login?next=%2Fconsole";
    }
  }

  return (
    <div className="min-h-[calc(100vh-1px)] w-full">
      <div className="mx-auto w-full max-w-6xl px-6 pb-16 pt-8">
        {/* Stocky glass header */}
        <div className="relative overflow-hidden rounded-[28px] border border-white/10 bg-black/25 shadow-[0_30px_140px_rgba(0,0,0,0.65)] backdrop-blur-xl">
          <div className="flex flex-col gap-4 px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
            {/* Left: system identity */}
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-[0.28em] text-amber-300">OASIS OS</div>
              <div className="mt-1 text-xs text-slate-400">Operator Console • Authority Entrance</div>
            </div>

            {/* Center: digital clock */}
            <div className="flex items-center justify-start sm:justify-center">
              <div className="rounded-full border border-white/10 bg-black/35 px-4 py-2">
                <div className="text-[10px] uppercase tracking-[0.28em] text-slate-500">System Time</div>
                <div className="mt-1 text-sm font-semibold tracking-[0.22em] text-slate-100">{systemTime}</div>
              </div>
            </div>

            {/* Right: session + sign out */}
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

        {/* Footer note */}
        <div className="mt-14 text-center text-xs text-slate-500">
          {booting ? "Authenticating…" : "Authenticated"} • Execution remains chamber-bound • Console performs no writes
        </div>
      </div>
    </div>
  );
}
