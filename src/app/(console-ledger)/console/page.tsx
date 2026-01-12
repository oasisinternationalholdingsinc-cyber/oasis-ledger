"use client";

export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export default function ConsoleHomePage() {
  const router = useRouter();
  const now = useClock();

  const [email, setEmail] = useState<string>("");

  // ✅ Hard auth gate (ledger internal)
  useEffect(() => {
    let alive = true;

    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!alive) return;

      if (!data.session) {
        router.replace("/login?next=%2Fconsole");
        return;
      }

      setEmail(data.session.user.email || "Operator");
    })();

    return () => {
      alive = false;
    };
  }, [router]);

  const systemTime = useMemo(
    () =>
      `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(
        now.getSeconds()
      )}`,
    [now]
  );

  return (
    <div className="min-h-screen w-full bg-black">
      <div className="mx-auto max-w-6xl px-6 py-10">
        {/* ===== HEADER ===== */}
        <div className="relative overflow-hidden rounded-[28px] border border-white/10 bg-black/30 shadow-[0_40px_160px_rgba(0,0,0,0.7)] backdrop-blur-xl">
          <div className="flex flex-col gap-4 px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
            {/* Left */}
            <div>
              <div className="text-[11px] uppercase tracking-[0.28em] text-amber-300">
                OASIS OS
              </div>
              <div className="mt-1 text-xs text-slate-400">
                Operator Console • Ledger Home
              </div>
            </div>

            {/* Center clock */}
            <div className="rounded-full border border-white/10 bg-black/40 px-4 py-2 text-center">
              <div className="text-[10px] uppercase tracking-[0.28em] text-slate-500">
                System Time
              </div>
              <div className="mt-1 text-sm font-semibold tracking-[0.22em] text-slate-100">
                {systemTime}
              </div>
            </div>

            {/* Right */}
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-[0.28em] text-slate-500">
                Session
              </div>
              <div className="mt-1 text-sm text-slate-200 truncate">
                {email || "—"}
              </div>
            </div>
          </div>

          {/* ambient glows */}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-[1px] bg-gradient-to-r from-transparent via-amber-300/30 to-transparent" />
          <div className="pointer-events-none absolute -left-40 -top-56 h-[420px] w-[420px] rounded-full bg-amber-400/8 blur-3xl" />
          <div className="pointer-events-none absolute -right-40 -top-64 h-[420px] w-[420px] rounded-full bg-sky-400/6 blur-3xl" />
        </div>

        {/* ===== BODY ===== */}
        <div className="mt-14 max-w-3xl">
          <div className="text-[11px] uppercase tracking-[0.28em] text-slate-500">
            Institutional Record
          </div>

          <h1 className="mt-3 text-3xl font-semibold text-slate-100">
            Digital Parliament Ledger
          </h1>

          <p className="mt-4 text-sm leading-relaxed text-slate-400">
            This is the operator home for the canonical system of record.
            All governance activity is routed through controlled chambers
            (Council, Forge, Archive).  
            <br />
            <br />
            This surface performs no execution — authority is exercised only
            inside CI modules.
          </p>
        </div>

        {/* ===== STATUS STRIP ===== */}
        <div className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {[
            ["Admissions", "Queue & intake authority"],
            ["Council", "Deliberation & approval"],
            ["Forge", "Execution & sealing"],
          ].map(([title, desc]) => (
            <div
              key={title}
              className="rounded-2xl border border-white/10 bg-black/25 px-5 py-4 backdrop-blur-xl"
            >
              <div className="text-xs uppercase tracking-[0.22em] text-amber-300">
                {title}
              </div>
              <div className="mt-2 text-sm text-slate-400">{desc}</div>
            </div>
          ))}
        </div>

        {/* ===== FOOT NOTE ===== */}
        <div className="mt-16 text-center text-xs text-slate-500">
          Ledger is the source of truth • Archive is immutable • Authority is logged
        </div>
      </div>
    </div>
  );
}
