// supabase/functions/send-signature-invite/index.ts
//
// ✅ ENTERPRISE • NO REGRESSION
// ✅ Fixes 401 by enforcing REAL operator auth (Authorization Bearer) OR optional internal key
// ✅ Multi-signer: accepts signers[] (and legacy signer_email)
// ✅ Writes canonical UI table: public.signature_envelope_parties
// ✅ Preserves capability signing model: ensures public.signature_parties has party_token
// ✅ Idempotent: re-sending does NOT duplicate; updates invited_at + queues/sends safely
// ✅ Lane-safe: copies is_test from signature_envelopes
// ✅ CC never blocks completion; required signers are the only gating set (handled elsewhere)
//
// NOTE: Your logs show pg_net calling without Authorization => 401.
// If you still call via pg_net, pass header X-INTERNAL-KEY matching INTERNAL_EDGE_KEY env.
// Otherwise call from Forge using supabase.functions.invoke (recommended).

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "npm:resend@4.0.0";

// ---------------------------------------------------------------------------
// ENV + CLIENTS
// ---------------------------------------------------------------------------
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const SUPABASE_ANON_KEY =
  Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("ANON_KEY");

// Optional: allow internal callers (pg_net / backend jobs) with this header:
//   X-INTERNAL-KEY: <INTERNAL_EDGE_KEY>
const INTERNAL_EDGE_KEY = Deno.env.get("INTERNAL_EDGE_KEY") ?? "";

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
}

// Service role for ALL DB writes (canonical enterprise pattern)
const supabaseService = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";

const FROM_EMAIL =
  Deno.env.get("SIGNATURE_FROM_EMAIL") ?? "signatures@oasisintlholdings.com";
const FROM_NAME =
  Deno.env.get("SIGNATURE_FROM_NAME") ?? "Oasis Digital Parliament";

// Keep your default; update if you use sign.html explicitly
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
      "Content-Type, Authorization, apikey, x-client-info, x-internal-key",
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

// split comma/semicolon/whitespace separated email lists safely
function splitEmails(input: unknown): string[] {
  const raw = String(input ?? "");
  return raw
    .split(/[,\n;]+/g)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && s.includes("@"));
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
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

// Capability table (token auth) — used by get-signing-context / complete-signature
type CapabilityPartyRow = {
  id: string;
  envelope_id: string;
  email: string;
  display_name: string | null;
  status: string | null;
  party_token: string | null;
  created_at?: string | null;
};

// Canonical UI signer table (Forge uses this)
type EnvelopePartyRow = {
  id: string;
  envelope_id: string;
  record_id: string | null;
  entity_id: string | null;
  is_test: boolean | null;
  name: string | null;
  email: string;
  role: string; // ✅ FIX: NOT NULL in your table
  party_type: string; // 'signer' | 'cc'
  required: boolean;
  is_primary: boolean;
  signing_order: number | null;
  invited_at: string | null;
  viewed_at: string | null;
  signed_at: string | null;
  status: string | null;
  created_at: string | null;
};

type EnvelopeRow = {
  id: string;
  record_id: string | null;
  entity_id: string | null;
  is_test: boolean | null;
  status?: string | null;
};

// Email queue row (if you have it)
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

// Request body supports both legacy and multi-signer
type SignerInput = {
  email: string;
  name?: string | null;
  role?: string | null;
  required?: boolean | null; // default true
  is_primary?: boolean | null;
  signing_order?: number | null;
  party_type?: "signer" | "cc" | string | null; // optional override
};

type InviteBody = {
  envelope_id?: string | null;

  // legacy single signer fields
  signer_email?: string | null;
  signer_name?: string | null;

  // enterprise multi-signer fields
  signers?: SignerInput[] | null;
  cc?: string[] | string | null;

  document_title?: string | null;

  // default true: send immediately
  send_now?: boolean | null;

  // optional: allow "worker mode" when called without payload
  worker?: boolean | null;
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
// AUTH (Fixes your 401)
// ---------------------------------------------------------------------------
async function requireOperatorOrInternal(req: Request): Promise<
  | {
      ok: true;
      mode: "operator" | "internal";
      operator_user_id: string | null;
    }
  | {
      ok: false;
      status: number;
      error: string;
      detail?: string;
    }
> {
  const internalHeader = safeStr(req.headers.get("x-internal-key") ?? "");
  if (
    INTERNAL_EDGE_KEY &&
    internalHeader &&
    internalHeader === INTERNAL_EDGE_KEY
  ) {
    return { ok: true, mode: "internal", operator_user_id: null };
  }

  const auth = safeStr(req.headers.get("authorization") ?? "");
  if (!auth.toLowerCase().startsWith("bearer ")) {
    return {
      ok: false,
      status: 401,
      error: "INVALID_SESSION",
      detail:
        "Missing Authorization Bearer token (call via supabase.functions.invoke from UI).",
    };
  }
  if (!SUPABASE_ANON_KEY) {
    return {
      ok: false,
      status: 500,
      error: "SERVER_MISCONFIG",
      detail: "Missing SUPABASE_ANON_KEY in function env.",
    };
  }

  // Validate operator session via anon client + bearer
  const supabaseAuthed = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: auth }, fetch },
  });

  const { data, error } = await supabaseAuthed.auth.getUser();
  if (error || !data?.user) {
    return {
      ok: false,
      status: 401,
      error: "INVALID_SESSION",
      detail: "Unable to resolve operator user from session.",
    };
  }

  return { ok: true, mode: "operator", operator_user_id: data.user.id };
}

// ---------------------------------------------------------------------------
// DB HELPERS (aligned to your schema)
// ---------------------------------------------------------------------------
async function getEnvelope(envelopeId: string): Promise<EnvelopeRow> {
  const r = await supabaseService
    .from("signature_envelopes")
    .select("id, record_id, entity_id, is_test, status")
    .eq("id", envelopeId)
    .maybeSingle();

  if (r.error) throw r.error;
  if (!r.data) throw new Error("ENVELOPE_NOT_FOUND");
  return r.data as EnvelopeRow;
}

/**
 * Ensures capability party exists (token auth).
 * Table: public.signature_parties (your existing code uses this).
 * Returns: signature_parties.id + party_token
 */
async function upsertCapabilityParty(
  envelopeId: string,
  email: string,
  displayName: string | null,
) {
  const existing = await supabaseService
    .from("signature_parties")
    .select("id, envelope_id, email, display_name, status, party_token")
    .eq("envelope_id", envelopeId)
    .eq("email", email)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing.error) throw existing.error;

  if (existing.data?.id) {
    const row = existing.data as CapabilityPartyRow;
    let token = row.party_token ? String(row.party_token) : null;

    if (!token) {
      token = generatePartyToken();
      const u = await supabaseService
        .from("signature_parties")
        .update({ party_token: token })
        .eq("id", row.id)
        .eq("envelope_id", envelopeId)
        .is("party_token", null);
      if (u.error) token = null; // best-effort
    }

    if (displayName && !row.display_name) {
      await supabaseService
        .from("signature_parties")
        .update({ display_name: displayName })
        .eq("id", row.id)
        .eq("envelope_id", envelopeId);
    }

    return { partyId: row.id, partyToken: token };
  }

  const token = generatePartyToken();
  const ins = await supabaseService
    .from("signature_parties")
    .insert({
      envelope_id: envelopeId,
      email,
      display_name: displayName,
      status: "pending",
      party_token: token,
    })
    .select("id, party_token")
    .single();

  if (ins.error) throw ins.error;
  return { partyId: ins.data.id as string, partyToken: ins.data.party_token as string };
}

/**
 * Upserts canonical UI party row (Forge reads this).
 * Table: public.signature_envelope_parties
 *
 * ✅ FIX: signature_envelope_parties.role is NOT NULL → enforce defaults
 */
async function upsertEnvelopeParty(args: {
  envelope: EnvelopeRow;
  name: string | null;
  email: string;
  role: string | null;
  party_type: "signer" | "cc";
  required: boolean;
  is_primary: boolean;
  signing_order: number | null;
}) {
  const envelopeId = args.envelope.id;

  // ✅ FIX: enforce non-null role for canonical table
  const role =
    safeStr(args.role ?? "") ||
    (args.party_type === "cc" ? "CC" : "Director");

  // Find existing by envelope_id + email + party_type (idempotent)
  const existing = await supabaseService
    .from("signature_envelope_parties")
    .select(
      "id, envelope_id, email, party_type, required, is_primary, signing_order, status, invited_at, signed_at",
    )
    .eq("envelope_id", envelopeId)
    .eq("email", args.email)
    .eq("party_type", args.party_type)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing.error) throw existing.error;

  if (existing.data?.id) {
    // If already signed, keep immutable core fields (do NOT overwrite)
    const signedAt = (existing.data as any).signed_at;
    if (signedAt) return existing.data as EnvelopePartyRow;

    const upd = await supabaseService
      .from("signature_envelope_parties")
      .update({
        name: args.name,
        role, // ✅ always non-null
        required: args.required,
        is_primary: args.is_primary,
        signing_order: args.signing_order,
        // do NOT set invited_at here; Send handles that
        status: (existing.data as any).status ?? "pending",
      })
      .eq("id", (existing.data as any).id)
      .eq("envelope_id", envelopeId)
      .select("*")
      .single();

    if (upd.error) throw upd.error;
    return upd.data as EnvelopePartyRow;
  }

  const ins = await supabaseService
    .from("signature_envelope_parties")
    .insert({
      envelope_id: envelopeId,
      record_id: args.envelope.record_id,
      entity_id: args.envelope.entity_id,
      is_test: args.envelope.is_test,
      name: args.name,
      email: args.email,
      role, // ✅ FIX: NOT NULL
      party_type: args.party_type,
      required: args.required,
      is_primary: args.is_primary,
      signing_order: args.signing_order,
      status: "pending",
    })
    .select("*")
    .single();

  if (ins.error) throw ins.error;
  return ins.data as EnvelopePartyRow;
}

async function markEnvelopePartyInvited(
  envelopePartyId: string,
  envelopeId: string,
) {
  // Keep status within allowed values; invited_at is the audit truth.
  const r = await supabaseService
    .from("signature_envelope_parties")
    .update({
      invited_at: new Date().toISOString(),
      status: "pending",
    })
    .eq("id", envelopePartyId)
    .eq("envelope_id", envelopeId);

  if (r.error) throw r.error;
}

// Optional queue (audit) — if table exists in your project
async function tryCreateQueueRow(args: {
  envelopeId: string;
  partyId: string; // capability party id
  toEmail: string;
  toName: string | null;
  subject: string;
  body: string;
  documentTitle: string;
  payload: any;
}): Promise<string | null> {
  const r = await supabaseService
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
    .maybeSingle();

  // If table doesn't exist or insert fails, we do NOT block (no regression / tolerant)
  if (r.error || !r.data?.id) return null;
  return r.data.id as string;
}

async function tryMarkQueueSent(queueId: string | null) {
  if (!queueId) return;
  await supabaseService
    .from("signature_email_queue")
    .update({
      status: "sent",
      attempts: 1,
      sent_at: new Date().toISOString(),
      error_message: null,
    })
    .eq("id", queueId);
}

async function tryMarkQueueFailed(queueId: string | null, msg: string) {
  if (!queueId) return;
  await supabaseService
    .from("signature_email_queue")
    .update({
      status: "failed",
      attempts: 1,
      error_message: msg.slice(0, 4000),
    })
    .eq("id", queueId);
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
// NORMALIZE REQUEST INTO SIGNERS + CC (multi-signer enterprise)
// ---------------------------------------------------------------------------
function normalizeInvite(body: InviteBody) {
  const envelope_id = safeStr(body.envelope_id ?? "");
  const document_title = safeStr(body.document_title ?? "") || "Governance Document";
  const send_now = body.send_now !== false;

  // Build signer list:
  // - If signers[] provided: use it
  // - Else fallback to legacy signer_email/signer_name
  const signers: SignerInput[] = [];

  if (Array.isArray(body.signers) && body.signers.length) {
    for (const s of body.signers) {
      const emails = splitEmails(s?.email);
      for (const e of emails) {
        signers.push({
          email: e,
          name: safeStr(s?.name ?? "") || null,
          role: safeStr(s?.role ?? "") || null,
          required: s?.required !== false, // default true
          is_primary: Boolean(s?.is_primary),
          signing_order:
            typeof s?.signing_order === "number" ? s.signing_order : null,
          party_type: (safeStr(s?.party_type ?? "") || "signer") as any,
        });
      }
    }
  } else {
    const legacyEmail = safeStr(body.signer_email ?? "");
    if (legacyEmail) {
      const emails = splitEmails(legacyEmail);
      for (const e of emails) {
        signers.push({
          email: e,
          name: safeStr(body.signer_name ?? "") || null,
          role: null,
          required: true,
          is_primary: true,
          signing_order: null,
          party_type: "signer",
        });
      }
    }
  }

  // CC list can be string or array; split if needed
  const ccRaw = body.cc ?? null;
  const ccList = Array.isArray(ccRaw) ? ccRaw.flatMap(splitEmails) : splitEmails(ccRaw);

  // Safety: normalize + unique + ✅ FIX: default role for canonical table
  const normSigners = signers
    .map((s) => {
      const partyTypeRaw = safeStr(s.party_type ?? "") || "signer";
      const partyType =
        partyTypeRaw.toLowerCase() === "cc" ? "cc" : "signer";

      const role =
        safeStr(s.role ?? "") ||
        (partyType === "cc" ? "CC" : "Director"); // ✅ FIX

      return {
        ...s,
        email: normEmail(s.email),
        party_type: partyType as any,
        role, // ✅ role always non-empty string now
      };
    })
    .filter((s) => s.email && s.email.includes("@"));

  const normCC = uniq(ccList.map((e) => normEmail(e))).filter((e) => e && e.includes("@"));

  return {
    envelope_id,
    document_title,
    send_now,
    signers: normSigners,
    cc: normCC,
  };
}

// ---------------------------------------------------------------------------
// MAIN HANDLER
// ---------------------------------------------------------------------------
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders() });
  }

  if (req.method !== "POST") {
    return json({ ok: false, error: "Use POST" }, 405);
  }

  // Auth gate (fixes 401)
  const auth = await requireOperatorOrInternal(req);
  if (!auth.ok) {
    return json({ ok: false, error: auth.error, detail: auth.detail }, auth.status);
  }

  // Parse body (worker mode allowed)
  let body: InviteBody | null = null;
  try {
    body = (await req.json()) as InviteBody;
  } catch {
    body = null;
  }

  // If worker mode requested explicitly, you can implement later;
  // for now we treat missing body as invalid (prevents silent behavior).
  if (!body || typeof body !== "object") {
    return json({ ok: false, error: "BAD_JSON" }, 400);
  }

  const inv = normalizeInvite(body);
  if (!inv.envelope_id) {
    return json({ ok: false, error: "ENVELOPE_REQUIRED" }, 400);
  }

  // Load envelope context (lane + record + entity)
  let envelope: EnvelopeRow;
  try {
    envelope = await getEnvelope(inv.envelope_id);
  } catch (e) {
    return json(
      {
        ok: false,
        error: "ENVELOPE_NOT_FOUND",
        detail: String((e as any)?.message ?? e),
      },
      404,
    );
  }

  const lane = laneLabel(envelope.is_test) as "SANDBOX" | "RoT";

  // Safety: do not mutate parties after completion
  const envStatus = safeStr(envelope.status ?? "").toLowerCase();
  if (envStatus === "completed") {
    return json(
      {
        ok: false,
        error: "ENVELOPE_COMPLETED",
        detail: "Envelope is completed; signer set is immutable.",
        envelope_id: envelope.id,
      },
      409,
    );
  }

  // If caller provided no signers and no CC, we still allow "re-invite existing signers"
  // by reading existing signature_envelope_parties.
  const requestedHasParties = inv.signers.length > 0 || inv.cc.length > 0;

  // -----------------------------------------------------------------------
  // 1) UPSERT SIGNERS (capability + canonical UI table)
  // -----------------------------------------------------------------------
  const ensured: Array<{
    email: string;
    party_type: "signer" | "cc";
    required: boolean;
    envelope_party_id: string | null;
    capability_party_id: string | null;
    signing_url: string | null;
    has_party_token: boolean;
  }> = [];

  if (requestedHasParties) {
    // SIGNERS
    for (const s of inv.signers) {
      const partyType =
        safeStr(s.party_type ?? "").toLowerCase() === "cc" ? "cc" : "signer";

      if (partyType === "cc") {
        // treat as CC
        inv.cc = uniq([...inv.cc, s.email]);
        continue;
      }

      // 1a) capability party (token model)
      const cap = await upsertCapabilityParty(envelope.id, s.email, s.name ?? null);

      const signingUrl = buildSigningUrl({
        envelopeId: envelope.id,
        partyId: cap.partyId,
        partyToken: cap.partyToken,
      });

      // 1b) canonical UI party row
      const envParty = await upsertEnvelopeParty({
        envelope,
        name: s.name ?? null,
        email: s.email,
        role: safeStr(s.role ?? "") || "Director", // ✅ FIX: never null
        party_type: "signer",
        required: s.required !== false,
        is_primary: Boolean(s.is_primary),
        signing_order: s.signing_order ?? null,
      });

      ensured.push({
        email: s.email,
        party_type: "signer",
        required: s.required !== false,
        envelope_party_id: envParty.id,
        capability_party_id: cap.partyId,
        signing_url: signingUrl,
        has_party_token: Boolean(cap.partyToken),
      });
    }

    // CC
    for (const ccEmail of inv.cc) {
      // CC has NO capability token; it should never block signing.
      const envParty = await upsertEnvelopeParty({
        envelope,
        name: null,
        email: ccEmail,
        role: "CC", // ✅ FIX: enforce non-null role
        party_type: "cc",
        required: false,
        is_primary: false,
        signing_order: null,
      });

      ensured.push({
        email: ccEmail,
        party_type: "cc",
        required: false,
        envelope_party_id: envParty.id,
        capability_party_id: null,
        signing_url: null,
        has_party_token: false,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 2) DETERMINE WHO TO INVITE
  // -----------------------------------------------------------------------
  // If caller provided signers, invite those required signers.
  // If caller provided none, invite existing required signers in envelope parties.
  let inviteTargets: Array<{
    envelope_party_id: string;
    email: string;
    name: string | null;
    role: string | null;
    required: boolean;
    capability_party_id: string;
    party_token: string | null;
  }> = [];

  if (inv.signers.length > 0) {
    // Use ensured list (signers only, required only)
    for (const e of ensured) {
      if (e.party_type !== "signer") continue;
      if (!e.required) continue;
      if (!e.envelope_party_id || !e.capability_party_id) continue;

      // load capability token to include in url
      const cap = await supabaseService
        .from("signature_parties")
        .select("id, party_token, display_name, email, status")
        .eq("id", e.capability_party_id)
        .eq("envelope_id", envelope.id)
        .maybeSingle();

      const token = cap.data ? String((cap.data as any).party_token ?? "") : "";
      inviteTargets.push({
        envelope_party_id: e.envelope_party_id,
        email: e.email,
        name: (cap.data as any)?.display_name ?? null,
        role: null,
        required: true,
        capability_party_id: e.capability_party_id,
        party_token: token || null,
      });
    }
  } else {
    // Invite existing required signers from signature_envelope_parties
    const existing = await supabaseService
      .from("signature_envelope_parties")
      .select("id, email, name, role, required, signed_at, party_type")
      .eq("envelope_id", envelope.id)
      .eq("party_type", "signer")
      .eq("required", true)
      .order("created_at", { ascending: true });

    if (existing.error) {
      return json(
        { ok: false, error: "DB_ERROR", detail: existing.error.message },
        500,
      );
    }

    for (const p of (existing.data ?? []) as any[]) {
      if (p.signed_at) continue;

      // capability party lookup by email
      const cap = await supabaseService
        .from("signature_parties")
        .select("id, party_token, display_name, email, status")
        .eq("envelope_id", envelope.id)
        .eq("email", String(p.email ?? "").toLowerCase())
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (cap.error || !cap.data?.id) {
        // Ensure capability party exists (no regression)
        const ensuredCap = await upsertCapabilityParty(
          envelope.id,
          String(p.email ?? "").toLowerCase(),
          (p.name ?? null) as string | null,
        );
        inviteTargets.push({
          envelope_party_id: p.id,
          email: String(p.email ?? "").toLowerCase(),
          name: (p.name ?? null) as string | null,
          role: (p.role ?? null) as string | null,
          required: true,
          capability_party_id: ensuredCap.partyId,
          party_token: ensuredCap.partyToken,
        });
      } else {
        inviteTargets.push({
          envelope_party_id: p.id,
          email: String(p.email ?? "").toLowerCase(),
          name: ((cap.data as any).display_name ?? p.name ?? null) as string | null,
          role: (p.role ?? null) as string | null,
          required: true,
          capability_party_id: (cap.data as any).id as string,
          party_token: ((cap.data as any).party_token ?? null) as string | null,
        });
      }
    }
  }

  // If there are still no required signers, fail loudly (enterprise)
  if (!inviteTargets.length) {
    return json(
      {
        ok: false,
        error: "NO_REQUIRED_SIGNERS",
        detail:
          "No required signer parties found to invite. Provide signers[] or create signature_envelope_parties first.",
        envelope_id: envelope.id,
      },
      400,
    );
  }

  // -----------------------------------------------------------------------
  // 3) SEND INVITES (audit-first: invited_at)
  // -----------------------------------------------------------------------
  const invited: any[] = [];
  const skipped: any[] = [];

  for (const t of inviteTargets) {
    const email = normEmail(t.email);
    if (!email || !email.includes("@")) {
      skipped.push({ email, reason: "INVALID_EMAIL" });
      continue;
    }

    // Always ensure invited_at in canonical party table (this is your audit truth)
    await markEnvelopePartyInvited(t.envelope_party_id, envelope.id);

    // Build URL (capability)
    const signingUrl = buildSigningUrl({
      envelopeId: envelope.id,
      partyId: t.capability_party_id,
      partyToken: t.party_token,
    });

    const subject = `Oasis Digital Parliament — Signature Required — ${inv.document_title}`;
    const html = buildAuthorityEmailHtml({
      toName: t.name ?? null,
      documentTitle: inv.document_title,
      signingUrl,
      lane,
      envelopeId: envelope.id,
      partyId: t.capability_party_id,
    });

    // Queue (best effort; never blocks)
    const queueId = await tryCreateQueueRow({
      envelopeId: envelope.id,
      partyId: t.capability_party_id,
      toEmail: email,
      toName: t.name ?? null,
      subject,
      body: html,
      documentTitle: inv.document_title,
      payload: {
        envelope_id: envelope.id,
        record_id: envelope.record_id,
        entity_id: envelope.entity_id,
        is_test: envelope.is_test,
        lane,
        party_id: t.capability_party_id,
        signing_url: signingUrl,
        mode: auth.mode,
        operator_user_id: auth.operator_user_id,
      },
    });

    // Send now (or just audit/queue if disabled)
    if (inv.send_now !== false) {
      try {
        await sendEmailDirect({
          toEmail: email,
          toName: t.name ?? null,
          subject,
          html,
          signingUrl,
          lane,
          envelopeId: envelope.id,
          partyId: t.capability_party_id,
          hasPartyToken: Boolean(t.party_token),
        });
        await tryMarkQueueSent(queueId);

        invited.push({
          email,
          envelope_party_id: t.envelope_party_id,
          party_id: t.capability_party_id,
          signing_url: signingUrl,
          queue_id: queueId,
          lane,
          has_party_token: Boolean(t.party_token),
          mode: resend ? "resend" : "log_only",
        });
      } catch (e) {
        await tryMarkQueueFailed(queueId, String((e as any)?.message ?? e));
        skipped.push({
          email,
          envelope_party_id: t.envelope_party_id,
          party_id: t.capability_party_id,
          reason: "SEND_FAILED",
          detail: String((e as any)?.message ?? e),
          queue_id: queueId,
        });
      }
    } else {
      invited.push({
        email,
        envelope_party_id: t.envelope_party_id,
        party_id: t.capability_party_id,
        signing_url: signingUrl,
        queue_id: queueId,
        lane,
        has_party_token: Boolean(t.party_token),
        mode: "queued_only",
      });
    }
  }

  return json({
    ok: true,
    envelope_id: envelope.id,
    record_id: envelope.record_id,
    entity_id: envelope.entity_id,
    is_test: envelope.is_test,
    envelope_status: envelope.status ?? null,
    lane,
    auth_mode: auth.mode,
    operator_user_id: auth.operator_user_id,
    invited_count: invited.length,
    skipped_count: skipped.length,
    invited,
    skipped,
  });
});
