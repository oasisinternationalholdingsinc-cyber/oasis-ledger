// supabase/functions/complete-signature/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";
import QRCode from "https://esm.sh/qrcode@1.5.3";
// ---------------------------------------------------------------------------
// SUPABASE CLIENT
// ---------------------------------------------------------------------------
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
}
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  global: {
    fetch
  }
});
const BUCKET = "minute_book";
// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------
function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey"
    }
  });
}
async function sha256Hex(bytes) {
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b)=>b.toString(16).padStart(2, "0")).join("");
}
// ---------------------------------------------------------------------------
// HTTP HANDLER
// ---------------------------------------------------------------------------
serve(async (req)=>{
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey"
      }
    });
  }
  if (req.method !== "POST") {
    return json({
      ok: false,
      error: "Use POST"
    }, 405);
  }
  // Parse body
  let body;
  try {
    body = await req.json();
  } catch  {
    return json({
      ok: false,
      error: "Invalid JSON body"
    }, 400);
  }
  const { envelope_id, party_id, client_ip, user_agent } = body ?? {};
  if (!envelope_id || !party_id) {
    return json({
      ok: false,
      error: "envelope_id and party_id are required"
    }, 400);
  }
  try {
    const signedAt = new Date().toISOString();
    // -----------------------------------------------------------------------
    // 1) Load envelope (includes supporting_document_path + metadata)
    // -----------------------------------------------------------------------
    const { data: envelope, error: envErr } = await supabase.from("signature_envelopes").select("id, status, title, entity_id, record_id, supporting_document_path, metadata").eq("id", envelope_id).single();
    if (envErr || !envelope) {
      console.error("Envelope fetch error", envErr);
      return json({
        ok: false,
        error: "Envelope not found",
        details: envErr
      }, 404);
    }
    // -----------------------------------------------------------------------
    // 2) Load party
    // -----------------------------------------------------------------------
    const { data: party, error: partyErr } = await supabase.from("signature_parties").select("id, envelope_id, email, display_name, role, status").eq("id", party_id).eq("envelope_id", envelope_id).single();
    if (partyErr || !party) {
      console.error("Party fetch error", partyErr);
      return json({
        ok: false,
        error: "Signature party not found",
        details: partyErr
      }, 404);
    }
    // -----------------------------------------------------------------------
    // 3) Mark this party as signed
    // -----------------------------------------------------------------------
    const { error: partyUpdateErr } = await supabase.from("signature_parties").update({
      status: "signed",
      signed_at: signedAt
    }).eq("id", party_id).eq("envelope_id", envelope_id);
    if (partyUpdateErr) {
      console.error("Party update error", partyUpdateErr);
      return json({
        ok: false,
        error: "Failed to update party",
        details: partyUpdateErr
      }, 500);
    }
    // -----------------------------------------------------------------------
    // 4) Check if all parties are signed and update envelope.status
    // -----------------------------------------------------------------------
    const { data: allParties, error: allPartiesErr } = await supabase.from("signature_parties").select("status").eq("envelope_id", envelope_id);
    if (allPartiesErr || !allParties) {
      console.error("All parties fetch error", allPartiesErr);
      return json({
        ok: false,
        error: "Failed to check parties",
        details: allPartiesErr
      }, 500);
    }
    const allSigned = allParties.length > 0 && allParties.every((p)=>p.status === "signed");
    const newStatus = allSigned ? "completed" : "partial";
    // sync envelope.status (redundant with view but good to have)
    const { error: envUpdateErr } = await supabase.from("signature_envelopes").update({
      status: newStatus
    }).eq("id", envelope_id);
    if (envUpdateErr) {
      console.error("Envelope update error", envUpdateErr);
    // non-fatal – we still continue with certificate + events
    }
    // -----------------------------------------------------------------------
    // 4.1) Optional: audit log + certificate job when fully completed
    //      (these fail soft if tables don't exist yet)
    // -----------------------------------------------------------------------
    if (allSigned) {
      try {
        const { error: auditErr } = await supabase.from("signature_audit_log").insert({
          envelope_id,
          record_id: envelope.record_id,
          event_type: "envelope_completed",
          actor_email: party.email ?? null,
          metadata: {
            client_ip: client_ip ?? null,
            user_agent: user_agent ?? null
          }
        });
        if (auditErr) {
          console.error("signature_audit_log insert error (non-fatal)", auditErr);
        }
      } catch (auditCatchErr) {
        console.error("signature_audit_log insert threw (non-fatal)", auditCatchErr);
      }
      try {
        const { error: jobErr } = await supabase.from("certificate_jobs").insert({
          envelope_id,
          record_id: envelope.record_id,
          status: "pending"
        });
        if (jobErr) {
          console.error("certificate_jobs insert error (non-fatal)", jobErr);
        }
      } catch (jobCatchErr) {
        console.error("certificate_jobs insert threw (non-fatal)", jobCatchErr);
      }
    }
    // -----------------------------------------------------------------------
    // 5) Load entity + record for certificate text
    // -----------------------------------------------------------------------
    const { data: entity } = await supabase.from("entities").select("id, slug, name").eq("id", envelope.entity_id).single();
    const { data: record } = await supabase.from("governance_ledger").select("id, title, description, created_at").eq("id", envelope.record_id).single();
    // -----------------------------------------------------------------------
    // 5.5) Verify URL used by QR + certificate metadata
    // -----------------------------------------------------------------------
    const verifyUrl = envelope.metadata?.verify_url ?? `https://sign.oasisintlholdings.com/verify.html?envelope_id=${envelope_id}`;
    let signedPath = null;
    let pdfHash = null;
    // -----------------------------------------------------------------------
    // 6) Generate signed PDF with certificate page
    //    Only when ALL parties have signed
    // -----------------------------------------------------------------------
    if (allSigned) {
      try {
        let objectPath = null;
        if (envelope.supporting_document_path) {
          objectPath = envelope.supporting_document_path;
        } else if (envelope.metadata?.storage_path) {
          const mPath = envelope.metadata.storage_path;
          objectPath = mPath.replace(/^minute_book\//, "");
        }
        if (!objectPath) {
          console.warn("No objectPath available for certificate PDF generation; skipping PDF step.");
        } else {
          // 6a) Download original PDF
          const { data: originalFile, error: dlErr } = await supabase.storage.from(BUCKET).download(objectPath);
          if (dlErr || !originalFile) {
            console.error("Error downloading original PDF:", dlErr);
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
              color: rgb(0.04, 0.08, 0.12)
            });
            certPage.drawText("Oasis Digital Parliament", {
              x: margin,
              y: height - headerHeight + 32,
              size: 16,
              font: fontBold,
              color: accent
            });
            certPage.drawText("Signature Certificate", {
              x: margin,
              y: height - headerHeight + 14,
              size: 11,
              font,
              color: rgb(0.8, 0.84, 0.9)
            });
            const rightHeader = "Issued by the Oasis Digital Parliament Ledger";
            const rightWidth = font.widthOfTextAtSize(rightHeader, 9);
            certPage.drawText(rightHeader, {
              x: width - margin - rightWidth,
              y: height - headerHeight + 20,
              size: 9,
              font,
              color: rgb(0.7, 0.75, 0.82)
            });
            // Body content
            let y = height - headerHeight - 35;
            certPage.drawText("This page certifies the electronic execution of the following record:", {
              x: margin,
              y,
              size: 10,
              font,
              color: textMuted
            });
            y -= 24;
            const title = record?.title ?? envelope.title ?? "Corporate Record";
            certPage.drawText(title, {
              x: margin,
              y,
              size: 13,
              font: fontBold,
              color: textDark
            });
            y -= 20;
            const entityLine = entity?.name ?? "Oasis International Group (entity unknown)";
            certPage.drawText(entityLine, {
              x: margin,
              y,
              size: 10,
              font,
              color: textMuted
            });
            y -= 26;
            const leftLines = [
              [
                "Certificate ID",
                envelope.id
              ],
              [
                "Entity",
                entityLine
              ],
              [
                "Record ID",
                String(envelope.record_id)
              ],
              [
                "Record Title",
                title
              ],
              [
                "Signed At (UTC)",
                signedAt
              ],
              [
                "Envelope Status",
                newStatus
              ]
            ];
            const rightLines = [
              [
                "Signer Name",
                party.display_name
              ],
              [
                "Signer Email",
                party.email ?? "N/A"
              ],
              [
                "Signer Role",
                party.role ?? "signer"
              ],
              [
                "Entity ID",
                String(envelope.entity_id)
              ],
              [
                "Entity Slug",
                entity?.slug ?? "n/a"
              ],
              [
                "Created At",
                record?.created_at ?? "N/A"
              ]
            ];
            let leftY = y;
            const colGap = 220;
            for (const [label, value] of leftLines){
              certPage.drawText(label + ":", {
                x: margin,
                y: leftY,
                size: 9,
                font: fontBold,
                color: textDark
              });
              certPage.drawText(String(value), {
                x: margin + 95,
                y: leftY,
                size: 9,
                font,
                color: textMuted
              });
              leftY -= 16;
            }
            let rightY = y;
            for (const [label, value] of rightLines){
              certPage.drawText(label + ":", {
                x: margin + colGap,
                y: rightY,
                size: 9,
                font: fontBold,
                color: textDark
              });
              certPage.drawText(String(value), {
                x: margin + colGap + 95,
                y: rightY,
                size: 9,
                font,
                color: textMuted
              });
              rightY -= 16;
            }
            // Optional technical footprint
            let techY = Math.min(leftY, rightY) - 18;
            if (client_ip || user_agent) {
              certPage.drawText("Technical footprint", {
                x: margin,
                y: techY,
                size: 9,
                font: fontBold,
                color: textDark
              });
              techY -= 14;
              if (client_ip) {
                certPage.drawText(`Client IP: ${client_ip}`, {
                  x: margin,
                  y: techY,
                  size: 8,
                  font,
                  color: textMuted
                });
                techY -= 12;
              }
              if (user_agent) {
                certPage.drawText(`User Agent: ${user_agent}`, {
                  x: margin,
                  y: techY,
                  size: 8,
                  font,
                  color: textMuted
                });
                techY -= 12;
              }
            }
            // QR code
            try {
              const dataUrl = await QRCode.toDataURL(verifyUrl, {
                margin: 1,
                width: 118,
                color: {
                  dark: "#22c55e",
                  light: "#00000000"
                }
              });
              const base64 = dataUrl.split(",")[1];
              const binary = atob(base64);
              const bytes = new Uint8Array(binary.length);
              for(let i = 0; i < binary.length; i++){
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
                height: qrSize
              });
              const caption = "Scan to verify";
              const captionWidth = font.widthOfTextAtSize(caption, 8);
              certPage.drawText(caption, {
                x: qrX + (qrSize - captionWidth) / 2,
                y: qrY - 10,
                size: 8,
                font,
                color: textMuted
              });
            } catch (qrErr) {
              console.error("QR generation / embed error:", qrErr);
            }
            const footerText = "This certificate page forms part of the official governance record within the Oasis Digital Parliament Ledger.";
            certPage.drawText(footerText, {
              x: margin,
              y: 40,
              size: 8,
              font,
              color: textMuted
            });
            // Save & upload signed PDF
            const pdfBytes = await pdfDoc.save();
            pdfHash = await sha256Hex(pdfBytes);
            signedPath = objectPath.replace(/\.pdf$/i, "-signed.pdf");
            const { error: uploadErr } = await supabase.storage.from(BUCKET).upload(signedPath, new Blob([
              pdfBytes
            ], {
              type: "application/pdf"
            }), {
              upsert: true
            });
            if (uploadErr) {
              console.error("Error uploading signed PDF:", uploadErr);
              signedPath = null;
            }
          }
        }
      } catch (pdfErr) {
        console.error("Certificate PDF generation error", pdfErr);
        signedPath = null;
      }
    } else {
      // not allSigned – no PDF yet, but pipeline still records metadata below
      signedPath = null;
      pdfHash = null;
    }
    // -----------------------------------------------------------------------
    // 7) Build certificate JSON
    // -----------------------------------------------------------------------
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
        role: party.role ?? "signer"
      },
      signed_at: signedAt,
      envelope_status: newStatus,
      client_ip: client_ip ?? null,
      user_agent: user_agent ?? null,
      verify_url: verifyUrl,
      pdf_hash: pdfHash,
      bucket: BUCKET,
      signed_document_path: signedPath
    };
    // -----------------------------------------------------------------------
    // 8) Persist metadata back onto signature_envelopes
    // -----------------------------------------------------------------------
    const existingMeta = envelope.metadata ?? {};
    const newMetadata = {
      ...existingMeta,
      verify_url: verifyUrl,
      certificate,
      signed_document_path: signedPath ?? existingMeta.signed_document_path ?? null
    };
    const { error: metaErr } = await supabase.from("signature_envelopes").update({
      metadata: newMetadata
    }).eq("id", envelope_id);
    if (metaErr) {
      console.error("Metadata update error", metaErr);
    }
    // -----------------------------------------------------------------------
    // 9) Log event
    // -----------------------------------------------------------------------
    const { error: eventErr } = await supabase.from("signature_events").insert({
      envelope_id,
      event_type: "completed",
      metadata: {
        party_id,
        signed_at: signedAt,
        certificate,
        signed_document_path: signedPath
      }
    });
    if (eventErr) {
      console.error("signature_events insert error", eventErr);
    }
    // -----------------------------------------------------------------------
    // 10) Ingest into minute book via odp-pdf-ingest (non-fatal)
    //      → only when fully signed AND we produced a signedPath
    //      AND auto-trigger odp-pdf-certify for official certificate PDF
    // -----------------------------------------------------------------------
    if (allSigned && signedPath) {
      const edgeBase = SUPABASE_URL.replace(/\/rest\/v1$/, "");
      // 10a) Ingest signed PDF into minute book / governance_documents
      try {
        const entitySlug = entity?.slug ?? null;
        const resolutionTitle = record?.title ?? envelope.title ?? "Signed Corporate Record";
        if (!entitySlug) {
          console.warn("No entity.slug available; skipping odp-pdf-ingest for envelope", envelope_id);
        } else {
          const ingestBody = {
            entity_slug: entitySlug,
            entity_id: envelope.entity_id,
            document_class: "resolution",
            section_name: "Resolutions",
            source_bucket: BUCKET,
            source_path: signedPath,
            title: resolutionTitle,
            source_table: "governance_ledger",
            source_record_id: envelope.record_id,
            envelope_id,
            pdf_hash: pdfHash
          };
          const ingestRes = await fetch(`${edgeBase}/functions/v1/odp-pdf-ingest`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              apikey: SERVICE_ROLE_KEY,
              Authorization: `Bearer ${SERVICE_ROLE_KEY}`
            },
            body: JSON.stringify(ingestBody)
          });
          if (!ingestRes.ok) {
            const text = await ingestRes.text().catch(()=>"");
            console.error("odp-pdf-ingest call failed (non-fatal)", ingestRes.status, text);
          }
        }
      } catch (ingestErr) {
        console.error("Unexpected error when calling odp-pdf-ingest (non-fatal)", ingestErr);
      }
      // 10b) Auto-trigger odp-pdf-certify to generate the ledger certificate PDF
      try {
        const certifyRes = await fetch(`${edgeBase}/functions/v1/odp-pdf-certify`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SERVICE_ROLE_KEY}`
          },
          body: JSON.stringify({
            envelope_id,
            // we usually want to re-use if already there; this lets
            // odp-pdf-certify skip regeneration if a cert already exists.
            force_regen: false
          })
        });
        if (!certifyRes.ok) {
          const text = await certifyRes.text().catch(()=>"");
          console.error("odp-pdf-certify call failed (non-fatal)", certifyRes.status, text);
        }
      } catch (certErr) {
        console.error("Unexpected error when calling odp-pdf-certify (non-fatal)", certErr);
      }
    }
    // -----------------------------------------------------------------------
    // SUCCESS
    // -----------------------------------------------------------------------
    return json({
      ok: true,
      envelope_id,
      status: newStatus,
      certificate,
      signed_document_path: signedPath,
      pdf_hash: pdfHash,
      verify_url: verifyUrl
    });
  } catch (e) {
    console.error("Unexpected error in complete-signature", e);
    return json({
      ok: false,
      error: "Unexpected server error",
      details: String(e)
    }, 500);
  }
});
