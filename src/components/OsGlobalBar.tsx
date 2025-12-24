"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut, Shield, ChevronDown, User, Clock } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { useEntity, type EntityKey } from "@/components/OsEntityContext";

type OsEnv = "RoT" | "SANDBOX";

const ENV_KEY = "oasis_os_env";

const ENTITY_LABEL: Record<EntityKey, string> = {
  holdings: "Holdings",
  "real-estate": "Real Estate",
  lounge: "Lounge",
};

function cls(...p: Array<string | false | null | undefined>) {
  return p.filter(Boolean).join(" ");
}

function getInitialEnv(): OsEnv {
  if (typeof window === "undefined") return "RoT";
  const v = window.localStorage.getItem(ENV_KEY);
  return v === "SANDBOX" ? "SANDBOX" : "RoT";
}

function setPersistedEnv(next: OsEnv) {
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
  const router = useRouter();
  const supabase = useMemo(() => supabaseBrowser(), []);
  const { activeEntity, setActiveEntity } = useEntity();

  const [env, setEnv] = useState<OsEnv>(() => getInitialEnv());
  const [operatorEmail, setOperatorEmail] = useState<string>("—");

  const [entityOpen, setEntityOpen] = useState(false);
  const [envOpen, setEnvOpen] = useState(false);

  const clock = useClockLabel();

  useEffect(() => {
    // sync across tabs + internal event
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
      try {
        const { data } = await supabase.auth.getUser();
        if (!mounted) return;
        setOperatorEmail(data?.user?.email ?? "—");
      } catch {
        if (!mounted) return;
        setOperatorEmail("—");
      }
    })();
    return () => {
      mounted = false;
    };
  }, [supabase]);

  const envMeta = useMemo(() => {
    if (env === "SANDBOX") {
      return {
        label: "SANDBOX",
        subtitle: "Test artifacts only • Not system of record",
        pill:
          "bg-[#2a1e0b]/60 border-[#7a5a1a]/50 text-[#f5d47a] shadow-[0_0_26px_rgba(245,212,122,0.10)]",
        icon: "⚗",
      };
    }
    return {
      label: "RoT",
      subtitle: "System of Record",
      pill:
        "bg-[#0b1f14]/60 border-[#1f6f48]/40 text-[#92f7c6] shadow-[0_0_22px_rgba(146,247,198,0.10)]",
      icon: "⛨",
    };
  }, [env]);

  function chooseEnv(next: OsEnv) {
    setPersistedEnv(next);
    setEnv(next);
    setEnvOpen(false);
  }

  async function signOut(e?: React.MouseEvent) {
    e?.preventDefault();
    e?.stopPropagation();
    try {
      await supabase.auth.signOut();
    } catch {}
    router.replace("/login");
  }

  // close menus on outside click / escape
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        setEntityOpen(false);
        setEnvOpen(false);
      }
    };
    const onClick = () => {
      setEntityOpen(false);
      setEnvOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onClick);
    };
  }, []);

  return (
    <div className="sticky top-0 z-[40]">
      {/* Global Bar */}
      <div className="relative h-[64px] w-full border-b border-white/5 bg-black/60 backdrop-blur-xl">
        <div className="mx-auto flex h-full max-w-[1400px] items-center px-5">
          {/* LEFT */}
          <div className="flex w-1/3 items-center gap-3 min-w-0">
            <div className="h-9 w-9 rounded-2xl border border-amber-500/25 bg-amber-500/10 flex items-center justify-center shrink-0">
              <Shield className="h-4 w-4 text-amber-300" />
            </div>

            <div className="min-w-0 leading-tight">
              <div className="text-[10px] tracking-[0.22em] text-white/55 truncate">
                OASIS DIGITAL PARLIAMENT
              </div>
              <div className="text-[13px] font-medium text-white/85 truncate">
                Governance Console <span className="text-amber-300/80">ODP.AI</span>
              </div>
            </div>
          </div>

          {/* CENTER (true centered) */}
          <div className="flex w-1/3 items-center justify-center">
            <div className="flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-4 py-2 text-[12px] text-white/80">
              <Clock className="h-4 w-4 text-amber-300/80" />
              <span className="min-w-[86px] text-center font-semibold tracking-wide">{clock}</span>
            </div>
          </div>

          {/* RIGHT */}
          <div className="flex w-1/3 items-center justify-end gap-3">
            <div className="hidden md:flex items-center gap-2 rounded-full border border-white/10 bg-black/25 px-3 py-2 text-[12px] text-white/70">
              <User className="h-4 w-4 text-white/45" />
              <span className="text-white/45">Operator:</span>
              <span className="text-white/85">{operatorEmail}</span>
            </div>

            {/* Entity */}
            <div className="relative" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                onClick={() => {
                  setEntityOpen((v) => !v);
                  setEnvOpen(false);
                }}
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/25 px-3 py-2 text-[12px] text-white/80 hover:bg-white/5"
                title="Switch entity"
              >
                <span className="text-white/45">Entity:</span>
                <span className="text-white/85">{ENTITY_LABEL[activeEntity]}</span>
                <ChevronDown className="h-3.5 w-3.5 text-white/45" />
              </button>

              {entityOpen && (
                <div className="absolute right-0 mt-2 w-56 overflow-hidden rounded-2xl border border-white/10 bg-black/90 shadow-[0_18px_60px_rgba(0,0,0,0.55)] backdrop-blur-xl z-[70]">
                  {(Object.keys(ENTITY_LABEL) as EntityKey[]).map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => {
                        setActiveEntity(k);
                        setEntityOpen(false);
                      }}
                      className={cls(
                        "w-full text-left px-3 py-2 text-[12px] hover:bg-white/5",
                        k === activeEntity ? "text-amber-200" : "text-white/85"
                      )}
                    >
                      {ENTITY_LABEL[k]}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Env (Style B) */}
            <div className="relative" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                onClick={() => {
                  setEnvOpen((v) => !v);
                  setEntityOpen(false);
                }}
                className={cls("inline-flex items-center gap-2 rounded-full border px-3 py-2 text-[12px]", envMeta.pill)}
                title="Switch environment"
              >
                <span>{envMeta.icon}</span>
                <span className="font-semibold tracking-wide">{envMeta.label}</span>
                <ChevronDown className="h-3.5 w-3.5 text-white/45" />
              </button>

              {envOpen && (
                <div className="absolute right-0 mt-2 w-[300px] rounded-2xl border border-white/10 bg-black/90 p-2 shadow-[0_18px_60px_rgba(0,0,0,0.55)] backdrop-blur-xl z-[70]">
                  <div className="px-3 py-2 text-[11px] text-white/55">Switch environment</div>

                  <button
                    type="button"
                    onClick={() => chooseEnv("RoT")}
                    className={cls(
                      "flex w-full items-center justify-between rounded-xl px-3 py-2 text-[13px]",
                      env === "RoT" ? "bg-white/10 text-white" : "hover:bg-white/5 text-white/85"
                    )}
                  >
                    <span>RoT</span>
                    <span className="text-[11px] text-white/45">System of Record</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => chooseEnv("SANDBOX")}
                    className={cls(
                      "mt-1 flex w-full items-center justify-between rounded-xl px-3 py-2 text-[13px]",
                      env === "SANDBOX" ? "bg-[#2a1e0b]/60 text-[#f5d47a]" : "hover:bg-white/5 text-white/85"
                    )}
                  >
                    <span>SANDBOX</span>
                    <span className="text-[11px] text-white/45">Test artifacts only</span>
                  </button>

                  <div className="mt-2 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-[11px] text-white/55">
                    Style B: modules select <span className="text-white/80">*_rot</span> vs{" "}
                    <span className="text-white/80">*_sandbox</span> views using{" "}
                    <span className="text-white/80">oasis_os_env</span>.
                  </div>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={signOut}
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/25 px-3 py-2 text-[12px] text-white/80 hover:bg-white/5"
              title="Sign out"
            >
              <LogOut className="h-4 w-4 text-white/60" />
              Sign out
            </button>
          </div>
        </div>
      </div>

      {/* SANDBOX RIBBON (never steals clicks) */}
      {env === "SANDBOX" && (
        <div
          className="relative z-[5] border-b border-[#7a5a1a]/35 bg-gradient-to-r from-[#201607] via-[#2a1e0b] to-[#201607]"
          style={{ pointerEvents: "none" }}
        >
          <div className="mx-auto flex max-w-[1400px] items-center justify-between px-5 py-2 text-[11px]">
            <div className="flex items-center gap-3 min-w-0">
              <span className="font-semibold tracking-[0.16em] text-[#f5d47a] whitespace-nowrap">
                SANDBOX ENVIRONMENT
              </span>
              <span className="text-white/55 truncate">Test artifacts only • Not the system of record</span>
            </div>
            <div className="text-white/45 whitespace-nowrap">Style B active</div>
          </div>
        </div>
      )}
    </div>
  );
}

export default OsGlobalBar;
