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
  const [_dockVisible, setDockVisible] = useState(true);

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
  // - TOUCH: hide during scroll/touchmove (iOS-safe), show shortly after stop
  // - DESKTOP: keep visible (enterprise-safe)
  useEffect(() => {
    if (typeof document === "undefined") return;

    const root = document.querySelector(".os-root") as HTMLElement | null;
    const dockEl = document.querySelector(".os-dock") as HTMLElement | null;
    const workspace = document.querySelector(".os-workspace") as HTMLElement | null;

    if (!root || !dockEl) return;

    const apply = (visible: boolean) => {
      root.dataset.dock = visible ? "visible" : "hidden";
      setDockVisible(visible);
    };

    // Default
    apply(true);

    // Desktop stays visible
    if (!touch) {
      root.dataset.dock = "visible";
      return;
    }

    let revealTimer: number | null = null;
    let lastHideT = 0;

    const HIDE_THROTTLE_MS = 50;
    const SHOW_AFTER_MS = 260;
    const TOP_GRACE_PX = 18;

    const getPrimaryScrollTop = () => {
      // ✅ OS scroll happens in workspace (body is overflow:hidden)
      if (workspace) return workspace.scrollTop || 0;
      // fallback if a route ever enables window scroll
      return window.scrollY || 0;
    };

    const getEventScrollTop = (evtTarget: EventTarget | null) => {
      const el = evtTarget as any;
      const st = typeof el?.scrollTop === "number" ? el.scrollTop : 0;
      return st;
    };

    const scheduleReveal = () => {
      if (revealTimer) window.clearTimeout(revealTimer);
      revealTimer = window.setTimeout(() => {
        apply(true);
        revealTimer = null;
      }, SHOW_AFTER_MS);
    };

    const hideNow = (evtTarget?: EventTarget | null) => {
      const now = performance.now();
      if (now - lastHideT < HIDE_THROTTLE_MS) return;
      lastHideT = now;

      // Grace near the *actual* scroller top (workspace)
      const yPrimary = getPrimaryScrollTop();

      // If the event came from a nested scroller, use its scrollTop too
      const yEvent = evtTarget ? getEventScrollTop(evtTarget) : 0;

      const y = Math.max(yPrimary, yEvent);

      if (y <= TOP_GRACE_PX) {
        apply(true);
        return;
      }

      apply(false);
      scheduleReveal();
    };

    // iOS: touchmove is the reliable “user is scrolling” signal
    const onTouchMove = (e: TouchEvent) => hideNow(e.target);

    // Backup: catch scroll from workspace and any nested scrollers
    const onWorkspaceScroll = () => hideNow(workspace);
    const onAnyScrollCapture = (e: Event) => hideNow(e.target);

    // Reveal on tap/focus (safety)
    const onPointerDown = () => apply(true);
    const onFocusIn = (e: FocusEvent) => {
      if (dockEl.contains(e.target as Node)) apply(true);
    };

    document.addEventListener("touchmove", onTouchMove, { passive: true });
    if (workspace) workspace.addEventListener("scroll", onWorkspaceScroll, { passive: true });
    document.addEventListener("scroll", onAnyScrollCapture, { passive: true, capture: true });

    dockEl.addEventListener("pointerdown", onPointerDown);
    dockEl.addEventListener("focusin", onFocusIn);

    return () => {
      document.removeEventListener("touchmove", onTouchMove);
      if (workspace) workspace.removeEventListener("scroll", onWorkspaceScroll as any);
      document.removeEventListener("scroll", onAnyScrollCapture as any, true as any);

      dockEl.removeEventListener("pointerdown", onPointerDown as any);
      dockEl.removeEventListener("focusin", onFocusIn as any);

      if (revealTimer) window.clearTimeout(revealTimer);
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
