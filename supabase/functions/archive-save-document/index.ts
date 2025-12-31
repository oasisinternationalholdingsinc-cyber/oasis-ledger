import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  record_id: string;   // governance_ledger.id
  envelope_id: string; // signature_envelopes.id (optional but strongly recommended)
  is_test?: boolean;
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
const MINUTE_BOOK_BUCKET = "minute_book"; // your bucket name

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const body = (await req.json()) as ReqBody;

    const record_id = (body?.record_id ?? "").trim();
    const envelope_id = (body?.envelope_id ?? "").trim();
    const is_test = asBool(body?.is_test, false);

    if (!record_id) return json({ ok: false, error: "record_id is required" }, 400);

    // 1) Load ledger (service_role: bypasses RLS)
    const led = await supabase
      .from("governance_ledger")
      .select("id, title, status, is_test, entity_id, archived, approved_by")
      .eq("id", record_id)
      .maybeSingle();

    if (led.error || !led.data) {
      return json({ ok: false, error: "governance_ledger row not found", details: led.error ?? null }, 404);
    }

    const ledger = led.data as any;

    // IMPORTANT: eligibility gate — treat STATUS as truth (your seal fn is stricter, but Council sets status)
    if (ledger.status !== "APPROVED") {
      return json(
        { ok: false, error: "Ledger not APPROVED; cannot archive", status: ledger.status },
        400,
      );
    }

    // 2) Load envelope (optional but recommended)
    let envStoragePath: string | null = null;
    if (envelope_id) {
      const env = await supabase
        .from("signature_envelopes")
        .select("id, record_id, status, storage_path, storage_hash, certificate_path")
        .eq("id", envelope_id)
        .maybeSingle();

      if (env.error || !env.data) {
        return json({ ok: false, error: "signature_envelopes row not found", details: env.error ?? null }, 404);
      }

      if ((env.data as any).record_id !== record_id) {
        return json({ ok: false, error: "Envelope does not belong to record_id", record_id, envelope_id }, 400);
      }

      const envStatus = ((env.data as any).status as string | null) ?? null;
      if (envStatus !== "completed") {
        return json({ ok: false, error: "Envelope not completed", envelope_status: envStatus }, 400);
      }

      envStoragePath = ((env.data as any).storage_path as string | null) ?? null;
    }

    // 3) Ensure minute_book_entries row exists (idempotent)
    const existing = await supabase
      .from("minute_book_entries")
      .select("id, storage_path, pdf_hash, file_name")
      .eq("source_record_id", record_id)
      .maybeSingle();

    // Create if missing
    let minute_book_entry_id: string;
    if (!existing.data) {
      const ins = await supabase
        .from("minute_book_entries")
        .insert({
          source_record_id: record_id,
          source_envelope_id: envelope_id || null,
          is_test,
          title: ledger.title ?? "Untitled",
          // pointers can be filled below after we compute them
        })
        .select("id")
        .single();

      if (ins.error) {
        return json({ ok: false, error: "Failed to create minute_book_entries", details: ins.error }, 500);
      }
      minute_book_entry_id = (ins.data as any).id;
    } else {
      minute_book_entry_id = (existing.data as any).id;
    }

    // 4) Repair primary storage pointers if missing (this is what your UI needs)
    // Prefer envelope storage_path if present; else fall back to deterministic path convention.
    const computedPath =
      envStoragePath ??
      `holdings/Resolutions/${record_id}.pdf`; // fallback; your screenshot matches this pattern

    const computedFileName = `${record_id}.pdf`;

    const needPointerRepair =
      !existing.data ||
      !(existing.data as any).storage_path ||
      !(existing.data as any).file_name;

    if (needPointerRepair) {
      const upd = await supabase
        .from("minute_book_entries")
        .update({
          storage_path: computedPath,
          file_name: computedFileName,
          source_envelope_id: envelope_id || null,
          is_test,
        })
        .eq("id", minute_book_entry_id);

      if (upd.error) {
        return json({ ok: false, error: "Failed to update minute_book_entries pointers", details: upd.error }, 500);
      }
    }

    // 5) Seal (service_role only; TRUTH LANE LOCK enforced in DB)
    // Your function signature is: seal_governance_record_for_archive(p_ledger_id uuid) returns jsonb
    const sealRes = await supabase.rpc(SEAL_RPC, { p_ledger_id: record_id });

    if (sealRes.error) {
      return json(
        { ok: false, error: `${SEAL_RPC} failed`, details: sealRes.error },
        500,
      );
    }

    const seal = sealRes.data as any;

    // We expect seal json to include bucket/path/hash + verified doc id (based on your earlier design)
    const sealedBucket =
      seal?.storage_bucket ?? seal?.bucket ?? MINUTE_BOOK_BUCKET;
    const sealedPath =
      seal?.storage_path ?? seal?.path ?? computedPath;
    const sealedHash =
      seal?.file_hash ?? seal?.hash ?? null;
    const verified_document_id =
      seal?.verified_document_id ?? seal?.verified_id ?? seal?.verified_document?.id ?? null;

    // 6) Persist hash/pointers onto minute_book_entries (so Reader + audit show correctly)
    const upd2 = await supabase
      .from("minute_book_entries")
      .update({
        storage_path: sealedPath,
        pdf_hash: sealedHash,
        file_name: computedFileName,
      })
      .eq("id", minute_book_entry_id);

    if (upd2.error) {
      return json({ ok: false, error: "Failed to persist seal pointers to minute_book_entries", details: upd2.error }, 500);
    }

    // 7) Ensure verified_documents row exists (idempotent)
    // NOTE: your schema uses source_record_id (NOT source_entry_id).
    const vdExisting = await supabase
      .from("verified_documents")
      .select("id")
      .eq("source_record_id", record_id)
      .maybeSingle();

    let verified_document: any = null;

    if (!vdExisting.data) {
      const vdIns = await supabase
        .from("verified_documents")
        .insert({
          source_record_id: record_id,
          storage_bucket: sealedBucket,
          storage_path: sealedPath,
          file_hash: sealedHash,
          is_test,
        })
        .select("*")
        .single();

      if (vdIns.error) {
        // Do NOT fail the whole archive if verified insert fails — but surface it.
        verified_document = { ok: false, error: "verified_documents insert failed", details: vdIns.error };
      } else {
        verified_document = vdIns.data;
      }
    } else {
      // repair/update pointers
      const vdUpd = await supabase
        .from("verified_documents")
        .update({
          storage_bucket: sealedBucket,
          storage_path: sealedPath,
          file_hash: sealedHash,
          is_test,
        })
        .eq("id", (vdExisting.data as any).id)
        .select("*")
        .single();

      if (vdUpd.error) {
        verified_document = { ok: false, error: "verified_documents update failed", details: vdUpd.error };
      } else {
        verified_document = vdUpd.data;
      }
    }

    return json({
      ok: true,
      record_id,
      envelope_id: envelope_id || null,
      is_test,
      minute_book_entry_id,
      pointers: {
        bucket: sealedBucket,
        path: sealedPath,
        hash: sealedHash,
      },
      seal,
      verified_document,
    });
  } catch (e: any) {
    return json({ ok: false, error: e?.message ?? "Unhandled error" }, 500);
  }
});
