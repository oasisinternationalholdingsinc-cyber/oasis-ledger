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
  // service_role for writes, but we still pass through the user JWT
  // so we can recover user id for uploaded_by/owner_id fields.
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
  // Prefer signed PDF, then fallback to any PDF for that ledgerId.
  // Your storage shows: holdings/Resolutions/<ledgerId>-signed.pdf
  const patterns = [
    `${entityKey}/Resolutions/${ledgerId}-signed.pdf`,
    `${entityKey}/resolutions/${ledgerId}-signed.pdf`,
    `${entityKey}/Resolutions/${ledgerId}.pdf`,
    `${entityKey}/resolutions/${ledgerId}.pdf`,
  ];

  for (const exact of patterns) {
    const { data } = await supabase
      .from("storage.objects")
      .select("name, created_at")
      .eq("bucket_id", MINUTE_BOOK_BUCKET)
      .eq("name", exact)
      .order("created_at", { ascending: false })
      .limit(1);

    if (data?.[0]?.name) return data[0].name as string;
  }

  // Loose fallback: newest object containing ledgerId under entityKey/
  const { data: loose } = await supabase
    .from("storage.objects")
    .select("name, created_at")
    .eq("bucket_id", MINUTE_BOOK_BUCKET)
    .ilike("name", `${entityKey}/%${ledgerId}%`)
    .order("created_at", { ascending: false })
    .limit(1);

  return loose?.[0]?.name ?? null;
}
