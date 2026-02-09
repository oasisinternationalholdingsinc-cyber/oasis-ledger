import { createClient } from "@supabase/supabase-js";

export function serviceSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE ||
    process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) throw new Error("Missing SUPABASE url/service_role env");

  return createClient(url, key, { auth: { persistSession: false } });
}

export async function readJson(req: Request) {
  return await req.json().catch(() => ({}));
}
