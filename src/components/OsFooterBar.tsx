"use client";

import { useEffect, useMemo, useState } from "react";

type OsEnv = "RoT" | "SANDBOX";
const ENV_KEY = "oasis_os_env";

function getInitialEnv(): OsEnv {
  if (typeof window === "undefined") return "RoT";
  const v = window.localStorage.getItem(ENV_KEY);
  return v === "SANDBOX" ? "SANDBOX" : "RoT";
}

export function OsFooterBar() {
  const [env, setEnv] = useState<OsEnv>(() => getInitialEnv());

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

  const show = env === "SANDBOX";

  const copy = useMemo(() => {
    return {
      title: "SANDBOX ENVIRONMENT",
      sub: "Test artifacts only • Not the system of record",
      right: "Ops Mode • *_sandbox views active",
    };
  }, []);

  if (!show) return null;

  return (
    <div
      className="pointer-events-none fixed bottom-0 left-0 right-0 z-[60] border-t border-[#7a5a1a]/35 bg-gradient-to-r from-[#201607] via-[#2a1e0b] to-[#201607]"
      aria-hidden="true"
    >
      <div className="mx-auto flex max-w-[1500px] items-center justify-between px-6 py-2 text-[11px]">
        <div className="flex items-center gap-3">
          <span className="font-semibold tracking-[0.16em] text-[#f5d47a]">{copy.title}</span>
          <span className="text-white/55">{copy.sub}</span>
        </div>
        <div className="text-white/45">{copy.right}</div>
      </div>
    </div>
  );
}
