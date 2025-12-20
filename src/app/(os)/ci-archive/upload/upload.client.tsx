"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { useEntity } from "@/components/OsEntityContext";

export const dynamic = "force-dynamic";

type Domain = { key: string; label: string };

const BUCKET_ID = "minute_book";
const MIME_PDF = "application/pdf";

/** ---------- helpers ---------- */
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function sanitizeFileName(name: string) {
  // keep it URL/storage safe + predictable
  const base = name.trim().replace(/\s+/g, "_");
  return base.replace(/[^a-zA-Z0-9._-]/g, "");
}

async function sha256Hex(file: File) {
  const buf = await file.arrayBuffer();
  const hashBuf = await crypto.subtle.digest("SHA-256", buf);
  const bytes = Array.from(new Uint8Array(hashBuf));
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isResourceExistsError(err: any) {
  // Supabase Storage typically returns status 409 / "The resource already exists"
  const msg = String(err?.message || "").toLowerCase();
  return msg.includes("already exists") || msg.includes("exists") || err?.statusCode === "409";
}

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">{label}</div>
      <div className="mt-2">{children}</div>
      {hint ? <div className="mt-1 text-[10px] text-slate-500">{hint}</div> : null}
    </div>
  );
}

export default function UploadClient({ initialEntityKey }: { initialEntityKey: string | null }) {
  const router = useRouter();
  const supabase = useMemo(() => supabaseBrowser(), []);
  const { activeEntity } = useEntity();

  // entity scope: query param (server) wins, otherwise OS context
  const entityKey = (initialEntityKey || activeEntity || "").toLowerCase();

  const [domains, setDomains] = useState<Domain[]>([]);
  const [entryTypes, setEntryTypes] = useState<string[]>([]);

  const [domainKey, setDomainKey] = useState("");
  const [entryType, setEntryType] = useState("");
  const [entryDate, setEntryDate] = useState(todayISO());
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  // Load domains + entry types (enterprise: DB is source of truth)
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setErr(null);

      try {
        // Domains
        const dRes = await supabase
          .from("governance_domains")
          .select("key,label")
          .eq("active", true)
          .order("sort_order", { ascending: true });

        if (!cancelled && dRes.data) {
          setDomains(dRes.data as Domain[]);
          if (!domainKey && dRes.data.length) setDomainKey(String(dRes.data[0].key));
        }

        // Entry types (from your defaults table; fallback to enum-like list if empty)
        const tRes = await supabase
          .from("entry_type_section_defaults")
          .select("entry_type")
          .order("entry_type", { ascending: true });

        const types = Array.from(
          new Set((tRes.data || []).map((r: any) => String(r.entry_type)))
        ).filter(Boolean);

        if (!cancelled) {
          setEntryTypes(types.length ? types : ["filing", "bylaws", "resolution", "registers", "annual_returns"]);
          if (!entryType) setEntryType((types[0] || "filing").toString());
        }
      } catch (e: any) {
        if (!cancelled) setErr(e?.message || "Failed to load filing metadata.");
      }
    }

    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase]);

  const domainLabel = useMemo(() => {
    return domains.find((d) => d.key === domainKey)?.label || domainKey || "—";
  }, [domains, domainKey]);

  const storagePreview = useMemo(() => {
    if (!entityKey || !domainKey || !entryType) return "—";
    return `${entityKey}/${domainKey}/${entryType}/${entryDate}/{sha256}-${file ? sanitizeFileName(file.name) : "filename.pdf"}`;
  }, [entityKey, domainKey, entryType, entryDate, file]);

  async function submit() {
    setErr(null);
    setOk(null);

    if (!entityKey) return setErr("Missing entity scope. Select an entity in the OS bar.");
    if (!domainKey) return setErr("Domain is required.");
    if (!entryType) return setErr("Entry Type is required.");
    if (!entryDate) return setErr("Entry Date is required.");
    if (!title.trim()) return setErr("Title is required.");
    if (!file) return setErr("PDF is required.");
    if (file.type && file.type !== MIME_PDF) return setErr("File must be a PDF.");

    setBusy(true);

    try {
      // 0) session sanity (prevents “looks logged in but isn’t hydrated”)
      const { data: sess } = await supabase.auth.getSession();
      if (!sess?.session) throw new Error("Not signed in. Refresh and sign in again.");

      // 1) hash
      const hash = await sha256Hex(file);

      // 2) build storage path (canonical)
      const safeName = sanitizeFileName(file.name);
      const storagePath = `${entityKey}/${domainKey}/${entryType}/${entryDate}/${hash}-${safeName}`;

      // 3) upload to Storage (treat "exists" as OK)
      const up = await supabase.storage.from(BUCKET_ID).upload(storagePath, file, {
        contentType: MIME_PDF,
        upsert: false,
        cacheControl: "3600",
      });

      if (up.error && !isResourceExistsError(up.error)) {
        throw new Error(`Storage upload failed: ${up.error.message}`);
      }

      // 4) register via SQL contract (THIS must match your function)
      const payload = {
        p_entity_key: entityKey,
        p_domain_key: domainKey,
        p_entry_type: entryType,
        p_entry_date: entryDate,
        p_title: title.trim(),
        p_notes: notes.trim() ? notes.trim() : null,
        p_file_name: file.name, // keep original display name
        p_storage_path: storagePath,
        p_pdf_hash: hash,
        p_file_size: file.size,
        p_mime_type: MIME_PDF,
        p_supporting: [], // jsonb (future)
      };

      const { data: entryId, error: rpcErr } = await supabase.rpc("register_minute_book_upload", payload);

      if (rpcErr) throw new Error(`Registry RPC failed: ${rpcErr.message}`);

      setOk(`Registered successfully: ${String(entryId)}`);
      // reset
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
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      {/* Header under OS bar */}
      <div className="mb-4 shrink-0">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">CI-ARCHIVE</div>
        <p className="mt-1 text-[11px] text-slate-400">
          Registry Upload Console •{" "}
          <span className="font-semibold text-slate-200">Minute Book & Supporting Docs</span>
        </p>
      </div>

      {/* Main Window – same frame style as CI-Council */}
      <div className="flex-1 min-h-0 flex justify-center overflow-hidden">
        <div className="w-full max-w-[1400px] h-full rounded-3xl border border-slate-900 bg-black/60 shadow-[0_0_60px_rgba(15,23,42,0.9)] px-6 py-5 flex flex-col overflow-hidden">
          {/* Window Title */}
          <div className="flex items-start justify-between mb-4 shrink-0">
            <div>
              <h1 className="text-lg font-semibold text-slate-50">Minute Book & Registry Upload</h1>
              <p className="mt-1 text-xs text-slate-400">
                Domain-driven filing • SHA-256 enforced • Writes via{" "}
                <span className="font-semibold text-amber-300">register_minute_book_upload</span>
              </p>
            </div>

            <div className="hidden md:flex items-center gap-2 text-[10px] uppercase tracking-[0.3em] text-slate-500">
              CI-ARCHIVE • LIVE
            </div>
          </div>

          {/* Alerts */}
          {(err || ok) && (
            <div className="mb-4 shrink-0">
              {err ? (
                <div className="rounded-2xl border border-red-800/60 bg-red-950/40 px-4 py-3 text-[12px] text-red-200">
                  {err}
                </div>
              ) : null}
              {ok ? (
                <div className="mt-2 rounded-2xl border border-emerald-700/60 bg-emerald-950/40 px-4 py-3 text-[12px] text-emerald-200">
                  {ok}
                </div>
              ) : null}
            </div>
          )}

          {/* TWO-COLUMN LAYOUT (Council-style) */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 flex-1 min-h-0">
            {/* LEFT – Filing Form */}
            <section className="bg-slate-950/40 border border-slate-800 rounded-2xl p-4 flex flex-col min-h-0">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-semibold text-slate-200">Filing</div>
                <span className="px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/40 text-[10px] uppercase tracking-[0.18em] text-amber-300">
                  Enterprise Contract
                </span>
              </div>

              <form
                className="flex-1 min-h-0 flex flex-col"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!busy) submit();
                }}
              >
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Field
                    label="Entity"
                    hint={
                      <>
                        Must match <span className="text-slate-300">entity_companies.key</span> (e.g. holdings)
                      </>
                    }
                  >
                    <div className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-100">
                      {entityKey || <span className="text-red-300">Missing entity scope</span>}
                    </div>
                  </Field>

                  <Field label="Domain" hint={<>Source: <span className="text-slate-300">governance_domains</span></>}>
                    <select
                      value={domainKey}
                      onChange={(e) => setDomainKey(e.target.value)}
                      className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 outline-none"
                    >
                      <option value="" disabled>
                        Select…
                      </option>
                      {domains.map((d) => (
                        <option key={d.key} value={d.key}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  </Field>

                  <Field label="Entry Type" hint={<>Source: <span className="text-slate-300">entry_type_section_defaults</span></>}>
                    <select
                      value={entryType}
                      onChange={(e) => setEntryType(e.target.value)}
                      className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 outline-none"
                    >
                      {entryTypes.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </Field>

                  <Field label="Entry Date">
                    <input
                      type="date"
                      value={entryDate}
                      onChange={(e) => setEntryDate(e.target.value)}
                      className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 outline-none"
                    />
                  </Field>

                  <div className="md:col-span-2">
                    <Field label="Title">
                      <input
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="Articles of Incorporation"
                        className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 outline-none"
                      />
                    </Field>
                  </div>

                  <div className="md:col-span-2">
                    <Field label="Notes (optional)">
                      <textarea
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        placeholder="Optional registry notes…"
                        className="w-full min-h-[90px] rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 outline-none"
                      />
                    </Field>
                  </div>

                  <div className="md:col-span-2">
                    <Field label="PDF (required)">
                      <input
                        type="file"
                        accept="application/pdf"
                        onChange={(e) => setFile(e.target.files?.[0] || null)}
                        className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-200"
                      />
                      <div className="mt-1 text-[10px] text-slate-500">
                        Bucket: <span className="text-slate-300">{BUCKET_ID}</span>
                      </div>
                    </Field>
                  </div>
                </div>

                <div className="mt-4 flex items-center gap-2">
                  <button
                    type="submit"
                    disabled={busy}
                    className="inline-flex items-center justify-center rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-2 text-sm font-medium text-amber-200 hover:bg-amber-400/15 disabled:opacity-60"
                  >
                    {busy ? "Uploading…" : "Upload & Register"}
                  </button>

                  <Link
                    href={`/ci-archive/minute-book?entity_key=${encodeURIComponent(entityKey || "holdings")}`}
                    className="inline-flex items-center justify-center rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/80 hover:bg-white/10"
                  >
                    Back to Registry
                  </Link>
                </div>

                <div className="mt-3 text-[10px] text-slate-500">
                  Upload is the sole write entry point. Registry remains OS-native and read-only.
                </div>
              </form>
            </section>

            {/* RIGHT – Registry Preview (what will be written) */}
            <section className="bg-slate-950/40 border border-slate-800 rounded-2xl p-4 flex flex-col min-h-0">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-semibold text-slate-200">Registry Preview</div>
                <span className="px-2 py-0.5 rounded-full bg-slate-800/50 border border-slate-700 text-[10px] uppercase tracking-[0.18em] text-slate-300">
                  write-set
                </span>
              </div>

              <div className="flex-1 min-h-0 overflow-auto rounded-xl border border-slate-800/80 bg-slate-950/60 p-3">
                <div className="text-[11px] text-slate-400">Storage Path</div>
                <div className="mt-1 font-mono text-[11px] text-slate-200 break-all">{storagePreview}</div>

                <div className="mt-4 grid grid-cols-2 gap-3 text-[11px]">
                  <div>
                    <div className="text-slate-500">Entity</div>
                    <div className="text-slate-200">{entityKey || "—"}</div>
                  </div>

                  <div>
                    <div className="text-slate-500">Domain</div>
                    <div className="text-slate-200">{domainKey ? `${domainKey} (${domainLabel})` : "—"}</div>
                  </div>

                  <div>
                    <div className="text-slate-500">Entry Type</div>
                    <div className="text-slate-200">{entryType || "—"}</div>
                  </div>

                  <div>
                    <div className="text-slate-500">Entry Date</div>
                    <div className="text-slate-200">{entryDate || "—"}</div>
                  </div>

                  <div className="col-span-2">
                    <div className="text-slate-500">Title</div>
                    <div className="text-slate-200">{title || "—"}</div>
                  </div>

                  <div className="col-span-2">
                    <div className="text-slate-500">File</div>
                    <div className="text-slate-200">{file?.name || "—"}</div>
                  </div>

                  <div className="col-span-2">
                    <div className="text-slate-500">SHA-256</div>
                    <div className="text-slate-400">Computed client-side at upload time (mandatory)</div>
                  </div>
                </div>

                <div className="mt-4 text-[10px] text-slate-500">
                  Writes to <span className="text-slate-300">minute_book_entries</span> and supporting docs (future) via one canonical RPC.
                </div>
              </div>

              <div className="mt-3 flex items-center justify-between text-[10px] text-slate-500">
                <span>CI-Archive · contract-driven · evidence-first</span>
                <span>Oasis Digital Parliament</span>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
