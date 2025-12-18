"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/browser";

function slugify(name: string) {
  return name
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .replace(/-+/g, "-");
}

export default function CIArchiveUploadPage() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const [entityKey, setEntityKey] = useState("holdings");
  const [folder, setFolder] = useState("AnnualReturns");
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function handleUpload() {
    setOk(null);
    setErr(null);

    if (!file) return setErr("Pick a PDF first.");
    if (file.type !== "application/pdf") return setErr("Only PDFs are allowed.");
    if (!folder.trim()) return setErr("Folder is required.");

    setBusy(true);
    try {
      const { data: userRes, error: userErr } = await supabase.auth.getUser();
      if (userErr) throw userErr;
      if (!userRes?.user) throw new Error("Not authenticated (OS auth gate should handle this).");

      const safeFileName = slugify(file.name);
      const safeFolder = slugify(folder);
      const storagePath = `${entityKey}/${safeFolder}/${safeFileName}`;

      // 1) Upload to Storage
      const up = await supabase.storage.from("minute_book").upload(storagePath, file, {
        upsert: false, // DO NOT overwrite. Prevent silent regressions.
        contentType: "application/pdf",
        cacheControl: "3600",
      });

      if (up.error) {
        // Most common: 409 / Already exists
        throw new Error(`Storage upload failed: ${up.error.message}`);
      }

      // 2) Insert minute_book_entries
      const finalTitle = title.trim() || safeFileName;

      const ins = await supabase
        .from("minute_book_entries")
        .insert({
          bucket_id: "minute_book",
          storage_path: storagePath,
          source: "manual_upload",
          title: finalTitle,
          entity_key: entityKey,
        })
        .select("id")
        .single();

      if (ins.error) {
        // If DB insert fails (duplicate constraint, RLS, etc.) we DO NOT hide it.
        // Optional: cleanup the uploaded file if you want strict atomicity.
        throw new Error(`DB insert failed: ${ins.error.message}`);
      }

      setOk(`Uploaded + indexed ✅ (${ins.data?.id})`);
      setTitle("");
      setFile(null);
    } catch (e: any) {
      console.error(e);
      setErr(e?.message ?? "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="sticky top-0 z-10 border-b border-yellow-500/15 bg-black/70 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <div>
            <div className="text-sm tracking-wide text-yellow-200/90">CI-Archive Upload</div>
            <div className="text-xs text-white/50">minute_book → minute_book_entries</div>
          </div>

          <Link
            href="/ci-archive"
            className="rounded-xl border border-yellow-500/15 bg-black px-3 py-2 text-sm text-white/70 hover:bg-white/5"
          >
            Back to Archive
          </Link>
        </div>
      </div>

      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="rounded-2xl border border-yellow-500/15 bg-black/40 p-5">
          <div className="grid gap-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="space-y-1">
                <div className="text-xs uppercase tracking-widest text-white/50">Entity</div>
                <select
                  className="w-full rounded-xl border border-yellow-500/15 bg-black px-3 py-2 text-sm text-white/80 outline-none"
                  value={entityKey}
                  onChange={(e) => setEntityKey(e.target.value)}
                >
                  <option value="holdings">holdings</option>
                  <option value="realestate">realestate</option>
                  <option value="lounge">lounge</option>
                </select>
              </label>

              <label className="space-y-1">
                <div className="text-xs uppercase tracking-widest text-white/50">Folder</div>
                <input
                  className="w-full rounded-xl border border-yellow-500/15 bg-black px-3 py-2 text-sm text-white/80 outline-none"
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                  placeholder="AnnualReturns"
                />
              </label>
            </div>

            <label className="space-y-1">
              <div className="text-xs uppercase tracking-widest text-white/50">Title (optional)</div>
              <input
                className="w-full rounded-xl border border-yellow-500/15 bg-black px-3 py-2 text-sm text-white/80 outline-none"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="2025 Annual Return"
              />
            </label>

            <label className="space-y-1">
              <div className="text-xs uppercase tracking-widest text-white/50">PDF File</div>
              <input
                type="file"
                accept="application/pdf"
                className="w-full rounded-xl border border-yellow-500/15 bg-black px-3 py-2 text-sm text-white/80 outline-none"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              <div className="text-xs text-white/35">
                Upload is <span className="text-white/60">non-destructive</span> (no overwrite). Duplicates will fail loudly.
              </div>
            </label>

            {err && (
              <div className="rounded-2xl border border-red-500/25 bg-red-500/10 p-3 text-sm text-red-100">
                {err}
              </div>
            )}
            {ok && (
              <div className="rounded-2xl border border-green-500/25 bg-green-500/10 p-3 text-sm text-green-100">
                {ok}
              </div>
            )}

            <button
              onClick={handleUpload}
              disabled={busy}
              className={[
                "rounded-2xl border px-4 py-3 text-sm",
                busy
                  ? "cursor-not-allowed border-yellow-500/10 bg-black text-white/30"
                  : "border-yellow-400/25 bg-yellow-500/10 text-yellow-100 hover:bg-yellow-500/15",
              ].join(" ")}
            >
              {busy ? "Uploading…" : "Upload & Index"}
            </button>

            <div className="text-xs leading-relaxed text-white/35">
              If you see a DB error like <span className="text-white/55">duplicate key</span>, that means your unique constraint is doing its job.
              Rename the file or change folder to create a new unique storage path.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
