// src/components/OsGlobalBar.tsx
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity, EntityKey } from "@/components/OsEntityContext";

function getTimeString() {
  return new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function OsGlobalBar() {
  const [time, setTime] = useState<string>(() => getTimeString());
  const [operatorEmail, setOperatorEmail] = useState<string | null>(null);

  // 🔥 global entity brain
  const { activeEntity, setActiveEntity } = useEntity();

  // live clock
  useEffect(() => {
    const timer = setInterval(() => {
      setTime(getTimeString());
    }, 1000);

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
          onChange={(e) =>
            setActiveEntity(e.target.value as EntityKey)
          }
        >
          <option value="holdings">Holdings</option>
          <option value="lounge">Lounge</option>
          <option value="real-estate">Real Estate</option>
        </select>

        <span className="os-role-pill">OPERATOR</span>

        <span className="os-email">
          {operatorEmail ?? "loading@oasis-os"}
        </span>

        <Link href="/login" className="os-signout">
          Sign Out
        </Link>
      </div>
    </div>
  );
}
