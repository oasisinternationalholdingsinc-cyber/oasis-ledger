import ForgeClient from "./ForgeClient";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export default function Page({
  searchParams,
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const raw = searchParams?.entity;
  const entitySlug = Array.isArray(raw) ? raw[0] : raw ?? "holdings";

  return <ForgeClient entitySlug={entitySlug} />;
}
