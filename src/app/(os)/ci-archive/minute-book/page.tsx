"use client";
export const dynamic = "force-dynamic";

import { Suspense } from "react";
import MinuteBookClient from "./minute-book.client";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <MinuteBookClient />
    </Suspense>
  );
}
