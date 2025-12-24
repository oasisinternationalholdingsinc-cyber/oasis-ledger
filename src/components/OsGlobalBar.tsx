"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  LogOut,
  Shield,
  ChevronDown,
  User,
  Clock,
  FlaskConical,
  Database,
} from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { useEntity, type EntityKey } from "@/components/OsEntityContext";

type OsEnv = "RoT" | "SANDBOX";

const ENTITY_LABEL: Record<EntityKey, string> = {
  holdings: "Holdings",
  "real-estate": "Real Estate",
  lounge: "Lounge",
};

function cls(...p: Array<string | false | null | undefined>) {
  return p.filter(Boolean).join(" ");
}

function useClock() {
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

const LS_ENV_KEY = "oasis_os_env";

function readEnv(): OsEnv {
  if (typeof window === "undefined") return "SANDBOX";
  const v = window.localStorage.getItem(LS_ENV_KEY);
  return v === "RoT" || v === "SANDBOX" ? v : "SANDBOX";
}

function writeEnv(next: OsEnv) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LS_ENV_KEY, next);
  document.documentElement.dataset.oasisEnv = next; // optional global hook
  window.dispatchEvent(new CustomEvent("oasis:env", { detail: next }));
}

export function OsGlobalBar() {
  const router = useRouter();
  const supabase = useMemo(() => supabaseBrowser(), []);
  const { activeEntity, setActiveEntity } = useEntity();

  const [entityOpen, setEntityOpen] = useState(false);
  const [envOpen, setEnvOpen] = useState(false);
  const [env, setEnv] = useState<OsEnv>(() => readEnv());

  const now = useClock();

  // TODO: wire to profiles later (kept as you had)
  const operatorLabel = "abbas1167@hotmail.com";
  const clockText = now.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Ensure DOM hook is set on load
    writeEnv(env);

    const onEnv = (e: Event) => {
      const ce = e as CustomEvent;
      const next = ce?.detail;
      if (next === "RoT" || next === "SANDBOX") setEnv(next);
    };
    window.addEventListener("oasis:env", onEnv as any);

    const onDoc = (ev: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(ev.target as Node)) {
        setEntityOpen(false);
        setEnvOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);

    return () => {
      window.removeEventListener("oasis:env", onEnv as any);
      document.removeEventListener("mousedown", onDoc);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function signOut(e?: React.MouseEvent) {
    e?.preventDefault();
    e?.stopPropagation();
    try {
      await supabase.auth.signOut();
    } catch {}
    router.replace("/login");
  }

  const isSandbox = env === "SANDBOX";

  return (
    <div ref={rootRef} className="sticky top-0 z-[80]">
      {/* GLOBAL BAR */}
      <div className="relative border-b border-amber-500/20 bg-black/70 backdrop-blur-xl">
        <div className="mx-auto max-w-[1600px] px-5 h-16 flex items-center">
          {/* LEFT */}
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className="h-9 w-9 rounded-2xl border border-amber-500/25 bg-amber-500/10 flex items-center justify-center">
              <Shield className="h-4 w-4 text-amber-300" />
            </div>

            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-[0.32em] text-slate-500">
                Oasis Digital Parliament
              </div>
              <div className="text-sm font-semibold text-slate-100 truncate">
                Governance Console{" "}
                <span className="text-slate-500 font-medium">ODP.AI</span>
              </div>
            </div>
          </div>

          {/* CENTER (true centered) */}
          <div className="absolute left-1/2 -translate-x-1/2 hidden md:flex items-center gap-2 rounded-full border border-slate-800 bg-slate-950/40 px-4 py-2 text-xs text-slate-200">
            <Clock className="h-4 w-4 text-amber-300/80" />
            <span className="font-semibold tracking-wide">{clockText}</span>
          </div>

          {/* RIGHT */}
          <div className="flex items-center justify-end gap-2 flex-1">
            {/* Operator */}
            <span className="hidden lg:inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-950/50 px-3 py-1 text-[11px] text-slate-300">
              <User className="h-3.5 w-3.5 text-slate-400" />
              <span className="text-slate-400">Operator:</span>
              <span className="text-slate-100">{operatorLabel}</span>
            </span>

            {/* Entity */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setEntityOpen((v) => !v);
                  setEnvOpen(false);
                }}
                className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-950/50 px-3 py-1 text-[11px] text-slate-200 hover:bg-slate-950/70"
                title="Switch entity"
              >
                <span className="text-slate-400">Entity:</span>
                <span className="text-slate-100">{ENTITY_LABEL[activeEntity]}</span>
                <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
              </button>

              {entityOpen && (
                <div className="absolute right-0 mt-2 w-56 overflow-hidden rounded-2xl border border-slate-800 bg-black/95 shadow-2xl z-[120]">
                  {(Object.keys(ENTITY_LABEL) as EntityKey[]).map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => {
                        setActiveEntity(k);
                        setEntityOpen(false);
                      }}
                      className={cls(
                        "w-full text-left px-3 py-2 text-xs hover:bg-slate-950/70",
                        k === activeEntity ? "text-amber-200" : "text-slate-200"
                      )}
                    >
                      {ENTITY_LABEL[k]}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* ENV (Style B toggle driver) */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setEnvOpen((v) => !v);
                  setEntityOpen(false);
                }}
                className={cls(
                  "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] hover:brightness-110",
                  isSandbox
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
                    : "border-emerald-400/40 bg-emerald-400/10 text-emerald-200"
                )}
                title="Switch environment"
              >
                {isSandbox ? (
                  <FlaskConical className="h-3.5 w-3.5" />
                ) : (
                  <Database className="h-3.5 w-3.5" />
                )}
                <span className="font-semibold tracking-wide">{env}</span>
                <ChevronDown className="h-3.5 w-3.5 opacity-80" />
              </button>

              {envOpen && (
                <div className="absolute right-0 mt-2 w-64 overflow-hidden rounded-2xl border border-slate-800 bg-black/95 shadow-2xl z-[120]">
                  <button
                    type="button"
                    onClick={() => {
                      setEnv("RoT");
                      writeEnv("RoT");
                      setEnvOpen(false);
                    }}
                    className={cls(
                      "w-full text-left px-3 py-2 text-xs hover:bg-slate-950/70",
                      env === "RoT" ? "text-emerald-200" : "text-slate-200"
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold">RoT</span>
                      <span className="text-[10px] text-slate-500">System of Record</span>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setEnv("SANDBOX");
                      writeEnv("SANDBOX");
                      setEnvOpen(false);
                    }}
                    className={cls(
                      "w-full text-left px-3 py-2 text-xs hover:bg-slate-950/70",
                      env === "SANDBOX" ? "text-amber-200" : "text-slate-200"
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold">SANDBOX</span>
                      <span className="text-[10px] text-slate-500">Test artifacts only</span>
                    </div>
                  </button>

                  <div className="px-3 py-2 border-t border-slate-800 text-[10px] text-slate-500">
                    Modules should read <span className="text-slate-300">oasis_os_env</span> to select{" "}
                    <span className="text-slate-300">*_rot</span> vs{" "}
                    <span className="text-slate-300">*_sandbox</span> views.
                  </div>
                </div>
              )}
            </div>

            {/* Sign out */}
            <button
              type="button"
              onClick={signOut}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs text-slate-200 hover:bg-slate-950/70"
              title="Sign out"
            >
              <LogOut className="h-4 w-4 text-slate-300" />
              Sign out
            </button>
          </div>
        </div>
      </div>

      {/* LOUD SANDBOX BANNER (never blocks clicks) */}
      {isSandbox && (
        <div className="relative z-[10] pointer-events-none">
          <div className="mx-auto max-w-[1600px] px-5">
            <div className="mt-2 mb-2 rounded-full border border-amber-500/30 bg-amber-500/10 backdrop-blur px-4 py-2 text-[11px] text-amber-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FlaskConical className="h-4 w-4" />
                <span className="font-semibold tracking-[0.2em] uppercase">
                  SANDBOX ENVIRONMENT
                </span>
                <span className="text-slate-400 ml-2">
                  Test artifacts only • Not the system of record
                </span>
              </div>
              <div className="hidden lg:block text-slate-500">
                Style B: modules select <span className="text-slate-300">*_sandbox</span> views
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default OsGlobalBar;
