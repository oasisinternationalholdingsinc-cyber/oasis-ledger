import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
if (!supabaseAnonKey) throw new Error("Missing NEXT_PUBLIC_SUPABASE_ANON_KEY");

// IMPORTANT: must be `any` to avoid TS "subsequent variable declarations" conflicts
// if this global is declared elsewhere (or by older code).
declare global {
  // eslint-disable-next-line no-var
  var __oasis_supabase__: any;
}
export const supabaseBrowser: SupabaseClient =
  (globalThis.__oasis_supabase__ as SupabaseClient | undefined) ??
  ((globalThis.__oasis_supabase__ = createBrowserClient(supabaseUrl, supabaseAnonKey)) as SupabaseClient);
