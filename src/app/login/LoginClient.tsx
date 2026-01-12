"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";

function isSafeNext(raw: string | null) {
  if (!raw) return false;
  const s = raw.trim();
  // must be an internal path (no protocol, no //)
  if (!s.startsWith("/")) return false;
  if (s.startsWith("//")) return false;
  return true;
}

export default function LoginClient() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // ✅ Enterprise default entry: Console Launchpad
  // (Public portal stays unauthenticated; operators authenticate to enter console.)
  const nextPath = useMemo(() => {
    const raw = searchParams.get("next");
    return isSafeNext(raw) ? raw!.trim() : "/console-launchpad";
  }, [searchParams]);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [systemTime, setSystemTime] = useState("");

  useEffect(() => {
    const updateTime = () => {
      const utc = new Date().toISOString().substring(11, 19);
      setSystemTime(utc + " UTC");
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  const handleLogin = async () => {
    if (!email || !password || loading) return;

    setLoading(true);

    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    setLoading(false);

    if (error) {
      alert("Invalid credentials.");
      return;
    }

    // ✅ go where the gate asked us to go (or default to Launchpad)
    router.replace(nextPath);
  };

  return (
    <main className="min-h-screen bg-[#020617] flex flex-col items-center justify-center px-4 text-slate-100 relative">
      <div className="absolute top-10 flex flex-col items-center gap-1">
        <div className="flex items-center gap-2 text-xs tracking-[0.35em] uppercase text-slate-400">
          <span>{systemTime}</span>
          <span className="inline-block w-2 h-2 rounded-full bg-slate-700 opacity-40" />
        </div>
        <div className="hidden text-[10px] uppercase tracking-widest text-slate-500">
          Jurisdiction: —
        </div>
      </div>

      <div className="w-full max-w-sm rounded-3xl border border-slate-800 bg-black/70 px-8 py-9 shadow-[0_0_60px_rgba(15,23,42,0.85)] relative z-10">
        <div className="text-[10px] tracking-[0.35em] uppercase text-slate-500 mb-2">
          Oasis Digital Parliament
        </div>

        <h1 className="text-xl font-semibold text-slate-100 mb-1">
          Operator Authentication
        </h1>

        <p className="text-xs text-slate-400 mb-6">
          Secure access to the Oasis Digital Governance Operating System
        </p>

        <div className="space-y-4">
          <div>
            <label className="block text-[11px] font-medium text-slate-300 mb-1.5">
              Email
            </label>
            <input
              type="email"
              className="w-full rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-400/70 focus:border-emerald-400/70"
              placeholder="you@organization.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-300 mb-1.5">
              Password
            </label>
            <input
              type="password"
              className="w-full rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-400/70 focus:border-emerald-400/70"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
            <div className="text-right mt-1">
              <a
                href="/forgot-password"
                className="text-[11px] text-slate-500 hover:text-slate-300 transition"
              >
                Forgot password?
              </a>
            </div>
          </div>

          <button
            type="button"
            onClick={handleLogin}
            disabled={loading}
            className="w-full mt-2 rounded-lg bg-emerald-500 text-slate-950 text-sm font-medium py-2.5 hover:bg-emerald-400 disabled:bg-slate-700 disabled:text-slate-400 transition"
          >
            {loading ? "Signing in…" : "Sign In"}
          </button>
        </div>

        <div className="mt-6 pt-4 border-t border-slate-800 text-[11px] text-slate-500 text-center">
          Oasis OS is restricted to authorized operators. If you require access,
          contact your Oasis administrator.
        </div>
      </div>
    </main>
  );
}
