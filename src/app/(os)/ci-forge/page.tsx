// src/app/(os)/ci-forge/page.tsx
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

import { Suspense } from "react";
import ForgeClient from "./ForgeClient";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <ForgeClient />
    </Suspense>
  );
}
