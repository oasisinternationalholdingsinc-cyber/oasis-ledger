"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";

type VerifiedRow = {
  id: string;
  entity_id: string | null;
  entity_slug: string | null;
  title: string;
  document_class: string;
  source_table: string | null;
  source_record_id: string | null;
  storage_bucket: string;
  storage_path: string;
  file_hash: string | null;
  envelope_id: string | null;
  signed_at: string | null;
  created_at: string | null;
  verification_level: string;
  is_archived: boolean;

  // derived (joined)
  lane_is_test?: boolean | null;
  ledger_status?: string | null;
};

type Tab = "ALL" | "SIGNED" | "ARCHIVED";

export default function VerifiedRegistryPage() {
  const { activeEntity } = useEntity(); // IMPORTANT: this is a slug/key string in your OS (e.g. "holdings")
  const { env } = useOsEnv();
  const laneIsTest = env === "SANDBOX";

  const [entityId, setEntityId] = useState<string | null>(null);
  const [rows, setRows] = useState<VerifiedRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<Tab>("ALL");
  const [q, setQ] = useState("");

  // Resolve entity UUID from entities table using slug (no assumptions about OsEntityContext shape)
  useEffect(() => {
    let alive = true;

    async function resolveEntity() {
      if (!activeEntity) {
        if (alive) setEntityId(null);
        return;
      }

      const { data, error } = await supabase
        .from("entities")
        .select("id")
        .eq("slug", String(activeEntity))
        .limit(1)
        .maybeSingle();

      if (!alive) return;

      if (error) {
        console.error("resolveEntity error", error);
        setEntityId(null);
        return;
      }

      setEntityId(data?.id ?? null);
    }

    resolveEntity();
    return () => {
      alive = false;
    };
  }, [activeEntity]);

  useEffect(() => {
    let alive = true;

    async function load() {
      if (!entityId) {
        setRows([]);
        return;
      }

      setLoading(true);

      const { data: vd, error: vdErr } = await supabase
        .from("verified_documents")
        .select(
          "id,entity_id,entity_slug,title,document_class,source_table,source_record_id,storage_bucket,storage_path,file_hash,envelope_id,signed_at,created_at,verification_level,is_archived"
        )
        .eq("entity_id", entityId)
        .order("created_at", { ascending: false })
        .limit(300);

      if (!alive) return;

      if (vdErr) {
        console.error("verified_documents load error", vdErr);
        setRows([]);
        setLoading(false);
        return;
      }

      const recordIds = (vd ?? [])
        .map((r: any) => r.source_record_id)
        .filter(Boolean) as string[];

      const laneMap = new Map<string, { is_test: boolean; status: string }>();

      if (recordIds.length) {
        const { data: gl, error: glErr } = await supabase
          .from("governance_ledger")
          .select("id,is_test,status")
          .in("id", recordIds);

        if (!glErr && gl) {
          for (const r of gl as any[]) {
            laneMap.set(r.id, { is_test: !!r.is_test, status: String(r.status ?? "") });
          }
        }
      }

      const merged: VerifiedRow[] = (vd ?? []).map((r: any) => {
        const m = r.source_record_id ? laneMap.get(r.source_record_id) : null;
        return {
          ...(r as VerifiedRow),
          lane_is_test: m?.is_test ?? null,
          ledger_status: m?.status ?? null,
        };
      });

      // Lane filter:
      // - If linked to ledger: enforce lane match
      // - If NOT linked: show in both lanes (registry-only docs)
      const laneFiltered = merged.filter((r) => {
        if (r.lane_is_test === null || r.lane_is_test === undefined) return true;
        return r.lane_is_test === laneIsTest;
      });

      setRows(laneFiltered);
      setLoading(false);
    }

    load();
    return () => {
      alive = false;
    };
  }, [entityId, laneIsTest]);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();

    return rows.filter((r) => {
      if (tab === "SIGNED" && !r.signed_at) return false;
      if (tab === "ARCHIVED" && !r.is_archived) return false;

      if (!qq) return true;
      const hay = `${r.title} ${r.document_class} ${r.storage_path} ${r.file_hash ?? ""}`.toLowerCase();
      return hay.includes(qq);
    });
  }, [rows, tab, q]);

  return (
    <div className="min-h-[calc(100vh-120px)] px-6 py-6">
      <div className="mx-auto max-w-[1400px]">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-[11px] tracking-[0.28em] text-white/50">CI-ARCHIVE</div>
            <h1 className="mt-1 text-xl font-semibold text-white">Verified Registry</h1>
            <div className="mt-1 text-sm text-white/60">
              Lane: <span className="text-white/80">{laneIsTest ? "SANDBOX" : "RoT"}</span> · Entity:{" "}
              <span className="text-white/80">{String(activeEntity ?? "").toUpperCase()}</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Link
              href="/ci-archive"
              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10"
            >
              Back to Launchpad →
            </Link>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-12 gap-4">
          {/* Left: filters */}
          <div className="col-span-12 md:col-span-3">
            <div className="rounded-2xl border border-white/10 bg-black/40 p-4">
              <div className="text-[11px] tracking-[0.28em] text-white/50">FILTERS</div>

              <div className="mt-3 flex flex-wrap gap-2">
                {(["ALL", "SIGNED", "ARCHIVED"] as Tab[]).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={[
                      "rounded-full px-3 py-1 text-xs",
                      tab === t
                        ? "border border-amber-400/40 bg-amber-400/10 text-amber-100"
                        : "border border-white/10 bg-white/5 text-white/70 hover:bg-white/10",
                    ].join(" ")}
                  >
                    {t}
                  </button>
                ))}
              </div>

              <div className="mt-4">
                <div className="text-[11px] tracking-[0.28em] text-white/50">SEARCH</div>
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="title, hash, path..."
                  className="mt-2 w-full rounded-xl border border-white/10 bg-black/50 px-3 py-2 text-sm text-white/80 outline-none placeholder:text-white/30 focus:border-amber-400/30"
                />
              </div>

              <div className="mt-4 text-xs text-white/50">
                {loading ? "Loading..." : `${filtered.length} result(s)`}
              </div>

              <div className="mt-3 rounded-xl border border-white/10 bg-white/5 p-3 text-xs text-white/60">
                Registry-only. No destructive actions here.
              </div>
            </div>
          </div>

          {/* Middle: list */}
          <div className="col-span-12 md:col-span-5">
            <div className="rounded-2xl border border-white/10 bg-black/40">
              <div className="border-b border-white/10 px-4 py-3">
                <div className="text-[11px] tracking-[0.28em] text-white/50">DOCUMENTS</div>
              </div>

              <div className="max-h-[calc(100vh-260px)] overflow-auto px-2 py-2">
                {filtered.length === 0 ? (
                  <div className="p-4 text-sm text-white/50">
                    {loading ? "Loading registry…" : "No documents match this view."}
                  </div>
                ) : (
                  filtered.map((r) => (
                    <div
                      key={r.id}
                      className="mb-2 rounded-xl border border-white/10 bg-white/5 p-3 hover:bg-white/10"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium text-white">{r.title}</div>
                          <div className="mt-1 text-xs text-white/55">
                            {r.document_class} · {r.verification_level}
                            {r.ledger_status ? ` · Ledger: ${r.ledger_status}` : ""}
                          </div>
                          <div className="mt-2 break-all text-[11px] text-white/40">{r.storage_path}</div>
                        </div>

                        <div className="flex flex-col items-end gap-2">
                          <span
                            className={[
                              "rounded-full px-2 py-1 text-[11px]",
                              r.signed_at
                                ? "border border-emerald-400/30 bg-emerald-400/10 text-emerald-100"
                                : "border border-white/10 bg-black/30 text-white/60",
                            ].join(" ")}
                          >
                            {r.signed_at ? "SIGNED" : "DRAFT"}
                          </span>

                          <Link
                            href={`/ci-archive/verified/${r.id}`}
                            className="rounded-lg border border-amber-400/20 bg-amber-400/10 px-2 py-1 text-[11px] text-amber-100 hover:bg-amber-400/15"
                          >
                            Open →
                          </Link>
                        </div>
                      </div>

                      {r.file_hash ? (
                        <div className="mt-2 break-all text-[11px] text-white/35">hash: {r.file_hash}</div>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Right: guidance */}
          <div className="col-span-12 md:col-span-4">
            <div className="rounded-2xl border border-white/10 bg-black/40 p-4">
              <div className="text-[11px] tracking-[0.28em] text-white/50">HOW THIS BECOMES “VALID”</div>

              <div className="mt-3 space-y-3 text-sm text-white/70">
                <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                  1) Council approves → <span className="text-white/80">approved_by_council = true</span>
                </div>
                <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                  2) Forge completes envelope →{" "}
                  <span className="text-white/80">signature_envelopes.status = completed</span>
                </div>
                <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                  3) Seal/Archive (service role) → writes{" "}
                  <span className="text-white/80">verified_documents</span> + minute book evidence
                </div>
                <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                  4) verify_governance_archive(record_id) → VALID
                </div>
              </div>

              <div className="mt-4 text-xs text-white/50">
                Lane-safe: list filters by <span className="text-white/70">governance_ledger.is_test</span> via{" "}
                <span className="text-white/70">verified_documents.source_record_id</span>.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
