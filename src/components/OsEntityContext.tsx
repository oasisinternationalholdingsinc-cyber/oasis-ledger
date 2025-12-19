"use client";

import React, { createContext, useContext, useEffect, useMemo, useState } from "react";

export type EntityKey = "holdings" | "real-estate" | "lounge";

export type EntityContextValue = {
  /** canonical */
  activeEntity: EntityKey;
  setActiveEntity: (v: EntityKey) => void;

  /** aliases (backwards/for safety) */
  entityKey: EntityKey;
  setEntityKey: (v: EntityKey) => void;
};

const DEFAULT_ENTITY: EntityKey = "holdings";
const STORAGE_KEY = "oasis_entity_key";

const EntityContext = createContext<EntityContextValue | null>(null);

export function OsEntityProvider({ children }: { children: React.ReactNode }) {
  const [activeEntity, setActiveEntityState] = useState<EntityKey>(DEFAULT_ENTITY);

  // hydrate once
  useEffect(() => {
    try {
      const saved = (localStorage.getItem(STORAGE_KEY) || "").toLowerCase();
      if (saved === "holdings" || saved === "real-estate" || saved === "lounge") {
        setActiveEntityState(saved);
      }
    } catch {}
  }, []);

  const setActiveEntity = (v: EntityKey) => {
    setActiveEntityState(v);
    try {
      localStorage.setItem(STORAGE_KEY, v);
    } catch {}
  };

  const value = useMemo<EntityContextValue>(
    () => ({
      activeEntity,
      setActiveEntity,
      entityKey: activeEntity,
      setEntityKey: setActiveEntity,
    }),
    [activeEntity]
  );

  return <EntityContext.Provider value={value}>{children}</EntityContext.Provider>;
}

export function useEntity() {
  const ctx = useContext(EntityContext);
  if (!ctx) throw new Error("useEntity must be used within OsEntityProvider");
  return ctx;
}

/**
 * Backwards-compatible alias:
 * Some CI modules/pages import `useOsEntity` — keep it stable.
 */
export const useOsEntity = useEntity;
