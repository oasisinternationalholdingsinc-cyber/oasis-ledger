"use client";

import React from "react";
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
  moduleKey: string; // used for per-module glow
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

export function OsDock() {
  const pathname = usePathname();

  const isActive = (href: string) => {
    if (href === "/") {
      return pathname === "/" || pathname === "/os";
    }
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

  return (
    <nav className="os-dock" aria-label="Oasis OS dock">
      {CORE_ITEMS.map(renderItem)}
      <div className="dock-divider" />
      {FUTURE_ITEMS.map(renderItem)}
    </nav>
  );
}
