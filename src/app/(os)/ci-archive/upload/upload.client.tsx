"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/browser";

type Domain = {
  key: string;
  label: string;
};

export default function CIArchiveUpload() {
  const router = useRouter();
  const supabase = useMemo(() => supabaseBrowser(), []);

  const [entityKey, setEntityKey] = useState<string | null>(null);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [entryTypes, setEntryTypes] = useState<string[]>([]);

  const [domainKey, setDomainKey] = useState("");
  const [entryType, setEntryType] = useState("");
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  /* ---------------- auth + scope ---------------- */

  useEffect(() => {
    const boot = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        router.replace("/login");
        return;
      }

      const sp = new URLSearchParams(window.location.search);
      const ek =
        sp.get("entity_key") ||
        localStorage.getItem("oasis_entity_key") ||
        null;

      if (!ek) {
        setError("No entity scope provided.");
        return;
      }

      setEntityKey(ek);
      localStorage.setItem("oasis_entity_key", ek);
    };

    boot();
  }, [router, supabase]);

  /* ---------------- load domains + enums ---------------- */

  useEffect(() => {
    if (!entityKey) return;

    const load = async () => {
      const { data: d } = await supabase
        .from("governance_domains")
        .select("key,label")
        .eq("active", true)
        .order("sort_order");

      if (d?.length) {
        setDomains(d);
        setDomainKey(d[0].key);
      }

      const { data: e } = await supabase.rpc("enum_range", {
        enum_name: "entry_type_enum",
      });

      if (Array.isArray(e)) {
        setEntryTypes(e);
        setEntryType(e[0]);
      }
    };

    load();
  }, [entityKey, supabase]);

  /* ---------------- helpers ---------------- */

  async function sha256Hex(f: File) {
    const buf = await f.arrayBuffer();
    const hash = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /* ---------------- submit ---------------- */

  async function handleUpload() {
    setError(null);
    setInfo(null);

    if (!entityKey) return setError("Missing entity scope.");
    if (!domainKey) return setError("Domain required.");
    if (!entryType) return setError("Entry type required.");
    if (!title.trim()) return setError("Title required.");
    if (!file) return setError("PDF required.");

    setBusy(true);
    try {
      const hash = await sha256Hex(file);
      const date = new Date().toISOString().slice(0, 10);
      const safe = file.name.replace(/[^\w.\-]+/g, "_");

      const storagePath = `${entityKey}/${domainKey}/${entryType}/${date}/${hash}-${safe}`;

      const { error: upErr } = await supabase.storage
        .from("minute_book")
        .upload(storagePath, file, {
          upsert: false,
          contentType: "application/pdf",
        });

      if (upErr) throw upErr;

      const { error: rpcErr } = await supabase.rpc(
        "register_minute_book_upload",
        {
          p_entity_key: entityKey,
          p_domain_key: domainKey,
          p_entry_type: entryType,
          p_entry_date: date,
          p_title: title,
          p_notes: notes || null,
          p_primary_file_name: file.name,
          p_primary_storage_path: storagePath,
          p_primary_file_hash: hash,
          p_primary_file_size: file.size,
          p_primary_mime_type: "application/pdf",
          p_supporting: [],
        }
      );

      if (rpcErr) throw rpcErr;

      setInfo("Document registered in CI-Archive.");
      setTitle("");
      setNotes("");
      setFile(null);
    } catch (e: any) {
      setError(e.message || "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  /* ---------------- UI ---------------- */

  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      <div className="mb-4 shrink-0">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">
          CI-ARCHIVE
        </div>
        <p className="mt-1 text-[11px] text-slate-400">
          Registry Upload Console •{" "}
          <span className="font-semibold text-slate-200">
            Oasis Digital Parliament Ledger
          </span>
        </p>
      </div>

      <div className="flex-1 min-h-0 flex justify-center overflow-hidden">
        <div className="w-full max-w-[1100px] h-full rounded-3xl border border-slate-900 bg-black/60 shadow-[0_0_60px_rgba(15,23,42,0.9)] px-6 py-5 flex flex-col overflow-hidden">
          <div className="mb-4 shrink-0">
            <h1 className="text-lg font-semibold text-slate-50">
              Minute Book & Registry Upload
            </h1>
            <p className="mt-1 text-xs text-slate-400">
              Domain-driven filing · SHA-256 enforced · Ledger-linked
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Entity">
              <div className="text-sm text-slate-200">{entityKey}</div>
            </Field>

            <Field label="Domain">
              <select
                value={domainKey}
                onChange={(e) => setDomainKey(e.target.value)}
                className="input"
              >
                {domains.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Entry Type">
              <select
                value={entryType}
                onChange={(e) => setEntryType(e.target.value)}
                className="input"
              >
                {entryTypes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Title">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="input"
              />
            </Field>

            <Field label="PDF">
              <input
                type="file"
                accept="application/pdf"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="input"
              />
            </Field>

            <Field label="Notes">
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={4}
                className="input"
              />
            </Field>
          </div>

          {error && (
            <div className="mt-4 text-[11px] text-red-400 bg-red-950/40 border border-red-800/60 rounded-xl px-3 py-2">
              {error}
            </div>
          )}

          {info && (
            <div className="mt-4 text-[11px] text-emerald-300 bg-emerald-950/40 border border-emerald-700/60 rounded-xl px-3 py-2">
              {info}
            </div>
          )}

          <div className="mt-6 flex justify-end">
            <button
              onClick={handleUpload}
              disabled={busy}
              className={`rounded-full px-5 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition ${
                busy
                  ? "bg-slate-700 text-slate-400 cursor-not-allowed"
                  : "bg-yellow-500 text-black hover:bg-yellow-400"
              }`}
            >
              {busy ? "Registering…" : "Upload & Register"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-[0.25em] text-slate-500">
        {label}
      </div>
      {children}
    </div>
  );
}
