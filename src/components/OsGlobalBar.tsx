"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { LogOut, Shield, Archive } from "lucide-react";

import { supabaseBrowser } from "@/lib/supabase/browser";
import { useEntity } from "@/components/OsEntityContext";

function cls(...p: Array<string | false | null | undefined>) {
  return p.filter(Boolean).join(" ");
}

export function OsGlobalBar() {
  const router = useRouter();
  const supabase = useMemo(() => supabaseBrowser(), []);
  const { activeEntity } = useEntity();

  async function signOut() {
    try {
      await supabase.auth.signOut();
    } catch {}
    router.replace("/login");
  }

  return (
    <div
      className={cls(
        "sticky top-0 z-50",
        "border-b border-slate-900/60",
        "bg-black/70 backdrop-blur-xl"
      )}
    >
      <div className="mx-auto max-w-[1600px] px-5 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-9 w-9 rounded-2xl border border-amber-500/25 bg-amber-500/10 flex items-center justify-center">
            <Shield className="h-4 w-4 text-amber-300" />
          </div>

          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.28em] text-slate-500">
              Oasis OS
            </div>
            <div className="text-sm font-semibold text-slate-100 truncate">
              Governance Console
            </div>
          </div>

          <span className="ml-2 rounded-full border border-slate-800 bg-slate-950/50 px-3 py-1 text-[11px] text-slate-300">
            Entity: <span className="text-slate-100">{activeEntity}</span>
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Link
            href="/ci-archive"
            className="inline-flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs text-slate-200 hover:bg-slate-950/70"
          >
            <Archive className="h-4 w-4 text-amber-300/80" />
            CI-Archive
          </Link>

          <button
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
