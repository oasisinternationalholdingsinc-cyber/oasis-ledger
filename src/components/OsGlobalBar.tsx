// src/components/OsGlobalBar.tsx
"use client";

/**
 * ✅ FINAL • NO REGRESSIONS (dark untouched; glass preserved)
 * ✅ TIME PILL ALWAYS CENTERED (absolute-center, never pushed by right controls)
 * ✅ OPERATOR MENU OWNS: Entity + Env (RoT/SANDBOX) + Appearance + Sign out
 * ✅ iPhone-first: header stays clean; Operator pill is the only right control
 * ✅ Cross-tab env sync via localStorage + custom oasis:env event
 */

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import type { EntityKey } from "@/components/OsEntityContext";
import { useOsTheme } from "@/components/OsThemeContext";
import type { OsTheme } from "@/components/OsThemeContext";
import {
  Shield,
  ChevronDown,
  LogOut,
  Clock3,
  Sun,
  Moon,
  Monitor,
  User,
  Check,
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

function emailToHandle(email: string) {
  const e = (email || "").trim();
  if (!e || e === "—") return "—";
  const at = e.indexOf("@");
  const base = at > 0 ? e.slice(0, at) : e;
  // light cleanup
  return base.replace(/\.+/g, ".").replace(/[_-]+/g, "-");
}

export function OsGlobalBar() {
  const { activeEntity, setActiveEntity } = useEntity();
  const { theme, resolved, setTheme } = useOsTheme();

  const [env, setEnvState] = useState<OsEnv>(() => getInitialEnv());
  const [operatorEmail, setOperatorEmail] = useState<string>("—");

  const [operatorMenuOpen, setOperatorMenuOpen] = useState(false);
  const [condensed, setCondensed] = useState(false);

  const [entityOptions, setEntityOptions] = useState<
    Array<{ key: EntityKey; label: string }>
  >([{ key: "workspace" as EntityKey, label: "Workspace" }]);

  const clock = useClockLabel24h();

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

  // operator identity
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
    const onScroll = () => {
      const y = window.scrollY || 0;
      setCondensed(y > 24);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    const ws = document.querySelector(".os-workspace");
    const onWs = () => {
      const y = (ws as HTMLElement | null)?.scrollTop ?? 0;
      setCondensed(y > 24);
    };
    if (ws) ws.addEventListener("scroll", onWs, { passive: true });

    return () => {
      window.removeEventListener("scroll", onScroll as any);
      if (ws) ws.removeEventListener("scroll", onWs as any);
    };
  }, []);

  // close menu on ESC
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOperatorMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ✅ real entities for signed-in user (via memberships -> entities)
  useEffect(() => {
    let mounted = true;

    async function loadEntities() {
      const memRes: any = await (supabase as any)
        .from("memberships")
        .select("entity_id, role, is_admin");

      if (!mounted) return;

      const memErr = memRes?.error as unknown;
      const mems = (memRes?.data ?? []) as MembershipRow[];

      if (memErr || !Array.isArray(mems) || mems.length === 0) {
        setEntityOptions([{ key: "workspace" as EntityKey, label: "Workspace" }]);
        return;
      }

      const ids = Array.from(
        new Set(
          mems
            .map((m: MembershipRow) => m.entity_id)
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

      const entErr = entRes?.error as unknown;
      const ents = (entRes?.data ?? []) as EntityRow[];

      if (entErr || !Array.isArray(ents) || ents.length === 0) {
        setEntityOptions([{ key: "workspace" as EntityKey, label: "Workspace" }]);
        return;
      }

      const opts = ents
        .filter((e: EntityRow) => e?.slug && e?.name)
        .sort((a: EntityRow, b: EntityRow) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
        )
        .map((e: EntityRow) => ({
          key: e.slug as EntityKey,
          label: e.name,
        }));

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

  const operatorHandle = useMemo(() => emailToHandle(operatorEmail), [operatorEmail]);

  const envMeta = useMemo(() => {
    if (env === "SANDBOX") {
      return {
        label: "SANDBOX",
        subtitle: "Test lane • Not system of record",
        pillClass:
          "bg-[#2a1e0b]/55 border-[#7a5a1a]/50 text-[#f5d47a] shadow-[0_0_26px_rgba(245,212,122,0.10)] hover:shadow-[0_0_32px_rgba(245,212,122,0.14)]",
        dotClass: "bg-[#f5d47a]",
      };
    }
    return {
      label: "RoT",
      subtitle: "System of Record",
      pillClass:
        "bg-[#0b1f14]/55 border-[#1f6f48]/42 text-[#92f7c6] shadow-[0_0_22px_rgba(146,247,198,0.10)] hover:shadow-[0_0_28px_rgba(146,247,198,0.14)]",
      dotClass: "bg-[#92f7c6]",
    };
  }, [env]);

  const themeMeta = useMemo(() => {
    const Icon = theme === "system" ? Monitor : resolved === "dark" ? Moon : Sun;
    const label = theme === "system" ? "Auto" : resolved === "dark" ? "Dark" : "Light";
    return { Icon, label };
  }, [theme, resolved]);

  const onSignOut = async () => {
    await (supabase as any).auth.signOut();
    window.location.href = "/login";
  };

  // Shell stays identical (dark glass); light-mode crisp is handled by your globals tokens
  const shell = cx(
    "border-b border-white/10 backdrop-blur-xl",
    "bg-gradient-to-b from-amber-200/[0.07] via-black/40 to-black/20",
    "shadow-[0_18px_80px_rgba(0,0,0,0.45)]"
  );

  const barH = condensed ? "h-[56px]" : "h-[64px]";
  const innerPad = condensed ? "px-3 sm:px-5" : "px-4 sm:px-6";
  const inner = cx("relative mx-auto flex h-full max-w-[1500px] items-center", innerPad);

  const dropdownShell =
    "rounded-2xl border border-white/10 bg-black/85 shadow-[0_14px_50px_rgba(0,0,0,0.62)] backdrop-blur-xl z-[80]";
  const dropdownHeader = "px-3 py-2 text-[11px] text-white/55";
  const dropdownFootnote =
    "mt-2 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-[11px] text-white/55";

  const pillBase = condensed ? "px-2.5 py-1.5" : "px-3 py-2";
  const pillBaseSm = condensed ? "sm:px-3 sm:py-2" : "sm:px-4 sm:py-2";

  const closeMenu = () => setOperatorMenuOpen(false);

  // close on outside click
  useEffect(() => {
    const onClick = () => closeMenu();
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="sticky top-0 z-[50]">
      <div className={cx("relative w-full transition-[height] duration-200", barH, shell)}>
        {/* subtle gold authority line */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[1px] bg-gradient-to-r from-transparent via-[#c9a227]/35 to-transparent" />

        <div className={inner}>
          {/* LEFT */}
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#c9a227]/45 bg-black/20 shadow-[0_0_24px_rgba(201,162,39,0.16)]">
              <Shield className="h-4.5 w-4.5 text-[#d6b24a]" />
              <span className="pointer-events-none absolute -inset-1 rounded-full bg-[#c9a227]/10 blur-md" />
            </div>

            <div className="min-w-0 leading-tight">
              <div className="truncate text-[10px] tracking-[0.28em] uppercase text-white/55">
                OASIS DIGITAL PARLIAMENT
              </div>
              <div className="truncate text-[13px] font-medium text-white/90">
                Authority Console <span className="text-[#c9a227]/85">OS</span>
              </div>
            </div>
          </div>

          {/* CENTER CLOCK — ALWAYS CENTERED (independent of right controls) */}
          <div className="pointer-events-none absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 items-center justify-center sm:flex">
            <div
              className={cx(
                "flex items-center gap-2 rounded-full border border-white/10 bg-black/20 text-[12px] text-white/90 shadow-[0_0_26px_rgba(201,162,39,0.10)] transition-all duration-200",
                condensed ? "px-3 py-1.5" : "px-4 py-2"
              )}
            >
              <Clock3 className="h-4 w-4 text-[#c9a227]/85" />
              <span className="min-w-[72px] text-center tracking-[0.20em]">{clock}</span>
              <span className="ml-1 h-1.5 w-1.5 rounded-full bg-[#c9a227]/85 shadow-[0_0_12px_rgba(201,162,39,0.55)]" />
            </div>
          </div>

          {/* RIGHT — Operator only (Entity+Env live inside) */}
          <div className="flex shrink-0 items-center justify-end">
            <div className="relative" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => setOperatorMenuOpen((v) => !v)}
                className={cx(
                  "flex min-w-0 items-center gap-2 rounded-full border border-white/10 bg-black/20 text-[12px] text-white/90 shadow-[0_0_18px_rgba(0,0,0,0.20)] hover:bg-white/5 transition",
                  pillBase,
                  pillBaseSm
                )}
                title="Operator menu"
              >
                <User className="h-4 w-4 shrink-0 text-white/70" />
                <span className="hidden sm:inline text-white/70">Operator</span>
                <span className="hidden h-1 w-1 shrink-0 rounded-full bg-white/25 sm:inline" />
                <span className="min-w-0 max-w-[220px] truncate font-semibold tracking-wide text-white/95">
                  {operatorHandle}
                </span>
                <ChevronDown className="h-4 w-4 shrink-0 text-white/55" />
              </button>

              {operatorMenuOpen && (
                <div className={cx("absolute right-0 mt-2 w-[340px] p-2 sm:w-[380px]", dropdownShell)}>
                  <div className={dropdownHeader}>Operator</div>

                  {/* Mobile clock appears inside menu */}
                  <div className="sm:hidden rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-[12px] text-white/85">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-2 text-white/60">
                        <Clock3 className="h-4 w-4 text-[#c9a227]/85" />
                        Time
                      </span>
                      <span className="font-mono tracking-[0.20em] text-white/90">{clock}</span>
                    </div>
                  </div>

                  {/* Identity */}
                  <div className="mt-2 rounded-xl border border-white/10 bg-black/40 px-3 py-2">
                    <div className="flex items-center justify-between text-[12px]">
                      <span className="text-white/60">Operator</span>
                      <span className="max-w-[220px] truncate text-white/92">{operatorHandle}</span>
                    </div>
                    <div className="mt-1 text-[11px] text-white/45 truncate">{operatorEmail}</div>
                  </div>

                  {/* Env (moved under operator) */}
                  <div className="mt-2">
                    <div className="px-3 py-2 text-[11px] text-white/55">Environment</div>

                    <div className="flex gap-2 px-2">
                      <button
                        onClick={() => {
                          setEnv("RoT");
                          setEnvState("RoT");
                        }}
                        className={cx(
                          "flex flex-1 items-center justify-between rounded-xl px-3 py-2 text-[13px] transition border",
                          env === "RoT"
                            ? "bg-white/10 text-white border-white/10"
                            : "hover:bg-white/5 text-white/85 border-white/10"
                        )}
                      >
                        <span className="flex items-center gap-2">
                          <span className="h-2 w-2 rounded-full bg-[#92f7c6]" />
                          RoT
                        </span>
                        {env === "RoT" ? <Check className="h-4 w-4 text-white/70" /> : null}
                      </button>

                      <button
                        onClick={() => {
                          setEnv("SANDBOX");
                          setEnvState("SANDBOX");
                        }}
                        className={cx(
                          "flex flex-1 items-center justify-between rounded-xl px-3 py-2 text-[13px] transition border",
                          env === "SANDBOX"
                            ? "bg-[#2a1e0b]/60 text-[#f5d47a] border-[#7a5a1a]/50"
                            : "hover:bg-white/5 text-white/85 border-white/10"
                        )}
                      >
                        <span className="flex items-center gap-2">
                          <span className="h-2 w-2 rounded-full bg-[#f5d47a]" />
                          SANDBOX
                        </span>
                        {env === "SANDBOX" ? (
                          <Check className="h-4 w-4 text-[#f5d47a]" />
                        ) : null}
                      </button>
                    </div>

                    <div className="px-3 pt-2 text-[11px] text-white/45">{envMeta.subtitle}</div>
                  </div>

                  {/* Entity (moved under operator) */}
                  <div className="mt-2">
                    <div className="px-3 py-2 text-[11px] text-white/55">Entity</div>

                    <div className="max-h-[240px] overflow-auto rounded-xl border border-white/10 bg-black/40 p-1">
                      {entityOptions.map((opt) => {
                        const selected = opt.key === activeEntity;
                        return (
                          <button
                            key={String(opt.key)}
                            onClick={() => setActiveEntity(opt.key)}
                            className={cx(
                              "flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-[13px] transition",
                              selected ? "bg-white/10 text-white" : "hover:bg-white/5 text-white/85"
                            )}
                          >
                            <span className="truncate pr-4">{opt.label}</span>
                            {selected ? (
                              <span className="text-[11px] text-[#c9a227]/90">Active</span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Appearance */}
                  <div className="mt-2">
                    <div className="px-3 py-2 text-[11px] text-white/55">Appearance</div>

                    {(
                      [
                        { key: "system", label: "System (Auto)", Icon: Monitor, hint: "Follows OS" },
                        { key: "dark", label: "Dark", Icon: Moon, hint: "Low-glare" },
                        { key: "light", label: "Light", Icon: Sun, hint: "Parchment" },
                      ] as Array<{ key: OsTheme; label: string; Icon: any; hint: string }>
                    ).map((opt) => {
                      const selected = theme === opt.key;
                      return (
                        <button
                          key={opt.key}
                          onClick={() => setTheme(opt.key)}
                          className={cx(
                            "flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-[13px] transition",
                            selected ? "bg-white/10 text-white" : "hover:bg-white/5 text-white/85"
                          )}
                        >
                          <span className="flex items-center gap-2 min-w-0">
                            <opt.Icon className="h-4 w-4 text-[#c9a227]/80" />
                            <span className="truncate">{opt.label}</span>
                          </span>
                          <span className="text-[11px] text-white/45">{opt.hint}</span>
                        </button>
                      );
                    })}

                    <div className="px-3 pt-2 text-[11px] text-white/45">
                      Resolved: <span className="text-white/70">{resolved}</span> • Mode:{" "}
                      <span className="text-white/70">{themeMeta.label}</span>
                    </div>
                  </div>

                  {/* Sign out */}
                  <div className="mt-3">
                    <button
                      onClick={async () => {
                        closeMenu();
                        await onSignOut();
                      }}
                      className="flex w-full items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-left text-[13px] text-white/90 hover:bg-white/10"
                    >
                      <span className="flex items-center gap-2">
                        <LogOut className="h-4 w-4 text-white/65" />
                        Sign out
                      </span>
                      <span className="text-[11px] text-white/45">End session</span>
                    </button>
                  </div>

                  <div className={dropdownFootnote}>
                    Operator menu owns Entity + Env to keep the header clean and keep the time pill
                    perfectly centered.
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default OsGlobalBar;
