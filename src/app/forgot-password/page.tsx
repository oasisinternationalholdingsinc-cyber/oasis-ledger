"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";

export default function ForgotPasswordPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const handleSubmit = async () => {
    if (!email) return;

    setSubmitting(true);

    try {
      // Issue recovery email. We *always* show the same UI result,
      // regardless of whether an account exists or not.
      await supabase.auth.resetPasswordForEmail(email, {
        // Optional: when you’re ready, point this to your future
        // password-update page, e.g. /update-password
        redirectTo: `${window.location.origin}/update-password`,
      });
    } catch (err) {
      // We deliberately do NOT expose error details in the UI.
      console.error("Error issuing recovery link:", err);
    } finally {
      setSubmitting(false);
      setDone(true);
    }
  };

  return (
    <main className="min-h-screen bg-[#020617] flex items-center justify-center px-4 text-slate-100">
      <div className="w-full max-w-sm rounded-3xl border border-slate-800 bg-black/70 px-8 py-9 shadow-[0_0_60px_rgba(15,23,42,0.85)] relative z-10">
        {/* TOP BADGE */}
        <div className="text-[10px] tracking-[0.35em] uppercase text-slate-500 mb-2">
          Oasis Digital Parliament
        </div>

        {/* TITLE */}
        <h1 className="text-xl font-semibold text-slate-100 mb-1">
          Reset Access Credentials
        </h1>

        {/* SUBTITLE */}
        <p className="text-xs text-slate-400 mb-6">
          Enter the email address associated with your Oasis OS operator
          account. If authorized, a recovery link will be issued.
        </p>

        {/* FORM / CONFIRMATION */}
        {!done ? (
          <div className="space-y-4">
            <div>
              <label className="block text-[11px] font-medium text-slate-300 mb-1.5">
                Email
              </label>
              <input
                type="email"
                className="w-full rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-400/70 focus:border-emerald-400/70"
                placeholder="you@organization.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting || !email}
              className="w-full mt-2 rounded-lg bg-emerald-500 text-slate-950 text-sm font-medium py-2.5 hover:bg-emerald-400 disabled:bg-slate-700 disabled:text-slate-400 transition"
            >
              {submitting ? "Issuing recovery link…" : "Issue Recovery Link"}
            </button>
          </div>
        ) : (
          <div className="text-sm text-slate-300 space-y-2">
            <p>
              If an authorized account exists for this address, a recovery link
              has been issued.
            </p>
            <p className="text-slate-500 text-xs">
              For security reasons, account status is never disclosed.
            </p>
          </div>
        )}

        {/* FOOTER ACTIONS */}
        <div className="mt-6 pt-4 border-t border-slate-800 flex items-center justify-between text-[11px] text-slate-500">
          <span>Oasis OS access recovery protocol.</span>
          <Link
            href="/login"
            className="text-[11px] text-slate-400 hover:text-slate-200 transition"
          >
            Return to login
          </Link>
        </div>
      </div>
    </main>
  );
}
