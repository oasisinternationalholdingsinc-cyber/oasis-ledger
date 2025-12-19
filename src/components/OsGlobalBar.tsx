// src/components/OsGlobalBar.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity, EntityKey } from "@/components/OsEntityContext";

function getTimeString() {
  return new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function isEntityKey(v: string | null): v is EntityKey {
  return v === "holdings" || v === "lounge" || v === "real-estate";
}

export function OsGlobalBar() {
  const [time, setTime] = useState<string>(() => getTimeString());
  const [operatorEmail, setOperatorEmail] = useState<string | null>(null);

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // 🔥 global entity brain
  const { activeEntity, setActiveEntity } = useEntity();

  // live clock
  useEffect(() => {
    const timer = setInterval(() => setTime(getTimeString()), 1000);
    return () => clearInterval(timer);
  }, []);

  // best-effort operator email from Supabase
  useEffect(() => {
    supabase.auth
      .getUser()
      .then(({ data, error }) => {
        if (error) {
          console.error("Failed to fetch operator:", error.message);
          return;
        }
        setOperatorEmail(data.user?.email ?? null);
      })
      .catch((err) => console.error("Unexpected error getting user:", err));
  }, []);

  // Keep context aligned with URL if user lands on a deep link like ?entity_key=holdings
  useEffect(() => {
    const urlEntity = searchParams.get("entity_key");
    if (isEntityKey(urlEntity) && urlEntity !== activeEntity) {
      setActiveEntity(urlEntity);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const onEntityChange = useMemo(() => {
    return (next: EntityKey) => {
      setActiveEntity(next);

      // Update the URL so every page (CI-Archive included) receives the scope
      const params = new URLSearchParams(searchParams.toString());
      params.set("entity_key", next);

      router.push(`${pathname}?${params.toString()}`);
    };
  }, [pathname, router, searchParams, setActiveEntity]);

  return (
    <div
      className="os-global-bar"
      data-entity={activeEntity}
      aria-label="Oasis OS global cockpit"
    >
      {/* left – brand */}
      <div className="os-brand">
        <div className="os-brand-title">OASIS DIGITAL PARLIAMENT</div>
        <div className="os-brand-sub">GOVERNANCE OS • CORE WORKSPACE</div>
      </div>

      {/* center – clock */}
      <div className="os-global-center">
        <div className="os-clock-wrap">
          <div className="os-clock-label">LOCAL OPERATOR TIME</div>
          <div className="os-clock-value" aria-live="polite">
            {time}
          </div>
        </div>
      </div>

      {/* right – entity, role, email, signout */}
      <div className="os-global-right">
        <select
          className="os-entity"
          value={activeEntity}
          onChange={(e) => onEntityChange(e.target.value as EntityKey)}
        >
          <option value="holdings">Holdings</option>
          <option value="lounge">Lounge</option>
          <option value="real-estate">Real Estate</option>
        </select>

        <span className="os-role-pill">OPERATOR</span>

        <span className="os-email">{operatorEmail ?? "loading@oasis-os"}</span>

        <Link href="/login" className="os-signout">
          Sign Out
        </Link>
      </div>
    </div>
  );
}
