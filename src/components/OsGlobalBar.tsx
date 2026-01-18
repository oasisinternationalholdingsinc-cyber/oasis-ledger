// src/components/OsGlobalBar.tsx
"use client";

/**
 * ✅ APPLE-OS GLOBAL BAR (NO REGRESSION)
 * - Keeps: Entity dropdown, Env dropdown, Clock always visible, Brand left
 * - ✅ Consolidates: Appearance + Sign out inside ONE Operator dropdown (frees space)
 * - ✅ Prevents pill explosion on small widths (Operator becomes compact icon)
 * - ✅ Condensed-on-scroll behavior preserved (threshold 24px)
 * - ✅ No wiring changes: memberships/entities, env storage key, theme provider, auth signout
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import type { EntityKey } from "@/components/OsEntityContext";
import { useOsTheme } from "@/components/OsThemeContext";
import type { OsTheme } from "@/components/OsThemeContext";
import {
  Shield,
  ChevronDown,
  Clock3,
  LogOut,
  Sun,
  Moon,
  Monitor,
  User,
} from "lucide-react";

type OsEnv = "RoT" | "SANDBOX";
const ENV_KEY = "oasis_os_env";

type MembershipRow = {
  entity_id: string | null;
  role?: string | null;
  is_admin?: boolean | null;
};

type EntityRow = {
  id: string;
  slug: string;
  name: string;
};

function cx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function getInitialEnv(): OsEnv {
  if (typeof window === "undefined") return "RoT";
  const v = window.localStorage.getItem(ENV_KEY);
  return v === "SANDBOX" ? "SANDBOX" : "RoT";
}

function setEnv(next: OsEnv) {
  window.localStorage.setItem(ENV_KEY, next);
  window.dispatchEvent(new CustomEvent("oasis:env", { detail: { env: next } }));
}

function useClockLabel24h() {
  const [label, setLabel] = useState<string>("—");

  useEffect(() => {
    const tick = () => {
      try {
        const d = new Date();
        const s = d.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
        setLabel(s);
      } catch {
        setLabel("—");
      }
    };

    tick();
    const t = setInterval(tick, 10_000);
    return () => clearInterval(t);
  }, []);

  return label;
}

export function OsGlobalBar() {
  const { activeEntity, setActiveEntity } = useEntity();
  const { theme, resolved, setTheme } = useOsTheme();

  const [env, setEnvState] = useState<OsEnv>(() => getInitialEnv());
  const [operatorEmail, setOperatorEmail] = useState<string>("—");

  const [entityMenuOpen, setEntityMenuOpen] = useState(false);
  const [envMenuOpen, setEnvMenuOpen] = useState(false);
  const [operatorMenuOpen, setOperatorMenuOpen] = useState(false);

  // ✅ condensed mode on scroll (Apple-style)
  const [condensed, setCondensed] = useState(false);

  const [entityOptions, setEntityOptions] = useState<
    Array<{ key: EntityKey; label: string }>
  >([{ key: "workspace" as EntityKey, label: "Workspace" }]);

  const clock = useClockLabel24h();

  // refs for outside-click closing (no propagation hacks)
  const entityRef = useRef<HTMLDivElement | null>(null);
  const envRef = useRef<HTMLDivElement | null>(null);
  const operatorRef = useRef<HTMLDivElement | null>(null);

  const closeAllMenus = () => {
    setEntityMenuOpen(false);
    setEnvMenuOpen(false);
    setOperatorMenuOpen(false);
  };

  const toggleEntity = () => {
    setEntityMenuOpen((v) => !v);
    setEnvMenuOpen(false);
    setOperatorMenuOpen(false);
  };

  const toggleEnv = () => {
    setEnvMenuOpen((v) => !v);
    setEntityMenuOpen(false);
    setOperatorMenuOpen(false);
  };

  const toggleOperator = () => {
    setOperatorMenuOpen((v) => !v);
    setEntityMenuOpen(false);
    setEnvMenuOpen(false);
  };

  // keep env in sync across tabs + app
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === ENV_KEY) setEnvState(getInitialEnv());
    };
    const onEnv = (e: Event) => {
      const anyE = e as unknown as { detail?: { env?: OsEnv } };
      const next = anyE?.detail?.env ?? getInitialEnv();
      setEnvState(next);
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener("oasis:env", onEnv as EventListener);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("oasis:env", onEnv as EventListener);
    };
  }, []);

  // operator email
  useEffect(() => {
    let mounted = true;
    (async () => {
      const res: any = await (supabase as any).auth.getUser();
      if (!mounted) return;
      setOperatorEmail(res?.data?.user?.email ?? "—");
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // condensed mode on scroll (threshold 24px) — supports both page scroll and workspace scroll
  useEffect(() => {
    const onScroll = () => setCondensed((window.scrollY || 0) > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    const ws = document.querySelector(".os-workspace") as HTMLElement | null;
    const onWs = () => setCondensed((ws?.scrollTop ?? 0) > 24);
    if (ws) ws.addEventListener("scroll", onWs, { passive: true });

    return () => {
      window.removeEventListener("scroll", onScroll as any);
      if (ws) ws.removeEventListener("scroll", onWs as any);
    };
  }, []);

  // close menus on ESC
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeAllMenus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // close menus on outside click
  useEffect(() => {
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node | null;
      if (!t) return;

      const insideEntity = !!entityRef.current?.contains(t);
      const insideEnv = !!envRef.current?.contains(t);
      const insideOperator = !!operatorRef.current?.contains(t);

      if (!insideEntity && !insideEnv && !insideOperator) closeAllMenus();
    };

    window.addEventListener("mousedown", onDown, { passive: true });
    window.addEventListener("touchstart", onDown, { passive: true });

    return () => {
      window.removeEventListener("mousedown", onDown as any);
      window.removeEventListener("touchstart", onDown as any);
    };
  }, []);

  // ✅ entities via memberships -> entities (NO wiring changes)
  useEffect(() => {
    let mounted = true;

    async function loadEntities() {
      const memRes: any = await (supabase as any)
        .from("memberships")
        .select("entity_id, role, is_admin");

      if (!mounted) return;

      const mems = (memRes?.data ?? []) as MembershipRow[];
      if (memRes?.error || !Array.isArray(mems) || mems.length === 0) {
        setEntityOptions([{ key: "workspace" as EntityKey, label: "Workspace" }]);
        return;
      }

      const ids = Array.from(
        new Set(
          mems
            .map((m) => m.entity_id)
            .filter((v): v is string => typeof v === "string" && v.length > 0)
        )
      );

      if (ids.length === 0) {
        setEntityOptions([{ key: "workspace" as EntityKey, label: "Workspace" }]);
        return;
      }

      const entRes: any = await (supabase as any)
        .from("entities")
        .select("id, slug, name")
        .in("id", ids);

      if (!mounted) return;

      const ents = (entRes?.data ?? []) as EntityRow[];
      if (entRes?.error || !Array.isArray(ents) || ents.length === 0) {
        setEntityOptions([{ key: "workspace" as EntityKey, label: "Workspace" }]);
        return;
      }

      const opts = ents
        .filter((e) => e?.slug && e?.name)
        .sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
        )
        .map((e) => ({ key: e.slug as EntityKey, label: e.name }));

      setEntityOptions(
        opts.length ? opts : [{ key: "workspace" as EntityKey, label: "Workspace" }]
      );

      if (!opts.some((o) => o.key === activeEntity) && opts[0]) {
        setActiveEntity(opts[0].key);
      }
    }

    loadEntities();
    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeEntityLabel = useMemo(() => {
    const hit = entityOptions.find((e) => e.key === activeEntity);
    return hit?.label ?? entityOptions[0]?.label ?? "Workspace";
  }, [activeEntity, entityOptions]);

  const envMeta = useMemo(() => {
    if (env === "SANDBOX") {
      return {
        label: "SANDBOX",
        short: "SBX",
        subtitle: "Test artifacts only • Not the system of record",
        pill:
          "bg-[#2a1e0b]/55 border-[#7a5a1a]/50 text-[#f5d47a] hover:bg-[#2a1e0b]/65",
        dot: "bg-[#f5d47a]",
      };
    }
    return {
      label: "RoT",
      short: "RoT",
      subtitle: "System of Record",
      pill:
        "bg-[#0b1f14]/55 border-[#1f6f48]/42 text-[#92f7c6] hover:bg-[#0b1f14]/65",
      dot: "bg-[#92f7c6]",
    };
  }, [env]);

  const themeLabel = useMemo(() => {
    if (theme === "system") return "Auto";
    return theme === "dark" ? "Dark" : "Light";
  }, [theme]);

  const themeIcon = useMemo(() => {
    return theme === "system" ? Monitor : resolved === "dark" ? Moon : Sun;
  }, [theme, resolved]);

  const onSignOut = async () => {
    await (supabase as any).auth.signOut();
    window.location.href = "/login";
  };

  // ✅ styling: keep existing global bar class names (globals.css controls layout + light mode clarity)
  const barClass = cx(
    "os-global-bar",
    condensed && "h-[56px] py-0",
    // keep bar clickable while clock remains pointer-events-none via CSS classes
    "select-none"
  );

  // shared dropdown surface (matches glass in dark, paper in light through globals.css tokens)
  const menuShell = cx(
    "absolute right-0 mt-2 w-[320px] p-2",
    "rounded-2xl border border-white/10 bg-black/85 shadow-[0_14px_50px_rgba(0,0,0,0.62)] backdrop-blur-xl z-[80]"
  );

  const menuHeader = "px-3 py-2 text-[11px] text-white/55";
  const menuItem = (active?: boolean) =>
    cx(
      "flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-[13px] transition",
      active ? "bg-white/10 text-white" : "hover:bg-white/5 text-white/85"
    );

  const pillBase = cx(
    "flex items-center gap-2 rounded-full border border-white/10 bg-black/20 text-[12px] text-white/90",
    "shadow-[0_0_18px_rgba(0,0,0,0.20)] hover:bg-white/5 transition",
    condensed ? "px-2.5 py-1.5" : "px-3 py-2"
  );

  return (
    <div className="sticky top-0 z-[50]">
      <div className={barClass}>
        {/* LEFT: Brand (never collapses) */}
        <div className="os-brand">
          <div className="flex items-center gap-10">
            <div className="flex items-center gap-3">
              <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#c9a227]/45 bg-black/20 shadow-[0_0_24px_rgba(201,162,39,0.16)]">
                <Shield className="h-4.5 w-4.5 text-[#d6b24a]" />
              </div>

              <div className="leading-tight min-w-0">
                <div className="os-brand-title truncate">OASIS DIGITAL PARLIAMENT</div>
                <div className="os-brand-sub truncate">Authority Console OS</div>
              </div>
            </div>
          </div>
        </div>

        {/* CENTER: Clock (always visible; global CSS ensures it never collides) */}
        <div className="os-global-center">
          <div className="os-clock-wrap">
            <div className="os-clock-label">TIME</div>
            <div className="os-clock-value">
              <span className="inline-flex items-center gap-2">
                <Clock3 className="h-4 w-4 text-[#c9a227]/85" />
                {clock}
              </span>
            </div>
          </div>
        </div>

        {/* RIGHT: Entity + Env + Operator dropdown (Appearance + Sign out inside) */}
        <div className="os-global-right">
          {/* Entity */}
          <div className="relative" ref={entityRef}>
            <button
              className={pillBase}
              onClick={toggleEntity}
              title="Switch entity"
            >
              <span className="hidden sm:inline text-white/55">Entity</span>
              <span className="hidden sm:inline h-1 w-1 rounded-full bg-white/25" />
              <span className="min-w-0 max-w-[200px] truncate text-white/95">
                {activeEntityLabel}
              </span>
              <ChevronDown className="h-4 w-4 shrink-0 text-white/55" />
            </button>

            {entityMenuOpen && (
              <div className={menuShell}>
                <div className={menuHeader}>Switch entity</div>
                {entityOptions.map((opt) => {
                  const selected = opt.key === activeEntity;
                  return (
                    <button
                      key={String(opt.key)}
                      className={menuItem(selected)}
                      onClick={() => {
                        setActiveEntity(opt.key);
                        setEntityMenuOpen(false);
                      }}
                    >
                      <span className="truncate pr-4">{opt.label}</span>
                      {selected && (
                        <span className="text-[11px] text-[#c9a227]/90">
                          Active
                        </span>
                      )}
                    </button>
                  );
                })}
                <div className="mt-2 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-[11px] text-white/55">
                  Entities are derived from your{" "}
                  <span className="text-white/80">memberships</span>.
                </div>
              </div>
            )}
          </div>

          {/* Env */}
          <div className="relative" ref={envRef}>
            <button
              className={cx(
                "flex items-center gap-2 rounded-full border text-[12px] transition",
                condensed ? "px-2.5 py-1.5" : "px-3 py-2",
                envMeta.pill
              )}
              onClick={toggleEnv}
              title={envMeta.subtitle}
            >
              <span className={cx("h-2 w-2 rounded-full", envMeta.dot)} />
              <span className="font-semibold tracking-wide">
                <span className="sm:hidden">{envMeta.short}</span>
                <span className="hidden sm:inline">{envMeta.label}</span>
              </span>
              <ChevronDown className="h-4 w-4 shrink-0 text-white/60" />
            </button>

            {envMenuOpen && (
              <div className={menuShell}>
                <div className={menuHeader}>Switch environment</div>

                <button
                  className={menuItem(env === "RoT")}
                  onClick={() => {
                    setEnv("RoT");
                    setEnvState("RoT");
                    setEnvMenuOpen(false);
                  }}
                >
                  <span className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-[#92f7c6]" />
                    RoT
                  </span>
                  <span className="text-[11px] text-white/45">
                    System of Record
                  </span>
                </button>

                <button
                  className={cx(
                    "mt-1",
                    menuItem(env === "SANDBOX"),
                    env === "SANDBOX" && "bg-[#2a1e0b]/60 text-[#f5d47a]"
                  )}
                  onClick={() => {
                    setEnv("SANDBOX");
                    setEnvState("SANDBOX");
                    setEnvMenuOpen(false);
                  }}
                >
                  <span className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-[#f5d47a]" />
                    SANDBOX
                  </span>
                  <span className="text-[11px] text-white/45">
                    Test artifacts only
                  </span>
                </button>

                <div className="mt-2 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-[11px] text-white/55">
                  Stored in{" "}
                  <span className="text-white/80">localStorage</span> as{" "}
                  <span className="text-white/80">oasis_os_env</span>.
                </div>
              </div>
            )}
          </div>

          {/* Operator dropdown (✅ contains Appearance + Sign out) */}
          <div className="relative" ref={operatorRef}>
            <button
              className={pillBase}
              onClick={toggleOperator}
              title="Operator menu"
            >
              {/* compact on mobile */}
              <User className="h-4 w-4 text-white/70" />
              <span className="hidden md:inline text-white/70">Operator</span>
              <span className="hidden md:inline h-1 w-1 rounded-full bg-white/25" />
              <span className="hidden md:inline min-w-0 max-w-[220px] truncate text-white/90">
                {operatorEmail}
              </span>
              <ChevronDown className="h-4 w-4 shrink-0 text-white/55" />
            </button>

            {operatorMenuOpen && (
              <div className={menuShell}>
                <div className={menuHeader}>Operator</div>

                {/* Email row */}
                <div className="px-3 py-2 text-[12px] text-white/80">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-white/55">Signed in</span>
                    <span className="min-w-0 truncate text-white/90">
                      {operatorEmail}
                    </span>
                  </div>
                </div>

                <div className="my-2 h-px bg-white/10" />

                {/* Appearance */}
                <div className="px-3 py-2 text-[11px] text-white/55">
                  Appearance
                </div>

                {(
                  [
                    { key: "system", label: "System (Auto)", Icon: Monitor, hint: "Follows OS" },
                    { key: "dark", label: "Dark", Icon: Moon, hint: "Low-glare" },
                    { key: "light", label: "Light", Icon: Sun, hint: "Parchment" },
                  ] as Array<{
                    key: OsTheme;
                    label: string;
                    Icon: any;
                    hint: string;
                  }>
                ).map((opt) => {
                  const selected = theme === opt.key;
                  return (
                    <button
                      key={opt.key}
                      className={menuItem(selected)}
                      onClick={() => {
                        setTheme(opt.key);
                        // keep menu open (Apple-like) so user can continue; feel free to close if you prefer
                      }}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <opt.Icon className="h-4 w-4 text-[#c9a227]/80" />
                        <span className="truncate">{opt.label}</span>
                      </span>
                      <span className="text-[11px] text-white/45">
                        {selected ? `Active • ${themeLabel}` : opt.hint}
                      </span>
                    </button>
                  );
                })}

                <div className="mt-2 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-[11px] text-white/55">
                  Current resolved theme:{" "}
                  <span className="text-white/80">{resolved}</span>.
                </div>

                <div className="my-2 h-px bg-white/10" />

                {/* Sign out (only here) */}
                <button
                  className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-[13px] text-white/90 hover:bg-white/5"
                  onClick={async () => {
                    setOperatorMenuOpen(false);
                    await onSignOut();
                  }}
                >
                  <span className="flex items-center gap-2">
                    <LogOut className="h-4 w-4 text-white/65" />
                    Sign out
                  </span>
                  <span className="text-[11px] text-white/45">End session</span>
                </button>

                <div className="mt-2 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-[11px] text-white/55">
                  This menu consolidates controls to keep the bar calm and clock-visible.
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default OsGlobalBar;
