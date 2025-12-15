// src/app/(os)/layout.tsx
import type { ReactNode } from "react";
import { OsHeader } from "@/components/OsHeader";
import { OsDock } from "@/components/OsDock";
import { OsEntityProvider } from "@/components/OsEntityContext";

export default function OsLayout({ children }: { children: ReactNode }) {
  return (
    <OsEntityProvider>
      <div className="os-root">
        {/* Global cockpit bar */}
        <OsHeader />

        {/* Shell: dock + workspace */}
        <div className="os-shell">
          <OsDock />
          <div className="os-workspace">{children}</div>
        </div>

        {/* Footer + Orb */}
        <div className="os-footer">
          OASIS DIGITAL PARLIAMENT • <span>GOVERNANCE FIRMWARE</span>
        </div>

        <div className="os-orb-slot">ORB</div>
      </div>
    </OsEntityProvider>
  );
}
