"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

/**
 * Execution environment (NOT an entity)
 */
export type OsEnv = "ROT" | "SANDBOX";

export type OsEnvContextValue = {
  /** Canonical environment */
  env: OsEnv;
  setEnv: (v: OsEnv) => void;

  /** Convenience */
  isSandbox: boolean;
};

const DEFAULT_ENV: OsEnv = "ROT";
const STORAGE_KEY = "oasis_os_env";

const OsEnvContext = createContext<OsEnvContextValue | null>(null);

export function OsEnvProvider({ children }: { children: React.ReactNode }) {
  const [env, setEnvState] = useState<OsEnv>(DEFAULT_ENV);

  // hydrate once (mirror OsEntityContext behavior)
  useEffect(() => {
    try {
      const saved = (localStorage.getItem(STORAGE_KEY) || "").toUpperCase();
      if (saved === "ROT" || saved === "SANDBOX") {
        setEnvState(saved);
      }
    } catch {}
  }, []);

  const setEnv = (v: OsEnv) => {
    setEnvState(v);
    try {
      localStorage.setItem(STORAGE_KEY, v);
    } catch {}
  };

  const value = useMemo<OsEnvContextValue>(
    () => ({
      env,
      setEnv,
      isSandbox: env === "SANDBOX",
    }),
    [env]
  );

  return <OsEnvContext.Provider value={value}>{children}</OsEnvContext.Provider>;
}

/**
 * Primary hook
 */
export function useOsEnv() {
  const ctx = useContext(OsEnvContext);
  if (!ctx) {
    throw new Error("useOsEnv must be used within OsEnvProvider");
  }
  return ctx;
}

/**
 * Backwards-compatible alias (future-proofing)
 */
export const useEnv = useOsEnv;
