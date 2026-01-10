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

const FROM_EMAIL = Deno.env.get("SIGNATURE_FROM_EMAIL") ?? "signatures@oasisintlholdings.com";
const FROM_NAME = Deno.env.get("SIGNATURE_FROM_NAME") ?? "Oasis Digital Parliament";

const SIGNING_BASE_URL = Deno.env.get("SIGNING_BASE_URL") ?? "https://sign.oasisintlholdings.com/sign";

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
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

async function bestEffortContext(job: QueueJob): Promise<{
  entitySlug: string | null;
  entityName: string | null;
  isTest: boolean;
  recordId: string | null;
}> {
  let entitySlug = (job.entity_slug ?? null) || null;
  let entityName: string | null = null;
  let isTest: boolean | null = typeof job.is_test === "boolean" ? job.is_test : null;
  let recordId: string | null = null;

  try {
    const envRes = await supabase
      .from("signature_envelopes")
      .select("record_id, is_test")
      .eq("id", job.envelope_id)
      .maybeSingle();

    if (!envRes.error && envRes.data) {
      const env = envRes.data as EnvelopeLookup;
      recordId = (env.record_id ?? null) || recordId;
      if (typeof env.is_test === "boolean" && isTest === null) isTest = env.is_test;
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

        if (!entitySlug && gl.entity_id) {
          const entRes = await supabase
            .from("entities")
            .select("slug, name")
            .eq("id", gl.entity_id)
            .maybeSingle();

          if (!entRes.error && entRes.data) {
            const ent = entRes.data as EntityLookup;
            entitySlug = (ent.slug ?? null) || entitySlug;
            entityName = (ent.name ?? null) || entityName;
          }
        }
      }
    }
  } catch {
    // never block sending
  }

  return { entitySlug: entitySlug || null, entityName, isTest: isTest ?? false, recordId };
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
  const entityToken = args.entitySlug ? `Entity: ${escapeHtml(args.entitySlug)}` : "Entity: —";
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

                    ${toName ? `<div style="margin-top:6px; font-family: ui-sans-serif, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; font-size:12px; line-height:1.5; color:rgba(255,255,255,0.55);">
                      Recipient: ${escapeHtml(toName)}
                    </div>` : ""}

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

async function pickOldestPendingJob(): Promise<{ job: QueueJob | null; err: any | null }> {
  // Try with optional columns first
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
    // Retry with core columns if optional columns don't exist
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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
      },
    });
  }

  if (req.method !== "POST") {
    return json({ ok: false, error: "Use POST" }, 405);
  }

  try {
    const { job, err } = await pickOldestPendingJob();
    if (err) {
      console.error("signature_email_queue query error", err);
      return json({ ok: false, error: "Failed to read pending signature jobs." }, 500);
    }

    if (!job) {
      return json({ ok: true, message: "No pending signature email jobs." });
    }

    const signingUrl =
      `${SIGNING_BASE_URL}?envelope_id=${encodeURIComponent(job.envelope_id)}&party_id=${encodeURIComponent(job.party_id)}`;

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
      console.log({ to: job.to_email, subject, signingUrl, entity_slug: ctx.entitySlug, lane });
    } else {
      await resend.emails.send({
        from: `${FROM_NAME} <${FROM_EMAIL}>`,
        to: job.to_email,
        subject,
        html,
      });
    }

    const { error: updateErr } = await supabase
      .from("signature_email_queue")
      .update({
        status: "sent",
        attempts: (job.attempts ?? 0) + 1,
        sent_at: new Date().toISOString(),
        error_message: null,
      })
      .eq("id", job.id);

    if (updateErr) {
      console.error("signature_email_queue update error", updateErr);
      return json({ ok: false, error: "Email sent, but failed to update queue row." }, 500);
    }

    return json({
      ok: true,
      message: "Signature invitation email sent.",
      job_id: job.id,
      signing_url: signingUrl,
      entity_slug: ctx.entitySlug,
      lane,
    });
  } catch (e) {
    console.error("Unexpected error in send-signature-invite", e);
    return json({ ok: false, error: "Unexpected server error", details: String(e) }, 500);
  }
});
