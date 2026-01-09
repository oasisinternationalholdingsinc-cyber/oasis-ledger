// src/app/(os)/ci-archive/minute-book/minute-book.client.tsx
"use client";
export const dynamic = "force-dynamic";

/**
 * CI-Archive → Minute Book (PRODUCTION — LOCKED CONTRACT)
 * ✅ STRICT 3-column surface: Domains | Entries | Evidence (PDF + Metadata Zone)
 * ✅ Domains source of truth: governance_domains (same as Upload)
 * ✅ Entries source of truth: minute_book_entries + supporting_documents (primary doc)
 * ✅ Entity scope: minute_book_entries.entity_key = useEntity().entityKey
 * ✅ Domain scope: minute_book_entries.domain_key = selected domain.key
 * ✅ Evidence: signed URL from storage buckets using supporting_documents.file_path
 * ✅ Metadata Zone preserved (Storage / Hash / Audit)
 * ✅ Delete UX (right panel): calls public.delete_minute_book_entry_and_files(p_entry_id, p_reason)
 * ❌ NO wiring changes beyond calling the existing delete function
 */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";

/* ---------------- types (schema-aligned) ---------------- */

type GovernanceDomain = {
  key: string;
  label: string;
  description?: string | null;
  sort_order?: number | null;
  active?: boolean | null;
};

type MinuteBookEntry = {
  id: string;
  entity_key: string;
  domain_key: string | null;
  section_name?: string | null;
  entry_type?: string | null;
  title?: string | null;
  notes?: string | null;
  created_at?: string | null;
  created_by?: string | null;
  source?: string | null;
};

type SupportingDoc = {
  id: string;
  entry_id: string;
  file_path: string | null;
  file_name: string | null;
  file_hash: string | null;
  file_size: number | null;
  mime_type: string | null;
  version?: number | null;
  uploaded_at?: string | null;
};

type EntryWithDoc = MinuteBookEntry & {
  document_id?: string | null;
  storage_path?: string | null;
  file_name?: string | null;
  file_hash?: string | null;
  file_size?: number | null;
  mime_type?: string | null;
};

type OfficialArtifact = {
  bucket_id: string;
  storage_path: string;
  file_name?: string | null;
  kind?: "official" | "certified" | "verified";
};

type DeleteResult = {
  ok?: boolean;
  entry_id?: string;
  entity_key?: string;
  deleted_storage_objects?: number;
  deleted_entry_rows?: number;
  reason?: string | null;
};

/* ---------------- helpers ---------------- */

function norm(s?: string | null, fb = "—") {
  const x = (s || "").toString().trim();
  return x.length ? x : fb;
}

function fmtBytes(n?: number | null) {
  if (!n || n <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function shortHash(h?: string | null) {
  if (!h) return "—";
  if (h.length <= 20) return h;
  return `${h.slice(0, 12)}…${h.slice(-8)}`;
}

function getCreatedAtMs(iso?: string | null) {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** Optional UI-only icon map (does not affect wiring) */
const DOMAIN_ICON: Record<string, string> = {
  incorporation: "📜",
  formation: "📜",
  "incorporation-and-formation": "📜",
  corporate_profile: "🛡️",
  "corporate-profile": "🛡️",
  share_capital: "📈",
  "share-capital": "📈",
  share_certificates: "📈",
  directors_officers: "👤",
  "directors-and-officers": "👤",
  resolutions: "⚖️",
  minutes: "⚖️",
  bylaws: "📘",
  governance: "📘",
  annual_returns: "🧾",
  tax: "🧾",
  banking: "🏦",
  insurance: "🛡️",
  risk: "🛡️",
  real_estate: "🏠",
  assets: "🏠",
  contracts: "🤝",
  agreements: "🤝",
  brand_ip: "™️",
  brand: "™️",
  compliance: "✅",
  regulatory: "✅",
  litigation: "⚠️",
  legal: "⚠️",
  annexes: "🗂️",
  misc: "🗂️",
};

/* ---------------- data loaders (LOCKED) ---------------- */

async function loadDomains(): Promise<GovernanceDomain[]> {
  const sb = supabaseBrowser;
  const { data, error } = await sb
    .from("governance_domains")
    .select("key,label,description,sort_order,active")
    .eq("active", true)
    .order("sort_order", { ascending: true });

  if (error) throw error;
  return (data ?? []) as GovernanceDomain[];
}

async function loadEntries(entityKey: string): Promise<MinuteBookEntry[]> {
  const sb = supabaseBrowser;
  const { data, error } = await sb
    .from("minute_book_entries")
    .select("id,entity_key,domain_key,section_name,entry_type,title,notes,created_at,created_by,source")
    .eq("entity_key", entityKey)
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error) throw error;
  return (data ?? []) as MinuteBookEntry[];
}

async function loadSupportingDocs(entryIds: string[]): Promise<SupportingDoc[]> {
  if (!entryIds.length) return [];
  const sb = supabaseBrowser;

  const { data, error } = await sb
    .from("supporting_documents")
    .select("id,entry_id,file_path,file_name,file_hash,file_size,mime_type,version,uploaded_at")
    .in("entry_id", entryIds)
    .order("version", { ascending: false })
    .order("uploaded_at", { ascending: false });

  if (error) throw error;
  return (data ?? []) as SupportingDoc[];
}

function pickPrimaryDocByEntry(docs: SupportingDoc[]): Map<string, SupportingDoc> {
  const m = new Map<string, SupportingDoc>();
  for (const d of docs) {
    if (!d.entry_id) continue;
    if (!m.has(d.entry_id)) m.set(d.entry_id, d);
  }
  return m;
}

/**
 * OFFICIAL-first resolver (read-only)
 * If Verified Registry has a record tied by hash/path/entry_id, prefer that.
 */
async function resolveOfficialArtifact(entityKey: string, entry: EntryWithDoc): Promise<OfficialArtifact | null> {
  const sb = supabaseBrowser;

  try {
    const hash = entry.file_hash || null;
    const path = entry.storage_path || null;

    const orParts = [
      hash ? `file_hash.eq.${hash}` : "",
      path ? `source_storage_path.eq.${path}` : "",
      `source_entry_id.eq.${entry.id}`,
      `minute_book_entry_id.eq.${entry.id}`,
    ].filter(Boolean);

    if (!orParts.length) return null;

    const { data, error } = await sb
      .from("verified_documents")
      .select("*")
      .eq("entity_key", entityKey)
      .or(orParts.join(","))
      .order("created_at", { ascending: false })
      .limit(1);

    if (error || !data?.length) return null;

    const v = data[0] as Record<string, unknown>;
    const bucket = (v.bucket_id as string) || (v.storage_bucket as string) || "verified_documents";
    const vpath = (v.storage_path as string) || (v.file_path as string) || (v.path as string);

    if (!bucket || !vpath) return null;

    return {
      bucket_id: bucket,
      storage_path: vpath,
      file_name: (v.file_name as string) || entry.file_name || null,
      kind: ((v.kind as string) as "official" | "certified" | "verified") || "verified",
    };
  } catch {
    return null;
  }
}

/* ---------------- storage url helpers (SURGICAL FIX) ---------------- */

/**
 * Canonicalize storage paths:
 * - remove leading slashes
 * - collapse accidental double slashes
 */
function cleanStoragePath(p: string) {
  const x = p.trim().replace(/^\/+/, "");
  return x.replace(/\/{2,}/g, "/");
}

/**
 * Build a small set of safe fallbacks for known case-variance issues (seen in storage.objects):
 * - holdings/resolutions/...  <-> holdings/Resolutions/...
 *
 * This does NOT change wiring; it only retries reads if the exact key was stored with different casing.
 */
function buildMinuteBookPathFallbacks(p: string): string[] {
  const base = cleanStoragePath(p);

  // Only a few deterministic fallbacks — keep it surgical.
  const flips: Array<[string, string]> = [
    ["/resolutions/", "/Resolutions/"],
    ["/Resolutions/", "/resolutions/"],
    ["/bylaws/", "/Bylaws/"],
    ["/Bylaws/", "/bylaws/"],
    ["/registers/", "/Registers/"],
    ["/Registers/", "/registers/"],
    ["/share_certificates/", "/Share_Certificates/"],
    ["/Share_Certificates/", "/share_certificates/"],
  ];

  const out: string[] = [base];

  for (const [a, b] of flips) {
    if (base.includes(a)) out.push(base.replace(a, b));
  }

  // Also try a lowercased variant ONLY if it doesn't explode path semantics
  // (this is rare but cheap and controlled).
  if (base !== base.toLowerCase()) out.push(base.toLowerCase());

  // Deduplicate
  return Array.from(new Set(out));
}

async function signedUrlFor(bucketId: string, storagePath: string, downloadName?: string | null) {
  const sb = supabaseBrowser;
  const key = cleanStoragePath(storagePath);
  const opts: { download?: string } | undefined = downloadName ? { download: downloadName } : undefined;

  const { data, error } = await sb.storage.from(bucketId).createSignedUrl(key, 60 * 10, opts);
  if (error) throw error;
  return data.signedUrl;
}

/**
 * Minute Book evidence signer with controlled fallbacks for casing variance.
 * If the first key fails with "Object not found", we retry a few safe variants.
 */
async function signedUrlForMinuteBookEvidence(storagePath: string, downloadName?: string | null) {
  const tries = buildMinuteBookPathFallbacks(storagePath);
  let lastErr: unknown = null;

  for (const key of tries) {
    try {
      return await signedUrlFor("minute_book", key, downloadName);
    } catch (e: unknown) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      // Only retry on "Object not found" / 404-ish errors
      if (!/not found|404/i.test(msg)) throw e;
    }
  }

  // If we exhausted fallbacks, throw the last error (preserves current UX)
  throw lastErr instanceof Error ? lastErr : new Error("Object not found");
}

/* ---------------- UI ---------------- */

export default function MinuteBookClient() {
  const { entityKey } = useEntity();

  // domains
  const [domains, setDomains] = useState<GovernanceDomain[]>([]);
  const [activeDomainKey, setActiveDomainKey] = useState<string>("all");

  // entries
  const [entries, setEntries] = useState<EntryWithDoc[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // ui state
  const [query, setQuery] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);

  // evidence state (official-first)
  const [official, setOfficial] = useState<OfficialArtifact | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState<boolean>(false);
  const [pdfErr, setPdfErr] = useState<string | null>(null);

  // reader overlay
  const [readerOpen, setReaderOpen] = useState<boolean>(false);
  const [readerTone, setReaderTone] = useState<"glass" | "solid">("glass");
  const [showHashInReader, setShowHashInReader] = useState<boolean>(true);

  // delete UX
  const [deleteOpen, setDeleteOpen] = useState<boolean>(false);
  const [deleteReason, setDeleteReason] = useState<string>("");
  const [deleteBusy, setDeleteBusy] = useState<boolean>(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  // Load domains
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await loadDomains();
        if (!alive) return;
        setDomains(d);
      } catch (e: unknown) {
        if (!alive) return;
        setDomains([]);
        setErr(e instanceof Error ? e.message : "Failed to load governance domains.");
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  // Load entries (entity-scoped) + resolve primary docs
  useEffect(() => {
    let alive = true;

    async function run() {
      setErr(null);
      setLoading(true);

      setEntries([]);
      setSelectedId(null);

      setOfficial(null);
      setPreviewUrl(null);
      setPdfErr(null);

      if (!entityKey) {
        setLoading(false);
        return;
      }

      try {
        const base = await loadEntries(entityKey);
        if (!alive) return;

        const ids = base.map((e: MinuteBookEntry) => e.id);
        const docs = await loadSupportingDocs(ids);
        if (!alive) return;

        const primary = pickPrimaryDocByEntry(docs);

        const merged: EntryWithDoc[] = base.map((e: MinuteBookEntry) => {
          const doc = primary.get(e.id);
          return {
            ...e,
            document_id: doc?.id ?? null,
            storage_path: doc?.file_path ?? null,
            file_name: doc?.file_name ?? null,
            file_hash: doc?.file_hash ?? null,
            file_size: doc?.file_size ?? null,
            mime_type: doc?.mime_type ?? null,
          };
        });

        merged.sort((a: EntryWithDoc, b: EntryWithDoc) => getCreatedAtMs(b.created_at) - getCreatedAtMs(a.created_at));

        setEntries(merged);
        setSelectedId(merged[0]?.id ?? null);

        // if selected domain no longer exists, reset to all
        if (activeDomainKey !== "all") {
          const exists = domains.some((d: GovernanceDomain) => d.key === activeDomainKey);
          if (!exists) setActiveDomainKey("all");
        }
      } catch (e: unknown) {
        if (!alive) return;
        setErr(e instanceof Error ? e.message : "Failed to load Minute Book entries.");
      } finally {
        if (alive) setLoading(false);
      }
    }

    run();

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityKey]);

  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase();

    let list: EntryWithDoc[] = entries;

    if (activeDomainKey !== "all") {
      list = list.filter((e: EntryWithDoc) => (e.domain_key || "") === activeDomainKey);
    }

    if (q) {
      list = list.filter((e: EntryWithDoc) => {
        const hay = [
          e.title || "",
          e.entry_type || "",
          e.domain_key || "",
          e.section_name || "",
          e.file_name || "",
          e.storage_path || "",
          e.file_hash || "",
        ]
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      });
    }

    return [...list].sort((a: EntryWithDoc, b: EntryWithDoc) => getCreatedAtMs(b.created_at) - getCreatedAtMs(a.created_at));
  }, [entries, activeDomainKey, query]);

  const selected = useMemo(() => {
    if (!selectedId) return null;
    return entries.find((e: EntryWithDoc) => e.id === selectedId) || null;
  }, [entries, selectedId]);

  // Domain counts (from actual entries)
  const domainCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of domains) m.set(d.key, 0);
    for (const e of entries) {
      if (e.domain_key) m.set(e.domain_key, (m.get(e.domain_key) || 0) + 1);
    }
    return m;
  }, [domains, entries]);

  // Resolve OFFICIAL artifact when selection changes
  useEffect(() => {
    let alive = true;
    (async () => {
      setOfficial(null);
      setPdfErr(null);
      setPreviewUrl(null);
      setReaderOpen(false);

      if (!entityKey || !selected) return;

      setPdfBusy(true);
      try {
        const off = await resolveOfficialArtifact(entityKey, selected);
        if (!alive) return;
        setOfficial(off);
      } finally {
        if (alive) setPdfBusy(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [entityKey, selected?.id]);

  async function ensurePreviewUrl(openReader: boolean) {
    if (!selected) return;

    setPdfErr(null);
    setPdfBusy(true);

    try {
      // official-first
      if (official?.bucket_id && official?.storage_path) {
        const url = await signedUrlFor(official.bucket_id, official.storage_path, null);
        setPreviewUrl(url);
        if (openReader) setReaderOpen(true);
        return;
      }

      // fallback: minute_book evidence (with casing fallbacks)
      if (!selected.storage_path) throw new Error("No storage_path on the primary document.");
      const url = await signedUrlForMinuteBookEvidence(selected.storage_path, null);
      setPreviewUrl(url);
      if (openReader) setReaderOpen(true);
    } catch (e: unknown) {
      setPdfErr(e instanceof Error ? e.message : "Failed to generate PDF preview.");
    } finally {
      setPdfBusy(false);
    }
  }

  async function downloadPdf() {
    if (!selected) return;
    setPdfErr(null);
    setPdfBusy(true);

    try {
      const name = selected.file_name || `${norm(selected.title, "document")}.pdf`;

      if (official?.bucket_id && official?.storage_path) {
        const url = await signedUrlFor(official.bucket_id, official.storage_path, name);
        window.open(url, "_blank", "noopener,noreferrer");
        return;
      }

      if (!selected.storage_path) throw new Error("No storage_path on the primary document.");
      const url = await signedUrlForMinuteBookEvidence(selected.storage_path, name);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e: unknown) {
      setPdfErr(e instanceof Error ? e.message : "Failed to generate download URL.");
    } finally {
      setPdfBusy(false);
    }
  }

  async function openNewTab() {
    if (!selected) return;
    setPdfErr(null);
    setPdfBusy(true);

    try {
      // prefer existing preview
      if (previewUrl) {
        window.open(previewUrl, "_blank", "noopener,noreferrer");
        return;
      }

      if (official?.bucket_id && official?.storage_path) {
        const url = await signedUrlFor(official.bucket_id, official.storage_path, null);
        window.open(url, "_blank", "noopener,noreferrer");
        return;
      }

      if (!selected.storage_path) throw new Error("No storage_path on the primary document.");
      const url = await signedUrlForMinuteBookEvidence(selected.storage_path, null);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e: unknown) {
      setPdfErr(e instanceof Error ? e.message : "Failed to open PDF.");
    } finally {
      setPdfBusy(false);
    }
  }

  async function runDelete() {
    if (!selected) return;

    setDeleteErr(null);
    setDeleteBusy(true);

    try {
      const sb = supabaseBrowser;

      // SECURITY DEFINER function (already implemented in DB)
      const { data, error } = await sb.rpc("delete_minute_book_entry_and_files", {
        p_entry_id: selected.id,
        p_reason: deleteReason?.trim() || null,
      });

      if (error) throw error;

      const res = (data ?? {}) as DeleteResult;
      if (!res.ok) throw new Error("Delete failed (no ok=true returned).");

      // close modal + refresh list (same wiring, just re-fetch)
      setDeleteOpen(false);
      setDeleteReason("");
      setReaderOpen(false);
      setPreviewUrl(null);

      // re-load entries for this entity
      if (entityKey) {
        const base = await loadEntries(entityKey);
        const ids = base.map((e: MinuteBookEntry) => e.id);
        const docs = await loadSupportingDocs(ids);
        const primary = pickPrimaryDocByEntry(docs);

        const merged: EntryWithDoc[] = base.map((e: MinuteBookEntry) => {
          const doc = primary.get(e.id);
          return {
            ...e,
            document_id: doc?.id ?? null,
            storage_path: doc?.file_path ?? null,
            file_name: doc?.file_name ?? null,
            file_hash: doc?.file_hash ?? null,
            file_size: doc?.file_size ?? null,
            mime_type: doc?.mime_type ?? null,
          };
        });

        merged.sort((a: EntryWithDoc, b: EntryWithDoc) => getCreatedAtMs(b.created_at) - getCreatedAtMs(a.created_at));
        setEntries(merged);
        setSelectedId(merged[0]?.id ?? null);
      }
    } catch (e: unknown) {
      setDeleteErr(e instanceof Error ? e.message : "Delete failed.");
    } finally {
      setDeleteBusy(false);
    }
  }

  const activeDomainLabel = useMemo(() => {
    if (activeDomainKey === "all") return "All";
    return domains.find((d: GovernanceDomain) => d.key === activeDomainKey)?.label || "Domain";
  }, [activeDomainKey, domains]);

  const authorityBadge = useMemo(() => {
    if (!selected) return null;
    if (official) return { label: "OFFICIAL", tone: "gold" as const };
    return { label: "UPLOADED", tone: "neutral" as const };
  }, [selected?.id, !!official]);

  /* ---------------- render ---------------- */

  return (
    <div className="h-full flex flex-col px-8 pt-6 pb-6">
      {/* Header under OS bar */}
      <div className="mb-4 shrink-0">
        <div className="text-xs tracking-[0.3em] uppercase text-slate-500">CI-ARCHIVE</div>
        <p className="mt-1 text-[11px] text-slate-400">
          Minute Book Registry • <span className="font-semibold text-slate-200">Evidence-first</span>
        </p>
      </div>

      {/* Main Window – council-framed */}
      <div className="flex-1 min-h-0 flex justify-center overflow-hidden">
        <div className="w-full max-w-[1600px] h-full rounded-3xl border border-slate-900 bg-black/60 shadow-[0_0_60px_rgba(15,23,42,0.9)] px-6 py-5 flex flex-col overflow-hidden">
          {/* Window Title */}
          <div className="flex items-start justify-between mb-4 shrink-0">
            <div className="min-w-0">
              <h1 className="text-lg font-semibold text-slate-50 truncate">Minute Book Registry</h1>
              <p className="mt-1 text-xs text-slate-400">
                Canonical archive indexed by governance domain.{" "}
                <span className="text-slate-500">Domains sourced from governance_domains (Upload contract).</span>
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <div className="hidden md:flex items-center text-[10px] uppercase tracking-[0.3em] text-slate-500">
                CI-ARCHIVE • LIVE
              </div>
              <Link
                href="/ci-archive/upload"
                className="rounded-full border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-amber-200 hover:bg-amber-500/15"
              >
                Go to Upload →
              </Link>
            </div>
          </div>

          {!entityKey ? (
            <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4 text-sm text-slate-300">
              Select an entity in the OS bar to view Minute Book records.
            </div>
          ) : (
            <div className="grid grid-cols-12 gap-6 flex-1 min-h-0">
              {/* LEFT: Domains (tab-style, hover glow) */}
              <section className="col-span-12 lg:col-span-3 min-h-0 flex flex-col">
                <div className="bg-slate-950/40 border border-slate-800 rounded-2xl p-4 flex flex-col min-h-0">
                  <div className="flex items-center justify-between mb-3 shrink-0">
                    <div>
                      <div className="text-sm font-semibold text-slate-200">Domains</div>
                      <div className="text-[11px] text-slate-500">Source: governance_domains</div>
                    </div>
                    <div className="text-[10px] uppercase tracking-[0.25em] text-slate-500">{domains.length || "—"}</div>
                  </div>

                  <div className="flex-1 min-h-0 overflow-y-auto rounded-xl border border-slate-800/80 bg-slate-950/60 p-2">
                    {/* All */}
                    <button
                      type="button"
                      onClick={() => setActiveDomainKey("all")}
                      className={[
                        "group w-full flex items-center justify-between gap-3 px-3 py-2 rounded-xl transition border",
                        activeDomainKey === "all"
                          ? "bg-amber-500/10 border-amber-500/40 shadow-[0_0_0_1px_rgba(245,158,11,0.25)]"
                          : "bg-transparent border-transparent hover:bg-slate-900/60 hover:border-amber-500/25 hover:shadow-[0_0_22px_rgba(245,158,11,0.10)]",
                      ].join(" ")}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <span className="w-7 h-7 grid place-items-center rounded-lg border border-slate-800 bg-slate-950/70 text-[12px] group-hover:border-amber-500/30">
                          ◆
                        </span>
                        <span className="text-sm text-slate-100 truncate">All</span>
                      </span>
                      <span className="text-[11px] text-slate-500">{entries.length}</span>
                    </button>

                    <div className="mt-2 space-y-1">
                      {domains.map((d: GovernanceDomain) => {
                        const active = d.key === activeDomainKey;
                        const count = domainCounts.get(d.key) || 0;
                        const icon = DOMAIN_ICON[d.key] || "•";

                        return (
                          <button
                            key={d.key}
                            type="button"
                            onClick={() => setActiveDomainKey(d.key)}
                            className={[
                              "group w-full flex items-center justify-between gap-3 px-3 py-2 rounded-xl transition border",
                              active
                                ? "bg-amber-500/10 border-amber-500/40 shadow-[0_0_0_1px_rgba(245,158,11,0.25)]"
                                : "bg-transparent border-transparent hover:bg-slate-900/60 hover:border-amber-500/25 hover:shadow-[0_0_22px_rgba(245,158,11,0.10)]",
                            ].join(" ")}
                          >
                            <span className="flex items-center gap-2 min-w-0">
                              <span className="w-7 h-7 grid place-items-center rounded-lg border border-slate-800 bg-slate-950/70 text-[12px] group-hover:border-amber-500/30">
                                {icon}
                              </span>
                              <span className="text-sm text-slate-100 truncate">{d.label}</span>
                            </span>
                            <span className={["text-[11px]", count ? "text-amber-200/80" : "text-slate-600"].join(" ")}>
                              {count}
                            </span>
                          </button>
                        );
                      })}
                    </div>

                    {err ? (
                      <div className="mt-3 rounded-xl border border-red-800/60 bg-red-950/40 px-3 py-2 text-[11px] text-red-300">
                        {err}
                      </div>
                    ) : null}
                  </div>

                  <div className="mt-3 text-[10px] text-slate-500 flex items-center justify-between">
                    <span>
                      Entity: <span className="text-slate-300">{entityKey}</span>
                    </span>
                    <Link href="/ci-archive" className="text-slate-400 hover:text-slate-200">
                      Launchpad
                    </Link>
                  </div>
                </div>
              </section>

              {/* MIDDLE: Entries */}
              <section className="col-span-12 lg:col-span-5 min-h-0 flex flex-col">
                <div className="bg-slate-950/40 border border-slate-800 rounded-2xl p-4 flex flex-col min-h-0">
                  <div className="flex items-start justify-between mb-3 shrink-0">
                    <div>
                      <div className="text-sm font-semibold text-slate-200">Registry Entries</div>
                      <div className="text-[11px] text-slate-500">
                        {loading ? "Loading…" : `${filteredEntries.length} item(s)`} •{" "}
                        <span className="text-slate-300">{activeDomainLabel}</span>
                      </div>
                    </div>
                    <span className="px-2 py-0.5 rounded-full bg-sky-500/10 border border-sky-500/30 text-[10px] uppercase tracking-[0.18em] text-sky-200">
                      Evidence Index
                    </span>
                  </div>

                  <div className="mb-3 shrink-0">
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search title, hash, path…"
                      className="w-full rounded-xl bg-slate-950/70 border border-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 outline-none focus:border-amber-500/40"
                    />
                  </div>

                  <div className="flex-1 min-h-0 overflow-y-auto rounded-xl border border-slate-800/80 bg-slate-950/60">
                    {loading ? (
                      <div className="p-3 text-[11px] text-slate-400">Loading entries…</div>
                    ) : filteredEntries.length === 0 ? (
                      <div className="p-3 text-[11px] text-slate-400">
                        No records filed under <span className="text-slate-200">{activeDomainLabel}</span> yet.
                        <div className="mt-2 text-[10px] text-slate-500">Upload later — it will appear here automatically.</div>
                      </div>
                    ) : (
                      filteredEntries.map((e: EntryWithDoc) => {
                        const active = e.id === selectedId;
                        const createdAt = e.created_at ? new Date(e.created_at).toLocaleString() : "—";

                        return (
                          <button
                            key={e.id}
                            type="button"
                            onClick={() => setSelectedId(e.id)}
                            className={[
                              "w-full text-left px-3 py-3 border-b border-slate-800 last:border-b-0 transition",
                              active ? "bg-slate-900/90 shadow-[0_0_0_1px_rgba(245,158,11,0.35)]" : "hover:bg-slate-900/60",
                            ].join(" ")}
                          >
                            <div className="text-xs font-semibold text-slate-100 line-clamp-2">
                              {e.title || e.file_name || "Untitled filing"}
                            </div>
                            <div className="mt-1 text-[11px] text-slate-400 flex items-center gap-2 flex-wrap">
                              <span className="capitalize">{e.entry_type || "document"}</span>
                              <span className="w-1 h-1 rounded-full bg-slate-600" />
                              <span className="text-slate-500">{createdAt}</span>
                              <span className="w-1 h-1 rounded-full bg-slate-700" />
                              <span className="text-slate-500">{fmtBytes(e.file_size)}</span>
                            </div>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              </section>

              {/* RIGHT: Evidence (Actions + Reader + Metadata Zone) */}
              <section className="col-span-12 lg:col-span-4 min-h-0 flex flex-col">
                <div className="bg-slate-950/40 border border-slate-800 rounded-2xl p-4 flex flex-col min-h-0">
                  <div className="flex items-start justify-between mb-3 shrink-0">
                    <div>
                      <div className="text-sm font-semibold text-slate-200">Evidence</div>
                      <div className="text-[11px] text-slate-500">Reader-first • Metadata secondary</div>
                    </div>

                    {authorityBadge ? (
                      <span
                        className={[
                          "px-2 py-0.5 rounded-full border text-[10px] uppercase tracking-[0.18em] font-semibold",
                          authorityBadge.tone === "gold"
                            ? "bg-amber-500/10 border-amber-500/40 text-amber-200"
                            : "bg-slate-900/40 border-slate-700 text-slate-300",
                        ].join(" ")}
                      >
                        {authorityBadge.label}
                      </span>
                    ) : null}
                  </div>

                  {!selected ? (
                    <div className="flex-1 min-h-0 rounded-xl border border-slate-800/80 bg-slate-950/60 p-3 text-[11px] text-slate-400">
                      Select a record to inspect evidence.
                    </div>
                  ) : (
                    <>
                      {/* Actions */}
                      <div className="rounded-xl border border-slate-800/80 bg-slate-950/60 p-3 shrink-0">
                        <div className="text-sm font-semibold text-slate-100">
                          {selected.title || selected.file_name || "Untitled filing"}
                        </div>

                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <span className="px-2 py-1 rounded-full bg-slate-900/60 border border-slate-800 text-[11px] text-slate-200 capitalize">
                            {selected.entry_type || "document"}
                          </span>
                          <span className="px-2 py-1 rounded-full bg-amber-500/10 border border-amber-500/30 text-[11px] text-amber-200">
                            {domains.find((d: GovernanceDomain) => d.key === selected.domain_key)?.label || norm(selected.domain_key, "—")}
                          </span>
                        </div>

                        {pdfErr ? (
                          <div className="mt-3 rounded-xl border border-red-800/60 bg-red-950/40 px-3 py-2 text-[11px] text-red-300">
                            {pdfErr}
                          </div>
                        ) : null}

                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          {/* Primary action: Reader */}
                          <button
                            type="button"
                            onClick={() => ensurePreviewUrl(true)}
                            disabled={pdfBusy}
                            className={[
                              "rounded-full px-4 py-1.5 text-[11px] font-semibold tracking-[0.18em] uppercase transition",
                              pdfBusy ? "bg-amber-500/20 text-amber-200/60 cursor-not-allowed" : "bg-amber-500 text-black hover:bg-amber-400",
                            ].join(" ")}
                            title="Open PDF in Reader Mode (full overlay)"
                          >
                            Reader
                          </button>

                          <button
                            type="button"
                            onClick={downloadPdf}
                            disabled={pdfBusy}
                            className={[
                              "rounded-full px-4 py-1.5 text-[11px] font-semibold tracking-[0.18em] uppercase transition",
                              pdfBusy ? "bg-slate-800/40 text-slate-300/60 cursor-not-allowed" : "bg-slate-200 text-black hover:bg-white",
                            ].join(" ")}
                            title="Download PDF"
                          >
                            Download
                          </button>

                          <button
                            type="button"
                            onClick={openNewTab}
                            disabled={pdfBusy}
                            className={[
                              "rounded-full px-4 py-1.5 text-[11px] font-semibold tracking-[0.18em] uppercase transition border",
                              pdfBusy
                                ? "bg-slate-800/40 text-slate-300/60 cursor-not-allowed border-slate-800"
                                : "bg-slate-900/60 border-slate-700 text-slate-200 hover:bg-slate-900 hover:border-amber-500/25 hover:shadow-[0_0_18px_rgba(245,158,11,0.10)]",
                            ].join(" ")}
                            title="Open in new tab"
                          >
                            Open
                          </button>

                          {/* Delete */}
                          <button
                            type="button"
                            onClick={() => {
                              setDeleteErr(null);
                              setDeleteReason("");
                              setDeleteOpen(true);
                            }}
                            className="rounded-full px-4 py-1.5 text-[11px] font-semibold tracking-[0.18em] uppercase transition border border-red-500/30 bg-red-500/10 text-red-200 hover:bg-red-500/15"
                            title="Hard delete entry + files (owner/admin only)"
                          >
                            Delete
                          </button>
                        </div>

                        <div className="mt-3 flex items-center justify-between text-[10px] text-slate-500">
                          <span>Upload is the sole write entry point.</span>
                          <button
                            type="button"
                            onClick={() => ensurePreviewUrl(false)}
                            className="text-slate-400 hover:text-slate-200"
                            title="Refresh preview URL (no overlay)"
                          >
                            Refresh preview
                          </button>
                        </div>
                      </div>

                      {/* Docked preview (secondary) */}
                      <div className="mt-3 flex-1 min-h-0 rounded-xl border border-slate-800/80 bg-slate-950/60 overflow-hidden">
                        {previewUrl ? (
                          <iframe title="PDF Preview" src={previewUrl} className="h-full w-full" />
                        ) : (
                          <div className="h-full w-full grid place-items-center text-[11px] text-slate-500">
                            Click <span className="text-slate-200 font-semibold">Reader</span> to open a full-size view.
                          </div>
                        )}
                      </div>

                      {/* Metadata Zone (secondary) */}
                      <div className="mt-3 rounded-xl border border-slate-800/80 bg-slate-950/60 p-3 shrink-0">
                        <div className="flex items-center justify-between mb-2">
                          <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">Metadata Zone</div>
                          <span className="px-2 py-0.5 rounded-full bg-slate-900/60 border border-slate-800 text-[10px] tracking-[0.18em] uppercase text-slate-300">
                            secondary
                          </span>
                        </div>

                        <div className="space-y-2">
                          <details className="rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2">
                            <summary className="cursor-pointer text-[11px] text-slate-200">Storage</summary>
                            <div className="mt-2 space-y-1 text-[11px] text-slate-300">
                              <div className="flex items-start justify-between gap-3">
                                <span className="text-slate-500">Path</span>
                                <span className="text-right font-mono break-all">{norm(selected.storage_path, "—")}</span>
                              </div>
                              <div className="flex items-start justify-between gap-3">
                                <span className="text-slate-500">File</span>
                                <span className="text-right break-all">{norm(selected.file_name, "—")}</span>
                              </div>
                              <div className="flex items-start justify-between gap-3">
                                <span className="text-slate-500">Size</span>
                                <span className="text-right">{fmtBytes(selected.file_size)}</span>
                              </div>
                              <div className="flex items-start justify-between gap-3">
                                <span className="text-slate-500">MIME</span>
                                <span className="text-right">{norm(selected.mime_type, "—")}</span>
                              </div>
                            </div>
                          </details>

                          <details open className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                            <summary className="cursor-pointer text-[11px] text-amber-200">Hash</summary>
                            <div className="mt-2 text-[11px] text-amber-100/90">
                              <div className="flex items-start justify-between gap-3">
                                <span className="text-amber-200/60">SHA-256</span>
                                <span className="text-right font-mono break-all">{shortHash(selected.file_hash)}</span>
                              </div>
                              <div className="mt-1 text-[10px] text-amber-200/60">
                                Minute Book = evidence access. Certification/attestation lives in Verified Registry.
                              </div>
                            </div>
                          </details>

                          <details className="rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2">
                            <summary className="cursor-pointer text-[11px] text-slate-200">Audit</summary>
                            <div className="mt-2 space-y-1 text-[11px] text-slate-300">
                              <div className="flex items-start justify-between gap-3">
                                <span className="text-slate-500">Created</span>
                                <span className="text-right">{selected.created_at ? new Date(selected.created_at).toLocaleString() : "—"}</span>
                              </div>
                              <div className="flex items-start justify-between gap-3">
                                <span className="text-slate-500">Created By</span>
                                <span className="text-right font-mono break-all">{norm(selected.created_by, "—")}</span>
                              </div>
                              <div className="flex items-start justify-between gap-3">
                                <span className="text-slate-500">Source</span>
                                <span className="text-right break-all">{norm(selected.source, "—")}</span>
                              </div>
                            </div>
                          </details>
                        </div>

                        <div className="mt-3 flex items-center justify-between text-[10px] text-slate-500">
                          <Link href="/ci-archive" className="hover:text-slate-200">
                            Archive Launchpad
                          </Link>
                          <span>Evidence-first. Verification lives in Verified.</span>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </section>
            </div>
          )}

          <div className="mt-3 flex items-center justify-between text-[10px] text-slate-500">
            <span>CI-Archive · Oasis Digital Parliament</span>
            <span>ODP.AI · Governance Firmware</span>
          </div>
        </div>
      </div>

      {/* ---------------- Reader Overlay (Council-style) ---------------- */}
      {readerOpen ? (
        <div
          className={[
            "fixed inset-0 z-[80] flex items-center justify-center p-4",
            readerTone === "glass" ? "bg-black/70 backdrop-blur-xl" : "bg-black",
          ].join(" ")}
        >
          <div className="w-full max-w-[1400px] h-[86vh] rounded-3xl border border-slate-800 bg-slate-950/70 shadow-[0_0_70px_rgba(0,0,0,0.55)] overflow-hidden flex flex-col">
            <div className="px-5 py-4 border-b border-slate-800/80 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-xs tracking-[0.3em] uppercase text-slate-500">READER MODE</div>
                <div className="mt-1 text-sm font-semibold text-slate-100 truncate">
                  {selected?.title || selected?.file_name || "Document"}
                </div>
                <div className="mt-1 text-[11px] text-slate-500">
                  {official ? "Official artifact preferred • " : "Uploaded evidence • "}
                  {showHashInReader ? <span className="font-mono">{shortHash(selected?.file_hash || null)}</span> : null}
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setReaderTone((t) => (t === "glass" ? "solid" : "glass"))}
                  className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1.5 text-[11px] text-slate-200 hover:border-amber-500/25 hover:shadow-[0_0_18px_rgba(245,158,11,0.10)]"
                  title="Toggle overlay tone"
                >
                  {readerTone === "glass" ? "Glass" : "Solid"}
                </button>

                <button
                  type="button"
                  onClick={() => setShowHashInReader((v) => !v)}
                  className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1.5 text-[11px] text-slate-200 hover:border-amber-500/25 hover:shadow-[0_0_18px_rgba(245,158,11,0.10)]"
                  title="Toggle hash in header"
                >
                  Hash
                </button>

                <button
                  type="button"
                  onClick={() => setReaderOpen(false)}
                  className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1.5 text-[11px] text-slate-200 hover:bg-slate-900 hover:border-slate-500"
                >
                  Close
                </button>
              </div>
            </div>

            <div className="flex-1 min-h-0 bg-black">
              {previewUrl ? (
                <iframe title="PDF Reader" src={previewUrl} className="h-full w-full" />
              ) : (
                <div className="h-full w-full grid place-items-center text-[11px] text-slate-400">
                  No preview loaded. Close and click Reader again.
                </div>
              )}
            </div>

            <div className="px-5 py-3 border-t border-slate-800/80 flex items-center justify-between text-[11px] text-slate-500">
              <span>
                Record ID: <span className="font-mono text-slate-300">{selected?.id || "—"}</span>
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={downloadPdf}
                  className="rounded-full bg-slate-200 text-black px-3 py-1.5 text-[11px] font-semibold hover:bg-white"
                >
                  Download
                </button>
                <button
                  type="button"
                  onClick={openNewTab}
                  className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1.5 text-[11px] text-slate-200 hover:bg-slate-900"
                >
                  Open New Tab
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ---------------- Delete Confirm Modal (Right-panel authority) ---------------- */}
      {deleteOpen && selected ? (
        <div className="fixed inset-0 z-[90] bg-black/70 backdrop-blur-xl flex items-center justify-center p-4">
          <div className="w-full max-w-[720px] rounded-3xl border border-red-500/30 bg-slate-950/80 shadow-[0_0_70px_rgba(0,0,0,0.55)] overflow-hidden">
            <div className="px-6 py-5 border-b border-slate-800/80">
              <div className="text-xs tracking-[0.3em] uppercase text-red-300">HARD DELETE</div>
              <div className="mt-2 text-lg font-semibold text-slate-100">Delete Minute Book entry?</div>
              <p className="mt-2 text-sm text-slate-300">
                This permanently removes the entry and all related files in the <span className="font-mono">minute_book</span> bucket
                (including thumbnails). Owner/Admin only.
              </p>
              <div className="mt-2 text-[11px] text-slate-500">
                Record: <span className="text-slate-200 font-semibold">{selected.title || selected.file_name || "Untitled filing"}</span>{" "}
                • <span className="font-mono">{shortHash(selected.file_hash || null)}</span>
              </div>
            </div>

            <div className="px-6 py-5">
              <label className="text-[11px] uppercase tracking-[0.2em] text-slate-500">Reason (required)</label>
              <input
                value={deleteReason}
                onChange={(e) => setDeleteReason(e.target.value)}
                placeholder="e.g., Filed under wrong entity / wrong domain / duplicate / test upload"
                className="mt-2 w-full rounded-xl bg-black/40 border border-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 outline-none focus:border-red-500/40"
              />

              {deleteErr ? (
                <div className="mt-3 rounded-xl border border-red-800/60 bg-red-950/40 px-3 py-2 text-[11px] text-red-300">
                  {deleteErr}
                </div>
              ) : null}

              <div className="mt-5 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => {
                    setDeleteOpen(false);
                    setDeleteErr(null);
                  }}
                  className="rounded-full border border-slate-700 bg-slate-900/60 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-slate-900"
                >
                  Cancel
                </button>

                <button
                  type="button"
                  disabled={deleteBusy || deleteReason.trim().length < 3}
                  onClick={runDelete}
                  className={[
                    "rounded-full px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition",
                    deleteBusy || deleteReason.trim().length < 3
                      ? "bg-red-500/20 text-red-200/60 cursor-not-allowed"
                      : "bg-red-500 text-white hover:bg-red-400",
                  ].join(" ")}
                >
                  {deleteBusy ? "Deleting…" : "Confirm Delete"}
                </button>
              </div>

              <div className="mt-3 text-[10px] text-slate-500">
                ISO language: record lifecycle correction • controlled disposal • reason captured.
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
