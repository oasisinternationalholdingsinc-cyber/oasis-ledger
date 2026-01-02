import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  record_id: string;     // governance_ledger.id
  is_test?: boolean;     // optional; we also read from governance_ledger if omitted
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
};

const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY =
  Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("ANON_KEY") ?? "";

// Your canonical SQL function
const SEAL_RPC = "seal_governance_record_for_archive";

type SealResult = {
  storage_bucket: string;
  storage_path: string;
  file_hash: string | null;
  verified_document_id: string | null;
  minute_book_entry_id: string | null;
};

function getBearer(req: Request) {
  const h = req.headers.get("authorization") || req.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m?.[1] ?? null;
}

async function requireUserId(req: Request): Promise<string> {
  const token = getBearer(req);
  if (!token) throw new Error("Missing Authorization Bearer token");

  // Prefer a real verification via auth.getUser if anon key is available.
  if (SUPABASE_ANON_KEY) {
    const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data, error } = await authClient.auth.getUser();
    if (error || !data?.user?.id) throw new Error("Invalid session");
    return data.user.id;
  }

  // Fallback: decode JWT "sub" (not ideal, but prevents NULL attribution).
  const parts = token.split(".");
  if (parts.length < 2) throw new Error("Invalid JWT");
  const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
  if (!payload?.sub) throw new Error("JWT missing sub");
  return String(payload.sub);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  try {
    const actorUid = await requireUserId(req);

    const body = (await req.json()) as ReqBody;
    const record_id = String(body.record_id || "").trim();
    if (!record_id) return json({ ok: false, error: "record_id is required" }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { global: { fetch } });

    // 1) Load governance_ledger row (title/entity/is_test)
    const { data: gl, error: glErr } = await admin
      .from("governance_ledger")
      .select("id,title,entity_id,is_test,status,archived,locked")
      .eq("id", record_id)
      .maybeSingle();

    if (glErr) throw glErr;
    if (!gl) return json({ ok: false, error: "governance_ledger not found" }, 404);

    // 2) Derive entity_slug -> entity_key_enum
    const { data: ent, error: entErr } = await admin
      .from("entities")
      .select("slug")
      .eq("id", gl.entity_id)
      .maybeSingle();

    if (entErr) throw entErr;
    const entity_slug = String(ent?.slug || "");
    if (!entity_slug) throw new Error("Could not resolve entity slug");

    // entity_key_enum is castable from slug (holdings/lounge/real-estate) in your DB
    const entity_key = entity_slug;

    const lane_is_test = typeof body.is_test === "boolean" ? body.is_test : !!gl.is_test;

    // 3) Seal via SQL (idempotent, lane-safe)
    // Your function signature might be either (uuid) or (p_ledger_id uuid). We support both.
    let seal: SealResult | null = null;

    {
      const try1 = await admin.rpc(SEAL_RPC, { p_ledger_id: record_id });
      if (!try1.error && try1.data) seal = (Array.isArray(try1.data) ? try1.data[0] : try1.data) as SealResult;

      if (!seal) {
        const try2 = await admin.rpc(SEAL_RPC, { record_id });
        if (!try2.error && try2.data) seal = (Array.isArray(try2.data) ? try2.data[0] : try2.data) as SealResult;
      }
    }

    if (!seal?.storage_bucket || !seal?.storage_path) {
      return json(
        { ok: false, error: "Seal did not return storage pointers", details: seal },
        500,
      );
    }

    // 4) Upsert minute_book_entries (domain_key MUST be 'governance', source MUST pass chk_minute_book_source)
    const entry_date = (new Date()).toISOString().slice(0, 10); // YYYY-MM-DD
    const mbeTitle = String(gl.title || "Untitled");

    const { data: mbeUpsert, error: mbeErr } = await admin
      .from("minute_book_entries")
      .upsert(
        {
          entity_id: gl.entity_id,
          entity_key,                 // enum cast in DB
          entry_date,                 // NOT NULL
          entry_type: "resolution",   // entry_type_enum default is ok; explicit is safer
          title: mbeTitle,            // NOT NULL
          domain_key: "governance",   // FK-safe (matches your list)
          section_name: "Resolutions",
          source: "signed_resolution", // passes chk_minute_book_source
          source_record_id: gl.id,
          storage_path: seal.storage_path,
          pdf_hash: seal.file_hash,
          is_test: lane_is_test,
          registry_status: "active",
        },
        { onConflict: "entity_key,entry_date,title" },
      )
      .select("id,source_record_id,storage_path,domain_key,source")
      .maybeSingle();

    if (mbeErr) throw mbeErr;
    const entry_id = mbeUpsert?.id as string;

    // 5) Ensure primary supporting_documents pointer exists (uploaded_by + owner_id required)
    const { data: existingPrimary, error: primChkErr } = await admin
      .from("supporting_documents")
      .select("id")
      .eq("entry_id", entry_id)
      .eq("doc_type", "primary")
      .limit(1);

    if (primChkErr) throw primChkErr;

    if (!existingPrimary || existingPrimary.length === 0) {
      const file_name = seal.storage_path.split("/").pop() || `${gl.id}.pdf`;

      const { error: insErr } = await admin.from("supporting_documents").insert({
        entry_id,
        entity_key,                 // entity_key_enum
        section: "resolutions",     // doc_section_enum (you already proved this value works)
        file_path: seal.storage_path,
        file_name,
        doc_type: "primary",
        version: 1,
        uploaded_by: actorUid,
        uploaded_at: new Date().toISOString(),
        owner_id: actorUid,
        file_hash: seal.file_hash,
        mime_type: "application/pdf",
        verified: true,
        registry_visible: true,
        metadata: {},               // NOT NULL jsonb
      });

      if (insErr) throw insErr;
    }

    // 6) Ensure verified_documents exists for this record/path (title is NOT NULL)
    // We DO NOT write generated cols. We only insert when missing.
    const { data: vdExisting, error: vdChkErr } = await admin
      .from("verified_documents")
      .select("id")
      .eq("source_record_id", gl.id)
      .eq("storage_bucket", "minute_book")
      .eq("storage_path", seal.storage_path)
      .limit(1);

    if (vdChkErr) throw vdChkErr;

    if (!vdExisting || vdExisting.length === 0) {
      const { error: vdInsErr } = await admin.from("verified_documents").insert({
        entity_id: gl.entity_id,
        entity_slug,
        document_class: "resolution",
        title: mbeTitle,                 // NOT NULL
        source_table: "governance_ledger",
        source_record_id: gl.id,
        storage_bucket: "minute_book",
        storage_path: seal.storage_path,
        file_hash: seal.file_hash,
        mime_type: "application/pdf",
        verification_level: "certified",
        is_archived: true,
      });
      if (vdInsErr) throw vdInsErr;
    }

    return json({
      ok: true,
      record_id: gl.id,
      entity_slug,
      is_test: lane_is_test,
      sealed: {
        storage_bucket: seal.storage_bucket,
        storage_path: seal.storage_path,
        file_hash: seal.file_hash,
        verified_document_id: seal.verified_document_id,
        minute_book_entry_id: seal.minute_book_entry_id,
      },
      minute_book_entry_id: entry_id,
    });
  } catch (e) {
    console.error("archive-save-document error", e);
    return json({ ok: false, error: (e as Error).message ?? String(e) }, 500);
  }
});
