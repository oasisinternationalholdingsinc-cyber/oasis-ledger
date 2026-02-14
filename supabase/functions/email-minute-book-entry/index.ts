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
  | { ok: true; request_id: string; to_email: string; verify_url: string; download_url?: string | null }
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
  const x = (s || "").trim();
  return x;
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
      { ok: false, request_id, error: "SERVER_MISCONFIGURED", details: "Missing SUPABASE_URL/SERVICE_ROLE." },
      500
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
        details: "No verified_documents.file_hash found for this Minute Book entry (must be certified/verified first).",
      },
      404
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
      500
    );
  }

  const subject = "Minute Book Entry — Verified Copy";

  const introName = to_name ? `Hello ${esc(to_name)},` : "Hello,";
  const msgBlock = message
    ? `<p style="margin:12px 0 0;color:#cbd5e1;font-size:13px;line-height:1.5">${esc(message)}</p>`
    : "";

  const html = `
  <div style="font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; background:#05070c; color:#e5e7eb; padding:24px; border-radius:16px">
    <div style="max-width:720px; margin:0 auto;">
      <div style="letter-spacing:.28em; text-transform:uppercase; font-size:11px; color:rgba(255,255,255,.55)">Oasis Digital Parliament</div>
      <h1 style="margin:10px 0 0; font-size:18px; font-weight:700; color:#fff">Minute Book Entry — Verified Copy</h1>
      <p style="margin:10px 0 0; color:rgba(255,255,255,.68); font-size:13px; line-height:1.5">${introName}</p>
      ${msgBlock}

      <div style="margin:18px 0 0; padding:14px; border:1px solid rgba(255,255,255,.10); border-radius:14px; background:rgba(14,22,36,.55)">
        <div style="font-size:11px; letter-spacing:.20em; text-transform:uppercase; color:rgba(255,255,255,.55)">Verification Hash</div>
        <div style="margin-top:8px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size:12px; color:#fff; word-break:break-all">${esc(file_hash)}</div>
      </div>

      <div style="margin:16px 0 0; display:flex; gap:10px; flex-wrap:wrap">
        <a href="${esc(verify_url)}" style="display:inline-block; padding:10px 14px; border-radius:999px; background:rgba(255,214,128,.95); color:#0b0f17; font-weight:700; text-decoration:none; font-size:12px">
          Verify (Hash-first)
        </a>
        ${
          download_url
            ? `<a href="${esc(download_url)}" style="display:inline-block; padding:10px 14px; border-radius:999px; background:rgba(56,189,248,.16); color:#bae6fd; border:1px solid rgba(56,189,248,.30); font-weight:700; text-decoration:none; font-size:12px">
                Download PDF (time-limited)
              </a>`
            : ""
        }
      </div>

      <p style="margin:16px 0 0; color:rgba(255,255,255,.55); font-size:11px; line-height:1.5">
        This email contains a hash-first verification link. The public verification terminal is authoritative.
      </p>
    </div>
  </div>
  `;

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
    return json({ ok: false, request_id, error: "SEND_FAILED", details: msg }, 500);
  }
});
