// supabase/functions/export-discovery-package/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { zipSync, strToU8 } from "https://esm.sh/fflate@0.8.2";
import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";

// NOTE:
// - No schema writes.
// - No storage writes.
// - Resolver remains canonical.
// - This function only packages evidence that the resolver already points to.

type ReqBody = {
  hash?: string | null;
  envelope_id?: string | null;
  ledger_id?: string | null;

  // uploaded docs / minute book records
  entry_id?: string | null;

  // forward-compat aliases
  p_hash?: string | null;
  p_envelope_id?: string | null;
  p_ledger_id?: string | null;
  p_entry_id?: string | null;
};

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Expose-Headers": "content-type, x-sb-request-id",
  "Access-Control-Max-Age": "86400",
};

function withCors(extra?: Record<string, string>) {
  return { ...cors, ...(extra ?? {}) };
}

const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x, null, 2), {
    status,
    headers: withCors({ "Content-Type": "application/json" }),
  });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  "";

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
}

const RESOLVE_RPC = "resolve_verified_record";
const RESOLVE_EDGE_FN = "resolve-verified-record";

function normalizeHash(h: string | null) {
  if (!h) return null;
  const t = h.trim();
  if (!t) return null;
  return t.toLowerCase();
}

function normalizeUuid(v: string | null) {
  if (!v) return null;
  const t = v.trim();
  return t ? t : null;
}

async function downloadAsU8(
  supabaseAdmin: ReturnType<typeof createClient>,
  bucket: string,
  path: string,
): Promise<Uint8Array> {
  const { data, error } = await supabaseAdmin.storage.from(bucket).download(path);
  if (error || !data) {
    throw new Error(
      `DOWNLOAD_FAILED: ${bucket}/${path} :: ${error?.message ?? "no data"}`,
    );
  }
  const ab = await data.arrayBuffer();
  return new Uint8Array(ab);
}

function readmeText() {
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
ledger identifier, or Minute Book entry identifier against a registry of verified records.

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
  Human-readable summary generated from resolver output (non-authoritative).

/MANIFEST-SHA256.txt
  SHA-256 hashes of every file in this export (for independent integrity checks).

/QR-HASH-REFERENCE.txt
  Human-readable verification instructions for the SHA-256 reference.

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

function qrHashReferenceText(hash: string) {
  return `OASIS DIGITAL PARLIAMENT
QR / HASH REFERENCE (NON-AUTHORITATIVE)
======================================

Reference Hash (SHA-256):
${hash}

How to verify:
1) Open: https://verify.oasisintlholdings.com
2) Paste the hash into the verification terminal.
3) Confirm the Verified Registry resolves the record and returns signed URL delivery.

This file is a convenience reference for auditors and counsel.
It does not create authority, certification, or custody.
`;
}

// ---------- SHA-256 helpers (manifest) ----------
function toHex(bytes: ArrayBuffer) {
  const u8 = new Uint8Array(bytes);
  let out = "";
  for (let i = 0; i < u8.length; i++) out += u8[i].toString(16).padStart(2, "0");
  return out;
}

async function sha256Hex(u8: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", u8);
  return toHex(digest);
}

async function buildManifest(files: Record<string, Uint8Array>) {
  const paths = Object.keys(files).slice().sort();
  const lines: string[] = [];
  lines.push("OASIS DIGITAL PARLIAMENT — SHA-256 MANIFEST");
  lines.push("MANIFEST-SHA256.txt is non-authoritative; it supports integrity checking.");
  lines.push(`Generated (UTC): ${new Date().toISOString()}`);
  lines.push("");
  for (const p of paths) {
    const h = await sha256Hex(files[p]);
    lines.push(`${h}  ${p}`);
  }
  lines.push("");
  lines.push("END OF MANIFEST");
  return lines.join("\n");
}

// ---------- Attestation PDF ----------
type AttLine = { t: string; mono?: boolean; dim?: boolean };

function jurisdictionLine(payload: any): string | null {
  const ent = payload?.entity ?? {};
  const led = payload?.ledger ?? {};
  const ver = payload?.verified ?? {};
  const j =
    payload?.jurisdiction ??
    ent?.jurisdiction ??
    led?.jurisdiction ??
    ver?.jurisdiction ??
    null;
  if (!j) return null;
  const s = String(j).trim();
  return s ? s : null;
}

async function buildAttestationPdf(payload: any): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();

  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);

  const led = payload?.ledger ?? {};
  const ent = payload?.entity ?? {};
  const ver = payload?.verified ?? {};

  const lines: AttLine[] = [];

  lines.push({ t: "OASIS DIGITAL PARLIAMENT" });
  lines.push({ t: "ATTESTATION SUMMARY (NON-AUTHORITATIVE)", dim: true });
  lines.push({ t: "" });

  const juris = jurisdictionLine(payload);
  if (juris) {
    lines.push({ t: `Jurisdiction (non-authoritative): ${juris}` });
    lines.push({
      t:
        "Jurisdiction is reported from registry payload fields only. Legal effect is determined by applicable law and competent authority.",
      dim: true,
    });
    lines.push({ t: "" });
  }

  lines.push({ t: "This summary is generated from resolver output at export time." });
  lines.push({
    t: "It does not confer authority; it reports registry-derived integrity signals.",
  });
  lines.push({ t: "" });

  lines.push({
    t: `Ledger ID: ${payload?.ledger_id ?? led?.id ?? "—"}`,
    mono: true,
  });
  lines.push({
    t: `Entry ID: ${payload?.entry_id ?? payload?.source?.record_id ?? "—"}`,
    mono: true,
  });
  lines.push({
    t: `Verified Document ID: ${payload?.verified_document_id ?? "—"}`,
    mono: true,
  });
  lines.push({
    t: `Hash (SHA-256): ${payload?.hash ?? ver?.file_hash ?? "—"}`,
    mono: true,
  });
  lines.push({ t: "" });

  lines.push({ t: `Entity: ${ent?.name ?? "—"} • ${ent?.slug ?? "—"}` });
  lines.push({
    t: `Lane: ${
      led?.is_test === true ? "SANDBOX" : led?.is_test === false ? "RoT" : "—"
    }`,
  });
  lines.push({ t: `Ledger Title: ${led?.title ?? "—"}` });
  lines.push({ t: `Ledger Status: ${led?.status ?? "—"}` });
  lines.push({ t: "" });

  lines.push({
    t: `Verification Level: ${String(ver?.verification_level ?? "—")}`,
  });
  lines.push({ t: `Archive Registered: ${String(ver?.is_archived ?? "—")}` });
  lines.push({ t: "" });

  const best = payload?.best_pdf ?? null;
  const pub = payload?.public_pdf ?? null;

  lines.push({ t: `Best Artifact Kind: ${best?.kind ?? "—"}` });
  lines.push({
    t: `Best Artifact Pointer: ${
      best?.storage_bucket && best?.storage_path
        ? `${best.storage_bucket}/${best.storage_path}`
        : "—"
    }`,
    mono: true,
  });
  lines.push({
    t: `Minute Book Pointer: ${
      pub?.storage_bucket && pub?.storage_path
        ? `${pub.storage_bucket}/${pub.storage_path}`
        : "—"
    }`,
    mono: true,
  });
  lines.push({
    t: `Registry Archive Pointer: ${
      ver?.storage_bucket && ver?.storage_path
        ? `${ver.storage_bucket}/${ver.storage_path}`
        : "—"
    }`,
    mono: true,
  });

  lines.push({ t: "" });
  lines.push({
    t: `Export Timestamp (UTC): ${new Date().toISOString()}`,
    mono: true,
    dim: true,
  });

  const PAGE_W = 612;
  const PAGE_H = 792;

  const marginX = 54;
  const topY = PAGE_H - 54;
  const bottomY = 54;
  const lh = 16;

  const wrap = (s: string, max: number) => {
    const out: string[] = [];
    let cur = s;
    while (cur.length > max) {
      out.push(cur.slice(0, max));
      cur = cur.slice(max);
    }
    out.push(cur);
    return out;
  };

  const wrapped: AttLine[] = [];
  for (const L of lines) {
    const txt = L.t ?? "";
    const parts = wrap(txt, L.mono ? 90 : 110);
    for (const p of parts) wrapped.push({ t: p, mono: L.mono, dim: L.dim });
  }

  const headerSpace = 52;
  const footerSpace = 34;
  const usable = (topY - headerSpace) - (bottomY + footerSpace);
  const linesPerPage = Math.max(1, Math.floor(usable / lh));
  const totalPages = Math.max(1, Math.ceil(wrapped.length / linesPerPage));

  const drawPageFrame = (page: any, pageNo: number) => {
    page.drawText("OASIS DIGITAL PARLIAMENT", {
      x: marginX,
      y: PAGE_H - 36,
      size: 9,
      font: fontBold,
      color: rgb(0.55, 0.55, 0.55),
    });
    page.drawLine({
      start: { x: marginX, y: PAGE_H - 44 },
      end: { x: PAGE_W - marginX, y: PAGE_H - 44 },
      thickness: 1,
      color: rgb(0.92, 0.92, 0.92),
      opacity: 0.15,
    });

    const wm = "ATTESTATION (NON-AUTHORITATIVE)";
    page.drawText(wm, {
      x: 70,
      y: PAGE_H / 2,
      size: 26,
      font: fontBold,
      color: rgb(0.2, 0.2, 0.2),
      opacity: 0.06,
      rotate: { type: "degrees", angle: 20 },
    });

    page.drawLine({
      start: { x: marginX, y: bottomY + 18 },
      end: { x: PAGE_W - marginX, y: bottomY + 18 },
      thickness: 1,
      color: rgb(0.92, 0.92, 0.92),
      opacity: 0.10,
    });

    page.drawText(`Page ${pageNo} of ${totalPages}`, {
      x: PAGE_W - marginX - 110,
      y: bottomY + 4,
      size: 9,
      font: mono,
      color: rgb(0.55, 0.55, 0.55),
    });
  };

  for (let p = 0; p < totalPages; p++) {
    const page = pdf.addPage([PAGE_W, PAGE_H]);
    drawPageFrame(page, p + 1);

    let y = topY - headerSpace;

    const start = p * linesPerPage;
    const end = Math.min(wrapped.length, start + linesPerPage);

    for (let i = start; i < end; i++) {
      const L = wrapped[i];
      const isMono = !!L.mono;
      const dim = !!L.dim;

      const useBold =
        (!isMono &&
          !dim &&
          (L.t.includes("ATTESTATION SUMMARY") || L.t === "OASIS DIGITAL PARLIAMENT"));

      page.drawText(L.t, {
        x: marginX,
        y,
        size: 11,
        font: useBold ? fontBold : (isMono ? mono : font),
        color: dim ? rgb(0.55, 0.55, 0.55) : rgb(0.10, 0.10, 0.10),
      });
      y -= lh;
    }
  }

  const bytes = await pdf.save();
  return new Uint8Array(bytes);
}

// canonical resolve via Edge Function (supports entry_id)
async function resolveViaEdge(body: Record<string, unknown>) {
  const url = `${SUPABASE_URL.replace(/\/$/, "")}/functions/v1/${RESOLVE_EDGE_FN}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      apikey: SERVICE_ROLE_KEY,
      "x-client-info": "odp-verify/export-discovery-package",
    },
    body: JSON.stringify(body),
  });

  const txt = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(txt);
  } catch {
    data = txt;
  }

  if (!res.ok) {
    return { ok: false, error: "EDGE_RESOLVE_FAILED", status: res.status, data };
  }

  return data;
}

// downloads any array of storage pointers returned by resolver (no guessing)
async function addPointerArray(
  supabaseAdmin: ReturnType<typeof createClient>,
  files: Record<string, Uint8Array>,
  baseDir: string,
  arr: any,
) {
  if (!Array.isArray(arr)) return;
  let idx = 0;
  for (const item of arr) {
    const b = item?.storage_bucket;
    const p = item?.storage_path;
    if (!b || !p) continue;

    const rawName =
      item?.filename ||
      item?.name ||
      item?.title ||
      item?.kind ||
      `artifact_${idx + 1}`;

    const safeName = String(rawName)
      .trim()
      .replace(/[\/\\]+/g, "-")
      .replace(/[^\w\-. ]+/g, "")
      .replace(/\s+/g, "_")
      .slice(0, 120) || `artifact_${idx + 1}`;

    const ext =
      typeof item?.mime === "string" && item.mime.includes("pdf") ? ".pdf" :
      (String(p).toLowerCase().endsWith(".pdf") ? ".pdf" : "");

    const u8 = await downloadAsU8(supabaseAdmin, String(b), String(p));
    files[`${baseDir}/${safeName}${ext}`] = u8;
    idx++;
  }
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
    global: {
      fetch,
      headers: { "x-client-info": "odp-verify/export-discovery-package" },
    },
  });

  let body: ReqBody = {};
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    return json({ ok: false, error: "INVALID_JSON" }, 400);
  }

  const hash = normalizeHash(((body.hash ?? body.p_hash ?? null)?.toString() ?? null));
  const envelope_id = normalizeUuid(((body.envelope_id ?? body.p_envelope_id ?? null)?.toString() ?? null));
  const ledger_id = normalizeUuid(((body.ledger_id ?? body.p_ledger_id ?? null)?.toString() ?? null));
  const entry_id = normalizeUuid(((body.entry_id ?? body.p_entry_id ?? null)?.toString() ?? null));

  if (!hash && !envelope_id && !ledger_id && !entry_id) {
    return json(
      { ok: false, error: "MISSING_INPUT", message: "Provide hash OR envelope_id OR ledger_id OR entry_id." },
      400,
    );
  }

  // 1) Resolve canonically
  let payload: any = null;

  if (entry_id) {
    payload = await resolveViaEdge({ entry_id });
  } else {
    const { data, error } = await supabaseAdmin.rpc(RESOLVE_RPC, {
      p_hash: hash,
      p_envelope_id: envelope_id,
      p_ledger_id: ledger_id,
    });

    if (error) {
      return json({ ok: false, error: "RPC_FAILED", message: error.message }, 500);
    }
    payload = data;
  }

  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch { /* keep string */ }
  }

  // ✅ SAFETY NET:
  // If caller passed a Minute Book entry UUID in ledger_id by mistake, protect the system:
  // - no schema changes
  // - no guessing
  // - only try entry_id resolution when we *know* ledger lookup failed
  if (
    (!entry_id && ledger_id) &&
    payload &&
    payload.ok === false &&
    (payload.error === "LEDGER_NOT_FOUND" || payload.error === "NOT_FOUND")
  ) {
    const retry = await resolveViaEdge({ entry_id: ledger_id });
    if (retry && retry.ok === true) payload = retry;
  }

  // -------------------------
  // FAIL-SAFE ZIP (no lying)
  // -------------------------
  if (!payload || payload.ok !== true) {
    const base: Record<string, Uint8Array> = {};
    base["OASIS-DISCOVERY-EXPORT/README.txt"] = strToU8(readmeText());
    base["OASIS-DISCOVERY-EXPORT/verification.json"] = strToU8(
      JSON.stringify(payload ?? {}, null, 2),
    );
    base["OASIS-DISCOVERY-EXPORT/MANIFEST-SHA256.txt"] = strToU8(
      await buildManifest(base),
    );

    const zipBytes = zipSync(base);
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
  files["OASIS-DISCOVERY-EXPORT/verification.json"] = strToU8(
    JSON.stringify(payload, null, 2),
  );

  // Always generate attestation when ok:true
  files["OASIS-DISCOVERY-EXPORT/attestation.pdf"] = await buildAttestationPdf(payload);

  const best = payload.best_pdf ?? null;
  const pub = payload.public_pdf ?? null;
  const ver = payload.verified ?? null;

  const canonicalHash =
    (payload?.hash && String(payload.hash)) ||
    (ver?.file_hash && String(ver.file_hash)) ||
    null;

  if (canonicalHash) {
    files["OASIS-DISCOVERY-EXPORT/QR-HASH-REFERENCE.txt"] = strToU8(
      qrHashReferenceText(canonicalHash),
    );
  }

  // Best artifact
  if (best?.storage_bucket && best?.storage_path) {
    const u8 = await downloadAsU8(
      supabaseAdmin,
      String(best.storage_bucket),
      String(best.storage_path),
    );
    const name =
      best.kind === "minute_book_signed"
        ? "minute_book_signed.pdf"
        : best.kind === "minute_book"
          ? "minute_book.pdf"
          : "best_artifact.pdf";
    files[`OASIS-DISCOVERY-EXPORT/${name}`] = u8;
  }

  // Minute book pointer (include if present and different from best)
  if (pub?.storage_bucket && pub?.storage_path) {
    const sameAsBest =
      best?.storage_bucket === pub.storage_bucket &&
      best?.storage_path === pub.storage_path;
    if (!sameAsBest) {
      const u8 = await downloadAsU8(
        supabaseAdmin,
        String(pub.storage_bucket),
        String(pub.storage_path),
      );
      files["OASIS-DISCOVERY-EXPORT/minute_book.pdf"] = u8;
    }
  }

  // Registry archive (certified archive)
  if (ver?.storage_bucket && ver?.storage_path) {
    const u8 = await downloadAsU8(
      supabaseAdmin,
      String(ver.storage_bucket),
      String(ver.storage_path),
    );
    files["OASIS-DISCOVERY-EXPORT/certified_archive.pdf"] = u8;
  }

  // OPTIONAL: include any extra artifacts the resolver returns (future-proof, no regression)
  // Examples your resolver may emit in future:
  // - payload.artifacts: [{ kind, filename, storage_bucket, storage_path, mime }]
  // - payload.supporting_documents: [...]
  await addPointerArray(
    supabaseAdmin,
    files,
    "OASIS-DISCOVERY-EXPORT/artifacts",
    payload?.artifacts,
  );
  await addPointerArray(
    supabaseAdmin,
    files,
    "OASIS-DISCOVERY-EXPORT/supporting_documents",
    payload?.supporting_documents,
  );

  // 3) SHA-256 manifest
  files["OASIS-DISCOVERY-EXPORT/MANIFEST-SHA256.txt"] = strToU8(
    await buildManifest(files),
  );

  // 4) Zip and return
  const zipBytes = zipSync(files);

  const safeId =
    (payload?.ledger_id ?? ledger_id ?? payload?.entry_id ?? entry_id ?? "record")
      .toString();

  return new Response(zipBytes, {
    status: 200,
    headers: withCors({
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="Oasis-Discovery-Export-${safeId}.zip"`,
    }),
  });
});
