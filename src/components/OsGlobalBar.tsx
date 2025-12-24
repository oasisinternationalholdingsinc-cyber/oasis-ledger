"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  LogOut,
  Shield,
  ChevronDown,
  User,
  Clock,
  FlaskConical,
  BadgeCheck,
} from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { useEntity, type EntityKey } from "@/components/OsEntityContext";

const ENTITY_LABEL: Record<EntityKey, string> = {
  holdings: "Holdings",
  "real-estate": "Real Estate",
  lounge: "Lounge",
};

type OsEnv = "RoT" | "SANDBOX";

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

function readEnv(): OsEnv {
  if (typeof window === "undefined") return "RoT";
  const v = (localStorage.getItem("oasis_os_env") || "").toUpperCase();
  return v === "SANDBOX" ? "SANDBOX" : "RoT";
}

function writeEnv(env: OsEnv) {
  if (typeof window === "undefined") return;
  localStorage.setItem("oasis_os_env", env);
  document.documentElement.dataset.oasisEnv = env; // CSS hooks if you want them later
  // Broadcast for any module listeners (no per-module wiring required)
  window.dispatchEvent(new CustomEvent("oasis:env", { detail: { env } }));
}

export function OsGlobalBar() {
  const router = useRouter();
  const supabase = useMemo(() => supabaseBrowser(), []);
  const { activeEntity, setActiveEntity } = useEntity();

  const [entityOpen, setEntityOpen] = useState(false);
  const [envOpen, setEnvOpen] = useState(false);
  const [env, setEnv] = useState<OsEnv>(() => readEnv());
  const [operatorLabel, setOperatorLabel] = useState<string>("Operator");

  const now = useClock();
  const clockText = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  useEffect(() => {
    // ensure html data attr is set on load
    if (typeof window !== "undefined") document.documentElement.dataset.oasisEnv = env;
  }, []);

  useEffect(() => {
    // keep in sync if another tab changes it
    function onStorage(e: StorageEvent) {
      if (e.key === "oasis_os_env") {
        const next = readEnv();
        setEnv(next);
        document.documentElement.dataset.oasisEnv = next;
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    // operator label
    let alive = true;
    (async () => {
      try {
        const { data } = await supabase.auth.getUser();
        const email = data?.user?.email;
        if (!alive) return;
        if (email) setOperatorLabel(email);
      } catch {
        // ignore
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

  function setEnvAndClose(next: OsEnv) {
    setEnv(next);
    writeEnv(next);
    setEnvOpen(false);
  }

  return (
    <div className="sticky top-0 z-50">
      {/* TOP BAR */}
      <div className="border-b border-slate-900/60 bg-black/70 backdrop-blur-xl">
        <div className="relative mx-auto max-w-[1600px] px-5 py-3">
          {/* LEFT ZONE */}
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-9 w-9 rounded-2xl border border-amber-500/25 bg-amber-500/10 flex items-center justify-center">
              <Shield className="h-4 w-4 text-amber-300" />
            </div>

            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-[0.28em] text-slate-500">
                Oasis Digital Parliament
              </div>
              <div className="text-sm font-semibold text-slate-100 truncate">
                Governance Console <span className="text-slate-500 font-medium">ODP.AI</span>
              </div>
            </div>
          </div>

          {/* CENTER CLOCK (true center, independent of left/right width) */}
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 hidden md:flex">
            <div className="flex items-center gap-2 rounded-full border border-slate-800 bg-slate-950/40 px-4 py-2 text-xs text-slate-200">
              <Clock className="h-4 w-4 text-amber-300/80" />
              <span className="font-semibold tracking-wide tabular-nums">{clockText}</span>
            </div>
          </div>

          {/* RIGHT ZONE */}
          <div className="absolute right-5 top-1/2 -translate-y-1/2 flex items-center gap-2">
            {/* Operator */}
            <div className="hidden lg:inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-950/50 px-3 py-2 text-[11px] text-slate-300">
              <User className="h-3.5 w-3.5 text-slate-400" />
              <span className="text-slate-400">Operator:</span>
              <span className="text-slate-100">{operatorLabel}</span>
            </div>

            {/* Entity */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setEntityOpen((v) => !v)}
                className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-950/50 px-3 py-2 text-[11px] text-slate-200 hover:bg-slate-950/70"
                title="Switch entity"
              >
                <span className="text-slate-400">Entity:</span>
                <span className="text-slate-100">{ENTITY_LABEL[activeEntity]}</span>
                <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
              </button>

              {entityOpen && (
                <div
                  className="absolute right-0 mt-2 w-56 overflow-hidden rounded-2xl border border-slate-800 bg-black/95 shadow-xl"
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

            {/* ENV (Style B) */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setEnvOpen((v) => !v)}
                className={cls(
                  "inline-flex items-center gap-2 rounded-full border px-3 py-2 text-[11px] hover:opacity-95",
                  env === "SANDBOX"
                    ? "border-amber-600/40 bg-amber-500/10 text-amber-200"
                    : "border-emerald-600/40 bg-emerald-500/10 text-emerald-200"
                )}
                title="Switch environment"
              >
                {env === "SANDBOX" ? (
                  <FlaskConical className="h-4 w-4" />
                ) : (
                  <BadgeCheck className="h-4 w-4" />
                )}
                <span className="font-semibold tracking-wide">{env}</span>
                <ChevronDown className="h-3.5 w-3.5 opacity-80" />
              </button>

              {envOpen && (
                <div
                  className="absolute right-0 mt-2 w-[340px] overflow-hidden rounded-2xl border border-slate-800 bg-black/95 shadow-xl"
                  onMouseLeave={() => setEnvOpen(false)}
                >
                  <button
                    type="button"
                    onClick={() => setEnvAndClose("RoT")}
                    className={cls(
                      "w-full text-left px-3 py-3 hover:bg-slate-950/70",
                      env === "RoT" ? "text-emerald-200" : "text-slate-200"
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <div className="font-semibold">RoT</div>
                      <div className="text-[11px] text-slate-400">System of Record</div>
                    </div>
                    <div className="mt-1 text-[11px] text-slate-400">
                      Production artifacts. Use <span className="text-slate-300">*_rot</span> views.
                    </div>
                  </button>

                  <div className="h-px bg-slate-900/70" />

                  <button
                    type="button"
                    onClick={() => setEnvAndClose("SANDBOX")}
                    className={cls(
                      "w-full text-left px-3 py-3 hover:bg-slate-950/70",
                      env === "SANDBOX" ? "text-amber-200" : "text-slate-200"
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <div className="font-semibold">SANDBOX</div>
                      <div className="text-[11px] text-slate-400">Test artifacts only</div>
                    </div>
                    <div className="mt-1 text-[11px] text-slate-400">
                      Non-authoritative. Use <span className="text-slate-300">*_sandbox</span> views.
                    </div>
                  </button>

                  <div className="px-3 pb-3 pt-2 text-[11px] text-slate-500">
                    Modules should read <span className="text-slate-300">localStorage.oasis_os_env</span>{" "}
                    to select <span className="text-slate-300">*_rot</span> vs{" "}
                    <span className="text-slate-300">*_sandbox</span> feeds.
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

      {/* SANDBOX BANNER (does NOT steal clicks) */}
      {env === "SANDBOX" && (
        <div className="relative z-40 pointer-events-none">
          <div className="border-b border-amber-500/15 bg-gradient-to-r from-amber-500/10 via-black/50 to-amber-500/10">
            <div className="mx-auto max-w-[1600px] px-5 py-2 flex items-center justify-between gap-3 text-[11px]">
              <div className="flex items-center gap-2 text-amber-200/90">
                <FlaskConical className="h-4 w-4" />
                <span className="font-semibold tracking-[0.22em] uppercase">
                  SANDBOX ENVIRONMENT
                </span>
                <span className="text-slate-400 hidden md:inline">
                  Test artifacts only • Not the system of record
                </span>
              </div>
              <div className="text-slate-500 hidden md:block">
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
