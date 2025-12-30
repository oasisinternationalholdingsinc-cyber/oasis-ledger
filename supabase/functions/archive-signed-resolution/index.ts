import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  record_id: string; // governance_ledger.id
  envelope_id?: string; // signature_envelopes.id (optional if governance_documents has it)
  is_test?: boolean; // lane flag
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

const MINUTE_BOOK_BUCKET = "minute_book";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};

const json = (x: unknown, s = 200) =>
  new Response(JSON.stringify(x, null, 2), {
    status: s,
    headers: { ...cors, "Content-Type": "application/json" },
  });

async function pickActor(entity_id: string, preferred?: string | null) {
  if (preferred) return preferred;
  const { data: m } = await supabase
    .from("memberships")
    .select("user_id,role,is_admin")
    .eq("entity_id", entity_id)
    .order("is_admin", { ascending: false });

  return (
    m?.find((x) => x.role === "owner")?.user_id ??
    m?.[0]?.user_id ??
    null
  );
}

async function sha256Hex(bytes: Uint8Array) {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const arr = Array.from(new Uint8Array(hash));
  return arr.map((b) => b.toString(16).padStart(2, "0")).join("");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const body = (await req.json()) as ReqBody;
    if (!body?.record_id) return json({ ok: false, error: "Missing record_id" }, 400);

    // 1) Load ledger record (entity_id, title, created_by, is_test)
    const led = await supabase
      .from("governance_ledger")
      .select("id, entity_id, title, created_by, is_test")
      .eq("id", body.record_id)
      .single();

    if (led.error) return json({ ok: false, error: "Ledger not found", details: led.error.message }, 404);

    const record = led.data;
    const is_test = body.is_test ?? record.is_test ?? false;

    // 2) Resolve entity_slug
    const ent = await supabase
      .from("entities")
      .select("id, slug, name")
      .eq("id", record.entity_id)
      .single();

    if (ent.error) return json({ ok: false, error: "Entity not found", details: ent.error.message }, 500);

    const entity_slug = ent.data.slug;

    // 3) Resolve envelope + signed storage_path
    // IMPORTANT: NO signature_envelopes.storage_bucket in your schema — bucket is implied (minute_book)
    let envelope_id = body.envelope_id ?? null;

    if (!envelope_id) {
      // try find an envelope for this record
      const env = await supabase
        .from("signature_envelopes")
        .select("id,status,storage_path,completed_at,created_by,is_test")
        .eq("record_id", body.record_id)
        .order("created_at", { ascending: false })
        .maybeSingle();

      if (env.data?.id) envelope_id = env.data.id;
    }

    if (!envelope_id) {
      return json({ ok: false, error: "No envelope_id provided and none found for record" }, 400);
    }

    const env2 = await supabase
      .from("signature_envelopes")
      .select("id,status,storage_path,completed_at,created_by,is_test")
      .eq("id", envelope_id)
      .single();

    if (env2.error) return json({ ok: false, error: "Envelope not found", details: env2.error.message }, 404);

    const envelope = env2.data;

    if (envelope.status !== "completed") {
      return json({ ok: false, error: "Envelope not completed yet", status: envelope.status }, 409);
    }
    if (!envelope.storage_path) {
      return json({ ok: false, error: "Envelope missing storage_path (signed PDF not persisted)" }, 500);
    }

    // 4) Determine actor (needed for supporting_documents NOT NULL fields)
    const actor = await pickActor(record.entity_id, record.created_by);
    if (!actor) {
      return json(
        { ok: false, error: "Ledger missing created_by (needed for supporting_docs) and no owner/admin membership found" },
        500,
      );
    }

    // 5) Download signed PDF bytes from storage
    const dl = await supabase.storage
      .from(MINUTE_BOOK_BUCKET)
      .download(envelope.storage_path);

    if (dl.error) {
      return json(
        { ok: false, error: "Failed to download signed PDF from storage", details: dl.error.message, path: envelope.storage_path },
        500,
      );
    }

    const arrBuf = await dl.data.arrayBuffer();
    const bytes = new Uint8Array(arrBuf);
    const file_hash = await sha256Hex(bytes);

    // 6) Call archive-save-document (internal) using service role (same project)
    const fnUrl = `${SUPABASE_URL}/functions/v1/archive-save-document`;

    const resp = await fetch(fnUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
        "apikey": SERVICE_ROLE_KEY,
      },
      body: JSON.stringify({
        entity_id: record.entity_id,
        entity_slug,
        is_test,
        file_base64: btoa(String.fromCharCode(...bytes)),
        title: record.title,
        file_name: `${record.title}.pdf`,
        record_id: record.id,
        envelope_id: envelope.id,
        domain_key: "resolutions-and-minutes", // will fallback inside archive-save-document if not found
        section_name: "Resolutions & Minutes",
        entry_type: "resolution",
        source: "signed_resolution",
      }),
    });

    const out = await resp.json().catch(() => ({}));
    if (!resp.ok || !out?.ok) {
      return json(
        {
          ok: false,
          error: "archive-save-document failed",
          details: out?.details ?? out?.error ?? "Edge Function returned a non-2xx status code",
          upstream: out,
        },
        500,
      );
    }

    return json({
      ok: true,
      record_id: record.id,
      envelope_id: envelope.id,
      is_test,
      signed_source_path: envelope.storage_path,
      signed_sha256: file_hash,
      archive: out,
    });
  } catch (e) {
    return json({ ok: false, error: String(e?.message ?? e) }, 500);
  }
});
