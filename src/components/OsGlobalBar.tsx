// src/components/OsGlobalBar.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import type { EntityKey } from "@/components/OsEntityContext";
import { Shield, ChevronDown, LogOut, Clock3 } from "lucide-react";

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

  const [env, setEnvState] = useState<OsEnv>(() => getInitialEnv());
  const [operatorEmail, setOperatorEmail] = useState<string>("—");

  const [envMenuOpen, setEnvMenuOpen] = useState(false);
  const [entityMenuOpen, setEntityMenuOpen] = useState(false);

  // ✅ condensed mode on scroll (Apple-style). UI-only.
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

  // operator pill
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

  // condensed mode on scroll (threshold 24px)
  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY || 0;
      setCondensed(y > 24);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll as any);
  }, []);

  // close menus on outside click / ESC
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setEnvMenuOpen(false);
        setEntityMenuOpen(false);
      }
    };
    const onClick = () => {
      setEnvMenuOpen(false);
      setEntityMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onClick);
    };
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

  // ✅ env styling (single indicator only — the env pill; no duplicates)
  const envMeta = useMemo(() => {
    if (env === "SANDBOX") {
      return {
        label: "SANDBOX",
        subtitle: "Test artifacts only • Not the system of record",
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

  const activeEntityLabel = useMemo(() => {
    const hit = entityOptions.find((e) => e.key === activeEntity);
    return hit?.label ?? entityOptions[0]?.label ?? "Workspace";
  }, [activeEntity, entityOptions]);

  const onSignOut = async () => {
    await (supabase as any).auth.signOut();
    window.location.href = "/login";
  };

  // Gold-glass OS shell (lighter than black slab)
  const shell = cx(
    "border-b border-white/10 backdrop-blur-xl",
    "bg-gradient-to-b from-amber-200/[0.07] via-black/40 to-black/20",
    "shadow-[0_18px_80px_rgba(0,0,0,0.45)]"
  );

  const barH = condensed ? "h-[56px]" : "h-[64px]";
  const innerPad = condensed ? "px-3 sm:px-5" : "px-4 sm:px-6";

  const inner = cx(
    "mx-auto flex h-full max-w-[1500px] items-center",
    innerPad
  );

  const dropdownShell =
    "rounded-2xl border border-white/10 bg-black/85 shadow-[0_14px_50px_rgba(0,0,0,0.62)] backdrop-blur-xl z-[80]";
  const dropdownHeader = "px-3 py-2 text-[11px] text-white/55";
  const dropdownFootnote =
    "mt-2 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-[11px] text-white/55";

  // pill sizing (condensed saves room)
  const pillBase = condensed ? "px-2.5 py-1.5" : "px-3 py-2";
  const pillBaseSm = condensed ? "sm:px-3 sm:py-2" : "sm:px-4 sm:py-2";

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

            {/* Operator pill (hidden in condensed mode to save space) */}
            <div
              className={cx(
                "ml-3 hidden min-w-0 items-center gap-2 rounded-full border border-white/10 bg-black/20 text-[12px] text-white/75 shadow-[0_0_18px_rgba(0,0,0,0.20)] lg:flex",
                condensed ? "opacity-0 pointer-events-none w-0 px-0" : "px-3 py-2"
              )}
            >
              <span className="shrink-0 text-white/50">Operator</span>
              <span className="h-1 w-1 shrink-0 rounded-full bg-white/25" />
              <span className="min-w-0 max-w-[220px] truncate text-white/90">
                {operatorEmail}
              </span>
            </div>
          </div>

          {/* CENTER clock */}
          <div className="pointer-events-none absolute left-1/2 hidden -translate-x-1/2 items-center justify-center sm:flex">
            <div
              className={cx(
                "flex items-center gap-2 rounded-full border border-white/10 bg-black/20 text-[12px] text-white/90 shadow-[0_0_26px_rgba(201,162,39,0.10)] transition-all duration-200",
                condensed ? "px-3 py-1.5" : "px-4 py-2"
              )}
            >
              <Clock3 className="h-4 w-4 text-[#c9a227]/85" />
              <span className="min-w-[72px] text-center tracking-[0.20em]">
                {clock}
              </span>
              <span className="ml-1 h-1.5 w-1.5 rounded-full bg-[#c9a227]/85 shadow-[0_0_12px_rgba(201,162,39,0.55)]" />
            </div>
          </div>

          {/* RIGHT */}
          <div className="flex shrink-0 items-center justify-end gap-2 sm:gap-3">
            {/* Entity dropdown */}
            <div className="relative" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => {
                  setEntityMenuOpen((v) => !v);
                  setEnvMenuOpen(false);
                }}
                className={cx(
                  "flex min-w-0 items-center gap-2 rounded-full border border-white/10 bg-black/20 text-[12px] text-white/90 shadow-[0_0_18px_rgba(0,0,0,0.20)] hover:bg-white/5 transition",
                  pillBase,
                  pillBaseSm
                )}
                title="Switch entity"
              >
                <span className="hidden shrink-0 text-white/55 sm:inline">
                  Entity
                </span>
                <span className="hidden h-1 w-1 shrink-0 rounded-full bg-white/25 sm:inline" />
                <span className="min-w-0 max-w-[140px] truncate text-white/95 sm:max-w-[220px] md:max-w-[260px]">
                  {activeEntityLabel}
                </span>
                <ChevronDown className="h-4 w-4 shrink-0 text-white/55" />
              </button>

              {entityMenuOpen && (
                <div
                  className={cx(
                    "absolute right-0 mt-2 w-[320px] p-2 sm:w-[360px]",
                    dropdownShell
                  )}
                >
                  <div className={dropdownHeader}>Switch entity</div>

                  {entityOptions.map((opt) => {
                    const selected = opt.key === activeEntity;
                    return (
                      <button
                        key={String(opt.key)}
                        onClick={() => {
                          setActiveEntity(opt.key);
                          setEntityMenuOpen(false);
                        }}
                        className={cx(
                          "flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-[13px] transition",
                          selected
                            ? "bg-white/10 text-white"
                            : "hover:bg-white/5 text-white/85"
                        )}
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

                  <div className={dropdownFootnote}>
                    Entities shown are derived from your{" "}
                    <span className="text-white/80">memberships</span> and{" "}
                    <span className="text-white/80">entities</span> tables.
                  </div>
                </div>
              )}
            </div>

            {/* Env dropdown (single lane indicator; no duplicate env badge elsewhere) */}
            <div className="relative" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => {
                  setEnvMenuOpen((v) => !v);
                  setEntityMenuOpen(false);
                }}
                className={cx(
                  "flex items-center gap-2 rounded-full border text-[12px] transition",
                  pillBase,
                  pillBaseSm,
                  envMeta.pillClass
                )}
                title={envMeta.subtitle}
              >
                <span
                  className={cx("h-2 w-2 shrink-0 rounded-full", envMeta.dotClass)}
                />
                <span className="font-semibold tracking-wide">
                  {condensed && envMeta.label === "SANDBOX" ? "SBX" : envMeta.label}
                </span>
                <ChevronDown className="h-4 w-4 shrink-0 text-white/60" />
              </button>

              {envMenuOpen && (
                <div className={cx("absolute right-0 mt-2 w-[320px] p-2", dropdownShell)}>
                  <div className={dropdownHeader}>Switch environment</div>

                  <button
                    onClick={() => {
                      setEnv("RoT");
                      setEnvState("RoT");
                      setEnvMenuOpen(false);
                    }}
                    className={cx(
                      "flex w-full items-center justify-between rounded-xl px-3 py-2 text-[13px]",
                      env === "RoT"
                        ? "bg-white/10 text-white"
                        : "hover:bg-white/5 text-white/85"
                    )}
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
                    onClick={() => {
                      setEnv("SANDBOX");
                      setEnvState("SANDBOX");
                      setEnvMenuOpen(false);
                    }}
                    className={cx(
                      "mt-1 flex w-full items-center justify-between rounded-xl px-3 py-2 text-[13px]",
                      env === "SANDBOX"
                        ? "bg-[#2a1e0b]/60 text-[#f5d47a]"
                        : "hover:bg-white/5 text-white/85"
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-[#f5d47a]" />
                      SANDBOX
                    </span>
                    <span className="text-[11px] text-white/45">
                      Test artifacts only
                    </span>
                  </button>

                  <div className={dropdownFootnote}>
                    Modules read{" "}
                    <span className="text-white/80">oasis_os_env</span> to select{" "}
                    <span className="text-white/80">*_rot</span> vs{" "}
                    <span className="text-white/80">*_sandbox</span>.
                  </div>

                  <div className="mt-2 flex justify-end">
                    <button
                      onClick={() => {
                        const next: OsEnv = env === "SANDBOX" ? "RoT" : "SANDBOX";
                        setEnv(next);
                        setEnvState(next);
                        setEnvMenuOpen(false);
                      }}
                      className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] text-white/75 hover:bg-white/10"
                    >
                      Quick toggle
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Sign out */}
            <button
              onClick={onSignOut}
              className={cx(
                "flex items-center gap-2 rounded-full border border-white/10 bg-black/20 text-[12px] text-white/90 shadow-[0_0_18px_rgba(0,0,0,0.20)] hover:bg-white/5 hover:shadow-[0_0_24px_rgba(201,162,39,0.10)] transition",
                pillBase,
                pillBaseSm
              )}
              title="Sign out"
            >
              <LogOut className="h-4 w-4 text-white/65" />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default OsGlobalBar;
