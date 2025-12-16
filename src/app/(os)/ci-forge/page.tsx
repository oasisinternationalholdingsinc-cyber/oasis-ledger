export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

import ForgeClient from "./ForgeClient";

export default function Page({
  searchParams,
}: {
  searchParams?: { [key: string]: string | string[] | undefined };
}) {
  const raw = searchParams?.entity;
  const entity =
    typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;

  const entitySlug = entity ?? "holdings";

  return <ForgeClient entitySlug={entitySlug} />;
}
