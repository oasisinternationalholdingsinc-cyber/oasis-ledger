// src/components/OsGlobalBar.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import type { EntityKey } from "@/components/OsEntityContext";
import { Shield, ChevronDown, LogOut, Clock3 } from "lucide-react";

export type OsEnv = "RoT" | "SANDBOX";
export const ENV_KEY = "oasis_os_env";

const ENTITY_OPTIONS: Array<{ key: EntityKey; label: string }> = [
  { key: "holdings" as EntityKey, label: "Oasis International Holdings Inc." },
  { key: "lounge" as EntityKey, label: "Oasis International Lounge Inc." },
  { key: "real-estate" as EntityKey, label: "Oasis International Real Estate Inc." },
];

export function getInitialEnv(): OsEnv {
  if (typeof window === "undefined") return "RoT";
  const v = window.localStorage.getItem(ENV_KEY);
  return v === "SANDBOX" ? "SANDBOX" : "RoT";
}

export function writeEnv(next: OsEnv) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ENV_KEY, next);
  window.dispatchEvent(new CustomEvent("oasis:env", { detail: { env: next } }));
}

function useClockLabel24h() {
  const [label, setLabel] = useState<string>("—");
  useEffect(() => {
    const tick = () => {
      try {
        const d = new Date();
        const s = d.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
        setLabel(s);
      } catch {
        setLabel("—");
      }
    };
    tick();
    const t = setInterval(tick, 10_000);
    return () => clearInterval(t);
  }, []);
  return label;
}

export function OsGlobalBar() {
  const { activeEntity, setActiveEntity } = useEntity();

  const [env, setEnvState] = useState<OsEnv>(() => getInitialEnv());
  const [operatorEmail, setOperatorEmail] = useState<string>("—");

  const [envMenuOpen, setEnvMenuOpen] = useState(false);
  const [entityMenuOpen, setEntityMenuOpen] = useState(false);

  const clock = useClockLabel24h();

  // keep env state synced
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

  // operator
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

  // close menus on ESC / outside click
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setEnvMenuOpen(false);
        setEntityMenuOpen(false);
      }
    };
    const onClick = () => {
      setEnvMenuOpen(false);
      setEntityMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onClick);
    };
  }, []);

  const envMeta = useMemo(() => {
    if (env === "SANDBOX") {
      return {
        label: "SANDBOX",
        pillClass:
          "bg-[#2a1e0b]/60 border-[#7a5a1a]/55 text-[#f5d47a] shadow-[0_0_28px_rgba(245,212,122,0.12)] hover:shadow-[0_0_34px_rgba(245,212,122,0.16)]",
        dotClass: "bg-[#f5d47a]",
      };
    }
    return {
      label: "RoT",
      pillClass:
        "bg-[#0b1f14]/60 border-[#1f6f48]/45 text-[#92f7c6] shadow-[0_0_24px_rgba(146,247,198,0.12)] hover:shadow-[0_0_30px_rgba(146,247,198,0.16)]",
      dotClass: "bg-[#92f7c6]",
    };
  }, [env]);

  const activeEntityLabel = useMemo(() => {
    const hit = ENTITY_OPTIONS.find((e) => e.key === activeEntity);
    return hit?.label ?? "Oasis International Holdings Inc.";
  }, [activeEntity]);

  const onSignOut = async () => {
    await supabase.auth.signOut();
    window.location.href = "/login";
  };

  return (
    <div className="sticky top-0 z-[50]">
      <div className="relative h-[64px] w-full border-b border-white/5 bg-black/55 backdrop-blur-xl">
        <div className="mx-auto flex h-full max-w-[1500px] items-center px-6">
          {/* LEFT */}
          <div className="flex w-1/3 items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full border border-[#c9a227]/45 bg-black/30 shadow-[0_0_24px_rgba(201,162,39,0.16)]">
              <Shield className="h-4.5 w-4.5 text-[#d6b24a]" />
            </div>

            <div className="leading-tight">
              <div className="text-[10px] tracking-[0.22em] text-white/55">
                OASIS DIGITAL PARLIAMENT
              </div>
              <div className="text-[13px] font-medium text-white/85">
                Governance Console <span className="text-[#c9a227]/80">ODP.AI</span>
              </div>
            </div>

            <div className="ml-3 hidden items-center gap-2 rounded-full border border-white/10 bg-black/25 px-3 py-2 text-[12px] text-white/75 shadow-[0_0_18px_rgba(0,0,0,0.22)] lg:flex">
              <span className="text-white/50">Operator</span>
              <span className="h-1 w-1 rounded-full bg-white/25" />
              <span className="max-w-[220px] truncate text-white/90">{operatorEmail}</span>
            </div>
          </div>

          {/* CENTER */}
          <div className="flex w-1/3 items-center justify-center">
            <div className="flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-4 py-2 text-[12px] text-white/85 shadow-[0_0_26px_rgba(201,162,39,0.08)]">
              <Clock3 className="h-4 w-4 text-[#c9a227]/80" />
              <span className="min-w-[72px] text-center tracking-wide">{clock}</span>
            </div>
          </div>

          {/* RIGHT */}
          <div className="flex w-1/3 items-center justify-end gap-3">
            {/* Entity */}
            <div className="relative" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => {
                  setEntityMenuOpen((v) => !v);
                  setEnvMenuOpen(false);
                }}
                className="flex items-center gap-2 rounded-full border border-white/10 bg-black/25 px-4 py-2 text-[12px] text-white/85 shadow-[0_0_18px_rgba(0,0,0,0.22)] hover:bg-white/5"
              >
                <span className="text-white/55">Entity</span>
                <span className="h-1 w-1 rounded-full bg-white/25" />
                <span className="max-w-[260px] truncate text-white/90">{activeEntityLabel}</span>
                <ChevronDown className="h-4 w-4 text-white/55" />
              </button>

              {entityMenuOpen && (
                <div className="absolute right-0 mt-2 w-[360px] rounded-2xl border border-white/10 bg-black/85 p-2 shadow-[0_14px_50px_rgba(0,0,0,0.62)] backdrop-blur-xl z-[80]">
                  <div className="px-3 py-2 text-[11px] text-white/55">Switch entity</div>
                  {ENTITY_OPTIONS.map((opt) => {
                    const selected = opt.key === activeEntity;
                    return (
                      <button
                        key={String(opt.key)}
                        onClick={() => {
                          setActiveEntity(opt.key);
                          setEntityMenuOpen(false);
                        }}
                        className={[
                          "flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-[13px] transition",
                          selected ? "bg-white/10 text-white" : "hover:bg-white/5 text-white/85",
                        ].join(" ")}
                      >
                        <span className="truncate pr-4">{opt.label}</span>
                        {selected && <span className="text-[11px] text-[#c9a227]/85">Active</span>}
                      </button>
                    );
                  })}
                  <div className="mt-2 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-[11px] text-white/55">
                    Entity scoping is enforced across CI modules.
                  </div>
                </div>
              )}
            </div>

            {/* Env */}
            <div className="relative" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => {
                  setEnvMenuOpen((v) => !v);
                  setEntityMenuOpen(false);
                }}
                className={`flex items-center gap-2 rounded-full border px-4 py-2 text-[12px] transition ${envMeta.pillClass}`}
              >
                <span className={`h-2 w-2 rounded-full ${envMeta.dotClass}`} />
                <span className="font-semibold tracking-wide">{envMeta.label}</span>
                <ChevronDown className="h-4 w-4 text-white/60" />
              </button>

              {envMenuOpen && (
                <div className="absolute right-0 mt-2 w-[320px] rounded-2xl border border-white/10 bg-black/85 p-2 shadow-[0_14px_50px_rgba(0,0,0,0.62)] backdrop-blur-xl z-[80]">
                  <div className="px-3 py-2 text-[11px] text-white/55">Switch environment</div>

                  <button
                    onClick={() => {
                      writeEnv("RoT");
                      setEnvState("RoT");
                      setEnvMenuOpen(false);
                    }}
                    className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-[13px] ${
                      env === "RoT" ? "bg-white/10 text-white" : "hover:bg-white/5 text-white/85"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-[#92f7c6]" />
                      RoT
                    </span>
                    <span className="text-[11px] text-white/45">System of Record</span>
                  </button>

                  <button
                    onClick={() => {
                      writeEnv("SANDBOX");
                      setEnvState("SANDBOX");
                      setEnvMenuOpen(false);
                    }}
                    className={`mt-1 flex w-full items-center justify-between rounded-xl px-3 py-2 text-[13px] ${
                      env === "SANDBOX"
                        ? "bg-[#2a1e0b]/60 text-[#f5d47a]"
                        : "hover:bg-white/5 text-white/85"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-[#f5d47a]" />
                      SANDBOX
                    </span>
                    <span className="text-[11px] text-white/45">Test artifacts only</span>
                  </button>

                  <div className="mt-2 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-[11px] text-white/55">
                    Modules read <span className="text-white/80">oasis_os_env</span> to select{" "}
                    <span className="text-white/80">*_rot</span> vs{" "}
                    <span className="text-white/80">*_sandbox</span>.
                  </div>

                  <div className="mt-2 flex justify-end">
                    <button
                      onClick={() => {
                        const next: OsEnv = env === "SANDBOX" ? "RoT" : "SANDBOX";
                        writeEnv(next);
                        setEnvState(next);
                        setEnvMenuOpen(false);
                      }}
                      className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] text-white/75 hover:bg-white/10"
                    >
                      Quick toggle
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Sign out */}
            <button
              onClick={onSignOut}
              className="flex items-center gap-2 rounded-full border border-white/10 bg-black/25 px-4 py-2 text-[12px] text-white/85 shadow-[0_0_18px_rgba(0,0,0,0.22)] hover:bg-white/5 hover:shadow-[0_0_24px_rgba(201,162,39,0.10)]"
            >
              <LogOut className="h-4 w-4 text-white/65" />
              <span>Sign out</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function OsGlobalBar() {
  // ...your component body
}
export default OsGlobalBar;
