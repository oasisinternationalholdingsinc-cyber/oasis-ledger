"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  LogOut,
  Shield,
  ChevronDown,
  User,
  Clock,
  Beaker,
  BadgeCheck,
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

const ENV_STORAGE_KEY = "oasis_os_env"; // used by modules to pick *_rot vs *_sandbox views

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

function readEnvFromStorage(): EnvKey {
  if (typeof window === "undefined") return "SANDBOX";
  const v = (window.localStorage.getItem(ENV_STORAGE_KEY) || "").toUpperCase();
  return v === "ROT" ? "RoT" : "SANDBOX";
}

function writeEnvToStorage(env: EnvKey) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ENV_STORAGE_KEY, env);
  window.dispatchEvent(new CustomEvent("oasis:env-changed", { detail: { env } }));
}

export function OsGlobalBar() {
  const router = useRouter();
  const supabase = useMemo(() => supabaseBrowser(), []);
  const { activeEntity, setActiveEntity } = useEntity();

  const [entityOpen, setEntityOpen] = useState(false);
  const [envOpen, setEnvOpen] = useState(false);

  const [env, setEnv] = useState<EnvKey>("SANDBOX");
  const [operatorLabel, setOperatorLabel] = useState("Operator");

  const now = useClock();
  const clockText = now.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  useEffect(() => {
    // initialize env from localStorage (default SANDBOX)
    setEnv(readEnvFromStorage());
  }, []);

  useEffect(() => {
    // operator label from current session (email), fallback to "Operator"
    let alive = true;
    (async () => {
      try {
        const { data } = await supabase.auth.getUser();
        const email = data?.user?.email || "";
        if (!alive) return;
        setOperatorLabel(email ? email : "Operator");
      } catch {
        if (!alive) return;
        setOperatorLabel("Operator");
      }
    })();
    return () => {
      alive = false;
    };
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
      {/* MAIN BAR */}
      <div className="border-b border-slate-900/60 bg-black/70 backdrop-blur-xl">
        <div className="mx-auto max-w-[1600px] px-5 py-3 flex items-center justify-between gap-4">
          {/* LEFT: Brand + Operator + Entity + Env */}
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

            <span className="hidden md:inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-950/50 px-3 py-1 text-[11px] text-slate-300">
              <User className="h-3.5 w-3.5 text-slate-400" />
              <span className="text-slate-400">Operator:</span>
              <span className="text-slate-100 truncate max-w-[260px]">
                {operatorLabel}
              </span>
            </span>

            {/* ENTITY SELECT */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setEntityOpen((v) => !v);
                  setEnvOpen(false);
                }}
                className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-950/50 px-3 py-1 text-[11px] text-slate-300 hover:bg-slate-950/70"
                title="Switch entity"
              >
                <span className="text-slate-400">Entity:</span>
                <span className="text-slate-100">{ENTITY_LABEL[activeEntity]}</span>
                <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
              </button>

              {entityOpen && (
                <div
                  className="absolute left-0 mt-2 w-52 overflow-hidden rounded-2xl border border-slate-800 bg-black/95 shadow-xl"
                  onMouseLeave={() => setEntityOpen(false)}
                >
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

            {/* ENV SELECT (Style B driver: modules choose *_rot vs *_sandbox views) */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setEnvOpen((v) => !v);
                  setEntityOpen(false);
                }}
                className={cls(
                  "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] hover:bg-slate-950/70",
                  isSandbox
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
                    : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                )}
                title="Switch environment"
              >
                {isSandbox ? (
                  <Beaker className="h-3.5 w-3.5 text-amber-300" />
                ) : (
                  <BadgeCheck className="h-3.5 w-3.5 text-emerald-300" />
                )}
                <span className={cls(isSandbox ? "text-amber-200" : "text-emerald-200")}>
                  {ENV_LABEL[env]}
                </span>
                <ChevronDown className="h-3.5 w-3.5 opacity-80" />
              </button>

              {envOpen && (
                <div
                  className="absolute left-0 mt-2 w-52 overflow-hidden rounded-2xl border border-slate-800 bg-black/95 shadow-xl"
                  onMouseLeave={() => setEnvOpen(false)}
                >
                  {(["RoT", "SANDBOX"] as EnvKey[]).map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => {
                        setEnv(k);
                        writeEnvToStorage(k);
                        setEnvOpen(false);
                      }}
                      className={cls(
                        "w-full text-left px-3 py-2 text-xs hover:bg-slate-950/70",
                        k === env ? "text-amber-200" : "text-slate-200"
                      )}
                    >
                      {k === "RoT" ? "RoT (System of Record)" : "SANDBOX (Test Artifacts)"}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* CENTER: Clock */}
          <div className="hidden md:flex items-center gap-2 rounded-full border border-slate-800 bg-slate-950/40 px-4 py-2 text-xs text-slate-200">
            <Clock className="h-4 w-4 text-amber-300/80" />
            <span className="font-semibold tracking-wide">{clockText}</span>
          </div>

          {/* RIGHT: Sign out */}
          <div className="flex items-center gap-2">
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

      {/* LOUD ENV BANNER (cannot miss) */}
      {isSandbox ? (
        <div className="border-b border-amber-500/25 bg-gradient-to-r from-amber-500/20 via-black/70 to-amber-500/20 backdrop-blur-xl">
          <div className="mx-auto max-w-[1600px] px-5 py-2 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs">
              <span className="inline-flex items-center gap-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[11px] uppercase tracking-[0.22em] text-amber-200">
                <Beaker className="h-4 w-4 text-amber-300" />
                SANDBOX ENVIRONMENT
              </span>
              <span className="text-[11px] text-slate-300">
                Test artifacts only • Not the system of record
              </span>
            </div>

            <span className="hidden md:inline-flex text-[11px] text-slate-400">
              Modules should read{" "}
              <span className="mx-1 font-mono text-slate-200">{ENV_STORAGE_KEY}</span>
              to select *_sandbox views
            </span>
          </div>
        </div>
      ) : (
        <div className="border-b border-emerald-500/20 bg-gradient-to-r from-emerald-500/15 via-black/70 to-emerald-500/15 backdrop-blur-xl">
          <div className="mx-auto max-w-[1600px] px-5 py-2 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs">
              <span className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-[11px] uppercase tracking-[0.22em] text-emerald-200">
                <BadgeCheck className="h-4 w-4 text-emerald-300" />
                RoT • SYSTEM OF RECORD
              </span>
              <span className="text-[11px] text-slate-300">
                Canonical ledger artifacts • Archive discipline enforced
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default OsGlobalBar;
