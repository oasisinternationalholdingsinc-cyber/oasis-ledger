// src/components/OsDock.tsx
"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import {
  Orbit, // Dashboard – Oasis Os Core
  Edit, // CI-Alchemy – Scribe / Drafting
  Landmark, // CI-Parliament – Parliament / Council
  Flame, // CI-Forge – Execution / Fire
  ShieldAlert, // CI-Sentinel – Guardian / Alerts
  Archive, // CI-Archive – Vault / Records
  IdCard, // CI-Onboarding – Intake / Authority Gateway
} from "lucide-react";

type DockItem = {
  href: string;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  tintClass: string;
  moduleKey: string;
};

const CORE_ITEMS: DockItem[] = [
  { href: "/", label: "Dashboard", Icon: Orbit, tintClass: "text-amber-300", moduleKey: "orbit" },
  { href: "/ci-alchemy", label: "CI-Alchemy", Icon: Edit, tintClass: "text-sky-300", moduleKey: "alchemy" },
  { href: "/ci-parliament", label: "CI-Parliament", Icon: Landmark, tintClass: "text-emerald-300", moduleKey: "parliament" },
  { href: "/ci-forge", label: "CI-Forge", Icon: Flame, tintClass: "text-orange-300", moduleKey: "forge" },
];

const FUTURE_ITEMS: DockItem[] = [
  { href: "/ci-onboarding", label: "CI-Onboarding", Icon: IdCard, tintClass: "text-amber-200", moduleKey: "admissions" },
  { href: "/ci-sentinel", label: "CI-Sentinel", Icon: ShieldAlert, tintClass: "text-rose-300", moduleKey: "sentinel" },
  { href: "/ci-archive", label: "CI-Archive", Icon: Archive, tintClass: "text-slate-200", moduleKey: "archive" },
];

function isTouchDevice() {
  if (typeof window === "undefined") return false;
  return (
    "ontouchstart" in window ||
    (navigator as any)?.maxTouchPoints > 0 ||
    window.matchMedia?.("(pointer: coarse)").matches
  );
}

export function OsDock() {
  const pathname = usePathname();
  const dockRef = useRef<HTMLElement | null>(null);

  const [touch] = useState(() => isTouchDevice());
  const [dockVisible, setDockVisible] = useState(true);

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/" || pathname === "/os";
    return pathname.startsWith(href);
  };

  const renderItem = ({ href, label, Icon, tintClass, moduleKey }: DockItem) => {
    const active = isActive(href);

    return (
      <Link key={href} href={href} className="dock-item" data-module={moduleKey}>
        <div className={clsx("dock-icon", active && "active")}>
          <Icon className={clsx("w-5 h-5", tintClass)} />
        </div>
        <div className="dock-label">{label}</div>
      </Link>
    );
  };

  // Apple-ish auto-hide:
  // - on TOUCH devices: any scroll hides, stop scrolling shows (works with nested scrollers)
  // - on DESKTOP: keep visible (safe/enterprise), but still reveal on click/focus
  useEffect(() => {
    if (typeof document === "undefined") return;

    const root = document.querySelector(".os-root") as HTMLElement | null;
    const dockEl = document.querySelector(".os-dock") as HTMLElement | null;

    if (!root || !dockEl) return;

    // expose for CSS (NO UI regressions: you already style via [data-dock])
    const apply = (visible: boolean) => {
      root.dataset.dock = visible ? "visible" : "hidden";
      setDockVisible(visible);
    };

    // Default state
    apply(true);

    // Desktop stays visible (your locked behavior)
    if (!touch) {
      root.dataset.dock = "visible";
      return;
    }

    // IMPORTANT: catch scroll from ANY nested container (3-pane pages),
    // not just a specific ".os-workspace" node.
    let hideTimer: number | null = null;
    let lastHideT = 0;

    const HIDE_THROTTLE_MS = 60; // ignore high-frequency jitter
    const SHOW_AFTER_MS = 220; // show shortly after scroll stops
    const TOP_GRACE_PX = 18; // near top, prefer visible

    const hideNow = () => {
      const now = performance.now();
      if (now - lastHideT < HIDE_THROTTLE_MS) return;
      lastHideT = now;

      // keep visible near top (feels more native)
      const y = window.scrollY || 0;
      if (y <= TOP_GRACE_PX) {
        apply(true);
        return;
      }

      apply(false);

      if (hideTimer) window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        apply(true);
        hideTimer = null;
      }, SHOW_AFTER_MS);
    };

    // Capture-phase listener catches scroll events from inner scroll containers too.
    const onAnyScroll = () => hideNow();

    // Reveal on tap / focus (native safety)
    const onPointerDown = () => apply(true);
    const onFocusIn = (e: FocusEvent) => {
      if (dockEl.contains(e.target as Node)) apply(true);
    };

    window.addEventListener("scroll", onAnyScroll, { passive: true });
    document.addEventListener("scroll", onAnyScroll, { passive: true, capture: true });
    dockEl.addEventListener("pointerdown", onPointerDown);
    dockEl.addEventListener("focusin", onFocusIn);

    return () => {
      window.removeEventListener("scroll", onAnyScroll as any);
      document.removeEventListener("scroll", onAnyScroll as any, true as any);
      dockEl.removeEventListener("pointerdown", onPointerDown as any);
      dockEl.removeEventListener("focusin", onFocusIn as any);
      if (hideTimer) window.clearTimeout(hideTimer);
    };
  }, [touch]);

  // Keep ref (optional)
  useEffect(() => {
    dockRef.current = document.querySelector(".os-dock") as HTMLElement | null;
  }, []);

  // Keep output identical structure (no module wiring changes)
  return (
    <nav className="os-dock" aria-label="Oasis OS dock">
      {CORE_ITEMS.map(renderItem)}
      <div className="dock-divider" />
      {FUTURE_ITEMS.map(renderItem)}
    </nav>
  );
}
