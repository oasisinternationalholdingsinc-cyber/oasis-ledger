// src/app/(os)/ci-archive/upload/page.tsx
import { Suspense } from "react";
import UploadClient from "./upload.client";

export const dynamic = "force-dynamic";

export default function Page({
  searchParams,
}: {
  searchParams?: { entity_key?: string };
}) {
  const entityKey = (searchParams?.entity_key || "").toLowerCase();

  return (
    <Suspense fallback={<div className="p-6 text-slate-300">Loading…</div>}>
      <UploadClient initialEntityKey={entityKey || null} />
    </Suspense>
  );
}
