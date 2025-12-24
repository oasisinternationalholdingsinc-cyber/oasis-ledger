// src/app/(os)/layout.tsx
import type { ReactNode } from "react";
import { OsHeader } from "@/components/OsHeader";
import { OsDock } from "@/components/OsDock";
import { OsEntityProvider } from "@/components/OsEntityContext";
import OsAuthGate from "./os-auth-gate";
import { OsFooter } from "@/components/OsFooter";

export default function OsLayout({ children }: { children: ReactNode }) {
  return (
    <OsEntityProvider>
      <div className="os-root">
        <OsHeader />

        <div className="os-shell">
          <OsDock />
          <OsAuthGate>
            <div className="os-workspace">{children}</div>
          </OsAuthGate>
        </div>

        {/* ✅ Footer owns SANDBOX ribbon + identity */}
        <OsFooter />

        <div className="os-orb-slot">ORB</div>
      </div>
    </OsEntityProvider>
  );
}
