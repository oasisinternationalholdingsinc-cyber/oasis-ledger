import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

const MINUTE_BOOK_BUCKET =
  Deno.env.get("MINUTE_BOOK_BUCKET") ?? "minute_book";

const corsHeaders: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  try {
    const body = await req.json().catch(() => ({}));

    // Required: ledger id for the source record
    const source_record_id: string | undefined = body.source_record_id;

    // Optional fields (for future pdf upload / context)
    const pdf_base64: string | undefined = body.pdf_base64;
    const bucket: string = body.bucket ?? MINUTE_BOOK_BUCKET;
    const storagePath: string | null = body.storagePath ?? null;
    const envelope_id: string | null = body.envelope_id ?? null;

    if (!source_record_id) {
      return json(
        {
          ok: false,
          error: "Missing required field: source_record_id",
          required: ["source_record_id"],
          received: { source_record_id },
        },
        400,
      );
    }

    // 1) Look up the ledger record using the current schema
    const { data: ledger, error: ledgerErr } = await supabase
      .from("governance_ledger")
      .select(
        `
          id,
          title,
          record_type,
          entity_id,
          entities!inner (
            slug,
            name
          )
        `,
      )
      .eq("id", source_record_id)
      .maybeSingle();

    if (ledgerErr) {
      console.error("archive-save-document: ledger lookup error", ledgerErr);
      return json(
        {
          ok: false,
          error: "Ledger record not found",
          details: ledgerErr.message,
          source_record_id,
        },
        404,
      );
    }

    if (!ledger) {
      return json(
        {
          ok: false,
          error: "Ledger record not found",
          source_record_id,
        },
        404,
      );
    }

    const entity_id: string | null = (ledger as any).entity_id ?? null;
    const entitySlug: string | null = (ledger as any).entities?.slug ?? null;
    const entityName: string | null = (ledger as any).entities?.name ?? null;

    if (!entitySlug) {
      return json(
        {
          ok: false,
          error:
            "Ledger record found, but entity slug (entities.slug) is missing.",
          source_record_id,
        },
        400,
      );
    }

    if (!entity_id) {
      return json(
        {
          ok: false,
          error:
            "Ledger record found, but entity_id is missing for this record.",
          source_record_id,
        },
        400,
      );
    }

    const entity_key = entitySlug as string;
    const title: string =
      (ledger as any).title ?? "Signed governance record";
    const record_type: string =
      (ledger as any).record_type ?? "resolution";

    // 2) Decide section name based on record_type
    let section_name = "Resolutions";
    if (
      record_type.toLowerCase().includes("special") ||
      record_type.toLowerCase().includes("extraordinary")
    ) {
      section_name = "SpecialResolutions";
    }

    // 3) Optional: check if already archived (by ledger record id + entity)
    const { data: existing, error: existingErr } = await supabase
      .from("minute_book_entries")
      .select("id")
      .eq("entity_key", entity_key)
      .eq("entity_id", entity_id)
      .eq("source_record_id", source_record_id)
      .limit(1);

    if (existingErr) {
      console.error(
        "archive-save-document: check existing error",
        existingErr,
      );
    }

    if (existing && existing.length > 0) {
      return json({
        ok: true,
        minute_book_entry_id: existing[0].id,
        already_archived: true,
      });
    }

    // 4) Decide storage_path for the archive entry
    let finalStoragePath = storagePath;
    if (!finalStoragePath) {
      const safeTitle = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/gi, "-")
        .replace(/^-+|-+$/g, "");
      finalStoragePath = `${entity_key}/${section_name}/${source_record_id}-${safeTitle}.pdf`;
    }

    // 5) (Optional) If you want, you can decode pdf_base64 and upload here using
    // supabase.storage.from(bucket).upload(finalStoragePath, ...)

    // 6) Insert into minute_book_entries (✅ include entity_id, ❌ no storage_bucket)
    const entry_date = new Date().toISOString().slice(0, 10);

    const { data: insertRows, error: insertErr } = await supabase
      .from("minute_book_entries")
      .insert([
        {
          entity_key,            // e.g. "holdings"
          entity_id,             // ✅ required NOT NULL column
          entry_date,
          entry_type: record_type,
          title,
          notes: envelope_id
            ? `Archived from envelope ${envelope_id}`
            : "Archived signed record",
          section_name,
          storage_path: finalStoragePath,
          source: "signed_record",
          source_record_id,
        },
      ])
      .select("id")
      .single();

    if (insertErr) {
      console.error(
        "archive-save-document: insert minute_book_entries error",
        insertErr,
      );
      return json(
        {
          ok: false,
          error: "Failed to insert minute book entry",
          details: insertErr.message,
        },
        500,
      );
    }

    return json({
      ok: true,
      minute_book_entry_id: insertRows?.id ?? null,
      already_archived: false,
    });
  } catch (err) {
    console.error("archive-save-document: unexpected error", err);
    return json(
      {
        ok: false,
        error:
          err instanceof Error ? err.message : "Unexpected error in function.",
      },
      500,
    );
  }
});
