"use client";
export const dynamic = "force-dynamic";

import { Suspense } from "react";
import MinuteBookClient from "./minute-book.client";

export default function MinuteBookPage() {
  return (
    <Suspense fallback={<MinuteBookSkeleton />}>
      <MinuteBookClient />
    </Suspense>
  );
}

function MinuteBookSkeleton() {
  return (
    <div className="min-h-screen bg-black text-white">
      <div className="mx-auto max-w-[1600px] px-5 pt-5">
        <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="h-8 w-64 rounded-xl bg-white/5 animate-pulse" />
          <div className="mt-3 h-px w-full bg-gradient-to-r from-transparent via-yellow-500/25 to-transparent" />
        </div>
      </div>

      <div className="mx-auto max-w-[1600px] px-5 pb-8 pt-4">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)_420px]">
          <div className="h-[72vh] rounded-3xl border border-white/10 bg-white/5 animate-pulse" />
          <div className="h-[72vh] rounded-3xl border border-white/10 bg-white/5 animate-pulse" />
          <div className="h-[72vh] rounded-3xl border border-white/10 bg-white/5 animate-pulse" />
        </div>
      </div>
    </div>
  );
}
