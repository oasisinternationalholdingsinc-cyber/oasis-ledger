"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/browser";

type SigningContext = {
  envelope?: any;
  party?: any;
  entity?: any;
  record?: any;
  document?: { file_name?: string | null; storage_path?: string | null } | null;
  pdf_url?: string | null;
  resolution?: { body?: string | null } | null;
  error?: string | null;
};

export default function SignClient() {
  const router = useRouter();
  const supabase = useMemo(() => supabaseBrowser(), []);

  const [envelopeId, setEnvelopeId] = useState<string | null>(null);
  const [partyId, setPartyId] = useState<string | null>(null);

  const [ctx, setCtx] = useState<SigningContext | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // ✅ no useSearchParams (pre-render safe)
    const sp = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
    setEnvelopeId(sp.get("envelope_id"));
    setPartyId(sp.get("party_id"));
  }, []);

  useEffect(() => {
    let alive = true;

    async function load() {
      if (!envelopeId || !partyId) {
        setLoading(false);
        setCtx({ error: "Missing envelope_id or party_id." });
        return;
      }

      setLoading(true);

      try {
        const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
        const GET_CONTEXT_URL = `${SUPABASE_URL}/functions/v1/get-signing-context`;

        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData.session?.access_token;

        const res = await fetch(GET_CONTEXT_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ envelope_id: envelopeId, party_id: partyId }),
        });

        const json = (await res.json()) as SigningContext;
        if (!alive) return;

        setCtx(json);
        setLoading(false);
      } catch (e: any) {
        if (!alive) return;
        setCtx({ error: e?.message || "Failed to load signing context." });
        setLoading(false);
      }
    }

    load();
    return () => {
      alive = false;
    };
  }, [envelopeId, partyId, supabase]);

  if (loading) return <div className="p-6 text-sm text-slate-200">Loading…</div>;
  if (ctx?.error) return <div className="p-6 text-sm text-red-200">{ctx.error}</div>;

  return (
    <div className="p-6 text-slate-100">
      <div className="text-lg font-semibold">Signature</div>
      <div className="mt-2 text-sm text-slate-300">
        Envelope: <span className="text-slate-100">{envelopeId}</span>
      </div>
      <div className="text-sm text-slate-300">
        Party: <span className="text-slate-100">{partyId}</span>
      </div>

      <div className="mt-6 flex gap-2">
        <button
          onClick={() => router.back()}
          className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs hover:bg-slate-950/70"
        >
          Back
        </button>
      </div>
    </div>
  );
}
