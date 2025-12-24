"use client";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";

type OsEnv = "RoT" | "SANDBOX";

const ENV_KEY = "oasis_os_env";

function getInitialEnv(): OsEnv {
  if (typeof window === "undefined") return "RoT";
  const v = window.localStorage.getItem(ENV_KEY);
  return v === "SANDBOX" ? "SANDBOX" : "RoT";
}

function setEnv(next: OsEnv) {
  window.localStorage.setItem(ENV_KEY, next);
  window.dispatchEvent(new CustomEvent("oasis:env", { detail: { env: next } }));
}

function useClockLabel() {
  const [label, setLabel] = useState<string>("—");
  useEffect(() => {
    const tick = () => {
      try {
        const d = new Date();
        // Your screenshot shows “10:52 p.m.” style.
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
  const { activeEntity, setActiveEntity, entities } = useEntity();

  const [env, setEnvState] = useState<OsEnv>(() => getInitialEnv());
  const [operatorEmail, setOperatorEmail] = useState<string>("—");
  const [menuOpen, setMenuOpen] = useState(false);

  const clock = useClockLabel();

  useEffect(() => {
    // Keep in sync if another tab changes env
    const onStorage = (e: StorageEvent) => {
      if (e.key === ENV_KEY) setEnvState(getInitialEnv());
    };
    const onEnv = (e: any) => setEnvState((e?.detail?.env as OsEnv) ?? getInitialEnv());
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
      const { data } = await supabase.auth.getUser();
      if (!mounted) return;
      setOperatorEmail(data?.user?.email ?? "—");
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
          "bg-[#2a1e0b]/60 border-[#7a5a1a]/50 text-[#f5d47a] shadow-[0_0_30px_rgba(245,212,122,0.10)]",
        icon: "⚗",
      };
    }
    return {
      label: "RoT",
      subtitle: "System of Record",
      pillClass:
        "bg-[#0b1f14]/60 border-[#1f6f48]/40 text-[#92f7c6] shadow-[0_0_24px_rgba(146,247,198,0.10)]",
      icon: "⛨",
    };
  }, [env]);

  const entityLabel = useMemo(() => {
    const hit = entities?.find((e: any) => e.slug === activeEntity);
    return hit?.label ?? activeEntity ?? "—";
  }, [entities, activeEntity]);

  const toggleEnv = () => {
    const next: OsEnv = env === "SANDBOX" ? "RoT" : "SANDBOX";
    setEnv(next);
    setEnvState(next);
    setMenuOpen(false);
  };

  const onSignOut = async () => {
    await supabase.auth.signOut();
    window.location.href = "/login";
  };

  return (
    <div className="sticky top-0 z-[40]">
      {/* Top Global Bar */}
      <div className="relative h-[64px] w-full border-b border-white/5 bg-black/55 backdrop-blur-xl">
        {/* 3-column symmetric frame */}
        <div className="mx-auto flex h-full max-w-[1400px] items-center px-5">
          {/* Left: Brand */}
          <div className="flex w-1/3 items-center gap-3">
            <div className="h-8 w-8 rounded-full border border-[#c9a227]/40 bg-black/30 shadow-[0_0_20px_rgba(201,162,39,0.12)]" />
            <div className="leading-tight">
              <div className="text-[10px] tracking-[0.22em] text-white/55">OASIS DIGITAL PARLIAMENT</div>
              <div className="text-[13px] font-medium text-white/85">
                Governance Console <span className="text-[#c9a227]/80">ODP.AI</span>
              </div>
            </div>
          </div>

          {/* Center: Clock (true centered) */}
          <div className="flex w-1/3 items-center justify-center">
            <div className="flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-4 py-2 text-[12px] text-white/80 shadow-[0_0_24px_rgba(0,0,0,0.25)]">
              <span className="text-[#c9a227]/80">🕒</span>
              <span className="min-w-[80px] text-center">{clock}</span>
            </div>
          </div>

          {/* Right: Operator / Entity / Env / Sign out */}
          <div className="flex w-1/3 items-center justify-end gap-3">
            <div className="hidden items-center gap-2 rounded-full border border-white/10 bg-black/25 px-3 py-2 text-[12px] text-white/70 md:flex">
              <span className="text-white/50">Operator:</span>
              <span className="text-white/85">{operatorEmail}</span>
            </div>

            {/* Entity selector */}
            <div className="rounded-full border border-white/10 bg-black/25 px-3 py-2 text-[12px] text-white/80">
              <span className="text-white/50">Entity:</span>{" "}
              <select
                className="ml-2 bg-transparent text-white/85 outline-none"
                value={activeEntity ?? ""}
                onChange={(e) => setActiveEntity(e.target.value)}
              >
                {(entities ?? []).map((e: any) => (
                  <option key={e.slug} value={e.slug}>
                    {e.label ?? e.slug}
                  </option>
                ))}
                {!entities?.length && <option value="holdings">{entityLabel}</option>}
              </select>
            </div>

            {/* Env selector (Style B) */}
            <div className="relative">
              <button
                onClick={() => setMenuOpen((v) => !v)}
                className={`flex items-center gap-2 rounded-full border px-3 py-2 text-[12px] ${envMeta.pillClass}`}
              >
                <span>{envMeta.icon}</span>
                <span className="font-semibold tracking-wide">{envMeta.label}</span>
                <span className="text-white/55">▾</span>
              </button>

              {menuOpen && (
                <div className="absolute right-0 mt-2 w-[290px] rounded-2xl border border-white/10 bg-black/85 p-2 shadow-[0_10px_40px_rgba(0,0,0,0.55)] backdrop-blur-xl z-[60]">
                  <div className="px-3 py-2 text-[11px] text-white/55">Switch environment</div>
                  <button
                    onClick={() => {
                      setEnv("RoT");
                      setEnvState("RoT");
                      setMenuOpen(false);
                    }}
                    className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-[13px] ${
                      env === "RoT" ? "bg-white/10 text-white" : "hover:bg-white/5 text-white/85"
                    }`}
                  >
                    <span>RoT</span>
                    <span className="text-[11px] text-white/45">System of Record</span>
                  </button>
                  <button
                    onClick={() => {
                      setEnv("SANDBOX");
                      setEnvState("SANDBOX");
                      setMenuOpen(false);
                    }}
                    className={`mt-1 flex w-full items-center justify-between rounded-xl px-3 py-2 text-[13px] ${
                      env === "SANDBOX" ? "bg-[#2a1e0b]/60 text-[#f5d47a]" : "hover:bg-white/5 text-white/85"
                    }`}
                  >
                    <span>SANDBOX</span>
                    <span className="text-[11px] text-white/45">Test artifacts only</span>
                  </button>

                  <div className="mt-2 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-[11px] text-white/55">
                    Modules should read <span className="text-white/80">oasis_os_env</span> to select{" "}
                    <span className="text-white/80">*_rot</span> vs <span className="text-white/80">*_sandbox</span> views.
                  </div>

                  <div className="mt-2 flex justify-end">
                    <button
                      onClick={toggleEnv}
                      className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] text-white/70 hover:bg-white/10"
                    >
                      Quick toggle
                    </button>
                  </div>
                </div>
              )}
            </div>

            <button
              onClick={onSignOut}
              className="rounded-full border border-white/10 bg-black/25 px-3 py-2 text-[12px] text-white/80 hover:bg-white/5"
            >
              Sign out
            </button>
          </div>
        </div>
      </div>

      {/* NON-BLOCKING RIBBON (below bar, never steals clicks) */}
      {env === "SANDBOX" && (
        <div
          className="relative z-[10] border-b border-[#7a5a1a]/35 bg-gradient-to-r from-[#201607] via-[#2a1e0b] to-[#201607]"
          style={{ pointerEvents: "none" }}
        >
          <div className="mx-auto flex max-w-[1400px] items-center justify-between px-5 py-2 text-[11px]">
            <div className="flex items-center gap-3">
              <span className="font-semibold tracking-[0.16em] text-[#f5d47a]">SANDBOX ENVIRONMENT</span>
              <span className="text-white/55">Test artifacts only • Not the system of record</span>
            </div>
            <div className="text-white/45">Style B: modules select *_sandbox views</div>
          </div>
        </div>
      )}
    </div>
  );
}
