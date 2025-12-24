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

  const meta = useMemo(() => {
    if (env === "SANDBOX") {
      return {
        ribbonLeft: "SANDBOX ENVIRONMENT",
        ribbonRight: "Test artifacts only • Not the system of record",
        ribbonGlow: "shadow-[0_-10px_36px_rgba(245,212,122,0.10)]",
        envCode: "oasis_os_env = SANDBOX",
      };
    }
    return {
      ribbonLeft: "SYSTEM OF RECORD",
      ribbonRight: "RoT • Production ledger environment",
      ribbonGlow: "shadow-[0_-10px_36px_rgba(146,247,198,0.08)]",
      envCode: "oasis_os_env = RoT",
    };
  }, [env]);

  return (
    <div className="pointer-events-none fixed bottom-0 left-0 right-0 z-[60]">
      {/* Ribbon */}
      <div
        className={[
          "pointer-events-none h-[42px] border-t border-white/5 bg-black/55 backdrop-blur-xl",
          meta.ribbonGlow,
        ].join(" ")}
      >
        <div className="mx-auto grid h-full max-w-[1500px] grid-cols-[1fr_auto_1fr] items-center px-6">
          <div className="text-[11px] tracking-[0.28em] text-[#c9a227]/85">
            {meta.ribbonLeft}
          </div>

          <div className="text-[11px] text-white/55">{meta.ribbonRight}</div>

          <div className="text-right text-[11px] text-white/40">
            {meta.envCode}
          </div>
        </div>
      </div>

      {/* Identity footer (centered, green accent like you wanted) */}
      <div className="pointer-events-none h-[44px] border-t border-white/5 bg-black/45 backdrop-blur-xl">
        <div className="mx-auto grid h-full max-w-[1500px] grid-cols-[1fr_auto_1fr] items-center px-6">
          <div className="text-[11px] tracking-[0.22em] text-white/35">
            OASIS DIGITAL PARLIAMENT
          </div>

          <div className="text-center text-[11px] tracking-[0.20em] text-white/55">
            <span className="text-white/45">OPERATIONAL</span>{" "}
            <span className="text-[#92f7c6]/85">•</span>{" "}
            <span className="text-white/70">GOVERNANCE FIRMWARE</span>{" "}
            <span className="text-[#92f7c6]/85">•</span>{" "}
            <span className="text-[#c9a227]/75">ODP.AI</span>
          </div>

          <div className="text-right text-[11px] tracking-[0.16em] text-white/30">
            {/* keep right side subtle (or leave empty) */}
          </div>
        </div>
      </div>
    </div>
  );
}
