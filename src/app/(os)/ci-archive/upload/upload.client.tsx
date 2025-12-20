"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabaseClient";

type DomainRow = {
  key: string;
  label: string | null;
  sort_order: number | null;
  active: boolean | null;
};

type EntryType = "resolution" | "register" | "bylaw" | "certificate" | "agreement" | "filing" | "supporting" | "other";

const BUCKET_ID = "minute_book";

// ---------- helpers ----------
function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function sanitizeFileName(name: string) {
  // keep it filesystem + URL safe
  return name
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^\w.\- ()]/g, "_");
}

async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const hashBuf = await crypto.subtle.digest("SHA-256", buf);
  const bytes = Array.from(new Uint8Array(hashBuf));
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isResourceExistsError(err: any) {
  const msg = String(err?.message || err || "");
  return msg.toLowerCase().includes("resource already exists");
}

// ---------- component ----------
export default function CIArchiveUploadClient() {
  const router = useRouter();
  const sp = useSearchParams();

  const entityKey = (sp.get("entity_key") || "holdings").toLowerCase(); // entity_key_enum text (holdings, lounge, real_estate)

  const [domains, setDomains] = useState<DomainRow[]>([]);
  const [domainKey, setDomainKey] = useState<string>("incorporation");
  const [entryType, setEntryType] = useState<EntryType>("filing");
  const [title, setTitle] = useState<string>("");
  const [notes, setNotes] = useState<string>("");

  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Load governance_domains (Upload contract)
  useEffect(() => {
    const load = async () => {
      setError(null);
      const { data, error } = await supabaseBrowser
        .from("governance_domains")
        .select("key,label,sort_order,active")
        .eq("active", true)
        .order("sort_order", { ascending: true });

      if (error) {
        console.error("governance_domains load error:", error);
        setError("Unable to load governance domains.");
        return;
      }

      const rows = (data || []) as DomainRow[];
      setDomains(rows);

      // If current domainKey not in list, default to first
      const keys = new Set(rows.map((r) => r.key));
      if (!keys.has(domainKey) && rows[0]?.key) {
        setDomainKey(rows[0].key);
      }
    };

    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const domainLabel = useMemo(() => {
    return domains.find((d) => d.key === domainKey)?.label || domainKey;
  }, [domains, domainKey]);

  const preview = useMemo(() => {
    const date = todayISO();
    const filename = file ? sanitizeFileName(file.name) : "{filename}";
    const hash = file ? "{sha256}" : "{sha256}";
    return {
      entityKey,
      domainKey,
      domainLabel,
      entryType,
      title: title || "(required)",
      fileName: file ? sanitizeFileName(file.name) : "(required)",
      pathPattern: `${entityKey}/${domainKey}/${entryType}/${date}/${hash}-${filename}`,
    };
  }, [entityKey, domainKey, domainLabel, entryType, title, file]);

  // Submit: Upload to storage (idempotent) -> RPC register_minute_book_upload
  const handleUpload = async () => {
    if (busy) return;

    setError(null);
    setInfo(null);

    if (!file) return setError("Choose a PDF first.");
    if (!title.trim()) return setError("Title is required.");
    if (!domainKey) return setError("Domain is required.");

    setBusy(true);

    try {
      // 1) Confirm auth is real
      const { data: sessionData, error: sessionErr } = await supabaseBrowser.auth.getSession();
      if (sessionErr) {
        console.error("auth.getSession error:", sessionErr);
      }
      if (!sessionData?.session) {
        setError("Not signed in. Please refresh and sign in again.");
        return;
      }

      // 2) Hash
      const hash = await sha256Hex(file);

      // 3) Storage path (contract)
      const date = todayISO();
      const safeName = sanitizeFileName(file.name);
      const storagePath = `${entityKey}/${domainKey}/${entryType}/${date}/${hash}-${safeName}`;

      // 4) Upload PDF to bucket (idempotent: treat exists as OK)
      const uploadRes = await supabaseBrowser.storage
        .from(BUCKET_ID)
        .upload(storagePath, file, {
          contentType: file.type || "application/pdf",
          upsert: false, // keep evidence-first; we still allow "exists" as success below
        });

      if (uploadRes.error && !isResourceExistsError(uploadRes.error)) {
        console.error("storage upload failed:", uploadRes.error);
        setError(`Storage upload failed: ${uploadRes.error.message}`);
        return;
      }

      // 5) RPC register (enterprise contract)
      const payload = {
        p_entity_key: entityKey,
        p_domain_key: domainKey,
        p_entry_type: entryType,
        p_entry_date: date, // date
        p_title: title.trim(),
        p_notes: notes?.trim() || null,
        p_primary_file_name: safeName,
        p_primary_storage_path: storagePath,
        p_primary_file_hash: hash,
        p_primary_file_size: file.size,
        p_primary_mime_type: file.type || "application/pdf",
        p_supporting: [], // future
      };

      const { data: entryId, error: rpcErr } = await supabaseBrowser.rpc("register_minute_book_upload", payload);

      if (rpcErr) {
        console.error("register_minute_book_upload failed:", rpcErr);
        setError(`Registry RPC failed: ${rpcErr.message}`);
        return;
      }

      setInfo("Uploaded and registered successfully.");

      // Optional: bounce back to registry (your OS flow)
      // router.push(`/ci-archive/minute-book?entity_key=${entityKey}`);
      // For now: keep them here so they can upload more.
      setFile(null);
      setTitle("");
      setNotes("");
    } catch (e: any) {
      console.error(e);
      setError(e?.message || "Unexpected upload error.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      {/* Header under OS bar */}
      <div className="mb-4 shrink-0">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">CI-ARCHIVE</div>
        <p className="mt-1 text-[11px] text-slate-400">
          Upload Console •{" "}
          <span className="font-semibold text-slate-200">Minute Book Registry</span>
        </p>
      </div>

      {/* Main Window – council frame */}
      <div className="flex-1 min-h-0 flex justify-center overflow-hidden">
        <div className="w-full max-w-[1400px] h-full rounded-3xl border border-slate-900 bg-black/60 shadow-[0_0_60px_rgba(15,23,42,0.9)] px-6 py-5 flex flex-col overflow-hidden">
          {/* Window title row */}
          <div className="flex items-start justify-between mb-4 shrink-0">
            <div>
              <h1 className="text-lg font-semibold text-slate-50">Minute Book Upload</h1>
              <p className="mt-1 text-xs text-slate-400">
                Domain-driven filing • SHA-256 enforced • Writes via{" "}
                <span className="font-semibold text-amber-300">register_minute_book_upload</span>
              </p>
            </div>

            <div className="flex items-center gap-3">
              <div className="hidden md:flex items-center text-[10px] uppercase tracking-[0.3em] text-slate-500">
                CI-ARCHIVE • LIVE
              </div>

              <button
                type="button"
                onClick={() => router.push(`/ci-archive/minute-book?entity_key=${entityKey}`)}
                className="rounded-full px-3 py-1.5 text-[11px] font-semibold tracking-[0.18em] uppercase border border-amber-500/40 text-amber-300 hover:bg-amber-500/10 transition"
              >
                Back to Registry
              </button>
            </div>
          </div>

          {error && (
            <div className="mb-4 text-[11px] text-red-300 bg-red-950/40 border border-red-800/60 rounded-xl px-3 py-2">
              {error}
            </div>
          )}

          {info && !error && (
            <div className="mb-4 text-[11px] text-emerald-300 bg-emerald-950/40 border border-emerald-700/60 rounded-xl px-3 py-2">
              {info}
            </div>
          )}

          {/* TWO-COLUMN LAYOUT */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 flex-1 min-h-0">
            {/* LEFT – Filing */}
            <section className="border border-slate-800 rounded-2xl bg-slate-950/40 p-4 flex flex-col min-h-0">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-semibold text-slate-200">Filing</div>
                <span className="px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/40 text-[10px] uppercase tracking-[0.18em] text-amber-300">
                  Enterprise Contract
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Entity */}
                <div>
                  <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500 mb-1">Entity</div>
                  <input
                    value={entityKey}
                    readOnly
                    className="w-full rounded-xl bg-slate-950/70 border border-slate-800 px-3 py-2 text-sm text-slate-100"
                  />
                  <div className="mt-1 text-[11px] text-slate-500">
                    Open via OS with <span className="text-slate-300">?entity_key={entityKey}</span>
                  </div>
                </div>

                {/* Domain */}
                <div>
                  <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500 mb-1">Domain</div>
                  <select
                    value={domainKey}
                    onChange={(e) => setDomainKey(e.target.value)}
                    className="w-full rounded-xl bg-slate-950/70 border border-slate-800 px-3 py-2 text-sm text-slate-100"
                  >
                    {domains.map((d) => (
                      <option key={d.key} value={d.key}>
                        {d.label || d.key}
                      </option>
                    ))}
                  </select>
                  <div className="mt-1 text-[11px] text-slate-500">
                    Source: <span className="text-slate-300">governance_domains</span>
                  </div>
                </div>

                {/* Entry type */}
                <div>
                  <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500 mb-1">Entry Type</div>
                  <select
                    value={entryType}
                    onChange={(e) => setEntryType(e.target.value as EntryType)}
                    className="w-full rounded-xl bg-slate-950/70 border border-slate-800 px-3 py-2 text-sm text-slate-100"
                  >
                    <option value="resolution">resolution</option>
                    <option value="register">register</option>
                    <option value="bylaw">bylaw</option>
                    <option value="certificate">certificate</option>
                    <option value="agreement">agreement</option>
                    <option value="filing">filing</option>
                    <option value="supporting">supporting</option>
                    <option value="other">other</option>
                  </select>
                  <div className="mt-1 text-[11px] text-slate-500">
                    Source: <span className="text-slate-300">entry_type_enum</span>
                  </div>
                </div>

                {/* PDF */}
                <div>
                  <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500 mb-1">PDF</div>
                  <input
                    type="file"
                    accept="application/pdf"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    className="w-full rounded-xl bg-slate-950/70 border border-slate-800 px-3 py-2 text-sm text-slate-100"
                  />
                  <div className="mt-1 text-[11px] text-slate-500">
                    Bucket: <span className="text-slate-300">{BUCKET_ID}</span>
                  </div>
                </div>
              </div>

              {/* Title */}
              <div className="mt-4">
                <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500 mb-1">Title</div>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g., Articles of Incorporation"
                  className="w-full rounded-xl bg-slate-950/70 border border-slate-800 px-3 py-2 text-sm text-slate-100"
                />
              </div>

              {/* Notes */}
              <div className="mt-4 flex-1 min-h-0 flex flex-col">
                <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500 mb-1">Notes (Optional)</div>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Optional registry notes…"
                  className="flex-1 min-h-[140px] rounded-xl bg-slate-950/70 border border-slate-800 px-3 py-2 text-sm text-slate-100 resize-none"
                />
              </div>

              <div className="mt-4">
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleUpload}
                  className={`w-full rounded-full px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition ${
                    busy ? "bg-amber-500/20 text-amber-200/60 cursor-not-allowed" : "bg-amber-500 text-black hover:bg-amber-400"
                  }`}
                >
                  {busy ? "UPLOADING…" : "UPLOAD & REGISTER"}
                </button>
              </div>
            </section>

            {/* RIGHT – Preview */}
            <section className="border border-slate-800 rounded-2xl bg-slate-950/40 p-4 flex flex-col min-h-0">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h2 className="text-sm font-semibold text-slate-200">Registry Preview</h2>
                  <p className="mt-1 text-[11px] text-slate-400">
                    Exactly what will be written into{" "}
                    <span className="font-semibold text-slate-200">minute_book_entries</span> + supporting docs.
                  </p>
                </div>
                <span className="px-2 py-0.5 rounded-full bg-sky-500/10 border border-sky-500/40 text-[10px] uppercase tracking-[0.18em] text-sky-300">
                  Storage Path
                </span>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4 text-[11px] text-slate-300">
                <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500 mb-3">Selected</div>

                <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                  <div className="text-slate-500">Entity</div>
                  <div className="text-slate-200 text-right">{preview.entityKey}</div>

                  <div className="text-slate-500">Domain</div>
                  <div className="text-slate-200 text-right">{preview.domainLabel}</div>

                  <div className="text-slate-500">Entry Type</div>
                  <div className="text-slate-200 text-right">{preview.entryType}</div>

                  <div className="text-slate-500">Title</div>
                  <div className="text-slate-200 text-right">{preview.title}</div>

                  <div className="text-slate-500">File</div>
                  <div className="text-slate-200 text-right">{preview.fileName}</div>
                </div>

                <div className="mt-4 text-[10px] uppercase tracking-[0.2em] text-slate-500">Path Pattern</div>
                <div className="mt-1 rounded-lg border border-slate-800 bg-black/40 px-3 py-2 font-mono text-[11px] text-slate-200 break-all">
                  {preview.pathPattern}
                </div>
              </div>

              <div className="mt-auto pt-3 flex items-center justify-between text-[10px] text-slate-500">
                <span>CI-Archive · Oasis Digital Parliament</span>
                <span>ODP.AI · Registry Intake</span>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
