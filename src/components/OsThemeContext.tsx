"use client";

import React, { createContext, useContext, useEffect, useMemo, useState } from "react";

export type OsTheme = "system" | "dark" | "light";
export type ResolvedTheme = "dark" | "light";

const THEME_KEY = "oasis_os_theme";

type OsThemeCtx = {
  theme: OsTheme;
  resolved: ResolvedTheme;
  setTheme: (t: OsTheme) => void;
};

const Ctx = createContext<OsThemeCtx | null>(null);

function readStoredTheme(): OsTheme {
  if (typeof window === "undefined") return "system";
  const v = window.localStorage.getItem(THEME_KEY);
  return v === "dark" || v === "light" || v === "system" ? v : "system";
}

function resolveTheme(t: OsTheme): ResolvedTheme {
  if (t === "dark") return "dark";
  if (t === "light") return "light";
  if (typeof window === "undefined") return "dark";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(resolved: ResolvedTheme) {
  if (typeof document === "undefined") return;

  // 1) Global surface (useful if you later theme generic tokens)
  document.documentElement.dataset.theme = resolved;

  // 2) OS shell surface (matches your Oasis OS selectors)
  const root = document.querySelector(".os-root") as HTMLElement | null;
  if (root) root.dataset.theme = resolved;
}

export function OsThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<OsTheme>(() => readStoredTheme());
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(readStoredTheme()));

  // Apply on mount + whenever theme changes
  useEffect(() => {
    const nextResolved = resolveTheme(theme);
    setResolved(nextResolved);
    applyTheme(nextResolved);

    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      // ignore
    }
  }, [theme]);

  // If theme=system, react to OS changes live
  useEffect(() => {
    if (theme !== "system") return;

    const mql = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mql) return;

    const onChange = () => {
      const nextResolved: ResolvedTheme = mql.matches ? "dark" : "light";
      setResolved(nextResolved);
      applyTheme(nextResolved);
    };

    onChange();

    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    } else {
      // Safari fallback
      // @ts-ignore
      mql.addListener(onChange);
      // @ts-ignore
      return () => mql.removeListener(onChange);
    }
  }, [theme]);

  // Ensure theme is applied after first paint even if .os-root mounts later
  useEffect(() => {
    const id = window.setTimeout(() => applyTheme(resolved), 0);
    return () => window.clearTimeout(id);
  }, [resolved]);

  const value = useMemo<OsThemeCtx>(
    () => ({
      theme,
      resolved,
      setTheme: setThemeState,
    }),
    [theme, resolved]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useOsTheme() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useOsTheme must be used within OsThemeProvider");
  return v;
}
