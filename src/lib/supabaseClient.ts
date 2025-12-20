// src/lib/supabaseClient.ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
if (!supabaseAnonKey) throw new Error("Missing NEXT_PUBLIC_SUPABASE_ANON_KEY");

// ✅ TRUE singleton in the browser (prevents multiple GoTrueClient warnings)
declare global {
  // eslint-disable-next-line no-var
  var __oasis_supabase__: SupabaseClient | undefined;
}

export const supabaseBrowser: SupabaseClient =
  typeof window === "undefined"
    ? createClient(supabaseUrl, supabaseAnonKey)
    : (globalThis.__oasis_supabase__ ??= createClient(supabaseUrl, supabaseAnonKey));
