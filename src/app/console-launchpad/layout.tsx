import type { ReactNode } from "react";
import OsAuthGate from "../(console-ledger)/os-auth-gate";

export default function ConsoleLaunchpadLayout({ children }: { children: ReactNode }) {
  return <OsAuthGate>{children}</OsAuthGate>;
}
