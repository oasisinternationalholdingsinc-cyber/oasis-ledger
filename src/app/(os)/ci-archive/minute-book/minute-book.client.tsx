"use client";
export const dynamic = "force-dynamic";

/**
 * CI-Archive → Minute Book (FINAL PRODUCTION OS)
 * - STRICT 3-column registry surface (no stacked layout)
 * - OS entity-scoped ONLY (useEntity)
 * - Registry-only (NO upload logic)
 * - WIRING LOCKED:
 *    - Reads v_registry_minute_book_entries (fallback minute_book_entries)
 *    - Uses supabaseBrowser singleton (NOT callable)
 * - ENFORCES canonical domain cabinet (matches Upload)
 * - PDF-first: view / download / open + inline preview
 * - Metadata present but muted/collapsible (does NOT disappear)
 */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";

/* ---------------- types ---------------- */

type MinuteBookRow = {
  id: string;
  entity_key?: string | null;

  title?: string | null;
  entry_type?: string | null;

  // domain / section variants that may exist depending on view/table
  domain?: string | null;
  section?: string | null;
  doc_section?: string | null;

  storage_path?: string | null;
  file_name?: string | null;
  file_hash?: string | null;
  file_size?: number | null;
  mime_type?: string | null;

  status?: string | null;
  created_at?: string | null;
  created_by?: string | null;

  notes?: string | null;
  source?: string | null;

  // Optional future-proof fields (won't break if absent)
  official_storage_path?: string | null;
  official_bucket_id?: string | null;
};

type DomainDef = {
  key: string;
  label: string;
  icon: string; // emoji is fine + stable
  // synonyms help normalize legacy values
  synonyms?: string[];
};

type OfficialArtifact = {
  bucket_id: string;
  storage_path: string;
  file_name?: string | null;
  kind?: "official" | "certified" | "verified";
};

/* ---------------- helpers ---------------- */

function norm(s?: string | null, fallback = "") {
  const x = (s || "").toString().trim();
  return x.length ? x : fallback;
}

function toSlug(s?: string | null) {
  const x = (s || "").toString().trim();
  if (!x) return "";
  return x
    .replace(/&/g, "and")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .toLowerCase()
    .trim();
}

function getTitle(r: MinuteBookRow) {
  return norm(r.title, norm(r.file_name, "Untitled"));
}

function getType(r: MinuteBookRow) {
  return norm(r.entry_type, "Document");
}

function getCreatedAtMs(r: MinuteBookRow) {
  const t = r.created_at ? Date.parse(r.created_at) : NaN;
  return Number.isFinite(t) ? t : 0;
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
  if (h.length <= 18) return h;
  return `${h.slice(0, 10)}…${h.slice(-6)}`;
}

/* ---------------- canonical cabinet (MATCH UPLOAD) ---------------- */

const DOMAIN_CABINET: DomainDef[] = [
  {
    key: "formation",
    label: "Incorporation & Formation",
    icon: "📜",
    synonyms: ["incorporation", "articles", "formation", "registrations", "registration", "corporate_profile"],
  },
  {
    key: "corporate_profile",
    label: "Corporate Profile & Registrations",
    icon: "🛡️",
    synonyms: ["profile", "corporate_profile", "registrations", "registration", "notices"],
  },
  {
    key: "share_certificates",
    label: "Share Capital & Ownership",
    icon: "📈",
    synonyms: ["share", "shares", "share_certificates", "sharecertificates", "ownership", "registers"],
  },
  {
    key: "directors_officers",
    label: "Directors & Officers",
    icon: "👤",
    synonyms: ["directors", "officers", "director", "officer", "consents"],
  },
  {
    key: "resolutions",
    label: "Resolutions & Minutes",
    icon: "⚖️",
    synonyms: ["resolutions", "resolution", "minutes"],
  },
  {
    key: "bylaws",
    label: "Policies & Governance",
    icon: "📘",
    synonyms: ["bylaws", "by_laws", "policies", "governance"],
  },
  {
    key: "annual_returns",
    label: "Financial & Tax",
    icon: "🧾",
    synonyms: ["annual_returns", "annualreturn", "tax", "financial", "cra"],
  },
  {
    key: "banking",
    label: "Banking & Finance",
    icon: "🏦",
    synonyms: ["banking", "finance"],
  },
  {
    key: "insurance",
    label: "Insurance & Risk",
    icon: "🛡️",
    synonyms: ["insurance", "risk"],
  },
  {
    key: "appraisal",
    label: "Real Estate & Assets",
    icon: "🏠",
    synonyms: ["real_estate", "assets", "appraisal", "property"],
  },
  {
    key: "contracts",
    label: "Contracts & Agreements",
    icon: "🤝",
    synonyms: ["contracts", "agreements", "closingbinders", "closing_binders"],
  },
  {
    key: "brand_ip",
    label: "Brand & Intellectual Property",
    icon: "™️",
    synonyms: ["brand", "ip", "intellectual_property", "trademark", "copyright"],
  },
  {
    key: "compliance",
    label: "Regulatory & Compliance",
    icon: "✅",
    synonyms: ["compliance", "regulatory", "legal_package"],
  },
  {
    key: "litigation",
    label: "Litigation & Legal",
    icon: "⚠️",
    synonyms: ["litigation", "legal", "notices"],
  },
  {
    key: "annexes",
    label: "Miscellaneous / Other",
    icon: "🗂️",
    synonyms: ["annexes", "misc", "miscellaneous", "other", "general"],
  },
];

// fallback display when you click All (optional)
const ALL_DOMAIN: DomainDef = { key: "all", label: "All", icon: "◆" };

function domainKeyForRow(r: MinuteBookRow): string {
  // Prefer explicit "domain" (Upload contract), else section/doc_section legacy
  const raw =
    norm(r.domain, "") ||
    norm(r.doc_section, "") ||
    norm(r.section, "") ||
    "general";

  const slug = toSlug(raw);

  // direct cabinet match
  const direct = DOMAIN_CABINET.find((d) => d.key === slug);
  if (direct) return direct.key;

  // synonym match
  for (const d of DOMAIN_CABINET) {
    const syn = (d.synonyms || []).map(toSlug);
    if (syn.includes(slug)) return d.key;
  }

  // heuristic: common legacy values
  if (slug.includes("bylaw")) return "bylaws";
  if (slug.includes("resolution") || slug.includes("minute")) return "resolutions";
  if (slug.includes("register")) return "share_certificates";
  if (slug.includes("share")) return "share_certificates";
  if (slug.includes("annual") || slug.includes("tax") || slug.includes("financial")) return "annual_returns";
  if (slug.includes("bank")) return "banking";
  if (slug.includes("insur")) return "insurance";
  if (slug.includes("apprais") || slug.includes("asset") || slug.includes("real")) return "appraisal";
  if (slug.includes("contract") || slug.includes("agreement")) return "contracts";
  if (slug.includes("brand") || slug.includes("ip") || slug.includes("trademark")) return "brand_ip";
  if (slug.includes("compliance") || slug.includes("regulat")) return "compliance";
  if (slug.includes("legal") || slug.includes("litigat")) return "litigation";

  // safe default
  return "annexes";
}

/* ---------------- data loading (WIRING LOCKED) ---------------- */

async function loadMinuteBook(entityKey: string) {
  const sb = supabaseBrowser;

  // Preferred: registry view
  try {
    const { data, error } = await sb
      .from("v_registry_minute_book_entries")
      .select("*")
      .eq("entity_key", entityKey)
      .limit(1000);

    if (!error && data) return data as MinuteBookRow[];
  } catch {
    // fallback below
  }

  // Fallback: table
  const { data, error } = await sb
    .from("minute_book_entries")
    .select("*")
    .eq("entity_key", entityKey)
    .limit(1000);

  if (error) throw error;
  return (data || []) as MinuteBookRow[];
}

/**
 * OFFICIAL-first resolution (no wiring changes).
 * Priority:
 * 1) explicit official_* fields if present
 * 2) best-effort verified_documents lookup (safe fallback)
 * 3) null -> fallback to uploaded minute_book bucket
 */
async function resolveOfficialArtifact(entityKey: string, row: MinuteBookRow): Promise<OfficialArtifact | null> {
  const sb = supabaseBrowser;

  // (1) explicit pointers
  if (row.official_bucket_id && row.official_storage_path) {
    return {
      bucket_id: row.official_bucket_id,
      storage_path: row.official_storage_path,
      file_name: row.file_name || null,
      kind: "official",
    };
  }

  // (2) best-effort lookup (harmless if schema differs)
  try {
    const hash = row.file_hash || null;
    const path = row.storage_path || null;
    const id = row.id;

    const orParts = [
      hash ? `file_hash.eq.${hash}` : "",
      path ? `source_storage_path.eq.${path}` : "",
      `source_entry_id.eq.${id}`,
      `minute_book_entry_id.eq.${id}`,
    ].filter(Boolean);

    if (orParts.length) {
      const { data, error } = await sb
        .from("verified_documents")
        .select("*")
        .eq("entity_key", entityKey)
        .or(orParts.join(","))
        .order("created_at", { ascending: false })
        .limit(1);

      if (!error && data && data.length) {
        const v: any = data[0];
        const bucket = v.bucket_id || v.storage_bucket || "verified_documents";
        const vpath = v.storage_path || v.file_path || v.path;
        if (bucket && vpath) {
          return {
            bucket_id: bucket,
            storage_path: vpath,
            file_name: v.file_name || row.file_name || null,
            kind: v.kind || "verified",
          };
        }
      }
    }
  } catch {
    // ignore
  }

  return null;
}

async function signedUrlFor(bucketId: string, storagePath: string, downloadName?: string | null) {
  const sb = supabaseBrowser;
  const opts: any = downloadName ? { download: downloadName } : undefined;
  const { data, error } = await sb.storage.from(bucketId).createSignedUrl(storagePath, 60 * 10, opts);
  if (error) throw error;
  return data.signedUrl;
}

/* ---------------- UI ---------------- */

export default function MinuteBookClient() {
  const { entityKey } = useEntity();

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [rows, setRows] = useState<MinuteBookRow[]>([]);
  const [activeDomain, setActiveDomain] = useState<string>(ALL_DOMAIN.key);
  const [query, setQuery] = useState<string>("");

  const [selectedId, setSelectedId] = useState<string | null>(null);

  // PDF state (official-first)
  const [official, setOfficial] = useState<OfficialArtifact | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLabel, setPreviewLabel] = useState<string>("");
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfErr, setPdfErr] = useState<string | null>(null);

  const rowsWithDomain = useMemo(() => {
    return rows.map((r) => ({ ...r, __domainKey: domainKeyForRow(r) })) as (MinuteBookRow & {
      __domainKey: string;
    })[];
  }, [rows]);

  const domainCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of DOMAIN_CABINET) m.set(d.key, 0);
    for (const r of rowsWithDomain) m.set(r.__domainKey, (m.get(r.__domainKey) || 0) + 1);
    return m;
  }, [rowsWithDomain]);

  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();

    let filtered = rowsWithDomain.filter((r) => {
      if (activeDomain !== ALL_DOMAIN.key && r.__domainKey !== activeDomain) return false;
      if (!q) return true;

      const hay = [
        getTitle(r),
        getType(r),
        r.domain || "",
        r.doc_section || "",
        r.section || "",
        r.file_name || "",
        r.storage_path || "",
        r.status || "",
        r.file_hash || "",
      ]
        .join(" ")
        .toLowerCase();

      return hay.includes(q);
    });

    filtered.sort((a, b) => getCreatedAtMs(b) - getCreatedAtMs(a));
    return filtered;
  }, [rowsWithDomain, activeDomain, query]);

  const selected = useMemo(() => {
    if (!selectedId) return null;
    return rowsWithDomain.find((r) => r.id === selectedId) || null;
  }, [rowsWithDomain, selectedId]);

  // Load registry (WIRING LOCKED)
  useEffect(() => {
    let alive = true;

    async function run() {
      setErr(null);
      setLoading(true);
      setRows([]);
      setSelectedId(null);

      setActiveDomain(ALL_DOMAIN.key);
      setQuery("");

      setOfficial(null);
      setPreviewUrl(null);
      setPreviewLabel("");
      setPdfErr(null);

      if (!entityKey) {
        setLoading(false);
        return;
      }

      try {
        const data = await loadMinuteBook(entityKey);
        if (!alive) return;

        setRows(data);

        if (data.length) {
          const newest = [...data].sort((a, b) => getCreatedAtMs(b) - getCreatedAtMs(a))[0];
          setSelectedId(newest?.id || null);
        }
      } catch (e: any) {
        if (!alive) return;
        setErr(e?.message || "Failed to load Minute Book registry.");
      } finally {
        if (alive) setLoading(false);
      }
    }

    run();
    return () => {
      alive = false;
    };
  }, [entityKey]);

  // Resolve OFFICIAL artifact on selection
  useEffect(() => {
    let alive = true;

    async function run() {
      setPdfErr(null);
      setPreviewUrl(null);
      setPreviewLabel("");
      setOfficial(null);

      if (!entityKey || !selected) return;

      setPdfBusy(true);
      try {
        const off = await resolveOfficialArtifact(entityKey, selected);
        if (!alive) return;
        setOfficial(off);
      } catch {
        if (!alive) return;
        setOfficial(null);
      } finally {
        if (alive) setPdfBusy(false);
      }
    }

    run();
    return () => {
      alive = false;
    };
  }, [entityKey, selected?.id]);

  async function viewPdf() {
    if (!entityKey || !selected) return;

    setPdfErr(null);
    setPdfBusy(true);
    try {
      // OFFICIAL-first
      if (official?.bucket_id && official?.storage_path) {
        const url = await signedUrlFor(official.bucket_id, official.storage_path, null);
        setPreviewUrl(url);
        setPreviewLabel("Official PDF");
        return;
      }

      // fallback: uploaded evidence
      if (!selected.storage_path) throw new Error("No storage_path on selected record.");
      const url = await signedUrlFor("minute_book", selected.storage_path, null);
      setPreviewUrl(url);
      setPreviewLabel("Uploaded PDF");
    } catch (e: any) {
      setPdfErr(e?.message || "Failed to generate preview URL.");
    } finally {
      setPdfBusy(false);
    }
  }

  async function downloadPdf() {
    if (!entityKey || !selected) return;

    setPdfErr(null);
    setPdfBusy(true);
    try {
      const name = selected.file_name || `${getTitle(selected)}.pdf`;

      if (official?.bucket_id && official?.storage_path) {
        const url = await signedUrlFor(official.bucket_id, official.storage_path, name);
        window.open(url, "_blank", "noopener,noreferrer");
        return;
      }

      if (!selected.storage_path) throw new Error("No storage_path on selected record.");
      const url = await signedUrlFor("minute_book", selected.storage_path, name);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e: any) {
      setPdfErr(e?.message || "Failed to generate download URL.");
    } finally {
      setPdfBusy(false);
    }
  }

  async function openNewTab() {
    if (!entityKey || !selected) return;

    setPdfErr(null);
    setPdfBusy(true);
    try {
      if (previewUrl) {
        window.open(previewUrl, "_blank", "noopener,noreferrer");
        return;
      }

      if (official?.bucket_id && official?.storage_path) {
        const url = await signedUrlFor(official.bucket_id, official.storage_path, null);
        window.open(url, "_blank", "noopener,noreferrer");
        return;
      }

      if (!selected.storage_path) throw new Error("No storage_path on selected record.");
      const url = await signedUrlFor("minute_book", selected.storage_path, null);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e: any) {
      setPdfErr(e?.message || "Failed to open PDF.");
    } finally {
      setPdfBusy(false);
    }
  }

  const authorityBadge = useMemo(() => {
    if (!selected) return null;
    if (official) return { label: "OFFICIAL", tone: "gold" as const };
    return { label: "UPLOADED", tone: "neutral" as const };
  }, [selected?.id, !!official]);

  const activeDomainLabel = useMemo(() => {
    if (activeDomain === ALL_DOMAIN.key) return ALL_DOMAIN.label;
    return DOMAIN_CABINET.find((d) => d.key === activeDomain)?.label || "Domain";
  }, [activeDomain]);

  /* ---------------- render ---------------- */

  return (
    <div className="h-[calc(100vh-56px)] w-full overflow-hidden px-4 py-4">
      {/* Header */}
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-xs text-white/50">CI-Archive</div>
          <div className="truncate text-xl font-semibold tracking-tight text-white">Minute Book Registry</div>
          <div className="mt-1 text-sm text-white/50">
            Evidence registry. Read-only. Official-first when available.
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Link
            href="/ci-archive"
            className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10"
            title="CI-Archive Launchpad"
          >
            Archive
          </Link>

          <Link
            href="/ci-archive/upload"
            className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm font-medium text-amber-200 hover:bg-amber-400/15"
          >
            Upload Filing →
          </Link>
        </div>
      </div>

      {/* Entity guard */}
      {!entityKey ? (
        <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-white/70">
          Select an entity in the OS bar to view Minute Book records.
        </div>
      ) : (
        <div className="grid h-[calc(100vh-56px-88px)] grid-cols-12 gap-4">
          {/* Left: Domains (CANONICAL, ALWAYS) */}
          <div className="col-span-12 md:col-span-3">
            <div className="h-full overflow-hidden rounded-2xl border border-white/10 bg-white/5">
              <div className="border-b border-white/10 px-4 py-3">
                <div className="text-sm font-medium text-white">Domains</div>
                <div className="text-xs text-white/50">Canonical cabinet (matches Upload)</div>
              </div>

              <div className="h-full overflow-auto p-2">
                {/* Optional All */}
                <button
                  onClick={() => setActiveDomain(ALL_DOMAIN.key)}
                  className={[
                    "w-full rounded-xl px-3 py-2 text-left text-sm transition",
                    activeDomain === ALL_DOMAIN.key
                      ? "border border-amber-400/30 bg-amber-400/10 text-amber-100"
                      : "border border-transparent text-white/80 hover:bg-white/5",
                  ].join(" ")}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="grid h-7 w-7 place-items-center rounded-xl border border-white/10 bg-black/20 text-sm">
                        {ALL_DOMAIN.icon}
                      </span>
                      <span className="truncate">{ALL_DOMAIN.label}</span>
                    </span>
                    <span className="text-xs text-white/40">{rows.length}</span>
                  </div>
                </button>

                <div className="mt-2 space-y-1">
                  {DOMAIN_CABINET.map((d) => {
                    const isActive = d.key === activeDomain;
                    const count = domainCounts.get(d.key) || 0;

                    return (
                      <button
                        key={d.key}
                        onClick={() => setActiveDomain(d.key)}
                        className={[
                          "w-full rounded-xl px-3 py-2 text-left text-sm transition",
                          isActive
                            ? "border border-amber-400/30 bg-amber-400/10 text-amber-100"
                            : "border border-transparent text-white/80 hover:bg-white/5",
                        ].join(" ")}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="grid h-7 w-7 place-items-center rounded-xl border border-white/10 bg-black/20 text-sm">
                              {d.icon}
                            </span>
                            <span className="truncate">{d.label}</span>
                          </span>

                          <span
                            className={[
                              "text-xs",
                              count > 0 ? "text-amber-100/80" : "text-white/35",
                            ].join(" ")}
                          >
                            {count}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* Middle: Entries */}
          <div className="col-span-12 md:col-span-5">
            <div className="h-full overflow-hidden rounded-2xl border border-white/10 bg-white/5">
              <div className="border-b border-white/10 px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-white">Entries</div>
                    <div className="text-xs text-white/50">
                      {loading ? "Loading…" : `${visibleRows.length} item(s)`}{" "}
                      <span className="text-white/35">in</span>{" "}
                      <span className="text-white/70">{activeDomainLabel}</span>
                    </div>
                  </div>
                  <div className="text-xs text-white/40">
                    Entity: <span className="text-white/70">{entityKey}</span>
                  </div>
                </div>

                <div className="mt-3">
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search title, hash, path…"
                    className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white placeholder:text-white/35 outline-none focus:border-amber-400/30"
                  />
                </div>
              </div>

              <div className="h-full overflow-auto p-2">
                {err ? (
                  <div className="rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200">
                    {err}
                  </div>
                ) : loading ? (
                  <div className="p-3 text-sm text-white/60">Loading registry…</div>
                ) : visibleRows.length === 0 ? (
                  <div className="p-3 text-sm text-white/60">
                    No records filed under{" "}
                    <span className="text-white/80">{activeDomainLabel}</span> yet.
                    <div className="mt-2 text-xs text-white/40">
                      Structure is authoritative even when empty — upload later and it will appear here.
                    </div>
                  </div>
                ) : (
                  visibleRows.map((r) => {
                    const isActive = r.id === selectedId;
                    const title = getTitle(r);
                    const type = getType(r);
                    const createdAt = r.created_at ? new Date(r.created_at).toLocaleString() : "—";

                    return (
                      <button
                        key={r.id}
                        onClick={() => setSelectedId(r.id)}
                        className={[
                          "w-full rounded-xl border px-3 py-3 text-left transition",
                          isActive ? "border-amber-400/30 bg-amber-400/10" : "border-white/10 hover:bg-white/5",
                        ].join(" ")}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-white">{title}</div>
                            <div className="mt-1 flex flex-wrap gap-2 text-xs text-white/50">
                              <span className="rounded-lg border border-white/10 bg-white/5 px-2 py-0.5">{type}</span>
                              <span className="text-white/40">{createdAt}</span>
                            </div>
                          </div>

                          <div className="shrink-0 text-right">
                            <div className="text-xs text-white/50">{fmtBytes(r.file_size)}</div>
                            <div className="mt-1 text-[11px] text-white/40">{norm(r.status, "—")}</div>
                          </div>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          {/* Right: PDF-first Focus + Metadata (muted/collapsible) */}
          <div className="col-span-12 md:col-span-4">
            <div className="h-full overflow-hidden rounded-2xl border border-white/10 bg-white/5">
              <div className="border-b border-white/10 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-white">Details</div>
                    <div className="text-xs text-white/50">PDF-first focus • metadata secondary</div>
                  </div>

                  {authorityBadge ? (
                    <span
                      className={[
                        "rounded-full border px-2 py-1 text-[11px] font-semibold tracking-wide",
                        authorityBadge.tone === "gold"
                          ? "border-amber-400/30 bg-amber-400/10 text-amber-200"
                          : "border-white/10 bg-white/5 text-white/60",
                      ].join(" ")}
                      title={authorityBadge.tone === "gold" ? "Official artifact available" : "Uploaded evidence"}
                    >
                      {authorityBadge.label}
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="h-full overflow-auto p-4">
                {!selected ? (
                  <div className="text-sm text-white/60">Select an entry to view the document.</div>
                ) : (
                  <div className="space-y-4">
                    {/* Title */}
                    <div>
                      <div className="text-xs text-white/40">Title</div>
                      <div className="mt-1 text-base font-semibold text-white">{getTitle(selected)}</div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <span className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-white/75">
                          {getType(selected)}
                        </span>
                        <span className="rounded-lg border border-amber-400/20 bg-amber-400/10 px-2 py-1 text-xs text-amber-100">
                          {DOMAIN_CABINET.find((d) => d.key === (selected as any).__domainKey)?.label || "Domain"}
                        </span>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <div className="text-xs font-medium text-white/80">Document</div>
                          <div className="text-[11px] text-white/40">
                            {official ? "Official-first (fallback to uploaded)" : "Uploaded evidence"}
                          </div>
                        </div>
                        <div className="text-[11px] text-white/40">
                          {pdfBusy ? "Working…" : previewLabel ? previewLabel : ""}
                        </div>
                      </div>

                      {pdfErr ? (
                        <div className="mt-2 rounded-xl border border-red-400/20 bg-red-400/10 p-2 text-xs text-red-200">
                          {pdfErr}
                        </div>
                      ) : null}

                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          onClick={viewPdf}
                          disabled={pdfBusy}
                          className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm font-medium text-amber-200 hover:bg-amber-400/15 disabled:opacity-50"
                        >
                          View PDF
                        </button>
                        <button
                          onClick={downloadPdf}
                          disabled={pdfBusy}
                          className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10 disabled:opacity-50"
                        >
                          Download
                        </button>
                        <button
                          onClick={openNewTab}
                          disabled={pdfBusy}
                          className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10 disabled:opacity-50"
                        >
                          Open New Tab
                        </button>
                      </div>

                      {/* Inline preview (breathing room) */}
                      {previewUrl ? (
                        <div className="mt-4 overflow-hidden rounded-2xl border border-white/10 bg-black/30">
                          <div className="border-b border-white/10 px-3 py-2 text-xs text-white/60">
                            Preview — {previewLabel || (official ? "Official PDF" : "Uploaded PDF")}
                          </div>
                          <div className="h-[520px]">
                            <iframe title="PDF Preview" src={previewUrl} className="h-full w-full" />
                          </div>
                        </div>
                      ) : null}
                    </div>

                    {/* Metadata zone (secondary) */}
                    <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                      <div className="text-xs font-medium text-white/70">Metadata Zone (secondary)</div>
                      <div className="mt-2 space-y-2">
                        <details className="rounded-xl border border-white/10 bg-black/20 p-3">
                          <summary className="cursor-pointer text-sm text-white/75">Storage</summary>
                          <div className="mt-2 space-y-2 text-sm text-white/70">
                            <div className="flex items-start justify-between gap-3">
                              <div className="text-white/40">Path</div>
                              <div className="min-w-0 text-right font-mono text-xs text-white/70">
                                {norm(selected.storage_path, "—")}
                              </div>
                            </div>
                            <div className="flex items-start justify-between gap-3">
                              <div className="text-white/40">File</div>
                              <div className="min-w-0 text-right text-sm text-white/70">
                                {norm(selected.file_name, "—")}
                              </div>
                            </div>
                            <div className="flex items-start justify-between gap-3">
                              <div className="text-white/40">Size</div>
                              <div className="text-right text-sm text-white/70">{fmtBytes(selected.file_size)}</div>
                            </div>
                            <div className="flex items-start justify-between gap-3">
                              <div className="text-white/40">MIME</div>
                              <div className="text-right text-sm text-white/70">{norm(selected.mime_type, "—")}</div>
                            </div>
                          </div>
                        </details>

                        <details open className="rounded-xl border border-amber-400/20 bg-amber-400/10 p-3">
                          <summary className="cursor-pointer text-sm text-amber-100">Hash</summary>
                          <div className="mt-2 space-y-2 text-sm text-amber-100/90">
                            <div className="flex items-start justify-between gap-3">
                              <div className="text-amber-100/60">SHA-256</div>
                              <div className="min-w-0 text-right font-mono text-xs">{shortHash(selected.file_hash)}</div>
                            </div>
                            <div className="text-[11px] text-amber-100/60">
                              Minute Book is evidence access. Certification/attestation lives in Verified Registry.
                            </div>
                          </div>
                        </details>

                        <details className="rounded-xl border border-white/10 bg-black/20 p-3">
                          <summary className="cursor-pointer text-sm text-white/75">Audit</summary>
                          <div className="mt-2 space-y-2 text-sm text-white/70">
                            <div className="flex items-start justify-between gap-3">
                              <div className="text-white/40">Created</div>
                              <div className="text-right text-sm text-white/70">
                                {selected.created_at ? new Date(selected.created_at).toLocaleString() : "—"}
                              </div>
                            </div>
                            <div className="flex items-start justify-between gap-3">
                              <div className="text-white/40">Created By</div>
                              <div className="min-w-0 text-right font-mono text-xs text-white/70">
                                {norm(selected.created_by, "—")}
                              </div>
                            </div>
                            <div className="flex items-start justify-between gap-3">
                              <div className="text-white/40">Source</div>
                              <div className="text-right text-sm text-white/70">{norm(selected.source, "—")}</div>
                            </div>
                          </div>
                        </details>
                      </div>
                    </div>

                    {/* Footer nav */}
                    <div className="pt-1">
                      <div className="grid grid-cols-2 gap-2">
                        <Link
                          href="/ci-archive"
                          className="inline-flex items-center justify-center rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10"
                        >
                          Archive Launchpad
                        </Link>
                        <Link
                          href="/ci-archive/upload"
                          className="inline-flex items-center justify-center rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm font-medium text-amber-200 hover:bg-amber-400/15"
                        >
                          File Another Upload
                        </Link>
                      </div>
                      <div className="mt-2 text-center text-[11px] text-white/40">
                        Upload is the sole write entry point. Registry remains OS-native and read-only.
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
