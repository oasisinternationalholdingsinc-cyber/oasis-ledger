// supabase/functions/start-signature/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

// Base URL for calling other edge functions (like odp-pdf-engine)
const EDGE_BASE = (SUPABASE_URL ?? "").replace(/\/rest\/v1$/, "");

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, apikey, x-client-info",
    },
  });
}

serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, apikey, x-client-info",
      },
    });
  }

  if (req.method !== "POST") {
    return json({ ok: false, error: "Use POST" }, 405);
  }

  // ---------------------------------------------------------------------------
  // Parse body
  // ---------------------------------------------------------------------------
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const { document_id, entity_slug, record_title, parties } = body ?? {};

  if (!document_id || !entity_slug) {
    return json(
      {
        ok: false,
        error: "document_id and entity_slug are required",
      },
      400,
    );
  }

  if (!Array.isArray(parties) || parties.length === 0) {
    return json(
      {
        ok: false,
        error: "At least one signer (parties[]) is required",
      },
      400,
    );
  }

  try {
    // -----------------------------------------------------------------------
    // 1) Load the governance record (ledger row)
    // -----------------------------------------------------------------------
    const { data: record, error: recErr } = await supabase
      .from("governance_ledger")
      .select("id, title, entity_id")
      .eq("id", document_id)
      .single();

    if (recErr || !record) {
      console.error("governance_ledger fetch error", recErr);
      return json(
        {
          ok: false,
          error: "Record not found in governance_ledger",
        },
        404,
      );
    }

    // -----------------------------------------------------------------------
    // 2) Load the entity (by slug)
    // -----------------------------------------------------------------------
    const { data: entity, error: entErr } = await supabase
      .from("entities")
      .select("id, slug, name")
      .eq("slug", entity_slug)
      .single();

    if (entErr || !entity) {
      console.error("entities fetch error", entErr);
      return json(
        {
          ok: false,
          error: "Entity not found for given slug",
        },
        404,
      );
    }

    // -----------------------------------------------------------------------
    // 3) Find the latest governance_document for this record (if any)
    // -----------------------------------------------------------------------
    const { data: doc, error: docErr } = await supabase
      .from("governance_documents")
      .select("id, storage_path")
      .eq("record_id", record.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (docErr) {
      console.error("governance_documents fetch error", docErr);
    }

    // storage_path is usually like "minute_book/OIH/Folder/File.pdf"
    const storagePath = doc?.storage_path ?? null;

    // supporting_document_path relative to the bucket:
    // e.g. "OIH/Folder/File.pdf"
    let supportingDocumentPath: string | null = null;
    if (storagePath) {
      supportingDocumentPath = storagePath.replace(/^minute_book\//, "");
    }

    if (!supportingDocumentPath) {
      console.warn(
        "start-signature: no supporting document found for record_id",
        record.id,
      );
    }

    // -----------------------------------------------------------------------
    // 4) Create the envelope (link to record + entity + minute_book path)
    // -----------------------------------------------------------------------
    const envelopeTitle =
      record.title ?? record_title ?? "Oasis Governance Record";

    const envelopeMetadata = {
      entity_slug: entity.slug,
      entity_name: entity.name,
      record_id: record.id,
      record_title: envelopeTitle,
      storage_path: storagePath,
      created_by: "ci-forge",
      created_at: new Date().toISOString(),
    };

    const { data: envelope, error: envErr } = await supabase
      .from("signature_envelopes")
      .insert({
        title: envelopeTitle,
        entity_id: entity.id,
        record_id: record.id,
        status: "pending",
        metadata: envelopeMetadata,
        supporting_document_path: supportingDocumentPath,
      })
      .select("id")
      .single();

    if (envErr || !envelope) {
      console.error("signature_envelopes insert error", envErr);
      return json(
        {
          ok: false,
          error: "Failed to create envelope",
          details: envErr,
        },
        500,
      );
    }

    const envelopeId: string = envelope.id;

    // -----------------------------------------------------------------------
    // 4.5) Trigger odp-pdf-engine to generate Oasis-styled base PDF
    //      This is non-fatal if it fails.
    // -----------------------------------------------------------------------
    if (EDGE_BASE) {
      try {
        const engineRes = await fetch(
          `${EDGE_BASE}/functions/v1/odp-pdf-engine`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              apikey: SERVICE_ROLE_KEY,
              Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
            },
            body: JSON.stringify({
              record_id: record.id,
              envelope_id: envelopeId,
            }),
          },
        );

        if (!engineRes.ok) {
          const text = await engineRes.text().catch(() => "");
          console.error(
            "odp-pdf-engine call failed (non-fatal)",
            engineRes.status,
            text,
          );
        } else {
          console.log(
            "✅ odp-pdf-engine successfully triggered for envelope",
            envelopeId,
          );
        }
      } catch (engineErr) {
        console.error("Error calling odp-pdf-engine (non-fatal)", engineErr);
      }
    } else {
      console.error("EDGE_BASE missing; cannot call odp-pdf-engine");
    }

    // -----------------------------------------------------------------------
    // 5) Insert signature_parties rows
    // -----------------------------------------------------------------------
    const partyRows = (parties as any[]).map((p, idx) => ({
      envelope_id: envelopeId,
      email: p.signer_email,
      display_name: p.signer_name,
      role: p.role ?? "signer",
      signing_order: p.signing_order ?? idx + 1,
      status: "pending",
    }));

    const { data: insertedParties, error: partiesErr } = await supabase
      .from("signature_parties")
      .insert(partyRows)
      .select("id, email, display_name, role, signing_order");

    if (partiesErr || !insertedParties || insertedParties.length === 0) {
      console.error("signature_parties insert error", partiesErr);
      return json(
        {
          ok: false,
          error: "Failed to create signature parties",
        },
        500,
      );
    }

    const primaryParty = insertedParties[0];

    // -----------------------------------------------------------------------
    // 6) Queue a background job in signature_jobs (for send-signature-invite)
    // -----------------------------------------------------------------------
    try {
      const primaryEmail = String(primaryParty.email || "").toLowerCase();
      const primaryName =
        primaryParty.display_name || primaryEmail || "Signer";

      const { error: jobErr } = await supabase
        .from("signature_jobs")
        .insert({
          envelope_id: envelopeId,
          record_id: record.id,
          entity_slug: entity.slug,
          signer_email: primaryEmail,
          signer_name: primaryName,
          status: "pending", // default anyway, but explicit is fine
        });

      if (jobErr) {
        console.error(
          "❌ signature_jobs insert error (non-fatal for client):",
          jobErr,
        );
      } else {
        console.log(
          "✅ Queued signature_jobs item for envelope:",
          envelopeId,
        );
      }
    } catch (jobErr) {
      console.error(
        "❌ Unexpected error inserting into signature_jobs (non-fatal):",
        jobErr,
      );
    }

    // -----------------------------------------------------------------------
    // 7) Queue an email job in signature_email_queue (legacy / extra)
    // -----------------------------------------------------------------------
    const { error: queueErr } = await supabase
      .from("signature_email_queue")
      .insert({
        envelope_id: envelopeId,
        party_id: primaryParty.id,
        to_email: primaryParty.email,
        to_name: primaryParty.display_name,
        document_title: envelopeTitle,
        status: "pending",
        attempts: 0,
      });

    if (queueErr) {
      console.error("signature_email_queue insert error", queueErr);
      // non-fatal; worker + direct link can still be used
    }

    // -----------------------------------------------------------------------
    // 8) Log envelope_created event (optional but nice for audit)
    // -----------------------------------------------------------------------
    const { error: eventErr } = await supabase
      .from("signature_events")
      .insert({
        envelope_id: envelopeId,
        event_type: "created",
        metadata: {
          entity_id: entity.id,
          entity_slug: entity.slug,
          record_id: record.id,
          storage_path: storagePath,
          supporting_document_path: supportingDocumentPath,
        },
      });

    if (eventErr) {
      console.error("signature_events insert error", eventErr);
    }

    // -----------------------------------------------------------------------
    // SUCCESS
    // -----------------------------------------------------------------------
    return json({
      ok: true,
      envelope_id: envelopeId,
      record_id: record.id,
      entity_slug: entity.slug,
      storage_path: storagePath,
      supporting_document_path: supportingDocumentPath,
    });
  } catch (e) {
    console.error("Unexpected error in start-signature", e);
    return json(
      {
        ok: false,
        error: "Unexpected server error",
        details: String(e),
      },
      500,
    );
  }
});
