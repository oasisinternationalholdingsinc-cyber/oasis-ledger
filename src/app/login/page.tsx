"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [systemTime, setSystemTime] = useState("");

  // --- SYSTEM TIME (UTC) ----------------------------------------------------
  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      const utc = now.toISOString().substring(11, 19); // HH:MM:SS UTC
      setSystemTime(utc + " UTC");
    };

    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  // --- LOGIN ---------------------------------------------------------------
  const handleLogin = async () => {
    if (!email || !password) return;

    setLoading(true);

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    setLoading(false);

    if (error) {
      alert("Invalid credentials.");
      return;
    }

    router.push("/ci-council");
  };

  return (
    <main className="min-h-screen bg-[#020617] flex flex-col items-center justify-center px-4 text-slate-100 relative">

      {/* ================= SYSTEM TIME + RESERVED V2 SURFACE ================= */}
      <div className="absolute top-10 flex flex-col items-center gap-1">

        {/* SYSTEM TIME */}
        <div className="flex items-center gap-2 text-xs tracking-[0.35em] uppercase text-slate-400">
          <span>{systemTime}</span>

          {/* RESERVED: MICRO SYSTEM STATE INDICATOR (V2) */}
          <span className="inline-block w-2 h-2 rounded-full bg-slate-700 opacity-40" />
        </div>

        {/* RESERVED: JURISDICTION OVERLAY (V2 – HIDDEN BY DEFAULT) */}
        <div className="hidden text-[10px] uppercase tracking-widest text-slate-500">
          Jurisdiction: —
        </div>
      </div>
      {/* ===================================================================== */}


      {/* ============================== LOGIN CARD =========================== */}
      <div className="w-full max-w-sm rounded-3xl border border-slate-800 bg-black/70 px-8 py-9 shadow-[0_0_60px_rgba(15,23,42,0.85)] relative z-10">

        {/* TOP BADGE */}
        <div className="text-[10px] tracking-[0.35em] uppercase text-slate-500 mb-2">
          Oasis Digital Parliament
        </div>

        {/* TITLE */}
        <h1 className="text-xl font-semibold text-slate-100 mb-1">
          Oasis OS Login
        </h1>

        {/* SUBTITLE */}
        <p className="text-xs text-slate-400 mb-6">
          Secure access to the Oasis Digital Governance Operating System
        </p>

        {/* FORM */}
        <div className="space-y-4">

          {/* EMAIL */}
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
            />
          </div>

          {/* PASSWORD */}
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
            />

            {/* FORGOT PASSWORD ENTRY */}
            <div className="text-right mt-1">
              <a
                href="/forgot-password"
                className="text-[11px] text-slate-500 hover:text-slate-300 transition"
              >
                Forgot password?
              </a>
            </div>
          </div>

          {/* SIGN IN BUTTON */}
          <button
            type="button"
            onClick={handleLogin}
            disabled={loading}
            className="w-full mt-2 rounded-lg bg-emerald-500 text-slate-950 text-sm font-medium py-2.5 hover:bg-emerald-400 disabled:bg-slate-700 disabled:text-slate-400 transition"
          >
            {loading ? "Signing in…" : "Sign In"}
          </button>
        </div>

        {/* FOOTNOTE */}
        <div className="mt-6 pt-4 border-t border-slate-800 text-[11px] text-slate-500 text-center">
          Oasis OS is restricted to authorized operators. If you require access,
          contact your Oasis administrator.
        </div>
      </div>
      {/* ===================================================================== */}

    </main>
  );
}
