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
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
  };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

async function sha256Hex(bytes: ArrayBuffer | Uint8Array) {
  const buf = bytes instanceof Uint8Array ? bytes.buffer : bytes;
  const hashBuffer = await crypto.subtle.digest("SHA-256", buf);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
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

// Resolve a base PDF path even when envelope pointers are missing.
// Searches bucket minute_book for the record_id and prefers the newest hit.
async function resolveBasePdfPath(recordId: string): Promise<string | null> {
  // NOTE: patterns kept for intent; we still scan latest rows to keep it cheap.
  const patterns = [`%/${recordId}.pdf%`, `%/${recordId}-%`];
  void patterns;

  const { data, error } = await supabase
    .from("storage.objects")
    .select("name, created_at")
    .eq("bucket_id", BUCKET)
    .or(
      [
        `name.ilike.%/Resolutions/%`,
        `name.ilike.%/resolutions/%`,
      ].join(","),
    )
    .order("created_at", { ascending: false })
    .limit(250);

  if (error || !data) {
    console.error("storage.objects lookup failed", error);
    return null;
  }

  const lowerNeedle = recordId.toLowerCase();

  // Prefer non -signed
  for (const row of data as any[]) {
    const name = String(row?.name ?? "");
    if (!name) continue;
    if (!name.toLowerCase().includes(lowerNeedle)) continue;
    if (!name.toLowerCase().endsWith("-signed.pdf")) return name;
  }

  // Fallback: signed exists
  for (const row of data as any[]) {
    const name = String(row?.name ?? "");
    if (!name) continue;
    if (name.toLowerCase().includes(lowerNeedle)) return name;
  }

  return null;
}

function canonicalizeResolutionsPath(p: string): string {
  // additive: creates a canonical lowercase twin, while preserving legacy path
  return p.replace("/Resolutions/", "/resolutions/");
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

    // NEW (optional, additive): allow regen even if already signed/completed
    force_regen,
  } = body ?? {};

  if (!envelope_id || !party_id) {
    return json(
      { ok: false, error: "envelope_id and party_id are required" },
      400,
    );
  }

  const providedToken = party_token ?? token;

  try {
    const signedAt = new Date().toISOString();

    // 1) Load envelope
    const { data: envelope, error: envErr } = await supabase
      .from("signature_envelopes")
      .select(
        "id, status, title, entity_id, record_id, supporting_document_path, storage_path, metadata",
      )
      .eq("id", envelope_id)
      .single();

    if (envErr || !envelope) {
      console.error("Envelope fetch error", envErr);
      return json(
        { ok: false, error: "Envelope not found", details: envErr },
        404,
      );
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
      return json(
        { ok: false, error: "Signature party not found", details: partyErr },
        404,
      );
    }

    // 2.1) Capability token enforcement (NO REGRESSION)
    if (party.party_token) {
      const expected = String(party.party_token);
      const provided = String(providedToken ?? "");

      if (!provided) {
        return json({ ok: false, error: "SIGNING_TOKEN_REQUIRED" }, 401);
      }
      if (provided !== expected) {
        return json({ ok: false, error: "SIGNING_TOKEN_INVALID" }, 403);
      }
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
        return json(
          {
            ok: false,
            error: "Failed to update party",
            details: partyUpdateErr,
          },
          500,
        );
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
            .upload(
              wetSignaturePath,
              new Blob([pngBytes], { type: "image/png" }),
              {
                upsert: true,
                contentType: "image/png",
              },
            );

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
      return json(
        { ok: false, error: "Failed to check parties", details: allPartiesErr },
        500,
      );
    }

    const allSigned =
      allParties.length > 0 &&
      allParties.every((p: any) => p.status === "signed");

    const newStatus = allSigned ? "completed" : "partial";

    // sync envelope.status (non-fatal)
    await supabase
      .from("signature_envelopes")
      .update({ status: newStatus })
      .eq("id", envelope_id);

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
    //    - run when ALL parties have signed
    //    - AND either: this call just signed a party, OR force_regen is true
    // -----------------------------------------------------------------------
    if (allSigned && (!alreadySigned || wantRegen)) {
      // 6.0) Resolve base objectPath (repair-safe)
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
        console.warn(
          "No base PDF path could be resolved; cannot generate signed PDF.",
        );
      } else {
        // If pointers were missing, repair them now (non-breaking)
        const needsPointerRepair = !envSupport || !envStorage || !metaPath;

        if (needsPointerRepair) {
          try {
            const existingMeta = (envelope as any)?.metadata ?? {};
            const repairedMeta = { ...existingMeta, storage_path: basePath };

            await supabase
              .from("signature_envelopes")
              .update({
                supporting_document_path: basePath,
                storage_path: basePath,
                metadata: repairedMeta,
              })
              .eq("id", envelope_id);
          } catch (e) {
            console.error("Pointer repair failed (non-fatal)", e);
          }
        }

        // 6a) Download original PDF
        const { data: originalFile, error: dlErr } = await supabase.storage
          .from(BUCKET)
          .download(basePath);

        if (dlErr || !originalFile) {
          console.error("Error downloading base PDF:", dlErr);
        } else {
          const originalBytes = await originalFile.arrayBuffer();
          const pdfDoc = await PDFDocument.load(originalBytes);

          // 6b) Add certificate page
          const certPage = pdfDoc.addPage();
          const width = certPage.getWidth();
          const height = certPage.getHeight();

          const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
          const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

          const margin = 50;
          const accent = rgb(0.11, 0.77, 0.55);
          const textDark = rgb(0.16, 0.18, 0.22);
          const textMuted = rgb(0.45, 0.48, 0.55);

          // Header band
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
            ["Envelope Status", newStatus],
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
            certPage.drawText(String(value), {
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
            certPage.drawText(String(value), {
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
              certPage.drawText(`User Agent: ${user_agent}`, {
                x: margin,
                y: techY,
                size: 8,
                font,
                color: textMuted,
              });
              techY -= 12;
            }
          }

          // QR code
          try {
            const dataUrl = await QRCode.toDataURL(verifyUrl, {
              margin: 1,
              width: 118,
              color: { dark: "#22c55e", light: "#00000000" },
            });

            const base64 = dataUrl.split(",")[1];
            const binary = atob(base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
              bytes[i] = binary.charCodeAt(i);
            }

            const qrImage = await pdfDoc.embedPng(bytes);
            const qrSize = 90;
            const qrX = width - margin - qrSize;
            const qrY = margin + 14;

            certPage.drawImage(qrImage, {
              x: qrX,
              y: qrY,
              width: qrSize,
              height: qrSize,
            });

            const caption = "Scan to verify";
            const captionWidth = font.widthOfTextAtSize(caption, 8);
            certPage.drawText(caption, {
              x: qrX + (qrSize - captionWidth) / 2,
              y: qrY - 10,
              size: 8,
              font,
              color: textMuted,
            });
          } catch (qrErr) {
            console.error("QR generation / embed error:", qrErr);
          }

          // Optional: embed wet-ink signature image (fail-soft)
          try {
            if (wetSignaturePath) {
              const { data: sigFile, error: sigDlErr } = await supabase.storage
                .from(BUCKET)
                .download(wetSignaturePath);

              if (!sigDlErr && sigFile) {
                const sigBytes = new Uint8Array(
                  await sigFile.arrayBuffer(),
                );
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

          // 6c) Save + hash
          const pdfBytes = await pdfDoc.save();
          pdfHash = await sha256Hex(pdfBytes);

          // Legacy signed path (NO REGRESSION): follows basePath casing
          signedPath = basePath.replace(/\.pdf$/i, "-signed.pdf");

          // Canonical twin (additive): lowercase folder version
          signedPathCanonical = canonicalizeResolutionsPath(signedPath);

          // Upload canonical first (safe), then legacy (primary continuity)
          try {
            const { error: upCanonErr } = await supabase.storage
              .from(BUCKET)
              .upload(
                signedPathCanonical,
                new Blob([pdfBytes], { type: "application/pdf" }),
                { upsert: true },
              );

            if (upCanonErr) {
              console.error("Error uploading canonical signed PDF:", upCanonErr);
            }
          } catch (e) {
            console.error("Canonical signed upload threw (non-fatal)", e);
          }

          const { error: uploadErr } = await supabase.storage
            .from(BUCKET)
            .upload(
              signedPath,
              new Blob([pdfBytes], { type: "application/pdf" }),
              { upsert: true },
            );

          if (uploadErr) {
            console.error("Error uploading legacy signed PDF:", uploadErr);
            // If legacy failed but canonical succeeded, keep returning legacy as null (no regression),
            // but preserve canonical in metadata so verify/cert can still work.
            signedPath = null;
          }
        }
      }
    }

    // 7) Build certificate JSON
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
      envelope_status: newStatus,
      client_ip: client_ip ?? null,
      user_agent: user_agent ?? null,
      verify_url: verifyUrl,
      pdf_hash: pdfHash,
      bucket: BUCKET,
      base_document_path:
        basePath ??
        envelope.supporting_document_path ??
        envelope.storage_path ??
        null,
      signed_document_path: signedPath, // legacy (NO REGRESSION)
      signed_document_path_canonical: signedPathCanonical, // additive twin
      wet_signature_mode:
        String(wet_signature_mode ?? "").toLowerCase() || "click",
      wet_signature_path: wetSignaturePath,
    };

    // 8) Persist metadata back onto signature_envelopes
    const existingMeta = (envelope as any)?.metadata ?? {};
    const newMetadata = {
      ...existingMeta,
      verify_url: verifyUrl,
      certificate,

      // keep canonical pointer discipline: storage_path remains base PDF pointer
      storage_path:
        existingMeta.storage_path ??
        (basePath ??
          envelope.supporting_document_path ??
          envelope.storage_path ??
          null),

      // signed pointers: preserve legacy + additive canonical
      signed_document_path: signedPath ?? existingMeta.signed_document_path ?? null,
      signed_document_path_canonical:
        signedPathCanonical ??
        existingMeta.signed_document_path_canonical ??
        null,

      // keep hash accessible for verify/certificate
      pdf_hash: pdfHash ?? existingMeta.pdf_hash ?? null,

      wet_signature_mode:
        String(wet_signature_mode ?? "").toLowerCase() ||
        (existingMeta.wet_signature_mode ?? "click"),
      wet_signature_path: wetSignaturePath ?? existingMeta.wet_signature_path ?? null,
    };

    await supabase
      .from("signature_envelopes")
      .update({
        metadata: newMetadata,

        // repair-safe base pointers (DO NOT repoint to signed)
        supporting_document_path:
          envelope.supporting_document_path ?? basePath ?? null,
        storage_path: envelope.storage_path ?? basePath ?? null,
      })
      .eq("id", envelope_id);

    // 9) Log event (non-fatal)
    await supabase.from("signature_events").insert({
      envelope_id,
      event_type: "completed",
      metadata: {
        party_id,
        signed_at: signedAt,
        certificate,
        signed_document_path: signedPath,
        signed_document_path_canonical: signedPathCanonical,
        wet_signature_mode:
          String(wet_signature_mode ?? "").toLowerCase() || "click",
        wet_signature_path: wetSignaturePath,
        force_regen: !!force_regen,
      },
    });

    // 10) Keep your downstream calls exactly as-is (NO REGRESSION)
    if (allSigned && signedPath) {
      const edgeBase = SUPABASE_URL.replace(/\/rest\/v1$/, "");

      try {
        const entitySlug = entity?.slug ?? null;
        const resolutionTitle =
          record?.title ?? envelope.title ?? "Signed Corporate Record";

        if (entitySlug) {
          const ingestBody = {
            entity_slug: entitySlug,
            entity_id: envelope.entity_id,
            document_class: "resolution",
            section_name: "Resolutions",
            source_bucket: BUCKET,
            source_path: signedPath, // legacy path remains for continuity
            title: resolutionTitle,
            source_table: "governance_ledger",
            source_record_id: envelope.record_id,
            envelope_id,
            pdf_hash: pdfHash,
          };

          const ingestRes = await fetch(
            `${edgeBase}/functions/v1/odp-pdf-ingest`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                apikey: SERVICE_ROLE_KEY,
                Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
              },
              body: JSON.stringify(ingestBody),
            },
          );

          if (!ingestRes.ok) {
            const text = await ingestRes.text().catch(() => "");
            console.error(
              "odp-pdf-ingest failed (non-fatal)",
              ingestRes.status,
              text,
            );
          }
        }
      } catch (e) {
        console.error("odp-pdf-ingest threw (non-fatal)", e);
      }

      try {
        const certifyRes = await fetch(
          `${edgeBase}/functions/v1/odp-pdf-certify`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              apikey: SERVICE_ROLE_KEY,
              Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
            },
            body: JSON.stringify({ envelope_id, force_regen: false }),
          },
        );

        if (!certifyRes.ok) {
          const text = await certifyRes.text().catch(() => "");
          console.error(
            "odp-pdf-certify failed (non-fatal)",
            certifyRes.status,
            text,
          );
        }
      } catch (e) {
        console.error("odp-pdf-certify threw (non-fatal)", e);
      }
    }

    return json({
      ok: true,
      envelope_id,
      status: newStatus,
      certificate,
      base_document_path: basePath ?? null,
      signed_document_path: signedPath, // legacy (no regression)
      signed_document_path_canonical: signedPathCanonical, // additive
      pdf_hash: pdfHash,
      verify_url: verifyUrl,
      wet_signature_mode:
        String(wet_signature_mode ?? "").toLowerCase() || "click",
      wet_signature_path: wetSignaturePath,
      force_regen: !!force_regen,
    });
  } catch (e) {
    console.error("Unexpected error in complete-signature", e);
    return json(
      { ok: false, error: "Unexpected server error", details: String(e) },
      500,
    );
  }
});
