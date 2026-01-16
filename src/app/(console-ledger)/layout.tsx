import type { ReactNode } from "react";

import { OsHeader } from "@/components/OsHeader";
import { OsDock } from "@/components/OsDock";

import { OsEntityProvider } from "@/components/OsEntityContext";
import { OsEnvProvider } from "@/components/OsEnvContext";

import OsAuthGate from "./os-auth-gate";

export default function OsLayout({ children }: { children: ReactNode }) {
  return (
    <OsEntityProvider>
      <OsEnvProvider>
        <div className="os-root">
          {/* Global OS command / control bar */}
          <OsHeader />

          {/* Main workspace shell (ONLY scroll surface) */}
          <div className="os-shell">
            <OsAuthGate>
              <div className="os-workspace">{children}</div>
            </OsAuthGate>
          </div>

          {/* OS Dock (will be bottom overlay via CSS) */}
          <OsDock />
        </div>
      </OsEnvProvider>
    </OsEntityProvider>
  );
}
