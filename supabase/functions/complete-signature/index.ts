// supabase/functions/complete-signature/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";
import QRCode from "https://esm.sh/qrcode@1.5.3";

// ---------------------------------------------------------------------------
// SUPABASE CLIENT
// ---------------------------------------------------------------------------
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY =
  Deno.env.get("SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: { fetch },
});

const BUCKET = "minute_book";

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, apikey, X-Client-Info",
  };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

async function sha256Hex(bytes: ArrayBuffer | Uint8Array) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = u8;

  const digest = await crypto.subtle.digest(
    "SHA-256",
    view.byteOffset === 0 && view.byteLength === view.buffer.byteLength
      ? view.buffer
      : view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength),
  );

  const hashArray = Array.from(new Uint8Array(digest));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- OPTIONAL wet-ink helpers (additive, no wiring regression) ----
function isPngDataUrl(v: unknown): v is string {
  return typeof v === "string" && v.startsWith("data:image/png;base64,");
}

function decodePngDataUrl(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(",")[1] ?? "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function safeText(v: unknown): string | null {
  if (v == null) return null;
  const t = String(v).trim();
  return t.length ? t : null;
}

function toSignedPath(basePath: string): string {
  if (/\.pdf$/i.test(basePath)) return basePath.replace(/\.pdf$/i, "-signed.pdf");
  return `${basePath}-signed.pdf`;
}

function canonicalizeResolutionsPath(p: string): string {
  return p.replace("/Resolutions/", "/resolutions/");
}

function truncateMiddle(s: string, max = 34) {
  const t = String(s ?? "");
  if (t.length <= max) return t;
  const left = Math.ceil((max - 3) / 2);
  const right = Math.floor((max - 3) / 2);
  return `${t.slice(0, left)}...${t.slice(t.length - right)}`;
}

// ---------------------------------------------------------------------------
// QR RENDERING (EDGE-SAFE): draw QR as vector modules directly in PDF
// ---------------------------------------------------------------------------
// qrcode@1.5.3 can generate module matrix without canvas via `create`.
// We then draw filled rectangles for "dark" modules.
// This is deterministic, fast, and cannot regress due to runtime DOM APIs.
function drawQrToPdf(opts: {
  page: any;
  url: string;
  x: number;
  y: number;
  size: number; // total square size
}) {
  const { page, url, x, y, size } = opts;

  // Create QR matrix (no canvas)
  // errorCorrectionLevel M is a good balance; you can bump to Q if you want.
  const qr = QRCode.create(url, { errorCorrectionLevel: "M" });

  const modules = qr.modules;
  if (!modules || typeof modules.size !== "number" || !modules.data) {
    throw new Error("CERTIFICATE_QR_MATRIX_FAILED");
  }

  const n = modules.size;
  const data: boolean[] = modules.data; // row-major booleans

  // Add a quiet zone (margin) as white plate is already drawn outside.
  const quiet = 2; // modules
  const total = n + quiet * 2;
  const cell = size / total;

  // Draw white background inside QR bounds for perfect contrast
  page.drawRectangle({
    x,
    y,
    width: size,
    height: size,
    color: rgb(1, 1, 1),
  });

  // Draw modules (black squares)
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const idx = row * n + col;
      const dark = !!data[idx];
      if (!dark) continue;

      const px = x + (col + quiet) * cell;
      const py = y + (total - (row + quiet) - 1) * cell; // flip Y so row 0 is top

      page.drawRectangle({
        x: px,
        y: py,
        width: cell,
        height: cell,
        color: rgb(0, 0, 0),
      });
    }
  }
}

// Resolve a base PDF path even when envelope pointers are missing.
async function resolveBasePdfPath(recordId: string): Promise<string | null> {
  const rid = recordId.toLowerCase();

  const candidates = [
    `holdings/resolutions/${recordId}.pdf`,
    `holdings/Resolutions/${recordId}.pdf`,
    `real-estate/resolutions/${recordId}.pdf`,
    `real-estate/Resolutions/${recordId}.pdf`,
    `lounge/resolutions/${recordId}.pdf`,
    `lounge/Resolutions/${recordId}.pdf`,
  ];

  for (const name of candidates) {
    const { data, error } = await supabase
      .from("storage.objects")
      .select("name")
      .eq("bucket_id", BUCKET)
      .eq("name", name)
      .limit(1);

    if (!error && data && data.length > 0) return String(data[0].name);
  }

  const { data: rows, error: scanErr } = await supabase
    .from("storage.objects")
    .select("name, created_at")
    .eq("bucket_id", BUCKET)
    .or([`name.ilike.%/resolutions/%`, `name.ilike.%/Resolutions/%`].join(","))
    .order("created_at", { ascending: false })
    .limit(400);

  if (scanErr || !rows) {
    console.error("resolveBasePdfPath storage.objects scan failed", scanErr);
    return null;
  }

  for (const row of rows as any[]) {
    const name = String(row?.name ?? "");
    if (!name) continue;
    const lower = name.toLowerCase();
    if (!lower.includes(rid)) continue;
    if (lower.endsWith("-signed.pdf")) continue;
    if (lower.endsWith(".pdf")) return name;
  }

  for (const row of rows as any[]) {
    const name = String(row?.name ?? "");
    if (!name) continue;
    if (name.toLowerCase().includes(rid)) return name;
  }

  return null;
}

async function mustUpdateEnvelope(envelope_id: string, patch: Record<string, unknown>) {
  const { error } = await supabase
    .from("signature_envelopes")
    .update(patch)
    .eq("id", envelope_id);

  if (error) {
    console.error("signature_envelopes update failed", error, patch);
    throw new Error(`ENVELOPE_UPDATE_FAILED: ${error.message}`);
  }
}

async function mustInsertEvent(row: Record<string, unknown>) {
  const { error } = await supabase.from("signature_events").insert(row);
  if (error) {
    console.error("signature_events insert failed (non-fatal)", error);
  }
}

// ---------------------------------------------------------------------------
// HTTP HANDLER
// ---------------------------------------------------------------------------
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders() });
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "Use POST" }, 405);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const {
    envelope_id,
    party_id,

    // capability token (accept BOTH names; legacy-safe)
    token,
    party_token,

    client_ip,
    user_agent,
    wet_signature_mode,
    wet_signature_png,

    // allow regen even if already signed/completed
    force_regen,
  } = body ?? {};

  if (!envelope_id || !party_id) {
    return json({ ok: false, error: "envelope_id and party_id are required" }, 400);
  }

  const providedToken = party_token ?? token;

  try {
    const signedAt = new Date().toISOString();

    // 1) Load envelope
    const { data: envelope, error: envErr } = await supabase
      .from("signature_envelopes")
      .select(
        "id, status, title, entity_id, record_id, supporting_document_path, storage_path, metadata, is_test",
      )
      .eq("id", envelope_id)
      .single();

    if (envErr || !envelope) {
      console.error("Envelope fetch error", envErr);
      return json({ ok: false, error: "Envelope not found", details: envErr }, 404);
    }

    // 2) Load party (include party_token)
    const { data: party, error: partyErr } = await supabase
      .from("signature_parties")
      .select("id, envelope_id, email, display_name, role, status, party_token")
      .eq("id", party_id)
      .eq("envelope_id", envelope_id)
      .single();

    if (partyErr || !party) {
      console.error("Party fetch error", partyErr);
      return json({ ok: false, error: "Signature party not found", details: partyErr }, 404);
    }

    // 2.1) Capability token enforcement (NO REGRESSION)
    if (party.party_token) {
      const expected = String(party.party_token);
      const provided = String(providedToken ?? "");

      if (!provided) return json({ ok: false, error: "SIGNING_TOKEN_REQUIRED" }, 401);
      if (provided !== expected) return json({ ok: false, error: "SIGNING_TOKEN_INVALID" }, 403);
    }

    const partyStatus = String(party.status ?? "").toLowerCase();
    const alreadySigned = partyStatus === "signed";
    const wantRegen = !!force_regen;

    // 3) Mark party signed (only if not already)
    if (!alreadySigned) {
      const { error: partyUpdateErr } = await supabase
        .from("signature_parties")
        .update({ status: "signed", signed_at: signedAt })
        .eq("id", party_id)
        .eq("envelope_id", envelope_id);

      if (partyUpdateErr) {
        console.error("Party update error", partyUpdateErr);
        return json({ ok: false, error: "Failed to update party", details: partyUpdateErr }, 500);
      }
    }

    // 3.1) OPTIONAL: capture wet-ink PNG (fail-soft)
    let wetSignaturePath: string | null = null;
    try {
      const mode = String(wet_signature_mode ?? "").toLowerCase();
      if (mode === "draw" && isPngDataUrl(wet_signature_png)) {
        if (wet_signature_png.length > 1_500_000) {
          console.warn("wet_signature_png too large; skipping capture");
        } else {
          const pngBytes = decodePngDataUrl(wet_signature_png);
          wetSignaturePath = `signatures/${envelope_id}/${party_id}-${Date.now()}.png`;

          const { error: sigUpErr } = await supabase.storage
            .from(BUCKET)
            .upload(wetSignaturePath, new Blob([pngBytes], { type: "image/png" }), {
              upsert: true,
              contentType: "image/png",
            });

          if (sigUpErr) {
            console.error("Wet signature upload error (non-fatal)", sigUpErr);
            wetSignaturePath = null;
          }
        }
      }
    } catch (e) {
      console.error("Wet signature capture threw (non-fatal)", e);
      wetSignaturePath = null;
    }

    // 4) Check if all parties signed
    const { data: allParties, error: allPartiesErr } = await supabase
      .from("signature_parties")
      .select("status")
      .eq("envelope_id", envelope_id);

    if (allPartiesErr || !allParties) {
      console.error("All parties fetch error", allPartiesErr);
      return json({ ok: false, error: "Failed to check parties", details: allPartiesErr }, 500);
    }

    const allSigned =
      allParties.length > 0 &&
      allParties.every((p: any) => String(p.status).toLowerCase() === "signed");

    const nextStatus = allSigned ? "completed" : "partial";

    // 5) Load entity + record for certificate text
    const { data: entity } = await supabase
      .from("entities")
      .select("id, slug, name")
      .eq("id", envelope.entity_id)
      .single();

    const { data: record } = await supabase
      .from("governance_ledger")
      .select("id, title, description, created_at")
      .eq("id", envelope.record_id)
      .single();

    // 5.5) Verify URL
    const verifyUrl =
      (envelope as any)?.metadata?.verify_url ??
      `https://sign.oasisintlholdings.com/verify.html?envelope_id=${envelope_id}`;

    let basePath: string | null = null;
    let signedPath: string | null = null; // legacy path (NO REGRESSION)
    let signedPathCanonical: string | null = null; // additive twin
    let pdfHash: string | null = null;

    // -----------------------------------------------------------------------
    // 6) Generate signed PDF with certificate page
    // -----------------------------------------------------------------------
    if (allSigned && (!alreadySigned || wantRegen)) {
      const metaPath = safeText((envelope as any)?.metadata?.storage_path);
      const envSupport = safeText((envelope as any)?.supporting_document_path);
      const envStorage = safeText((envelope as any)?.storage_path);

      basePath =
        envSupport ??
        envStorage ??
        metaPath?.replace(/^minute_book\//, "") ??
        null;

      if (!basePath) {
        basePath = await resolveBasePdfPath(String(envelope.record_id));
      }

      if (!basePath) {
        console.warn("No base PDF path could be resolved; cannot generate signed PDF.");
      } else {
        const { data: originalFile, error: dlErr } = await supabase.storage
          .from(BUCKET)
          .download(basePath);

        if (dlErr || !originalFile) {
          console.error("Error downloading base PDF:", dlErr);
        } else {
          const originalBytes = await originalFile.arrayBuffer();
          const pdfDoc = await PDFDocument.load(originalBytes);

          // Add certificate page
          const certPage = pdfDoc.addPage();
          const width = certPage.getWidth();
          const height = certPage.getHeight();

          const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
          const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

          const margin = 50;
          const accent = rgb(0.11, 0.77, 0.55);
          const textDark = rgb(0.16, 0.18, 0.22);
          const textMuted = rgb(0.45, 0.48, 0.55);

          const headerHeight = 70;
          certPage.drawRectangle({
            x: 0,
            y: height - headerHeight,
            width,
            height: headerHeight,
            color: rgb(0.04, 0.08, 0.12),
          });

          certPage.drawText("Oasis Digital Parliament", {
            x: margin,
            y: height - headerHeight + 32,
            size: 16,
            font: fontBold,
            color: accent,
          });

          certPage.drawText("Signature Certificate", {
            x: margin,
            y: height - headerHeight + 14,
            size: 11,
            font,
            color: rgb(0.8, 0.84, 0.9),
          });

          const rightHeader = "Issued by the Oasis Digital Parliament Ledger";
          const rightWidth = font.widthOfTextAtSize(rightHeader, 9);
          certPage.drawText(rightHeader, {
            x: width - margin - rightWidth,
            y: height - headerHeight + 20,
            size: 9,
            font,
            color: rgb(0.7, 0.75, 0.82),
          });

          let y = height - headerHeight - 35;
          certPage.drawText(
            "This page certifies the electronic execution of the following record:",
            { x: margin, y, size: 10, font, color: textMuted },
          );

          y -= 24;
          const title =
            record?.title ?? (envelope as any)?.title ?? "Corporate Record";
          certPage.drawText(title, {
            x: margin,
            y,
            size: 13,
            font: fontBold,
            color: textDark,
          });

          y -= 20;
          const entityLine = entity?.name ?? "Entity";
          certPage.drawText(entityLine, {
            x: margin,
            y,
            size: 10,
            font,
            color: textMuted,
          });

          y -= 26;

          const leftLines: Array<[string, unknown]> = [
            ["Certificate ID", envelope.id],
            ["Entity", entityLine],
            ["Record ID", String(envelope.record_id)],
            ["Record Title", title],
            ["Signed At (UTC)", signedAt],
            ["Envelope Status", nextStatus],
          ];

          const rightLines: Array<[string, unknown]> = [
            ["Signer Name", party.display_name],
            ["Signer Email", party.email ?? "N/A"],
            ["Signer Role", party.role ?? "signer"],
            ["Entity ID", String(envelope.entity_id)],
            ["Entity Slug", entity?.slug ?? "n/a"],
            ["Created At", record?.created_at ?? "N/A"],
          ];

          let leftY = y;
          const colGap = 220;

          for (const [label, value] of leftLines) {
            certPage.drawText(label + ":", {
              x: margin,
              y: leftY,
              size: 9,
              font: fontBold,
              color: textDark,
            });
            certPage.drawText(truncateMiddle(String(value), 36), {
              x: margin + 95,
              y: leftY,
              size: 9,
              font,
              color: textMuted,
            });
            leftY -= 16;
          }

          let rightY = y;
          for (const [label, value] of rightLines) {
            certPage.drawText(label + ":", {
              x: margin + colGap,
              y: rightY,
              size: 9,
              font: fontBold,
              color: textDark,
            });
            certPage.drawText(truncateMiddle(String(value), 28), {
              x: margin + colGap + 95,
              y: rightY,
              size: 9,
              font,
              color: textMuted,
            });
            rightY -= 16;
          }

          // Technical footprint
          let techY = Math.min(leftY, rightY) - 18;
          if (client_ip || user_agent) {
            certPage.drawText("Technical footprint", {
              x: margin,
              y: techY,
              size: 9,
              font: fontBold,
              color: textDark,
            });
            techY -= 14;

            if (client_ip) {
              certPage.drawText(`Client IP: ${client_ip}`, {
                x: margin,
                y: techY,
                size: 8,
                font,
                color: textMuted,
              });
              techY -= 12;
            }
            if (user_agent) {
              certPage.drawText(`User Agent: ${truncateMiddle(user_agent, 68)}`, {
                x: margin,
                y: techY,
                size: 8,
                font,
                color: textMuted,
              });
              techY -= 12;
            }
          }

          // QR code (CERTIFICATE PAGE ONLY) — MUST EXIST
          {
            const qrSize = 96;
            const pad = 36;
            const qrX = width - pad - qrSize;
            const qrY = pad;

            // White plate behind QR for legibility + caption room
            certPage.drawRectangle({
              x: qrX - 6,
              y: qrY - 6,
              width: qrSize + 12,
              height: qrSize + 22,
              color: rgb(1, 1, 1),
              borderColor: rgb(0.9, 0.9, 0.9),
              borderWidth: 1,
            });

            try {
              drawQrToPdf({
                page: certPage,
                url: verifyUrl,
                x: qrX,
                y: qrY + 16,
                size: qrSize,
              });
            } catch (e) {
              console.error("QR matrix/draw failed", e);
              throw new Error("CERTIFICATE_QR_GENERATION_FAILED");
            }

            const caption = "Scan to verify";
            const captionWidth = font.widthOfTextAtSize(caption, 8);
            certPage.drawText(caption, {
              x: qrX + (qrSize - captionWidth) / 2,
              y: qrY + 4,
              size: 8,
              font,
              color: textMuted,
            });
          }

          // Optional wet-ink embed (fail-soft)
          try {
            if (wetSignaturePath) {
              const { data: sigFile, error: sigDlErr } = await supabase.storage
                .from(BUCKET)
                .download(wetSignaturePath);

              if (!sigDlErr && sigFile) {
                const sigBytes = new Uint8Array(await sigFile.arrayBuffer());
                const sigImg = await pdfDoc.embedPng(sigBytes);

                certPage.drawText("Wet-Ink Signature (Captured)", {
                  x: margin,
                  y: 125,
                  size: 8,
                  font,
                  color: textMuted,
                });

                certPage.drawImage(sigImg, {
                  x: margin,
                  y: 50,
                  width: 220,
                  height: 70,
                });
              }
            }
          } catch (e) {
            console.error("Wet signature embed error (non-fatal)", e);
          }

          // Save + hash
          const pdfBytes = await pdfDoc.save();
          pdfHash = await sha256Hex(pdfBytes);

          // Paths
          signedPath = toSignedPath(basePath);
          signedPathCanonical = canonicalizeResolutionsPath(signedPath);

          // Upload canonical first (best-effort)
          try {
            const { error: upCanonErr } = await supabase.storage
              .from(BUCKET)
              .upload(
                signedPathCanonical,
                new Blob([pdfBytes], { type: "application/pdf" }),
                { upsert: true },
              );
            if (upCanonErr) console.error("Error uploading canonical signed PDF:", upCanonErr);
          } catch (e) {
            console.error("Canonical signed upload threw (non-fatal)", e);
          }

          // Upload legacy path (continuity)
          const { error: uploadErr } = await supabase.storage
            .from(BUCKET)
            .upload(
              signedPath,
              new Blob([pdfBytes], { type: "application/pdf" }),
              { upsert: true },
            );

          if (uploadErr) {
            console.error("Error uploading legacy signed PDF:", uploadErr);
            signedPath = null;
          }

          // Metadata write BEFORE marking completed (regen-safe; status is set after)
          const existingMeta = (envelope as any)?.metadata ?? {};
          const certificate = {
            certificate_version: 1,
            envelope_id,
            record_id: envelope.record_id,
            entity_id: envelope.entity_id,
            entity_name: entity?.name ?? null,
            record_title: record?.title ?? envelope.title ?? null,
            signer: {
              party_id: party.id,
              name: party.display_name,
              email: party.email,
              role: party.role ?? "signer",
            },
            signed_at: signedAt,
            envelope_status: nextStatus,
            client_ip: client_ip ?? null,
            user_agent: user_agent ?? null,
            verify_url: verifyUrl,
            pdf_hash: pdfHash,
            bucket: BUCKET,
            base_document_path: basePath ?? envSupport ?? envStorage ?? null,
            signed_document_path: signedPath,
            signed_document_path_canonical: signedPathCanonical,
            wet_signature_mode: String(wet_signature_mode ?? "").toLowerCase() || "click",
            wet_signature_path: wetSignaturePath,
          };

          const newMetadata = {
            ...existingMeta,
            verify_url: verifyUrl,
            certificate,

            storage_path: existingMeta.storage_path ?? basePath ?? null,

            signed_document_path: signedPath ?? existingMeta.signed_document_path ?? null,
            signed_document_path_canonical:
              signedPathCanonical ?? existingMeta.signed_document_path_canonical ?? null,

            pdf_hash: pdfHash ?? existingMeta.pdf_hash ?? null,

            wet_signature_mode:
              String(wet_signature_mode ?? "").toLowerCase() ||
              (existingMeta.wet_signature_mode ?? "click"),
            wet_signature_path: wetSignaturePath ?? existingMeta.wet_signature_path ?? null,
          };

          // IMPORTANT: do NOT set completed here; we set it after metadata is written.
          await mustUpdateEnvelope(envelope_id, {
            status: "partial",
            metadata: newMetadata,
            supporting_document_path: envSupport ?? basePath ?? null,
            storage_path: envStorage ?? basePath ?? null,
          });

          await mustInsertEvent({
            envelope_id,
            event_type: "completed",
            metadata: {
              party_id,
              signed_at: signedAt,
              certificate,
              signed_document_path: signedPath,
              signed_document_path_canonical: signedPathCanonical,
              wet_signature_mode: String(wet_signature_mode ?? "").toLowerCase() || "click",
              wet_signature_path: wetSignaturePath,
              force_regen: !!force_regen,
            },
          });
        }
      }
    }

    // 7) FINALIZE ENVELOPE STATUS (AFTER METADATA WRITE)
    if (String(envelope.status ?? "").toLowerCase() !== nextStatus) {
      await mustUpdateEnvelope(envelope_id, { status: nextStatus });
    }

    // 8) Downstream calls (NO REGRESSION)
    if (allSigned) {
      const edgeBase = SUPABASE_URL.replace(/\/rest\/v1$/, "");

      let finalMeta: any = null;
      try {
        const { data: env2 } = await supabase
          .from("signature_envelopes")
          .select("metadata, entity_id, record_id")
          .eq("id", envelope_id)
          .single();
        finalMeta = (env2 as any)?.metadata ?? null;
      } catch {
        finalMeta = null;
      }

      const signed_document_path = safeText(finalMeta?.signed_document_path) ?? null;
      const pdf_hash = safeText(finalMeta?.pdf_hash) ?? null;

      if (signed_document_path) {
        try {
          const entitySlug = entity?.slug ?? null;
          const resolutionTitle = record?.title ?? envelope.title ?? "Signed Corporate Record";

          if (entitySlug) {
            const ingestBody = {
              entity_slug: entitySlug,
              entity_id: envelope.entity_id,
              document_class: "resolution",
              section_name: "Resolutions",
              source_bucket: BUCKET,
              source_path: signed_document_path,
              title: resolutionTitle,
              source_table: "governance_ledger",
              source_record_id: envelope.record_id,
              envelope_id,
              pdf_hash,
            };

            const ingestRes = await fetch(`${edgeBase}/functions/v1/odp-pdf-ingest`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                apikey: SERVICE_ROLE_KEY,
                Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
              },
              body: JSON.stringify(ingestBody),
            });

            if (!ingestRes.ok) {
              const text = await ingestRes.text().catch(() => "");
              console.error("odp-pdf-ingest failed (non-fatal)", ingestRes.status, text);
            }
          }
        } catch (e) {
          console.error("odp-pdf-ingest threw (non-fatal)", e);
        }

        try {
          const certifyRes = await fetch(`${edgeBase}/functions/v1/odp-pdf-certify`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              apikey: SERVICE_ROLE_KEY,
              Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
            },
            body: JSON.stringify({ envelope_id, force_regen: false }),
          });

          if (!certifyRes.ok) {
            const text = await certifyRes.text().catch(() => "");
            console.error("odp-pdf-certify failed (non-fatal)", certifyRes.status, text);
          }
        } catch (e) {
          console.error("odp-pdf-certify threw (non-fatal)", e);
        }
      }
    }

    // Final read
    const { data: finalEnv } = await supabase
      .from("signature_envelopes")
      .select("metadata")
      .eq("id", envelope_id)
      .single();

    const meta = (finalEnv as any)?.metadata ?? {};
    const cert = meta?.certificate ?? null;

    return json({
      ok: true,
      envelope_id,
      status: nextStatus,
      certificate: cert,
      base_document_path: safeText(cert?.base_document_path) ?? null,
      signed_document_path:
        safeText(cert?.signed_document_path) ?? safeText(meta?.signed_document_path) ?? null,
      signed_document_path_canonical:
        safeText(cert?.signed_document_path_canonical) ??
        safeText(meta?.signed_document_path_canonical) ??
        null,
      pdf_hash: safeText(cert?.pdf_hash) ?? safeText(meta?.pdf_hash) ?? null,
      verify_url: safeText(cert?.verify_url) ?? safeText(meta?.verify_url) ?? verifyUrl,
      wet_signature_mode: String(wet_signature_mode ?? "").toLowerCase() || "click",
      wet_signature_path: safeText(cert?.wet_signature_path) ?? null,
      force_regen: !!force_regen,
    });
  } catch (e) {
    console.error("Unexpected error in complete-signature", e);
    return json({ ok: false, error: "Unexpected server error", details: String(e) }, 500);
  }
});
