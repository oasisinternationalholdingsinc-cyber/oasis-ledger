// supabase/functions/send-signature-invite/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "npm:resend@4.0.0";

// ---------------------------------------------------------------------------
// ENV + CLIENT
// ---------------------------------------------------------------------------
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

const FROM_EMAIL =
  Deno.env.get("SIGNATURE_FROM_EMAIL") ?? "signatures@oasisintlholdings.com";
const FROM_NAME =
  Deno.env.get("SIGNATURE_FROM_NAME") ?? "Oasis Digital Parliament";

const SIGNING_BASE_URL =
  Deno.env.get("SIGNING_BASE_URL") ?? "https://sign.oasisintlholdings.com/sign";

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// ---------------------------------------------------------------------------
// RESPONSES + UTILS
// ---------------------------------------------------------------------------
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, apikey, x-client-info",
  };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

function escapeHtml(input: unknown): string {
  const s = String(input ?? "");
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function laneLabel(isTest: boolean | null | undefined) {
  return isTest ? "SANDBOX" : "RoT";
}

function normEmail(input: unknown): string {
  return String(input ?? "").trim().toLowerCase();
}

function safeStr(input: unknown): string {
  return String(input ?? "").trim();
}

/**
 * 🔐 PARTY TOKEN GENERATOR (CAPABILITY TOKEN)
 * - Cryptographically secure
 * - Non-guessable
 */
function generatePartyToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------
type QueueJob = {
  id: string;
  envelope_id: string;
  party_id: string;
  to_email: string;
  to_name: string | null;
  document_title: string | null;
  status: string;
  attempts: number | null;

  // optional if present
  entity_slug?: string | null;
  is_test?: boolean | null;
};

type EnvelopeLookup = { record_id?: string | null; is_test?: boolean | null };
type LedgerLookup = { entity_id?: string | null; is_test?: boolean | null };
type EntityLookup = { slug?: string | null; name?: string | null };
type PartyLookup = { party_token?: string | null; status?: string | null };

type InviteBody = {
  // API mode (Forge calls this)
  envelope_id: string;
  signer_email: string;
  signer_name?: string | null;
  document_title?: string | null;
  entity_slug?: string | null;
  is_test?: boolean | null;

  // optional: immediate send vs enqueue-only
  send_now?: boolean | null;
};

// ---------------------------------------------------------------------------
// CONTEXT HELPERS (BEST EFFORT — NEVER BLOCK)
// ---------------------------------------------------------------------------
async function bestEffortContextFromEnvelope(envelopeId: string): Promise<{
  entitySlug: string | null;
  entityName: string | null;
  isTest: boolean;
  recordId: string | null;
}> {
  let entitySlug: string | null = null;
  let entityName: string | null = null;
  let isTest: boolean | null = null;
  let recordId: string | null = null;

  try {
    const envRes = await supabase
      .from("signature_envelopes")
      .select("record_id, is_test")
      .eq("id", envelopeId)
      .maybeSingle();

    if (!envRes.error && envRes.data) {
      const env = envRes.data as EnvelopeLookup;
      recordId = (env.record_id ?? null) || null;
      if (typeof env.is_test === "boolean") isTest = env.is_test;
    }

    if (recordId) {
      const glRes = await supabase
        .from("governance_ledger")
        .select("entity_id, is_test")
        .eq("id", recordId)
        .maybeSingle();

      if (!glRes.error && glRes.data) {
        const gl = glRes.data as LedgerLookup;
        if (typeof gl.is_test === "boolean" && isTest === null) isTest = gl.is_test;

        if (gl.entity_id) {
          const entRes = await supabase
            .from("entities")
            .select("slug, name")
            .eq("id", gl.entity_id)
            .maybeSingle();

          if (!entRes.error && entRes.data) {
            const ent = entRes.data as EntityLookup;
            entitySlug = (ent.slug ?? null) || null;
            entityName = (ent.name ?? null) || null;
          }
        }
      }
    }
  } catch {
    // never block
  }

  return { entitySlug, entityName, isTest: isTest ?? false, recordId };
}

async function bestEffortContext(job: QueueJob): Promise<{
  entitySlug: string | null;
  entityName: string | null;
  isTest: boolean;
  recordId: string | null;
}> {
  // prefer job hints, then enrich from DB
  const seeded = {
    entitySlug: (job.entity_slug ?? null) || null,
    entityName: null as string | null,
    isTest: typeof job.is_test === "boolean" ? job.is_test : null,
    recordId: null as string | null,
  };

  const enriched = await bestEffortContextFromEnvelope(job.envelope_id);

  return {
    entitySlug: seeded.entitySlug || enriched.entitySlug,
    entityName: enriched.entityName,
    isTest: (seeded.isTest ?? enriched.isTest) ?? false,
    recordId: enriched.recordId,
  };
}

async function bestEffortPartyTokenByParty(
  envelopeId: string,
  partyId: string,
): Promise<string | null> {
  // NO REGRESSION:
  // - If column exists and token present -> use it
  // - If column exists but token missing -> best-effort backfill
  // - If column doesn't exist -> return null (legacy link)
  try {
    const r = await supabase
      .from("signature_parties")
      .select("party_token")
      .eq("id", partyId)
      .eq("envelope_id", envelopeId)
      .maybeSingle();

    if (r.error) return null; // column may not exist or other non-fatal issue

    const row = (r.data ?? null) as PartyLookup | null;
    const existing = row?.party_token ? String(row.party_token) : null;
    if (existing) return existing;

    const token = generatePartyToken();
    const u = await supabase
      .from("signature_parties")
      .update({ party_token: token })
      .eq("id", partyId)
      .eq("envelope_id", envelopeId)
      .is("party_token", null);

    if (u.error) return null;
    return token;
  } catch {
    return null;
  }
}

function buildSigningUrl(args: {
  envelopeId: string;
  partyId: string;
  partyToken: string | null;
}) {
  // IMPORTANT: token param name aligned to your locked capability model:
  // envelope_id + party_id + party_token
  const base =
    `${SIGNING_BASE_URL}?envelope_id=${encodeURIComponent(args.envelopeId)}` +
    `&party_id=${encodeURIComponent(args.partyId)}`;

  return args.partyToken
    ? `${base}&party_token=${encodeURIComponent(args.partyToken)}`
    : base;
}

function buildAuthorityEmailHtml(args: {
  toName: string | null;
  documentTitle: string;
  signingUrl: string;
  entitySlug: string | null;
  lane: "SANDBOX" | "RoT";
  envelopeId: string;
  partyId: string;
}) {
  const toName = (args.toName ?? "").trim();
  const docTitle = args.documentTitle.trim() || "Governance Document";
  const entityToken = args.entitySlug
    ? `Entity: ${escapeHtml(args.entitySlug)}`
    : "Entity: —";
  const laneToken = `Lane: ${escapeHtml(args.lane)}`;
  const envToken = `Envelope: ${escapeHtml(args.envelopeId.slice(0, 8))}…`;
  const partyToken = `Party: ${escapeHtml(args.partyId.slice(0, 8))}…`;

  const preheader =
    "Authority notice: signature execution requested. This link is unique to you; do not forward.";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="x-apple-disable-message-reformatting" />
  <title>Oasis Digital Parliament — Signature Required</title>
</head>
<body style="margin:0; padding:0; background:#070A10;">
  <div style="display:none; font-size:1px; color:#070A10; line-height:1px; max-height:0; max-width:0; opacity:0; overflow:hidden;">
    ${escapeHtml(preheader)}
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#070A10; padding:40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="680" cellpadding="0" cellspacing="0" style="width:680px; max-width:680px;">
          <tr>
            <td>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                style="background: radial-gradient(120% 140% at 50% 0%, #0B1626 0%, #070C14 45%, #060910 100%);
                       border:1px solid rgba(255,255,255,0.08);
                       border-radius:18px;
                       overflow:hidden;
                       box-shadow: 0 18px 70px rgba(0,0,0,0.60);">
                <tr>
                  <td style="padding:22px 26px 18px 26px;">
                    <div style="font-family: ui-sans-serif, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; letter-spacing:.18em; font-size:11px; text-transform:uppercase; color:rgba(255,214,128,0.82);">
                      AUTHORITY NOTICE
                    </div>
                    <div style="margin-top:10px; font-family: ui-sans-serif, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; font-size:26px; font-weight:700; color:rgba(255,255,255,0.92);">
                      Oasis Digital Parliament
                    </div>
                  </td>
                </tr>
                <tr><td style="height:1px; background:rgba(255,255,255,0.08);"></td></tr>
                <tr>
                  <td style="padding:22px 26px 10px 26px;">
                    <div style="font-family: ui-sans-serif, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; font-size:14px; line-height:1.55; color:rgba(255,255,255,0.78);">
                      A governance instrument has been issued for execution within the Oasis Digital Parliament Ledger.
                    </div>

                    <div style="margin-top:14px; font-family: ui-sans-serif, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; font-size:14px; line-height:1.55; color:rgba(255,255,255,0.86);">
                      <span style="color:rgba(255,255,255,0.65);">Document:</span>
                      <strong style="color:rgba(255,255,255,0.92); font-weight:700;">${escapeHtml(docTitle)}</strong>
                    </div>

                    ${
                      toName
                        ? `<div style="margin-top:6px; font-family: ui-sans-serif, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; font-size:12px; line-height:1.5; color:rgba(255,255,255,0.55);">
                      Recipient: ${escapeHtml(toName)}
                    </div>`
                        : ""
                    }

                    <div style="margin-top:22px;">
                      <a href="${escapeHtml(args.signingUrl)}"
                        style="display:inline-block; background:#F0C86F; color:#0B0F16; text-decoration:none;
                               font-family: ui-sans-serif, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
                               font-weight:700; font-size:13px; padding:14px 22px; border-radius:12px;
                               letter-spacing:.08em; text-transform:uppercase;
                               box-shadow: 0 10px 26px rgba(240,200,111,0.20);">
                        Review &amp; Execute
                      </a>
                    </div>

                    <div style="margin-top:14px; font-family: ui-sans-serif, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; font-size:12px; line-height:1.55; color:rgba(255,255,255,0.55);">
                      This link is unique to you. Do not forward or share it.
                    </div>
                  </td>
                </tr>
                <tr><td style="height:1px; background:rgba(255,255,255,0.08);"></td></tr>
                <tr>
                  <td style="padding:16px 26px 18px 26px;">
                    <div style="font-family: ui-sans-serif, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; font-size:11px; line-height:1.6; color:rgba(255,255,255,0.45);">
                      <div>${entityToken} &nbsp;•&nbsp; ${laneToken}</div>
                      <div style="margin-top:2px;">${envToken} &nbsp;•&nbsp; ${partyToken}</div>
                      <div style="margin-top:8px;">Issued by CI-Forge • Logged for audit • Generated automatically. Please do not reply.</div>
                    </div>
                  </td>
                </tr>
              </table>

              <div style="height:18px;"></div>
              <div style="font-family: ui-sans-serif, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; font-size:11px; color:rgba(255,255,255,0.35); text-align:center;">
                Oasis Digital Parliament Authority System
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// QUEUE WORKER (BACKCOMPAT: process oldest pending row)
// ---------------------------------------------------------------------------
async function pickOldestPendingJob(): Promise<{ job: QueueJob | null; err: any | null }> {
  const withOptional = [
    "id",
    "envelope_id",
    "party_id",
    "to_email",
    "to_name",
    "document_title",
    "status",
    "attempts",
    "entity_slug",
    "is_test",
  ].join(", ");

  const coreOnly = [
    "id",
    "envelope_id",
    "party_id",
    "to_email",
    "to_name",
    "document_title",
    "status",
    "attempts",
  ].join(", ");

  let r = await supabase
    .from("signature_email_queue")
    .select(withOptional)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(1);

  if (r.error) {
    r = await supabase
      .from("signature_email_queue")
      .select(coreOnly)
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(1);
  }

  if (r.error) return { job: null, err: r.error };
  const jobs = (r.data ?? []) as unknown as QueueJob[];
  return { job: jobs[0] ?? null, err: null };
}

async function sendOneQueueJob(job: QueueJob) {
  const partyToken = await bestEffortPartyTokenByParty(job.envelope_id, job.party_id);
  const signingUrl = buildSigningUrl({
    envelopeId: job.envelope_id,
    partyId: job.party_id,
    partyToken,
  });

  const ctx = await bestEffortContext(job);
  const lane = laneLabel(ctx.isTest) as "SANDBOX" | "RoT";

  const docTitle = job.document_title ?? "Governance Document";
  const subject = `Oasis Digital Parliament — Signature Required — ${docTitle}`;

  const html = buildAuthorityEmailHtml({
    toName: job.to_name ?? null,
    documentTitle: docTitle,
    signingUrl,
    entitySlug: ctx.entitySlug,
    lane,
    envelopeId: job.envelope_id,
    partyId: job.party_id,
  });

  if (!resend || !RESEND_API_KEY) {
    console.warn("RESEND_API_KEY not configured – logging email instead of sending.");
    console.log({
      to: job.to_email,
      subject,
      signingUrl,
      entity_slug: ctx.entitySlug,
      lane,
      has_party_token: Boolean(partyToken),
    });
  } else {
    await resend.emails.send({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: job.to_email,
      subject,
      html,
    });
  }

  // mark sent
  const { error: updateErr } = await supabase
    .from("signature_email_queue")
    .update({
      status: "sent",
      attempts: (job.attempts ?? 0) + 1,
      sent_at: new Date().toISOString(),
      error_message: null,
    })
    .eq("id", job.id);

  if (updateErr) throw updateErr;

  return { signingUrl, ctx, hasPartyToken: Boolean(partyToken) };
}

// ---------------------------------------------------------------------------
// API MODE (NO REGRESSION): create party + queue row, optionally send now
// This is what Forge UI should call.
// ---------------------------------------------------------------------------
async function upsertPartyAndQueue(inv: InviteBody): Promise<{
  envelopeId: string;
  partyId: string;
  partyToken: string | null;
  queueId: string | null;
  signingUrl: string;
  lane: "SANDBOX" | "RoT";
  entitySlug: string | null;
}> {
  const envelopeId = safeStr(inv.envelope_id);
  const signerEmail = normEmail(inv.signer_email);
  const signerName = safeStr(inv.signer_name ?? "") || null;

  // Validate envelope exists
  const envRes = await supabase
    .from("signature_envelopes")
    .select("id, record_id, is_test")
    .eq("id", envelopeId)
    .maybeSingle();

  if (envRes.error) throw envRes.error;
  if (!envRes.data) throw new Error("ENVELOPE_NOT_FOUND");

  // Best-effort context (lane + entity)
  const ctxFromEnv = await bestEffortContextFromEnvelope(envelopeId);
  const entitySlug = (safeStr(inv.entity_slug ?? "") || ctxFromEnv.entitySlug) ?? null;
  const isTest = typeof inv.is_test === "boolean" ? inv.is_test : ctxFromEnv.isTest;
  const lane = laneLabel(isTest) as "SANDBOX" | "RoT";

  // Upsert party by (envelope_id + email)
  let partyId: string;
  let partyToken: string | null = null;

  const existing = await supabase
    .from("signature_parties")
    .select("id, party_token, status")
    .eq("envelope_id", envelopeId)
    .eq("email", signerEmail)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing.error) {
    // if the table exists but query failed for some reason, treat as hard error
    throw existing.error;
  }

  if (existing.data?.id) {
    partyId = existing.data.id;
    partyToken = (existing.data as PartyLookup).party_token
      ? String((existing.data as PartyLookup).party_token)
      : null;

    // backfill token if missing (safe additive)
    if (!partyToken) {
      partyToken = await bestEffortPartyTokenByParty(envelopeId, partyId);
    }
  } else {
    // create party (try to include token column; if schema lacks it, fallback)
    const token = generatePartyToken();

    // Attempt insert with party_token
    const ins = await supabase
      .from("signature_parties")
      .insert({
        envelope_id: envelopeId,
        email: signerEmail,
        name: signerName,
        status: "pending",
        party_token: token,
      })
      .select("id")
      .single();

    if (!ins.error) {
      partyId = ins.data.id;
      partyToken = token;
    } else {
      // Fallback insert without party_token (legacy schema)
      const ins2 = await supabase
        .from("signature_parties")
        .insert({
          envelope_id: envelopeId,
          email: signerEmail,
          name: signerName,
          status: "pending",
        })
        .select("id")
        .single();

      if (ins2.error) throw ins2.error;
      partyId = ins2.data.id;
      partyToken = null;
    }
  }

  const signingUrl = buildSigningUrl({ envelopeId, partyId, partyToken });

  // Insert queue row if table exists; do not hard-fail if queue schema isn't present
  let queueId: string | null = null;
  const docTitle = safeStr(inv.document_title ?? "") || null;

  try {
    // "idempotent-ish": if a pending job exists within 30s, reuse it
    const recent = await supabase
      .from("signature_email_queue")
      .select("id, status, created_at")
      .eq("envelope_id", envelopeId)
      .eq("party_id", partyId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!recent.error && recent.data?.id) {
      const lastStatus = String((recent.data as any).status ?? "");
      const lastCreatedAt = (recent.data as any).created_at
        ? new Date((recent.data as any).created_at).getTime()
        : 0;

      if (lastStatus === "pending" && lastCreatedAt && Date.now() - lastCreatedAt < 30_000) {
        queueId = recent.data.id;
      }
    }

    if (!queueId) {
      // try insert with optional columns
      const try1 = await supabase
        .from("signature_email_queue")
        .insert({
          envelope_id: envelopeId,
          party_id: partyId,
          to_email: signerEmail,
          to_name: signerName,
          document_title: docTitle,
          status: "pending",
          attempts: 0,
          entity_slug: entitySlug,
          is_test: isTest,
        })
        .select("id")
        .single();

      if (!try1.error) {
        queueId = try1.data.id;
      } else {
        // fallback core columns
        const try2 = await supabase
          .from("signature_email_queue")
          .insert({
            envelope_id: envelopeId,
            party_id: partyId,
            to_email: signerEmail,
            to_name: signerName,
            document_title: docTitle,
            status: "pending",
            attempts: 0,
          })
          .select("id")
          .single();

        if (!try2.error) queueId = try2.data.id;
      }
    }
  } catch {
    // queue is best-effort; do not block invite
    queueId = null;
  }

  return { envelopeId, partyId, partyToken, queueId, signingUrl, lane, entitySlug };
}

async function sendDirectEmail(args: {
  toEmail: string;
  toName: string | null;
  documentTitle: string;
  signingUrl: string;
  entitySlug: string | null;
  lane: "SANDBOX" | "RoT";
  envelopeId: string;
  partyId: string;
}) {
  const subject = `Oasis Digital Parliament — Signature Required — ${args.documentTitle}`;
  const html = buildAuthorityEmailHtml({
    toName: args.toName,
    documentTitle: args.documentTitle,
    signingUrl: args.signingUrl,
    entitySlug: args.entitySlug,
    lane: args.lane,
    envelopeId: args.envelopeId,
    partyId: args.partyId,
  });

  if (!resend || !RESEND_API_KEY) {
    console.warn("RESEND_API_KEY not configured – logging email instead of sending.");
    console.log({
      to: args.toEmail,
      subject,
      signingUrl: args.signingUrl,
      entity_slug: args.entitySlug,
      lane: args.lane,
      has_party_token: args.signingUrl.includes("party_token="),
    });
    return;
  }

  await resend.emails.send({
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to: args.toEmail,
    subject,
    html,
  });
}

// ---------------------------------------------------------------------------
// HANDLER
// ---------------------------------------------------------------------------
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders() });
  }

  if (req.method !== "POST") {
    return json({ ok: false, error: "Use POST" }, 405);
  }

  // Dual-mode (NO REGRESSION):
  // 1) API mode: if body contains envelope_id + signer_email -> enqueue + optionally send
  // 2) Worker mode: if no invite payload -> process oldest pending queue row
  let body: any = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }

  const hasInvitePayload =
    body &&
    typeof body === "object" &&
    safeStr(body.envelope_id || "") &&
    safeStr(body.signer_email || "");

  try {
    if (hasInvitePayload) {
      const inv = body as InviteBody;

      const envelopeId = safeStr(inv.envelope_id);
      const signerEmail = normEmail(inv.signer_email);
      if (!envelopeId) return json({ ok: false, error: "ENVELOPE_REQUIRED" }, 400);
      if (!signerEmail || !signerEmail.includes("@"))
        return json({ ok: false, error: "SIGNER_EMAIL_REQUIRED" }, 400);

      const docTitle = safeStr(inv.document_title ?? "") || "Governance Document";
      const sendNow = inv.send_now !== false; // default true

      const out = await upsertPartyAndQueue(inv);

      if (sendNow) {
        await sendDirectEmail({
          toEmail: signerEmail,
          toName: safeStr(inv.signer_name ?? "") || null,
          documentTitle: docTitle,
          signingUrl: out.signingUrl,
          entitySlug: out.entitySlug,
          lane: out.lane,
          envelopeId: out.envelopeId,
          partyId: out.partyId,
        });

        // best-effort: mark queue sent if we created one
        if (out.queueId) {
          await supabase
            .from("signature_email_queue")
            .update({
              status: "sent",
              sent_at: new Date().toISOString(),
              error_message: null,
            })
            .eq("id", out.queueId);
        }
      }

      return json({
        ok: true,
        message: sendNow ? "Signature invitation email sent." : "Signature invitation queued.",
        envelope_id: out.envelopeId,
        party_id: out.partyId,
        queue_id: out.queueId,
        signing_url: out.signingUrl,
        entity_slug: out.entitySlug,
        lane: out.lane,
        has_party_token: Boolean(out.partyToken),
      });
    }

    // ---------------------------
    // Worker mode (legacy-safe)
    // ---------------------------
    const { job, err } = await pickOldestPendingJob();
    if (err) {
      console.error("signature_email_queue query error", err);
      return json({ ok: false, error: "Failed to read pending signature jobs." }, 500);
    }

    if (!job) {
      return json({ ok: true, message: "No pending signature email jobs." });
    }

    const sent = await sendOneQueueJob(job);

    return json({
      ok: true,
      message: "Signature invitation email sent.",
      job_id: job.id,
      signing_url: sent.signingUrl,
      entity_slug: sent.ctx.entitySlug,
      lane: laneLabel(sent.ctx.isTest),
      has_party_token: sent.hasPartyToken,
    });
  } catch (e) {
    console.error("Unexpected error in send-signature-invite", e);
    return json(
      { ok: false, error: "Unexpected server error", details: String(e?.message ?? e) },
      500,
    );
  }
});
