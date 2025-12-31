import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  record_id: string; // governance_ledger.id
  envelope_id?: string; // signature_envelopes.id (recommended)
  is_test?: boolean; // lane flag (fallback only; ledger is truth)
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

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { global: { fetch } });

function asBool(v: unknown, fallback = false) {
  if (typeof v === "boolean") return v;
  return fallback;
}

const SEAL_RPC = "seal_governance_record_for_archive";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const body = (await req.json()) as ReqBody;

    const record_id = (body?.record_id ?? "").trim();
    const envelope_id = (body?.envelope_id ?? "").trim() || null;

    if (!record_id) return json({ ok: false, error: "record_id is required" }, 400);

    // 1) Load ledger (service_role bypasses RLS)
    const led = await supabase
      .from("governance_ledger")
      .select("id, title, status, is_test, entity_id, entity_key, approved_by_council, archived, locked, created_by")
      .eq("id", record_id)
      .maybeSingle();

    if (led.error || !led.data) {
      return json(
        { ok: false, error: "governance_ledger row not found", details: led.error ?? null },
        404,
      );
    }

    const ledger = led.data as any;

    // Ledger is truth for lane
    const is_test = !!ledger.is_test;

    // Gate: only approved may be archived (match seal fn expectation)
    // (status alone is not enough; we keep it strict)
    if (ledger.approved_by_council !== true) {
      return json(
        {
          ok: false,
          error: "Ledger not eligible for archive (approved_by_council=false)",
          status: ledger.status ?? null,
        },
        400,
      );
    }

    // 2) If envelope_id provided, validate it (record match + completed)
    let envelope_storage_path: string | null = null;
    let envelope_storage_hash: string | null = null;

    if (envelope_id) {
      const env = await supabase
        .from("signature_envelopes")
        .select("id, record_id, status, storage_path, storage_hash")
        .eq("id", envelope_id)
        .maybeSingle();

      if (env.error || !env.data) {
        return json(
          { ok: false, error: "signature_envelopes row not found", details: env.error ?? null },
          404,
        );
      }

      if ((env.data as any).record_id !== record_id) {
        return json(
          { ok: false, error: "Envelope does not belong to record_id", record_id, envelope_id },
          400,
        );
      }

      const envStatus = ((env.data as any).status as string | null) ?? null;
      if (envStatus !== "completed") {
        return json(
          { ok: false, error: "Envelope not completed", envelope_status: envStatus },
          400,
        );
      }

      envelope_storage_path = ((env.data as any).storage_path as string | null) ?? null;
      envelope_storage_hash = ((env.data as any).storage_hash as string | null) ?? null;
    }

    // 3) Ensure minute_book_entries exists for THIS lane (idempotent)
    // NOTE: your minute_book_entries has required columns (entity_id, entity_key, domain_key).
    // We supply enterprise-safe defaults.
    const mbeExisting = await supabase
      .from("minute_book_entries")
      .select("id, title, is_test, entity_id, entity_key, domain_key, storage_path, file_name, pdf_hash, created_at")
      .eq("source_record_id", record_id)
      .eq("is_test", is_test)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (mbeExisting.error) {
      return json({ ok: false, error: "Failed to check minute_book_entries", details: mbeExisting.error }, 500);
    }

    let minute_book_entry_id: string;
    let already_archived = false;

    if (!mbeExisting.data) {
      const ins = await supabase
        .from("minute_book_entries")
        .insert({
          source_record_id: record_id,
          source_envelope_id: envelope_id,
          is_test: is_test,

          entity_id: ledger.entity_id,                 // REQUIRED
          entity_key: ledger.entity_key,               // REQUIRED (enum)
          domain_key: "resolutions",                   // REQUIRED (text) — enterprise default
          section: "Resolutions",                      // if your table has it
          title: ledger.title ?? "Untitled",
        } as any)
        .select("id")
        .single();

      if (ins.error) {
        return json({ ok: false, error: "Failed to create minute_book_entries", details: ins.error }, 500);
      }

      minute_book_entry_id = (ins.data as any).id;
    } else {
      minute_book_entry_id = (mbeExisting.data as any).id;
      already_archived = true;
    }

    // 4) Seal the governance record (single source of truth for bucket/path/hash)
    // Must be called via service_role path due to TRUTH LANE LOCK protections.
    // Function signature uses p_ledger_id; also try ledger_id as fallback.
    let sealRes = await supabase.rpc(SEAL_RPC as any, { p_ledger_id: record_id } as any);
    if (sealRes.error) {
      sealRes = await supabase.rpc(SEAL_RPC as any, { ledger_id: record_id } as any);
    }

    if (sealRes.error) {
      return json({ ok: false, error: `${SEAL_RPC} failed`, details: sealRes.error }, 500);
    }

    const seal = sealRes.data as any;
    const sealedBucket = seal?.storage_bucket ?? null;
    const sealedPath = seal?.storage_path ?? null;
    const sealedHash = seal?.file_hash ?? null;
    const sealedSize = seal?.file_size ?? null;
    const sealedMime = seal?.mime_type ?? "application/pdf";
    const sealedFileName = `${record_id}.pdf`;

    if (!sealedPath || !sealedHash) {
      return json(
        {
          ok: false,
          error: "Seal succeeded but returned missing pointers (storage_path/file_hash).",
          seal,
        },
        500,
      );
    }

    // 5) Repair minute_book_entries primary pointers (what CI-Archive Reader needs)
    // Prefer sealed pointers (authoritative). Envelope pointers are secondary.
    const updMbe = await supabase
      .from("minute_book_entries")
      .update({
        title: ledger.title ?? "Untitled",
        source_envelope_id: envelope_id,
        storage_path: sealedPath,
        file_name: sealedFileName,
        pdf_hash: sealedHash,
      } as any)
      .eq("id", minute_book_entry_id);

    if (updMbe.error) {
      return json(
        { ok: false, error: "Failed to persist pointers to minute_book_entries", details: updMbe.error },
        500,
      );
    }

    // 6) Ensure supporting_documents has a PRIMARY doc row (idempotent repair)
    // Your UI evidence panel reads supporting_documents; this prevents “No storage path on primary document”.
    const sdExisting = await supabase
      .from("supporting_documents")
      .select("id, file_path")
      .eq("entry_id", minute_book_entry_id)
      .eq("doc_type", "primary")
      .order("uploaded_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (sdExisting.error) {
      return json({ ok: false, error: "Failed to check supporting_documents", details: sdExisting.error }, 500);
    }

    if (!sdExisting.data) {
      const sdIns = await supabase.from("supporting_documents").insert({
        entry_id: minute_book_entry_id,
        doc_type: "primary",
        file_path: sealedPath,
        file_name: sealedFileName,
        file_hash: sealedHash,
        mime_type: sealedMime,
        file_size: sealedSize,
        uploaded_at: new Date().toISOString(),
        signature_envelope_id: envelope_id,
        verified: true,
        registry_visible: true,
      } as any);

      if (sdIns.error) {
        return json({ ok: false, error: "Failed to insert primary supporting_document", details: sdIns.error }, 500);
      }
    } else if (!(sdExisting.data as any).file_path) {
      const sdUpd = await supabase
        .from("supporting_documents")
        .update({
          file_path: sealedPath,
          file_name: sealedFileName,
          file_hash: sealedHash,
          mime_type: sealedMime,
          file_size: sealedSize,
          signature_envelope_id: envelope_id,
          verified: true,
          registry_visible: true,
        } as any)
        .eq("id", (sdExisting.data as any).id);

      if (sdUpd.error) {
        return json({ ok: false, error: "Failed to repair primary supporting_document", details: sdUpd.error }, 500);
      }
    }

    // 7) Fetch verified registry row (created by seal fn) — DO NOT re-insert (avoid schema mismatch)
    const vd = await supabase
      .from("verified_documents")
      .select("id, storage_bucket, storage_path, file_hash, verification_level, created_at")
      .eq("source_table", "governance_ledger")
      .eq("source_record_id", record_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // vd might fail if your RLS is strict (but service_role should bypass)
    const verified_document = vd.error ? { ok: false, details: vd.error } : (vd.data ?? null);

    return json({
      ok: true,
      record_id,
      envelope_id,
      is_test,
      minute_book_entry_id,
      already_archived,
      pointers: {
        storage_bucket: sealedBucket,
        storage_path: sealedPath,
        file_hash: sealedHash,
      },
      envelope_pointers: envelope_id
        ? { storage_path: envelope_storage_path, storage_hash: envelope_storage_hash }
        : null,
      seal,
      verified_document,
    });
  } catch (e: any) {
    return json({ ok: false, error: e?.message ?? "Unhandled error" }, 500);
  }
});
