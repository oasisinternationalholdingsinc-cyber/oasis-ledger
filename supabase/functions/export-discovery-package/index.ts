// supabase/functions/export-discovery-package/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { zipSync, strToU8 } from "https://esm.sh/fflate@0.8.2";
import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";

type ReqBody = {
  hash?: string | null;
  envelope_id?: string | null;
  ledger_id?: string | null;

  // forward-compat
  p_hash?: string | null;
  p_envelope_id?: string | null;
  p_ledger_id?: string | null;
};

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
};

function withCors(extra?: Record<string, string>) {
  return { ...cors, ...(extra ?? {}) };
}

const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x, null, 2), {
    status,
    headers: withCors({ "Content-Type": "application/json" }),
  });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
}

const RESOLVE_RPC = "resolve_verified_record";

function normalizeHash(h: string | null) {
  if (!h) return null;
  const t = h.trim();
  if (!t) return null;
  return t.toLowerCase();
}

async function downloadAsU8(
  supabaseAdmin: ReturnType<typeof createClient>,
  bucket: string,
  path: string,
): Promise<Uint8Array> {
  const { data, error } = await supabaseAdmin.storage.from(bucket).download(path);
  if (error || !data) throw new Error(`DOWNLOAD_FAILED: ${bucket}/${path} :: ${error?.message ?? "no data"}`);
  const ab = await data.arrayBuffer();
  return new Uint8Array(ab);
}

function readmeText() {
  // Keep static. This is packaging documentation, not system state.
  return `OASIS DIGITAL PARLIAMENT
VERIFICATION & DISCOVERY EXPORT
================================

This folder contains a cryptographically verifiable record package generated
by the Oasis Digital Parliament verification system.

This package is an EVIDENCE EXPORT.
It does not itself create legal authority, custody, or certification.
All claims are derived from the Verified Registry at time of export.

---------------------------------------------------------------------

1. PURPOSE OF THIS EXPORT
-------------------------

This export is intended to support:
• Court discovery
• Regulatory review
• Audit examination
• Independent third-party verification

---------------------------------------------------------------------

2. VERIFICATION METHOD (HIGH-LEVEL)
-----------------------------------

Verification is performed by resolving a SHA-256 hash, envelope identifier,
or ledger identifier against a registry of verified records.

The registry, not this export, is the source of truth.

---------------------------------------------------------------------

3. CONTENTS OF THIS FOLDER
--------------------------

/verification.json
  Resolver output at time of export (machine-readable).

/minute_book_signed.pdf
  Preferred authoritative artifact when available (signed Minute Book render).

/certified_archive.pdf
  Registry-archived copy when available.

/attestation.pdf
  Human-readable summary generated from resolver output.

---------------------------------------------------------------------

4. IMPORTANT LIMITATIONS
------------------------

• This export does NOT replace the Verified Registry
• This export does NOT independently certify legality
• This export represents a point-in-time resolution

Independent verification should be performed using the hash.

---------------------------------------------------------------------

5. INDEPENDENT RE-VERIFICATION
------------------------------

Submit the cryptographic hash to:
  https://verify.oasisintlholdings.com

---------------------------------------------------------------------

END OF FILE
`;
}

async function buildAttestationPdf(payload: any): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const mono = await pdf.embedFont(StandardFonts.Courier);

  const led = payload?.ledger ?? {};
  const ent = payload?.entity ?? {};
  const ver = payload?.verified ?? {};

  const lines: Array<{ t: string; mono?: boolean; dim?: boolean }> = [];

  lines.push({ t: "OASIS DIGITAL PARLIAMENT — ATTESTATION SUMMARY" });
  lines.push({ t: "" });
  lines.push({ t: "This summary is generated from resolver output at export time." });
  lines.push({ t: "It does not confer authority; it reports registry-derived integrity signals." });
  lines.push({ t: "" });

  lines.push({ t: `Ledger ID: ${payload?.ledger_id ?? led?.id ?? "—"}`, mono: true });
  lines.push({ t: `Verified Document ID: ${payload?.verified_document_id ?? "—"}`, mono: true });
  lines.push({ t: `Hash (SHA-256): ${payload?.hash ?? ver?.file_hash ?? "—"}`, mono: true });
  lines.push({ t: "" });

  lines.push({ t: `Entity: ${(ent?.name ?? "—")} • ${(ent?.slug ?? "—")}` });
  lines.push({ t: `Lane: ${(led?.is_test === true) ? "SANDBOX" : (led?.is_test === false ? "RoT" : "—")}` });
  lines.push({ t: `Ledger Title: ${led?.title ?? "—"}` });
  lines.push({ t: `Ledger Status: ${led?.status ?? "—"}` });
  lines.push({ t: "" });

  lines.push({ t: `Verification Level: ${String(ver?.verification_level ?? "—")}` });
  lines.push({ t: `Archive Registered: ${String(ver?.is_archived ?? "—")}` });
  lines.push({ t: "" });

  const best = payload?.best_pdf ?? null;
  const pub = payload?.public_pdf ?? null;

  lines.push({ t: `Best Artifact Kind: ${best?.kind ?? "—"}` });
  lines.push({ t: `Best Artifact Pointer: ${(best?.storage_bucket && best?.storage_path) ? `${best.storage_bucket}/${best.storage_path}` : "—"}`, mono: true });
  lines.push({ t: `Minute Book Pointer: ${(pub?.storage_bucket && pub?.storage_path) ? `${pub.storage_bucket}/${pub.storage_path}` : "—"}`, mono: true });
  lines.push({ t: `Registry Archive Pointer: ${(ver?.storage_bucket && ver?.storage_path) ? `${ver.storage_bucket}/${ver.storage_path}` : "—"}`, mono: true });

  lines.push({ t: "" });
  lines.push({ t: `Export Timestamp (UTC): ${new Date().toISOString()}`, mono: true, dim: true });

  // Render
  const margin = 54;
  let y = 740;
  const lh = 16;

  const drawLine = (txt: string, isMono: boolean, dim: boolean) => {
    page.drawText(txt, {
      x: margin,
      y,
      size: 11,
      font: isMono ? mono : font,
      color: dim ? rgb(0.55, 0.55, 0.55) : rgb(0.1, 0.1, 0.1),
    });
    y -= lh;
  };

  // Simple wrap for long mono lines
  const wrap = (s: string, max = 86) => {
    const out: string[] = [];
    let cur = s;
    while (cur.length > max) {
      out.push(cur.slice(0, max));
      cur = cur.slice(max);
    }
    out.push(cur);
    return out;
  };

  for (const L of lines) {
    const txt = L.t ?? "";
    const parts = (L.mono ? wrap(txt, 90) : wrap(txt, 110));
    for (const p of parts) {
      if (y < 60) break;
      drawLine(p, !!L.mono, !!L.dim);
    }
    if (y < 60) break;
  }

  const bytes = await pdf.save();
  return new Uint8Array(bytes);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: withCors() });
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
    global: { headers: { "x-client-info": "odp-verify/export-discovery-package" } },
  });

  let body: ReqBody = {};
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    return json({ ok: false, error: "INVALID_JSON" }, 400);
  }

  const hash = normalizeHash(((body.hash ?? body.p_hash ?? null)?.toString() ?? null));
  const envelope_id =
    ((body.envelope_id ?? body.p_envelope_id ?? null)?.toString() ?? "").trim() || null;
  const ledger_id =
    ((body.ledger_id ?? body.p_ledger_id ?? null)?.toString() ?? "").trim() || null;

  if (!hash && !envelope_id && !ledger_id) {
    return json({ ok: false, error: "MISSING_INPUT", message: "Provide hash OR envelope_id OR ledger_id." }, 400);
  }

  // 1) Resolve using canonical SQL (registry-first; lane-safe; entity-safe)
  const { data: resolved, error: rpcErr } = await supabaseAdmin.rpc(RESOLVE_RPC, {
    p_hash: hash,
    p_envelope_id: envelope_id,
    p_ledger_id: ledger_id,
  });

  if (rpcErr) {
    return json({ ok: false, error: "RPC_FAILED", message: rpcErr.message, details: rpcErr }, 500);
  }

  let payload: any = resolved;
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch {}
  }

  if (!payload || payload.ok !== true) {
    // Export still returns resolver output (enterprise: no lying)
    const readme = readmeText();
    const zipBytes = zipSync({
      "OASIS-DISCOVERY-EXPORT/README.txt": strToU8(readme),
      "OASIS-DISCOVERY-EXPORT/verification.json": strToU8(JSON.stringify(payload ?? {}, null, 2)),
    });

    return new Response(zipBytes, {
      status: 200,
      headers: withCors({
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="Oasis-Discovery-Export.zip"`,
      }),
    });
  }

  // 2) Gather artifacts via pointers (NO guessing)
  const files: Record<string, Uint8Array> = {};
  files["OASIS-DISCOVERY-EXPORT/README.txt"] = strToU8(readmeText());
  files["OASIS-DISCOVERY-EXPORT/verification.json"] = strToU8(JSON.stringify(payload, null, 2));
  files["OASIS-DISCOVERY-EXPORT/attestation.pdf"] = await buildAttestationPdf(payload);

  const best = payload.best_pdf ?? null;
  const pub = payload.public_pdf ?? null;
  const ver = payload.verified ?? null;

  // Best artifact
  if (best?.storage_bucket && best?.storage_path) {
    const u8 = await downloadAsU8(supabaseAdmin, String(best.storage_bucket), String(best.storage_path));
    const name =
      best.kind === "minute_book_signed" ? "minute_book_signed.pdf" :
      best.kind === "minute_book" ? "minute_book.pdf" :
      "best_artifact.pdf";
    files[`OASIS-DISCOVERY-EXPORT/${name}`] = u8;
  }

  // Minute book pointer (include if present and different from best)
  if (pub?.storage_bucket && pub?.storage_path) {
    const sameAsBest =
      best?.storage_bucket === pub.storage_bucket && best?.storage_path === pub.storage_path;
    if (!sameAsBest) {
      const u8 = await downloadAsU8(supabaseAdmin, String(pub.storage_bucket), String(pub.storage_path));
      files["OASIS-DISCOVERY-EXPORT/minute_book.pdf"] = u8;
    }
  }

  // Registry archive (certified archive)
  if (ver?.storage_bucket && ver?.storage_path) {
    const u8 = await downloadAsU8(supabaseAdmin, String(ver.storage_bucket), String(ver.storage_path));
    files["OASIS-DISCOVERY-EXPORT/certified_archive.pdf"] = u8;
  }

  // 3) Zip and return (no storage writes, no DB writes)
  const zipBytes = zipSync(files);

  return new Response(zipBytes, {
    status: 200,
    headers: withCors({
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="Oasis-Discovery-Export-${payload.ledger_id}.zip"`,
    }),
  });
});
