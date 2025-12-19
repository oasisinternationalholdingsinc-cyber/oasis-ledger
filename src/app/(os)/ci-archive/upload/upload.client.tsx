"use client";

import { useEffect, useMemo, useState } from "react";
import { useEntity } from "@/components/OsEntityContext";
import { supabaseBrowser } from "@/lib/supabase/browser";

const BUCKET_MINUTE_BOOK = "minute_book";

// Keep in sync with your canonical domains
const DOMAINS: { key: string; label: string }[] = [
  { key: "articles", label: "Articles" },
  { key: "share-capital", label: "Share Capital" },
  { key: "directors-officers", label: "Directors & Officers" },
  { key: "resolutions", label: "Resolutions" },
  { key: "annual-returns", label: "Annual Returns" },
  { key: "tax-cra", label: "Tax & CRA" },
  { key: "banking", label: "Banking" },
  { key: "contracts", label: "Contracts" },
  { key: "licenses-compliance", label: "Licenses & Compliance" },
  { key: "other", label: "Other" },
];

// Adjust to your enum values if needed
const ENTRY_TYPES: { key: string; label: string }[] = [
  { key: "document", label: "Document" },
  { key: "resolution", label: "Resolution" },
  { key: "annual_return", label: "Annual Return" },
  { key: "register", label: "Register / Ledger" },
  { key: "certificate", label: "Certificate" },
  { key: "other", label: "Other" },
];

function cls(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function getQueryParam(name: string) {
  if (typeof window === "undefined") return null;
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

function safeFileName(name: string) {
  return name
    .replace(/[^\w.\-() ]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

function yyyyMm() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

// SHA-256 (hex) client-side
async function sha256Hex(file: File) {
  const buf = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buf);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export default function UploadClient() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const { activeEntity } = useEntity();

  // Entity scope = global entity (with optional URL override)
  const [entityKey, setEntityKey] = useState<string>(activeEntity);

  useEffect(() => {
    const fromUrl =
      getQueryParam("entity_key") || getQueryParam("entityKey") || getQueryParam("entity");
    setEntityKey(fromUrl || activeEntity);
  }, [activeEntity]);

  const [domainKey, setDomainKey] = useState(DOMAINS[0]?.key || "articles");
  const [entryType, setEntryType] = useState(ENTRY_TYPES[0]?.key || "document");

  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [entryDate, setEntryDate] = useState<string>(() => {
    const d = new Date();
    return d.toISOString().slice(0, 10);
  });

  const [file, setFile] = useState<File | null>(null);

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function computedStoragePath(f: File) {
    // Canonical OS filing path:
    // entity/domain/entryType/YYYY-MM/<filename>
    const name = safeFileName(f.name);
    return `${entityKey}/${domainKey}/${entryType}/${yyyyMm()}/${name}`;
  }

  async function submit() {
    setError(null);
    setStatus(null);

    if (!file) return setError("Choose a PDF to upload.");
    if (!title.trim()) return setError("Title is required.");
    if (!entityKey) return setError("Entity scope missing.");

    setBusy(true);

    try {
      // 1) Compute hash (mandatory)
      setStatus("Computing SHA-256…");
      const hash = await sha256Hex(file);

      // 2) Upload to storage
      const storage_path = computedStoragePath(file);

      setStatus("Uploading PDF to registry storage…");
      const up = await supabase.storage
        .from(BUCKET_MINUTE_BOOK)
        .upload(storage_path, file, {
          contentType: file.type || "application/pdf",
          upsert: false,
        });

      if (up.error) {
        // If duplicate exists, show clean message
        throw new Error(up.error.message || "Upload failed.");
      }

      // 3) Register via canonical SQL function
      // IMPORTANT: keep param names aligned with your SQL function signature.
      setStatus("Registering record in minute_book_entries…");

      const { data, error: rpcErr } = await supabase.rpc(
        "register_minute_book_upload",
        {
          p_entity_key: entityKey,
          p_domain_key: domainKey,
          p_entry_type: entryType,
          p_entry_date: entryDate,
          p_title: title.trim(),
          p_notes: notes?.trim() || null,
          p_file_name: file.name,
          p_storage_path: storage_path,
          p_file_hash: hash,
          p_file_size: file.size,
          p_mime_type: file.type || "application/pdf",
        }
      );

      if (rpcErr) {
        throw new Error(rpcErr.message || "Registration failed.");
      }

      setStatus("✅ Uploaded + registered successfully.");
      // Optional: clear form (keep entity/domain for rapid filing)
      setTitle("");
      setNotes("");
      setFile(null);
      // data typically returns uuid id (depends on your function)
      void data;
    } catch (e: any) {
      setError(e?.message || "Upload failed.");
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="mx-auto max-w-[1100px] px-5 pt-6 pb-10">
        {/* OS bar */}
        <div className="rounded-2xl border border-white/10 bg-white/5">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-white/95">
                CI-Archive Upload
              </div>
              <div className="mt-1 text-xs text-white/55">
                Domain-driven filing · Mandatory SHA-256 · Registry-only write surface
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span className="rounded-full border border-white/10 bg-black/30 px-3 py-1 text-xs text-white/75">
                Entity: <span className="text-white/95">{entityKey}</span>
              </span>
              <a
                href={`/ci-archive/minute-book?entity_key=${encodeURIComponent(entityKey)}`}
                className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10"
              >
                Back to Minute Book
              </a>
            </div>
          </div>
          <div className="h-px w-full bg-gradient-to-r from-transparent via-yellow-500/35 to-transparent" />
        </div>

        {/* Form */}
        <div className="mt-4 rounded-3xl border border-white/10 bg-white/5 p-5">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <div className="text-[11px] tracking-wide text-white/45">GOVERNANCE DOMAIN</div>
              <select
                value={domainKey}
                onChange={(e) => setDomainKey(e.target.value)}
                className="mt-2 w-full rounded-2xl border border-white/10 bg-black/30 px-3 py-3 text-sm text-white/90 outline-none"
              >
                {DOMAINS.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <div className="text-[11px] tracking-wide text-white/45">ENTRY TYPE</div>
              <select
                value={entryType}
                onChange={(e) => setEntryType(e.target.value)}
                className="mt-2 w-full rounded-2xl border border-white/10 bg-black/30 px-3 py-3 text-sm text-white/90 outline-none"
              >
                {ENTRY_TYPES.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="md:col-span-2">
              <div className="text-[11px] tracking-wide text-white/45">TITLE</div>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g., Director Resolution — Appointment of Officer"
                className="mt-2 w-full rounded-2xl border border-white/10 bg-black/30 px-3 py-3 text-sm text-white/90 placeholder:text-white/35 outline-none"
              />
            </div>

            <div>
              <div className="text-[11px] tracking-wide text-white/45">ENTRY DATE</div>
              <input
                type="date"
                value={entryDate}
                onChange={(e) => setEntryDate(e.target.value)}
                className="mt-2 w-full rounded-2xl border border-white/10 bg-black/30 px-3 py-3 text-sm text-white/90 outline-none"
              />
            </div>

            <div>
              <div className="text-[11px] tracking-wide text-white/45">PDF FILE</div>
              <input
                type="file"
                accept="application/pdf"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                className="mt-2 w-full rounded-2xl border border-white/10 bg-black/30 px-3 py-3 text-sm text-white/80 outline-none"
              />
              {file ? (
                <div className="mt-2 text-xs text-white/55">
                  Path:{" "}
                  <span className="font-mono text-white/75">
                    {computedStoragePath(file)}
                  </span>
                </div>
              ) : null}
            </div>

            <div className="md:col-span-2">
              <div className="text-[11px] tracking-wide text-white/45">NOTES</div>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional filing notes…"
                className="mt-2 min-h-[110px] w-full rounded-2xl border border-white/10 bg-black/30 px-3 py-3 text-sm text-white/90 placeholder:text-white/35 outline-none"
              />
            </div>
          </div>

          {error ? (
            <div className="mt-4 rounded-2xl border border-red-500/25 bg-red-500/10 p-3 text-sm text-red-100">
              {error}
            </div>
          ) : null}

          {status ? (
            <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-3 text-sm text-white/75">
              {status}
            </div>
          ) : null}

          <div className="mt-4 flex items-center justify-between gap-3">
            <div className="text-xs text-white/45">
              Hashing is mandatory · Upload is the sole write entry point
            </div>

            <button
              onClick={submit}
              disabled={busy}
              className={cls(
                "inline-flex items-center justify-center rounded-2xl px-5 py-3 text-sm font-semibold",
                "border border-yellow-500/25 bg-yellow-500/10 text-yellow-100",
                "hover:bg-yellow-500/15",
                busy && "opacity-60 cursor-not-allowed"
              )}
            >
              {busy ? "Working…" : "Upload + Register"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
