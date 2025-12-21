"use client";

export const dynamic = "force-dynamic";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  UploadCloud,
  ShieldCheck,
  Hash,
  FileText,
  AlertTriangle,
} from "lucide-react";

import { supabaseBrowser } from "@/lib/supabase/browser";
import { useEntity } from "@/components/OsEntityContext";

/* ---------------- helpers ---------------- */

function cx(...v: any[]) {
  return v.filter(Boolean).join(" ");
}

function ymd(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function safe(name: string) {
  return name.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9._-]/g, "");
}

async function sha256(file: File) {
  const buf = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* ---------------- component ---------------- */

export default function UploadClient() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const { entityKey } = useEntity();

  const fileRef = useRef<HTMLInputElement | null>(null);

  const [domainKey, setDomainKey] = useState("incorporation");
  const [entryType, setEntryType] = useState("filing");
  const [entryDate, setEntryDate] = useState(ymd());

  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");

  const [file, setFile] = useState<File | null>(null);
  const [hash, setHash] = useState<string>("");

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const preview = useMemo(() => {
    if (!file || !hash || !title) return null;
    const clean = safe(file.name);
    return {
      path: `${entityKey}/${domainKey}/${entryType}/${entryDate}/${hash}-${clean}`,
      name: clean,
      size: file.size,
      type: file.type || "application/pdf",
    };
  }, [file, hash, title, entityKey, domainKey, entryType, entryDate]);

  async function pick(f: File | null) {
    setErr(null);
    setOk(null);
    setFile(null);
    setHash("");

    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".pdf")) {
      setErr("PDF required");
      return;
    }

    setFile(f);
    const h = await sha256(f);
    setHash(h);

    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ""));
  }

  async function submit() {
    if (!preview || !file) return;
    setBusy(true);
    setErr(null);

    try {
      // STORAGE (unchanged)
      const up = await supabase.storage
        .from("minute_book")
        .upload(preview.path, file, {
          upsert: false,
          contentType: preview.type,
        });

      if (up.error && !up.error.message.includes("exists")) {
        throw up.error;
      }

      // RPC (unchanged)
      const rpc = await supabase.rpc("register_minute_book_upload", {
        p_entity_key: entityKey,
        p_domain_key: domainKey,
        p_entry_type: entryType,
        p_entry_date: entryDate,
        p_title: title,
        p_notes: notes || null,
        p_file_name: preview.name,
        p_storage_path: preview.path,
        p_pdf_hash: hash,
        p_file_size: preview.size,
        p_mime_type: preview.type,
        p_supporting: null,
      });

      if (rpc.error) throw rpc.error;

      setOk("Filed into Minute Book");
      setTitle("");
      setNotes("");
      setFile(null);
      setHash("");
      if (fileRef.current) fileRef.current.value = "";
    } catch (e: any) {
      setErr(e.message ?? "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  /* ---------------- layout ---------------- */

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      {/* HEADER — locked */}
      <div className="shrink-0 px-6 py-4 border-b border-slate-800 bg-slate-950/80">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-slate-100">
              Minute Book Filing
            </h1>
            <div className="mt-1 text-xs text-slate-400 flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-emerald-300" />
              Enterprise Contract • SHA-256 enforced
            </div>
          </div>

          <button
            onClick={submit}
            disabled={!preview || busy}
            className={cx(
              "rounded-xl px-4 py-2 text-sm font-semibold",
              preview && !busy
                ? "bg-amber-500 text-black hover:bg-amber-400"
                : "bg-slate-800 text-slate-400"
            )}
          >
            {busy ? "Filing…" : "File into Minute Book"}
          </button>
        </div>
      </div>

      {/* CONSOLE — locked height */}
      <div className="flex-1 min-h-0 overflow-hidden px-6 py-4">
        <div className="h-full min-h-0 grid grid-cols-12 gap-4">
          {/* LEFT — taxonomy */}
          <div className="col-span-3 min-h-0 overflow-y-auto rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
            <div className="text-xs uppercase tracking-wider text-slate-400">
              Filing Context
            </div>

            <div className="mt-4 text-sm text-slate-200">
              Entity
              <div className="mt-1 text-slate-400">{entityKey}</div>
            </div>

            <div className="mt-4">
              <label className="text-xs text-slate-400">Domain</label>
              <input
                value={domainKey}
                onChange={(e) => setDomainKey(e.target.value)}
                className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-800 px-2 py-1 text-sm"
              />
            </div>

            <div className="mt-4">
              <label className="text-xs text-slate-400">Entry Type</label>
              <input
                value={entryType}
                onChange={(e) => setEntryType(e.target.value)}
                className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-800 px-2 py-1 text-sm"
              />
            </div>

            <div className="mt-4">
              <label className="text-xs text-slate-400">Date</label>
              <input
                type="date"
                value={entryDate}
                onChange={(e) => setEntryDate(e.target.value)}
                className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-800 px-2 py-1 text-sm"
              />
            </div>
          </div>

          {/* MIDDLE — action */}
          <div className="col-span-5 min-h-0 overflow-y-auto rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
            <div className="text-xs uppercase tracking-wider text-slate-400">
              Filing Payload
            </div>

            {err && (
              <div className="mt-3 text-sm text-red-300 flex gap-2">
                <AlertTriangle className="h-4 w-4" /> {err}
              </div>
            )}

            {ok && (
              <div className="mt-3 text-sm text-emerald-300">
                {ok}
              </div>
            )}

            <div className="mt-4">
              <label className="text-xs text-slate-400">Title</label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-800 px-2 py-1 text-sm"
              />
            </div>

            <div className="mt-4">
              <label className="text-xs text-slate-400">Notes</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={4}
                className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-800 px-2 py-1 text-sm"
              />
            </div>

            <div className="mt-4">
              <input
                ref={fileRef}
                type="file"
                accept="application/pdf"
                onChange={(e) => pick(e.target.files?.[0] ?? null)}
              />
            </div>
          </div>

          {/* RIGHT — projection */}
          <div className="col-span-4 min-h-0 overflow-y-auto rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
            <div className="text-xs uppercase tracking-wider text-slate-400">
              Registry Projection
            </div>

            <div className="mt-4 text-xs text-slate-500">
              Storage Path
            </div>
            <div className="mt-1 text-xs font-mono break-all text-slate-300">
              {preview?.path ?? "—"}
            </div>

            <div className="mt-4 flex items-center gap-2 text-xs text-slate-400">
              <Hash className="h-4 w-4 text-emerald-300" />
              SHA-256 enforced
            </div>

            <div className="mt-2 text-xs font-mono text-slate-300">
              {hash ? `${hash.slice(0, 20)}…` : "—"}
            </div>

            <div className="mt-4 text-xs text-slate-500">
              This exact projection is what the registry will display.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
