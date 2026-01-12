"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";

export default function OsAuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    let alive = true;

    const bounceToLogin = (p?: string | null) => {
      // ✅ Enterprise default entry: Launchpad (not a CI module route)
      const raw = (p && p.startsWith("/") ? p : "/console-launchpad") || "/console-launchpad";
      const next = encodeURIComponent(raw);
      router.replace(`/login?next=${next}`);
    };

    (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!alive) return;

      if (!session) bounceToLogin(pathname);
    })();

    const { data: sub } = supabase.auth.onAuthStateChange(
      (_event: AuthChangeEvent, session: Session | null) => {
        if (!session) bounceToLogin(pathname);
      }
    );

    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, [router, pathname]);

  return <>{children}</>;
}
