import { Suspense } from "react";
import SignClient from "./SignClient";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="h-[calc(100vh-80px)] w-full flex items-center justify-center text-xs text-slate-400">
          Loading CI-Sign…
        </div>
      }
    >
      <SignClient />
    </Suspense>
  );
}
