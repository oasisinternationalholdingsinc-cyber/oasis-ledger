"use client";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity, type EntityKey } from "@/components/OsEntityContext";

type OsEnv = "RoT" | "SANDBOX";
const ENV_KEY = "oasis_os_env";

function getInitialEnv(): OsEnv {
  if (typeof window === "undefined") return "RoT";
  const v = window.localStorage.getItem(ENV_KEY);
  return v === "SANDBOX" ? "SANDBOX" : "RoT";
}

function setEnvLS(next: OsEnv) {
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

const ENTITY_OPTIONS: Array<{ key: EntityKey; label: string }> = [
  { key: "holdings" as EntityKey, label: "Oasis International Holdings Inc." },
  { key: "lounge" as EntityKey, label: "Oasis International Lounge Inc." },
  { key: "real-estate" as EntityKey, label: "Oasis International Real Estate Inc." },
];

export function OsGlobalBar() {
  const { activeEntity, setActiveEntity } = useEntity();

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
          "bg-[#2a1e0b]/70 border-[#c9a227]/35 text-[#f5d47a] shadow-[0_0_28px_rgba(201,162,39,0.16)] hover:shadow-[0_0_34px_rgba(201,162,39,0.22)]",
        icon: "⚗",
      };
    }
    return {
      label: "RoT",
      subtitle: "System of Record",
      pillClass:
        "bg-[#0b1f14]/70 border-[#36c58a]/35 text-[#92f7c6] shadow-[0_0_26px_rgba(54,197,138,0.14)] hover:shadow-[0_0_34px_rgba(54,197,138,0.20)]",
      icon: "⛨",
    };
  }, [env]);

  const activeEntityLabel = useMemo(() => {
    const hit = ENTITY_OPTIONS.find((e) => e.key === activeEntity);
    return hit?.label ?? (activeEntity as any) ?? "—";
  }, [activeEntity]);

  const onSignOut = async () => {
    await supabase.auth.signOut();
    window.location.href = "/login";
  };

  return (
    <>
      {/* TOP GLOBAL BAR (enterprise, symmetric) */}
      <div className="sticky top-0 z-[60]">
        <div className="relative h-[68px] w-full border-b border-white/6 bg-black/55 backdrop-blur-xl">
          <div className="mx-auto flex h-full max-w-[1400px] items-center px-5">
            {/* LEFT (Brand) */}
            <div className="flex w-1/3 items-center gap-3">
              {/* crest */}
              <div className="grid h-9 w-9 place-items-center rounded-full border border-[#c9a227]/45 bg-black/35 shadow-[0_0_24px_rgba(201,162,39,0.18)]">
                <div className="h-4 w-4 rounded-[6px] border border-[#c9a227]/60 bg-[#0a0a0a]" />
              </div>
              <div className="leading-tight">
                <div className="text-[10px] tracking-[0.24em] text-white/55">OASIS DIGITAL PARLIAMENT</div>
                <div className="text-[13px] font-medium text-white/88">
                  Governance Console <span className="text-[#c9a227]/85">ODP.AI</span>
                </div>
              </div>
            </div>

            {/* CENTER (Clock – true centered, isolated) */}
            <div className="flex w-1/3 items-center justify-center">
              <div className="flex items-center gap-2 rounded-full border border-white/10 bg-black/35 px-5 py-2 text-[12px] text-white/85 shadow-[0_0_28px_rgba(0,0,0,0.35)]">
                <span className="text-[#c9a227]/80">🕒</span>
                <span className="min-w-[86px] text-center font-medium tracking-wide">{clock}</span>
              </div>
            </div>

            {/* RIGHT (Operator / Entity / Env / Sign out) */}
            <div className="flex w-1/3 items-center justify-end gap-3">
              {/* Operator pill */}
              <div className="hidden items-center gap-2 rounded-full border border-white/10 bg-black/30 px-4 py-2 text-[12px] text-white/80 shadow-[0_0_18px_rgba(0,0,0,0.25)] md:flex">
                <span className="text-white/55">Operator</span>
                <span className="mx-1 h-3 w-[1px] bg-white/10" />
                <span className="max-w-[220px] truncate text-white/90">{operatorEmail}</span>
              </div>

              {/* Entity selector (match env pill style) */}
              <div className="flex items-center rounded-full border border-white/10 bg-black/30 px-4 py-2 text-[12px] text-white/85 shadow-[0_0_18px_rgba(0,0,0,0.25)] hover:border-white/15">
                <span className="text-white/55">Entity</span>
                <span className="mx-2 h-3 w-[1px] bg-white/10" />
                <select
                  className="max-w-[240px] cursor-pointer bg-transparent text-white/90 outline-none"
                  value={(activeEntity ?? "holdings") as EntityKey}
                  onChange={(e) => setActiveEntity(e.target.value as EntityKey)}
                  title={activeEntityLabel}
                >
                  {ENTITY_OPTIONS.map((opt) => (
                    <option key={String(opt.key)} value={opt.key}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Env selector */}
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
                  <div className="absolute right-0 mt-2 w-[320px] rounded-2xl border border-white/10 bg-black/90 p-2 shadow-[0_12px_46px_rgba(0,0,0,0.65)] backdrop-blur-xl z-[70]">
                    <div className="px-3 py-2 text-[11px] text-white/55">Switch environment</div>

                    <button
                      onClick={() => {
                        setEnvLS("RoT");
                        setEnv("RoT");
                        setMenuOpen(false);
                      }}
                      className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-[13px] ${
                        env === "RoT" ? "bg-white/10 text-white" : "hover:bg-white/5 text-white/85"
                      }`}
                    >
                      <span className="font-medium">RoT</span>
                      <span className="text-[11px] text-white/45">System of Record</span>
                    </button>

                    <button
                      onClick={() => {
                        setEnvLS("SANDBOX");
                        setEnv("SANDBOX");
                        setMenuOpen(false);
                      }}
                      className={`mt-1 flex w-full items-center justify-between rounded-xl px-3 py-2 text-[13px] ${
                        env === "SANDBOX"
                          ? "bg-[#2a1e0b]/70 text-[#f5d47a] border border-[#c9a227]/25"
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
                          setEnvLS(next);
                          setEnv(next);
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

              {/* Sign out (pill, executive) */}
              <button
                onClick={onSignOut}
                className="flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-4 py-2 text-[12px] text-white/85 shadow-[0_0_18px_rgba(0,0,0,0.25)] hover:border-[#c9a227]/25 hover:shadow-[0_0_26px_rgba(201,162,39,0.18)]"
              >
                <span className="text-[#c9a227]/80">⇥</span>
                <span className="font-medium">Sign out</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* FOOTER STATUS RAIL (ONLY the environment ribbon) */}
      {env === "SANDBOX" && (
        <div
          className="fixed bottom-0 left-0 right-0 z-[55] border-t border-[#7a5a1a]/35 bg-gradient-to-r from-[#201607] via-[#2a1e0b] to-[#201607]"
          style={{ pointerEvents: "none" }}
        >
          <div className="mx-auto flex max-w-[1400px] items-center justify-between px-5 py-2 text-[11px]">
            <div className="flex items-center gap-3">
              <span className="font-semibold tracking-[0.18em] text-[#f5d47a]">SANDBOX ENVIRONMENT</span>
              <span className="text-white/55">Test artifacts only • Not the system of record</span>
            </div>
            <div className="text-white/45">Style B active</div>
          </div>
        </div>
      )}
    </>
  );
}

export default OsGlobalBar;
