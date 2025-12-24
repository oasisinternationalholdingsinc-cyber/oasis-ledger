// src/components/OsGlobalBar.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";

type OsEnv = "RoT" | "SANDBOX";

const ENV_KEY = "oasis_os_env";

const ENTITY_LABELS: Record<string, string> = {
  holdings: "Oasis International Holdings Inc.",
  lounge: "Oasis International Lounge Inc.",
  "real-estate": "Oasis International Real Estate Inc.",
};

function getInitialEnv(): OsEnv {
  if (typeof window === "undefined") return "RoT";
  const v = window.localStorage.getItem(ENV_KEY);
  return v === "SANDBOX" ? "SANDBOX" : "RoT";
}

function setEnvLocal(next: OsEnv) {
  window.localStorage.setItem(ENV_KEY, next);
  window.dispatchEvent(new CustomEvent("oasis:env", { detail: { env: next } }));
}

function useClockLabel() {
  const [label, setLabel] = useState<string>("—");
  useEffect(() => {
    const tick = () => {
      try {
        const d = new Date();
        const s = d
          .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
          .replace("AM", "a.m.")
          .replace("PM", "p.m.")
          .replace("am", "a.m.")
          .replace("pm", "p.m.");
        setLabel(s);
      } catch {
        setLabel("—");
      }
    };
    tick();
    const t = setInterval(tick, 15_000);
    return () => clearInterval(t);
  }, []);
  return label;
}

export default function OsGlobalBar() {
  const { activeEntity, setActiveEntity } = useEntity(); // ✅ no "entities" (fixes TS build)
  const [env, setEnv] = useState<OsEnv>(() => getInitialEnv());
  const [operatorEmail, setOperatorEmail] = useState<string>("—");
  const [menuOpen, setMenuOpen] = useState(false);

  const clock = useClockLabel();

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === ENV_KEY) setEnv(getInitialEnv());
    };
    const onEnv = (e: any) => setEnv((e?.detail?.env as OsEnv) ?? getInitialEnv());
    window.addEventListener("storage", onStorage);
    window.addEventListener("oasis:env" as any, onEnv);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("oasis:env" as any, onEnv);
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      // Prefer session (fast) then user
      const { data: sessionData } = await supabase.auth.getSession();
      const email =
        sessionData?.session?.user?.email ??
        (await supabase.auth.getUser()).data?.user?.email ??
        "—";
      if (!mounted) return;
      setOperatorEmail(email || "—");
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const envMeta = useMemo(() => {
    if (env === "SANDBOX") {
      return {
        label: "SANDBOX",
        subtitle: "Test artifacts only • Not the system of record",
        pillClass:
          "bg-[#2a1e0b]/60 border-[#7a5a1a]/55 text-[#f5d47a] shadow-[0_0_26px_rgba(245,212,122,0.16)] hover:shadow-[0_0_34px_rgba(245,212,122,0.22)]",
        icon: "⚗",
        ring: "ring-1 ring-[#c9a227]/25",
      };
    }
    return {
      label: "RoT",
      subtitle: "System of Record",
      pillClass:
        "bg-[#0b1f14]/60 border-[#1f6f48]/45 text-[#92f7c6] shadow-[0_0_22px_rgba(146,247,198,0.14)] hover:shadow-[0_0_30px_rgba(146,247,198,0.20)]",
      icon: "⛨",
      ring: "ring-1 ring-[#ffffff]/10",
    };
  }, [env]);

  const entityLabel = useMemo(() => {
    const slug = activeEntity ?? "holdings";
    return ENTITY_LABELS[slug] ?? slug;
  }, [activeEntity]);

  const onSignOut = async () => {
    await supabase.auth.signOut();
    window.location.href = "/login";
  };

  return (
    <>
      {/* NON-BLOCKING TOP RIBBON (only in SANDBOX) */}
      {env === "SANDBOX" && (
        <div
          className="fixed top-0 left-0 right-0 z-[70] border-b border-[#7a5a1a]/35 bg-gradient-to-r from-[#201607] via-[#2a1e0b] to-[#201607]"
          style={{ pointerEvents: "none" }}
        >
          <div className="mx-auto flex max-w-[1400px] items-center justify-between px-5 py-2 text-[11px]">
            <div className="flex items-center gap-3">
              <span className="font-semibold tracking-[0.16em] text-[#f5d47a]">
                SANDBOX ENVIRONMENT
              </span>
              <span className="text-white/55">Test artifacts only • Not the system of record</span>
            </div>
            <div className="text-white/45">Style B active</div>
          </div>
        </div>
      )}

      {/* FOOTER GLOBAL BAR (Member/Operator lives here) */}
      <div className="fixed bottom-0 left-0 right-0 z-[80]">
        {/* glow line */}
        <div className="h-[1px] w-full bg-gradient-to-r from-transparent via-[#c9a227]/25 to-transparent" />
        <div className="border-t border-white/6 bg-black/55 backdrop-blur-xl">
          <div className="mx-auto flex h-[64px] max-w-[1400px] items-center px-5">
            {/* Left: Brand */}
            <div className="flex w-1/3 items-center gap-3">
              <div className="h-8 w-8 rounded-full border border-[#c9a227]/45 bg-black/30 shadow-[0_0_22px_rgba(201,162,39,0.14)]" />
              <div className="leading-tight">
                <div className="text-[10px] tracking-[0.22em] text-white/55">OASIS DIGITAL PARLIAMENT</div>
                <div className="text-[13px] font-medium text-white/85">
                  Governance Console <span className="text-[#c9a227]/80">ODP.AI</span>
                </div>
              </div>
            </div>

            {/* Center: clock */}
            <div className="flex w-1/3 items-center justify-center">
              <div className="group flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-4 py-2 text-[12px] text-white/80 shadow-[0_0_24px_rgba(0,0,0,0.25)] hover:border-[#c9a227]/25 hover:shadow-[0_0_34px_rgba(201,162,39,0.14)] transition">
                <span className="text-[#c9a227]/80">🕒</span>
                <span className="min-w-[80px] text-center">{clock}</span>
              </div>
            </div>

            {/* Right: Operator / Entity / Env / Sign out */}
            <div className="flex w-1/3 items-center justify-end gap-3">
              {/* Member / Operator */}
              <div className="hidden items-center gap-2 rounded-full border border-white/10 bg-black/25 px-3 py-2 text-[12px] text-white/70 md:flex hover:border-[#c9a227]/20 hover:shadow-[0_0_28px_rgba(201,162,39,0.10)] transition">
                <span className="text-white/50">Member:</span>
                <span className="text-white/85">{operatorEmail}</span>
              </div>

              {/* Entity selector (UI-only, no rewiring) */}
              <div className="rounded-full border border-white/10 bg-black/25 px-3 py-2 text-[12px] text-white/80 hover:border-[#c9a227]/20 hover:shadow-[0_0_28px_rgba(201,162,39,0.10)] transition">
                <span className="text-white/50">Entity:</span>{" "}
                <select
                  className="ml-2 bg-transparent text-white/85 outline-none"
                  value={activeEntity ?? "holdings"}
                  onChange={(e) => setActiveEntity(e.target.value)}
                >
                  <option value="holdings">Oasis International Holdings Inc.</option>
                  <option value="lounge">Oasis International Lounge Inc.</option>
                  <option value="real-estate">Oasis International Real Estate Inc.</option>
                </select>
              </div>

              {/* Env selector */}
              <div className="relative">
                <button
                  onClick={() => setMenuOpen((v) => !v)}
                  className={`flex items-center gap-2 rounded-full border px-3 py-2 text-[12px] ${envMeta.pillClass} ${envMeta.ring} transition`}
                >
                  <span>{envMeta.icon}</span>
                  <span className="font-semibold tracking-wide">{envMeta.label}</span>
                  <span className="text-white/55">▾</span>
                </button>

                {menuOpen && (
                  <div className="absolute right-0 bottom-[74px] w-[300px] rounded-2xl border border-white/10 bg-black/88 p-2 shadow-[0_10px_44px_rgba(0,0,0,0.60)] backdrop-blur-xl">
                    <div className="px-3 py-2 text-[11px] text-white/55">Environment</div>

                    <button
                      onClick={() => {
                        setEnvLocal("RoT");
                        setEnv("RoT");
                        setMenuOpen(false);
                      }}
                      className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-[13px] transition ${
                        env === "RoT" ? "bg-white/10 text-white" : "hover:bg-white/5 text-white/85"
                      }`}
                    >
                      <span>RoT</span>
                      <span className="text-[11px] text-white/45">System of Record</span>
                    </button>

                    <button
                      onClick={() => {
                        setEnvLocal("SANDBOX");
                        setEnv("SANDBOX");
                        setMenuOpen(false);
                      }}
                      className={`mt-1 flex w-full items-center justify-between rounded-xl px-3 py-2 text-[13px] transition ${
                        env === "SANDBOX"
                          ? "bg-[#2a1e0b]/60 text-[#f5d47a] border border-[#7a5a1a]/40"
                          : "hover:bg-white/5 text-white/85"
                      }`}
                    >
                      <span>SANDBOX</span>
                      <span className="text-[11px] text-white/45">Test artifacts only</span>
                    </button>

                    <div className="mt-2 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-[11px] text-white/55">
                      Modules should read <span className="text-white/80">oasis_os_env</span> to select{" "}
                      <span className="text-white/80">*_sandbox</span> vs{" "}
                      <span className="text-white/80">*_rot</span> views.
                    </div>
                  </div>
                )}
              </div>

              {/* Sign out (make it not “gay”: icon pill, executive hover) */}
              <button
                onClick={onSignOut}
                className="group flex items-center gap-2 rounded-full border border-white/10 bg-black/25 px-3 py-2 text-[12px] text-white/80 hover:border-[#c9a227]/25 hover:bg-white/5 hover:shadow-[0_0_30px_rgba(201,162,39,0.12)] transition"
              >
                <span className="text-white/55 group-hover:text-[#c9a227]/85 transition">⟂</span>
                <span>Sign out</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Spacer so pages don’t sit under footer */}
      <div className="h-[72px]" />
      {/* Spacer for top ribbon if SANDBOX */}
      {env === "SANDBOX" && <div className="h-[34px]" />}
    </>
  );
}
