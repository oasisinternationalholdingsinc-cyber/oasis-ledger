"use client";

export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabaseClient";

/**
 * CI-Archive Upload (Enterprise)
 * - Domain-driven filing (governance_domains)
 * - SHA-256 mandatory
 * - Storage path: {entity_key}/{domain_key}/{entry_type}/{YYYY-MM-DD}/{sha256}-{filename}
 * - Registry write: public.register_minute_book_upload(...)
 */

type DomainRow = {
  key: string;
  label: string;
  description?: string | null;
  sort_order?: number | null;
  active?: boolean | null;
};

type EntryTypeRow = {
  entry_type: string;
  default_section?: string | null;
  notes?: string | null;
};

type SupportingItem = {
  file_name: string;
  storage_path: string;
  file_hash: string; // sha256
  file_size: number;
  mime_type: string;
};

function ymd(d: Date) {
  return d.toISOString().slice(0, 10);
}

function sanitizeFilename(name: string) {
  // keep it safe for storage paths
  return name.replace(/[^\w.\-()\s]/g, "").replace(/\s+/g, " ").trim();
}

async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const hashBuf = await crypto.subtle.digest("SHA-256", buf);
  const hashArray = Array.from(new Uint8Array(hashBuf));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default function UploadClient() {
  const router = useRouter();

  // ✅ Do NOT create multiple clients — use the singleton
  const supabase = supabaseBrowser;

  // --- UI state
  const [loading, setLoading] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  // --- data sources
  const [domains, setDomains] = useState<DomainRow[]>([]);
  const [entryTypes, setEntryTypes] = useState<string[]>([]);

  // --- form state
  const [entityKey, setEntityKey] = useState<string>("holdings");
  const [domainKey, setDomainKey] = useState<string>("incorporation");
  const [entryType, setEntryType] = useState<string>("filing");
  const [entryDate, setEntryDate] = useState<string>(ymd(new Date()));
  const [title, setTitle] = useState<string>("");
  const [notes, setNotes] = useState<string>("");
  const [file, setFile] = useState<File | null>(null);

  // --- derived preview
  const preview = useMemo(() => {
    const safeEntity = (entityKey || "").trim().toLowerCase();
    const safeDomain = (domainKey || "").trim().toLowerCase();
    const safeType = (entryType || "").trim().toLowerCase();
    const safeDate = (entryDate || ymd(new Date())).trim();

    return {
      entity_key: safeEntity,
      domain_key: safeDomain,
      entry_type: safeType,
      entry_date: safeDate,
    };
  }, [entityKey, domainKey, entryType, entryDate]);

  const [computedHash, setComputedHash] = useState<string | null>(null);
  const [computedPath, setComputedPath] = useState<string>("");

  // Pull entity from querystring if present: ?entity_key=holdings
  useEffect(() => {
    if (typeof window === "undefined") return;
    const qs = new URLSearchParams(window.location.search);
    const ek = qs.get("entity_key");
    if (ek && ek.trim()) setEntityKey(ek.trim().toLowerCase());
  }, []);

  // Load domains + entry types
  useEffect(() => {
    let alive = true;

    (async () => {
      setBanner(null);

      // Domains
      const { data: doms, error: domErr } = await supabase
        .from("governance_domains")
        .select("key,label,description,sort_order,active")
        .eq("active", true)
        .order("sort_order", { ascending: true });

      if (!alive) return;

      if (domErr) {
        setBanner(`Failed to load domains: ${domErr.message}`);
      } else {
        const rows = (doms ?? []) as DomainRow[];
        setDomains(rows);

        // pick a sensible default if current domainKey not valid
        if (rows.length > 0 && !rows.some((d) => d.key === domainKey)) {
          setDomainKey(rows[0].key);
        }
      }

      // Entry types (from your mapping table; keeps UI aligned with DB)
      const { data: ets, error: etErr } = await supabase
        .from("entry_type_section_defaults")
        .select("entry_type,default_section,notes");

      if (!alive) return;

      if (etErr) {
        // fallback: at least allow "filing"
        setEntryTypes(["filing"]);
      } else {
        const rows = (ets ?? []) as EntryTypeRow[];
        const distinct = Array.from(
          new Set(rows.map((r) => (r.entry_type || "").trim()).filter(Boolean))
        ).sort((a, b) => a.localeCompare(b));
        setEntryTypes(distinct.length ? distinct : ["filing"]);
        if (distinct.length && !distinct.includes(entryType)) setEntryType(distinct[0]);
      }
    })();

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When file changes: compute sha + storage path preview
  useEffect(() => {
    let alive = true;

    (async () => {
      setComputedHash(null);
      setComputedPath("");

      if (!file) return;

      try {
        const hash = await sha256Hex(file);
        if (!alive) return;

        const safeName = sanitizeFilename(file.name);
        const path = `${preview.entity_key}/${preview.domain_key}/${preview.entry_type}/${preview.entry_date}/${hash}-${safeName}`;

        setComputedHash(hash);
        setComputedPath(path);

        // Nice default title if empty
        if (!title.trim()) {
          const base = safeName.replace(/\.[^.]+$/, "");
          setTitle(base);
        }
      } catch (e: any) {
        if (!alive) return;
        setBanner(`Failed to hash file: ${e?.message ?? "unknown error"}`);
      }
    })();

    return () => {
      alive = false;
    };
  }, [file, preview.entity_key, preview.domain_key, preview.entry_type, preview.entry_date]); // eslint-disable-line react-hooks/exhaustive-deps

  async function onSubmit() {
    setBanner(null);

    const safeEntity = preview.entity_key;
    const safeDomain = preview.domain_key;
    const safeType = preview.entry_type;
    const safeDate = preview.entry_date;

    if (!safeEntity) return setBanner("Entity key is required (e.g., holdings).");
    if (!safeDomain) return setBanner("Domain is required.");
    if (!safeType) return setBanner("Entry type is required.");
    if (!safeDate) return setBanner("Entry date is required.");
    if (!title.trim()) return setBanner("Title is required.");
    if (!file) return setBanner("Please choose a PDF file.");

    if (!computedHash || !computedPath) {
      return setBanner("Hash/path not ready yet — reselect the file.");
    }

    setLoading(true);

    const bucket = "minute_book";
    const storagePath = computedPath;

    try {
      // 1) Upload to storage
      const { error: upErr } = await supabase.storage.from(bucket).upload(storagePath, file, {
        upsert: false,
        contentType: file.type || "application/pdf",
        cacheControl: "3600",
      });

      if (upErr) throw new Error(`Storage upload failed: ${upErr.message}`);

      // 2) Register via canonical RPC (MATCHES PROD SIGNATURE)
      // register_minute_book_upload(
      //   p_entity_key entity_key_enum,
      //   p_domain_key text,
      //   p_entry_type entry_type_enum,
      //   p_entry_date date,
      //   p_title text,
      //   p_notes text,
      //   p_file_name text,
      //   p_storage_path text,
      //   p_pdf_hash text,
      //   p_file_size bigint,
      //   p_mime_type text,
      //   p_supporting jsonb
      // ) returns uuid
      const { data: entryId, error: rpcErr } = await supabase.rpc("register_minute_book_upload", {
        p_entity_key: safeEntity,
        p_domain_key: safeDomain,
        p_entry_type: safeType,
        p_entry_date: safeDate,
        p_title: title.trim(),
        p_notes: notes?.trim() || null,
        p_file_name: sanitizeFilename(file.name),
        p_storage_path: storagePath,
        p_pdf_hash: computedHash,
        p_file_size: file.size,
        p_mime_type: file.type || "application/pdf",
        p_supporting: ([] as SupportingItem[]), // enterprise: ready, but empty for now
      });

      if (rpcErr) throw new Error(`Registry RPC failed: ${rpcErr.message}`);

      // ✅ success → back to registry
      router.push("/ci-archive/minute-book");
      router.refresh();
    } catch (e: any) {
      // rollback storage if RPC failed after upload
      try {
        if (storagePath) await supabase.storage.from(bucket).remove([storagePath]);
      } catch {
        // ignore rollback failures
      }
      setBanner(e?.message ?? "Upload failed (unknown error).");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="os-page">
      <div className="os-page-header">
        <div>
          <h1 className="os-title">Minute Book Upload</h1>
          <div className="os-subtitle">
            Domain-driven filing • SHA-256 enforced • Writes via{" "}
            <span className="os-accent">register_minute_book_upload</span>
          </div>
        </div>

        <div className="os-page-actions">
          <button
            className="os-btn os-btn-secondary"
            type="button"
            onClick={() => router.push("/ci-archive/minute-book")}
          >
            Back to Registry
          </button>
        </div>
      </div>

      {banner ? (
        <div className="os-banner os-banner-error">
          <div className="os-banner-title">Registry RPC failed</div>
          <div className="os-banner-body">{banner}</div>
        </div>
      ) : null}

      <div className="os-grid-2">
        {/* LEFT: Filing */}
        <div className="os-card">
          <div className="os-card-header">
            <div className="os-card-title">Filing</div>
            <div className="os-chip">Enterprise Contract</div>
          </div>

          <div className="os-form">
            <div className="os-field">
              <label className="os-label">Entity</label>
              <input
                className="os-input"
                value={entityKey}
                onChange={(e) => setEntityKey(e.target.value.toLowerCase())}
                placeholder="holdings"
                spellCheck={false}
              />
              <div className="os-help">
                Must match <span className="os-mono">entity_companies.key</span> (e.g., holdings).
              </div>
            </div>

            <div className="os-field">
              <label className="os-label">Domain</label>
              <select
                className="os-select"
                value={domainKey}
                onChange={(e) => setDomainKey(e.target.value)}
              >
                {domains.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label}
                  </option>
                ))}
              </select>
              <div className="os-help">
                Source: <span className="os-mono">governance_domains</span>
              </div>
            </div>

            <div className="os-field">
              <label className="os-label">Entry Type</label>
              <select
                className="os-select"
                value={entryType}
                onChange={(e) => setEntryType(e.target.value)}
              >
                {entryTypes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <div className="os-help">
                Source: <span className="os-mono">entry_type_section_defaults</span>
              </div>
            </div>

            <div className="os-field">
              <label className="os-label">Entry Date</label>
              <input
                className="os-input"
                type="date"
                value={entryDate}
                onChange={(e) => setEntryDate(e.target.value)}
              />
            </div>

            <div className="os-field">
              <label className="os-label">PDF</label>
              <input
                className="os-file"
                type="file"
                accept="application/pdf"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              <div className="os-help">
                Bucket: <span className="os-mono">minute_book</span>
              </div>
            </div>

            <div className="os-field">
              <label className="os-label">Title</label>
              <input
                className="os-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Articles of Incorporation - Oasis Holdings"
              />
            </div>

            <div className="os-field">
              <label className="os-label">Notes (optional)</label>
              <textarea
                className="os-textarea"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional registry notes..."
              />
            </div>

            <div className="os-actions">
              <button
                className="os-btn os-btn-primary"
                type="button"
                onClick={onSubmit}
                disabled={loading}
              >
                {loading ? "Uploading…" : "Upload & Register"}
              </button>
            </div>
          </div>
        </div>

        {/* RIGHT: Registry Preview */}
        <div className="os-card">
          <div className="os-card-header">
            <div>
              <div className="os-card-title">Registry Preview</div>
              <div className="os-card-subtitle">
                Exactly what will be written into <span className="os-mono">minute_book_entries</span> + supporting docs.
              </div>
            </div>
            <div className="os-chip os-chip-blue">Storage Path</div>
          </div>

          <div className="os-preview">
            <div className="os-preview-row">
              <div className="os-preview-k">Entity</div>
              <div className="os-preview-v">{preview.entity_key || "—"}</div>
            </div>
            <div className="os-preview-row">
              <div className="os-preview-k">Domain</div>
              <div className="os-preview-v">{preview.domain_key || "—"}</div>
            </div>
            <div className="os-preview-row">
              <div className="os-preview-k">Entry Type</div>
              <div className="os-preview-v">{preview.entry_type || "—"}</div>
            </div>
            <div className="os-preview-row">
              <div className="os-preview-k">Entry Date</div>
              <div className="os-preview-v">{preview.entry_date || "—"}</div>
            </div>
            <div className="os-preview-row">
              <div className="os-preview-k">Title</div>
              <div className="os-preview-v">{title || "—"}</div>
            </div>
            <div className="os-preview-row">
              <div className="os-preview-k">File</div>
              <div className="os-preview-v">{file?.name || "—"}</div>
            </div>

            <div className="os-preview-divider" />

            <div className="os-preview-row">
              <div className="os-preview-k">SHA-256</div>
              <div className="os-preview-v os-mono">{computedHash || "—"}</div>
            </div>
            <div className="os-preview-row">
              <div className="os-preview-k">Path Pattern</div>
              <div className="os-preview-v os-mono">
                {computedPath ||
                  `${preview.entity_key}/${preview.domain_key}/${preview.entry_type}/${preview.entry_date}/{sha256}-{filename}`}
              </div>
            </div>
          </div>

          <div className="os-footnote">CI-Archive · Oasis Digital Parliament</div>
        </div>
      </div>
    </div>
  );
}
