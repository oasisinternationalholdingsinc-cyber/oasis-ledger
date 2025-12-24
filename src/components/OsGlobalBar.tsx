// src/components/OsGlobalBar.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";

type OsEnv = "RoT" | "SANDBOX";
const ENV_KEY = "oasis_os_env";

// Keep this aligned with your actual entity keys used everywhere
type EntityKey = "holdings" | "lounge" | "real-estate" | "sandbox";

const ENTITY_OPTIONS: Array<{ key: EntityKey; label: string }> = [
  { key: "holdings", label: "Oasis International Holdings Inc." },
  { key: "lounge", label: "Oasis International Lounge Inc." },
  { key: "real-estate", label: "Oasis International Real Estate Inc." },
  // keep sandbox as an internal/testing entity if you actually use it
  { key: "sandbox", label: "SANDBOX (Internal)" },
];

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
  // NOTE: useEntity() typing differs between builds in your repo history.
  // We keep it strict on OUR side and only cast where necessary.
  const ec = useEntity() as unknown as {
    activeEntity: EntityKey;
    setActiveEntity: (k: EntityKey) => void;
  };

  const activeEntity = ec.activeEntity ?? "holdings";
  const setActiveEntity = ec.setActiveEntity;

  const [env, setEnvState] = useState<OsEnv>(() => getInitialEnv());
  const [operatorEmail, setOperatorEmail] = useState<string>("—");
  const [menuOpen, setMenuOpen] = useState(false);

  const clock = useClockLabel();

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === ENV_KEY) setEnvState(getInitialEnv());
    };
    const onEnv = (e: Event) => {
      const ce = e as CustomEvent;
      const next = (ce?.detail?.env as OsEnv) ?? getInitialEnv();
      setEnvState(next);
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("oasis:env", onEnv as any);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("oasis:env", onEnv as any);
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
        icon: "⚗",
        pill:
          "border-[#7a5a1a]/55 bg-[#2a1e0b]/55 text-[#f5d47a] shadow-[0_0_26px_rgba(245,212,122,0.12)]",
        ribbon:
          "border-[#7a5a1a]/35 bg-gradient-to-r from-[#201607] via-[#2a1e0b] to-[#201607] text-[#f5d47a]",
      };
    }
    return {
      label: "RoT",
      subtitle: "System of Record",
      icon: "⛨",
      pill:
        "border-[#1f6f48]/45 bg-[#0b1f14]/55 text-[#92f7c6] shadow-[0_0_22px_rgba(146,247,198,0.10)]",
      ribbon:
        "border-white/10 bg-gradient-to-r from-black via-[#07150f] to-black text-white/85",
    };
  }, [env]);

  const entityLabel = useMemo(() => {
    return ENTITY_OPTIONS.find((e) => e.key === activeEntity)?.label ?? activeEntity;
  }, [activeEntity]);

  const onSignOut = async () => {
    await supabase.auth.signOut();
    window.location.href = "/login";
  };

  // FOOTER: operational bar + non-blocking sandbox ribbon above it
  return (
    <div className="fixed bottom-0 left-0 right-0 z-[80]">
      {/* Ribbon (never steals clicks) */}
      {env === "SANDBOX" && (
        <div
          className={`border-t ${envMeta.ribbon}`}
          style={{ pointerEvents: "none" }}
        >
          <div className="mx-auto flex max-w-[1400px] items-center justify-between px-6 py-2 text-[11px]">
            <div className="flex items-center gap-3">
              <span className="font-semibold tracking-[0.16em]">SANDBOX ENVIRONMENT</span>
              <span className="text-white/55">{envMeta.subtitle}</span>
            </div>
            <div className="text-white/45">Style B active</div>
          </div>
        </div>
      )}

      {/* Footer Bar */}
      <div className="border-t border-white/10 bg-black/60 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between px-6 py-3">
          {/* Left: Brand */}
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-full border border-[#c9a227]/40 bg-black/30 shadow-[0_0_20px_rgba(201,162,39,0.16)]" />
            <div className="leading-tight">
              <div className="text-[10px] tracking-[0.22em] text-white/55">
                OASIS DIGITAL PARLIAMENT
              </div>
              <div className="text-[13px] font-medium text-white/85">
                Governance Console <span className="text-[#c9a227]/85">ODP.AI</span>
              </div>
            </div>
          </div>

          {/* Center: Clock (true centered) */}
          <div className="hidden md:flex items-center justify-center">
            <div className="group flex items-center gap-2 rounded-full border border-white/10 bg-black/25 px-4 py-2 text-[12px] text-white/80 shadow-[0_0_22px_rgba(0,0,0,0.28)] transition hover:border-[#c9a227]/30 hover:shadow-[0_0_26px_rgba(201,162,39,0.14)]">
              <span className="text-[#c9a227]/80">🕒</span>
              <span className="min-w-[80px] text-center">{clock}</span>
            </div>
          </div>

          {/* Right: Operator / Entity / Env / Sign out */}
          <div className="flex items-center gap-3">
            <div className="hidden lg:flex items-center gap-2 rounded-full border border-white/10 bg-black/25 px-3 py-2 text-[12px] text-white/70 transition hover:border-[#c9a227]/25 hover:shadow-[0_0_18px_rgba(201,162,39,0.10)]">
              <span className="text-white/50">Operator:</span>
              <span className="text-white/90">{operatorEmail}</span>
            </div>

            {/* Entity selector */}
            <div className="rounded-full border border-white/10 bg-black/25 px-3 py-2 text-[12px] text-white/80 transition hover:border-[#c9a227]/25 hover:shadow-[0_0_18px_rgba(201,162,39,0.10)]">
              <span className="text-white/50">Entity:</span>
              <select
                className="ml-2 bg-transparent text-white/90 outline-none"
                value={activeEntity}
                onChange={(e) => setActiveEntity(e.target.value as EntityKey)}
                aria-label="Entity selector"
              >
                {ENTITY_OPTIONS.map((opt) => (
                  <option key={opt.key} value={opt.key}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Env selector */}
            <div className="relative">
              <button
                onClick={() => setMenuOpen((v) => !v)}
                className={`flex items-center gap-2 rounded-full border px-3 py-2 text-[12px] transition hover:shadow-[0_0_22px_rgba(201,162,39,0.12)] ${envMeta.pill}`}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
              >
                <span className="opacity-90">{envMeta.icon}</span>
                <span className="font-semibold tracking-wide">{envMeta.label}</span>
                <span className="text-white/60">▾</span>
              </button>

              {menuOpen && (
                <div className="absolute bottom-[46px] right-0 w-[300px] rounded-2xl border border-white/10 bg-black/88 p-2 shadow-[0_12px_46px_rgba(0,0,0,0.60)] backdrop-blur-xl">
                  <div className="px-3 py-2 text-[11px] text-white/55">
                    Switch environment
                  </div>

                  <button
                    onClick={() => {
                      setEnv("RoT");
                      setEnvState("RoT");
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
                      setEnv("SANDBOX");
                      setEnvState("SANDBOX");
                      setMenuOpen(false);
                    }}
                    className={`mt-1 flex w-full items-center justify-between rounded-xl px-3 py-2 text-[13px] transition ${
                      env === "SANDBOX"
                        ? "bg-[#2a1e0b]/60 text-[#f5d47a]"
                        : "hover:bg-white/5 text-white/85"
                    }`}
                  >
                    <span>SANDBOX</span>
                    <span className="text-[11px] text-white/45">Test artifacts only</span>
                  </button>

                  <div className="mt-2 rounded-xl border border-white/10 bg-black/45 px-3 py-2 text-[11px] text-white/55">
                    Modules read <span className="text-white/80">oasis_os_env</span> to select{" "}
                    <span className="text-white/80">*_sandbox</span> vs{" "}
                    <span className="text-white/80">*_rot</span> views.
                  </div>
                </div>
              )}
            </div>

            {/* Sign out (executive) */}
            <button
              onClick={onSignOut}
              className="group flex items-center gap-2 rounded-full border border-white/10 bg-black/25 px-3 py-2 text-[12px] text-white/85 transition hover:border-[#c9a227]/35 hover:bg-white/5 hover:shadow-[0_0_22px_rgba(201,162,39,0.14)]"
              aria-label="Sign out"
            >
              <span className="opacity-80 group-hover:opacity-100">⇦</span>
              <span>Sign out</span>
            </button>
          </div>
        </div>

        {/* Mobile center clock */}
        <div className="md:hidden border-t border-white/5 px-6 py-2">
          <div className="flex items-center justify-center">
            <div className="flex items-center gap-2 rounded-full border border-white/10 bg-black/25 px-4 py-2 text-[12px] text-white/80">
              <span className="text-[#c9a227]/80">🕒</span>
              <span className="min-w-[80px] text-center">{clock}</span>
              <span className="text-white/35">•</span>
              <span className="text-white/65">{entityLabel}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
