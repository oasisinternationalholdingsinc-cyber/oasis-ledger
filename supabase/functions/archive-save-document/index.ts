import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  record_id: string;          // governance_ledger.id
  envelope_id?: string | null; // optional (for pointers)
  is_test?: boolean;          // lane flag
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};

const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

const SEAL_RPC = "seal_governance_record_for_archive";

function asBool(v: unknown, fallback = false) {
  if (typeof v === "boolean") return v;
  return fallback;
}

async function pickValidDomainKey(preferred: string | null): Promise<string> {
  // 1) If preferred exists and is valid → use it
  if (preferred) {
    const check = await supabase
      .from("governance_domains")
      .select("key")
      .eq("key", preferred)
      .eq("active", true)
      .limit(1)
      .maybeSingle();
    if (!check.error && check.data?.key) return check.data.key as string;
  }

  // 2) Otherwise choose first active domain by sort_order
  const fallback = await supabase
    .from("governance_domains")
    .select("key")
    .eq("active", true)
    .order("sort_order", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (fallback.error || !fallback.data?.key) {
    // If this happens, your governance_domains table is empty or inactive.
    throw new Error("No active governance_domains found (cannot satisfy minute_book_entries.domain_key FK).");
  }
  return fallback.data.key as string;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const body = (await req.json()) as ReqBody;
    const record_id = (body?.record_id ?? "").trim();
    const envelope_id = body?.envelope_id ?? null;
    const is_test = asBool(body?.is_test, false);

    if (!record_id) return json({ ok: false, error: "record_id is required" }, 400);

    // 1) Load ledger record (do NOT guess domain_key)
    const gl = await supabase
      .from("governance_ledger")
      .select("id, title, entity_id, entity_key, is_test, created_by, domain_key")
      .eq("id", record_id)
      .maybeSingle();

    if (gl.error || !gl.data) {
      return json({ ok: false, error: "governance_ledger record not found", details: gl.error }, 404);
    }

    const ledger = gl.data as any;

    // lane safety: respect caller flag but also enforce ledger lane if present
    const lane = typeof ledger.is_test === "boolean" ? ledger.is_test : is_test;

    // 2) Determine a valid domain_key (FK-safe)
    const domain_key = await pickValidDomainKey((ledger.domain_key ?? null) as string | null);

    // 3) Find or create minute book entry (idempotent)
    const existing = await supabase
      .from("minute_book_entries")
      .select("id, title, is_test")
      .eq("source_record_id", record_id)
      .eq("is_test", lane)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let entry_id: string | null = existing.data?.id ?? null;

    if (!entry_id) {
      const ins = await supabase
        .from("minute_book_entries")
        .insert({
          entity_id: ledger.entity_id,            // required
          entity_key: ledger.entity_key,          // enum required in your schema
          is_test: lane,
          domain_key,                             // FK-safe
          entry_type: "resolution",
          title: ledger.title ?? "Untitled",
          source_record_id: record_id,
        })
        .select("id")
        .single();

      if (ins.error) {
        return json(
          {
            ok: false,
            error: "minute_book_entries insert failed",
            details: ins.error,
          },
          500,
        );
      }

      entry_id = ins.data.id as string;
    }

    // 4) Seal/render (returns storage pointers + hash in your implementation)
    const seal = await supabase.rpc(SEAL_RPC as any, { p_record_id: record_id });

    if (seal.error) {
      return json(
        {
          ok: false,
          error: `${SEAL_RPC} failed`,
          details: seal.error,
        },
        500,
      );
    }

    // Support both object and array returns safely
    const sealDataAny: any = seal.data;
    const sealRow = Array.isArray(sealDataAny) ? sealDataAny[0] : sealDataAny;

    const storage_bucket = sealRow?.storage_bucket ?? sealRow?.bucket ?? null;
    const storage_path = sealRow?.storage_path ?? sealRow?.path ?? null;
    const file_hash = sealRow?.file_hash ?? sealRow?.hash ?? null;

    // 5) Ensure a primary supporting_document pointer exists (repair-capable)
    if (storage_path) {
      const sdExisting = await supabase
        .from("supporting_documents")
        .select("id")
        .eq("entry_id", entry_id)
        .eq("doc_type", "primary_pdf")
        .limit(1)
        .maybeSingle();

      if (!sdExisting.data?.id) {
        const sdIns = await supabase.from("supporting_documents").insert({
          entry_id,
          doc_type: "primary_pdf",
          file_path: storage_path,
          file_name: (ledger.title ?? "resolution") + ".pdf",
          file_hash: file_hash ?? null,
          mime_type: "application/pdf",
          signature_envelope_id: envelope_id,
          verified: true,
          registry_visible: true,
        });

        if (sdIns.error) {
          // don't fail the whole archive if pointer insert fails; surface it
          return json(
            {
              ok: false,
              error: "supporting_documents insert failed (primary_pdf)",
              minute_book_entry_id: entry_id,
              details: sdIns.error,
            },
            500,
          );
        }
      }
    }

    // 6) Upsert verified registry pointer (uses source_record_id — NOT source_entry_id)
    const vd = await supabase
      .from("verified_documents")
      .upsert(
        {
          source_record_id: record_id,
          storage_bucket: storage_bucket,
          storage_path: storage_path,
          file_hash: file_hash,
          verification_level: "SEALED",
          is_test: lane,
        } as any,
        { onConflict: "source_record_id" },
      )
      .select("id, storage_bucket, storage_path, file_hash, verification_level, created_at")
      .maybeSingle();

    // don't hard-fail if your schema doesn't match exact vd columns; return best effort
    const verified_document = vd.error ? null : (vd.data as any) ?? null;

    return json({
      ok: true,
      record_id,
      minute_book_entry_id: entry_id,
      lane_is_test: lane,
      domain_key_used: domain_key,
      sealed: {
        storage_bucket,
        storage_path,
        file_hash,
      },
      verified_document,
    });
  } catch (e: any) {
    return json({ ok: false, error: e?.message ?? "Unhandled error" }, 500);
  }
});
