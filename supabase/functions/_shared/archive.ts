import { createClient } from "jsr:@supabase/supabase-js@2";

export type ArchiveContext = {
  ledger_id: string;
  is_test: boolean;
  entity_id: string;
  entity_slug: string | null;
  title: string | null;
};

export function sbAdmin() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key =
    Deno.env.get("SERVICE_ROLE_KEY") ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key, { global: { fetch } });
}

/**
 * Canonical loader: governance_ledger DOES NOT have entity_key.
 * We always load entity_id, then fetch entities.slug as the "key/slug".
 */
export async function loadArchiveContext(
  supabase: ReturnType<typeof sbAdmin>,
  ledger_id: string,
  is_test?: boolean,
): Promise<ArchiveContext> {
  const { data: gl, error: glErr } = await supabase
    .from("governance_ledger")
    .select("id, is_test, entity_id, title")
    .eq("id", ledger_id)
    .single();

  if (glErr) throw glErr;

  const lane = (is_test ?? gl.is_test ?? false) === true;

  const { data: ent, error: entErr } = await supabase
    .from("entities")
    .select("id, slug")
    .eq("id", gl.entity_id)
    .single();

  if (entErr) throw entErr;

  return {
    ledger_id: gl.id,
    is_test: lane,
    entity_id: gl.entity_id,
    entity_slug: ent?.slug ?? null,
    title: gl.title ?? null,
  };
}
