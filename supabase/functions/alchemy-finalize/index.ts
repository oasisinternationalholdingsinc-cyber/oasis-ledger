// supabase/functions/alchemy-finalize/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// ---------------------------------------------------------------------------
// ENV + CLIENT
// ---------------------------------------------------------------------------
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
}
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: {
    fetch
  }
});
// Simple JSON helper with CORS
function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey"
    }
  });
}
// ---------------------------------------------------------------------------
// HTTP HANDLER
// ---------------------------------------------------------------------------
serve(async (req)=>{
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey"
      }
    });
  }
  if (req.method !== "POST") {
    return json({
      ok: false,
      error: "Use POST"
    }, 405);
  }
  // Parse body
  let body;
  try {
    body = await req.json();
  } catch  {
    return json({
      ok: false,
      error: "Invalid JSON body",
      stage: "parse_body"
    });
  }
  const { draft_id } = body ?? {};
  if (!draft_id) {
    return json({
      ok: false,
      error: "draft_id is required",
      stage: "validate"
    });
  }
  try {
    // -----------------------------------------------------------------------
    // 1) Load the draft
    // -----------------------------------------------------------------------
    const { data: draft, error: draftErr } = await supabase.from("governance_drafts").select("id, entity_id, entity_slug, entity_name, title, record_type, draft_text, status, finalized_record_id").eq("id", draft_id).single();
    if (draftErr || !draft) {
      console.error("Draft fetch error", draftErr);
      return json({
        ok: false,
        stage: "draft_lookup",
        error: "Draft not found",
        details: draftErr
      });
    }
    if (draft.status === "finalized" && draft.finalized_record_id) {
      // Already finalized – idempotent return
      return json({
        ok: true,
        stage: "already_finalized",
        ledger_id: draft.finalized_record_id
      });
    }
    if (!draft.entity_id) {
      return json({
        ok: false,
        stage: "draft_validate",
        error: "Draft is missing entity_id"
      });
    }
    if (!draft.draft_text) {
      return json({
        ok: false,
        stage: "draft_validate",
        error: "Draft has no text to finalize"
      });
    }
    // -----------------------------------------------------------------------
    // 2) Insert into governance_ledger
    // -----------------------------------------------------------------------
    // We keep this minimal and let your schema defaults handle status, etc.
    const descriptionPreview = draft.draft_text.length > 240 ? draft.draft_text.slice(0, 240) + "…" : draft.draft_text;
    const provenance = {
      source: "ci-alchemy",
      drafted_by: "scribe",
      draft_id: draft.id,
      entity_slug: draft.entity_slug,
      entity_name: draft.entity_name,
      description_preview: descriptionPreview
    };
    const { data: ledgerRow, error: ledgerErr } = await supabase.from("governance_ledger").insert({
      entity_id: draft.entity_id,
      title: draft.title,
      description: descriptionPreview,
      body: draft.draft_text,
      record_type: draft.record_type ?? "resolution",
      provisional: false,
      needs_summary: true,
      summarized: false,
      ai_status: "drafted",
      source: "ci-alchemy",
      provenance
    }).select("id, created_at, status").single();
    if (ledgerErr || !ledgerRow) {
      console.error("Ledger insert error", ledgerErr);
      return json({
        ok: false,
        stage: "insert_ledger",
        error: "Failed to insert into governance_ledger",
        details: ledgerErr
      });
    }
    const ledgerId = ledgerRow.id;
    // -----------------------------------------------------------------------
    // 3) Update draft → finalized + link ledger record
    // -----------------------------------------------------------------------
    const { error: updateDraftErr } = await supabase.from("governance_drafts").update({
      status: "finalized",
      finalized_record_id: ledgerId,
      updated_at: new Date().toISOString()
    }).eq("id", draft.id);
    if (updateDraftErr) {
      console.error("Draft update error (non-fatal)", updateDraftErr);
    // we still consider the finalize successful, because the ledger row exists
    }
    // -----------------------------------------------------------------------
    // 4) Optional: lightweight event log (if you have signature_events or similar)
    // -----------------------------------------------------------------------
    try {
      await supabase.from("governance_events").insert({
        entity_id: draft.entity_id,
        record_id: ledgerId,
        event_type: "draft_finalized",
        source: "ci-alchemy",
        metadata: {
          draft_id: draft.id,
          entity_slug: draft.entity_slug,
          title: draft.title
        }
      });
    } catch (eventErr) {
      console.error("governance_events insert error (non-fatal)", eventErr);
    }
    // -----------------------------------------------------------------------
    // SUCCESS
    // -----------------------------------------------------------------------
    return json({
      ok: true,
      stage: "done",
      draft_id: draft.id,
      ledger_id: ledgerId,
      ledger_status: ledgerRow.status ?? null,
      ledger_created_at: ledgerRow.created_at
    });
  } catch (e) {
    console.error("Unexpected error in alchemy-finalize", e);
    return json({
      ok: false,
      stage: "exception",
      error: String(e?.message ?? e)
    }, 500);
  }
});
