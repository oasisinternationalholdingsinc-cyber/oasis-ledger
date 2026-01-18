"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import {
  Orbit,       // Dashboard – Oasis Os Core
  Edit,        // CI-Alchemy – Scribe / Drafting
  Landmark,    // CI-Parliament – Parliament / Council
  Flame,       // CI-Forge – Execution / Fire
  ShieldAlert, // CI-Sentinel – Guardian / Alerts
  Archive,     // CI-Archive – Vault / Records
  IdCard,      // CI-Onboarding – Intake / Authority Gateway
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
  // - on TOUCH devices: scroll down hides, scroll up shows
  // - on DESKTOP: keep visible (no cursor-edge reveal yet), but we still show on hover/tap handle
  useEffect(() => {
    if (typeof document === "undefined") return;

    const root = document.querySelector(".os-root") as HTMLElement | null;
    const workspace = document.querySelector(".os-workspace") as HTMLElement | null;
    const dockEl = document.querySelector(".os-dock") as HTMLElement | null;

    if (!root || !workspace || !dockEl) return;

    // expose for CSS
    const apply = (visible: boolean) => {
      root.dataset.dock = visible ? "visible" : "hidden";
      setDockVisible(visible);
    };

    // Default state
    apply(true);

    // If not touch device, keep it visible (safe/enterprise)
    if (!touch) {
      root.dataset.dock = "visible";
      return;
    }

    let lastY = workspace.scrollTop;
    let lastT = performance.now();

    const thresholdPx = 10;      // ignore tiny movements
    const minIntervalMs = 50;    // ignore super high-frequency noise

    const onScroll = () => {
      const nowT = performance.now();
      const y = workspace.scrollTop;

      if (nowT - lastT < minIntervalMs) return;

      const dy = y - lastY;
      if (Math.abs(dy) < thresholdPx) return;

      // scroll down -> hide (unless near top)
      if (dy > 0 && y > 24) apply(false);

      // scroll up -> show
      if (dy < 0) apply(true);

      lastY = y;
      lastT = nowT;
    };

    // Tap the dock/handle to reveal
    const onPointerDown = () => apply(true);

    workspace.addEventListener("scroll", onScroll, { passive: true });
    dockEl.addEventListener("pointerdown", onPointerDown);

    return () => {
      workspace.removeEventListener("scroll", onScroll as any);
      dockEl.removeEventListener("pointerdown", onPointerDown as any);
    };
  }, [touch]);

  // Keep ref (optional)
  useEffect(() => {
    dockRef.current = document.querySelector(".os-dock") as HTMLElement | null;
  }, []);

  // (optional) keyboard safety: if user tabs into dock, reveal
  useEffect(() => {
    if (!touch) return;
    const root = document.querySelector(".os-root") as HTMLElement | null;
    const dockEl = document.querySelector(".os-dock") as HTMLElement | null;
    if (!root || !dockEl) return;

    const onFocusIn = (e: FocusEvent) => {
      if (dockEl.contains(e.target as Node)) root.dataset.dock = "visible";
    };

    dockEl.addEventListener("focusin", onFocusIn);
    return () => dockEl.removeEventListener("focusin", onFocusIn);
  }, [touch]);

  // Keep output identical structure (no module wiring changes)
  return (
    <nav className="os-dock" aria-label="Oasis OS dock">
      {CORE_ITEMS.map(renderItem)}
      <div className="dock-divider" />
      {FUTURE_ITEMS.map(renderItem)}
    </nav>
  );
}
