"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const GET_CONTEXT_URL = `${SUPABASE_URL}/functions/v1/get-signing-context`;
const COMPLETE_SIGNATURE_URL = `${SUPABASE_URL}/functions/v1/complete-signature`;

type SigningContext = {
  envelope?: any;
  party?: any;
  entity?: any;
  record?: any;
  document?: {
    file_name?: string | null;
    storage_path?: string | null;
  } | null;
  pdf_url?: string | null;
  resolution?: { body?: string | null } | null;
  error?: string | null;
};

export default function PublicSignPage() {
  const searchParams = useSearchParams();
  const envelopeId = searchParams.get("envelope_id");
  const partyId = searchParams.get("party_id");

  const [ctx, setCtx] = useState<SigningContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [hardError, setHardError] = useState<string | null>(null);
  const [signError, setSignError] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);

  // “Digital click” confirmation
  const [confirmed, setConfirmed] = useState(false);

  // ---------------------------------------------------------------------------
  // Derived fields
  // ---------------------------------------------------------------------------
  const partyStatus = useMemo(
    () => (ctx?.party?.status ? String(ctx.party.status).toLowerCase() : ""),
    [ctx]
  );
  const envelopeStatus = useMemo(
    () =>
      ctx?.envelope?.status ? String(ctx.envelope.status).toLowerCase() : "",
    [ctx]
  );

  const alreadySigned = partyStatus === "signed";
  const fullyCompleted = envelopeStatus === "completed";
  const isSigned = alreadySigned || fullyCompleted;

  const pdfUrl = ctx?.pdf_url || null;

  const resolutionBody: string =
    (ctx?.resolution?.body ?? ctx?.record?.body ?? "") || "";

  // ---------------------------------------------------------------------------
  // Initial param validation
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!envelopeId || !partyId) {
      setLoading(false);
      setHardError(
        "Missing envelope_id or party_id in the URL. Please use a valid signing link."
      );
    }
  }, [envelopeId, partyId]);

  // ---------------------------------------------------------------------------
  // Load signing context from Edge Function
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!envelopeId || !partyId) return;

    async function loadContext() {
      setLoading(true);
      setHardError(null);
      setSignError(null);
      setConfirmed(false);

      try {
        const res = await fetch(GET_CONTEXT_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          },
          body: JSON.stringify({
            envelope_id: envelopeId,
            party_id: partyId,
          }),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          console.error(
            "get-signing-context HTTP error:",
            res.status,
            text || "(no body)"
          );
          setHardError(
            `Unable to load signing context (HTTP ${res.status}). Please contact the issuer if this persists.`
          );
          setCtx(null);
          return;
        }

        const data: SigningContext = await res.json().catch((err) => {
          console.error("Failed to parse get-signing-context JSON:", err);
          throw err;
        });

        if (data.error) {
          console.error("get-signing-context error payload:", data);
          setHardError(data.error || "Unable to load signing context.");
          setCtx(null);
          return;
        }

        setCtx(data);
      } catch (err) {
        console.error("Network error calling get-signing-context:", err);
        setHardError("Unexpected error contacting signing service.");
        setCtx(null);
      } finally {
        setLoading(false);
      }
    }

    loadContext();
  }, [envelopeId, partyId]);

  // ---------------------------------------------------------------------------
  // Complete signature
  // ---------------------------------------------------------------------------
  async function handleSign() {
    if (!envelopeId || !partyId || !ctx || isSigned || !confirmed) return;

    setSigning(true);
    setSignError(null);

    try {
      const res = await fetch(COMPLETE_SIGNATURE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({
          envelope_id: envelopeId,
          party_id: partyId,
        }),
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        console.error("complete-signature HTTP error:", res.status, txt);
        setSignError(
          `Failed to complete signature (HTTP ${res.status}). Please try again.`
        );
        return;
      }

      const result = await res.json().catch((err) => {
        console.error("Failed to parse complete-signature JSON:", err);
        throw err;
      });

      if (result.error || result.ok === false) {
        console.error("complete-signature error payload:", result);
        setSignError(result.error || "Failed to complete signature.");
        return;
      }

      // Mark as signed locally
      setCtx((prev) =>
        prev
          ? {
              ...prev,
              party: { ...(prev.party || {}), status: "SIGNED" },
              envelope: { ...(prev.envelope || {}), status: "COMPLETED" },
            }
          : prev
      );
    } catch (err) {
      console.error("Network error calling complete-signature:", err);
      setSignError("Unexpected error during signing. Please try again.");
    } finally {
      setSigning(false);
    }
  }

  // ---------------------------------------------------------------------------
  // UI helpers
  // ---------------------------------------------------------------------------
  const statusLabel = (() => {
    if (!envelopeId || !partyId) return "Invalid link";
    if (loading) return "Loading signing context…";
    if (hardError) return "Failed to load";
    if (isSigned) return "Signature completed";
    return "Ready to sign";
  })();

  const statusDotClass = (() => {
    if (hardError || (!envelopeId && !partyId)) return "bg-red-400";
    if (loading) return "bg-amber-400";
    if (isSigned) return "bg-emerald-400";
    return "bg-emerald-400";
  })();

  const canSign = !!ctx && !isSigned && !signing && !hardError && confirmed;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-slate-900 via-slate-950 to-black flex items-center justify-center px-4 py-10">
      <div className="relative w-full max-w-5xl rounded-3xl border border-slate-800/80 bg-slate-950/90 shadow-[0_24px_80px_rgba(0,0,0,0.9)] overflow-hidden">
        {/* Glow background */}
        <div className="pointer-events-none absolute inset-[-40%] bg-[radial-gradient(circle_at_top,rgba(34,197,94,0.18),transparent_55%),radial-gradient(circle_at_bottom_right,rgba(59,130,246,0.15),transparent_50%)] opacity-70" />

        <div className="relative z-10 p-6 md:p-7">
          {/* Header */}
          <header className="flex items-center justify-between gap-4 mb-4">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-3">
                <h1 className="text-lg md:text-xl font-semibold tracking-wide text-slate-50">
                  Oasis Digital Parliament
                </h1>
                <span className="inline-flex items-center rounded-full border border-slate-600/60 px-2.5 py-0.5 text-[0.68rem] uppercase tracking-[0.18em] text-slate-300">
                  Signature Execution
                </span>
              </div>
              <p className="text-xs md:text-sm text-slate-400">
                Review the governance document below and sign to complete
                execution.
              </p>
            </div>

            <div className="flex h-20 w-20 items-center justify-center rounded-full border border-emerald-400/70 bg-gradient-to-b from-emerald-500/15 to-transparent shadow-[0_0_40px_rgba(34,197,94,0.6)]">
              <div className="flex h-14 w-14 items-center justify-center rounded-full border border-emerald-400/60 border-dashed text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-emerald-400">
                ODP.AI
              </div>
            </div>
          </header>

          {/* Status row */}
          <div className="flex flex-wrap items-center gap-3 text-xs mb-3">
            <div className="inline-flex items-center gap-2 rounded-full border border-slate-600/60 px-3 py-1 text-[0.7rem] uppercase tracking-[0.18em] text-slate-200">
              <span className={`h-1.5 w-1.5 rounded-full ${statusDotClass}`} />
              <span>{statusLabel}</span>
            </div>
            {envelopeId && (
              <span className="font-mono text-[0.7rem] text-slate-400">
                Envelope: {envelopeId}
              </span>
            )}
          </div>

          {loading && !hardError && (
            <p className="text-xs text-slate-400 mb-2">
              Contacting ODP.AI signing service…
            </p>
          )}
          {hardError && (
            <p className="text-xs text-rose-400 mb-3">{hardError}</p>
          )}

          {/* Main content */}
          {!hardError && !loading && (
            <section className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-[1.7fr,1.1fr] gap-4">
                {/* Document column */}
                <section className="flex flex-col gap-2 rounded-2xl border border-slate-800/90 bg-gradient-to-b from-slate-950 via-slate-950/90 to-black/90 p-3.5">
                  <div className="flex items-center justify-between text-[0.7rem] uppercase tracking-[0.18em] text-slate-400">
                    <span>Document</span>
                    <span className="rounded-full border border-slate-600/60 px-2 py-0.5 text-[0.68rem]">
                      {pdfUrl
                        ? `PDF · ${
                            ctx?.document?.file_name || "Governance document"
                          }`
                        : "Ledger text · Draft"}
                    </span>
                  </div>

                  <div className="relative mt-1 h-[420px] max-h-[calc(100vh-260px)] overflow-hidden rounded-xl border border-slate-800/80 bg-black">
                    {pdfUrl ? (
                      <>
                        <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-[0.75rem] text-slate-400">
                          If the preview does not load, use the “Open in new
                          tab” link below.
                        </div>
                        <iframe
                          src={pdfUrl}
                          title="Document for signature"
                          className="h-full w-full border-0"
                          onLoad={(e) => {
                            const fallback =
                              (e.target as HTMLIFrameElement)
                                .previousElementSibling;
                            if (fallback) fallback.remove();
                          }}
                        />
                      </>
                    ) : (
                      <div className="absolute inset-0 overflow-auto bg-slate-50 p-4 text-slate-900 text-sm leading-relaxed">
                        <h2 className="mb-1 text-base font-semibold">
                          {ctx?.record?.title || "Governance Record"}
                        </h2>
                        <p className="mb-3 text-[0.75rem] text-slate-500">
                          {ctx?.entity?.name
                            ? `${ctx.entity.name} • Oasis Digital Parliament`
                            : "Oasis Digital Parliament"}
                        </p>
                        <pre className="whitespace-pre-wrap font-sans text-[0.86rem]">
                          {resolutionBody ||
                            "[No PDF is linked to this envelope yet, and no body text is available.]"}
                        </pre>
                      </div>
                    )}
                  </div>

                  <p className="text-[0.72rem] text-slate-400">
                    {pdfUrl ? (
                      <>
                        {ctx?.document?.storage_path ? (
                          <>
                            Stored in{" "}
                            <span className="font-mono text-slate-300">
                              minute_book/{ctx.document.storage_path}
                            </span>
                            .
                          </>
                        ) : (
                          "Document ready."
                        )}{" "}
                        {pdfUrl && (
                          <>
                            ·{" "}
                            <a
                              href={pdfUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-emerald-400 hover:text-emerald-300 underline decoration-emerald-500/70"
                            >
                              Open in new tab
                            </a>
                          </>
                        )}
                      </>
                    ) : (
                      <>
                        No PDF is attached yet. You are viewing the resolution
                        text directly from the governance ledger. A formatted
                        PDF can be generated in a later phase.
                      </>
                    )}
                  </p>
                </section>

                {/* Signing details + digital click */}
                <section className="flex flex-col gap-3 rounded-2xl border border-slate-800/90 bg-gradient-to-b from-slate-950 via-slate-950/90 to-black/90 p-3.5">
                  <div className="flex items-center justify-between text-[0.7rem] uppercase tracking-[0.18em] text-slate-400">
                    <span>Signing Details</span>
                    <span className="rounded-full border border-slate-600/60 px-2 py-0.5 text-[0.68rem]">
                      {isSigned ? "Signed" : "Signer Pending"}
                    </span>
                  </div>

                  <dl className="grid grid-cols-[1.1fr,1.9fr] gap-y-1.5 gap-x-2 text-[0.78rem]">
                    <dt className="text-slate-400">Signer</dt>
                    <dd className="text-slate-100 font-medium">
                      {ctx?.party?.display_name ||
                        ctx?.party?.email ||
                        "Unknown signer"}
                    </dd>

                    <dt className="text-slate-400">Role</dt>
                    <dd className="text-slate-100 font-medium">
                      {ctx?.party?.role || "signer"}
                    </dd>

                    <dt className="text-slate-400">Entity</dt>
                    <dd className="text-slate-100 font-medium">
                      {ctx?.entity?.name ||
                        ctx?.entity?.slug ||
                        "Unknown entity"}
                    </dd>

                    <dt className="text-slate-400">Record</dt>
                    <dd className="text-slate-100 font-medium">
                      {ctx?.record?.title || "Governance record"}
                    </dd>

                    <dt className="text-slate-400">Record ID</dt>
                    <dd className="font-mono text-[0.74rem] text-slate-300">
                      {ctx?.record?.id || "—"}
                    </dd>

                    <dt className="text-slate-400">Envelope</dt>
                    <dd className="font-mono text-[0.74rem] text-slate-300">
                      {ctx?.envelope?.id || envelopeId || "—"}
                    </dd>
                  </dl>

                  {/* Digital click acknowledgement */}
                  {!isSigned && (
                    <button
                      type="button"
                      onClick={() => setConfirmed((prev) => !prev)}
                      className={`mt-2 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[0.75rem] transition
                        ${
                          confirmed
                            ? "border-emerald-400/80 bg-emerald-500/10 text-emerald-200 shadow-[0_0_20px_rgba(16,185,129,0.5)]"
                            : "border-slate-600/80 bg-slate-900/80 text-slate-300 hover:border-emerald-400/80 hover:text-emerald-200"
                        }`}
                    >
                      <span
                        className={`h-3.5 w-3.5 rounded-full border flex items-center justify-center text-[0.55rem] ${
                          confirmed
                            ? "border-emerald-400 bg-emerald-500/30"
                            : "border-slate-500"
                        }`}
                      >
                        {confirmed ? "✓" : ""}
                      </span>
                      <span>
                        I have reviewed this document and authorize this
                        execution.
                      </span>
                    </button>
                  )}

                  {signError && (
                    <p className="text-[0.78rem] text-rose-400">{signError}</p>
                  )}

                  <div className="mt-3 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => window.location.reload()}
                      className="inline-flex items-center rounded-full border border-slate-600/80 px-3 py-1.5 text-[0.78rem] font-medium text-slate-200 hover:bg-slate-900/80 transition"
                    >
                      Refresh
                    </button>
                    <button
                      type="button"
                      disabled={!canSign}
                      onClick={handleSign}
                      className={`inline-flex items-center rounded-full px-4 py-1.5 text-[0.78rem] font-semibold tracking-[0.16em] uppercase transition
                        ${
                          canSign
                            ? "bg-gradient-to-r from-emerald-400 to-emerald-500 text-slate-950 shadow-[0_14px_40px_rgba(16,185,129,0.6)] hover:shadow-[0_18px_45px_rgba(16,185,129,0.7)]"
                            : "bg-emerald-500/20 text-emerald-200/70 cursor-not-allowed"
                        }`}
                    >
                      {isSigned
                        ? "Signature Complete"
                        : signing
                        ? "Recording Signature…"
                        : confirmed
                        ? "Sign & Complete"
                        : "Confirm to Sign"}
                    </button>
                  </div>
                </section>
              </div>

              <div className="mt-1 flex flex-col md:flex-row items-start md:items-center justify-between gap-2 text-[0.72rem] text-slate-400">
                <p>
                  Issued &amp; executed via the{" "}
                  <span className="font-medium text-slate-100">
                    Oasis Digital Parliament Ledger
                  </span>
                  , an AI-governed corporate minute book powered by{" "}
                  <span className="font-medium text-slate-100">ODP.AI</span>.
                </p>
                <p className="text-[0.7rem]">
                  This link is unique to your signing session. Do not share it
                  publicly.
                </p>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
