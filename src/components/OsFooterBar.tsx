// src/components/OsFooterBar.tsx
"use client";

import { useEffect, useState } from "react";

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

  // Footer base (always)
  return (
    <div className="relative">
      {/* ✅ SANDBOX ribbon at footer only (non-blocking) */}
      {env === "SANDBOX" && (
        <div
          className="fixed bottom-[38px] left-0 right-0 z-[40] border-t border-[#7a5a1a]/35 bg-gradient-to-r from-[#201607] via-[#2a1e0b] to-[#201607]"
          style={{ pointerEvents: "none" }}
        >
          <div className="mx-auto flex max-w-[1500px] items-center justify-between px-6 py-2 text-[11px]">
            <div className="flex items-center gap-3">
              <span className="font-semibold tracking-[0.16em] text-[#f5d47a]">
                SANDBOX ENVIRONMENT
              </span>
              <span className="text-white/55">
                Test artifacts only • Not the system of record
              </span>
            </div>
            <div className="text-white/45">Modules select *_sandbox views</div>
          </div>
        </div>
      )}

      {/* OS footer strip */}
      <div className="fixed bottom-0 left-0 right-0 z-[35] border-t border-white/5 bg-black/55 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between px-6 py-2 text-[11px] text-white/55">
          <div>
            OASIS DIGITAL PARLIAMENT • <span className="text-white/70">GOVERNANCE FIRMWARE</span>
          </div>
          <div className="text-white/40">ODP.AI</div>
        </div>
      </div>
    </div>
  );
}
