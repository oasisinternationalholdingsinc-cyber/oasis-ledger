// supabase/functions/billing-send-document-email/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * billing-send-document-email (OS / registry-grade)
 * ✅ Operator-triggered (JWT required) + membership-gated by entity_id
 * ✅ Lane-safe (is_test respected)
 * ✅ Non-blocking: uses EdgeRuntime.waitUntil when available
 * ✅ No schema drift: reads billing_documents defensively
 * ✅ Provider-agnostic: ships with Resend implementation (recommended)
 *
 * Expected billing_documents fields (best-effort):
 * - id (uuid)
 * - entity_id (uuid)
 * - is_test (boolean)
 * - status (text)
 * - title / document_title (text)
 * - document_number / invoice_number (text)
 * - storage_bucket (text) + storage_path (text)  OR  pdf_bucket/pdf_path
 * - file_hash / sha256 / hash (text)
 * - recipient_email / to_email / issued_to_email (text)
 * - metadata (jsonb) for extra details
 */

type ReqBody = {
  document_id?: string;
  hash?: string;

  // Optional overrides
  to?: string;
  subject?: string;
  message?: string;

  // Delivery options
  expires_in_seconds?: number; // signed url ttl
  include_attachment?: boolean; // default false (link-only)
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json; charset=utf-8" },
  });
}

function pickString(...vals: Array<unknown>) {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function safeUpper(s: unknown) {
  if (typeof s !== "string") return "";
  return s.trim().toUpperCase();
}

function isUUIDish(x: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
}

function nowISO() {
  return new Date().toISOString();
}

async function sendViaResend(params: {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  attachments?: Array<{ filename: string; content: string; content_type: string }>;
}) {
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: params.from,
      to: [params.to],
      subject: params.subject,
      html: params.html,
      attachments: params.attachments,
    }),
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`RESEND_FAILED: ${resp.status} ${text}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    return { ok: true };
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  if (req.method !== "POST") {
    return json(405, { ok: false, error: "METHOD_NOT_ALLOWED" });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_ROLE_KEY =
    Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return json(500, { ok: false, error: "MISSING_SUPABASE_ENV" });
  }

  // Email provider (Resend recommended)
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  const RESEND_FROM = Deno.env.get("RESEND_FROM") || "Oasis Digital Parliament <no-reply@oasisintlholdings.com>";

  // Operator JWT required (do NOT allow anonymous to trigger email sends)
  const authz = req.headers.get("authorization") || "";
  const jwt = authz.toLowerCase().startsWith("bearer ") ? authz.slice(7).trim() : "";
  if (!jwt) return json(401, { ok: false, error: "MISSING_AUTH" });

  let body: ReqBody;
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    return json(400, { ok: false, error: "INVALID_JSON" });
  }

  const documentId = pickString(body.document_id);
  const hash = pickString(body.hash);

  if (!documentId && !hash) {
    return json(400, { ok: false, error: "MISSING_IDENTIFIER", details: "Provide document_id or hash." });
  }
  if (documentId && !isUUIDish(documentId)) {
    return json(400, { ok: false, error: "INVALID_DOCUMENT_ID" });
  }

  const ttl = Math.max(60, Math.min(Number(body.expires_in_seconds ?? 60 * 60 * 24 * 7), 60 * 60 * 24 * 30)); // 1m..30d
  const includeAttachment = Boolean(body.include_attachment);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { global: { fetch } });

  // 1) Resolve actor (JWT) using service role auth
  const { data: userRes, error: userErr } = await admin.auth.getUser(jwt);
  const actor = userRes?.user ?? null;
  if (userErr || !actor?.id) {
    return json(401, { ok: false, error: "INVALID_SESSION" });
  }

  // 2) Load billing document
  const docQuery = admin.from("billing_documents").select("*").limit(1);

  let docResp;
  if (documentId) docResp = await docQuery.eq("id", documentId).maybeSingle();
  else docResp = await docQuery.or(`file_hash.eq.${hash},sha256.eq.${hash},hash.eq.${hash}`).maybeSingle();

  if (docResp.error) {
    return json(500, { ok: false, error: "DOC_LOOKUP_FAILED", details: docResp.error.message });
  }

  const doc: any = docResp.data;
  if (!doc) return json(404, { ok: false, error: "DOC_NOT_FOUND" });

  const entityId = pickString(doc.entity_id);
  const laneIsTest = Boolean(doc.is_test);

  if (!entityId) return json(500, { ok: false, error: "DOC_MISSING_ENTITY_ID" });

  // 3) Membership gate (mirrors OS operator model)
  // memberships: (user_id uuid, entity_id uuid, role text, is_admin boolean)
  const { data: mem, error: memErr } = await admin
    .from("memberships")
    .select("user_id,entity_id,role,is_admin")
    .eq("user_id", actor.id)
    .eq("entity_id", entityId)
    .limit(1)
    .maybeSingle();

  if (memErr) {
    return json(500, { ok: false, error: "MEMBERSHIP_CHECK_FAILED", details: memErr.message });
  }

  const role = (mem?.role || "").toString().toLowerCase();
  const isAdmin = Boolean(mem?.is_admin) || ["owner", "admin", "operator"].includes(role);
  if (!isAdmin) {
    return json(403, { ok: false, error: "FORBIDDEN" });
  }

  // 4) Resolve storage pointer (defensive)
  const storageBucket =
    pickString(doc.storage_bucket, doc.pdf_bucket, doc.bucket, doc.source_bucket) || "billing";
  const storagePath =
    pickString(doc.storage_path, doc.pdf_path, doc.path, doc.source_path) || null;

  if (!storagePath) {
    return json(409, {
      ok: false,
      error: "DOC_NOT_SEALED",
      details: "No storage_path found on billing_documents. Generate/seal document first.",
    });
  }

  // 5) Create signed URL
  const { data: signed, error: signedErr } = await admin.storage
    .from(storageBucket)
    .createSignedUrl(storagePath, ttl);

  if (signedErr || !signed?.signedUrl) {
    return json(500, {
      ok: false,
      error: "SIGNED_URL_FAILED",
      details: signedErr?.message || "Unknown error",
    });
  }

  // 6) Resolve recipient + subject
  const meta = (doc.metadata && typeof doc.metadata === "object") ? doc.metadata : {};
  const recipient =
    pickString(
      body.to,
      doc.recipient_email,
      doc.to_email,
      doc.issued_to_email,
      doc.contact_email,
      meta?.recipient_email,
      meta?.to,
      meta?.email
    ) || null;

  if (!recipient) {
    return json(409, {
      ok: false,
      error: "MISSING_RECIPIENT",
      details: "No recipient email found on document or request body.",
    });
  }

  const docNo = pickString(doc.document_number, doc.invoice_number, meta?.document_number, meta?.invoice_number);
  const title = pickString(doc.title, doc.document_title, meta?.title) || "Billing Document";
  const status = pickString(doc.status) || "issued";

  const subject =
    pickString(body.subject) ||
    `Oasis ODP • ${title}${docNo ? ` • ${docNo}` : ""}${laneIsTest ? " • SANDBOX" : ""}`;

  const message =
    pickString(body.message) ||
    "Your billing document is ready. Use the secure link below to view/download the PDF.";

  // 7) Prepare email HTML (OS-grade minimal)
  const hashValue = pickString(doc.file_hash, doc.sha256, doc.hash, meta?.file_hash, meta?.sha256, hash) || "—";
  const verifyHint =
    pickString(meta?.verify_url) ||
    (hashValue !== "—"
      ? `https://sign.oasisintlholdings.com/verify-billing.html?hash=${encodeURIComponent(hashValue)}`
      : null);

  const html = `
  <div style="font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; background:#05070c; padding:24px;">
    <div style="max-width:640px; margin:0 auto; border:1px solid rgba(255,255,255,.10); border-radius:24px; overflow:hidden; background:rgba(12,18,30,.70);">
      <div style="padding:18px 20px; border-bottom:1px solid rgba(255,255,255,.08);">
        <div style="letter-spacing:.28em; text-transform:uppercase; font-size:11px; color:rgba(255,255,255,.55);">
          Oasis Digital Parliament • Billing
        </div>
        <div style="margin-top:8px; font-size:18px; font-weight:700; color:rgba(255,255,255,.92);">
          ${title}${docNo ? ` — ${docNo}` : ""}
        </div>
        <div style="margin-top:6px; font-size:12px; color:rgba(255,255,255,.60);">
          Status: ${status} • Lane: ${laneIsTest ? "SANDBOX" : "RoT"}
        </div>
      </div>

      <div style="padding:18px 20px;">
        <div style="font-size:13px; line-height:1.6; color:rgba(255,255,255,.82);">
          ${message}
        </div>

        <div style="margin-top:16px; padding:14px; border-radius:16px; border:1px solid rgba(255,255,255,.10); background:rgba(255,255,255,.04);">
          <div style="font-size:11px; letter-spacing:.22em; text-transform:uppercase; color:rgba(255,255,255,.55);">Secure download</div>
          <div style="margin-top:10px;">
            <a href="${signed.signedUrl}"
              style="display:inline-block; padding:10px 14px; border-radius:999px; text-decoration:none;
                     border:1px solid rgba(255,214,128,.22); background:rgba(255,214,128,.12); color:rgba(255,244,214,.92);
                     font-weight:700; font-size:12px; letter-spacing:.12em; text-transform:uppercase;">
              Download PDF
            </a>
          </div>
          <div style="margin-top:10px; font-size:12px; color:rgba(255,255,255,.55);">
            Link expires in ${Math.round(ttl / 3600)} hours.
          </div>
        </div>

        ${
          verifyHint
            ? `
          <div style="margin-top:14px; font-size:12px; color:rgba(255,255,255,.60);">
            Verification: <a href="${verifyHint}" style="color:rgba(255,214,128,.92); text-decoration:none;">open verifier</a>
          </div>`
            : ""
        }

        <div style="margin-top:14px; font-size:11px; color:rgba(255,255,255,.45);">
          Hash: <span style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas; color:rgba(255,255,255,.65);">${hashValue}</span>
        </div>
      </div>

      <div style="padding:14px 20px; border-top:1px solid rgba(255,255,255,.08); font-size:11px; color:rgba(255,255,255,.45);">
        Operator-triggered delivery • Registry-grade document pointers • ${nowISO()}
      </div>
    </div>
  </div>
  `;

  // 8) Email provider check
  if (!RESEND_API_KEY) {
    return json(500, {
      ok: false,
      error: "MISSING_EMAIL_PROVIDER",
      details: "Set RESEND_API_KEY (and optionally RESEND_FROM) in Supabase Edge env.",
    });
  }

  // 9) Optional attachment (fetch + base64) — default OFF for performance
  async function buildAttachments() {
    if (!includeAttachment) return undefined;

    const obj = await admin.storage.from(storageBucket).download(storagePath);
    if (obj.error || !obj.data) throw new Error(`ATTACHMENT_DOWNLOAD_FAILED: ${obj.error?.message || "no data"}`);

    const bytes = new Uint8Array(await obj.data.arrayBuffer());
    // base64 encode
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    const b64 = btoa(bin);

    const filename = `${(docNo || "billing-document").toString().replace(/[^\w.-]+/g, "_")}.pdf`;
    return [{ filename, content: b64, content_type: "application/pdf" }];
  }

  // 10) Non-blocking send (preferred)
  const work = (async () => {
    const attachments = await buildAttachments();
    const result = await sendViaResend({
      apiKey: RESEND_API_KEY!,
      from: RESEND_FROM,
      to: recipient,
      subject,
      html,
      attachments,
    });

    // Optional: record an audit event if you already have a table for it.
    // We do NOT assume schema here (no insert by default).
    return result;
  })();

  // If runtime supports waitUntil, return immediately (async/non-blocking).
  // Otherwise, await normally.
  const anyRT: any = (globalThis as any).EdgeRuntime;
  if (anyRT?.waitUntil) {
    try {
      anyRT.waitUntil(work);
      return json(200, {
        ok: true,
        queued: true,
        document_id: doc.id,
        entity_id: entityId,
        is_test: laneIsTest,
        to: recipient,
        provider: "resend",
      });
    } catch {
      // fall through to await
    }
  }

  // Fallback: blocking send (still safe)
  const sendResult = await work;
  return json(200, {
    ok: true,
    queued: false,
    document_id: doc.id,
    entity_id: entityId,
    is_test: laneIsTest,
    to: recipient,
    provider: "resend",
    result: sendResult ?? null,
  });
});
