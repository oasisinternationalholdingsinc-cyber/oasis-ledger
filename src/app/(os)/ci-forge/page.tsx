import { Suspense } from "react";
import ForgeClient from "./ForgeClient";

export const dynamic = "force-dynamic";

export default function CIForgePage() {
  return (
    <Suspense
      fallback={
        <div className="h-full flex items-center justify-center text-[12px] text-slate-400">
          Loading CI-Forge…
        </div>
      }
    >
      <ForgeClient />
    </Suspense>
  );
}
