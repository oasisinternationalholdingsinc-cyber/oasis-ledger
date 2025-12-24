"use client";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity, type EntityKey } from "@/components/OsEntityContext";

type OsEnv = "RoT" | "SANDBOX";

const ENV_KEY = "oasis_os_env";

const ENTITY_OPTIONS: Array<{ key: EntityKey; label: string }> = [
  { key: "holdings", label: "Oasis International Holdings Inc." },
  { key: "real-estate", label: "Oasis International Real Estate Inc." },
  { key: "lounge", label: "Oasis International Lounge Inc." },
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
    const t = setInterval(tick, 10_000);
    return () => clearInterval(t);
  }, []);
  return label;
}

function PillButton({
  children,
  onClick,
  className = "",
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
  title?: string;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={[
        "group inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/25 px-3.5 py-2 text-[12px] text-white/85",
        "backdrop-blur-xl shadow-[0_0_18px_rgba(0,0,0,0.35)]",
        "hover:bg-white/5 hover:border-white/15 hover:shadow-[0_0_26px_rgba(201,162,39,0.10)] transition",
        className,
      ].join(" ")}
    >
      {children}
    </button>
  );
}

export function OsGlobalBar() {
  const { activeEntity, setActiveEntity } = useEntity();

  const [env, setEnvState] = useState<OsEnv>(() => getInitialEnv());
  const [operatorEmail, setOperatorEmail] = useState<string>("—");

  const [envOpen, setEnvOpen] = useState(false);
  const [entityOpen, setEntityOpen] = useState(false);

  const clock = useClockLabel();

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

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      // close menus if clicking outside
      if (!t.closest("[data-os-env]")) setEnvOpen(false);
      if (!t.closest("[data-os-entity]")) setEntityOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const envMeta = useMemo(() => {
    if (env === "SANDBOX") {
      return {
        label: "SANDBOX",
        subtitle: "Test artifacts only • Not the system of record",
        pill:
          "border-[#7a5a1a]/55 bg-[#241807]/55 text-[#f5d47a] shadow-[0_0_22px_rgba(245,212,122,0.10)]",
        dot: "bg-[#f5d47a]",
      };
    }
    return {
      label: "RoT",
      subtitle: "System of Record",
      pill:
        "border-[#1f6f48]/45 bg-[#0b1f14]/55 text-[#92f7c6] shadow-[0_0_22px_rgba(146,247,198,0.10)]",
      dot: "bg-[#92f7c6]",
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
    <>
      {/* TOP GLOBAL BAR */}
      <div className="sticky top-0 z-[60]">
        <div className="relative h-[64px] w-full border-b border-white/5 bg-black/55 backdrop-blur-xl">
          <div className="mx-auto flex h-full max-w-[1400px] items-center px-5">
            {/* LEFT */}
            <div className="flex w-1/3 items-center gap-3">
              {/* Restored logo */}
              <div className="relative h-9 w-9 rounded-full border border-[#c9a227]/40 bg-black/30 shadow-[0_0_22px_rgba(201,162,39,0.16)]">
                <div className="absolute inset-[6px] rounded-full border border-[#c9a227]/30" />
                <div className="absolute inset-[11px] rounded-full bg-[#c9a227]/15" />
              </div>
              <div className="leading-tight">
                <div className="text-[10px] tracking-[0.22em] text-white/55">OASIS DIGITAL PARLIAMENT</div>
                <div className="text-[13px] font-medium text-white/85">
                  Governance Console <span className="text-[#c9a227]/85">ODP.AI</span>
                </div>
              </div>
            </div>

            {/* CENTER — TRUE CENTER, NEVER PUSHED */}
            <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
              <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-4 py-2 text-[12px] text-white/85 shadow-[0_0_24px_rgba(0,0,0,0.35)]">
                <span className="text-[#c9a227]/80">🕒</span>
                <span className="min-w-[92px] text-center tabular-nums">{clock}</span>
              </div>
            </div>

            {/* RIGHT */}
            <div className="ml-auto flex w-1/3 items-center justify-end gap-3">
              {/* Operator (compact, never blocks center) */}
              <div className="hidden md:flex">
                <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/25 px-3.5 py-2 text-[12px] text-white/80 shadow-[0_0_18px_rgba(0,0,0,0.30)]">
                  <span className="text-white/50">Operator</span>
                  <span className="text-white/35">·</span>
                  <span className="max-w-[220px] truncate text-white/90">{operatorEmail}</span>
                </div>
              </div>

              {/* Entity (elite dropdown, matches env quality) */}
              <div className="relative" data-os-entity>
                <PillButton
                  onClick={() => setEntityOpen((v) => !v)}
                  className="min-w-[260px] justify-between px-4"
                  title="Select Entity"
                >
                  <span className="text-white/55">Entity</span>
                  <span className="mx-1 text-white/35">·</span>
                  <span className="max-w-[190px] truncate text-white/90">{activeEntityLabel}</span>
                  <span className="ml-auto text-white/55">▾</span>
                </PillButton>

                {entityOpen && (
                  <div className="absolute right-0 mt-2 w-[340px] rounded-2xl border border-white/10 bg-black/85 p-2 shadow-[0_10px_40px_rgba(0,0,0,0.55)] backdrop-blur-xl">
                    <div className="px-3 py-2 text-[11px] text-white/55">Switch entity</div>
                    {ENTITY_OPTIONS.map((opt) => {
                      const active = opt.key === activeEntity;
                      return (
                        <button
                          key={opt.key}
                          onClick={() => {
                            setActiveEntity(opt.key);
                            setEntityOpen(false);
                          }}
                          className={[
                            "flex w-full items-center justify-between rounded-xl px-3 py-2 text-[13px] transition",
                            active ? "bg-white/10 text-white" : "hover:bg-white/5 text-white/90",
                          ].join(" ")}
                        >
                          <span className="truncate">{opt.label}</span>
                          {active && <span className="text-[11px] text-white/55">Active</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Env (your Style B, RoT green / Sandbox gold) */}
              <div className="relative" data-os-env>
                <PillButton
                  onClick={() => setEnvOpen((v) => !v)}
                  className={[
                    "px-4 font-semibold tracking-wide",
                    envMeta.pill,
                    "hover:shadow-[0_0_30px_rgba(201,162,39,0.12)]",
                  ].join(" ")}
                  title="Switch Environment"
                >
                  <span className={`h-2 w-2 rounded-full ${envMeta.dot}`} />
                  <span>{envMeta.label}</span>
                  <span className="text-white/55">▾</span>
                </PillButton>

                {envOpen && (
                  <div className="absolute right-0 mt-2 w-[320px] rounded-2xl border border-white/10 bg-black/85 p-2 shadow-[0_10px_40px_rgba(0,0,0,0.55)] backdrop-blur-xl z-[80]">
                    <div className="px-3 py-2 text-[11px] text-white/55">Switch environment</div>

                    <button
                      onClick={() => {
                        setEnv("RoT");
                        setEnvState("RoT");
                        setEnvOpen(false);
                      }}
                      className={[
                        "flex w-full items-center justify-between rounded-xl px-3 py-2 text-[13px] transition",
                        env === "RoT" ? "bg-[#0b1f14]/60 text-[#92f7c6] border border-[#1f6f48]/35" : "hover:bg-white/5 text-white/90",
                      ].join(" ")}
                    >
                      <span className="font-semibold">RoT</span>
                      <span className="text-[11px] text-white/55">System of Record</span>
                    </button>

                    <button
                      onClick={() => {
                        setEnv("SANDBOX");
                        setEnvState("SANDBOX");
                        setEnvOpen(false);
                      }}
                      className={[
                        "mt-1 flex w-full items-center justify-between rounded-xl px-3 py-2 text-[13px] transition",
                        env === "SANDBOX"
                          ? "bg-[#241807]/60 text-[#f5d47a] border border-[#7a5a1a]/40"
                          : "hover:bg-white/5 text-white/90",
                      ].join(" ")}
                    >
                      <span className="font-semibold">SANDBOX</span>
                      <span className="text-[11px] text-white/55">Test artifacts only</span>
                    </button>

                    <div className="mt-2 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-[11px] text-white/55">
                      Modules read <span className="text-white/80">oasis_os_env</span> to select{" "}
                      <span className="text-white/80">*_rot</span> vs <span className="text-white/80">*_sandbox</span>.
                    </div>

                    <div className="mt-2 flex justify-end">
                      <button
                        onClick={() => {
                          const next: OsEnv = env === "SANDBOX" ? "RoT" : "SANDBOX";
                          setEnv(next);
                          setEnvState(next);
                          setEnvOpen(false);
                        }}
                        className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] text-white/75 hover:bg-white/10"
                      >
                        Quick toggle
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Sign out (pill, executive) */}
              <PillButton
                onClick={onSignOut}
                className="px-4 hover:border-[#c9a227]/25 hover:shadow-[0_0_26px_rgba(201,162,39,0.14)]"
                title="Sign out"
              >
                <span className="text-white/80">↗</span>
                <span>Sign out</span>
              </PillButton>
            </div>
          </div>
        </div>
      </div>

      {/* FOOTER OPERATIONAL RAIL (as agreed) */}
      {env === "SANDBOX" && (
        <div
          className="fixed bottom-0 left-0 right-0 z-[55] border-t border-[#7a5a1a]/30 bg-gradient-to-r from-[#201607] via-[#2a1e0b] to-[#201607]"
          style={{ pointerEvents: "none" }}
        >
          <div className="mx-auto flex max-w-[1400px] items-center justify-between px-5 py-2 text-[11px]">
            <div className="flex items-center gap-3">
              <span className="font-semibold tracking-[0.16em] text-[#f5d47a]">SANDBOX ENVIRONMENT</span>
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
