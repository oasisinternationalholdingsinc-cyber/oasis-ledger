// src/components/OsEntityContext.tsx
"use client";

import { createContext, useContext, useState, ReactNode } from "react";

export type EntityKey = "holdings" | "lounge" | "real-estate";

type EntityContextValue = {
  activeEntity: EntityKey;
  setActiveEntity: (key: EntityKey) => void;
};

const EntityContext = createContext<EntityContextValue | undefined>(undefined);

export function OsEntityProvider({ children }: { children: ReactNode }) {
  const [activeEntity, setActiveEntity] = useState<EntityKey>("holdings");

  return (
    <EntityContext.Provider value={{ activeEntity, setActiveEntity }}>
      {children}
    </EntityContext.Provider>
  );
}

export function useEntity() {
  const ctx = useContext(EntityContext);
  if (!ctx) {
    throw new Error("useEntity must be used inside <OsEntityProvider>");
  }
  return ctx;
}
