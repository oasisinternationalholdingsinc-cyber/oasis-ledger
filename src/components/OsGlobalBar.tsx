"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut, Shield, ChevronDown, User, Clock } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { useEntity, type EntityKey } from "@/components/OsEntityContext";

const ENTITY_LABEL: Record<EntityKey, string> = {
  holdings: "Holdings",
  "real-estate": "Real Estate",
  lounge: "Lounge",
};

function cls(...p: Array<string | false | null | undefined>) {
  return p.filter(Boolean).join(" ");
}

function useClock() {
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * Export BOTH:
 * - named export: OsHeader imports { OsGlobalBar }
 * - default export: other places may import default
 */
export function OsGlobalBar() {
  const router = useRouter();
  const supabase = useMemo(() => supabaseBrowser(), []);
  const { activeEntity, setActiveEntity } = useEntity();

  const [entityOpen, setEntityOpen] = useState(false);
  const now = useClock();

  const operatorLabel = "Operator"; // later wire to profile table
  const clockText = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  async function signOut(e?: React.MouseEvent) {
    e?.preventDefault();
    e?.stopPropagation();
    try {
      await supabase.auth.signOut();
    } catch {}
    router.replace("/login");
  }

  return (
    <div className="sticky top-0 z-50 border-b border-slate-900/60 bg-black/70 backdrop-blur-xl">
      <div className="mx-auto max-w-[1600px] px-5 py-3 flex items-center justify-between gap-4">
        {/* LEFT: Brand + Operator + Entity */}
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-9 w-9 rounded-2xl border border-amber-500/25 bg-amber-500/10 flex items-center justify-center">
            <Shield className="h-4 w-4 text-amber-300" />
          </div>

          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.28em] text-slate-500">
              Oasis Digital Parliament
            </div>
            <div className="text-sm font-semibold text-slate-100 truncate">
              Governance Console <span className="text-slate-500 font-medium">ODP.AI</span>
            </div>
          </div>

          <span className="hidden md:inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-950/50 px-3 py-1 text-[11px] text-slate-300">
            <User className="h-3.5 w-3.5 text-slate-400" />
            <span className="text-slate-400">Operator:</span>
            <span className="text-slate-100">{operatorLabel}</span>
          </span>

          <div className="relative">
            <button
              type="button"
              onClick={() => setEntityOpen((v) => !v)}
              className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-950/50 px-3 py-1 text-[11px] text-slate-300 hover:bg-slate-950/70"
              title="Switch entity"
            >
              <span className="text-slate-400">Entity:</span>
              <span className="text-slate-100">{ENTITY_LABEL[activeEntity]}</span>
              <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
            </button>

            {entityOpen && (
              <div
                className="absolute left-0 mt-2 w-52 overflow-hidden rounded-2xl border border-slate-800 bg-black/95 shadow-xl"
                onMouseLeave={() => setEntityOpen(false)}
              >
                {(Object.keys(ENTITY_LABEL) as EntityKey[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => {
                      setActiveEntity(k);
                      setEntityOpen(false);
                    }}
                    className={cls(
                      "w-full text-left px-3 py-2 text-xs hover:bg-slate-950/70",
                      k === activeEntity ? "text-amber-200" : "text-slate-200"
                    )}
                  >
                    {ENTITY_LABEL[k]}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* CENTER: Clock */}
        <div className="hidden md:flex items-center gap-2 rounded-full border border-slate-800 bg-slate-950/40 px-4 py-2 text-xs text-slate-200">
          <Clock className="h-4 w-4 text-amber-300/80" />
          <span className="font-semibold tracking-wide">{clockText}</span>
        </div>

        {/* RIGHT: Sign out only */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={signOut}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs text-slate-200 hover:bg-slate-950/70"
            title="Sign out"
          >
            <LogOut className="h-4 w-4 text-slate-300" />
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

export default OsGlobalBar;
