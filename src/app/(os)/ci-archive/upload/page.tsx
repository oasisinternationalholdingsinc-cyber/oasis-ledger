// src/app/(os)/ci-archive/upload/page.tsx
export const dynamic = "force-dynamic";

import { Suspense } from "react";
import UploadClient from "./upload.client";

export default function Page() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-slate-400">Loading upload console…</div>}>
      <UploadClient />
    </Suspense>
  );
}
