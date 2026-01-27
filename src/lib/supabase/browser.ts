import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
if (!anon) throw new Error("Missing NEXT_PUBLIC_SUPABASE_ANON_KEY");

declare global {
  // eslint-disable-next-line no-var
  var __oasis_supabase__: ReturnType<typeof createClient> | undefined;
}

export const supabaseBrowser =
  globalThis.__oasis_supabase__ ??
  (globalThis.__oasis_supabase__ = createClient(url, anon, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  }));
