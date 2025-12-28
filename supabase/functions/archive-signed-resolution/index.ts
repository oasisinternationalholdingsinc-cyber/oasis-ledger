// supabase/functions/archive-signed-resolution/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  record_id: string; // governance_ledger.id
  // Optional override, but we DO NOT trust caller for lane; we read governance_ledger.is_test
  is_test?: boolean;
};

function j(res: unknown, status = 200) {
  return new Response(JSON.stringify(res), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pickFirst<T>(arr: T[] | null | undefined): T | null {
  return Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
}

Deno.serve(async (req) => {
  const sbRequestId = req.headers.get("x-sb-request-id") ?? null;

  try {
    if (req.method !== "POST") {
      return j({ ok: false, error: "Method not allowed", sb_request_id: sbRequestId }, 405);
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return j(
        { ok: false, error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY", sb_request_id: sbRequestId },
        500
      );
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const body = (await req.json().catch(() => null)) as ReqBody | null;
    const record_id = body?.record_id?.trim();

    if (!record_id) {
      return j({ ok: false, error: "Missing record_id", sb_request_id: sbRequestId }, 400);
    }

    // 1) Load ledger row (SOURCE OF TRUTH for lane)
    const { data: ledger, error: ledgerErr } = await supabase
      .from("governance_ledger")
      .select("id, title, entity_id, entity_key, domain_key, section_name, is_test, status")
      .eq("id", record_id)
      .maybeSingle();

    if (ledgerErr) {
      return j(
        { ok: false, error: "Failed to load governance_ledger", details: ledgerErr, sb_request_id: sbRequestId },
        500
      );
    }
    if (!ledger) {
      return j({ ok: false, error: "Record not found in governance_ledger", sb_request_id: sbRequestId }, 404);
    }

    const lane_is_test = !!ledger.is_test; // ✅ ALWAYS use this (not envelope.is_test)

    // 2) Find the completed envelope for this record
    const { data: envRows, error: envErr } = await supabase
      .from("signature_envelopes")
      .select("id, record_id, status, completed_at, storage_path, supporting_document_path")
      .eq("record_id", record_id)
      .order("completed_at", { ascending: false, nullsFirst: false })
      .limit(1);

    if (envErr) {
      return j(
        { ok: false, error: "Failed to load signature_envelopes", details: envErr, sb_request_id: sbRequestId },
        500
      );
    }

    const envelope = pickFirst(envRows);
    if (!envelope) {
      return j(
        { ok: false, error: "No signature envelope found for record_id", record_id, sb_request_id: sbRequestId },
        400
      );
    }

    if (String(envelope.status).toLowerCase() !== "completed") {
      return j(
        {
          ok: false,
          error: "Envelope not completed",
          envelope_id: envelope.id,
          envelope_status: envelope.status,
          sb_request_id: sbRequestId,
        },
        400
      );
    }

    // 3) Resolve the SIGNED PDF path in minute_book bucket
    // Primary heuristic: supporting_document_path + "-signed.pdf"
    // Example you showed:
    // supporting_document_path = holdings/Resolutions/<id>.pdf
    // signed should be:        holdings/Resolutions/<id>-signed.pdf
    const SIGNED_BUCKET = "minute_book";

    let signedPath: string | null = null;
    const basePath = (envelope.supporting_document_path || envelope.storage_path || "").trim();

    if (basePath) {
      signedPath = basePath.replace(/\.pdf$/i, "-signed.pdf");
      if (signedPath === basePath) {
        // if it didn't end with .pdf for some reason, try appending
        signedPath = `${basePath}-signed.pdf`;
      }
    }

    // Verify exists; if not, fall back to storage.objects lookup
    async function objectExists(bucket: string, name: string) {
      const { data, error } = await supabase
        .from("storage.objects")
        .select("name")
        .eq("bucket_id", bucket)
        .eq("name", name)
        .limit(1);

      if (error) return { ok: false as const, error };
      return { ok: true as const, exists: (data?.length ?? 0) > 0 };
    }

    if (signedPath) {
      const check = await objectExists(SIGNED_BUCKET, signedPath);
      if (!check.ok || !check.exists) {
        signedPath = null;
      }
    }

    if (!signedPath) {
      // Fallback: search for any *signed* pdf containing this record id
      const pattern = `%${record_id}%-signed.pdf`;
      const { data: objs, error: objErr } = await supabase
        .from("storage.objects")
        .select("name, created_at")
        .eq("bucket_id", SIGNED_BUCKET)
        .ilike("name", pattern)
        .order("created_at", { ascending: false })
        .limit(1);

      if (objErr) {
        return j(
          { ok: false, error: "Failed searching storage.objects for signed PDF", details: objErr, sb_request_id: sbRequestId },
          500
        );
      }

      const hit = pickFirst(objs);
      signedPath = hit?.name ?? null;
    }

    if (!signedPath) {
      return j(
        {
          ok: false,
          error: "Signed PDF not found in storage",
          hint: "Expected minute_book/<...>/<record_id>-signed.pdf",
          record_id,
          envelope_id: envelope.id,
          sb_request_id: sbRequestId,
        },
        500
      );
    }

    // 4) Attempt download (this is what was failing for you before)
    const { data: signedBlob, error: dlErr } = await supabase.storage.from(SIGNED_BUCKET).download(signedPath);

    if (dlErr || !signedBlob) {
      return j(
        {
          ok: false,
          error: "Failed to download signed PDF",
          details: dlErr ?? "download returned null",
          signed_pdf_bucket: SIGNED_BUCKET,
          signed_pdf_path: signedPath,
          record_id,
          envelope_id: envelope.id,
          sb_request_id: sbRequestId,
        },
        500
      );
    }

    // 5) Hand off to archive-save-document (service_role → internal)
    // IMPORTANT: lane comes from ledger.is_test (NOT envelope)
    const archiveUrl = `${SUPABASE_URL}/functions/v1/archive-save-document`;
    const payload = {
      record_id,
      envelope_id: envelope.id,
      is_test: lane_is_test,
      signed_pdf_bucket: SIGNED_BUCKET,
      signed_pdf_path: signedPath,
      // optional context for better logs
      source: "ci-forge",
    };

    const archiveRes = await fetch(archiveUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // use service_role so archive-save-document can write everything it needs
        authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        apikey: SERVICE_ROLE_KEY,
      },
      body: JSON.stringify(payload),
    });

    const archiveJson = await archiveRes.json().catch(() => null);

    if (!archiveRes.ok) {
      return j(
        {
          ok: false,
          error: "archive-save-document failed",
          status: archiveRes.status,
          details: archiveJson,
          sent: payload,
          sb_request_id: sbRequestId,
        },
        500
      );
    }

    return j(
      {
        ok: true,
        record_id,
        envelope_id: envelope.id,
        is_test: lane_is_test,
        signed_pdf_bucket: SIGNED_BUCKET,
        signed_pdf_path: signedPath,
        archive: archiveJson,
        sb_request_id: sbRequestId,
      },
      200
    );
  } catch (e) {
    return j(
      {
        ok: false,
        error: "Unhandled error",
        details: String(e?.message ?? e),
        sb_request_id: sbRequestId,
      },
      500
    );
  }
});
