"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";

export default function UpdatePasswordPage() {
  const router = useRouter();

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleUpdate = async () => {
    setError(null);

    if (!password || !confirm) {
      setError("Please enter and confirm your new password.");
      return;
    }

    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    setSubmitting(true);
    try {
      // After visiting the recovery link, Supabase will have an active session
      // for this operator. We now update that user's password.
      const { error: updateError } = await supabase.auth.updateUser({
        password,
      });

      if (updateError) {
        console.error(updateError);
        setError("Unable to update password. Please try again.");
        setSubmitting(false);
        return;
      }

      setDone(true);
      setSubmitting(false);

      // Small delay then route them back to login
      setTimeout(() => {
        router.push("/login");
      }, 1500);
    } catch (err) {
      console.error(err);
      setError("Unexpected error. Please try again.");
      setSubmitting(false);
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
          Set New Credentials
        </h1>

        {/* SUBTITLE */}
        <p className="text-xs text-slate-400 mb-6">
          Choose a new password for your Oasis OS operator account. For
          security reasons, this link may expire after use.
        </p>

        {!done ? (
          <div className="space-y-4">
            <div>
              <label className="block text-[11px] font-medium text-slate-300 mb-1.5">
                New password
              </label>
              <input
                type="password"
                className="w-full rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-400/70 focus:border-emerald-400/70"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            <div>
              <label className="block text-[11px] font-medium text-slate-300 mb-1.5">
                Confirm new password
              </label>
              <input
                type="password"
                className="w-full rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-400/70 focus:border-emerald-400/70"
                placeholder="••••••••"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>

            {error && (
              <p className="text-[11px] text-red-400 mt-1">{error}</p>
            )}

            <button
              type="button"
              onClick={handleUpdate}
              disabled={submitting}
              className="w-full mt-2 rounded-lg bg-emerald-500 text-slate-950 text-sm font-medium py-2.5 hover:bg-emerald-400 disabled:bg-slate-700 disabled:text-slate-400 transition"
            >
              {submitting ? "Updating…" : "Update Password"}
            </button>
          </div>
        ) : (
          <div className="text-sm text-slate-300 space-y-2">
            <p>Your credentials have been updated successfully.</p>
            <p className="text-slate-500 text-xs">
              You will be redirected to the Oasis OS login gate.
            </p>
          </div>
        )}

        <div className="mt-6 pt-4 border-t border-slate-800 text-[11px] text-slate-500 text-center">
          Oasis OS credential update protocol.
        </div>
      </div>
    </main>
  );
}
