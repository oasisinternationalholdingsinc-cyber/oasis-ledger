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
        <div className="os-root relative overflow-hidden">

          {/* === OS ENVIRONMENT (DOES NOT SCROLL) === */}
          <div
            aria-hidden
            className="
              pointer-events-none
              fixed inset-0 z-0
              flex items-center justify-center
            "
          >
            {/* Ledger shield watermark */}
            <div
              className="
                absolute
                w-[140vw] max-w-none
                aspect-[3/4]
                opacity-[0.035]
                blur-[72px]
                bg-center bg-no-repeat bg-contain
              "
              style={{
                backgroundImage: "url(/os/ledger-shield-gold.svg)",
                transform: "translateY(-8%)",
              }}
            />

            {/* Dark vignette above shield */}
            <div className="absolute inset-0 bg-gradient-radial from-transparent via-black/20 to-black/70" />
          </div>

          {/* === OS UI LAYER === */}
          <div className="relative z-10">
            {/* Global OS command / control bar */}
            <OsHeader />

            {/* Main workspace shell (ONLY scroll surface) */}
            <div className="os-shell">
              <OsAuthGate>
                <div className="os-workspace">{children}</div>
              </OsAuthGate>
            </div>

            {/* OS Dock (bottom overlay via CSS) */}
            <OsDock />
          </div>

        </div>
      </OsEnvProvider>
    </OsEntityProvider>
  );
}
