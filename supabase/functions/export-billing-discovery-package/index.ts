import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { zipSync, strToU8 } from "https://esm.sh/fflate@0.8.2";

type ReqBody = {
  hash?: string;        // sha256 hex
  document_id?: string; // uuid
  include_pdf?: boolean;
  // tolerated (future-proofing)
  expires_in?: number;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Expose-Headers": "content-type, content-disposition, x-sb-request-id",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

function isUuid(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

function isSha256(v: string) {
  return /^[a-f0-9]{64}$/i.test(v);
}

function safeFileName(s: string) {
  const clean = (s || "billing-document")
    .replace(/[^a-z0-9\-_]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 96);
  return clean || "billing-document";
}

async function downloadPdf(bucket: string, path: string): Promise<Uint8Array> {
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error || !data) {
    throw new Error(`STORAGE_DOWNLOAD_FAILED: ${error?.message || "no data"}`);
  }
  const ab = await data.arrayBuffer();
  return new Uint8Array(ab);
}

serve(async (req) => {
  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return json(405, { ok: false, error: "METHOD_NOT_ALLOWED" });

    const body = (await req.json().catch(() => ({}))) as ReqBody;
    const hash = (body.hash || "").trim().toLowerCase();
    const document_id = (body.document_id || "").trim();
    const include_pdf = body.include_pdf !== false; // default true

    if (!hash && !document_id) {
      return json(400, { ok: false, error: "MISSING_IDENTIFIER", message: "Provide hash OR document_id." });
    }
    if (hash && !isSha256(hash)) {
      return json(400, { ok: false, error: "INVALID_HASH", message: "hash must be 64 hex (sha-256)." });
    }
    if (document_id && !isUuid(document_id)) {
      return json(400, { ok: false, error: "INVALID_DOCUMENT_ID", message: "document_id must be a UUID." });
    }

    // -------------------------
    // Resolve billing document (registry)
    // -------------------------
    // IMPORTANT: This assumes billing_documents has:
    // id, entity_id, is_test, status, title, document_number/invoice_number (optional),
    // issued_at (optional), total_amount (optional),
    // file_hash (sha256), storage_bucket, storage_path
    //
    // If your column names differ, tell me and I’ll adjust EXACTLY.
    let doc: any | null = null;

    if (document_id) {
      const { data, error } = await supabase
        .from("billing_documents")
        .select("*")
        .eq("id", document_id)
        .maybeSingle();

      if (error) return json(500, { ok: false, error: "DB_ERROR", details: error.message });
      doc = data;
    } else {
      // hash-first
      const { data, error } = await supabase
        .from("billing_documents")
        .select("*")
        .eq("file_hash", hash)
        .neq("status", "void")
        .order("issued_at", { ascending: false, nullsFirst: false })
        .limit(1);

      if (error) return json(500, { ok: false, error: "DB_ERROR", details: error.message });
      doc = (data && data[0]) ? data[0] : null;
    }

    if (!doc) {
      return json(404, {
        ok: false,
        error: "NOT_REGISTERED",
        message: "No billing document found for the provided identifier.",
      });
    }

    const canonicalHash = (doc.file_hash || "").toString().trim().toLowerCase();
    if (!canonicalHash || !isSha256(canonicalHash)) {
      return json(500, {
        ok: false,
        error: "MISSING_CANONICAL_HASH",
        message: "billing_documents.file_hash missing/invalid. Registry must store canonical sha256.",
      });
    }

    const storage_bucket = doc.storage_bucket || null;
    const storage_path = doc.storage_path || null;

    if (include_pdf && (!storage_bucket || !storage_path)) {
      return json(409, {
        ok: false,
        error: "BILLING_PDF_POINTER_MISSING",
        message: "Registry row exists but storage_bucket/storage_path missing.",
        document_id: doc.id,
      });
    }

    // Optional: entity snapshot (best-effort; no hard dependency)
    let entity: any | null = null;
    if (doc.entity_id) {
      const { data: ent, error: entErr } = await supabase
        .from("entities")
        .select("id, slug, name")
        .eq("id", doc.entity_id)
        .maybeSingle();
      if (!entErr) entity = ent;
    }

    // -------------------------
    // Build ZIP payloads
    // -------------------------
    const nowIso = new Date().toISOString();
    const lane = (typeof doc.is_test === "boolean") ? (doc.is_test ? "SANDBOX" : "RoT") : "—";
    const title =
      doc.title ||
      doc.invoice_title ||
      doc.document_number ||
      doc.invoice_number ||
      "Billing Document";

    const baseName = safeFileName(
      (doc.document_number || doc.invoice_number || "") ? `${doc.document_number || doc.invoice_number}` : title,
    );

    const verification = {
      ok: true,
      kind: "billing_document",
      file_hash: canonicalHash,
      document_id: doc.id,
      entity_id: doc.entity_id || null,
      is_test: (typeof doc.is_test === "boolean") ? doc.is_test : null,
      lane,
      status: doc.status || null,
      issued_at: doc.issued_at || null,
      exported_at: nowIso,
      verifier: "Oasis Digital Parliament • Billing Registry",
      verify_url: `https://sign.oasisintlholdings.com/verify-billing.html?hash=${canonicalHash}`,
    };

    const manifest = {
      ok: true,
      kind: "discovery_package",
      package_type: "billing",
      exported_at: nowIso,
      document: {
        id: doc.id,
        title,
        status: doc.status || null,
        is_test: (typeof doc.is_test === "boolean") ? doc.is_test : null,
        entity_id: doc.entity_id || null,
        issued_at: doc.issued_at || null,
        total_amount: doc.total_amount ?? null,
        currency: doc.currency ?? null,
        file_hash: canonicalHash,
        storage: include_pdf
          ? { bucket: storage_bucket, path: storage_path }
          : null,
      },
      entity: entity
        ? { id: entity.id, slug: entity.slug, name: entity.name }
        : null,
      files: [
        { path: "README.txt", type: "text/plain" },
        { path: "manifest.json", type: "application/json" },
        { path: "verification.json", type: "application/json" },
        { path: "billing_document.json", type: "application/json" },
        ...(include_pdf ? [{ path: "billing.pdf", type: "application/pdf" }] : []),
      ],
      notes: [
        "This ZIP is non-mutating and registry-derived.",
        "Canonical integrity is anchored by verification.json.file_hash.",
      ],
    };

    const readme =
`OASIS DIGITAL PARLIAMENT — BILLING DISCOVERY PACKAGE
===================================================

This package is produced from the Billing Registry (public.billing_documents).

Integrity Anchor
----------------
- Canonical SHA-256: ${canonicalHash}

How to Verify
-------------
1) Open the verification terminal:
   https://sign.oasisintlholdings.com/verify-billing.html?hash=${canonicalHash}

2) The registry must resolve this hash to a registered billing document.

Contents
--------
- README.txt
- manifest.json
- verification.json
- billing_document.json
${include_pdf ? "- billing.pdf" : ""}

Lane
----
- ${lane}

Exported At
-----------
- ${nowIso}
`;

    const zipFiles: Record<string, Uint8Array> = {
      "README.txt": strToU8(readme),
      "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
      "verification.json": strToU8(JSON.stringify(verification, null, 2)),
      "billing_document.json": strToU8(JSON.stringify(doc, null, 2)),
    };

    if (include_pdf) {
      const pdfBytes = await downloadPdf(storage_bucket, storage_path);
      zipFiles["billing.pdf"] = pdfBytes;
    }

    const zipped = zipSync(zipFiles, { level: 6 });
    const filename = `Oasis-Billing-Discovery-${baseName}-${canonicalHash.slice(0, 10)}.zip`;

    return new Response(zipped, {
      status: 200,
      headers: {
        ...corsHeaders,
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (e) {
    return json(500, {
      ok: false,
      error: "EXPORT_FAILED",
      details: e?.message ? String(e.message) : String(e),
    });
  }
});
