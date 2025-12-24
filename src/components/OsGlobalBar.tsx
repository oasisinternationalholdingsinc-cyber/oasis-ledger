"use client";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";

// IMPORTANT: keep this aligned with your EntityKey type in OsEntityContext
// If your EntityKey already exists as an importable type, import it instead.
type EntityKey = "holdings" | "lounge" | "real-estate" | "sandbox";

type OsEnv = "RoT" | "SANDBOX";
const ENV_KEY = "oasis_os_env";

const ENTITY_OPTIONS: Array<{ key: EntityKey; label: string }> = [
  { key: "holdings", label: "Oasis International Holdings Inc." },
  { key: "lounge", label: "Oasis International Lounge Inc." },
  { key: "real-estate", label: "Oasis International Real Estate Inc." },
  { key: "sandbox", label: "Sandbox (Internal)" },
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

  const [env, setEnv] = useState<OsEnv>(() => getInitialEnv());
  const [operatorEmail, setOperatorEmail] = useState<string>("—");
  const [menuEnvOpen, setMenuEnvOpen] = useState(false);

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
        pill:
          "border-[#c9a227]/35 bg-black/35 text-[#f5d47a] shadow-[0_0_28px_rgba(201,162,39,0.10)] hover:shadow-[0_0_34px_rgba(201,162,39,0.14)]",
        icon: "⚗",
        rail:
          "border-t border-[#c9a227]/25 bg-gradient-to-r from-[#1a1306] via-[#251a08] to-[#1a1306] text-[#f5d47a]",
      };
    }
    return {
      label: "RoT",
      subtitle: "System of Record",
      pill:
        "border-[#2bd98f]/25 bg-black/35 text-[#92f7c6] shadow-[0_0_26px_rgba(43,217,143,0.10)] hover:shadow-[0_0_32px_rgba(43,217,143,0.14)]",
      icon: "⛨",
      rail:
        "border-t border-[#2bd98f]/18 bg-gradient-to-r from-[#07160f] via-[#0a1f15] to-[#07160f] text-[#92f7c6]",
    };
  }, [env]);

  const activeEntityLabel = useMemo(() => {
    const hit = ENTITY_OPTIONS.find((x) => x.key === (activeEntity as EntityKey));
    return hit?.label ?? "—";
  }, [activeEntity]);

  const onSignOut = async () => {
    await supabase.auth.signOut();
    window.location.href = "/login";
  };

  return (
    <>
      {/* TOP GLOBAL BAR (stays top, executive) */}
      <div className="sticky top-0 z-[60]">
        <div className="relative h-[72px] w-full border-b border-white/6 bg-black/55 backdrop-blur-xl">
          <div className="mx-auto flex h-full max-w-[1500px] items-center px-6">
            {/* LEFT: Brand */}
            <div className="flex w-1/3 items-center gap-3">
              {/* Oasis mark restored */}
              <div className="grid h-10 w-10 place-items-center rounded-full border border-[#c9a227]/45 bg-black/35 shadow-[0_0_26px_rgba(201,162,39,0.16)]">
                <span className="text-[16px] text-[#f5d47a]">⛨</span>
              </div>
              <div className="leading-tight">
                <div className="text-[10px] tracking-[0.22em] text-white/55">OASIS DIGITAL PARLIAMENT</div>
                <div className="text-[14px] font-medium text-white/85">
                  Governance Console <span className="text-[#c9a227]/85">ODP.AI</span>
                </div>
              </div>
            </div>

            {/* CENTER: Clock */}
            <div className="flex w-1/3 items-center justify-center">
              <div className="group flex items-center gap-2 rounded-full border border-white/10 bg-black/35 px-5 py-2 text-[12px] text-white/80 shadow-[0_0_26px_rgba(0,0,0,0.35)] hover:border-white/14 hover:bg-black/40">
                <span className="text-[#c9a227]/85">🕒</span>
                <span className="min-w-[92px] text-center">{clock}</span>
              </div>
            </div>

            {/* RIGHT: Operator / Entity / Env / Sign out */}
            <div className="flex w-1/3 items-center justify-end gap-3">
              {/* Operator (email) */}
              <div className="hidden items-center gap-2 rounded-full border border-white/10 bg-black/30 px-4 py-2 text-[12px] text-white/75 shadow-[0_0_18px_rgba(255,255,255,0.04)] md:flex">
                <span className="text-white/45">Operator:</span>
                <span className="text-white/90">{operatorEmail}</span>
              </div>

              {/* Entity selector (executive pill; matches env) */}
              <div className="rounded-full border border-white/10 bg-black/30 px-4 py-2 text-[12px] text-white/85 shadow-[0_0_18px_rgba(255,255,255,0.04)] hover:border-white/14 hover:bg-black/40">
                <span className="text-white/45">Entity:</span>
                <select
                  className="ml-2 max-w-[240px] bg-transparent text-white/90 outline-none"
                  value={(activeEntity as string) ?? "holdings"}
                  onChange={(e) => setActiveEntity(e.target.value as unknown as EntityKey)}
                  title={activeEntityLabel}
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
                  onClick={() => setMenuEnvOpen((v) => !v)}
                  className={`flex items-center gap-2 rounded-full border px-4 py-2 text-[12px] transition ${envMeta.pill}`}
                >
                  <span>{envMeta.icon}</span>
                  <span className="font-semibold tracking-wide">{envMeta.label}</span>
                  <span className="text-white/55">▾</span>
                </button>

                {menuEnvOpen && (
                  <div className="absolute right-0 mt-2 w-[300px] rounded-2xl border border-white/10 bg-black/88 p-2 shadow-[0_12px_44px_rgba(0,0,0,0.65)] backdrop-blur-xl">
                    <div className="px-3 py-2 text-[11px] text-white/55">Switch environment</div>

                    <button
                      onClick={() => {
                        persistEnv("RoT");
                        setEnv("RoT");
                        setMenuEnvOpen(false);
                      }}
                      className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-[13px] ${
                        env === "RoT" ? "bg-white/10 text-white" : "hover:bg-white/5 text-white/85"
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span className="text-[#92f7c6]">⛨</span> RoT
                      </span>
                      <span className="text-[11px] text-white/45">System of Record</span>
                    </button>

                    <button
                      onClick={() => {
                        persistEnv("SANDBOX");
                        setEnv("SANDBOX");
                        setMenuEnvOpen(false);
                      }}
                      className={`mt-1 flex w-full items-center justify-between rounded-xl px-3 py-2 text-[13px] ${
                        env === "SANDBOX"
                          ? "bg-[#241807]/70 text-[#f5d47a] border border-[#c9a227]/20"
                          : "hover:bg-white/5 text-white/85"
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span className="text-[#f5d47a]">⚗</span> SANDBOX
                      </span>
                      <span className="text-[11px] text-white/45">Test artifacts only</span>
                    </button>

                    <div className="mt-2 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-[11px] text-white/55">
                      Modules read <span className="text-white/80">oasis_os_env</span> to select{" "}
                      <span className="text-white/80">*_rot</span> vs <span className="text-white/80">*_sandbox</span> views.
                    </div>
                  </div>
                )}
              </div>

              {/* Sign out (pill, executive) */}
              <button
                onClick={onSignOut}
                className="flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-4 py-2 text-[12px] text-white/85 shadow-[0_0_18px_rgba(255,255,255,0.04)] hover:border-white/16 hover:bg-black/45 hover:shadow-[0_0_24px_rgba(201,162,39,0.10)]"
              >
                <span className="text-[#c9a227]/75">⎋</span>
                <span>Sign out</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* FOOTER STATUS RAIL (ONLY the environment rail stays at footer) */}
      <div className="fixed bottom-0 left-0 right-0 z-[55]">
        <div className={`border-t ${envMeta.rail}`}>
          <div className="mx-auto flex max-w-[1500px] items-center justify-between px-6 py-2 text-[11px]">
            <div className="flex items-center gap-3">
              <span className="font-semibold tracking-[0.16em]">
                {env === "SANDBOX" ? "SANDBOX ENVIRONMENT" : "RoT • SYSTEM OF RECORD"}
              </span>
              <span className="text-white/55">{envMeta.subtitle}</span>
            </div>
            <div className="text-white/45">Style B active</div>
          </div>
        </div>
      </div>
    </>
  );
}

export default OsGlobalBar;
