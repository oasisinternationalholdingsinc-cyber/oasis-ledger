"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";

type SigningContext = any;

export default function CISignPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // we’ll pass ?envelope_id=...&token=... from Forge later
  const envelopeId =
    searchParams.get("envelope_id") || searchParams.get("envelopeId");
  const token = searchParams.get("token") || searchParams.get("t") || null;

  const [loading, setLoading] = useState(true);
  const [signing, setSigning] = useState(false);
  const [context, setContext] = useState<SigningContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [signed, setSigned] = useState(false);

  // 🔐 Auth guard – must be logged into Oasis OS
  useEffect(() => {
    const checkAuth = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        router.replace("/login");
      }
    };

    checkAuth();
  }, [router]);

  // 📥 Load signing context from Edge Function
  useEffect(() => {
    if (!envelopeId) {
      setError("Missing envelope_id in URL.");
      setLoading(false);
      return;
    }

    const loadContext = async () => {
      setLoading(true);
      setError(null);
      setInfo(null);

      try {
        const payload: Record<string, any> = { envelope_id: envelopeId };
        if (token) payload.token = token;

        const { data, error } = await supabase.functions.invoke(
          "get-signing-context",
          {
            body: payload,
          }
        );

        if (error) {
          console.error("get-signing-context error:", error);
          setError(error.message || "Unable to load signing context.");
          setContext(null);
        } else {
          console.log("get-signing-context response:", data);
          setContext(data);
          if (data && (data.status === "signed" || data.signed === true)) {
            setSigned(true);
          }
        }
      } catch (err: any) {
        console.error("get-signing-context exception:", err);
        setError(err.message ?? "Unexpected error while loading context.");
        setContext(null);
      } finally {
        setLoading(false);
      }
    };

    loadContext();
  }, [envelopeId, token]);

  const recordTitle = useMemo(() => {
    if (!context) return "";
    return (
      context.record?.title ||
      context.envelope?.record_title ||
      context.title ||
      ""
    );
  }, [context]);

  const entityName = useMemo(() => {
    if (!context) return "";
    return (
      context.record?.entity_name ||
      context.envelope?.entity_name ||
      context.entity_name ||
      ""
    );
  }, [context]);

  const pdfUrl = useMemo(() => {
    if (!context) return null as string | null;
    return (
      context.pdf_url ||
      context.document_url ||
      context.record?.pdf_url ||
      context.record?.document_url ||
      null
    );
  }, [context]);

  const primarySignerName = useMemo(() => {
    if (!context) return "";
    return (
      context.primary_signer_name ||
      context.primary_party?.name ||
      context.party?.name ||
      ""
    );
  }, [context]);

  const primarySignerEmail = useMemo(() => {
    if (!context) return "";
    return (
      context.primary_signer_email ||
      context.primary_party?.email ||
      context.party?.email ||
      ""
    );
  }, [context]);

  // ✍️ Complete signature via Edge Function
  const handleSign = async () => {
    if (!envelopeId || signing) return;

    setSigning(true);
    setError(null);
    setInfo(null);

    try {
      const payload: Record<string, any> = { envelope_id: envelopeId };
      if (token) payload.token = token;

      const { data, error } = await supabase.functions.invoke(
        "complete-signature",
        {
          body: payload,
        }
      );

      if (error) {
        console.error("complete-signature error:", error);
        setError(error.message || "Unable to complete signature.");
        return;
      }

      console.log("complete-signature response:", data);
      setSigned(true);
      setInfo("Signature recorded successfully.");
    } catch (err: any) {
      console.error("complete-signature exception:", err);
      setError(err.message ?? "Unexpected error while completing signature.");
    } finally {
      setSigning(false);
    }
  };

  return (
    <div className="h-[calc(100vh-80px)] w-full flex flex-col px-8 pt-6 pb-6 text-slate-100">
      {/* Header */}
      <div className="mb-4 shrink-0 flex items-baseline justify-between gap-4">
        <div>
          <div className="text-xs tracking-[0.3em] uppercase text-sky-400">
            CI-SIGN
          </div>
          <p className="mt-1 text-[11px] text-slate-400">
            Internal Signature Console •{" "}
            <span className="font-semibold text-slate-200">
              Oasis Digital Parliament
            </span>
          </p>
        </div>
        <div className="hidden md:block text-[10px] uppercase tracking-[0.25em] text-slate-500">
          SIGNATURE EXECUTION • LIVE
        </div>
      </div>

      {/* Main window */}
      <div className="flex-1 min-h-0 flex justify-center overflow-hidden">
        <div className="w-full max-w-[1400px] h-full rounded-3xl border border-slate-900 bg-slate-950/80 shadow-[0_0_60px_rgba(15,23,42,0.9)] px-6 py-5 flex flex-col overflow-hidden">
          {/* Title bar */}
          <div className="mb-4 flex items-start justify-between shrink-0">
            <div>
              <h1 className="text-lg font-semibold text-slate-50">
                Oasis Digital Parliament – Signature Execution
              </h1>
              <p className="mt-1 text-xs text-slate-400 max-w-2xl">
                Review the governance document below and sign to complete
                execution. This console uses the same envelopes and parties as
                CI-Forge and the public signing portal.
              </p>
            </div>
            <div className="flex flex-col items-end gap-1 text-[10px] text-slate-500">
              <div>
                Envelope:{" "}
                <span className="text-slate-300">
                  {envelopeId || "— (missing)"}
                </span>
              </div>
              {entityName && (
                <div>
                  Entity:{" "}
                  <span className="text-slate-300">{entityName}</span>
                </div>
              )}
            </div>
          </div>

          {/* Layout */}
          <div className="flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-[minmax(0,2fr)_minmax(0,1.1fr)] gap-6 overflow-hidden">
            {/* LEFT – Document preview */}
            <section className="flex flex-col min-h-0 rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">
                    Governance Document
                  </div>
                  <div className="mt-1 text-sm font-semibold text-slate-100 line-clamp-2">
                    {recordTitle || "Loading resolution title…"}
                  </div>
                </div>
                <span
                  className={`px-2 py-0.5 rounded-full border text-[10px] uppercase tracking-[0.18em] ${
                    signed
                      ? "bg-emerald-500/10 border-emerald-500/60 text-emerald-300"
                      : "bg-sky-500/10 border-sky-500/50 text-sky-300"
                  }`}
                >
                  {signed ? "Signed" : "Awaiting Signature"}
                </span>
              </div>

              <div className="flex-1 min-h-0 rounded-xl border border-slate-800 bg-slate-950/80 overflow-hidden">
                {loading ? (
                  <div className="h-full flex items-center justify-center text-xs text-slate-400">
                    Loading signing context…
                  </div>
                ) : pdfUrl ? (
                  <iframe
                    src={pdfUrl}
                    className="w-full h-full border-0"
                    title="Resolution PDF"
                  />
                ) : context?.record?.body ? (
                  <div className="h-full overflow-y-auto px-4 py-3 text-[11px] leading-relaxed">
                    <pre className="whitespace-pre-wrap font-sans text-slate-200">
                      {context.record.body}
                    </pre>
                  </div>
                ) : (
                  <div className="h-full flex flex-col items-center justify-center px-6 text-center text-[11px] text-slate-500">
                    <p>No PDF URL found in signing context.</p>
                    <p className="mt-1">
                      (Check that get-signing-context returns a pdf_url or
                      document_url field.)
                    </p>
                  </div>
                )}
              </div>

              {/* Debug context (optional) */}
              {context && (
                <details className="mt-3 text-[10px] text-slate-500">
                  <summary className="cursor-pointer">
                    Debug: raw signing context
                  </summary>
                  <pre className="mt-2 max-h-48 overflow-y-auto rounded-lg bg-slate-950/90 border border-slate-800 px-3 py-2">
                    {JSON.stringify(context, null, 2)}
                  </pre>
                </details>
              )}
            </section>

            {/* RIGHT – Signer panel */}
            <section className="flex flex-col min-h-0 rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">
                    Signing Party
                  </div>
                  <div className="mt-1 text-sm font-semibold text-slate-100">
                    {primarySignerName || "Primary signer"}
                  </div>
                  {primarySignerEmail && (
                    <div className="text-[11px] text-slate-400">
                      {primarySignerEmail}
                    </div>
                  )}
                </div>
                <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/40 text-[10px] uppercase tracking-[0.18em] text-emerald-300">
                  Ledger-Linked
                </span>
              </div>

              <div className="mb-4 text-[11px] text-slate-400">
                By signing, you confirm that you have reviewed the attached
                governance record and are authorized to execute on behalf of the
                listed entity. This action will be recorded in the{" "}
                <span className="font-semibold text-emerald-300">
                  Oasis Digital Parliament ledger
                </span>{" "}
                and reflected in CI-Archive / certificates.
              </div>

              <div className="mb-4 flex flex-col gap-2 text-[11px] text-slate-400">
                <div>
                  <span className="font-semibold text-slate-200">
                    Envelope ID:
                  </span>{" "}
                  <span className="text-slate-400">
                    {envelopeId || "— (missing)"}
                  </span>
                </div>
                {context?.record?.id && (
                  <div>
                    <span className="font-semibold text-slate-200">
                      Record ID:
                    </span>{" "}
                    <span className="text-slate-400">
                      {context.record.id}
                    </span>
                  </div>
                )}
              </div>

              {/* Buttons */}
              <div className="mt-auto flex flex-col gap-3">
                <button
                  type="button"
                  disabled={!context || signing || signed}
                  onClick={handleSign}
                  className={`rounded-full px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.2em] transition ${
                    !context || signing || signed
                      ? "bg-emerald-500/20 text-emerald-200/60 cursor-not-allowed"
                      : "bg-emerald-500 text-slate-950 hover:bg-emerald-400"
                  }`}
                >
                  {signed
                    ? "Signature Complete"
                    : signing
                    ? "Recording Signature…"
                    : "Sign Resolution"}
                </button>

                <div className="flex flex-wrap gap-2 text-[11px]">
                  <button
                    type="button"
                    disabled={!context?.record?.id}
                    className="rounded-full border border-slate-700 bg-slate-900/80 px-3 py-1.5 text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed"
                    // TODO: wire to CI-Archive deep link when ready
                  >
                    Open in CI-Archive
                  </button>
                  <button
                    type="button"
                    disabled={!signed}
                    className="rounded-full border border-slate-700 bg-slate-900/80 px-3 py-1.5 text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed"
                    // TODO: call download-signed-pdf or link to certificate.html
                  >
                    Download Signed PDF / Certificate
                  </button>
                </div>

                {error && (
                  <div className="mt-2 rounded-xl border border-red-600/60 bg-red-900/40 px-3 py-2 text-[11px] text-red-200">
                    {error}
                  </div>
                )}

                {info && !error && (
                  <div className="mt-2 rounded-xl border border-emerald-600/60 bg-emerald-900/40 px-3 py-2 text-[11px] text-emerald-200">
                    {info}
                  </div>
                )}

                <div className="mt-2 flex items-center justify-between text-[10px] text-slate-500">
                  <span>CI-Sign · Oasis Digital Parliament</span>
                  <span>ODP.AI · Resolution Session</span>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
