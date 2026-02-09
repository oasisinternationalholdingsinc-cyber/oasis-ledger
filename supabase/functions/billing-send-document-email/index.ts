import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type ReqBody = {
  document_id?: string; // uuid
  hash?: string;        // sha256
  to_email?: string;    // recipient
  to_name?: string;
  subject?: string;

  // optional presentation
  message?: string;

  // tolerated
  expires_in?: number;  // not used (future)
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY"); // REQUIRED
const BILLING_FROM_EMAIL = Deno.env.get("BILLING_FROM_EMAIL") || "billing@oasisintlholdings.com";
const VERIFY_BASE_URL =
  Deno.env.get("BILLING_VERIFY_BASE_URL") || "https://sign.oasisintlholdings.com/verify-billing.html";

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { global: { fetch } });

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

function isUuid(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
function isSha256(v: string) {
  return /^[a-f0-9]{64}$/i.test(v);
}
function safeText(v: unknown, fallback = "") {
  const s = (v ?? "").toString().trim();
  return s || fallback;
}

async function resendSendEmail(args: {
  to: string;
  subject: string;
  html: string;
  reply_to?: string;
}) {
  if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY missing");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: BILLING_FROM_EMAIL,
      to: [args.to],
      subject: args.subject,
      html: args.html,
      ...(args.reply_to ? { reply_to: args.reply_to } : {}),
    }),
  });

  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch {}

  if (!res.ok) {
    const msg = data?.message || text || `HTTP ${res.status}`;
    throw new Error(`RESEND_FAILED: ${msg}`);
  }
  return data; // typically { id: "..." }
}

serve(async (req) => {
  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return json(405, { ok: false, error: "METHOD_NOT_ALLOWED" });

    const body = (await req.json().catch(() => ({}))) as ReqBody;

    const document_id = safeText(body.document_id);
    const hash = safeText(body.hash).toLowerCase();
    const to_email = safeText(body.to_email);
    const to_name = safeText(body.to_name);
    const subjectOverride = safeText(body.subject);
    const message = safeText(body.message);

    if (!document_id && !hash) {
      return json(400, { ok: false, error: "MISSING_IDENTIFIER", message: "Provide document_id OR hash." });
    }
    if (document_id && !isUuid(document_id)) {
      return json(400, { ok: false, error: "INVALID_DOCUMENT_ID" });
    }
    if (hash && !isSha256(hash)) {
      return json(400, { ok: false, error: "INVALID_HASH" });
    }
    if (!to_email) {
      return json(400, { ok: false, error: "MISSING_TO_EMAIL" });
    }

    // Resolve billing document
    let doc: any | null = null;

    if (document_id) {
      const { data, error } = await supabase
        .from("billing_documents")
        .select("*")
        .eq("id", document_id)
        .maybeSingle();
      if (error) return json(500, { ok: false, error: "DB_ERROR", details: error.message });
      doc = data;
    } else {
      const { data, error } = await supabase
        .from("billing_documents")
        .select("*")
        .eq("file_hash", hash)
        .neq("status", "void")
        .order("issued_at", { ascending: false, nullsFirst: false })
        .limit(1);
      if (error) return json(500, { ok: false, error: "DB_ERROR", details: error.message });
      doc = data?.[0] ?? null;
    }

    if (!doc) {
      return json(404, { ok: false, error: "NOT_REGISTERED", message: "Billing document not found." });
    }

    const canonicalHash = safeText(doc.file_hash).toLowerCase();
    if (!canonicalHash || !isSha256(canonicalHash)) {
      return json(500, {
        ok: false,
        error: "MISSING_CANONICAL_HASH",
        message: "billing_documents.file_hash missing/invalid.",
      });
    }

    // Best-effort entity snapshot
    let entity: any | null = null;
    if (doc.entity_id) {
      const { data: ent } = await supabase
        .from("entities")
        .select("id, slug, name")
        .eq("id", doc.entity_id)
        .maybeSingle();
      entity = ent ?? null;
    }

    const lane = (typeof doc.is_test === "boolean") ? (doc.is_test ? "SANDBOX" : "RoT") : "—";
    const title = safeText(doc.document_number) || safeText(doc.external_reference) || "Billing Document";

    const verifyUrl = `${VERIFY_BASE_URL}?hash=${canonicalHash}`;

    const subject =
      subjectOverride ||
      `Oasis Billing • ${title} • ${lane}`;

    const html = `
<div style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;line-height:1.5;color:#0b1220">
  <div style="max-width:640px;margin:0 auto;padding:24px">
    <div style="border:1px solid rgba(15,23,42,.12);border-radius:16px;padding:18px 18px 14px;background:#ffffff">
      <div style="font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:rgba(15,23,42,.55)">
        Oasis Digital Parliament • Billing
      </div>
      <h2 style="margin:10px 0 8px 0;font-size:18px;color:#0b1220">${title}</h2>

      <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Liberation Mono','Courier New',monospace;
                  font-size:12px;color:rgba(15,23,42,.78);margin:0 0 12px 0">
        Lane: <b>${lane}</b><br/>
        Hash: <b>${canonicalHash}</b><br/>
        ${entity ? `Entity: <b>${entity.name || entity.slug}</b><br/>` : ""}
      </div>

      ${message ? `<div style="margin:12px 0 14px 0;color:rgba(15,23,42,.86)">${message}</div>` : ""}

      <a href="${verifyUrl}"
         style="display:inline-block;padding:12px 14px;border-radius:12px;
                text-decoration:none;border:1px solid rgba(245,158,11,.35);
                background:linear-gradient(180deg, rgba(245,158,11,.16), rgba(15,23,42,.02));
                color:#7a4a00;font-weight:700;letter-spacing:.08em;text-transform:uppercase;font-size:12px">
        Verify / View Document
      </a>

      <div style="margin-top:14px;font-size:12px;color:rgba(15,23,42,.58)">
        This email does not carry authority. The Billing Registry and Verification Terminal remain canonical.
      </div>
    </div>

    <div style="margin-top:10px;font-size:11px;color:rgba(15,23,42,.48)">
      If you received this in error, you may ignore it. Verification is hash-anchored.
    </div>
  </div>
</div>
`;

    // send (best effort)
    let provider_message_id: string | null = null;
    let sendStatus = "sent";
    let sendError: string | null = null;

    try {
      const r = await resendSendEmail({ to: to_email, subject, html });
      provider_message_id = r?.id ? String(r.id) : null;
    } catch (e) {
      sendStatus = "failed";
      sendError = e?.message ? String(e.message) : String(e);
    }

    // audit log (never block response)
    try {
      await supabase.from("billing_delivery_events").insert({
        entity_id: doc.entity_id ?? null,
        is_test: (typeof doc.is_test === "boolean") ? doc.is_test : null,
        document_id: doc.id,
        file_hash: canonicalHash,
        channel: "email",
        recipient: to_email,
        status: sendStatus,
        provider: "resend",
        provider_message_id,
        error: sendError,
        metadata: {
          subject,
          to_name: to_name || null,
          verify_url: verifyUrl,
        },
        created_by: doc.created_by ?? null,
      });
    } catch {
      // intentionally ignore
    }

    return json(200, {
      ok: sendStatus === "sent",
      status: sendStatus,
      document_id: doc.id,
      file_hash: canonicalHash,
      lane,
      verify_url: verifyUrl,
      provider: "resend",
      provider_message_id,
      error: sendError,
    });
  } catch (e) {
    return json(500, { ok: false, error: "SEND_FAILED", details: e?.message ? String(e.message) : String(e) });
  }
});
