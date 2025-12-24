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
    const onEnv = (e: Event) => {
      const anyE = e as any;
      setEnv(((anyE?.detail?.env as OsEnv) ?? getInitialEnv()) as OsEnv);
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener("oasis:env", onEnv as EventListener);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("oasis:env", onEnv as EventListener);
    };
  }, []);

  const meta = useMemo(() => {
    if (env === "SANDBOX") {
      return {
        left: "SANDBOX ENVIRONMENT",
        mid: "Test artifacts only • Not the system of record",
        right: "oasis_os_env = SANDBOX",
        leftClass: "text-[#f5d47a]",
        barClass: "border-[#7a5a1a]/55 bg-[#2a1e0b]/60",
      };
    }
    return {
      left: "SYSTEM OF RECORD",
      mid: "RoT • Production governance ledger",
      right: "oasis_os_env = RoT",
      leftClass: "text-[#92f7c6]",
      barClass: "border-[#1f6f48]/45 bg-[#0b1f14]/55",
    };
  }, [env]);

  return (
    <div className={`h-[44px] w-full border-t ${meta.barClass} backdrop-blur-xl`}>
      <div className="mx-auto flex h-full max-w-[1500px] items-center justify-between px-6 text-[12px]">
        <div className={`font-semibold tracking-[0.18em] ${meta.leftClass}`}>{meta.left}</div>

        <div className="text-white/55">
          <span className="text-white/70">OASIS DIGITAL PARLIAMENT</span>
          <span className="mx-2 text-white/25">•</span>
          <span className="text-[#92f7c6]/70">OPERATIONAL</span>
          <span className="mx-2 text-white/25">•</span>
          <span className="text-[#c9a227]/80">GOVERNANCE FIRMWARE</span>
        </div>

        <div className="text-white/45">{meta.right}</div>
      </div>
    </div>
  );
}
