// supabase/functions/email-minute-book-entry/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ✅ Edge-safe QR (NO canvas / NO wasm)
import QRGen from "npm:qrcode-generator@1.4.4";
import { PNG } from "npm:pngjs@7.0.0";

/**
 * email-minute-book-entry (PRODUCTION — LOCKED)
 * ✅ Operator-auth required (JWT)
 * ✅ service_role for DB + storage signing
 * ✅ Hash-first: always includes verify.html?hash=...
 * ✅ Optional time-limited download link (signed URL)
 * ✅ Lane-safe: validates storage_bucket vs is_test hint (best-effort)
 *
 * ENHANCEMENTS (NO REWIRING / NO REGRESSION):
 * ✅ Adds optional `context` for UI copy/subject (Verified Registry vs Minute Book)
 * ✅ Allows passing storage_bucket/storage_path for hash-only registry sends (optional)
 * ✅ Default behavior remains identical for Minute Book entry sends
 *
 * Requires env:
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY
 * - RESEND_API_KEY
 * - EMAIL_FROM
 */

type EmailContext = "minute_book" | "verified_registry";

type ReqBody = {
  // Legacy / Minute Book
  entry_id?: string | null;

  // Hash-first (works for BOTH Minute Book + Verified Registry)
  hash?: string | null;

  // Lane hint (optional)
  is_test?: boolean | null;

  // Recipient
  to_email?: string | null;
  to_name?: string | null;
  message?: string | null;

  // Download controls
  include_download?: boolean | null;
  expires_in?: number | null; // seconds (default 600)

  // ✅ NEW (UI-only): controls subject + copy (NO backend contract break)
  context?: EmailContext | null;

  // ✅ Optional: lets Verified Registry send include_download even without entry_id
  // (NO schema change; just a request override)
  storage_bucket?: string | null;
  storage_path?: string | null;

  // ✅ Optional: title shown in email (defaults by context)
  title?: string | null;
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
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
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

// ---------------- QR helpers (verify_url -> PNG data URI) ----------------

function qrToPngDataUri(input: string, sizePx = 160): string {
  const qr = QRGen(0, "M"); // auto version, medium ECC
  qr.addData(input);
  qr.make();

  const count = qr.getModuleCount();
  const quiet = 4; // quiet zone modules
  const modules = count + quiet * 2;

  const scale = Math.max(3, Math.floor(sizePx / modules));
  const outSize = modules * scale;

  const png = new PNG({ width: outSize, height: outSize });

  // fill white
  for (let y = 0; y < outSize; y++) {
    for (let x = 0; x < outSize; x++) {
      const idx = (outSize * y + x) << 2;
      png.data[idx] = 255;
      png.data[idx + 1] = 255;
      png.data[idx + 2] = 255;
      png.data[idx + 3] = 255;
    }
  }

  // draw modules in black
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      const dark = qr.isDark(r, c);
      if (!dark) continue;

      const x0 = (c + quiet) * scale;
      const y0 = (r + quiet) * scale;

      for (let yy = 0; yy < scale; yy++) {
        for (let xx = 0; xx < scale; xx++) {
          const x = x0 + xx;
          const y = y0 + yy;
          const idx = (outSize * y + x) << 2;
          png.data[idx] = 0;
          png.data[idx + 1] = 0;
          png.data[idx + 2] = 0;
          png.data[idx + 3] = 255;
        }
      }
    }
  }

  const bytes = PNG.sync.write(png);
  const b64 = btoa(String.fromCharCode(...bytes));
  return `data:image/png;base64,${b64}`;
}

// ---------------- Email UI helpers (Outlook-safe buttons) ----------------

const gold = "#FFD680";
const ink = "#0B0F17";
const bg0 = "#05070C";
const card = "#0B0F17"; // solid (prevents "faded" look)
const panel = "#0F172A";
const stroke = "#1E293B";
const textHi = "#FFFFFF";
const textMd = "#CBD5E1";
const textLo = "#94A3B8";

function bulletproofGoldButton(href: string, label: string, widthPx = 190) {
  const safeHref = esc(href);
  const safeLabel = esc(label);
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-block;border-collapse:separate;">
  <tr>
    <td bgcolor="${gold}" style="background-color:${gold};border-radius:999px;">
      <!--[if mso]>
      <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${safeHref}"
        style="height:40px;v-text-anchor:middle;width:${widthPx}px;" arcsize="60%" strokecolor="${gold}" fillcolor="${gold}">
        <w:anchorlock/>
        <center style="color:${ink};font-family:Segoe UI,Arial,sans-serif;font-size:12px;font-weight:bold;letter-spacing:.02em;">
          ${safeLabel}
        </center>
      </v:roundrect>
      <![endif]-->
      <!--[if !mso]><!-- -->
      <a href="${safeHref}"
        style="display:inline-block;padding:12px 18px;border-radius:999px;background-color:${gold};color:${ink};
               font-weight:900;text-decoration:none;font-size:12px;letter-spacing:.02em;">
        ${safeLabel}
      </a>
      <!--<![endif]-->
    </td>
  </tr>
</table>`.trim();
}

function bulletproofSecondaryButton(href: string, label: string, widthPx = 240) {
  const safeHref = esc(href);
  const safeLabel = esc(label);
  const fill = "#111827";
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-block;border-collapse:separate;">
  <tr>
    <td bgcolor="${fill}" style="background-color:${fill};border-radius:999px;border:1px solid ${stroke};">
      <!--[if mso]>
      <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${safeHref}"
        style="height:40px;v-text-anchor:middle;width:${widthPx}px;" arcsize="60%" strokecolor="#2A3448" fillcolor="${fill}">
        <w:anchorlock/>
        <center style="color:#E5E7EB;font-family:Segoe UI,Arial,sans-serif;font-size:12px;font-weight:bold;letter-spacing:.01em;">
          ${safeLabel}
        </center>
      </v:roundrect>
      <![endif]-->
      <!--[if !mso]><!-- -->
      <a href="${safeHref}"
        style="display:inline-block;padding:12px 18px;border-radius:999px;background-color:${fill};color:#E5E7EB;
               font-weight:800;text-decoration:none;font-size:12px;letter-spacing:.01em;border:1px solid ${stroke};">
        ${safeLabel}
      </a>
      <!--<![endif]-->
    </td>
  </tr>
</table>`.trim();
}

serve(async (req) => {
  const request_id = rid();

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, request_id, error: "METHOD_NOT_ALLOWED" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return json(
      { ok: false, request_id, error: "SERVER_MISCONFIGURED", details: "Missing SUPABASE_URL/SERVICE_ROLE." },
      500,
    );
  }

  const authHeader = req.headers.get("authorization") || "";
  const jwt = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  if (!jwt) return json({ ok: false, request_id, error: "NOT_AUTHENTICATED" }, 401);

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });

  // Validate user session (operator auth gate)
  const { data: userData, error: userErr } = await sb.auth.getUser();
  if (userErr || !userData?.user) return json({ ok: false, request_id, error: "INVALID_SESSION" }, 401);

  let body: ReqBody | null = null;
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    body = null;
  }

  const entry_id = (body?.entry_id || "").toString().trim() || null;
  const hinted_hash = (body?.hash || "").toString().trim() || null;

  const hinted_is_test = typeof body?.is_test === "boolean" ? body?.is_test : null;

  const to_email = cleanEmail(body?.to_email);
  const to_name = (body?.to_name || "").toString().trim() || "";
  const message = (body?.message || "").toString().trim() || "";

  const include_download = !!body?.include_download;
  const expires_in = Number.isFinite(Number(body?.expires_in))
    ? Math.max(60, Math.min(60 * 60, Number(body?.expires_in))) // clamp 1m..1h
    : 60 * 10; // default 10 min

  // ✅ context (defaults to minute_book to preserve legacy behavior)
  const rawCtx = (body?.context || "").toString().trim() as EmailContext;
  const ctx: EmailContext =
    rawCtx === "verified_registry" || rawCtx === "minute_book" ? rawCtx : "minute_book";

  // If caller provided hash-only and no entry_id, infer registry context (safe UX upgrade)
  const inferredCtx: EmailContext =
    !entry_id && isHex64(hinted_hash) ? "verified_registry" : ctx;

  const providedTitle = (body?.title || "").toString().trim() || "";

  // Optional storage pointers from UI (helps Verified Registry include_download when hash-only)
  let storage_bucket: string | null = (body?.storage_bucket || "").toString().trim() || null;
  let storage_path: string | null = (body?.storage_path || "").toString().trim() || null;

  if (!to_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to_email)) {
    return json({ ok: false, request_id, error: "MISSING_TO_EMAIL" }, 400);
  }

  // 1) Resolve hash + pointers
  let file_hash: string | null = null;

  if (isHex64(hinted_hash)) file_hash = hinted_hash!;

  // If entry_id is provided, load the verified row for this minute_book_entries record
  // (Preserves old behavior exactly.)
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
      const fh = (row.file_hash || "").toString().trim() || null;
      if (!file_hash && isHex64(fh)) file_hash = fh;

      // Only override pointers if UI didn't provide them
      if (!storage_bucket) storage_bucket = (row.storage_bucket || "").toString().trim() || null;
      if (!storage_path) storage_path = (row.storage_path || "").toString().trim() || null;
    }
  }

  if (!file_hash || !isHex64(file_hash)) {
    return json(
      {
        ok: false,
        request_id,
        error: "NOT_REGISTERED",
        details:
          inferredCtx === "verified_registry"
            ? "No certified file_hash provided/found. Verified Registry emails require a 64-hex hash."
            : "No verified_documents.file_hash found for this Minute Book entry (must be certified/verified first).",
      },
      404,
    );
  }

  const verify_url = buildVerifyUrl(file_hash);

  // 2) Optional download URL (time-limited signed)
  let download_url: string | null = null;

  if (include_download) {
    if (!storage_bucket || !storage_path) {
      // hash-only registry emails can still be sent; download link is optional
      download_url = null;
    } else {
      if (typeof hinted_is_test === "boolean") {
        if (storage_bucket === "governance_sandbox" && hinted_is_test === false) {
          return json({ ok: false, request_id, error: "LANE_MISMATCH" }, 403);
        }
        if (storage_bucket === "governance_truth" && hinted_is_test === true) {
          return json({ ok: false, request_id, error: "LANE_MISMATCH" }, 403);
        }
      }

      const { data: signed, error: signErr } = await sb.storage.from(storage_bucket).createSignedUrl(storage_path, expires_in);
      if (!signErr && signed?.signedUrl) download_url = signed.signedUrl;
      else download_url = null;
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

  // ✅ Subject + headline are now context-aware (no more “Minute Book …” when sent from Verified Registry)
  const defaultTitle =
    inferredCtx === "verified_registry" ? "Verified Registry — Certified Copy" : "Minute Book Entry — Verified Copy";

  const subject =
    inferredCtx === "verified_registry" ? "Verified Registry — Certified Copy" : "Minute Book Entry — Verified Copy";

  const headline = providedTitle ? providedTitle : defaultTitle;

  const introName = to_name ? `Hello ${esc(to_name)},` : "Hello,";

  const msgBlock = message
    ? `
<tr>
  <td style="padding:0 0 14px 0;">
    <div style="font-size:13px;line-height:1.55;color:${textMd};">
      ${esc(message)}
    </div>
  </td>
</tr>`
    : "";

  const shimmerKeyframes = `
@keyframes odpShimmer {
  0% { opacity:.62; }
  45% { opacity:1; }
  100% { opacity:.78; }
}`;

  // QR encodes canonical verify_url (hash-first)
  const qrPng = qrToPngDataUri(verify_url, 168);

  const verifyBtn = bulletproofGoldButton(verify_url, "Verify (Hash-first)", 190);
  const downloadBtn = download_url ? bulletproofSecondaryButton(download_url, "Download PDF (time-limited)", 250) : "";

  const footerTitle = `OASIS DIGITAL PARLIAMENT`;
  const footerSub = `VERIFICATION TERMINAL`;
  const footerProtocol = `Certified via Hash-First Verification Protocol`;

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
    <style>${shimmerKeyframes}</style>
  </head>
  <body style="margin:0;padding:0;background:${bg0};background-color:${bg0};">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${bg0}"
      style="background:${bg0};background-color:${bg0};padding:24px 10px;">
      <tr>
        <td align="center" style="padding:0;">

          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="720"
            style="width:100%;max-width:720px;border-collapse:separate;">
            <tr>
              <td bgcolor="${card}" style="
                background:${card};
                background-color:${card};
                border:1px solid ${stroke};
                border-radius:18px;
                overflow:hidden;
                box-shadow:0 18px 60px rgba(0,0,0,.55);
              ">

                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:separate;">
                  <tr>
                    <td style="padding:22px 22px 18px 22px;">

                      <div style="letter-spacing:.34em;text-transform:uppercase;font-size:11px;color:rgba(203,213,225,.74);">
                        OASIS DIGITAL PARLIAMENT
                      </div>

                      <div style="height:10px;line-height:10px;font-size:10px;">&nbsp;</div>

                      <div style="font-size:20px;font-weight:800;color:${textHi};margin:0;padding:0;">
                        ${esc(headline)}
                      </div>

                      <div style="height:10px;line-height:10px;font-size:10px;">&nbsp;</div>

                      <div style="font-size:13px;line-height:1.5;color:${textMd};">
                        ${introName}
                      </div>

                      <div style="height:14px;line-height:14px;font-size:14px;">&nbsp;</div>

                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:separate;">
                        ${msgBlock}
                      </table>

                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:separate;">
                        <tr>
                          <td style="padding:0 0 12px 0;">
                            <span style="
                              display:inline-block;
                              padding:6px 10px;
                              border-radius:999px;
                              border:1px solid rgba(255,214,128,.40);
                              background:rgba(255,214,128,.12);
                              color:${gold};
                              font-weight:900;
                              font-size:11px;
                              letter-spacing:.10em;
                              text-transform:uppercase;
                              animation:odpShimmer 2.6s ease-in-out infinite;
                            ">Certified ✓</span>
                          </td>
                        </tr>
                      </table>

                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:separate;">
                        <tr>
                          <td style="
                            padding:14px 14px;
                            border-radius:16px;
                            border:1px solid rgba(255,255,255,.10);
                            background:${panel};
                            background-color:${panel};
                          ">
                            <div style="font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:${textLo};">
                              Verification Hash
                            </div>
                            <div style="height:8px;line-height:8px;font-size:8px;">&nbsp;</div>
                            <div style="
                              font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;
                              font-size:12px;
                              color:${textHi};
                              word-break:break-all;
                            ">${esc(file_hash)}</div>

                            <div style="height:10px;line-height:10px;font-size:10px;">&nbsp;</div>
                            <div style="font-size:11px;line-height:1.45;color:${textLo};">
                              QR opens the official verification terminal (hash-first).
                            </div>
                          </td>
                        </tr>
                      </table>

                      <div style="height:16px;line-height:16px;font-size:16px;">&nbsp;</div>

                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:separate;">
                        <tr>
                          <td valign="bottom" align="left" style="padding:0 14px 0 0;">
                            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">
                              <tr>
                                <td style="padding:0 10px 0 0;">${verifyBtn}</td>
                                ${downloadBtn ? `<td style="padding:0;">${downloadBtn}</td>` : ``}
                              </tr>
                            </table>

                            <div style="height:14px;line-height:14px;font-size:14px;">&nbsp;</div>

                            <div style="font-size:11px;line-height:1.55;color:${textLo};max-width:420px;">
                              This message contains a hash-first verification link. The public verification terminal is authoritative.
                            </div>

                            <div style="height:10px;line-height:10px;font-size:10px;">&nbsp;</div>

                            <div style="font-size:11px;line-height:1.55;color:rgba(148,163,184,.72);max-width:420px;">
                              If you did not request this message, you may ignore it.
                            </div>
                          </td>

                          <td valign="bottom" align="right" style="padding:0;">
                            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">
                              <tr>
                                <td style="
                                  padding:10px;
                                  border-radius:16px;
                                  border:1px solid rgba(255,255,255,.10);
                                  background:${panel};
                                  background-color:${panel};
                                " align="right" valign="bottom">
                                  <img src="${qrPng}" width="168" height="168" alt="Verification QR"
                                       style="display:block;border-radius:12px;border:1px solid rgba(255,255,255,.10);" />
                                  <div style="height:8px;line-height:8px;font-size:8px;">&nbsp;</div>
                                  <div style="font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:${textLo};text-align:right;">
                                    QR Verification
                                  </div>
                                </td>
                              </tr>
                            </table>
                          </td>
                        </tr>
                      </table>

                    </td>
                  </tr>

                  <tr>
                    <td style="padding:0 22px 18px 22px;">
                      <div style="height:1px;background:rgba(255,214,128,.18);"></div>
                      <div style="height:12px;line-height:12px;font-size:12px;">&nbsp;</div>

                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:separate;">
                        <tr>
                          <td align="left" valign="top" style="padding:0;">
                            <div style="font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:rgba(203,213,225,.62);">
                              ${footerTitle}
                            </div>
                            <div style="height:6px;line-height:6px;font-size:6px;">&nbsp;</div>
                            <div style="font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:rgba(148,163,184,.56);">
                              ${footerSub}
                            </div>
                          </td>
                          <td align="right" valign="top" style="padding:0;">
                            <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:10px;line-height:1.45;color:rgba(148,163,184,.50);text-align:right;">
                              ${footerProtocol}
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

        </td>
      </tr>
    </table>
  </body>
</html>
  `.trim();

  const text =
    `${subject}\n\n` +
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
    return json({ ok: false, request_id, error: "SEND_FAILED", details: msg }, 500);
  }
});
