// src/components/OsHeader.tsx
"use client";

import OsGlobalBar, { OsGlobalBar as OsGlobalBarNamed } from "@/components/OsGlobalBar";

export function OsHeader() {
  // Use the named export so either style works across the codebase
  return (
    <header>
      <OsGlobalBarNamed />
    </header>
  );
}

// Optional default export in case something imports OsHeader default elsewhere
export default function OsHeaderDefault() {
  return (
    <header>
      <OsGlobalBar />
    </header>
  );
}
