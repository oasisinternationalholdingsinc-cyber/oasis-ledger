"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";

type SigningContext = any;

export default function SignClient() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const envelopeId =
    searchParams.get("envelope_id") || searchParams.get("envelopeId");
  const token = searchParams.get("token") || searchParams.get("t") || null;

  const [loading, setLoading] = useState(true);
  const [signing, setSigning] = useState(false);
  const [context, setContext] = useState<SigningContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [signed, setSigned] = useState(false);

  useEffect(() => {
    const checkAuth = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) router.replace("/login");
    };
    checkAuth();
  }, [router]);

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
          { body: payload },
        );

        if (error) {
          console.error("get-signing-context error:", error);
          setError(error.message || "Unable to load signing context.");
          setContext(null);
        } else {
          setContext(data);
          if (data && (data.status === "signed" || data.signed === true)) {
            setSigned(true);
          }
        }
      } catch (err: any) {
        console.error("get-signing-context exception:", err);
        setError(err?.message ?? "Unexpected error while loading context.");
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
        { body: payload },
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
      setError(err?.message ?? "Unexpected error while completing signature.");
    } finally {
      setSigning(false);
    }
  };

  return (
    <div className="h-[calc(100vh-80px)] w-full flex flex-col px-8 pt-6 pb-6 text-slate-100">
      {/* (keep your UI exactly as you pasted) */}
      {/* ... */}
      {/* Just make sure this file contains ONLY this one default export. */}
    </div>
  );
}
