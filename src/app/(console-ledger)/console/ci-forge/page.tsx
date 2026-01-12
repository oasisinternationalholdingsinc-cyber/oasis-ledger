// src/app/(os)/ci-forge/page.tsx
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

import ForgeClient from "./ForgeClient";

export default function Page() {
  return <ForgeClient />;
}
