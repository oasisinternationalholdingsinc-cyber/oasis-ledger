import type { ReactNode } from "react";

import { OsHeader } from "@/components/OsHeader";
import { OsDock } from "@/components/OsDock";
import { OsFooter } from "@/components/OsFooter";

import { OsEntityProvider } from "@/components/OsEntityContext";
import { OsEnvProvider } from "@/components/OsEnvContext";

import OsAuthGate from "./os-auth-gate";

export default function OsLayout({ children }: { children: ReactNode }) {
  return (
    <OsEntityProvider>
      <OsEnvProvider>
        <div className="os-root">
          <OsHeader />

          <div className="os-shell">
            <OsDock />
            <OsAuthGate>
              <div className="os-workspace">{children}</div>
            </OsAuthGate>
          </div>

          {/* Footer owns SANDBOX / ROT ribbon */}
          <OsFooter />

          <div className="os-orb-slot">ORB</div>
        </div>
      </OsEnvProvider>
    </OsEntityProvider>
  );
}
