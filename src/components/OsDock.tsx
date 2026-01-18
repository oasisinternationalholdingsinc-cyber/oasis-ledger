// src/components/OsDock.tsx
"use client";

import React, { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import {
  Orbit, // Dashboard
  Edit, // CI-Alchemy
  Landmark, // CI-Parliament
  Flame, // CI-Forge
  ShieldAlert, // CI-Sentinel
  Archive, // CI-Archive
  IdCard, // CI-Onboarding
} from "lucide-react";

type DockItem = {
  href: string;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  tintClass: string;
  moduleKey: string;
};

const CORE_ITEMS: DockItem[] = [
  {
    href: "/",
    label: "Dashboard",
    Icon: Orbit,
    tintClass: "text-amber-300",
    moduleKey: "orbit",
  },
  {
    href: "/ci-alchemy",
    label: "CI-Alchemy",
    Icon: Edit,
    tintClass: "text-sky-300",
    moduleKey: "alchemy",
  },
  {
    href: "/ci-parliament",
    label: "CI-Parliament",
    Icon: Landmark,
    tintClass: "text-emerald-300",
    moduleKey: "parliament",
  },
  {
    href: "/ci-forge",
    label: "CI-Forge",
    Icon: Flame,
    tintClass: "text-orange-300",
    moduleKey: "forge",
  },
];

const FUTURE_ITEMS: DockItem[] = [
  {
    href: "/ci-onboarding",
    label: "CI-Onboarding",
    Icon: IdCard,
    tintClass: "text-amber-200",
    moduleKey: "admissions",
  },
  {
    href: "/ci-sentinel",
    label: "CI-Sentinel",
    Icon: ShieldAlert,
    tintClass: "text-rose-300",
    moduleKey: "sentinel",
  },
  {
    href: "/ci-archive",
    label: "CI-Archive",
    Icon: Archive,
    tintClass: "text-slate-200",
    moduleKey: "archive",
  },
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

  const [touch] = useState(() => isTouchDevice());

  // NOTE: state kept for debugging parity; CSS is driven by root.dataset.dock.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [dockVisible, setDockVisible] = useState(true);

  const isActive = useCallback(
    (href: string) => {
      if (href === "/") return pathname === "/" || pathname === "/os";
      return pathname.startsWith(href);
    },
    [pathname]
  );

  const renderItem = useCallback(
    ({ href, label, Icon, tintClass, moduleKey }: DockItem) => {
      const active = isActive(href);

      return (
        <Link
          key={href}
          href={href}
          className="dock-item"
          data-module={moduleKey}
          aria-label={label}
          aria-current={active ? "page" : undefined}
        >
          <div className={clsx("dock-icon", active && "active")}>
            <Icon className={clsx("h-5 w-5", tintClass)} />
          </div>

          {/* Label visibility is CSS-controlled:
              - desktop: hidden until hover (your original “elite” behavior)
              - touch: you can choose to show labels via CSS if desired
          */}
          <div className="dock-label">{label}</div>
        </Link>
      );
    },
    [isActive]
  );

  // ===== AUTOHIDE ENGINE (KEEP — hides while scrolling, shows on hover/near-bottom) =====
  useEffect(() => {
    if (typeof document === "undefined") return;

    const root = document.querySelector(".os-root") as HTMLElement | null;
    const workspace = document.querySelector(".os-workspace") as HTMLElement | null;
    const dockEl = document.querySelector(".os-dock") as HTMLElement | null;

    if (!root || !workspace || !dockEl) return;

    // expose touch hint to CSS (NO wiring change)
    root.dataset.touch = touch ? "1" : "0";

    const apply = (visible: boolean) => {
      root.dataset.dock = visible ? "visible" : "hidden";
      setDockVisible(visible);
    };

    // Default state
    apply(true);

    // Heuristics
    const TOP_REVEAL_PX = 24; // always show near top
    const SCROLL_HIDE_AFTER_PX = 48; // don't hide immediately
    const DY_THRESHOLD = 8; // ignore tiny movements
    const QUIET_MS = 900; // after user stops scrolling, allow hide again
    const BOTTOM_REVEAL_PX = 84; // mouse near bottom reveals (desktop)

    let lastY = workspace.scrollTop;
    let lastDir: "up" | "down" | "none" = "none";
    let raf = 0;

    // track "reading / interacting"
    let pointerNearDock = false;
    let lastInteractAt = 0;

    const now = () => performance.now();
    const markInteract = () => {
      lastInteractAt = now();
      apply(true);
    };

    const shouldLockVisible = () => {
      if (pointerNearDock) return true;
      if (now() - lastInteractAt < 650) return true;
      return false;
    };

    const onScroll = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;

        const y = workspace.scrollTop;
        const dy = y - lastY;

        // always show near top
        if (y <= TOP_REVEAL_PX) {
          lastY = y;
          lastDir = "none";
          apply(true);
          return;
        }

        // ignore micro-scroll noise
        if (Math.abs(dy) < DY_THRESHOLD) return;

        // Determine direction
        const dir: "up" | "down" = dy > 0 ? "down" : "up";
        lastDir = dir;

        // Scroll up -> show
        if (dir === "up") {
          apply(true);
          lastY = y;
          return;
        }

        // Scroll down -> hide only after some travel, and not while interacting
        if (dir === "down") {
          if (shouldLockVisible()) {
            apply(true);
            lastY = y;
            return;
          }
          if (y > SCROLL_HIDE_AFTER_PX) apply(false);
        }

        lastY = y;
      });
    };

    // After scrolling stops, if we were going down, hide (unless interacting)
    let idleTimer: any = null;
    const onScrollEndTick = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (shouldLockVisible()) return;
        const y = workspace.scrollTop;
        if (y > SCROLL_HIDE_AFTER_PX && lastDir === "down") apply(false);
      }, QUIET_MS);
    };

    // Pointer logic: reveal when user approaches bottom (desktop + touchpads)
    const onMouseMove = (e: MouseEvent) => {
      if (touch) return;
      const vh = window.innerHeight || 0;
      const nearBottom = vh - e.clientY < BOTTOM_REVEAL_PX;
      if (nearBottom) apply(true);
    };

    // Hover / focus / tap keeps visible
    const onDockEnter = () => {
      pointerNearDock = true;
      apply(true);
    };
    const onDockLeave = () => {
      pointerNearDock = false;
    };

    const onPointerDown = () => markInteract();
    const onFocusIn = (e: FocusEvent) => {
      if (dockEl.contains(e.target as Node)) markInteract();
    };

    // Keyboard: keep dock visible on Tab focus movement
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Tab") apply(true);
    };

    // Attach listeners
    workspace.addEventListener("scroll", onScroll, { passive: true });
    workspace.addEventListener("scroll", onScrollEndTick as any, { passive: true });

    dockEl.addEventListener("pointerdown", onPointerDown);
    dockEl.addEventListener("mouseenter", onDockEnter);
    dockEl.addEventListener("mouseleave", onDockLeave);
    dockEl.addEventListener("focusin", onFocusIn);

    window.addEventListener("mousemove", onMouseMove, { passive: true });
    window.addEventListener("keydown", onKeyDown);

    // Cleanup
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      if (idleTimer) clearTimeout(idleTimer);

      workspace.removeEventListener("scroll", onScroll as any);
      workspace.removeEventListener("scroll", onScrollEndTick as any);

      dockEl.removeEventListener("pointerdown", onPointerDown as any);
      dockEl.removeEventListener("mouseenter", onDockEnter as any);
      dockEl.removeEventListener("mouseleave", onDockLeave as any);
      dockEl.removeEventListener("focusin", onFocusIn as any);

      window.removeEventListener("mousemove", onMouseMove as any);
      window.removeEventListener("keydown", onKeyDown as any);
    };
  }, [touch]);

  return (
    <nav className="os-dock" aria-label="Oasis OS dock">
      {CORE_ITEMS.map(renderItem)}
      <div className="dock-divider" />
      {FUTURE_ITEMS.map(renderItem)}
    </nav>
  );
}

export default OsDock;
