"use client";

import { useMemo, useState, useEffect, FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";

// KEEP your existing types + UI here.
// The only requirement is: useSearchParams stays in this client file.

export default function ForgeClient() {
  const searchParams = useSearchParams(); // ✅ allowed here

  // Example: read query params safely
  const envelopeId = useMemo(() => searchParams.get("envelope") ?? "", [searchParams]);

  const { activeEntity } = useEntity();

  // ⬇️ Paste your existing CI-FORGE component logic/UI here
  // Everything you had in page.tsx goes in this component.

  return (
    <div className="h-full flex flex-col">
      {/* paste your full CI-FORGE UI here */}
      <div className="text-xs text-slate-400 p-4">
        Forge Client Loaded • envelope={envelopeId || "none"} • entity={activeEntity}
      </div>
    </div>
  );
}
