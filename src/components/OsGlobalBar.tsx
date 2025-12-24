"use client";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import type { EntityKey } from "@/components/OsEntityContext";

type OsEnv = "RoT" | "SANDBOX";

const ENV_KEY = "oasis_os_env";

/**
 * IMPORTANT:
 * - We do NOT rely on `entities` from context (your type doesn’t have it).
 * - We keep wiring unchanged: localStorage env + window event + useEntity() for activeEntity.
 * - We hard-lock allowed entity options to avoid TS errors and “sandbox” surprises.
 */
const ENTITY_OPTIONS: Array<{ key: EntityKey; label: string }> = [
  { key: "holdings" as EntityKey, label: "Oasis International Holdings Inc." },
  { key: "lounge" as EntityKey, label: "Oasis International Lounge Inc." },
  { key: "real-estate" as EntityKey, label: "Oasis International Real Estate Inc." },
];

function getInitialEnv(): OsEnv {
  if (typeof window === "undefined") return "RoT";
  const v = window.localStorage.getItem(ENV_KEY);
  return v === "SANDBOX" ? "SANDBOX" : "RoT";
}

function persistEnv(next: OsEnv) {
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

export function OsGlobalBar() {
  const { activeEntity, setActiveEntity } = useEntity();

  const [env, setEnvState] = useState<OsEnv>(() => getInitialEnv());
  const [operatorEmail, setOperatorEmail] = useState<string>("—");
  const [menuOpen, setMenuOpen] = useState(false);

  const clock = useClockLabel();

  // Resolve current entity safely (guards against unexpected slugs like "sandbox")
  const safeEntityKey: EntityKey = useMemo(() => {
    const hit = ENTITY_OPTIONS.find((o) => o.key === (activeEntity as any));
    return (hit?.key ?? ENTITY_OPTIONS[0]!.key) as EntityKey;
  }, [activeEntity]);

  const activeEntityLabel = useMemo(() => {
    return ENTITY_OPTIONS.find((o) => o.key === safeEntityKey)?.label ?? "—";
  }, [safeEntityKey]);

  useEffect(() => {
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
          "bg-[#2a1e0b]/65 border-[#c9a227]/35 text-[#f5d47a] shadow-[0_0_26px_rgba(201,162,39,0.14)] hover:shadow-[0_0_40px_rgba(201,162,39,0.20)]",
        icon: "⚗",
      };
    }
    // RoT MUST be green (as requested)
    return {
      label: "RoT",
      subtitle: "System of Record",
      pillClass:
        "bg-[#081b12]/65 border-[#22c55e]/30 text-[#86efac] shadow-[0_0_22px_rgba(34,197,94,0.12)] hover:shadow-[0_0_36px_rgba(34,197,94,0.18)]",
      icon: "⛨",
    };
  }, [env]);

  const onSignOut = async () => {
    await supabase.auth.signOut();
    window.location.href = "/login";
  };

  return (
    <div className="sticky top-0 z-[60]">
      {/* TOP GLOBAL BAR (EXECUTIVE) */}
      <div className="relative w-full border-b border-white/5 bg-black/55 backdrop-blur-xl">
        <div className="mx-auto flex h-[72px] max-w-[1400px] items-center px-6">
          {/* Left: Brand */}
          <div className="flex w-1/3 items-center gap-3">
            {/* Oasis icon restored */}
            <div className="grid h-9 w-9 place-items-center rounded-full border border-[#c9a227]/45 bg-black/35 shadow-[0_0_26px_rgba(201,162,39,0.14)]">
              <span className="text-[#c9a227]/90">⛨</span>
            </div>

            <div className="leading-tight">
              <div className="text-[10px] tracking-[0.22em] text-white/55">OASIS DIGITAL PARLIAMENT</div>
              <div className="text-[13px] font-medium text-white/85">
                Governance Console <span className="text-[#c9a227]/85">ODP.AI</span>
              </div>
            </div>
          </div>

          {/* Center: Clock (true centered) */}
          <div className="flex w-1/3 items-center justify-center">
            <div className="group flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-5 py-2 text-[12px] text-white/80 shadow-[0_0_26px_rgba(0,0,0,0.28)] transition hover:border-white/15 hover:bg-black/35">
              <span className="text-[#c9a227]/80">🕒</span>
              <span className="min-w-[92px] text-center">{clock}</span>
            </div>
          </div>

          {/* Right: Operator / Entity / Env / Sign out */}
          <div className="flex w-1/3 items-center justify-end gap-3">
            {/* Operator */}
            <div className="hidden items-center gap-2 rounded-full border border-white/10 bg-black/25 px-4 py-2 text-[12px] text-white/70 md:flex">
              <span className="text-white/45">Operator:</span>
              <span className="text-white/90">{operatorEmail}</span>
            </div>

            {/* Entity (styled like env pill) */}
            <div className="flex items-center gap-2 rounded-full border border-white/10 bg-black/25 px-3 py-2 text-[12px] text-white/85 shadow-[0_0_18px_rgba(0,0,0,0.22)] hover:border-white/15">
              <span className="text-white/45">Entity:</span>
              <select
                className="ml-1 max-w-[260px] bg-transparent text-white/90 outline-none"
                value={safeEntityKey as any}
                onChange={(e) => setActiveEntity(e.target.value as unknown as EntityKey)}
                title={activeEntityLabel}
              >
                {ENTITY_OPTIONS.map((opt) => (
                  <option key={String(opt.key)} value={String(opt.key)}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Env pill */}
            <div className="relative">
              <button
                onClick={() => setMenuOpen((v) => !v)}
                className={`flex items-center gap-2 rounded-full border px-4 py-2 text-[12px] transition ${envMeta.pillClass}`}
              >
                <span>{envMeta.icon}</span>
                <span className="font-semibold tracking-wide">{envMeta.label}</span>
                <span className="text-white/55">▾</span>
              </button>

              {menuOpen && (
                <div className="absolute right-0 mt-2 w-[300px] rounded-2xl border border-white/10 bg-black/88 p-2 shadow-[0_14px_54px_rgba(0,0,0,0.55)] backdrop-blur-xl z-[80]">
                  <div className="px-3 py-2 text-[11px] text-white/55">Switch environment</div>

                  <button
                    onClick={() => {
                      persistEnv("RoT");
                      setEnvState("RoT");
                      setMenuOpen(false);
                    }}
                    className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-[13px] ${
                      env === "RoT" ? "bg-[#081b12]/60 text-[#86efac] border border-[#22c55e]/25" : "hover:bg-white/5 text-white/85"
                    }`}
                  >
                    <span className="font-medium">RoT</span>
                    <span className="text-[11px] text-white/45">System of Record</span>
                  </button>

                  <button
                    onClick={() => {
                      persistEnv("SANDBOX");
                      setEnvState("SANDBOX");
                      setMenuOpen(false);
                    }}
                    className={`mt-1 flex w-full items-center justify-between rounded-xl px-3 py-2 text-[13px] ${
                      env === "SANDBOX"
                        ? "bg-[#2a1e0b]/60 text-[#f5d47a] border border-[#c9a227]/25"
                        : "hover:bg-white/5 text-white/85"
                    }`}
                  >
                    <span className="font-medium">SANDBOX</span>
                    <span className="text-[11px] text-white/45">Test artifacts only</span>
                  </button>

                  <div className="mt-2 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-[11px] text-white/55">
                    Modules read <span className="text-white/80">oasis_os_env</span> to select{" "}
                    <span className="text-white/80">*_rot</span> vs <span className="text-white/80">*_sandbox</span>.
                  </div>

                  <div className="mt-2 flex justify-end">
                    <button
                      onClick={() => {
                        const next: OsEnv = env === "SANDBOX" ? "RoT" : "SANDBOX";
                        persistEnv(next);
                        setEnvState(next);
                        setMenuOpen(false);
                      }}
                      className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] text-white/70 hover:bg-white/10"
                    >
                      Quick toggle
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Sign out (proper pill + hover glow) */}
            <button
              onClick={onSignOut}
              className="rounded-full border border-white/10 bg-black/30 px-4 py-2 text-[12px] text-white/85 shadow-[0_0_18px_rgba(0,0,0,0.22)] transition hover:border-white/15 hover:bg-black/40 hover:shadow-[0_0_34px_rgba(201,162,39,0.12)]"
            >
              Sign out
            </button>
          </div>
        </div>
      </div>

      {/* FOOTER RIBBON (your operational footer banner stays a footer) */}
      {env === "SANDBOX" && (
        <div
          className="fixed bottom-0 left-0 right-0 z-[55] border-t border-[#c9a227]/20 bg-gradient-to-r from-[#201607] via-[#2a1e0b] to-[#201607]"
          style={{ pointerEvents: "none" }}
        >
          <div className="mx-auto flex max-w-[1400px] items-center justify-between px-6 py-2 text-[11px]">
            <div className="flex items-center gap-3">
              <span className="font-semibold tracking-[0.16em] text-[#f5d47a]">SANDBOX ENVIRONMENT</span>
              <span className="text-white/55">Test artifacts only • Not the system of record</span>
            </div>
            <div className="text-white/45">Style B active</div>
          </div>
        </div>
      )}
    </div>
  );
}

export default OsGlobalBar;
