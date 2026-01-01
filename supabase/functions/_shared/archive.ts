// supabase/functions/_shared/archive.ts
import { createClient } from "jsr:@supabase/supabase-js@2";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export const MINUTE_BOOK_BUCKET = "minute_book";
export const SEAL_RPC = "seal_governance_record_for_archive";

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
};

export const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

export function serviceClient(req: Request) {
  // service_role for DB writes, but preserve the user's JWT so we can read auth.getUser()
  const authHeader = req.headers.get("authorization") ?? "";
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { authorization: authHeader } },
  });
}

export async function getActorUserId(supabase: ReturnType<typeof createClient>) {
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  return data?.user?.id ?? null;
}

export function pickFileName(path: string) {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

export async function pickMinuteBookPdfPath(
  supabase: ReturnType<typeof createClient>,
  ledgerId: string,
  entityKey: string,
) {
  // ✅ Canonical is lowercase "resolutions" (but keep legacy fallback)
  const patterns = [
    `${entityKey}/resolutions/${ledgerId}-signed.pdf`,
    `${entityKey}/resolutions/${ledgerId}.pdf`,
    `${entityKey}/Resolutions/${ledgerId}-signed.pdf`,
    `${entityKey}/Resolutions/${ledgerId}.pdf`,
  ];

  for (const exact of patterns) {
    const { data } = await supabase
      .from("storage.objects")
      .select("id, name, created_at")
      .eq("bucket_id", MINUTE_BOOK_BUCKET)
      .eq("name", exact)
      .order("created_at", { ascending: false })
      .limit(1);

    if (data?.[0]?.name) return { path: data[0].name as string, objectId: data[0].id as string };
  }

  // Loose fallback: newest object containing ledgerId under entityKey/
  const { data: loose } = await supabase
    .from("storage.objects")
    .select("id, name, created_at")
    .eq("bucket_id", MINUTE_BOOK_BUCKET)
    .ilike("name", `${entityKey}/%${ledgerId}%`)
    .order("created_at", { ascending: false })
    .limit(1);

  if (loose?.[0]?.name) return { path: loose[0].name as string, objectId: loose[0].id as string };
  return { path: null, objectId: null };
}
