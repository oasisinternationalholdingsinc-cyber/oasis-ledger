import { Suspense } from "react";
import MinuteBookClient from "./minute-book.client";

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <MinuteBookClient />
    </Suspense>
  );
}
