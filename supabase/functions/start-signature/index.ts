// supabase/functions/start-signature/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
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

// ✅ NO-404 / NO-REGRESSION: always build the correct base for /functions/v1
// Handles both:
// - https://xyz.supabase.co
// - https://xyz.supabase.co/rest/v1
const EDGE_BASE = SUPABASE_URL
  .replace(/\/rest\/v1\/?$/, "")
  .replace(/\/+$/, "");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, apikey, x-client-info",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

/**
 * 🔐 PARTY TOKEN GENERATOR (CAPABILITY TOKEN)
 * - Cryptographically secure
 * - Non-guessable
 * - Used for signer authorization (NOT identity)
 */
function generatePartyToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

type PartyInput = {
  signer_email: string;
  signer_name: string;
  role?: string; // "signer" | "viewer" etc
  signing_order?: number;
};

type ReqBody = {
  record_id: string; // governance_ledger.id
  entity_slug: string; // entities.slug (must match record.entity_id)
  parties: PartyInput[]; // at least 1
};

serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);

  let body: ReqBody;
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const { record_id, entity_slug, parties } = body ?? ({} as ReqBody);

  if (!record_id || !entity_slug) {
    return json(
      { ok: false, error: "record_id and entity_slug are required" },
      400,
    );
  }

  if (!Array.isArray(parties) || parties.length === 0) {
    return json(
      { ok: false, error: "At least one signer (parties[]) is required" },
      400,
    );
  }

  // basic normalization
  const normalizedParties = parties
    .map((p, i) => ({
      signer_email: String(p.signer_email ?? "").trim().toLowerCase(),
      signer_name: String(p.signer_name ?? "").trim(),
      role: String(p.role ?? "signer").trim() || "signer",
      signing_order: Number.isFinite(p.signing_order)
        ? Number(p.signing_order)
        : i + 1,
    }))
    .filter((p) => p.signer_email && p.signer_name);

  if (normalizedParties.length === 0) {
    return json(
      { ok: false, error: "parties[] missing valid signer_email/signer_name" },
      400,
    );
  }

  try {
    // ---------------------------------------------------------------------
    // 1) Load governance record (source of truth for entity + lane)
    // ---------------------------------------------------------------------
    const { data: record, error: recErr } = await supabase
      .from("governance_ledger")
      .select("id, title, entity_id, is_test, created_by")
      .eq("id", record_id)
      .single();

    if (recErr || !record) {
      return json({ ok: false, error: "Governance record not found" }, 404);
    }

    // ---------------------------------------------------------------------
    // 2) Load entity by slug + verify it matches the record.entity_id
    // ---------------------------------------------------------------------
    const { data: entity, error: entErr } = await supabase
      .from("entities")
      .select("id, slug, name")
      .eq("slug", entity_slug)
      .single();

    if (entErr || !entity) {
      return json({ ok: false, error: "Entity not found" }, 404);
    }

    if (entity.id !== record.entity_id) {
      return json(
        {
          ok: false,
          error:
            "Entity mismatch: entity_slug does not match governance_ledger.entity_id",
          details: {
            record_entity_id: record.entity_id,
            provided_entity_id: entity.id,
          },
        },
        409,
      );
    }

    const laneIsTest = Boolean(record.is_test);

    // ---------------------------------------------------------------------
    // 3) If a COMPLETED envelope already exists, do NOT touch it (immutability).
    // ---------------------------------------------------------------------
    const { data: completedEnvelope } = await supabase
      .from("signature_envelopes")
      .select("id, status")
      .eq("record_id", record.id)
      .eq("entity_id", entity.id)
      .eq("status", "completed")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (completedEnvelope?.id) {
      return json({
        ok: true,
        envelope_id: completedEnvelope.id,
        record_id: record.id,
        entity_slug: entity.slug,
        reused: true,
        reason: "envelope_already_completed",
      });
    }

    // ---------------------------------------------------------------------
    // 4) Reuse latest pending/in_progress envelope (enterprise rule)
    // ---------------------------------------------------------------------
    const { data: existingEnvelope } = await supabase
      .from("signature_envelopes")
      .select("id, status, is_test")
      .eq("record_id", record.id)
      .eq("entity_id", entity.id)
      .in("status", ["pending", "in_progress"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let envelopeId: string;
    let reused = false;

    if (existingEnvelope?.id) {
      envelopeId = existingEnvelope.id;
      reused = true;

      // keep lane aligned (ONLY for non-completed envelopes)
      if (existingEnvelope.is_test !== laneIsTest) {
        await supabase
          .from("signature_envelopes")
          .update({ is_test: laneIsTest })
          .eq("id", envelopeId);
      }
    } else {
      // -------------------------------------------------------------------
      // 5) Create a new envelope (lane-safe at creation)
      // -------------------------------------------------------------------
      const { data: doc } = await supabase
        .from("governance_documents")
        .select("storage_path")
        .eq("record_id", record.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const supportingPath = doc?.storage_path
        ? String(doc.storage_path).replace(/^minute_book\//, "")
        : null;

      const { data: envelope, error: envErr } = await supabase
        .from("signature_envelopes")
        .insert({
          title: record.title ?? "Oasis Governance Record",
          entity_id: entity.id,
          record_id: record.id,
          status: "pending",
          is_test: laneIsTest,
          supporting_document_path: supportingPath,
          metadata: {
            entity_slug: entity.slug,
            entity_name: entity.name,
            record_id: record.id,
            is_test: laneIsTest,
            created_by: "ci-forge",
            created_at: new Date().toISOString(),
          },
        })
        .select("id")
        .single();

      if (envErr || !envelope) {
        return json({ ok: false, error: "Failed to create envelope" }, 500);
      }

      envelopeId = envelope.id;

      // -------------------------------------------------------------------
      // 6) Generate the signing PDF (NON-ARCHIVE) — wiring unchanged
      // -------------------------------------------------------------------
      await fetch(`${EDGE_BASE}/functions/v1/odp-pdf-engine`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({
          record_id: record.id,
          envelope_id: envelopeId,
          is_test: laneIsTest,
        }),
      }).catch(() => {
        // best-effort; do not block start-signature
      });
    }

    // ---------------------------------------------------------------------
    // 7) Insert signature parties (avoid duplicates if UI retries)
    // ---------------------------------------------------------------------
    const { data: existingParties } = await supabase
      .from("signature_parties")
      .select("email")
      .eq("envelope_id", envelopeId);

    const existingEmails = new Set(
      (existingParties ?? [])
        .map((r: any) => String(r.email ?? "").trim().toLowerCase())
        .filter(Boolean),
    );

    const toInsert = normalizedParties
      .filter((p) => !existingEmails.has(p.signer_email))
      .map((p) => ({
        envelope_id: envelopeId,
        email: p.signer_email,
        display_name: p.signer_name,
        role: p.role ?? "signer",
        signing_order: p.signing_order,
        status: "pending",
        // ✅ capability token for signer links
        party_token: generatePartyToken(),
      }));

    let insertedParties: Array<{ id: string; email: string; display_name: string }> =
      [];
    if (toInsert.length > 0) {
      const { data } = await supabase
        .from("signature_parties")
        .insert(toInsert)
        .select("id, email, display_name");
      insertedParties = (data ?? []) as any;
    }

    // ---------------------------------------------------------------------
    // 8) Queue email + job for the “primary” signer (wiring unchanged)
    // ---------------------------------------------------------------------
    let primaryParty:
      | { id: string; email: string; display_name: string }
      | null = insertedParties[0] ?? null;

    if (!primaryParty) {
      const primaryEmail = normalizedParties[0].signer_email;
      const { data: existingPrimary } = await supabase
        .from("signature_parties")
        .select("id, email, display_name")
        .eq("envelope_id", envelopeId)
        .eq("email", primaryEmail)
        .maybeSingle();
      if (existingPrimary?.id) primaryParty = existingPrimary as any;
    }

    if (primaryParty) {
      await supabase.from("signature_jobs").insert({
        envelope_id: envelopeId,
        record_id: record.id,
        entity_slug: entity.slug,
        signer_email: primaryParty.email,
        signer_name: primaryParty.display_name,
        status: "pending",
      });

      await supabase.from("signature_email_queue").insert({
        envelope_id: envelopeId,
        party_id: primaryParty.id,
        to_email: primaryParty.email,
        to_name: primaryParty.display_name,
        document_title: record.title,
        status: "pending",
        attempts: 0,
      });
    }

    // ---------------------------------------------------------------------
    // 9) Audit event (wiring unchanged)
    // ---------------------------------------------------------------------
    await supabase.from("signature_events").insert({
      envelope_id: envelopeId,
      event_type: reused ? "reused" : "created",
      metadata: {
        record_id: record.id,
        entity_slug: entity.slug,
        is_test: laneIsTest,
      },
    });

    return json({
      ok: true,
      envelope_id: envelopeId,
      record_id: record.id,
      entity_slug: entity.slug,
      is_test: laneIsTest,
      reused,
    });
  } catch (e) {
    console.error("start-signature error", e);
    return json({ ok: false, error: "Unexpected server error" }, 500);
  }
});
