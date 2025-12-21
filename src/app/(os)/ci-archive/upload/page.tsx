export const dynamic = "force-dynamic";

import UploadClient from "./upload.client";

export default function Page() {
  return (
    <div className="h-full min-h-0 flex flex-col">
      <UploadClient />
    </div>
  );
}
