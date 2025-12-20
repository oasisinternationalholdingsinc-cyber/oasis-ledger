"use client";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";

type DomainRow = { key: string; label: string };

function cls(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function readEntityKeyFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const sp = new URLSearchParams(window.location.search);
  return sp.get("entity_key") || sp.get("entityKey") || sp.get("entity");
}

async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function safeFileName(name: string) {
  return name.replace(/[^\w.\-]+/g, "_");
}

export default function UploadClient() {
  const supabase = useMemo(() => supabaseBrowser(), []);

  // scope
  const [entityKey, setEntityKey] = useState<string | null>(null);

  // options
  const [domains, setDomains] = useState<DomainRow[]>([]);
  const ENTRY_TYPES = useMemo(
    () =>
      [
        "resolution",
        "register",
        "bylaw",
        "certificate",
        "agreement",
        "filing",
        "supporting",
        "other",
      ] as const,
    []
  );

  // form
  const [domainKey, setDomainKey] = useState<string>("");
  const [entryType, setEntryType] =
    useState<(typeof ENTRY_TYPES)[number]>("filing");
  const [title, setTitle] = useState<string>("");
  const [notes, setNotes] = useState<string>("");
  const [file, setFile] = useState<File | null>(null);

  // state
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  // ---------- bootstrap entity scope ----------
  useEffect(() => {
    const fromUrl = readEntityKeyFromUrl();
    if (fromUrl) {
      const norm = String(fromUrl).trim().toLowerCase();
      setEntityKey(norm);
      try {
        localStorage.setItem("oasis_entity_key", norm);
      } catch {}
      return;
    }
    try {
      const saved = localStorage.getItem("oasis_entity_key");
      if (saved) setEntityKey(String(saved).trim().toLowerCase());
    } catch {}
  }, []);

  // ---------- load domains ----------
  useEffect(() => {
    let alive = true;

    async function loadDomains() {
      setErr(null);
      const { data, error } = await supabase
        .from("governance_domains")
        .select("key,label")
        .eq("active", true)
        .order("sort_order", { ascending: true });

      if (!alive) return;

      if (error) {
        setDomains([]);
        setDomainKey("");
        setErr(`Unable to load governance domains: ${error.message}`);
        return;
      }

      const rows = (data ?? []) as DomainRow[];
      setDomains(rows);
      setDomainKey((prev) => prev || rows[0]?.key || "");
    }

    loadDomains();
    return () => {
      alive = false;
    };
  }, [supabase]);

  // ---------- submit ----------
  async function submit() {
    setErr(null);
    setOk(null);

    if (!entityKey)
      return setErr(
        "Missing entity scope. Open from OS with ?entity_key=holdings"
      );
    if (!domainKey) return setErr("Domain is required.");
    if (!entryType) return setErr("Entry type is required.");
    if (!title.trim()) return setErr("Title is required.");
    if (!file) return setErr("PDF is required.");

    setBusy(true);
    try {
      // 0) sanity: ensure user session exists (prevents confusing RLS results)
      const { data: sess } = await supabase.auth.getSession();
      if (!sess?.session) {
        throw new Error("Not signed in. Please log in again and retry upload.");
      }

      // 1) compute hash
      const hash = await sha256Hex(file);

      // 2) build path (domain-driven, stable)
      const date = new Date().toISOString().slice(0, 10);
      const safe = safeFileName(file.name);
      const storagePath = `${entityKey}/${domainKey}/${entryType}/${date}/${hash}-${safe}`;

      // 3) upload file to minute_book bucket
      const { error: upErr } = await supabase.storage
        .from("minute_book")
        .upload(storagePath, file, {
          upsert: false,
          contentType: "application/pdf",
          cacheControl: "3600",
        });

      if (upErr) throw new Error(`Storage upload failed: ${upErr.message}`);

      // 4) register via canonical SQL contract (entity_key overload)
      // IMPORTANT: we pass entryType values that exist in entry_type_enum (NO manual_upload)
      const { data: entryId, error: rpcErr } = await supabase.rpc(
        "register_minute_book_upload",
        {
          p_entity_key: entityKey, // casts to entity_key_enum
          p_domain_key: domainKey,
          p_entry_type: entryType, // casts to entry_type_enum
          p_entry_date: date,
          p_title: title.trim(),
          p_notes: notes?.trim() ? notes.trim() : null,
          p_primary_file_name: file.name,
          p_primary_storage_path: storagePath,
          p_primary_file_hash: hash,
          p_primary_file_size: file.size,
          p_primary_mime_type: "application/pdf",
          p_supporting: [],
        }
      );

      if (rpcErr) {
        // If registration fails, the file is already in storage.
        // That’s OK — we can clean storage after the fact if needed.
        throw new Error(`Registry RPC failed: ${rpcErr.message}`);
      }

      setOk(`Registered: ${String(entryId ?? "")}`.trim());
      setTitle("");
      setNotes("");
      setFile(null);
    } catch (e: any) {
      setErr(e?.message || "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  // ---------- UI ----------
  const domainLabel =
    domains.find((d) => d.key === domainKey)?.label ?? domainKey;

  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      {/* Header under OS bar */}
      <div className="mb-4 shrink-0">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">
          CI-ARCHIVE
        </div>
        <p className="mt-1 text-[11px] text-slate-400">
          Upload Console •{" "}
          <span className="font-semibold text-slate-200">
            Minute Book Registry
          </span>
        </p>
      </div>

      {/* Main Window */}
      <div className="flex-1 min-h-0 flex justify-center overflow-hidden">
        <div className="w-full max-w-[1400px] h-full rounded-3xl border border-slate-900 bg-black/60 shadow-[0_0_60px_rgba(15,23,42,0.9)] px-6 py-5 flex flex-col overflow-hidden">
          {/* Window Title */}
          <div className="flex items-start justify-between mb-4 shrink-0">
            <div>
              <h1 className="text-lg font-semibold text-slate-50">
                Minute Book Upload
              </h1>
              <p className="mt-1 text-xs text-slate-400">
                Domain-driven filing • SHA-256 enforced • Writes via{" "}
                <span className="font-semibold text-amber-300">
                  register_minute_book_upload
                </span>
              </p>
            </div>
            <div className="hidden md:flex items-center text-[10px] uppercase tracking-[0.3em] text-slate-500">
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

          {/* TWO-COLUMN LAYOUT */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 flex-1 min-h-0">
            {/* LEFT – Form */}
            <section className="bg-slate-950/40 border border-slate-800 rounded-2xl p-4 flex flex-col min-h-0">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-semibold text-slate-200">
                  Filing
                </div>
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
                  <Field label="Entity">
                    <div className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-100">
                      {entityKey ?? (
                        <span className="text-red-300">
                          Missing entity scope
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-[10px] text-slate-500">
                      Open via OS with{" "}
                      <span className="text-slate-300">
                        ?entity_key=holdings
                      </span>
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
                      Source:{" "}
                      <span className="text-slate-300">governance_domains</span>
                    </div>
                  </Field>

                  <Field label="Entry Type">
                    <select
                      value={entryType}
                      onChange={(e) => setEntryType(e.target.value as any)}
                      className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 outline-none"
                    >
                      {ENTRY_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                    <div className="mt-1 text-[10px] text-slate-500">
                      Source:{" "}
                      <span className="text-slate-300">entry_type_enum</span>
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
                      Bucket:{" "}
                      <span className="text-slate-300">minute_book</span>
                    </div>
                  </Field>

                  <div className="md:col-span-2">
                    <Field label="Title">
                      <input
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 outline-none"
                        placeholder="e.g., Articles of Incorporation"
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

                <div className="mt-4 flex items-center justify-end gap-3">
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

            {/* RIGHT – Preview */}
            <section className="border border-slate-800 rounded-2xl bg-slate-950/40 p-4 flex flex-col min-h-0">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h2 className="text-sm font-semibold text-slate-200">
                    Registry Preview
                  </h2>
                  <p className="mt-1 text-[11px] text-slate-400">
                    Exactly what will be written into{" "}
                    <span className="text-slate-200 font-semibold">
                      minute_book_entries
                    </span>{" "}
                    + supporting docs.
                  </p>
                </div>
                <span className="px-2 py-0.5 rounded-full bg-sky-500/10 border border-sky-500/40 text-[10px] uppercase tracking-[0.18em] text-sky-300">
                  Storage Path
                </span>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto rounded-xl border border-slate-800 bg-slate-950/70 p-3 text-[12px] text-slate-200">
                <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500 mb-2">
                  Selected
                </div>
                <div className="space-y-2">
                  <Row k="Entity" v={entityKey ?? "—"} />
                  <Row k="Domain" v={domainLabel || "—"} />
                  <Row k="Entry Type" v={entryType || "—"} />
                  <Row k="Title" v={title?.trim() || "—"} />
                  <Row k="File" v={file?.name || "—"} />
                </div>

                <div className="mt-4 text-[10px] uppercase tracking-[0.2em] text-slate-500 mb-2">
                  Path Pattern
                </div>
                <div className="rounded-lg border border-slate-800 bg-black/40 px-3 py-2 text-[11px] text-slate-300">
                  {entityKey
                    ? `${entityKey}/${domainKey || "domain"}/${entryType || "type"}/YYYY-MM-DD/{sha256}-{filename}`
                    : "—"}
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
