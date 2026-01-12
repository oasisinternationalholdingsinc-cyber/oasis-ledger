// src/app/(os)/ci-archive/ledger/page.tsx
export const dynamic = "force-dynamic";

import { Suspense } from "react";
import DraftsApprovalsClient from "./ledger.client";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <DraftsApprovalsClient />
    </Suspense>
  );
}
