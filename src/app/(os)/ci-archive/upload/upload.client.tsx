"use client";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";

function cls(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function readEntityKeyFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const sp = new URLSearchParams(window.location.search);
  return sp.get("entity_key") || sp.get("entityKey") || sp.get("entity");
}

export default function UploadClient() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const [entityKey, setEntityKey] = useState<string | null>(null);

  // Form fields (domain-driven)
  const [domainKey, setDomainKey] = useState<string>("resolutions");
  const [entryType, setEntryType] = useState<string>("Minutes");
  const [title, setTitle] = useState<string>("");
  const [notes, setNotes] = useState<string>("");
  const [file, setFile] = useState<File | null>(null);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    const fromUrl = readEntityKeyFromUrl();
    if (fromUrl) {
      setEntityKey(fromUrl);
      try {
        localStorage.setItem("oasis_entity_key", fromUrl);
      } catch {}
      return;
    }
    try {
      const saved = localStorage.getItem("oasis_entity_key");
      if (saved) setEntityKey(saved);
    } catch {}
  }, []);

  async function sha256Hex(f: File): Promise<string> {
    const buf = await f.arrayBuffer();
    const hash = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function submit() {
    setErr(null);
    setOk(null);

    if (!entityKey) return setErr("No entity scope. Open Upload from OS with ?entity_key=...");
    if (!title.trim()) return setErr("Title is required.");
    if (!file) return setErr("PDF file is required.");

    setBusy(true);
    try {
      const fileHash = await sha256Hex(file);

      // 1) Build storage path (domain-driven, not folder browsing)
      // Canonical pattern (yours): {entity}/{domain}/{entryType}/{yyyy-mm-dd}/{hash}-{filename}
      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, "0");
      const dd = String(today.getDate()).padStart(2, "0");
      const safeName = file.name.replace(/[^\w.\-]+/g, "_");

      const storagePath = `${entityKey}/${domainKey}/${entryType}/${yyyy}-${mm}-${dd}/${fileHash}-${safeName}`;

      // 2) Upload to bucket
      const { error: upErr } = await supabase.storage.from("minute_book").upload(storagePath, file, {
        cacheControl: "3600",
        upsert: false,
        contentType: file.type || "application/pdf",
      });
      if (upErr) throw new Error(upErr.message);

      // 3) Register/index via your canonical SQL function (replace name/args to match your production function)
      // Example (you already confirmed hashing mandatory + register_minute_book_upload as the single entry point):
      const { error: rpcErr } = await supabase.rpc("register_minute_book_upload", {
        p_entity_key: entityKey,
        p_domain_key: domainKey,
        p_entry_type: entryType,
        p_title: title,
        p_notes: notes || null,
        p_file_name: file.name,
        p_storage_path: storagePath,
        p_file_hash: fileHash,
        p_file_size: file.size,
        p_mime_type: file.type || "application/pdf",
      });

      if (rpcErr) throw new Error(rpcErr.message);

      setOk("Upload complete. Record indexed into CI-Archive registry.");
      setTitle("");
      setNotes("");
      setFile(null);
    } catch (e: any) {
      setErr(e?.message || "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="mx-auto max-w-[1100px] px-5 pt-5">
        <div className="rounded-2xl border border-white/10 bg-white/5">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-white/95">CI-Archive Upload</div>
              <div className="mt-1 text-xs text-white/55">
                Domain-driven filing · SHA-256 mandatory · Single SQL registration contract
              </div>
            </div>

            <div className="flex items-center gap-2">
              {entityKey ? (
                <span className="rounded-full border border-white/10 bg-black/30 px-3 py-1 text-xs text-white/75">
                  Entity: <span className="text-white/95">{entityKey}</span>
                </span>
              ) : (
                <span className="rounded-full border border-red-500/25 bg-red-500/10 px-3 py-1 text-xs text-red-200">
                  No entity scope
                </span>
              )}
              <a
                href={`/ci-archive/minute-book${entityKey ? `?entity_key=${encodeURIComponent(entityKey)}` : ""}`}
                className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10"
              >
                Back to Minute Book
              </a>
            </div>
          </div>
          <div className="h-px w-full bg-gradient-to-r from-transparent via-yellow-500/35 to-transparent" />
        </div>

        {err ? (
          <div className="mt-3 rounded-2xl border border-red-500/25 bg-red-500/10 p-4 text-sm text-red-100">{err}</div>
        ) : null}
        {ok ? (
          <div className="mt-3 rounded-2xl border border-emerald-500/25 bg-emerald-500/10 p-4 text-sm text-emerald-100">
            {ok}
          </div>
        ) : null}

        <div className="mt-4 rounded-3xl border border-white/10 bg-white/5 p-5">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Domain">
              <select
                value={domainKey}
                onChange={(e) => setDomainKey(e.target.value)}
                className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white/85 outline-none"
              >
                <option value="articles">Articles</option>
                <option value="share-capital">Share Capital</option>
                <option value="directors-officers">Directors & Officers</option>
                <option value="resolutions">Resolutions</option>
                <option value="annual-returns">Annual Returns</option>
                <option value="tax-cra">Tax & CRA</option>
                <option value="banking">Banking</option>
                <option value="contracts">Contracts</option>
                <option value="licenses-compliance">Licenses & Compliance</option>
                <option value="other">Other</option>
              </select>
            </Field>

            <Field label="Entry Type">
              <input
                value={entryType}
                onChange={(e) => setEntryType(e.target.value)}
                className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white/85 outline-none"
                placeholder="Minutes / Resolution / Certificate / etc."
              />
            </Field>

            <Field label="Title">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white/85 outline-none"
                placeholder="e.g., Directors Resolution – Banking"
              />
            </Field>

            <Field label="PDF">
              <input
                type="file"
                accept="application/pdf"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white/85 outline-none"
              />
            </Field>

            <div className="md:col-span-2">
              <Field label="Notes (optional)">
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={4}
                  className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white/85 outline-none"
                  placeholder="Optional registry notes…"
                />
              </Field>
            </div>
          </div>

          <div className="mt-4 flex items-center justify-end">
            <button
              onClick={submit}
              disabled={busy}
              className={cls(
                "rounded-2xl border border-yellow-500/20 bg-yellow-500/10 px-4 py-2 text-sm text-yellow-100/90",
                "hover:bg-yellow-500/15 disabled:opacity-50"
              )}
            >
              {busy ? "Registering…" : "Upload & Register"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-semibold tracking-[0.18em] text-white/45">{label.toUpperCase()}</div>
      {children}
    </div>
  );
}
