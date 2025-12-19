import MinuteBookClient from "./minute-book.client";

export const dynamic = "force-dynamic";

export default function MinuteBookPage() {
  return (
    <div className="h-[calc(100vh-56px)] overflow-hidden">
      <MinuteBookClient />
    </div>
  );
}
