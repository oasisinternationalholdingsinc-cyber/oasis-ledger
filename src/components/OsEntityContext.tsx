// src/components/OsEntityContext.tsx
"use client";

import { createContext, useContext, useEffect, useMemo, useState, ReactNode } from "react";

export type EntityKey = "holdings" | "lounge" | "real-estate";

type EntityContextValue = {
  activeEntity: EntityKey;
  setActiveEntity: (key: EntityKey) => void;
};

const EntityContext = createContext<EntityContextValue | undefined>(undefined);

function isEntityKey(v: string | null): v is EntityKey {
  return v === "holdings" || v === "lounge" || v === "real-estate";
}

function readEntityFromUrl(): EntityKey | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const v = params.get("entity_key");
  return isEntityKey(v) ? v : null;
}

function readEntityFromStorage(): EntityKey | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem("oasis_entity_key");
    return isEntityKey(v) ? v : null;
  } catch {
    return null;
  }
}

function writeEntityToStorage(v: EntityKey) {
  try {
    window.localStorage.setItem("oasis_entity_key", v);
  } catch {
    // ignore
  }
}

export function OsEntityProvider({ children }: { children: ReactNode }) {
  const [activeEntity, _setActiveEntity] = useState<EntityKey>("holdings");

  // Bootstrap from URL first, then localStorage (so refresh + deep-links are stable)
  useEffect(() => {
    const fromUrl = readEntityFromUrl();
    if (fromUrl) {
      _setActiveEntity(fromUrl);
      writeEntityToStorage(fromUrl);
      return;
    }

    const fromStorage = readEntityFromStorage();
    if (fromStorage) {
      _setActiveEntity(fromStorage);
    }
  }, []);

  const setActiveEntity = useMemo(() => {
    return (key: EntityKey) => {
      _setActiveEntity(key);
      writeEntityToStorage(key);
    };
  }, []);

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
