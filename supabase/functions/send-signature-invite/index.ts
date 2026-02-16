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

function safeStr(input: unknown): string {
  return String(input ?? "").trim();
}

function normEmail(input: unknown): string {
  return String(input ?? "").trim().toLowerCase();
}

function laneLabel(isTest: boolean | null | undefined) {
  return isTest ? "SANDBOX" : "RoT";
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

function buildSigningUrl(args: {
  envelopeId: string;
  partyId: string;
  partyToken: string | null;
}) {
  const base =
    `${SIGNING_BASE_URL}?envelope_id=${encodeURIComponent(args.envelopeId)}` +
    `&party_id=${encodeURIComponent(args.partyId)}`;

  // ✅ canonical param name per your capability model
  return args.partyToken
    ? `${base}&party_token=${encodeURIComponent(args.partyToken)}`
    : base;
}

// ---------------------------------------------------------------------------
// TYPES (aligned to YOUR schema)
// ---------------------------------------------------------------------------
type SignaturePartyRow = {
  id: string;
  envelope_id: string;
  email: string;
  display_name: string | null;
  status: string | null;
  party_token: string | null;
};

type EnvelopeRow = { id: string; record_id: string | null; is_test: boolean | null };

type QueueRow = {
  id: string;
  envelope_id: string;
  party_id: string;
  to_email: string;
  to_name: string | null;
  subject: string | null;
  body: string | null;
  template_key: string | null;
  payload: any | null;
  status: string;
  error_message: string | null;
  attempts: number | null;
  created_at: string;
  sent_at: string | null;
  document_title: string | null;
};

type InviteBody = {
  envelope_id: string;
  signer_email: string;
  signer_name?: string | null;
  document_title?: string | null;

  // default true: send immediately
  send_now?: boolean | null;
};

// ---------------------------------------------------------------------------
// EMAIL TEMPLATE (authority-grade)
// ---------------------------------------------------------------------------
function buildAuthorityEmailHtml(args: {
  toName: string | null;
  documentTitle: string;
  signingUrl: string;
  lane: "SANDBOX" | "RoT";
  envelopeId: string;
  partyId: string;
}) {
  const toName = (args.toName ?? "").trim();
  const docTitle = args.documentTitle.trim() || "Governance Document";
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
                      <div>${laneToken}</div>
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
// DB HELPERS (aligned to your schema)
// ---------------------------------------------------------------------------
async function getEnvelope(envelopeId: string): Promise<EnvelopeRow> {
  const r = await supabase
    .from("signature_envelopes")
    .select("id, record_id, is_test")
    .eq("id", envelopeId)
    .maybeSingle();

  if (r.error) throw r.error;
  if (!r.data) throw new Error("ENVELOPE_NOT_FOUND");
  return r.data as EnvelopeRow;
}

async function upsertParty(envelopeId: string, email: string, displayName: string | null) {
  const existing = await supabase
    .from("signature_parties")
    .select("id, envelope_id, email, display_name, status, party_token")
    .eq("envelope_id", envelopeId)
    .eq("email", email)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing.error) throw existing.error;

  if (existing.data?.id) {
    const row = existing.data as SignaturePartyRow;
    let token = row.party_token ? String(row.party_token) : null;

    if (!token) {
      token = generatePartyToken();
      // best-effort backfill
      const u = await supabase
        .from("signature_parties")
        .update({ party_token: token })
        .eq("id", row.id)
        .eq("envelope_id", envelopeId)
        .is("party_token", null);
      if (u.error) {
        // do not block invite; token can still be null
        token = null;
      }
    }

    // best-effort: update display name if provided and missing
    if (displayName && !row.display_name) {
      await supabase
        .from("signature_parties")
        .update({ display_name: displayName })
        .eq("id", row.id)
        .eq("envelope_id", envelopeId);
    }

    return { partyId: row.id, partyToken: token };
  }

  // create new party (party_token is real column in your schema)
  const token = generatePartyToken();
  const ins = await supabase
    .from("signature_parties")
    .insert({
      envelope_id: envelopeId,
      email,
      display_name: displayName,
      status: "pending",
      party_token: token,
    })
    .select("id")
    .single();

  if (ins.error) throw ins.error;
  return { partyId: ins.data.id as string, partyToken: token };
}

async function createQueueRow(args: {
  envelopeId: string;
  partyId: string;
  toEmail: string;
  toName: string | null;
  subject: string;
  body: string;
  documentTitle: string;
  payload: any;
}) {
  const r = await supabase
    .from("signature_email_queue")
    .insert({
      envelope_id: args.envelopeId,
      party_id: args.partyId,
      to_email: args.toEmail,
      to_name: args.toName,
      subject: args.subject,
      body: args.body,
      template_key: "signature_invite_v1",
      payload: args.payload,
      status: "pending",
      attempts: 0,
      document_title: args.documentTitle,
    })
    .select("id")
    .single();

  if (r.error) throw r.error;
  return r.data.id as string;
}

async function pickOldestPendingJob(): Promise<QueueRow | null> {
  const r = await supabase
    .from("signature_email_queue")
    .select(
      "id,envelope_id,party_id,to_email,to_name,subject,body,template_key,payload,status,error_message,attempts,created_at,sent_at,document_title",
    )
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(1);

  if (r.error) throw r.error;
  const rows = (r.data ?? []) as unknown as QueueRow[];
  return rows[0] ?? null;
}

async function markQueueSent(queueId: string, attempts: number | null) {
  const r = await supabase
    .from("signature_email_queue")
    .update({
      status: "sent",
      attempts: (attempts ?? 0) + 1,
      sent_at: new Date().toISOString(),
      error_message: null,
    })
    .eq("id", queueId);

  if (r.error) throw r.error;
}

async function markQueueFailed(queueId: string, attempts: number | null, msg: string) {
  const r = await supabase
    .from("signature_email_queue")
    .update({
      status: "failed",
      attempts: (attempts ?? 0) + 1,
      error_message: msg.slice(0, 4000),
    })
    .eq("id", queueId);

  if (r.error) throw r.error;
}

async function sendEmailDirect(args: {
  toEmail: string;
  toName: string | null;
  subject: string;
  html: string;
  signingUrl: string;
  lane: "SANDBOX" | "RoT";
  envelopeId: string;
  partyId: string;
  hasPartyToken: boolean;
}) {
  if (!resend || !RESEND_API_KEY) {
    console.warn("RESEND_API_KEY not configured – logging instead of sending.");
    console.log({
      to: args.toEmail,
      subject: args.subject,
      signingUrl: args.signingUrl,
      lane: args.lane,
      envelope_id: args.envelopeId,
      party_id: args.partyId,
      has_party_token: args.hasPartyToken,
    });
    return;
  }

  await resend.emails.send({
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to: args.toEmail,
    subject: args.subject,
    html: args.html,
  });
}

// ---------------------------------------------------------------------------
// HANDLER (API mode + worker mode)
// ---------------------------------------------------------------------------
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders() });
  }

  if (req.method !== "POST") {
    return json({ ok: false, error: "Use POST" }, 405);
  }

  // Dual-mode:
  // - API mode: body has envelope_id + signer_email
  // - Worker mode: no body or missing fields -> process oldest pending queue row
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
    // ---------------------------
    // API MODE (Forge calls this)
    // ---------------------------
    if (hasInvitePayload) {
      const inv = body as InviteBody;

      const envelopeId = safeStr(inv.envelope_id);
      const signerEmail = normEmail(inv.signer_email);
      const signerName = safeStr(inv.signer_name ?? "") || null;
      const docTitle = safeStr(inv.document_title ?? "") || "Governance Document";
      const sendNow = inv.send_now !== false; // default true

      if (!envelopeId) return json({ ok: false, error: "ENVELOPE_REQUIRED" }, 400);
      if (!signerEmail || !signerEmail.includes("@"))
        return json({ ok: false, error: "SIGNER_EMAIL_REQUIRED" }, 400);

      const env = await getEnvelope(envelopeId);
      const lane = laneLabel(env.is_test) as "SANDBOX" | "RoT";

      const { partyId, partyToken } = await upsertParty(
        envelopeId,
        signerEmail,
        signerName,
      );

      const signingUrl = buildSigningUrl({
        envelopeId,
        partyId,
        partyToken,
      });

      const subject = `Oasis Digital Parliament — Signature Required — ${docTitle}`;
      const html = buildAuthorityEmailHtml({
        toName: signerName,
        documentTitle: docTitle,
        signingUrl,
        lane,
        envelopeId,
        partyId,
      });

      // Always log in queue (audit), then optionally send immediately.
      const queueId = await createQueueRow({
        envelopeId,
        partyId,
        toEmail: signerEmail,
        toName: signerName,
        subject,
        body: html,
        documentTitle: docTitle,
        payload: {
          envelope_id: envelopeId,
          party_id: partyId,
          party_token: partyToken,
          signing_url: signingUrl,
          lane,
          record_id: env.record_id,
        },
      });

      if (sendNow) {
        await sendEmailDirect({
          toEmail: signerEmail,
          toName: signerName,
          subject,
          html,
          signingUrl,
          lane,
          envelopeId,
          partyId,
          hasPartyToken: Boolean(partyToken),
        });

        await markQueueSent(queueId, 0);
      }

      return json({
        ok: true,
        message: sendNow ? "Signature invitation email sent." : "Signature invitation queued.",
        envelope_id: envelopeId,
        party_id: partyId,
        queue_id: queueId,
        signing_url: signingUrl,
        lane,
        has_party_token: Boolean(partyToken),
      });
    }

    // ---------------------------
    // WORKER MODE (process queue)
    // ---------------------------
    const job = await pickOldestPendingJob();
    if (!job) {
      return json({ ok: true, message: "No pending signature email jobs." });
    }

    // Prefer job.body/subject if present (already rendered in API mode),
    // otherwise rebuild safely.
    let subject = safeStr(job.subject ?? "");
    let html = safeStr(job.body ?? "");
    const docTitle = safeStr(job.document_title ?? "") || "Governance Document";

    const env = await getEnvelope(job.envelope_id);
    const lane = laneLabel(env.is_test) as "SANDBOX" | "RoT";

    // Ensure token exists (best-effort), then build signing url.
    const party = await supabase
      .from("signature_parties")
      .select("id, party_token, display_name, email")
      .eq("id", job.party_id)
      .eq("envelope_id", job.envelope_id)
      .maybeSingle();

    if (party.error || !party.data) {
      throw new Error("PARTY_NOT_FOUND");
    }

    let partyToken = (party.data as any).party_token
      ? String((party.data as any).party_token)
      : null;

    if (!partyToken) {
      const token = generatePartyToken();
      const u = await supabase
        .from("signature_parties")
        .update({ party_token: token })
        .eq("id", job.party_id)
        .eq("envelope_id", job.envelope_id)
        .is("party_token", null);

      if (!u.error) partyToken = token;
    }

    const signingUrl = buildSigningUrl({
      envelopeId: job.envelope_id,
      partyId: job.party_id,
      partyToken,
    });

    if (!subject) subject = `Oasis Digital Parliament — Signature Required — ${docTitle}`;
    if (!html) {
      html = buildAuthorityEmailHtml({
        toName: job.to_name ?? null,
        documentTitle: docTitle,
        signingUrl,
        lane,
        envelopeId: job.envelope_id,
        partyId: job.party_id,
      });
    }

    try {
      await sendEmailDirect({
        toEmail: job.to_email,
        toName: job.to_name ?? null,
        subject,
        html,
        signingUrl,
        lane,
        envelopeId: job.envelope_id,
        partyId: job.party_id,
        hasPartyToken: Boolean(partyToken),
      });

      await markQueueSent(job.id, job.attempts ?? 0);

      return json({
        ok: true,
        message: "Signature invitation email sent.",
        job_id: job.id,
        signing_url: signingUrl,
        lane,
        has_party_token: Boolean(partyToken),
      });
    } catch (e) {
      await markQueueFailed(job.id, job.attempts ?? 0, String(e?.message ?? e));
      throw e;
    }
  } catch (e) {
    console.error("send-signature-invite error", e);
    return json(
      { ok: false, error: "Unexpected server error", details: String(e?.message ?? e) },
      500,
    );
  }
});
