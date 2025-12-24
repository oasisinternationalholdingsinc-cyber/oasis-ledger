"use client";

import { OsFooterBar } from "@/components/OsFooterBar";

export function OsFooter() {
  return (
    <>
      {/* Your existing OS footer line */}
      <div className="os-footer">
        OASIS DIGITAL PARLIAMENT • <span>GOVERNANCE FIRMWARE</span>
      </div>

      {/* Sandbox ribbon lives here */}
      <OsFooterBar />
    </>
  );
}
