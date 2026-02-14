// supabase/functions/email-minute-book-entry/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * email-minute-book-entry (PRODUCTION — LOCKED)
 * ✅ Operator-auth required (JWT)
 * ✅ service_role for DB + storage signing
 * ✅ Hash-first: always includes verify.html?hash=...
 * ✅ Optional time-limited download link (signed URL)
 * ✅ Lane-safe: validates storage_bucket vs is_test hint (best-effort)
 *
 * ENHANCEMENTS (NO REWIRING / NO REGRESSION):
 * ✅ Restores “authority” look: subtle gold accents, depth, and hierarchy
 * ✅ Outlook/Gmail-safe (table-based layout + bulletproof buttons + VML)
 * ✅ Adds “Certified ✓” micro-shimmer (safe CSS; ignored by strict clients)
 * ✅ Tightens micro-spacing + badge hierarchy
 * ✅ Download button clearly secondary
 *
 * Requires env:
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY
 * - RESEND_API_KEY  (recommended)
 * - EMAIL_FROM      (e.g., "Oasis Digital Parliament <no-reply@yourdomain>")
 */

type ReqBody = {
  // identifiers
  entry_id?: string | null;
  hash?: string | null; // preferred if already known (certified hash)

  // lane hint (UI-provided)
  is_test?: boolean | null;

  // email
  to_email?: string | null;
  to_name?: string | null;
  message?: string | null;

  // optional links
  include_download?: boolean | null;
  expires_in?: number | null; // seconds for signed url (default 600)
};

type Resp =
  | {
      ok: true;
      request_id: string;
      to_email: string;
      verify_url: string;
      download_url?: string | null;
    }
  | { ok: false; request_id: string; error: string; details?: unknown };

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
};

function json(data: Resp, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}

function rid() {
  return crypto.randomUUID();
}

function cleanEmail(s?: string | null) {
  return (s || "").trim();
}

function isHex64(s?: string | null) {
  if (!s) return false;
  return /^[0-9a-f]{64}$/i.test(s.trim());
}

function buildVerifyUrl(hash: string) {
  const base = "https://sign.oasisintlholdings.com/verify.html";
  const u = new URL(base);
  u.searchParams.set("hash", hash);
  return u.toString();
}

// Minimal HTML escaping
function esc(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function sendViaResend(args: {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${args.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: args.from,
      to: [args.to],
      subject: args.subject,
      html: args.html,
      text: args.text,
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(t || `Resend failed (${res.status}).`);
  }

  const j = await res.json().catch(() => ({}));
  return j;
}

serve(async (req) => {
  const request_id = rid();

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") {
    return json({ ok: false, request_id, error: "METHOD_NOT_ALLOWED" }, 405);
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return json(
      {
        ok: false,
        request_id,
        error: "SERVER_MISCONFIGURED",
        details: "Missing SUPABASE_URL/SERVICE_ROLE.",
      },
      500,
    );
  }

  const authHeader = req.headers.get("authorization") || "";
  const jwt = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";

  if (!jwt) {
    return json({ ok: false, request_id, error: "NOT_AUTHENTICATED" }, 401);
  }

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });

  // Validate user session (operator auth gate)
  const { data: userData, error: userErr } = await sb.auth.getUser();
  if (userErr || !userData?.user) {
    return json({ ok: false, request_id, error: "INVALID_SESSION" }, 401);
  }

  let body: ReqBody | null = null;
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    body = null;
  }

  const entry_id = (body?.entry_id || "").toString().trim() || null;
  const hinted_hash = (body?.hash || "").toString().trim() || null;
  const hinted_is_test =
    typeof body?.is_test === "boolean" ? body?.is_test : null;

  const to_email = cleanEmail(body?.to_email);
  const to_name = (body?.to_name || "").toString().trim() || "";
  const message = (body?.message || "").toString().trim() || "";

  const include_download = !!body?.include_download;
  const expires_in = Number.isFinite(Number(body?.expires_in))
    ? Math.max(60, Math.min(60 * 60, Number(body?.expires_in))) // clamp 1m..1h
    : 60 * 10; // default 10 min

  if (!to_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to_email)) {
    return json({ ok: false, request_id, error: "MISSING_TO_EMAIL" }, 400);
  }

  // 1) Resolve verified doc for minute_book_entries
  let file_hash: string | null = null;
  let storage_bucket: string | null = null;
  let storage_path: string | null = null;

  if (isHex64(hinted_hash)) {
    file_hash = hinted_hash!;
  }

  // Prefer using entry_id to fetch pointers
  if (entry_id) {
    const { data, error } = await sb
      .from("verified_documents")
      .select("file_hash,storage_bucket,storage_path,verification_level,created_at")
      .eq("source_table", "minute_book_entries")
      .eq("source_record_id", entry_id)
      .order("created_at", { ascending: false })
      .limit(1);

    if (!error && data?.length) {
      const row: any = data[0];
      storage_bucket = (row.storage_bucket || "").toString().trim() || null;
      storage_path = (row.storage_path || "").toString().trim() || null;
      const fh = (row.file_hash || "").toString().trim() || null;
      if (!file_hash && isHex64(fh)) file_hash = fh;
    }
  }

  // If we still don't have a hash, fail (hash-first invariant)
  if (!file_hash || !isHex64(file_hash)) {
    return json(
      {
        ok: false,
        request_id,
        error: "NOT_REGISTERED",
        details:
          "No verified_documents.file_hash found for this Minute Book entry (must be certified/verified first).",
      },
      404,
    );
  }

  const verify_url = buildVerifyUrl(file_hash);

  // 2) Optional download URL (time-limited signed)
  let download_url: string | null = null;

  if (include_download) {
    if (!storage_bucket || !storage_path) {
      // We can still send verify-only if pointers missing
      download_url = null;
    } else {
      // lane hint boundary check (best-effort)
      if (typeof hinted_is_test === "boolean") {
        if (storage_bucket === "governance_sandbox" && hinted_is_test === false) {
          return json({ ok: false, request_id, error: "LANE_MISMATCH" }, 403);
        }
        if (storage_bucket === "governance_truth" && hinted_is_test === true) {
          return json({ ok: false, request_id, error: "LANE_MISMATCH" }, 403);
        }
      }

      const { data: signed, error: signErr } = await sb.storage
        .from(storage_bucket)
        .createSignedUrl(storage_path, expires_in);

      if (!signErr && signed?.signedUrl) {
        download_url = signed.signedUrl;
      } else {
        // Don't hard-fail email if signing fails; keep verify-only
        download_url = null;
      }
    }
  }

  // 3) Send email
  const RESEND_API_KEY = (Deno.env.get("RESEND_API_KEY") || "").trim();
  const EMAIL_FROM = (Deno.env.get("EMAIL_FROM") || "").trim();

  if (!RESEND_API_KEY || !EMAIL_FROM) {
    return json(
      {
        ok: false,
        request_id,
        error: "EMAIL_PROVIDER_NOT_CONFIGURED",
        details: "Set RESEND_API_KEY and EMAIL_FROM in Supabase Edge Function env.",
      },
      500,
    );
  }

  const subject = "Minute Book Entry — Verified Copy";
  const introName = to_name ? `Hello ${esc(to_name)},` : "Hello,";

  const msgBlock = message
    ? `
      <tr>
        <td style="padding:0 0 14px 0">
          <div style="font-size:13px; line-height:1.55; color:rgba(255,255,255,.74)">
            ${esc(message)}
          </div>
        </td>
      </tr>
    `
    : "";

  // Optional tiny shimmer on “Certified ✓” (ignored by strict clients; harmless)
  const shimmerKeyframes = `
    @keyframes odpShimmer {
      0% { opacity: .55; }
      45% { opacity: 1; }
      100% { opacity: .70; }
    }
  `;

  const gold = "#FFD680";
  const ink = "#0B0F17";
  const bg0 = "#05070C";
  const glass = "rgba(14,22,36,.58)";
  const stroke = "rgba(255,255,255,.08)";

  // Bulletproof button helpers (Outlook-safe)
  function bulletproofGoldButton(href: string, label: string, widthPx = 170) {
    const safeHref = esc(href);
    const safeLabel = esc(label);
    return `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-block; border-collapse:separate;">
        <tr>
          <td bgcolor="${gold}" style="background-color:${gold}; border-radius:999px;">
            <!--[if mso]>
            <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${safeHref}"
              style="height:38px;v-text-anchor:middle;width:${widthPx}px;" arcsize="60%" strokecolor="${gold}" fillcolor="${gold}">
              <w:anchorlock/>
              <center style="color:${ink};font-family:Segoe UI,Arial,sans-serif;font-size:12px;font-weight:bold;letter-spacing:.02em;">
                ${safeLabel}
              </center>
            </v:roundrect>
            <![endif]-->
            <!--[if !mso]><!-- -->
            <a href="${safeHref}"
              style="display:inline-block;padding:11px 16px;border-radius:999px;background-color:${gold};color:${ink};
                     font-weight:900;text-decoration:none;font-size:12px;letter-spacing:.02em;">
              ${safeLabel}
            </a>
            <!--<![endif]-->
          </td>
        </tr>
      </table>
    `.trim();
  }

  function bulletproofSecondaryButton(href: string, label: string, widthPx = 220) {
    const safeHref = esc(href);
    const safeLabel = esc(label);
    // Secondary uses dark fill + light stroke; VML for Outlook
    const fill = "#101827";
    const strokeCol = "rgba(255,255,255,.18)";
    const text = "rgba(255,255,255,.86)";
    return `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-block; border-collapse:separate;">
        <tr>
          <td bgcolor="${fill}" style="background-color:${fill}; border-radius:999px; border:1px solid ${strokeCol};">
            <!--[if mso]>
            <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${safeHref}"
              style="height:38px;v-text-anchor:middle;width:${widthPx}px;" arcsize="60%" strokecolor="#2A3448" fillcolor="${fill}">
              <w:anchorlock/>
              <center style="color:#E5E7EB;font-family:Segoe UI,Arial,sans-serif;font-size:12px;font-weight:bold;letter-spacing:.01em;">
                ${safeLabel}
              </center>
            </v:roundrect>
            <![endif]-->
            <!--[if !mso]><!-- -->
            <a href="${safeHref}"
              style="display:inline-block;padding:11px 16px;border-radius:999px;background-color:${fill};color:${text};
                     font-weight:800;text-decoration:none;font-size:12px;letter-spacing:.01em;border:1px solid ${strokeCol};">
              ${safeLabel}
            </a>
            <!--<![endif]-->
          </td>
        </tr>
      </table>
    `.trim();
  }

  const verifyBtn = bulletproofGoldButton(verify_url, "Verify (Hash-first)", 180);
  const downloadBtn = download_url
    ? bulletproofSecondaryButton(download_url, "Download PDF (time-limited)", 230)
    : "";

  const html = `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <meta name="supported-color-schemes" content="dark" />
    <title>${esc(subject)}</title>
    <!--[if mso]>
    <xml>
      <o:OfficeDocumentSettings>
        <o:AllowPNG/>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
    <![endif]-->
    <style>
      ${shimmerKeyframes}
      /* Some clients strip <style>; we keep everything important inline too. */
    </style>
  </head>
  <body style="margin:0; padding:0; background:${bg0}; background-color:${bg0};">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${bg0}" style="background:${bg0}; background-color:${bg0}; padding:24px 10px;">
      <tr>
        <td align="center" style="padding:0;">

          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="720" style="width:100%; max-width:720px; border-collapse:separate;">
            <tr>
              <td bgcolor="${bg0}" style="
                background:${bg0};
                background-color:${bg0};
                border:1px solid ${stroke};
                border-radius:18px;
                overflow:hidden;
                box-shadow: 0 18px 60px rgba(0,0,0,.55);
              ">

                <!-- Gradient “authority” wash (safe even if stripped; bg stays solid) -->
                <div style="display:none; max-height:0; overflow:hidden;">
                  Oasis Digital Parliament Verification
                </div>

                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:separate;">
                  <tr>
                    <td style="padding:22px 22px 18px 22px;">

                      <div style="letter-spacing:.34em; text-transform:uppercase; font-size:11px; color:rgba(255,255,255,.60);">
                        OASIS DIGITAL PARLIAMENT
                      </div>

                      <div style="height:10px; line-height:10px; font-size:10px;">&nbsp;</div>

                      <div style="font-size:20px; font-weight:800; color:#ffffff; margin:0; padding:0;">
                        Minute Book Entry — Verified Copy
                      </div>

                      <div style="height:10px; line-height:10px; font-size:10px;">&nbsp;</div>

                      <div style="font-size:13px; line-height:1.5; color:rgba(255,255,255,.70);">
                        ${introName}
                      </div>

                      <div style="height:14px; line-height:14px; font-size:14px;">&nbsp;</div>

                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:separate;">
                        ${msgBlock}
                      </table>

                      <!-- Certified badge -->
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:separate;">
                        <tr>
                          <td style="padding:0 0 10px 0;">
                            <span style="
                              display:inline-block;
                              padding:6px 10px;
                              border-radius:999px;
                              border:1px solid rgba(255,214,128,.30);
                              background: rgba(255,214,128,.10);
                              color: rgba(255,214,128,.95);
                              font-weight:900;
                              font-size:11px;
                              letter-spacing:.10em;
                              text-transform:uppercase;
                              animation: odpShimmer 2.6s ease-in-out infinite;
                            ">Certified ✓</span>
                          </td>
                        </tr>
                      </table>

                      <!-- Hash card -->
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:separate;">
                        <tr>
                          <td style="
                            padding:14px 14px;
                            border-radius:16px;
                            border:1px solid rgba(255,255,255,.10);
                            background:${glass};
                            background-color:${glass};
                          ">
                            <div style="font-size:11px; letter-spacing:.22em; text-transform:uppercase; color:rgba(255,255,255,.58);">
                              Verification Hash
                            </div>
                            <div style="height:8px; line-height:8px; font-size:8px;">&nbsp;</div>
                            <div style="
                              font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
                              font-size:12px;
                              color:#ffffff;
                              word-break:break-all;
                            ">${esc(file_hash)}</div>
                          </td>
                        </tr>
                      </table>

                      <div style="height:16px; line-height:16px; font-size:16px;">&nbsp;</div>

                      <!-- Buttons row (bulletproof, Outlook-safe) -->
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">
                        <tr>
                          <td style="padding:0 10px 0 0;">
                            ${verifyBtn}
                          </td>
                          ${
                            downloadBtn
                              ? `<td style="padding:0;">${downloadBtn}</td>`
                              : ""
                          }
                        </tr>
                      </table>

                      <div style="height:16px; line-height:16px; font-size:16px;">&nbsp;</div>

                      <div style="font-size:11px; line-height:1.55; color:rgba(255,255,255,.56);">
                        This email contains a hash-first verification link. The public verification terminal is authoritative.
                      </div>

                      <div style="height:12px; line-height:12px; font-size:12px;">&nbsp;</div>

                      <div style="font-size:11px; line-height:1.55; color:rgba(255,255,255,.42);">
                        If you did not request this message, you may ignore it.
                      </div>

                    </td>
                  </tr>

                  <tr>
                    <td style="padding:0 22px 18px 22px;">
                      <div style="height:1px; background:rgba(255,255,255,.08);"></div>
                      <div style="height:12px; line-height:12px; font-size:12px;">&nbsp;</div>
                      <div style="font-size:10px; letter-spacing:.26em; text-transform:uppercase; color:rgba(255,255,255,.38);">
                        ODP.AI • Verification
                      </div>
                    </td>
                  </tr>

                </table>

              </td>
            </tr>
          </table>

        </td>
      </tr>
    </table>
  </body>
</html>
  `.trim();

  const text =
    `Minute Book Entry — Verified Copy\n\n` +
    (message ? `${message}\n\n` : "") +
    `Verification Hash:\n${file_hash}\n\n` +
    `Verify (hash-first): ${verify_url}\n` +
    (download_url ? `Download (time-limited): ${download_url}\n` : "");

  try {
    await sendViaResend({
      apiKey: RESEND_API_KEY,
      from: EMAIL_FROM,
      to: to_email,
      subject,
      html,
      text,
    });

    return json({ ok: true, request_id, to_email, verify_url, download_url });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Email send failed.";
    return json(
      { ok: false, request_id, error: "SEND_FAILED", details: msg },
      500,
    );
  }
});
