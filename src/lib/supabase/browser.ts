import { createBrowserClient } from "@supabase/ssr";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
if (!supabaseAnonKey) throw new Error("Missing NEXT_PUBLIC_SUPABASE_ANON_KEY");

declare global {
  // eslint-disable-next-line no-var
  var __oasis_supabase__: ReturnType<typeof createBrowserClient> | undefined;
}

export const supabaseBrowser =
  globalThis.__oasis_supabase__ ??
  (globalThis.__oasis_supabase__ = createBrowserClient(supabaseUrl, supabaseAnonKey));
