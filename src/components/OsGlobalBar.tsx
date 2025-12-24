"use client";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";

// If your project defines EntityKey somewhere, import it.
// Otherwise keep this local union (safe + build-proof).
type EntityKey = "holdings" | "lounge" | "real-estate";

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
  { key: "holdings", label: "Oasis International Holdings Inc." },
  { key: "lounge", label: "Oasis International Lounge Inc." },
  { key: "real-estate", label: "Oasis International Real Estate Inc." },
];

export function OsGlobalBar() {
  // IMPORTANT: do not assume `entities` exists on context — it caused your build error.
  const { activeEntity, setActiveEntity } = useEntity() as unknown as {
    activeEntity: EntityKey | null;
    setActiveEntity: (k: EntityKey) => void;
  };

  const [env, setEnvState] = useState<OsEnv>(() => getInitialEnv());
  const [operatorEmail, setOperatorEmail] = useState<string>("—");
  const [menuOpen, setMenuOpen] = useState(false);

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

  const envMeta = useMemo(() => {
    if (env === "SANDBOX") {
      return {
        label: "SANDBOX",
        subtitle: "Test artifacts only • Not the system of record",
        pillClass:
          "bg-[#2a1e0b]/55 border-[#c9a227]/35 text-[#f5d47a] shadow-[0_0_28px_rgba(245,212,122,0.10)] hover:shadow-[0_0_40px_rgba(245,212,122,0.16)]",
        icon: "⚗",
      };
    }
    return {
      label: "RoT",
      subtitle: "System of Record",
      pillClass:
        "bg-black/35 border-white/10 text-white/80 shadow-[0_0_18px_rgba(255,255,255,0.06)] hover:shadow-[0_0_28px_rgba(255,255,255,0.10)]",
      icon: "⛨",
    };
  }, [env]);

  const onSignOut = async () => {
    await supabase.auth.signOut();
    window.location.href = "/login";
  };

  return (
    <>
      {/* TOP GLOBAL BAR (sticky) */}
      <div className="sticky top-0 z-[60]">
        <div className="relative h-[64px] w-full border-b border-white/5 bg-black/55 backdrop-blur-xl">
          <div className="mx-auto flex h-full max-w-[1400px] items-center px-5">
            {/* LEFT: Brand */}
            <div className="flex w-1/3 items-center gap-3">
              <div className="h-8 w-8 rounded-full border border-[#c9a227]/40 bg-black/30 shadow-[0_0_20px_rgba(201,162,39,0.16)]" />
              <div className="leading-tight">
                <div className="text-[10px] tracking-[0.22em] text-white/55">OASIS DIGITAL PARLIAMENT</div>
                <div className="text-[13px] font-medium text-white/85">
                  Governance Console <span className="text-[#c9a227]/80">ODP.AI</span>
                </div>
              </div>
            </div>

            {/* CENTER: Clock */}
            <div className="flex w-1/3 items-center justify-center">
              <div className="group flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-4 py-2 text-[12px] text-white/80 shadow-[0_0_24px_rgba(0,0,0,0.25)] transition hover:border-[#c9a227]/25 hover:shadow-[0_0_34px_rgba(201,162,39,0.10)]">
                <span className="text-[#c9a227]/85">🕒</span>
                <span className="min-w-[88px] text-center tracking-wide">{clock}</span>
              </div>
            </div>

            {/* RIGHT: Operator / Entity / Env / Sign out */}
            <div className="flex w-1/3 items-center justify-end gap-3">
              <div className="hidden items-center gap-2 rounded-full border border-white/10 bg-black/25 px-3 py-2 text-[12px] text-white/70 md:flex">
                <span className="text-white/50">Operator:</span>
                <span className="text-white/85">{operatorEmail}</span>
              </div>

              {/* Entity */}
              <div className="rounded-full border border-white/10 bg-black/25 px-3 py-2 text-[12px] text-white/80 shadow-[0_0_18px_rgba(0,0,0,0.22)] transition hover:border-[#c9a227]/20 hover:bg-white/5">
                <span className="text-white/50">Entity:</span>{" "}
                <select
                  className="ml-2 bg-transparent text-white/85 outline-none"
                  value={(activeEntity ?? "holdings") as EntityKey}
                  onChange={(e) => setActiveEntity(e.target.value as EntityKey)}
                >
                  {ENTITY_OPTIONS.map((opt) => (
                    <option key={opt.key} value={opt.key}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Env */}
              <div className="relative">
                <button
                  onClick={() => setMenuOpen((v) => !v)}
                  className={`flex items-center gap-2 rounded-full border px-3 py-2 text-[12px] transition ${envMeta.pillClass}`}
                >
                  <span className="opacity-90">{envMeta.icon}</span>
                  <span className="font-semibold tracking-wide">{envMeta.label}</span>
                  <span className="text-white/55">▾</span>
                </button>

                {menuOpen && (
                  <div className="absolute right-0 mt-2 w-[300px] rounded-2xl border border-white/10 bg-black/85 p-2 shadow-[0_12px_48px_rgba(0,0,0,0.62)] backdrop-blur-xl z-[70]">
                    <div className="px-3 py-2 text-[11px] text-white/55">Environment</div>

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
                      <span className="flex items-center gap-2">
                        <span className="opacity-85">⛨</span> RoT
                      </span>
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
                      <span className="flex items-center gap-2">
                        <span className="opacity-85">⚗</span> SANDBOX
                      </span>
                      <span className="text-[11px] text-white/45">Test artifacts only</span>
                    </button>

                    <div className="mt-2 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-[11px] text-white/55">
                      Policy: modules read <span className="text-white/80">oasis_os_env</span> to select{" "}
                      <span className="text-white/80">*_rot</span> vs <span className="text-white/80">*_sandbox</span>.
                    </div>

                    <div className="mt-2 flex justify-end">
                      <button
                        onClick={() => {
                          const next: OsEnv = env === "SANDBOX" ? "RoT" : "SANDBOX";
                          setEnv(next);
                          setEnvState(next);
                          setMenuOpen(false);
                        }}
                        className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] text-white/70 transition hover:bg-white/10 hover:border-[#c9a227]/20"
                      >
                        Quick toggle
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Sign out (more OS executive) */}
              <button
                onClick={onSignOut}
                className="group flex items-center gap-2 rounded-full border border-white/10 bg-black/25 px-3 py-2 text-[12px] text-white/80 shadow-[0_0_18px_rgba(0,0,0,0.22)] transition hover:border-[#c9a227]/25 hover:bg-white/5 hover:shadow-[0_0_34px_rgba(201,162,39,0.10)]"
              >
                <span className="opacity-75 group-hover:opacity-90">⇦</span>
                <span>Sign out</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* FOOTER SANDBOX RIBBON ONLY (non-blocking) */}
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

// Also export default (prevents the “did you mean default?” import mismatch)
export default OsGlobalBar;
