"use client";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import type { EntityKey } from "@/components/OsEntityContext";

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
    const t = setInterval(tick, 15_000);
    return () => clearInterval(t);
  }, []);
  return label;
}

function ShieldMark() {
  return (
    <div className="relative h-9 w-9 rounded-full border border-[#c9a227]/35 bg-black/35 shadow-[0_0_24px_rgba(201,162,39,0.16)]">
      <div className="absolute inset-0 rounded-full shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]" />
      <svg
        viewBox="0 0 24 24"
        className="absolute left-1/2 top-1/2 h-[18px] w-[18px] -translate-x-1/2 -translate-y-1/2 opacity-90"
        fill="none"
      >
        <path
          d="M12 2.8c3.1 2.1 6 2.3 8.2 2.6v7.1c0 5.2-3.7 8.4-8.2 9.7-4.5-1.3-8.2-4.5-8.2-9.7V5.4c2.2-.3 5.1-.5 8.2-2.6Z"
          stroke="rgba(245,212,122,0.95)"
          strokeWidth="1.35"
        />
        <path
          d="M8.2 11.7l2.4 2.4 5.2-5.2"
          stroke="rgba(245,212,122,0.95)"
          strokeWidth="1.35"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

export function OsGlobalBar() {
  const { activeEntity, setActiveEntity } = useEntity();

  const [env, setEnvState] = useState<OsEnv>(() => getInitialEnv());
  const [operatorEmail, setOperatorEmail] = useState<string>("—");
  const [envMenuOpen, setEnvMenuOpen] = useState(false);

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

  const activeEntityLabel = useMemo(() => {
    const hit = ENTITY_OPTIONS.find((x) => x.key === activeEntity);
    return hit?.label ?? "—";
  }, [activeEntity]);

  const envMeta = useMemo(() => {
    if (env === "SANDBOX") {
      return {
        label: "SANDBOX",
        subtitle: "Test artifacts only • Not system of record",
        pill:
          "bg-[#2a1e0b]/60 border-[#7a5a1a]/55 text-[#f5d47a] shadow-[0_0_30px_rgba(245,212,122,0.12)] hover:shadow-[0_0_44px_rgba(245,212,122,0.18)]",
        dot: "bg-[#f5d47a]",
      };
    }
    return {
      label: "RoT",
      subtitle: "System of Record",
      pill:
        "bg-[#0b1f14]/55 border-[#1f6f48]/45 text-[#92f7c6] shadow-[0_0_26px_rgba(146,247,198,0.10)] hover:shadow-[0_0_42px_rgba(146,247,198,0.16)]",
      dot: "bg-[#92f7c6]",
    };
  }, [env]);

  const onSignOut = async () => {
    await supabase.auth.signOut();
    window.location.href = "/login";
  };

  return (
    <>
      {/* TOP GLOBAL BAR */}
      <div className="sticky top-0 z-[60]">
        <div className="relative h-[64px] w-full border-b border-white/5 bg-black/55 backdrop-blur-xl">
          <div className="mx-auto grid h-full max-w-[1400px] grid-cols-[1fr_auto_1fr] items-center gap-4 px-5">
            {/* LEFT: Brand + Operator (no overlap) */}
            <div className="flex min-w-0 items-center gap-4">
              <div className="flex items-center gap-3 min-w-0">
                <ShieldMark />
                <div className="min-w-0 leading-tight">
                  <div className="text-[10px] tracking-[0.22em] text-white/55">OASIS DIGITAL PARLIAMENT</div>
                  <div className="text-[13px] font-medium text-white/85">
                    Governance Console <span className="text-[#c9a227]/80">ODP.AI</span>
                  </div>
                </div>
              </div>

              {/* Operator pill (left-side, constrained, never collides with center) */}
              <div className="hidden min-w-0 items-center gap-2 rounded-full border border-white/10 bg-black/25 px-3 py-2 text-[12px] text-white/75 shadow-[0_0_22px_rgba(0,0,0,0.25)] md:flex">
                <span className="text-white/50">Operator</span>
                <span className="text-white/30">•</span>
                <span className="truncate text-white/85" title={operatorEmail}>
                  {operatorEmail}
                </span>
              </div>
            </div>

            {/* CENTER: Clock (true centered) */}
            <div className="flex items-center justify-center">
              <div className="flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-4 py-2 text-[12px] text-white/85 shadow-[0_0_28px_rgba(0,0,0,0.28)]">
                <span className="text-[#c9a227]/85">🕒</span>
                <span className="min-w-[92px] text-center tabular-nums">{clock}</span>
              </div>
            </div>

            {/* RIGHT: Entity / Env / Sign out */}
            <div className="flex items-center justify-end gap-3">
              {/* Entity selector (styled enterprise) */}
              <div className="group flex items-center gap-2 rounded-full border border-white/10 bg-black/25 px-3 py-2 text-[12px] text-white/85 shadow-[0_0_22px_rgba(0,0,0,0.22)] hover:border-white/15 hover:bg-white/5 hover:shadow-[0_0_34px_rgba(201,162,39,0.10)]">
                <span className="text-white/55">Entity</span>
                <span className="text-white/30">•</span>
                <select
                  className="max-w-[260px] cursor-pointer bg-transparent text-white/90 outline-none"
                  value={(activeEntity ?? "holdings") as EntityKey}
                  onChange={(e) => setActiveEntity(e.target.value as EntityKey)}
                  title={activeEntityLabel}
                >
                  {ENTITY_OPTIONS.map((opt) => (
                    <option key={opt.key} value={opt.key}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Env selector (pill) */}
              <div className="relative">
                <button
                  onClick={() => setEnvMenuOpen((v) => !v)}
                  className={`flex items-center gap-2 rounded-full border px-3 py-2 text-[12px] transition ${envMeta.pill}`}
                >
                  <span className={`h-2 w-2 rounded-full ${envMeta.dot}`} />
                  <span className="font-semibold tracking-wide">{envMeta.label}</span>
                  <span className="text-white/55">▾</span>
                </button>

                {envMenuOpen && (
                  <div className="absolute right-0 mt-2 w-[320px] rounded-2xl border border-white/10 bg-black/85 p-2 shadow-[0_12px_46px_rgba(0,0,0,0.62)] backdrop-blur-xl z-[80]">
                    <div className="px-3 py-2 text-[11px] text-white/55">Select environment</div>

                    <button
                      onClick={() => {
                        setEnv("RoT");
                        setEnvState("RoT");
                        setEnvMenuOpen(false);
                      }}
                      className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-[13px] ${
                        env === "RoT" ? "bg-white/10 text-white" : "hover:bg-white/5 text-white/85"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full bg-[#92f7c6]" />
                        <span>RoT</span>
                      </div>
                      <span className="text-[11px] text-white/45">System of Record</span>
                    </button>

                    <button
                      onClick={() => {
                        setEnv("SANDBOX");
                        setEnvState("SANDBOX");
                        setEnvMenuOpen(false);
                      }}
                      className={`mt-1 flex w-full items-center justify-between rounded-xl px-3 py-2 text-[13px] ${
                        env === "SANDBOX"
                          ? "bg-[#2a1e0b]/60 text-[#f5d47a]"
                          : "hover:bg-white/5 text-white/85"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full bg-[#f5d47a]" />
                        <span>SANDBOX</span>
                      </div>
                      <span className="text-[11px] text-white/45">Test artifacts only</span>
                    </button>

                    <div className="mt-2 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-[11px] text-white/55">
                      Modules read <span className="text-white/80">oasis_os_env</span> to select{" "}
                      <span className="text-white/80">*_rot</span> vs <span className="text-white/80">*_sandbox</span>.
                    </div>
                  </div>
                )}
              </div>

              {/* Sign out (pill, executive) */}
              <button
                onClick={onSignOut}
                className="group flex items-center gap-2 rounded-full border border-white/10 bg-black/25 px-4 py-2 text-[12px] text-white/85 shadow-[0_0_22px_rgba(0,0,0,0.22)] hover:border-white/15 hover:bg-white/5 hover:shadow-[0_0_34px_rgba(201,162,39,0.12)]"
              >
                <span className="text-white/60 group-hover:text-white/85">↗</span>
                <span>Sign out</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* FOOTER: NON-BLOCKING SANDBOX RIBBON ONLY */}
      {env === "SANDBOX" && (
        <div
          className="fixed bottom-0 left-0 right-0 z-[55] border-t border-[#7a5a1a]/35 bg-gradient-to-r from-[#201607] via-[#2a1e0b] to-[#201607]"
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
