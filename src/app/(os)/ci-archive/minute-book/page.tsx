export const dynamic = "force-dynamic";

import MinuteBookClient from "./minute-book.client";

export default function Page({
  searchParams,
}: {
  searchParams?: { entity_key?: string };
}) {
  return <MinuteBookClient initialEntityKey={searchParams?.entity_key ?? null} />;
}
