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

type EnvKey = "RoT" | "SANDBOX";

const ENTITY_LABEL: Record<EntityKey, string> = {
  holdings: "Holdings",
  "real-estate": "Real Estate",
  lounge: "Lounge",
};

const ENV_LABEL: Record<EnvKey, string> = {
  RoT: "RoT",
  SANDBOX: "SANDBOX",
};

const ENV_HELP: Record<EnvKey, string> = {
  RoT: "System of Record",
  SANDBOX: "Test artifacts only",
};

const LS_ENV_KEY = "oasis_os_env";

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

function readEnv(): EnvKey {
  if (typeof window === "undefined") return "RoT";
  const raw = window.localStorage.getItem(LS_ENV_KEY);
  return raw === "SANDBOX" ? "SANDBOX" : "RoT";
}

function writeEnv(v: EnvKey) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LS_ENV_KEY, v);
  window.dispatchEvent(new Event("oasis:env"));
}

function useOutsideClick(onOutside: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onOutside();
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onOutside]);
  return ref;
}

/**
 * Export BOTH:
 * - named export: OsHeader imports { OsGlobalBar }
 * - default export: other places may import default
 */
export function OsGlobalBar() {
  const router = useRouter();
  const supabase = useMemo(() => supabaseBrowser(), []);
  const { activeEntity, setActiveEntity } = useEntity();

  const [entityOpen, setEntityOpen] = useState(false);
  const [envOpen, setEnvOpen] = useState(false);

  const [env, setEnv] = useState<EnvKey>("RoT");
  const [operatorLabel, setOperatorLabel] = useState<string>("Operator");

  const now = useClock();
  const clockText = now.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  const entityMenuRef = useOutsideClick(() => setEntityOpen(false));
  const envMenuRef = useOutsideClick(() => setEnvOpen(false));

  useEffect(() => {
    setEnv(readEnv());
    // keep in sync if another tab/page changes it
    function onStorage(e: StorageEvent) {
      if (e.key === LS_ENV_KEY) setEnv(readEnv());
    }
    function onEnvEvent() {
      setEnv(readEnv());
    }
    window.addEventListener("storage", onStorage);
    window.addEventListener("oasis:env", onEnvEvent as any);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("oasis:env", onEnvEvent as any);
    };
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await supabase.auth.getUser();
        const email = data?.user?.email;
        if (email) setOperatorLabel(email);
      } catch {
        // keep default
      }
    })();
  }, [supabase]);

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
    <div className="sticky top-0 z-50">
      {/* Top bar */}
      <div className="border-b border-slate-900/60 bg-black/70 backdrop-blur-xl">
        <div className="mx-auto max-w-[1600px] px-5 py-3">
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4">
            {/* LEFT */}
            <div className="flex items-center gap-3 min-w-0">
              <div className="h-9 w-9 rounded-2xl border border-amber-500/25 bg-amber-500/10 flex items-center justify-center">
                <Shield className="h-4 w-4 text-amber-300" />
              </div>

              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-[0.28em] text-slate-500">
                  Oasis Digital Parliament
                </div>
                <div className="text-sm font-semibold text-slate-100 truncate">
                  Governance Console{" "}
                  <span className="text-slate-500 font-medium">ODP.AI</span>
                </div>
              </div>
            </div>

            {/* CENTER */}
            <div className="hidden md:flex justify-center">
              <div className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-950/40 px-4 py-2 text-xs text-slate-200">
                <Clock className="h-4 w-4 text-amber-300/80" />
                <span className="font-semibold tracking-wide">{clockText}</span>
              </div>
            </div>

            {/* RIGHT */}
            <div className="flex items-center justify-end gap-2">
              <span className="hidden lg:inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-950/50 px-3 py-1 text-[11px] text-slate-300">
                <User className="h-3.5 w-3.5 text-slate-400" />
                <span className="text-slate-400">Operator:</span>
                <span className="text-slate-100">{operatorLabel}</span>
              </span>

              {/* Entity */}
              <div className="relative" ref={entityMenuRef}>
                <button
                  type="button"
                  onClick={() => setEntityOpen((v) => !v)}
                  className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-950/50 px-3 py-1 text-[11px] text-slate-300 hover:bg-slate-950/70"
                  title="Switch entity"
                >
                  <span className="text-slate-400">Entity:</span>
                  <span className="text-slate-100">{ENTITY_LABEL[activeEntity]}</span>
                  <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
                </button>

                {entityOpen && (
                  <div className="absolute right-0 mt-2 w-52 overflow-hidden rounded-2xl border border-slate-800 bg-black/95 shadow-xl">
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

              {/* ENV (Style B) */}
              <div className="relative" ref={envMenuRef}>
                <button
                  type="button"
                  onClick={() => setEnvOpen((v) => !v)}
                  className={cls(
                    "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] hover:opacity-95",
                    isSandbox
                      ? "border-amber-500/35 bg-amber-500/10 text-amber-200"
                      : "border-emerald-500/35 bg-emerald-500/10 text-emerald-200"
                  )}
                  title="Switch environment"
                >
                  {isSandbox ? (
                    <FlaskConical className="h-3.5 w-3.5" />
                  ) : (
                    <Database className="h-3.5 w-3.5" />
                  )}
                  <span className="font-semibold">{ENV_LABEL[env]}</span>
                  <ChevronDown className="h-3.5 w-3.5 opacity-80" />
                </button>

                {envOpen && (
                  <div className="absolute right-0 mt-2 w-72 overflow-hidden rounded-2xl border border-slate-800 bg-black/95 shadow-xl">
                    {(["RoT", "SANDBOX"] as EnvKey[]).map((k) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => {
                          writeEnv(k);
                          setEnv(k);
                          setEnvOpen(false);
                        }}
                        className={cls(
                          "w-full text-left px-3 py-2 text-xs hover:bg-slate-950/70",
                          k === env ? "text-amber-200" : "text-slate-200"
                        )}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="font-semibold">{ENV_LABEL[k]}</div>
                          <div className="text-[11px] text-slate-500">{ENV_HELP[k]}</div>
                        </div>
                        <div className="mt-1 text-[11px] text-slate-500">
                          Modules select <span className="text-slate-300">*_rot</span> vs{" "}
                          <span className="text-slate-300">*_sandbox</span> views.
                        </div>
                      </button>
                    ))}
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
      </div>

      {/* SANDBOX ribbon (NEVER steals clicks) */}
      {isSandbox && (
        <div className="relative">
          {/* glow layer: pointer-events-none so it cannot block dropdown clicks */}
          <div className="pointer-events-none absolute inset-0 z-0">
            <div className="h-full w-full bg-gradient-to-r from-amber-500/0 via-amber-500/10 to-amber-500/0" />
            <div className="h-full w-full bg-[radial-gradient(ellipse_at_center,rgba(245,158,11,0.12),transparent_70%)]" />
          </div>

          {/* ribbon content */}
          <div className="relative z-10 border-b border-amber-500/20 bg-amber-500/5">
            <div className="mx-auto max-w-[1600px] px-5 py-2">
              <div className="flex items-center justify-between gap-3 text-[11px]">
                <div className="inline-flex items-center gap-2 rounded-full border border-amber-500/25 bg-black/40 px-3 py-1 text-amber-200">
                  <FlaskConical className="h-3.5 w-3.5" />
                  <span className="font-semibold tracking-[0.18em] uppercase">
                    SANDBOX ENVIRONMENT
                  </span>
                </div>

                <div className="min-w-0 truncate text-slate-400">
                  Test artifacts only • Not the system of record
                </div>

                <div className="hidden md:block text-slate-500">
                  Style B: modules select{" "}
                  <span className="text-slate-300">*_sandbox</span> views
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default OsGlobalBar;
