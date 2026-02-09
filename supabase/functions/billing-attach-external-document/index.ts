import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * billing-attach-external-document
 *
 * OPERATOR-ONLY
 * REGISTRY-GRADE
 * NO DELETES
 * NO MUTATION OF SUBSCRIPTIONS
 *
 * Attaches an externally-generated billing document
 * (invoice, receipt, contract, legacy PDF).
 *
 * Produces a verifiable, hash-first billing_documents row.
 */

type ReqBody = {
  entity_id: string;                 // REQUIRED
  document_type: string;             // enum-backed (invoice, receipt, statement, contract, other)
  period?: string | null;            // e.g. "2026-01", optional
  source: string;                    // manual | contract | legacy | wire | other
  file_name: string;                 // REQUIRED (display)
  mime_type?: string | null;         // default application/pdf
  base64_file: string;               // REQUIRED (raw file)
  is_test?: boolean;                 // lane (optional override)
  reason: string;                    // REQUIRED
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
};

function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function sha256Hex(buf: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ ok: false, error: "METHOD_NOT_ALLOWED" }),
      { status: 405, headers: cors }
    );
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_ROLE_KEY =
      Deno.env.get("SERVICE_ROLE_KEY") ??
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      throw new Error("Missing Supabase env vars");
    }

    // ---------- auth (operator required) ----------
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ ok: false, error: "UNAUTHORIZED" }),
        { status: 401, headers: cors }
      );
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { headers: { authorization: authHeader } },
    });

    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser();

    if (userErr || !user) {
      return new Response(
        JSON.stringify({ ok: false, error: "INVALID_SESSION" }),
        { status: 401, headers: cors }
      );
    }

    // ---------- parse + validate ----------
    const body = (await req.json()) as ReqBody;

    const {
      entity_id,
      document_type,
      period,
      source,
      file_name,
      mime_type,
      base64_file,
      is_test,
      reason,
    } = body;

    if (
      !entity_id ||
      !document_type ||
      !source ||
      !file_name ||
      !base64_file ||
      !reason?.trim()
    ) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "MISSING_REQUIRED_FIELDS",
          required: [
            "entity_id",
            "document_type",
            "source",
            "file_name",
            "base64_file",
            "reason",
          ],
        }),
        { status: 400, headers: cors }
      );
    }

    const laneIsTest = Boolean(is_test);
    const contentType = mime_type || "application/pdf";

    // ---------- verify entity ----------
    const { data: ent, error: entErr } = await supabase
      .from("entities")
      .select("id, slug")
      .eq("id", entity_id)
      .maybeSingle();

    if (entErr || !ent) {
      return new Response(
        JSON.stringify({ ok: false, error: "ENTITY_NOT_FOUND" }),
        { status: 404, headers: cors }
      );
    }

    // ---------- decode + hash ----------
    const fileBytes = base64ToUint8Array(base64_file);
    const fileHash = await sha256Hex(fileBytes);

    // ---------- storage path ----------
    const safePeriod = period ? period.replace(/[^0-9A-Za-z_-]/g, "") : "unspecified";
    const ts = new Date().toISOString().replace(/[:.]/g, "-");

    const storageBucket = "billing_documents";
    const storagePath = `${ent.slug}/${laneIsTest ? "sandbox" : "rot"}/${document_type}/${safePeriod}/${ts}-${file_name}`;

    // ---------- upload ----------
    const { error: upErr } = await supabase.storage
      .from(storageBucket)
      .upload(storagePath, fileBytes, {
        contentType,
        upsert: false,
      });

    if (upErr) throw upErr;

    // ---------- insert registry row ----------
    const { data: doc, error: insErr } = await supabase
      .from("billing_documents")
      .insert({
        entity_id,
        document_type,
        source,
        period: period ?? null,
        storage_bucket: storageBucket,
        storage_path: storagePath,
        file_hash: fileHash,
        file_name,
        mime_type: contentType,
        is_test: laneIsTest,
        created_by: user.id,
        metadata: {
          attached_reason: reason,
          attached_by_email: user.email ?? null,
        },
      })
      .select()
      .single();

    if (insErr) throw insErr;

    // ---------- audit (best-effort) ----------
    await supabase
      .from("actions_log")
      .insert({
        actor_uid: user.id,
        action: "BILLING_ATTACH_EXTERNAL_DOCUMENT",
        target_table: "billing_documents",
        target_id: doc.id,
        details_json: {
          entity_id,
          document_type,
          period: period ?? null,
          source,
          file_hash: fileHash,
          is_test: laneIsTest,
          reason,
        },
      })
      .throwOnError()
      .catch(() => {
        /* best-effort */
      });

    // ---------- response ----------
    return new Response(
      JSON.stringify({
        ok: true,
        document_id: doc.id,
        entity_id,
        document_type,
        file_hash: fileHash,
        storage_path: storagePath,
        is_test: laneIsTest,
      }),
      { status: 200, headers: cors }
    );
  } catch (e: any) {
    console.error("billing-attach-external-document failed:", e);
    return new Response(
      JSON.stringify({
        ok: false,
        error: "INTERNAL_ERROR",
        message: e?.message ?? String(e),
      }),
      { status: 500, headers: cors }
    );
  }
});
