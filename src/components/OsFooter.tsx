"use client";

import OsFooterBar from "@/components/OsFooterBar";

export function OsFooter() {
  return (
    <footer className="fixed bottom-0 left-0 right-0 z-[40]">
      {/* Footer ribbon owns SANDBOX banner */}
      <OsFooterBar />

      {/* Base footer strip */}
      <div className="border-t border-white/5 bg-black/55 backdrop-blur-xl">
        <div className="mx-auto flex h-[44px] max-w-[1500px] items-center justify-between px-6 text-[11px] text-white/55">
          <div className="tracking-[0.22em]">OASIS DIGITAL PARLIAMENT</div>
          <div>
            <span className="text-white/45">OPERATIONAL</span>{" "}
            <span className="text-[#c9a227]/80">• GOVERNANCE FIRMWARE</span>
          </div>
        </div>
      </div>
    </footer>
  );
}

export default OsFooter;
