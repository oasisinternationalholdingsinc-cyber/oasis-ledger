// src/app/(os)/ci-archive/minute-book/minute-book.client.tsx
"use client";
export const dynamic = "force-dynamic";

/**
 * CI-Archive → Minute Book (PRODUCTION — LOCKED CONTRACT)
 * ✅ SAME data sources + logic (NO wiring changes)
 * ✅ OS-native surface (no black-box window fighting OS shell)
 * ✅ iPhone-first: Rail → Reader Sheet (full screen), zero double-scroll
 * ✅ Desktop: 3-column layout preserved (Domains | Entries | Evidence)
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
  source_record_id?: string | null; // governance_ledger.id
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
  registry_visible?: boolean | null;
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

function cx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

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

function dirOf(path: string) {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i) : "";
}

function baseOf(path: string) {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

function normalizeSlashes(s: string) {
  return s.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function extractUuidPrefix(filename: string): string | null {
  const m = filename.match(
    /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i
  );
  return m?.[1] ?? null;
}

function looksLikeNotFound(err: unknown) {
  const msg = (err as any)?.message ? String((err as any).message) : "";
  return /not\s*found/i.test(msg) || (/object/i.test(msg) && /not\s*found/i.test(msg));
}

function uniq<T>(arr: T[]) {
  return Array.from(new Set(arr));
}

/**
 * Lane bucket heuristic (read-only, UI-only)
 */
function bucketCandidatesForPath(path: string) {
  const p = normalizeSlashes(path).toLowerCase();
  const candidates: string[] = [];

  if (p.startsWith("sandbox/")) candidates.push("governance_sandbox");
  if (p.startsWith("truth/")) candidates.push("governance_truth"); // harmless if absent
  if (p.includes("/archive/")) candidates.push("governance_sandbox");

  candidates.push("minute_book");
  candidates.push("governance_sandbox");

  return uniq(candidates);
}

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
    .select(
      "id,entity_key,domain_key,section_name,entry_type,title,notes,created_at,created_by,source,source_record_id"
    )
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
    .select("id,entry_id,file_path,file_name,file_hash,file_size,mime_type,version,uploaded_at,registry_visible")
    .in("entry_id", entryIds)
    .order("registry_visible", { ascending: false })
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
 * ✅ OFFICIAL resolver (read-only)
 */
async function resolveOfficialArtifact(_entityKey: string, entry: EntryWithDoc): Promise<OfficialArtifact | null> {
  const sb = supabaseBrowser;
  const ledgerId = (entry.source_record_id || "").toString().trim();
  if (!ledgerId) return null;

  try {
    const { data, error } = await sb
      .from("verified_documents")
      .select("storage_bucket,storage_path,file_name,created_at")
      .eq("source_record_id", ledgerId)
      .order("created_at", { ascending: false })
      .limit(1);

    if (error || !data?.length) return null;

    const v = data[0] as any;
    const bucket = (v.storage_bucket as string) || "";
    const path = (v.storage_path as string) || "";
    if (!bucket || !path) return null;

    return {
      bucket_id: bucket,
      storage_path: path,
      file_name: (v.file_name as string) || entry.file_name || null,
      kind: "verified",
    };
  } catch {
    return null;
  }
}

/**
 * Signed URL with auto-repair (read-only)
 */
async function signedUrlFor(
  bucketId: string,
  storagePath: string,
  downloadName?: string | null,
  extraDirs?: string[]
) {
  const sb = supabaseBrowser;

  const wantPath = normalizeSlashes(storagePath).replace(/^\/+/, "");
  const opts: { download?: string } | undefined = downloadName ? { download: downloadName } : undefined;

  // 1) exact path
  {
    const { data, error } = await sb.storage.from(bucketId).createSignedUrl(wantPath, 60 * 10, opts);
    if (!error && data?.signedUrl) {
      return { signedUrl: data.signedUrl, resolvedBucket: bucketId, resolvedPath: wantPath };
    }
    if (error && !looksLikeNotFound(error)) throw error;
  }

  // 2) directory repair
  const dir = dirOf(wantPath);
  const base = baseOf(wantPath);
  const uuidPrefix = extractUuidPrefix(base);

  const candidateDirs = new Set<string>();
  if (dir) candidateDirs.add(dir);

  if (extraDirs?.length) {
    for (const x of extraDirs) {
      const nx = normalizeSlashes(String(x || ""))
        .replace(/^\/+/, "")
        .replace(/\/+$/, "");
      if (nx) candidateDirs.add(nx);
    }
  }

  if (/\/resolutions\b/i.test(dir)) {
    candidateDirs.add(dir.replace(/\/resolutions\b/i, "/resolutions"));
    candidateDirs.add(dir.replace(/\/resolutions\b/i, "/Resolutions"));
  }

  const candidates: { name: string; updated_at?: string }[] = [];

  for (const d of Array.from(candidateDirs)) {
    const { data: list, error: listErr } = await sb.storage.from(bucketId).list(d, {
      limit: 200,
      sortBy: { column: "updated_at", order: "desc" },
    });
    if (listErr || !list) continue;

    for (const it of list as any[]) {
      if (!it?.name) continue;
      const full = d ? `${d}/${it.name}` : it.name;
      candidates.push({ name: full, updated_at: it.updated_at });
    }
  }

  let filtered = candidates.filter((c) => c.name.toLowerCase().endsWith(".pdf"));

  if (uuidPrefix) {
    const up = uuidPrefix.toLowerCase();
    filtered = filtered.filter((c) => baseOf(c.name).toLowerCase().startsWith(up));
  } else {
    const b = base.toLowerCase().replace(/\.pdf$/i, "");
    filtered = filtered.filter((c) => baseOf(c.name).toLowerCase().includes(b));
  }

  const signedVariant = filtered.find((c) => baseOf(c.name).toLowerCase().includes("-signed"));
  const best =
    signedVariant ||
    filtered.sort((a, b) => {
      const ta = a.updated_at ? Date.parse(a.updated_at) : 0;
      const tb = b.updated_at ? Date.parse(b.updated_at) : 0;
      return tb - ta;
    })[0];

  if (!best?.name) {
    throw new Error(`Object not found. No matching PDF in bucket "${bucketId}" for "${wantPath}".`);
  }

  const { data: data2, error: err2 } = await sb.storage.from(bucketId).createSignedUrl(best.name, 60 * 10, opts);
  if (err2) throw err2;
  if (!data2?.signedUrl) throw new Error("Signed URL generation failed.");

  return { signedUrl: data2.signedUrl, resolvedBucket: bucketId, resolvedPath: best.name };
}

function titleCaseSegment(s: string) {
  if (!s) return s;
  const cleaned = s.replace(/[_-]+/g, " ").trim();
  if (!cleaned) return s;
  return cleaned
    .split(" ")
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p))
    .join("");
}

function extraDirsForEntry(entityKey: string, e: EntryWithDoc) {
  const ek = (entityKey || "").trim();
  if (!ek) return [];
  const dk = (e.domain_key || "").trim();
  const dkTitle = dk ? titleCaseSegment(dk) : "";
  const dirs = [`${ek}/Resolutions`, `${ek}/resolutions`];
  if (dk) dirs.push(`${ek}/${dk}`);
  if (dkTitle) dirs.push(`${ek}/${dkTitle}`);
  return uniq(
    dirs
      .map((d) => normalizeSlashes(d).replace(/^\/+/, "").replace(/\/+$/, ""))
      .filter(Boolean)
  );
}

async function bestSignedUrlForMinuteBookEvidence(
  entityKey: string,
  selected: EntryWithDoc,
  official: OfficialArtifact | null,
  downloadName?: string | null
) {
  if (official?.bucket_id && official?.storage_path) {
    return signedUrlFor(official.bucket_id, official.storage_path, downloadName);
  }

  if (!selected.storage_path) {
    throw new Error("No storage_path on the primary document.");
  }

  const path = normalizeSlashes(selected.storage_path).replace(/^\/+/, "");
  const buckets = bucketCandidatesForPath(path);

  let lastErr: unknown = null;

  for (const bucket of buckets) {
    try {
      return await signedUrlFor(bucket, path, downloadName, extraDirsForEntry(entityKey, selected));
    } catch (e) {
      lastErr = e;
    }
  }

  const msg = lastErr instanceof Error ? lastErr.message : "Object not found in candidate buckets.";
  throw new Error(msg);
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

  // show what actually got signed (bucket/path)
  const [resolvedBucket, setResolvedBucket] = useState<string | null>(null);
  const [resolvedPath, setResolvedPath] = useState<string | null>(null);

  // mobile rails / sheets
  const [mobileDomainsOpen, setMobileDomainsOpen] = useState(false);
  const [mobileReaderOpen, setMobileReaderOpen] = useState(false);

  // reader overlay (desktop + mobile)
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
      setResolvedBucket(null);
      setResolvedPath(null);
      setMobileReaderOpen(false);

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

        merged.sort((a, b) => getCreatedAtMs(b.created_at) - getCreatedAtMs(a.created_at));

        setEntries(merged);
        setSelectedId(merged[0]?.id ?? null);

        if (activeDomainKey !== "all") {
          const exists = domains.some((d) => d.key === activeDomainKey);
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
    let list = entries;

    if (activeDomainKey !== "all") {
      list = list.filter((e) => (e.domain_key || "") === activeDomainKey);
    }

    if (q) {
      list = list.filter((e) => {
        const hay = [
          e.title || "",
          e.entry_type || "",
          e.domain_key || "",
          e.section_name || "",
          e.file_name || "",
          e.storage_path || "",
          e.file_hash || "",
          e.source_record_id || "",
        ]
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      });
    }

    return [...list].sort((a, b) => getCreatedAtMs(b.created_at) - getCreatedAtMs(a.created_at));
  }, [entries, activeDomainKey, query]);

  const selected = useMemo(() => {
    if (!selectedId) return null;
    return entries.find((e) => e.id === selectedId) || null;
  }, [entries, selectedId]);

  const domainCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of domains) m.set(d.key, 0);
    for (const e of entries) {
      if (e.domain_key) m.set(e.domain_key, (m.get(e.domain_key) || 0) + 1);
    }
    return m;
  }, [domains, entries]);

  const activeDomainLabel = useMemo(() => {
    if (activeDomainKey === "all") return "All";
    return domains.find((d) => d.key === activeDomainKey)?.label || "Domain";
  }, [activeDomainKey, domains]);

  const authorityBadge = useMemo(() => {
    if (!selected) return null;
    if (official) return { label: "OFFICIAL", tone: "gold" as const };
    return { label: "UPLOADED", tone: "neutral" as const };
  }, [selected?.id, !!official]);

  // Resolve official artifact on selection
  useEffect(() => {
    let alive = true;
    (async () => {
      setOfficial(null);
      setPdfErr(null);
      setPreviewUrl(null);
      setResolvedBucket(null);
      setResolvedPath(null);

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
      const { signedUrl, resolvedBucket: b, resolvedPath: p } = await bestSignedUrlForMinuteBookEvidence(
        entityKey,
        selected,
        official,
        null
      );

      setPreviewUrl(signedUrl);
      setResolvedBucket(b);
      setResolvedPath(p);

      if (openReader) setMobileReaderOpen(true);
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
      const { signedUrl, resolvedBucket: b, resolvedPath: p } = await bestSignedUrlForMinuteBookEvidence(
        entityKey,
        selected,
        official,
        name
      );

      setResolvedBucket(b);
      setResolvedPath(p);

      window.open(signedUrl, "_blank", "noopener,noreferrer");
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
      if (previewUrl) {
        window.open(previewUrl, "_blank", "noopener,noreferrer");
        return;
      }

      const { signedUrl, resolvedBucket: b, resolvedPath: p } = await bestSignedUrlForMinuteBookEvidence(
        entityKey,
        selected,
        official,
        null
      );

      setResolvedBucket(b);
      setResolvedPath(p);

      window.open(signedUrl, "_blank", "noopener,noreferrer");
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

      const { data, error } = await sb.rpc("delete_minute_book_entry_and_files", {
        p_entry_id: selected.id,
        p_reason: deleteReason?.trim() || null,
      });

      if (error) throw error;

      const res = (data ?? {}) as DeleteResult;
      if (!res.ok) throw new Error("Delete failed (no ok=true returned).");

      setDeleteOpen(false);
      setDeleteReason("");
      setMobileReaderOpen(false);
      setPreviewUrl(null);
      setResolvedBucket(null);
      setResolvedPath(null);

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

        merged.sort((a, b) => getCreatedAtMs(b.created_at) - getCreatedAtMs(a.created_at));
        setEntries(merged);
        setSelectedId(merged[0]?.id ?? null);
      }
    } catch (e: unknown) {
      setDeleteErr(e instanceof Error ? e.message : "Delete failed.");
    } finally {
      setDeleteBusy(false);
    }
  }

  /* ---------------- UI atoms ---------------- */

  const Shell = ({ children }: { children: React.ReactNode }) => (
    <div className="w-full">
      {/* OS-native spacing (no module-owned viewport/blackbox) */}
      <div className="mx-auto w-full max-w-[1400px] px-3 sm:px-4 pb-10 pt-4 sm:pt-6">{children}</div>
    </div>
  );

  const GlassCard = ({
    className,
    children,
  }: {
    className?: string;
    children: React.ReactNode;
  }) => (
    <div
      className={cx(
        "rounded-3xl border border-white/10 bg-black/20 shadow-[0_28px_120px_rgba(0,0,0,0.55)] overflow-hidden",
        className
      )}
    >
      {children}
    </div>
  );

  const CardHeader = ({ children }: { children: React.ReactNode }) => (
    <div className="border-b border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent px-4 sm:px-5 py-4">
      {children}
    </div>
  );

  const CardBody = ({ className, children }: { className?: string; children: React.ReactNode }) => (
    <div className={cx("px-4 sm:px-5 py-4", className)}>{children}</div>
  );

  /* ---------------- render ---------------- */

  return (
    <Shell>
      {/* OS page header */}
      <div className="mb-3 sm:mb-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] sm:text-xs tracking-[0.3em] uppercase text-slate-500">CI • Archive</div>
          <h1 className="mt-1 text-lg sm:text-xl font-semibold text-slate-50 truncate">Minute Book</h1>
          <p className="mt-1 text-[11px] sm:text-xs text-slate-400">
            Evidence-first registry indexed by governance domain. Official artifacts are preferred when linked.
          </p>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          <Link
            href="/ci-archive"
            className="hidden sm:inline-flex rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7"
          >
            Launchpad
          </Link>
          <Link
            href="/ci-archive/upload"
            className="rounded-full border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-amber-200 hover:bg-amber-500/15"
          >
            Upload →
          </Link>
        </div>
      </div>

      {!entityKey ? (
        <GlassCard>
          <CardBody>
            <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-slate-200">
              Select an entity in the OS bar to view Minute Book records.
            </div>
          </CardBody>
        </GlassCard>
      ) : (
        <>
          {/* MOBILE TOOLBAR (domains + reader) */}
          <div className="sm:hidden mb-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setMobileDomainsOpen(true)}
              className="flex-1 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-left"
            >
              <div className="text-[10px] uppercase tracking-[0.25em] text-slate-500">Domain</div>
              <div className="mt-1 text-sm font-semibold text-slate-100 truncate">{activeDomainLabel}</div>
            </button>

            <button
              type="button"
              onClick={async () => {
                await ensurePreviewUrl(true);
              }}
              disabled={!selected || pdfBusy}
              className={cx(
                "rounded-2xl px-4 py-3 border text-sm font-semibold",
                !selected || pdfBusy
                  ? "border-white/10 bg-white/5 text-slate-500"
                  : "border-amber-500/40 bg-amber-500/10 text-amber-200"
              )}
            >
              Reader
            </button>
          </div>

          {/* DESKTOP: 3-column | MOBILE: 1-column rail */}
          <div className="grid grid-cols-12 gap-3 sm:gap-4">
            {/* DOMAINS (desktop) */}
            <div className="hidden sm:block col-span-12 lg:col-span-3">
              <GlassCard>
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-200">Domains</div>
                      <div className="text-[11px] text-slate-500">Source: governance_domains</div>
                    </div>
                    <div className="text-[10px] uppercase tracking-[0.25em] text-slate-500">{domains.length || "—"}</div>
                  </div>
                </CardHeader>

                <CardBody className="pt-3">
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-2 max-h-[60vh] overflow-y-auto">
                    <button
                      type="button"
                      onClick={() => setActiveDomainKey("all")}
                      className={cx(
                        "group w-full flex items-center justify-between gap-3 px-3 py-2 rounded-2xl transition border",
                        activeDomainKey === "all"
                          ? "bg-amber-500/10 border-amber-500/40"
                          : "bg-transparent border-transparent hover:bg-white/5 hover:border-amber-500/25"
                      )}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <span className="w-7 h-7 grid place-items-center rounded-xl border border-white/10 bg-black/20 text-[12px]">
                          ◆
                        </span>
                        <span className="text-sm text-slate-100 truncate">All</span>
                      </span>
                      <span className="text-[11px] text-slate-400">{entries.length}</span>
                    </button>

                    <div className="mt-2 space-y-1">
                      {domains.map((d) => {
                        const active = d.key === activeDomainKey;
                        const count = domainCounts.get(d.key) || 0;
                        const icon = DOMAIN_ICON[d.key] || "•";

                        return (
                          <button
                            key={d.key}
                            type="button"
                            onClick={() => setActiveDomainKey(d.key)}
                            className={cx(
                              "group w-full flex items-center justify-between gap-3 px-3 py-2 rounded-2xl transition border",
                              active
                                ? "bg-amber-500/10 border-amber-500/40"
                                : "bg-transparent border-transparent hover:bg-white/5 hover:border-amber-500/25"
                            )}
                          >
                            <span className="flex items-center gap-2 min-w-0">
                              <span className="w-7 h-7 grid place-items-center rounded-xl border border-white/10 bg-black/20 text-[12px]">
                                {icon}
                              </span>
                              <span className="text-sm text-slate-100 truncate">{d.label}</span>
                            </span>
                            <span className={cx("text-[11px]", count ? "text-amber-200/80" : "text-slate-500")}>
                              {count}
                            </span>
                          </button>
                        );
                      })}
                    </div>

                    {err ? (
                      <div className="mt-3 rounded-2xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-[11px] text-red-200">
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
                </CardBody>
              </GlassCard>
            </div>

            {/* ENTRIES rail */}
            <div className="col-span-12 lg:col-span-5">
              <GlassCard>
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-200">Registry Entries</div>
                      <div className="text-[11px] text-slate-500">
                        {loading ? "Loading…" : `${filteredEntries.length} item(s)`} •{" "}
                        <span className="text-slate-300">{activeDomainLabel}</span>
                      </div>
                    </div>
                    <span className="hidden sm:inline-flex px-2 py-0.5 rounded-full bg-sky-500/10 border border-sky-500/30 text-[10px] uppercase tracking-[0.18em] text-sky-200">
                      Evidence Index
                    </span>
                  </div>
                </CardHeader>

                <CardBody className="pt-3">
                  <div className="mb-3">
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search title, hash, path…"
                      className="w-full rounded-2xl bg-black/20 border border-white/10 px-3 py-3 text-sm text-slate-100 placeholder:text-slate-600 outline-none focus:border-amber-500/40"
                    />
                  </div>

                  <div className="rounded-2xl border border-white/10 bg-black/20 overflow-hidden max-h-[60vh] sm:max-h-[70vh] overflow-y-auto">
                    {loading ? (
                      <div className="p-4 text-[11px] text-slate-400">Loading entries…</div>
                    ) : filteredEntries.length === 0 ? (
                      <div className="p-4 text-[11px] text-slate-400">
                        No records filed under <span className="text-slate-200">{activeDomainLabel}</span> yet.
                        <div className="mt-2 text-[10px] text-slate-500">Upload later — it will appear here automatically.</div>
                      </div>
                    ) : (
                      filteredEntries.map((e) => {
                        const active = e.id === selectedId;
                        const createdAt = e.created_at ? new Date(e.created_at).toLocaleString() : "—";

                        return (
                          <button
                            key={e.id}
                            type="button"
                            onClick={() => {
                              setSelectedId(e.id);
                              // iPhone: tap record → open reader quickly (but don’t force-load yet)
                              // keep behavior calm; user can hit Reader button
                            }}
                            className={cx(
                              "w-full text-left px-4 py-4 border-b border-white/10 last:border-b-0 transition",
                              active ? "bg-white/5" : "hover:bg-white/5"
                            )}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="text-sm font-semibold text-slate-100 line-clamp-2">
                                  {e.title || e.file_name || "Untitled filing"}
                                </div>
                                <div className="mt-1 text-[11px] text-slate-400 flex items-center gap-2 flex-wrap">
                                  <span className="capitalize">{e.entry_type || "document"}</span>
                                  <span className="w-1 h-1 rounded-full bg-slate-600" />
                                  <span className="text-slate-500">{createdAt}</span>
                                  <span className="w-1 h-1 rounded-full bg-slate-700" />
                                  <span className="text-slate-500">{fmtBytes(e.file_size)}</span>
                                </div>
                              </div>

                              {official && selectedId === e.id ? (
                                <span className="shrink-0 px-2 py-1 rounded-full bg-amber-500/10 border border-amber-500/30 text-[10px] uppercase tracking-[0.18em] text-amber-200">
                                  OFFICIAL
                                </span>
                              ) : null}
                            </div>
                          </button>
                        );
                      })
                    )}
                  </div>

                  {err ? (
                    <div className="mt-3 rounded-2xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-[11px] text-red-200">
                      {err}
                    </div>
                  ) : null}
                </CardBody>
              </GlassCard>
            </div>

            {/* EVIDENCE (desktop only; mobile uses Reader Sheet) */}
            <div className="hidden lg:block col-span-12 lg:col-span-4">
              <GlassCard>
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-200">Evidence</div>
                      <div className="text-[11px] text-slate-500">Reader-first • Metadata secondary</div>
                    </div>

                    {authorityBadge ? (
                      <span
                        className={cx(
                          "px-2 py-0.5 rounded-full border text-[10px] uppercase tracking-[0.18em] font-semibold",
                          authorityBadge.tone === "gold"
                            ? "bg-amber-500/10 border-amber-500/40 text-amber-200"
                            : "bg-white/5 border-white/10 text-slate-200"
                        )}
                      >
                        {authorityBadge.label}
                      </span>
                    ) : null}
                  </div>
                </CardHeader>

                <CardBody className="pt-3">
                  {!selected ? (
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-[11px] text-slate-400">
                      Select a record to inspect evidence.
                    </div>
                  ) : (
                    <>
                      <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                        <div className="text-sm font-semibold text-slate-100">
                          {selected.title || selected.file_name || "Untitled filing"}
                        </div>

                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <span className="px-2 py-1 rounded-full bg-white/5 border border-white/10 text-[11px] text-slate-200 capitalize">
                            {selected.entry_type || "document"}
                          </span>
                          <span className="px-2 py-1 rounded-full bg-amber-500/10 border border-amber-500/30 text-[11px] text-amber-200">
                            {domains.find((d) => d.key === selected.domain_key)?.label || norm(selected.domain_key, "—")}
                          </span>
                        </div>

                        {pdfErr ? (
                          <div className="mt-3 rounded-2xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-[11px] text-red-200">
                            {pdfErr}
                          </div>
                        ) : null}

                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => ensurePreviewUrl(true)}
                            disabled={pdfBusy}
                            className={cx(
                              "rounded-full px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition",
                              pdfBusy ? "bg-amber-500/20 text-amber-200/60" : "bg-amber-500 text-black hover:bg-amber-400"
                            )}
                            title="Open PDF in Reader Mode"
                          >
                            Reader
                          </button>

                          <button
                            type="button"
                            onClick={downloadPdf}
                            disabled={pdfBusy}
                            className={cx(
                              "rounded-full px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition",
                              pdfBusy ? "bg-white/10 text-slate-200/60" : "bg-slate-200 text-black hover:bg-white"
                            )}
                            title="Download PDF"
                          >
                            Download
                          </button>

                          <button
                            type="button"
                            onClick={openNewTab}
                            disabled={pdfBusy}
                            className={cx(
                              "rounded-full px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition border",
                              pdfBusy
                                ? "bg-white/5 text-slate-200/60 border-white/10"
                                : "bg-white/5 border-white/10 text-slate-200 hover:bg-white/7 hover:border-amber-500/25"
                            )}
                            title="Open in new tab"
                          >
                            Open
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              setDeleteErr(null);
                              setDeleteReason("");
                              setDeleteOpen(true);
                            }}
                            className="rounded-full px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition border border-red-500/30 bg-red-500/10 text-red-200 hover:bg-red-500/15"
                            title="Hard delete entry + files"
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
                            Refresh
                          </button>
                        </div>
                      </div>

                      <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 overflow-hidden h-[46vh]">
                        {previewUrl ? (
                          <iframe title="PDF Preview" src={previewUrl} className="h-full w-full" />
                        ) : (
                          <div className="h-full w-full grid place-items-center text-[11px] text-slate-500">
                            Click <span className="text-slate-200 font-semibold">Reader</span> to open a full-size view.
                          </div>
                        )}
                      </div>

                      <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 p-4">
                        <div className="flex items-center justify-between mb-2">
                          <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">Metadata</div>
                          <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-[10px] tracking-[0.18em] uppercase text-slate-300">
                            secondary
                          </span>
                        </div>

                        <div className="space-y-2">
                          <details className="rounded-2xl border border-white/10 bg-black/20 px-3 py-2">
                            <summary className="cursor-pointer text-[11px] text-slate-200">Storage</summary>
                            <div className="mt-2 space-y-1 text-[11px] text-slate-300">
                              <div className="flex items-start justify-between gap-3">
                                <span className="text-slate-500">Primary Path</span>
                                <span className="text-right font-mono break-all">{norm(selected.storage_path, "—")}</span>
                              </div>
                              <div className="flex items-start justify-between gap-3">
                                <span className="text-slate-500">Source Record</span>
                                <span className="text-right font-mono break-all">{norm(selected.source_record_id, "—")}</span>
                              </div>
                              <div className="flex items-start justify-between gap-3">
                                <span className="text-slate-500">Resolved Bucket</span>
                                <span className="text-right font-mono break-all">{norm(resolvedBucket, "—")}</span>
                              </div>
                              <div className="flex items-start justify-between gap-3">
                                <span className="text-slate-500">Resolved Path</span>
                                <span className="text-right font-mono break-all">{norm(resolvedPath, "—")}</span>
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

                          <details open className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-3 py-2">
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

                          <details className="rounded-2xl border border-white/10 bg-black/20 px-3 py-2">
                            <summary className="cursor-pointer text-[11px] text-slate-200">Audit</summary>
                            <div className="mt-2 space-y-1 text-[11px] text-slate-300">
                              <div className="flex items-start justify-between gap-3">
                                <span className="text-slate-500">Created</span>
                                <span className="text-right">
                                  {selected.created_at ? new Date(selected.created_at).toLocaleString() : "—"}
                                </span>
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
                </CardBody>
              </GlassCard>
            </div>
          </div>
        </>
      )}

      {/* ---------------- MOBILE: Domains Sheet ---------------- */}
      {mobileDomainsOpen ? (
        <div className="fixed inset-0 z-[90] bg-black/70 backdrop-blur-xl flex items-end sm:hidden">
          <div className="w-full rounded-t-3xl border-t border-white/10 bg-slate-950/90 max-h-[85vh] overflow-hidden">
            <div className="px-4 py-4 border-b border-white/10 flex items-center justify-between">
              <div>
                <div className="text-[10px] uppercase tracking-[0.3em] text-slate-500">Domains</div>
                <div className="mt-1 text-sm font-semibold text-slate-100">Select a domain</div>
              </div>
              <button
                type="button"
                onClick={() => setMobileDomainsOpen(false)}
                className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[11px] font-semibold text-slate-200"
              >
                Close
              </button>
            </div>

            <div className="p-3 overflow-y-auto">
              <button
                type="button"
                onClick={() => {
                  setActiveDomainKey("all");
                  setMobileDomainsOpen(false);
                }}
                className={cx(
                  "w-full flex items-center justify-between gap-3 px-4 py-3 rounded-2xl border",
                  activeDomainKey === "all" ? "border-amber-500/40 bg-amber-500/10" : "border-white/10 bg-white/5"
                )}
              >
                <span className="text-sm font-semibold text-slate-100">All</span>
                <span className="text-[11px] text-slate-400">{entries.length}</span>
              </button>

              <div className="mt-2 space-y-2">
                {domains.map((d) => {
                  const count = domainCounts.get(d.key) || 0;
                  const active = d.key === activeDomainKey;
                  const icon = DOMAIN_ICON[d.key] || "•";

                  return (
                    <button
                      key={d.key}
                      type="button"
                      onClick={() => {
                        setActiveDomainKey(d.key);
                        setMobileDomainsOpen(false);
                      }}
                      className={cx(
                        "w-full flex items-center justify-between gap-3 px-4 py-3 rounded-2xl border",
                        active ? "border-amber-500/40 bg-amber-500/10" : "border-white/10 bg-white/5"
                      )}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <span className="w-8 h-8 grid place-items-center rounded-2xl border border-white/10 bg-black/20">
                          {icon}
                        </span>
                        <span className="text-sm font-semibold text-slate-100 truncate">{d.label}</span>
                      </span>
                      <span className={cx("text-[11px]", count ? "text-amber-200" : "text-slate-500")}>{count}</span>
                    </button>
                  );
                })}
              </div>

              {err ? (
                <div className="mt-3 rounded-2xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-[11px] text-red-200">
                  {err}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {/* ---------------- Reader Sheet (mobile + desktop overlay) ---------------- */}
      {mobileReaderOpen ? (
        <div
          className={cx(
            "fixed inset-0 z-[95] flex items-end sm:items-center sm:justify-center",
            readerTone === "glass" ? "bg-black/70 backdrop-blur-xl" : "bg-black"
          )}
        >
          <div
            className={cx(
              "w-full sm:max-w-[1200px] sm:h-[86vh] h-[92vh] rounded-t-3xl sm:rounded-3xl border border-white/10 bg-slate-950/85 overflow-hidden flex flex-col"
            )}
          >
            <div className="px-4 sm:px-5 py-4 border-b border-white/10 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-[0.3em] text-slate-500">Reader</div>
                <div className="mt-1 text-sm font-semibold text-slate-100 truncate">
                  {selected?.title || selected?.file_name || "Document"}
                </div>
                <div className="mt-1 text-[11px] text-slate-500">
                  {official ? "Official preferred • " : "Uploaded evidence • "}
                  {showHashInReader ? <span className="font-mono">{shortHash(selected?.file_hash || null)}</span> : null}
                </div>
                {resolvedBucket ? (
                  <div className="mt-1 text-[10px] text-slate-600">
                    Resolved: <span className="font-mono text-slate-300">{resolvedBucket}</span>{" "}
                    <span className="text-slate-700">•</span>{" "}
                    <span className="font-mono text-slate-400">{shortHash(resolvedPath || null)}</span>
                  </div>
                ) : null}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setReaderTone((t) => (t === "glass" ? "solid" : "glass"))}
                  className="hidden sm:inline-flex rounded-full border border-white/10 bg-white/5 px-3 py-2 text-[11px] text-slate-200 hover:border-amber-500/25"
                  title="Toggle overlay tone"
                >
                  {readerTone === "glass" ? "Glass" : "Solid"}
                </button>

                <button
                  type="button"
                  onClick={() => setShowHashInReader((v) => !v)}
                  className="hidden sm:inline-flex rounded-full border border-white/10 bg-white/5 px-3 py-2 text-[11px] text-slate-200 hover:border-amber-500/25"
                  title="Toggle hash in header"
                >
                  Hash
                </button>

                <button
                  type="button"
                  onClick={() => setMobileReaderOpen(false)}
                  className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[11px] font-semibold text-slate-200 hover:bg-white/7"
                >
                  Close
                </button>
              </div>
            </div>

            <div className="flex-1 min-h-0 bg-black">
              {previewUrl ? (
                <iframe title="PDF Reader" src={previewUrl} className="h-full w-full" />
              ) : (
                <div className="h-full w-full grid place-items-center text-[11px] text-slate-400 px-4 text-center">
                  <div>
                    <div className="text-slate-200 font-semibold">No preview loaded</div>
                    <div className="mt-1 text-slate-500">Close, then tap Reader again.</div>
                  </div>
                </div>
              )}
            </div>

            <div className="px-4 sm:px-5 py-3 border-t border-white/10 flex items-center justify-between text-[11px] text-slate-500">
              <span className="hidden sm:inline">
                Record ID: <span className="font-mono text-slate-300">{selected?.id || "—"}</span>
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={downloadPdf}
                  className="rounded-full bg-slate-200 text-black px-4 py-2 text-[11px] font-semibold hover:bg-white"
                >
                  Download
                </button>
                <button
                  type="button"
                  onClick={openNewTab}
                  className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[11px] font-semibold text-slate-200 hover:bg-white/7"
                >
                  Open
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ---------------- Delete Confirm Modal ---------------- */}
      {deleteOpen && selected ? (
        <div className="fixed inset-0 z-[99] bg-black/70 backdrop-blur-xl flex items-center justify-center p-4">
          <div className="w-full max-w-[720px] rounded-3xl border border-red-500/30 bg-slate-950/85 shadow-[0_0_70px_rgba(0,0,0,0.55)] overflow-hidden">
            <div className="px-6 py-5 border-b border-white/10">
              <div className="text-xs tracking-[0.3em] uppercase text-red-300">HARD DELETE</div>
              <div className="mt-2 text-lg font-semibold text-slate-100">Delete Minute Book entry?</div>
              <p className="mt-2 text-sm text-slate-300">
                This permanently removes the entry and all related files. Owner/Admin only.
              </p>
              <div className="mt-2 text-[11px] text-slate-500">
                Record:{" "}
                <span className="text-slate-200 font-semibold">{selected.title || selected.file_name || "Untitled filing"}</span>{" "}
                • <span className="font-mono">{shortHash(selected.file_hash || null)}</span>
              </div>
            </div>

            <div className="px-6 py-5">
              <label className="text-[11px] uppercase tracking-[0.2em] text-slate-500">Reason (required)</label>
              <input
                value={deleteReason}
                onChange={(e) => setDeleteReason(e.target.value)}
                placeholder="e.g., Wrong entity / wrong domain / duplicate / test upload"
                className="mt-2 w-full rounded-2xl bg-black/30 border border-white/10 px-3 py-3 text-sm text-slate-100 placeholder:text-slate-600 outline-none focus:border-red-500/40"
              />

              {deleteErr ? (
                <div className="mt-3 rounded-2xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-[11px] text-red-200">
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
                  className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7"
                >
                  Cancel
                </button>

                <button
                  type="button"
                  disabled={deleteBusy || deleteReason.trim().length < 3}
                  onClick={runDelete}
                  className={cx(
                    "rounded-full px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition",
                    deleteBusy || deleteReason.trim().length < 3
                      ? "bg-red-500/20 text-red-200/60 cursor-not-allowed"
                      : "bg-red-500 text-white hover:bg-red-400"
                  )}
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

      {/* iPhone sticky bottom bar (thumb-safe) */}
      {entityKey ? (
        <div className="lg:hidden fixed bottom-0 left-0 right-0 z-[60] pb-[env(safe-area-inset-bottom)]">
          <div className="mx-auto max-w-[1400px] px-3">
            <div className="mb-2 rounded-2xl border border-white/10 bg-slate-950/80 backdrop-blur-xl px-3 py-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setMobileDomainsOpen(true)}
                className="flex-1 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-left"
              >
                <div className="text-[9px] uppercase tracking-[0.25em] text-slate-500">Domain</div>
                <div className="mt-0.5 text-[11px] font-semibold text-slate-100 truncate">{activeDomainLabel}</div>
              </button>

              <button
                type="button"
                onClick={() => ensurePreviewUrl(true)}
                disabled={!selected || pdfBusy}
                className={cx(
                  "rounded-xl px-4 py-3 border text-[11px] font-semibold tracking-[0.18em] uppercase",
                  !selected || pdfBusy
                    ? "border-white/10 bg-white/5 text-slate-500"
                    : "border-amber-500/40 bg-amber-500/10 text-amber-200"
                )}
              >
                Reader
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </Shell>
  );
}
