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
        <div className="os-root relative overflow-x-hidden">
          {/* === OS ENVIRONMENT (DOES NOT SCROLL) === */}
          <div
            aria-hidden
            className="pointer-events-none fixed inset-0 z-0 flex items-center justify-center"
          >
            {/* Ledger shield watermark (PNG substrate) */}
            <div
              className="absolute w-[140vw] max-w-none aspect-[3/4] bg-center bg-no-repeat bg-contain"
              style={{
                backgroundImage: "url(/os/ledger-shield-gold.png)",
                opacity: 0.045,          // final tuned value
                filter: "blur(48px)",    // final tuned value
                transform: "translateY(-8%)",
              }}
            />

            {/* Vignette */}
            <div className="absolute inset-0 bg-black/60 [mask-image:radial-gradient(circle,transparent_0%,black_60%,black_100%)]" />
          </div>

          {/* === OS UI LAYER === */}
          <div className="relative z-10">
            <OsHeader />

            <div className="os-shell">
              <OsAuthGate>
                <div className="os-workspace">{children}</div>
              </OsAuthGate>
            </div>

            <OsDock />
          </div>
        </div>
      </OsEnvProvider>
    </OsEntityProvider>
  );
}
