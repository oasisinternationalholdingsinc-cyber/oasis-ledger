"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/browser";

type Entry = {
  id: string;
  entity_key: string | null;
  title: string | null;
  storage_path: string | null;
  bucket_id: string | null;
  created_at: string;
  created_by: string | null;
  source: string | null;
};

function humanDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString();
}

function folderFromPath(p?: string | null) {
  if (!p) return "Unsorted";
  // expected: holdings/AnnualReturns/file.pdf
  const parts = p.split("/").filter(Boolean);
  if (parts.length >= 2) return parts[1];
  return "Unsorted";
}

export default function CIArchivePage() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const [loading, setLoading] = useState(true);

  // Scope
  const [entityKey, setEntityKey] = useState<string>("holdings");

  // Data
  const [entries, setEntries] = useState<Entry[]>([]);
  const [activeFolder, setActiveFolder] = useState<string>("All");
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // Load
  useEffect(() => {
    let mounted = true;

    (async () => {
      setLoading(true);

      const { data: userRes } = await supabase.auth.getUser();
      if (!userRes?.user) {
        // If you already have an OS auth gate, it will redirect.
        // If not, this prevents a confusing blank state.
        setEntries([]);
        setLoading(false);
        return;
      }

      // Pull entries for entityKey (or all if you want later)
      const { data, error } = await supabase
        .from("minute_book_entries")
        .select("id, entity_key, title, storage_path, bucket_id, created_at, created_by, source")
        .eq("bucket_id", "minute_book")
        .eq("entity_key", entityKey)
        .order("created_at", { ascending: false })
        .limit(250);

      if (!mounted) return;

      if (error) {
        console.error(error);
        setEntries([]);
      } else {
        setEntries((data as Entry[]) ?? []);
        setActiveEntryId((data as Entry[])?.[0]?.id ?? null);
      }

      setLoading(false);
    })();

    return () => {
      mounted = false;
    };
  }, [supabase, entityKey]);

  const folders = useMemo(() => {
    const set = new Set<string>();
    entries.forEach((e) => set.add(folderFromPath(e.storage_path)));
    return ["All", ...Array.from(set).sort((a, b) => a.localeCompare(b))];
  }, [entries]);

  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase();

    return entries.filter((e) => {
      const folder = folderFromPath(e.storage_path);
      const folderOk = activeFolder === "All" ? true : folder === activeFolder;

      const title = (e.title ?? "").toLowerCase();
      const path = (e.storage_path ?? "").toLowerCase();
      const queryOk = q ? title.includes(q) || path.includes(q) : true;

      return folderOk && queryOk;
    });
  }, [entries, activeFolder, query]);

  const activeEntry = useMemo(() => {
    return filteredEntries.find((e) => e.id === activeEntryId) ?? filteredEntries[0] ?? null;
  }, [filteredEntries, activeEntryId]);

  // Signed download URL (public/private buckets differ; this works for private buckets too)
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    setDownloadUrl(null);

    (async () => {
      if (!activeEntry?.storage_path) return;
      const { data, error } = await supabase.storage
        .from("minute_book")
        .createSignedUrl(activeEntry.storage_path, 60); // 60s

      if (!mounted) return;
      if (error) {
        console.error(error);
        setDownloadUrl(null);
      } else {
        setDownloadUrl(data?.signedUrl ?? null);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [supabase, activeEntry?.storage_path]);

  return (
    <div className="min-h-[calc(100vh-0px)] w-full bg-black text-white">
      {/* Top bar */}
      <div className="sticky top-0 z-10 border-b border-yellow-500/15 bg-black/70 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="h-2 w-2 rounded-full bg-yellow-400/80" />
            <div>
              <div className="text-sm tracking-wide text-yellow-200/90">CI-Archive</div>
              <div className="text-xs text-white/50">Three-column canonical layout</div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <select
              className="rounded-xl border border-yellow-500/15 bg-black px-3 py-2 text-sm text-white/80 outline-none"
              value={entityKey}
              onChange={(e) => setEntityKey(e.target.value)}
              title="Entity scope"
            >
              <option value="holdings">holdings</option>
              <option value="realestate">realestate</option>
              <option value="lounge">lounge</option>
            </select>

            <Link
              href="/ci-archive/upload"
              className="rounded-xl border border-yellow-500/20 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-100 hover:bg-yellow-500/15"
            >
              Upload
            </Link>
          </div>
        </div>
      </div>

      {/* 3 columns */}
      <div className="mx-auto grid max-w-7xl grid-cols-12 gap-0 px-4 py-4">
        {/* Left: folders */}
        <aside className="col-span-12 md:col-span-3">
          <div className="h-[78vh] rounded-2xl border border-yellow-500/15 bg-black/40 p-3 shadow-[0_0_0_1px_rgba(234,179,8,0.05)]">
            <div className="mb-3 text-xs uppercase tracking-widest text-white/50">Folders</div>

            <div className="space-y-1 overflow-auto pr-1" style={{ maxHeight: "calc(78vh - 40px)" }}>
              {folders.map((f) => {
                const active = f === activeFolder;
                return (
                  <button
                    key={f}
                    onClick={() => setActiveFolder(f)}
                    className={[
                      "w-full rounded-xl px-3 py-2 text-left text-sm",
                      active
                        ? "border border-yellow-400/30 bg-yellow-500/10 text-yellow-100"
                        : "border border-transparent text-white/75 hover:bg-white/5",
                    ].join(" ")}
                  >
                    {f}
                  </button>
                );
              })}
            </div>
          </div>
        </aside>

        {/* Middle: entries */}
        <section className="col-span-12 mt-3 md:col-span-5 md:mt-0 md:pl-3">
          <div className="h-[78vh] rounded-2xl border border-yellow-500/15 bg-black/40 p-3">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="text-xs uppercase tracking-widest text-white/50">Entries</div>

              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search title or path…"
                className="w-48 rounded-xl border border-yellow-500/15 bg-black px-3 py-2 text-sm text-white/80 outline-none placeholder:text-white/30"
              />
            </div>

            <div className="overflow-auto pr-1" style={{ maxHeight: "calc(78vh - 56px)" }}>
              {loading ? (
                <div className="p-4 text-sm text-white/50">Loading…</div>
              ) : filteredEntries.length === 0 ? (
                <div className="p-4 text-sm text-white/50">No entries found.</div>
              ) : (
                <div className="space-y-2">
                  {filteredEntries.map((e) => {
                    const active = e.id === (activeEntry?.id ?? null);
                    return (
                      <button
                        key={e.id}
                        onClick={() => setActiveEntryId(e.id)}
                        className={[
                          "w-full rounded-2xl border p-3 text-left",
                          active
                            ? "border-yellow-400/30 bg-yellow-500/10"
                            : "border-yellow-500/10 bg-black hover:bg-white/5",
                        ].join(" ")}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="text-sm text-white/90">
                              {e.title || (e.storage_path?.split("/").pop() ?? "Untitled")}
                            </div>
                            <div className="mt-1 text-xs text-white/45">
                              {folderFromPath(e.storage_path)} • {humanDate(e.created_at)}
                            </div>
                          </div>
                          <div className="text-[10px] uppercase tracking-widest text-yellow-200/60">
                            {e.source ?? "—"}
                          </div>
                        </div>

                        <div className="mt-2 truncate text-xs text-white/40">{e.storage_path}</div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Right: details */}
        <aside className="col-span-12 mt-3 md:col-span-4 md:mt-0 md:pl-3">
          <div className="h-[78vh] rounded-2xl border border-yellow-500/15 bg-black/40 p-4">
            <div className="mb-3 text-xs uppercase tracking-widest text-white/50">Details</div>

            {!activeEntry ? (
              <div className="text-sm text-white/50">Select an entry.</div>
            ) : (
              <div className="space-y-3">
                <div>
                  <div className="text-lg text-white/90">
                    {activeEntry.title || (activeEntry.storage_path?.split("/").pop() ?? "Untitled")}
                  </div>
                  <div className="mt-1 text-xs text-white/45">{humanDate(activeEntry.created_at)}</div>
                </div>

                <div className="rounded-2xl border border-yellow-500/10 bg-black p-3">
                  <div className="text-xs text-white/40">Storage path</div>
                  <div className="mt-1 break-all text-sm text-white/80">{activeEntry.storage_path}</div>
                </div>

                <div className="rounded-2xl border border-yellow-500/10 bg-black p-3">
                  <div className="text-xs text-white/40">Folder</div>
                  <div className="mt-1 text-sm text-white/80">{folderFromPath(activeEntry.storage_path)}</div>
                </div>

                <div className="flex gap-2">
                  <a
                    href={downloadUrl ?? "#"}
                    target="_blank"
                    rel="noreferrer"
                    className={[
                      "w-full rounded-2xl border px-4 py-3 text-center text-sm",
                      downloadUrl
                        ? "border-yellow-400/25 bg-yellow-500/10 text-yellow-100 hover:bg-yellow-500/15"
                        : "border-yellow-500/10 bg-black text-white/30 cursor-not-allowed",
                    ].join(" ")}
                    onClick={(e) => {
                      if (!downloadUrl) e.preventDefault();
                    }}
                  >
                    Open PDF
                  </a>

                  <Link
                    href="/ci-archive/upload"
                    className="w-full rounded-2xl border border-yellow-500/10 bg-black px-4 py-3 text-center text-sm text-white/70 hover:bg-white/5"
                  >
                    Upload New
                  </Link>
                </div>

                <div className="text-xs leading-relaxed text-white/35">
                  CI-Archive is canonical. No stacked panels. Independent scrolling. Strict three columns. Always.
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
