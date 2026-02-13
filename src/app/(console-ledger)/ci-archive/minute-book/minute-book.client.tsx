// src/app/(os)/ci-archive/minute-book/minute-book.client.tsx
"use client";
export const dynamic = "force-dynamic";

/**
 * CI-Archive → Minute Book (PRODUCTION — LOCKED CONTRACT)
 * ✅ SAME data sources + logic (NO wiring changes)
 * ✅ OS-native surface (matches Verified + Forge 1:1)
 * ✅ iPhone-first: Rail → Reader Sheet (full screen), zero double-scroll
 * ✅ Desktop: 3-column layout preserved (Domains | Entries | Evidence)
 * ✅ Lane-safe: respects RoT vs SANDBOX (via governance_ledger.is_test)
 *
 * Phase-2 enhancement (UI-only, NO schema/wiring drift):
 * ✅ Discovery Export button → calls Edge Function export-discovery-package (non-mutating ZIP)
 *    - body: { ledger_id } OR { entry_id }
 *    - Edge returns a ZIP download (bytes) OR { ok:true, url }
 *
 * ✅ Promote to Verified Registry (Minute Book Entry Certification)
 *    - PROMOTE IS UPLOADS-ONLY (source_record_id must be null)
 *    - calls Edge Function certify-minute-book-entry (mutating, controlled)
 *    - body: { entry_id, is_test, force? }  (actor resolved from JWT inside function)
 *    - expects: { ok:true, verified_document_id, reused?, verify_url? }
 *
 * ✅ IMPORTANT: verify.html is HASH-FIRST ONLY
 *    - Verify button opens verify.html?hash=<verified_documents.file_hash>
 */

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";

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
  source_record_id?: string | null; // governance_ledger.id (forge/ledger-origin)
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

  lane_is_test?: boolean | null;
  ledger_status?: string | null;
};

type OfficialArtifact = {
  bucket_id: string;
  storage_path: string;
  file_name?: string | null;
  kind?: "official" | "certified" | "verified";
  verified_document_id?: string | null;
  file_hash?: string | null; // ✅ used for verify.html (hash-first)
};

type DeleteResult = {
  ok?: boolean;
  entry_id?: string;
  entity_key?: string;
  deleted_storage_objects?: number;
  deleted_entry_rows?: number;
  reason?: string | null;
};

type ExportResult = {
  ok?: boolean;
  url?: string;
  error?: string;
  details?: unknown;
};

type PromoteResult = {
  ok?: boolean;
  entry_id?: string;
  is_test?: boolean;
  verified_document_id?: string;
  reused?: boolean;
  verify_url?: string;
  error?: string;
  details?: unknown;
};

type VerifiedDocRow = {
  id: string;
  storage_bucket: string | null;
  storage_path: string | null;
  file_hash?: string | null;
  verification_level?: string | null;
  created_at?: string | null;
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

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      ta.style.top = "-9999px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Lane bucket heuristic (read-only, UI-only)
 */
function bucketCandidatesForPath(path: string) {
  const p = normalizeSlashes(path).toLowerCase();
  const candidates: string[] = [];

  if (p.startsWith("sandbox/")) candidates.push("governance_sandbox");
  if (p.startsWith("truth/")) candidates.push("governance_truth");

  candidates.push("minute_book");
  candidates.push("governance_sandbox");

  return uniq(candidates);
}

/**
 * ✅ verify.html is hash-first only
 */
function buildVerifyHtmlUrlFromHash(hash: string) {
  const base = "https://sign.oasisintlholdings.com/verify.html";
  const u = new URL(base);
  u.searchParams.set("hash", hash);
  return u.toString();
}

function edgeInvokeMessage(error: any, data: any) {
  const a =
    (error?.context as any)?.error_description ||
    (error?.context as any)?.message ||
    error?.message ||
    "";
  const b = (data?.error as string) || "";
  const c = (typeof data?.details === "string" ? data.details : "") || "";
  const msg = [a, b, c].map((s) => String(s || "").trim()).filter(Boolean)[0];
  return msg || "Request failed.";
}

function safeZipNameFromSelected(e: EntryWithDoc) {
  const base = (e.title || e.file_name || "Oasis-Discovery-Export")
    .toString()
    .trim()
    .replace(/[\/\\]+/g, "-")
    .replace(/[^\w\-. ]+/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 90);
  return `${base || "Oasis-Discovery-Export"}.zip`;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2500);
}

/**
 * ✅ TS-safe: Uint8Array<ArrayBufferLike> → ArrayBuffer
 */
function u8ToArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(u8.byteLength);
  new Uint8Array(buf).set(u8);
  return buf;
}

/**
 * ✅ Robust ZIP handling:
 * - If response is Blob/ArrayBuffer/Uint8Array → build zip blob safely
 */
function asZipBlobOrNull(data: any): Blob | null {
  if (!data) return null;

  if (typeof Blob !== "undefined" && data instanceof Blob) return data;

  if (typeof ArrayBuffer !== "undefined" && data instanceof ArrayBuffer) {
    return new Blob([data], { type: "application/zip" });
  }

  if (typeof Uint8Array !== "undefined" && data instanceof Uint8Array) {
    const ab = u8ToArrayBuffer(data);
    return new Blob([ab], { type: "application/zip" });
  }

  if (data?.data && (data.data instanceof Uint8Array || data.data instanceof ArrayBuffer)) {
    const inner = data.data instanceof Uint8Array ? u8ToArrayBuffer(data.data) : data.data;
    return new Blob([inner], { type: "application/zip" });
  }

  return null;
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
    .select(
      "id,entry_id,file_path,file_name,file_hash,file_size,mime_type,version,uploaded_at,registry_visible"
    )
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
 * ✅ OFFICIAL resolver (read-only) — lane-aware (checks governance_ledger.is_test)
 */
async function resolveOfficialArtifact(
  _entityKey: string,
  entry: EntryWithDoc,
  laneIsTest: boolean
): Promise<OfficialArtifact | null> {
  const sb = supabaseBrowser;
  const ledgerId = (entry.source_record_id || "").toString().trim();
  if (!ledgerId) return null;

  try {
    const { data: gl } = await sb
      .from("governance_ledger")
      .select("id,is_test")
      .eq("id", ledgerId)
      .limit(1);

    const isTest = gl?.[0]?.is_test;
    if (typeof isTest === "boolean" && isTest !== laneIsTest) return null;

    const { data, error } = await sb
      .from("verified_documents")
      .select("id,storage_bucket,storage_path,file_hash,created_at")
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
      verified_document_id: (v.id as string) || null,
      file_hash: (v.file_hash as string) || null,
    };
  } catch {
    return null;
  }
}

/**
 * ✅ PROMOTED resolver (read-only) — Minute Book entry certification artifact
 */
async function resolvePromotedArtifact(
  entryId: string,
  laneIsTest: boolean
): Promise<OfficialArtifact | null> {
  const sb = supabaseBrowser;

  const { data, error } = await sb
    .from("verified_documents")
    .select("id,storage_bucket,storage_path,file_hash,verification_level,created_at")
    .eq("source_table", "minute_book_entries")
    .eq("source_record_id", entryId)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error || !data?.length) return null;

  const row = data[0] as unknown as VerifiedDocRow;

  const bucket = (row.storage_bucket || "").toString().trim();
  const path = (row.storage_path || "").toString().trim();
  if (!bucket || !path) return null;

  if (bucket === "governance_sandbox" && !laneIsTest) return null;
  if (bucket === "governance_truth" && laneIsTest) return null;

  const lvl = (row.verification_level || "").toLowerCase();
  const kind: OfficialArtifact["kind"] = lvl === "certified" ? "certified" : "verified";

  return {
    bucket_id: bucket,
    storage_path: path,
    kind,
    verified_document_id: row.id,
    file_hash: row.file_hash ?? null,
  };
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

  {
    const { data, error } = await sb.storage.from(bucketId).createSignedUrl(wantPath, 60 * 10, opts);
    if (!error && data?.signedUrl) {
      return { signedUrl: data.signedUrl, resolvedBucket: bucketId, resolvedPath: wantPath };
    }
    if (error && !looksLikeNotFound(error)) throw error;
  }

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

/* ---------------- ZIP EXPORT (FIXED) ---------------- */

/**
 * ✅ The Edge logs show: status 200 + content-type application/zip.
 * Supabase `functions.invoke()` often assumes JSON; so we fetch directly and download bytes.
 * NO new routes. NO backend changes.
 */
async function exportDiscoveryZipViaFetch(body: Record<string, any>, filename: string) {
  const sb = supabaseBrowser;

  const {
    data: { session },
  } = await sb.auth.getSession();

  const accessToken = session?.access_token;
  if (!accessToken) throw new Error("Not authenticated.");

  const anonKey =
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").toString().trim() ||
    // @ts-ignore
    (sb as any)?.supabaseKey ||
    "";

  const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/export-discovery-package`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
      apikey: anonKey,
    },
    body: JSON.stringify(body),
  });

  const ct = (res.headers.get("content-type") || "").toLowerCase();

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(txt || `Export failed (${res.status}).`);
  }

  // Variant: JSON {url}
  if (ct.includes("application/json")) {
    const json = (await res.json().catch(() => null)) as ExportResult | null;
    if (json?.url) {
      window.open(json.url, "_blank", "noopener,noreferrer");
      return;
    }
    throw new Error(json?.error || "Export failed (no url).");
  }

  // Variant: ZIP bytes
  if (ct.includes("application/zip") || ct.includes("application/octet-stream")) {
    const ab = await res.arrayBuffer();
    const blob = new Blob([ab], { type: "application/zip" });
    downloadBlob(blob, filename);
    return;
  }

  // fallback: try bytes anyway
  const ab = await res.arrayBuffer();
  const blob = new Blob([ab], { type: ct || "application/octet-stream" });
  downloadBlob(blob, filename);
}

export default function MinuteBookClient() {
  const { entityKey } = useEntity();
  const { env } = useOsEnv();
  const laneIsTest = env === "SANDBOX";

  const [domains, setDomains] = useState<GovernanceDomain[]>([]);
  const [activeDomainKey, setActiveDomainKey] = useState<string>("all");

  const [entries, setEntries] = useState<EntryWithDoc[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [query, setQuery] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);

  const [official, setOfficial] = useState<OfficialArtifact | null>(null);
  const [promoted, setPromoted] = useState<OfficialArtifact | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState<boolean>(false);
  const [pdfErr, setPdfErr] = useState<string | null>(null);

  const [resolvedBucket, setResolvedBucket] = useState<string | null>(null);
  const [resolvedPath, setResolvedPath] = useState<string | null>(null);

  const [mobileDomainsOpen, setMobileDomainsOpen] = useState(false);
  const [mobileReaderOpen, setMobileReaderOpen] = useState(false);

  const [readerTone, setReaderTone] = useState<"glass" | "solid">("glass");
  const [showHashInReader, setShowHashInReader] = useState<boolean>(true);

  const [deleteOpen, setDeleteOpen] = useState<boolean>(false);
  const [deleteReason, setDeleteReason] = useState<string>("");
  const [deleteBusy, setDeleteBusy] = useState<boolean>(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  const [exportBusy, setExportBusy] = useState<boolean>(false);
  const [exportErr, setExportErr] = useState<string | null>(null);

  const [promoteBusy, setPromoteBusy] = useState<boolean>(false);
  const [promoteErr, setPromoteErr] = useState<string | null>(null);

  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const selected = useMemo(() => {
    if (!selectedId) return null;
    return entries.find((e) => e.id === selectedId) || null;
  }, [entries, selectedId]);

  const isUploadEntry = useMemo(() => {
    if (!selected) return false;
    return !String(selected.source_record_id || "").trim();
  }, [selected?.id, selected?.source_record_id]);

  const canReissue = useMemo(() => {
    return !!promoted && isUploadEntry;
  }, [promoted, isUploadEntry]);

  const certifiedHash = useMemo(() => {
    return (promoted?.file_hash || "").toString().trim() || null;
  }, [promoted?.file_hash]);

  const officialHash = useMemo(() => {
    return (official?.file_hash || "").toString().trim() || null;
  }, [official?.file_hash]);

  const authorityBadge = useMemo(() => {
    if (!selected) return null;
    if (official) return { label: "OFFICIAL", tone: "gold" as const };
    if (promoted) return { label: "CERTIFIED", tone: "sky" as const };
    return { label: "UPLOADED", tone: "neutral" as const };
  }, [selected?.id, official, promoted]);

  const promoteDisabledReason = useMemo(() => {
    if (!selected) return "Select a record first.";
    if (!isUploadEntry) return "Not applicable: governance resolutions are certified via Forge automatically.";
    return null;
  }, [selected?.id, isUploadEntry]);

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

  // Load entries + docs + lane filter
  useEffect(() => {
    let alive = true;

    async function run() {
      setErr(null);
      setLoading(true);

      setEntries([]);
      setSelectedId(null);

      setOfficial(null);
      setPromoted(null);
      setPreviewUrl(null);
      setPdfErr(null);
      setResolvedBucket(null);
      setResolvedPath(null);
      setMobileReaderOpen(false);

      setExportErr(null);
      setExportBusy(false);

      setPromoteErr(null);
      setPromoteBusy(false);

      setCopiedKey(null);

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

        const recordIds = uniq(base.map((r) => r.source_record_id).filter(Boolean) as string[]);
        const laneMap = new Map<string, { is_test: boolean; status: string }>();

        if (recordIds.length) {
          const { data } = await supabaseBrowser
            .from("governance_ledger")
            .select("id,is_test,status")
            .in("id", recordIds);

          for (const r of data ?? []) {
            laneMap.set(String((r as any).id), {
              is_test: !!(r as any).is_test,
              status: String((r as any).status ?? ""),
            });
          }
        }

        const merged: EntryWithDoc[] = base.map((e: MinuteBookEntry) => {
          const doc = primary.get(e.id);
          const lm = e.source_record_id ? laneMap.get(String(e.source_record_id)) : null;

          return {
            ...e,
            document_id: doc?.id ?? null,
            storage_path: doc?.file_path ?? null,
            file_name: doc?.file_name ?? null,
            file_hash: doc?.file_hash ?? null,
            file_size: doc?.file_size ?? null,
            mime_type: doc?.mime_type ?? null,
            lane_is_test: lm?.is_test ?? null,
            ledger_status: lm?.status ?? null,
          };
        });

        const laneFiltered = merged.filter((r) => {
          if (r.lane_is_test === null || r.lane_is_test === undefined) return true;
          return r.lane_is_test === laneIsTest;
        });

        laneFiltered.sort((a, b) => getCreatedAtMs(b.created_at) - getCreatedAtMs(a.created_at));

        setEntries(laneFiltered);
        setSelectedId(laneFiltered[0]?.id ?? null);
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
  }, [entityKey, laneIsTest]);

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
          e.ledger_status || "",
        ]
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      });
    }

    return [...list].sort((a, b) => getCreatedAtMs(b.created_at) - getCreatedAtMs(a.created_at));
  }, [entries, activeDomainKey, query]);

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

  // Resolve official + promoted on selection
  useEffect(() => {
    let alive = true;
    (async () => {
      setOfficial(null);
      setPromoted(null);
      setPdfErr(null);
      setPreviewUrl(null);
      setResolvedBucket(null);
      setResolvedPath(null);

      setExportErr(null);
      setExportBusy(false);

      setPromoteErr(null);
      setPromoteBusy(false);

      setCopiedKey(null);

      if (!entityKey || !selected) return;

      setPdfBusy(true);
      try {
        const [off, prom] = await Promise.all([
          resolveOfficialArtifact(entityKey, selected, laneIsTest),
          resolvePromotedArtifact(selected.id, laneIsTest),
        ]);
        if (!alive) return;
        setOfficial(off);
        setPromoted(prom);
      } finally {
        if (alive) setPdfBusy(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [entityKey, selected?.id, laneIsTest]);

  async function ensurePreviewUrl(openReader: boolean) {
    if (!selected) return;

    setPdfErr(null);
    setPdfBusy(true);

    try {
      const preferred = official || promoted || null;
      const { signedUrl, resolvedBucket: b, resolvedPath: p } =
        await bestSignedUrlForMinuteBookEvidence(entityKey, selected, preferred, null);

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
      const preferred = official || promoted || null;

      const { signedUrl, resolvedBucket: b, resolvedPath: p } =
        await bestSignedUrlForMinuteBookEvidence(entityKey, selected, preferred, name);

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

      const preferred = official || promoted || null;

      const { signedUrl, resolvedBucket: b, resolvedPath: p } =
        await bestSignedUrlForMinuteBookEvidence(entityKey, selected, preferred, null);

      setResolvedBucket(b);
      setResolvedPath(p);

      window.open(signedUrl, "_blank", "noopener,noreferrer");
    } catch (e: unknown) {
      setPdfErr(e instanceof Error ? e.message : "Failed to open PDF.");
    } finally {
      setPdfBusy(false);
    }
  }

  // ✅ Discovery Export (FIXED)
  async function exportDiscoveryPackage() {
    if (!selected) return;

    setExportErr(null);
    setExportBusy(true);

    try {
      const ledgerId = (selected.source_record_id || "").toString().trim() || null;
      const entryId = (selected.id || "").toString().trim() || null;

      const body: Record<string, any> = ledgerId ? { ledger_id: ledgerId } : { entry_id: entryId };

      // First, try fetch-based ZIP download (matches your logs: 200 application/zip)
      await exportDiscoveryZipViaFetch(body, safeZipNameFromSelected(selected));
    } catch (e: unknown) {
      // Fallback to invoke() for deployments that return JSON {url}
      try {
        const ledgerId = (selected.source_record_id || "").toString().trim() || null;
        const entryId = (selected.id || "").toString().trim() || null;
        const body: Record<string, any> = ledgerId ? { ledger_id: ledgerId } : { entry_id: entryId };

        const { data, error } = await supabaseBrowser.functions.invoke("export-discovery-package", { body });

        if (error) {
          const msg = edgeInvokeMessage(error, data);
          throw new Error(msg);
        }

        if (data && typeof data === "object" && "url" in (data as any)) {
          const res = (data ?? {}) as ExportResult;
          if (!res.url) throw new Error(res.error || "Export failed (no url returned).");
          window.open(res.url, "_blank", "noopener,noreferrer");
          return;
        }

        const blob = asZipBlobOrNull(data);
        if (blob) {
          downloadBlob(blob, safeZipNameFromSelected(selected));
          return;
        }

        throw new Error(
          e instanceof Error ? e.message : "Export returned an unexpected response format."
        );
      } catch (inner: unknown) {
        setExportErr(inner instanceof Error ? inner.message : "Discovery Export failed.");
      }
    } finally {
      setExportBusy(false);
    }
  }

  async function promoteToVerifiedRegistry(opts?: { force?: boolean }) {
    if (!selected) return;

    if (!isUploadEntry) {
      setPromoteErr("Not applicable: governance resolutions are certified via Forge automatically.");
      return;
    }

    const force = !!opts?.force;

    setPromoteErr(null);
    setPromoteBusy(true);

    try {
      const { data, error } = await supabaseBrowser.functions.invoke("certify-minute-book-entry", {
        body: {
          entry_id: selected.id,
          is_test: laneIsTest,
          force,
        },
      });

      if (error) {
        const msg = edgeInvokeMessage(error, data);
        throw new Error(msg);
      }

      const res = (data ?? {}) as PromoteResult;
      if (!res.ok || !res.verified_document_id) {
        const msg =
          (typeof res.error === "string" && res.error) ||
          "Certification failed (no ok=true/verified_document_id).";
        throw new Error(msg);
      }

      const prom = await resolvePromotedArtifact(selected.id, laneIsTest);
      setPromoted(prom);

      if (previewUrl) {
        await ensurePreviewUrl(false);
      }
    } catch (e: unknown) {
      setPromoteErr(e instanceof Error ? e.message : "Certification failed.");
    } finally {
      setPromoteBusy(false);
    }
  }

  function openVerifyTerminal() {
    if (!selected) return;
    const hash = (isUploadEntry ? certifiedHash : null) || officialHash || certifiedHash || null;
    if (!hash) return;
    window.open(buildVerifyHtmlUrlFromHash(hash), "_blank", "noopener,noreferrer");
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

      setExportErr(null);
      setExportBusy(false);

      setPromoteErr(null);
      setPromoteBusy(false);
      setPromoted(null);
      setOfficial(null);

      setCopiedKey(null);

      if (entityKey) {
        const base = await loadEntries(entityKey);
        const ids = base.map((e: MinuteBookEntry) => e.id);
        const docs = await loadSupportingDocs(ids);
        const primary = pickPrimaryDocByEntry(docs);

        const recordIds = uniq(base.map((r) => r.source_record_id).filter(Boolean) as string[]);
        const laneMap = new Map<string, { is_test: boolean; status: string }>();

        if (recordIds.length) {
          const { data: gl } = await supabaseBrowser
            .from("governance_ledger")
            .select("id,is_test,status")
            .in("id", recordIds);

          for (const r of gl ?? []) {
            laneMap.set(String((r as any).id), {
              is_test: !!(r as any).is_test,
              status: String((r as any).status ?? ""),
            });
          }
        }

        const merged: EntryWithDoc[] = base.map((e: MinuteBookEntry) => {
          const doc = primary.get(e.id);
          const lm = e.source_record_id ? laneMap.get(String(e.source_record_id)) : null;

          return {
            ...e,
            document_id: doc?.id ?? null,
            storage_path: doc?.file_path ?? null,
            file_name: doc?.file_name ?? null,
            file_hash: doc?.file_hash ?? null,
            file_size: doc?.file_size ?? null,
            mime_type: doc?.mime_type ?? null,
            lane_is_test: lm?.is_test ?? null,
            ledger_status: lm?.status ?? null,
          };
        });

        const laneFiltered = merged.filter((r) => {
          if (r.lane_is_test === null || r.lane_is_test === undefined) return true;
          return r.lane_is_test === laneIsTest;
        });

        laneFiltered.sort((a, b) => getCreatedAtMs(b.created_at) - getCreatedAtMs(a.created_at));
        setEntries(laneFiltered);
        setSelectedId(laneFiltered[0]?.id ?? null);
      }
    } catch (e: unknown) {
      setDeleteErr(e instanceof Error ? e.message : "Delete failed.");
    } finally {
      setDeleteBusy(false);
    }
  }

  /* ---------------- UI atoms ---------------- */

  const shell =
    "rounded-3xl border border-white/10 bg-black/20 shadow-[0_28px_120px_rgba(0,0,0,0.55)] overflow-hidden";
  const header =
    "border-b border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent px-4 sm:px-6 py-4 sm:py-5";
  const body = "px-4 sm:px-6 py-5 sm:py-6";

  const Shell = ({ children }: { children: ReactNode }) => (
    <div className="w-full">
      <div className="mx-auto w-full max-w-[1400px] px-4 pb-10 pt-4 sm:pt-6">{children}</div>
    </div>
  );

  const GlassCard = ({ className, children }: { className?: string; children: ReactNode }) => (
    <div className={cx(shell, className)}>{children}</div>
  );

  const CardHeader = ({ children }: { children: ReactNode }) => <div className={header}>{children}</div>;

  const CardBody = ({ className, children }: { className?: string; children: ReactNode }) => (
    <div className={cx(body, className)}>{children}</div>
  );

  return (
    <Shell>
      <GlassCard className="mb-4">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] sm:text-xs tracking-[0.3em] uppercase text-slate-500">CI • Archive</div>
              <h1 className="mt-1 text-lg sm:text-xl font-semibold text-slate-50 truncate">Minute Book</h1>
              <p className="mt-1 max-w-3xl text-[11px] sm:text-xs text-slate-400 leading-relaxed">
                Evidence-first registry indexed by governance domain. Official artifacts are preferred when linked.
              </p>

              <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-400">
                <span>
                  Entity: <span className="text-emerald-300 font-medium">{String(entityKey ?? "—")}</span>
                </span>
                <span className="text-slate-700">•</span>
                <span>
                  Lane:{" "}
                  <span className={cx("font-medium", laneIsTest ? "text-amber-200" : "text-slate-200")}>
                    {laneIsTest ? "SANDBOX" : "RoT"}
                  </span>
                </span>
                <span className="text-slate-700">•</span>
                <span>
                  Domain: <span className="text-slate-200 font-medium">{activeDomainLabel}</span>
                </span>
                <span className="text-slate-700">•</span>
                <span className="inline-flex items-center gap-2">
                  <span className="text-slate-500">Entries:</span>
                  <span className="text-slate-200 font-semibold">{loading ? "…" : filteredEntries.length}</span>
                </span>
              </div>
            </div>

            <div className="shrink-0 flex items-center gap-2">
              <Link
                href="/ci-archive"
                className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7"
              >
                Launchpad
              </Link>
              <Link
                href="/ci-archive/upload"
                className="rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-amber-200 hover:bg-amber-500/15"
              >
                Upload →
              </Link>
            </div>
          </div>
        </CardHeader>
      </GlassCard>

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
          {/* MOBILE TOOLBAR */}
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
              onClick={async () => ensurePreviewUrl(true)}
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

            {/* ENTRIES */}
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
                            onClick={() => setSelectedId(e.id)}
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

                              {selectedId === e.id && authorityBadge ? (
                                <span
                                  className={cx(
                                    "shrink-0 px-2 py-1 rounded-full border text-[10px] uppercase tracking-[0.18em] font-semibold",
                                    authorityBadge.tone === "gold"
                                      ? "bg-amber-500/10 border-amber-500/30 text-amber-200"
                                      : authorityBadge.tone === "sky"
                                      ? "bg-sky-500/10 border-sky-500/30 text-sky-200"
                                      : "bg-white/5 border-white/10 text-slate-200"
                                  )}
                                >
                                  {authorityBadge.label}
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

            {/* EVIDENCE (desktop) */}
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
                            : authorityBadge.tone === "sky"
                            ? "bg-sky-500/10 border-sky-500/30 text-sky-200"
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
                          <span className="px-2 py-1 rounded-full bg-white/5 border border-white/10 text-[11px] text-slate-200">
                            {laneIsTest ? "SANDBOX" : "RoT"}
                          </span>
                          <span
                            className={cx(
                              "px-2 py-1 rounded-full border text-[11px]",
                              isUploadEntry
                                ? "bg-sky-500/10 border-sky-500/30 text-sky-200"
                                : "bg-white/5 border-white/10 text-slate-300"
                            )}
                          >
                            {isUploadEntry ? "UPLOAD" : "FORGE"}
                          </span>
                        </div>

                        {pdfErr ? (
                          <div className="mt-3 rounded-2xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-[11px] text-red-200">
                            {pdfErr}
                          </div>
                        ) : null}

                        {exportErr ? (
                          <div className="mt-3 rounded-2xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-[11px] text-red-200">
                            {exportErr}
                          </div>
                        ) : null}

                        {promoteErr ? (
                          <div className="mt-3 rounded-2xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-[11px] text-red-200">
                            {promoteErr}
                          </div>
                        ) : null}

                        <div className="mt-3">
                          <div className="text-[10px] uppercase tracking-[0.25em] text-slate-500">Actions</div>

                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => ensurePreviewUrl(true)}
                              disabled={pdfBusy}
                              className={cx(
                                "rounded-full px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition",
                                pdfBusy ? "bg-amber-500/20 text-amber-200/60" : "bg-amber-500 text-black hover:bg-amber-400"
                              )}
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
                            >
                              Open
                            </button>

                            <button
                              type="button"
                              onClick={exportDiscoveryPackage}
                              disabled={exportBusy}
                              className={cx(
                                "rounded-full px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition border",
                                exportBusy
                                  ? "bg-white/5 text-slate-200/40 border-white/10"
                                  : "bg-sky-500/10 border-sky-500/30 text-sky-200 hover:bg-sky-500/15"
                              )}
                            >
                              {exportBusy ? "Exporting…" : "Discovery Export"}
                            </button>

                            <button
                              type="button"
                              onClick={() => promoteToVerifiedRegistry({ force: canReissue })}
                              disabled={promoteBusy || !isUploadEntry}
                              className={cx(
                                "rounded-full px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition border",
                                promoteBusy || !isUploadEntry
                                  ? "bg-white/5 text-slate-200/40 border-white/10"
                                  : "bg-emerald-500/10 border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/15"
                              )}
                              title={!isUploadEntry ? promoteDisabledReason || "" : ""}
                            >
                              {promoteBusy ? (canReissue ? "Reissuing…" : "Promoting…") : canReissue ? "Reissue" : "Promote Upload"}
                            </button>

                            <button
                              type="button"
                              onClick={openVerifyTerminal}
                              disabled={!(certifiedHash || officialHash)}
                              className={cx(
                                "rounded-full px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition border",
                                !(certifiedHash || officialHash)
                                  ? "bg-white/5 text-slate-200/40 border-white/10"
                                  : "bg-white/5 border-amber-500/25 text-amber-200 hover:bg-white/7 hover:border-amber-500/40"
                              )}
                            >
                              Verify
                            </button>

                            <button
                              type="button"
                              onClick={() => {
                                setDeleteErr(null);
                                setDeleteReason("");
                                setDeleteOpen(true);
                              }}
                              className="rounded-full border px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition border-red-500/30 bg-red-500/10 text-red-200 hover:bg-red-500/15"
                            >
                              Delete
                            </button>
                          </div>

                          <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-[10px] text-slate-500 leading-relaxed">
                            <span className="text-slate-300 font-semibold">Discovery Export</span> is non-mutating.
                            <span className="text-slate-700"> • </span>
                            <span className="text-slate-300 font-semibold">Promote</span> applies to uploads only.
                            <span className="text-slate-700"> • </span>
                            Resolutions are certified via Forge automatically.
                          </div>
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
                        <div className="text-[10px] uppercase tracking-[0.25em] text-slate-500">Metadata Zone</div>

                        <div className="mt-3 grid grid-cols-1 gap-2 text-[11px]">
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-slate-500">Storage</span>
                            <span className="text-slate-200 truncate max-w-[60%]">
                              {resolvedBucket && resolvedPath
                                ? `${resolvedBucket} • ${resolvedPath}`
                                : selected.storage_path
                                ? `— • ${selected.storage_path}`
                                : "—"}
                            </span>
                          </div>

                          <div className="flex items-center justify-between gap-3">
                            <span className="text-slate-500">Upload Hash</span>
                            <span className="text-slate-200 font-mono truncate max-w-[60%]">{shortHash(selected.file_hash)}</span>
                          </div>

                          <div className="flex items-center justify-between gap-3">
                            <span className="text-slate-500">Certified Hash</span>
                            <span className="flex items-center gap-2 min-w-0">
                              <span className="text-slate-200 font-mono truncate max-w-[240px]">
                                {certifiedHash ? shortHash(certifiedHash) : "—"}
                              </span>
                              <button
                                type="button"
                                disabled={!certifiedHash}
                                onClick={async () => {
                                  if (!certifiedHash) return;
                                  const ok = await copyToClipboard(certifiedHash);
                                  if (ok) {
                                    setCopiedKey("cert-hash");
                                    window.setTimeout(
                                      () => setCopiedKey((v) => (v === "cert-hash" ? null : v)),
                                      1200
                                    );
                                  }
                                }}
                                className={cx(
                                  "rounded-full border px-2 py-1 text-[10px] font-semibold tracking-[0.18em] uppercase",
                                  !certifiedHash
                                    ? "border-white/10 bg-white/5 text-slate-200/40"
                                    : "border-amber-500/25 bg-white/5 text-amber-200 hover:bg-white/7 hover:border-amber-500/40"
                                )}
                              >
                                {copiedKey === "cert-hash" ? "Copied" : "Copy"}
                              </button>
                            </span>
                          </div>

                          <div className="flex items-center justify-between gap-3">
                            <span className="text-slate-500">Record</span>
                            <span className="text-slate-200 truncate max-w-[60%]">
                              {selected.source_record_id ? String(selected.source_record_id) : "—"}
                            </span>
                          </div>

                          <div className="flex items-center justify-between gap-3">
                            <span className="text-slate-500">Status</span>
                            <span className="text-slate-200 truncate max-w-[60%]">{norm(selected.ledger_status, "—")}</span>
                          </div>
                        </div>
                      </div>
                    </>
                  )}
                </CardBody>
              </GlassCard>
            </div>
          </div>

          {/* MOBILE: Domains Sheet */}
          {mobileDomainsOpen ? (
            <div className="sm:hidden fixed inset-0 z-[60]">
              <div className="absolute inset-0 bg-black/60" onClick={() => setMobileDomainsOpen(false)} />
              <div className="absolute inset-x-0 bottom-0 rounded-t-3xl border border-white/10 bg-black/70 backdrop-blur-xl">
                <div className="px-4 py-4 border-b border-white/10">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.25em] text-slate-500">Domains</div>
                      <div className="text-sm font-semibold text-slate-100">{activeDomainLabel}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setMobileDomainsOpen(false)}
                      className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200"
                    >
                      Close
                    </button>
                  </div>
                </div>

                <div className="px-3 py-3 max-h-[60vh] overflow-y-auto">
                  <button
                    type="button"
                    onClick={() => {
                      setActiveDomainKey("all");
                      setMobileDomainsOpen(false);
                    }}
                    className={cx(
                      "w-full flex items-center justify-between gap-3 px-3 py-3 rounded-2xl border transition",
                      activeDomainKey === "all" ? "bg-amber-500/10 border-amber-500/40" : "bg-white/5 border-white/10"
                    )}
                  >
                    <span className="text-sm text-slate-100">All</span>
                    <span className="text-[11px] text-slate-300">{entries.length}</span>
                  </button>

                  <div className="mt-2 space-y-2">
                    {domains.map((d) => {
                      const active = d.key === activeDomainKey;
                      const count = domainCounts.get(d.key) || 0;
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
                            "w-full flex items-center justify-between gap-3 px-3 py-3 rounded-2xl border transition",
                            active ? "bg-amber-500/10 border-amber-500/40" : "bg-white/5 border-white/10"
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

                  <div className="mt-4 text-[10px] text-slate-500 flex items-center justify-between px-1">
                    <span>
                      Lane: <span className="text-slate-200">{laneIsTest ? "SANDBOX" : "RoT"}</span>
                    </span>
                    <span>
                      Entity: <span className="text-slate-200">{String(entityKey)}</span>
                    </span>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {/* READER OVERLAY */}
          {mobileReaderOpen ? (
            <div className="fixed inset-0 z-[70]">
              <div className="absolute inset-0 bg-black/70" onClick={() => setMobileReaderOpen(false)} />
              <div
                className={cx(
                  "absolute inset-x-0 bottom-0 sm:inset-6 rounded-t-3xl sm:rounded-3xl border border-white/10 overflow-hidden",
                  readerTone === "glass" ? "bg-black/50 backdrop-blur-xl" : "bg-black"
                )}
              >
                <div className="border-b border-white/10 px-4 sm:px-5 py-4 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-[0.25em] text-slate-500">Reader</div>
                    <div className="mt-1 text-sm font-semibold text-slate-100 truncate">
                      {selected?.title || selected?.file_name || "Untitled"}
                    </div>
                    <div className="mt-1 text-[11px] text-slate-500 flex items-center gap-2 flex-wrap">
                      <span>{laneIsTest ? "SANDBOX" : "RoT"}</span>
                      <span className="w-1 h-1 rounded-full bg-slate-700" />
                      <span>{authorityBadge?.label || "—"}</span>
                      {showHashInReader ? (
                        <>
                          <span className="w-1 h-1 rounded-full bg-slate-700" />
                          <span className="font-mono text-slate-300">
                            {shortHash((isUploadEntry ? certifiedHash : null) || officialHash || selected?.file_hash || null)}
                          </span>
                        </>
                      ) : null}
                    </div>

                    {exportErr ? (
                      <div className="mt-2 rounded-2xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-[11px] text-red-200">
                        {exportErr}
                      </div>
                    ) : null}

                    {promoteErr ? (
                      <div className="mt-2 rounded-2xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-[11px] text-red-200">
                        {promoteErr}
                      </div>
                    ) : null}
                  </div>

                  <div className="shrink-0 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setShowHashInReader((v) => !v)}
                      className="hidden sm:inline-flex rounded-full border border-white/10 bg-white/5 px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200"
                    >
                      Hash
                    </button>

                    <button
                      type="button"
                      onClick={() => setReaderTone((t) => (t === "glass" ? "solid" : "glass"))}
                      className="hidden sm:inline-flex rounded-full border border-white/10 bg-white/5 px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200"
                    >
                      Tone
                    </button>

                    <button
                      type="button"
                      onClick={exportDiscoveryPackage}
                      disabled={exportBusy}
                      className={cx(
                        "rounded-full border px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase",
                        exportBusy
                          ? "border-white/10 bg-white/5 text-slate-200/40"
                          : "border-sky-500/30 bg-sky-500/10 text-sky-200 hover:bg-sky-500/15"
                      )}
                    >
                      {exportBusy ? "Exporting…" : "Export"}
                    </button>

                    <button
                      type="button"
                      onClick={() => promoteToVerifiedRegistry({ force: canReissue })}
                      disabled={promoteBusy || !isUploadEntry}
                      className={cx(
                        "rounded-full border px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase",
                        promoteBusy || !isUploadEntry
                          ? "border-white/10 bg-white/5 text-slate-200/40"
                          : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/15"
                      )}
                    >
                      {promoteBusy ? (canReissue ? "Reissuing…" : "Promoting…") : canReissue ? "Reissue" : "Promote"}
                    </button>

                    <button
                      type="button"
                      onClick={openVerifyTerminal}
                      disabled={!(certifiedHash || officialHash)}
                      className={cx(
                        "rounded-full border px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase",
                        !(certifiedHash || officialHash)
                          ? "border-white/10 bg-white/5 text-slate-200/40"
                          : "border-amber-500/25 bg-white/5 text-amber-200 hover:bg-white/7 hover:border-amber-500/40"
                      )}
                    >
                      Verify
                    </button>

                    <button
                      type="button"
                      onClick={() => setMobileReaderOpen(false)}
                      className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200"
                    >
                      Close
                    </button>
                  </div>
                </div>

                <div className="h-[70vh] sm:h-full bg-black/10">
                  {previewUrl ? (
                    <iframe title="PDF Reader" src={previewUrl} className="h-full w-full" />
                  ) : (
                    <div className="h-full w-full grid place-items-center text-[11px] text-slate-500">
                      No preview loaded. Tap{" "}
                      <button type="button" onClick={() => ensurePreviewUrl(false)} className="text-amber-200 underline">
                        Refresh
                      </button>
                      .
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : null}

          {/* DELETE MODAL */}
          {deleteOpen ? (
            <div className="fixed inset-0 z-[80]">
              <div className="absolute inset-0 bg-black/70" onClick={() => setDeleteOpen(false)} />
              <div className="absolute inset-x-0 bottom-0 sm:inset-0 sm:flex sm:items-center sm:justify-center p-3">
                <div className="w-full sm:max-w-[520px] rounded-3xl border border-white/10 bg-black/70 backdrop-blur-xl overflow-hidden">
                  <div className="px-4 py-4 border-b border-white/10">
                    <div className="text-[10px] uppercase tracking-[0.25em] text-slate-500">Danger Zone</div>
                    <div className="mt-1 text-sm font-semibold text-slate-100">Delete Minute Book Entry</div>
                    <div className="mt-1 text-[11px] text-slate-400">
                      This will hard-delete the entry and remove associated storage objects. Requires a reason.
                    </div>
                  </div>

                  <div className="px-4 py-4">
                    <label className="block text-[10px] uppercase tracking-[0.25em] text-slate-500">Reason</label>
                    <input
                      value={deleteReason}
                      onChange={(e) => setDeleteReason(e.target.value)}
                      placeholder="e.g., mistaken upload, wrong domain, duplicate…"
                      className="mt-2 w-full rounded-2xl bg-black/20 border border-white/10 px-3 py-3 text-sm text-slate-100 placeholder:text-slate-600 outline-none focus:border-red-500/40"
                    />

                    {deleteErr ? (
                      <div className="mt-3 rounded-2xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-[11px] text-red-200">
                        {deleteErr}
                      </div>
                    ) : null}

                    <div className="mt-4 flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setDeleteOpen(false)}
                        className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase text-slate-200"
                      >
                        Cancel
                      </button>

                      <button
                        type="button"
                        disabled={deleteBusy || !deleteReason.trim()}
                        onClick={runDelete}
                        className={cx(
                          "rounded-full px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition border",
                          deleteBusy || !deleteReason.trim()
                            ? "border-red-500/20 bg-red-500/10 text-red-200/50"
                            : "border-red-500/40 bg-red-500/15 text-red-200 hover:bg-red-500/20"
                        )}
                      >
                        {deleteBusy ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                  </div>

                  <div className="px-4 py-3 border-t border-white/10 text-[10px] text-slate-500 flex items-center justify-between">
                    <span>Lane: {laneIsTest ? "SANDBOX" : "RoT"}</span>
                    <span>Entity: {String(entityKey)}</span>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          <div className="mt-4 text-[10px] text-slate-600 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>Minute Book is a registry view.</span>
            <span className="text-slate-700">•</span>
            <span>Uploads remain pristine; official artifacts resolve via Verified registry.</span>
            <span className="text-slate-700">•</span>
            <span>Lane boundary enforced via governance_ledger.is_test.</span>
            <span className="text-slate-700">•</span>
            <span>Verification is hash-first (verify.html?hash=…).</span>
            <span className="text-slate-700">•</span>
            <span>Promote applies to uploads only (Forge resolutions are already certified).</span>
          </div>
        </>
      )}
    </Shell>
  );
}
