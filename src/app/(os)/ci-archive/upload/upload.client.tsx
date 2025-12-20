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

/**
 * IMPORTANT:
 * - Must match DB enum: public.entry_type_enum
 * - Do NOT include "other" (it breaks doc_section_enum downstream)
 * - Keep "filing" (we know it's valid from your minute_book_entries screenshot)
 */
const ENTRY_TYPES = [
  "filing",
  "resolution",
  "register",
  "bylaw",
  "certificate",
  "agreement",
  "supporting",
] as const;

type EntryType = (typeof ENTRY_TYPES)[number];

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

function cls(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

// ---------- component ----------
export default function UploadClient() {
  const router = useRouter();
  const sp = useSearchParams();

  // entity_key_enum comes from URL ?entity_key=holdings
  const entityKey = (sp.get("entity_key") || "holdings").toLowerCase();

  const [domains, setDomains] = useState<DomainRow[]>([]);
  const [domainKey, setDomainKey] = useState<string>("");
  const [entryType, setEntryType] = useState<EntryType>("filing");
  const [title, setTitle] = useState<string>("");
  const [notes, setNotes] = useState<string>("");

  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  // Load governance_domains (Upload contract)
  useEffect(() => {
    const load = async () => {
      setErr(null);

      const { data, error } = await supabaseBrowser
        .from("governance_domains")
        .select("key,label,sort_order,active")
        .eq("active", true)
        .order("sort_order", { ascending: true });

      if (error) {
        console.error("governance_domains load error:", error);
        setErr("Unable to load governance domains.");
        return;
      }

      const rows = (data || []) as DomainRow[];
      setDomains(rows);

      // Default domainKey to first active domain
      if (!domainKey && rows[0]?.key) {
        setDomainKey(rows[0].key);
      }
    };

    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const domainLabel = useMemo(() => {
    return domains.find((d) => d.key === domainKey)?.label || domainKey;
  }, [domains, domainKey]);

  const previewPathPattern = useMemo(() => {
    return entityKey && domainKey
      ? `${entityKey}/${domainKey}/${entryType}/YYYY-MM-DD/{sha256}-{filename}`
      : "—";
  }, [entityKey, domainKey, entryType]);

  const submit = async () => {
    if (busy) return;

    setErr(null);
    setOk(null);

    if (!entityKey) return setErr("Missing entity scope (?entity_key=holdings).");
    if (!domainKey) return setErr("Domain is required.");
    if (!file) return setErr("Choose a PDF first.");
    if (!title.trim()) return setErr("Title is required.");

    setBusy(true);

    try {
      // 1) Confirm auth
      const { data: sessionData, error: sessionErr } = await supabaseBrowser.auth.getSession();
      if (sessionErr) console.error("auth.getSession error:", sessionErr);
      if (!sessionData?.session) {
        setErr("Not signed in. Please refresh and sign in again.");
        return;
      }

      // 2) Hash
      const hash = await sha256Hex(file);

      // 3) Storage path contract
      const date = todayISO();
      const safeName = sanitizeFileName(file.name);
      const storagePath = `${entityKey}/${domainKey}/${entryType}/${date}/${hash}-${safeName}`;

      // 4) Upload to storage (idempotent)
      const uploadRes = await supabaseBrowser.storage
        .from(BUCKET_ID)
        .upload(storagePath, file, {
          contentType: file.type || "application/pdf",
          upsert: false, // evidence-first
        });

      if (uploadRes.error && !isResourceExistsError(uploadRes.error)) {
        console.error("storage upload failed:", uploadRes.error);
        setErr(`Storage upload failed: ${uploadRes.error.message}`);
        return;
      }

      // 5) Register via enterprise RPC (matches current signature)
      const payload = {
        p_entity_key: entityKey, // entity_key_enum
        p_domain_key: domainKey, // text
        p_entry_type: entryType, // entry_type_enum (must match DB)
        p_entry_date: date, // date (ISO string casts)
        p_title: title.trim(),
        p_notes: notes.trim() ? notes.trim() : null,
        p_primary_file_name: safeName,
        p_primary_storage_path: storagePath,
        p_primary_file_hash: hash,
        p_primary_file_size: file.size,
        p_primary_mime_type: file.type || "application/pdf",
        p_supporting: [], // jsonb
      };

      const { data: entryId, error: rpcErr } = await supabaseBrowser.rpc(
        "register_minute_book_upload",
        payload
      );

      if (rpcErr) {
        console.error("register_minute_book_upload failed:", rpcErr);
        setErr(`Registry RPC failed: ${rpcErr.message}`);
        return;
      }

      setOk(`Uploaded & registered successfully. Entry ID: ${String(entryId)}`);

      // reset for next upload
      setFile(null);
      setTitle("");
      setNotes("");
    } catch (e: any) {
      console.error(e);
      setErr(e?.message || "Unexpected upload error.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="os-workspace">
      <div className="max-w-6xl mx-auto w-full px-6 py-8">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-slate-100">Minute Book Upload</h1>
            <div className="mt-2 text-[12px] text-slate-400">
              Domain-driven filing • SHA-256 enforced • Writes via{" "}
              <span className="text-amber-300 font-semibold">register_minute_book_upload</span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push(`/ci-archive/minute-book?entity_key=${encodeURIComponent(entityKey)}`)}
              className="rounded-full px-4 py-2 text-[11px] uppercase tracking-[0.18em] border border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/15 transition"
            >
              Back to Registry
            </button>

            <div className="hidden md:flex items-center text-[10px] uppercase tracking-[0.3em] text-slate-500">
              CI-ARCHIVE • LIVE
            </div>
          </div>
        </div>

        {/* Alerts */}
        {(err || ok) && (
          <div className="mb-4">
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

        {/* Two-column layout */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {/* Left: Form */}
          <section className="bg-slate-950/40 border border-slate-800 rounded-2xl p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-semibold text-slate-200">Filing</div>
              <span className="px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/40 text-[10px] uppercase tracking-[0.18em] text-amber-300">
                Enterprise Contract
              </span>
            </div>

            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (!busy) submit();
              }}
            >
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label="Entity">
                  <div className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-100">
                    {entityKey}
                  </div>
                  <div className="mt-1 text-[10px] text-slate-500">
                    Open via OS with <span className="text-slate-300">?entity_key=holdings</span>
                  </div>
                </Field>

                <Field label="Domain">
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
                  <div className="mt-1 text-[10px] text-slate-500">
                    Source: <span className="text-slate-300">governance_domains</span>
                  </div>
                </Field>

                <Field label="Entry Type">
                  <select
                    value={entryType}
                    onChange={(e) => setEntryType(e.target.value as EntryType)}
                    className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 outline-none"
                  >
                    {ENTRY_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                  <div className="mt-1 text-[10px] text-slate-500">
                    Source: <span className="text-slate-300">entry_type_enum</span>
                  </div>
                </Field>

                <Field label="PDF">
                  <input
                    type="file"
                    accept="application/pdf"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 outline-none"
                  />
                  <div className="mt-1 text-[10px] text-slate-500">
                    Bucket: <span className="text-slate-300">minute_book</span>
                  </div>
                </Field>

                <div className="md:col-span-2">
                  <Field label="Title">
                    <input
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 outline-none"
                      placeholder="e.g., Corporate Profile 2025"
                    />
                  </Field>
                </div>

                <div className="md:col-span-2">
                  <Field label="Notes (optional)">
                    <textarea
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      rows={6}
                      className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 outline-none resize-none"
                      placeholder="Optional registry notes…"
                    />
                  </Field>
                </div>
              </div>

              <div className="mt-2 flex items-center justify-end gap-3">
                <button
                  type="submit"
                  disabled={busy}
                  className={cls(
                    "rounded-full px-5 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition",
                    busy
                      ? "bg-amber-500/20 text-amber-200/60 cursor-not-allowed border border-amber-500/30"
                      : "bg-amber-500 text-black hover:bg-amber-400"
                  )}
                >
                  {busy ? "Registering…" : "Upload & Register"}
                </button>
              </div>
            </form>
          </section>

          {/* Right: Preview */}
          <section className="border border-slate-800 rounded-2xl bg-slate-950/40 p-4 flex flex-col">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-200">Registry Preview</h2>
                <p className="mt-1 text-[11px] text-slate-400">
                  Exactly what will be written into{" "}
                  <span className="text-slate-200 font-semibold">minute_book_entries</span> + supporting docs.
                </p>
              </div>
              <span className="px-2 py-0.5 rounded-full bg-sky-500/10 border border-sky-500/40 text-[10px] uppercase tracking-[0.18em] text-sky-300">
                Storage Path
              </span>
            </div>

            <div className="flex-1 overflow-y-auto rounded-xl border border-slate-800 bg-slate-950/70 p-3 text-[12px] text-slate-200">
              <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500 mb-2">Selected</div>
              <div className="space-y-2">
                <Row k="Entity" v={entityKey || "—"} />
                <Row k="Domain" v={domainLabel || "—"} />
                <Row k="Entry Type" v={entryType || "—"} />
                <Row k="Title" v={title.trim() || "—"} />
                <Row k="File" v={file?.name || "—"} />
              </div>

              <div className="mt-4 text-[10px] uppercase tracking-[0.2em] text-slate-500 mb-2">
                Path Pattern
              </div>
              <div className="rounded-lg border border-slate-800 bg-black/40 px-3 py-2 text-[11px] text-slate-300">
                {previewPathPattern}
              </div>
            </div>

            <div className="mt-3 flex items-center justify-between text-[10px] text-slate-500">
              <span>CI-Archive · Oasis Digital Parliament</span>
              <span>ODP.AI · Registry Intake</span>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-semibold tracking-[0.18em] text-slate-500">
        {label.toUpperCase()}
      </div>
      {children}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="text-slate-500">{k}</div>
      <div className="text-slate-100 text-right break-all">{v}</div>
    </div>
  );
}
