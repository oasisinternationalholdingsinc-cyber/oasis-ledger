import { Suspense } from "react";
import SignClient from "./SignClient";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center text-xs text-slate-400">
          Loading signing session…
        </div>
      }
    >
      <SignClient />
    </Suspense>
  );
}
