"use client";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";

export default function UploadClient() {
  const supabase = useMemo(() => supabaseBrowser(), []);

  const [entityKey, setEntityKey] = useState<string | null>(null);
  const [domains, setDomains] = useState<Array<{ key: string; label: string }>>(
    []
  );
  const [entryTypes, setEntryTypes] = useState<string[]>([]);

  const [domainKey, setDomainKey] = useState("");
  const [entryType, setEntryType] = useState("");
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  /* ---------------- bootstrap ---------------- */

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const ek =
      sp.get("entity_key") ||
      localStorage.getItem("oasis_entity_key") ||
      null;

    if (ek) {
      setEntityKey(ek);
      localStorage.setItem("oasis_entity_key", ek);
    }
  }, []);

  useEffect(() => {
    async function load() {
      // domains
      const { data: d } = await supabase
        .from("governance_domains")
        .select("key,label")
        .eq("active", true)
        .order("sort_order");

      if (d?.length) {
        setDomains(d);
        setDomainKey(d[0].key);
      }

      // entry_type_enum
      const { data: e } = await supabase.rpc("enum_range", {
        enum_name: "entry_type_enum",
      });

      if (Array.isArray(e) && e.length) {
        setEntryTypes(e);
        setEntryType(e[0]);
      }
    }

    load();
  }, [supabase]);

  /* ---------------- helpers ---------------- */

  async function sha256Hex(f: File): Promise<string> {
    const buf = await f.arrayBuffer();
    const hash = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /* ---------------- submit ---------------- */

  async function submit() {
    setErr(null);
    setOk(null);

    if (!entityKey) return setErr("Missing entity scope.");
    if (!domainKey) return setErr("Domain required.");
    if (!entryType) return setErr("Entry type required.");
    if (!title.trim()) return setErr("Title required.");
    if (!file) return setErr("PDF required.");

    setBusy(true);
    try {
      const hash = await sha256Hex(file);
      const date = new Date().toISOString().slice(0, 10);
      const safe = file.name.replace(/[^\w.\-]+/g, "_");

      // canonical storage path
      const storagePath = `${entityKey}/${domainKey}/${entryType}/${date}/${hash}-${safe}`;

      // upload file
      const { error: upErr } = await supabase.storage
        .from("minute_book")
        .upload(storagePath, file, {
          upsert: false,
          contentType: "application/pdf",
        });

      if (upErr) throw upErr;

      // register via canonical SQL contract
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

      setOk("Upload registered successfully.");
      setTitle("");
      setNotes("");
      setFile(null);
    } catch (e: any) {
      setErr(e?.message ?? "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  /* ---------------- UI (intentionally plain) ---------------- */

  return (
    <div style={{ padding: 24, maxWidth: 720 }}>
      <h2>CI-Archive Upload</h2>

      {err && <p style={{ color: "red" }}>{err}</p>}
      {ok && <p style={{ color: "green" }}>{ok}</p>}

      <label>Domain</label>
      <select value={domainKey} onChange={(e) => setDomainKey(e.target.value)}>
        {domains.map((d) => (
          <option key={d.key} value={d.key}>
            {d.label}
          </option>
        ))}
      </select>

      <label>Entry Type</label>
      <select value={entryType} onChange={(e) => setEntryType(e.target.value)}>
        {entryTypes.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>

      <label>Title</label>
      <input value={title} onChange={(e) => setTitle(e.target.value)} />

      <label>Notes</label>
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />

      <label>PDF</label>
      <input
        type="file"
        accept="application/pdf"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />

      <button disabled={busy} onClick={submit}>
        {busy ? "Registering…" : "Upload & Register"}
      </button>
    </div>
  );
}
