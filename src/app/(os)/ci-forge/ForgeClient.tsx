// src/app/(os)/ci-forge/page.tsx
"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";

type ForgeTab = "active" | "completed";

type EnvelopeStatus =
  | "DRAFT"
  | "SENT"
  | "PENDING"
  | "SIGNING"
  | "SIGNED"
  | "COMPLETED"
  | "ARCHIVED"
  | "VOIDED"
  | "CANCELLED"
  | string;

type ForgeEnvelope = {
  id: string;

  // record linkage (governance_ledger)
  record_id: string | null;
  record_title: string | null;
  record_status: string | null;

  // scoping
  entity_key: string | null;
  entity_slug: string | null;
  entity_name: string | null;

  // envelope state
  status: EnvelopeStatus;
  created_at: string | null;
  updated_at: string | null;
  completed_at: string | null;

  // artifacts (optional, depending on your schema/view)
  sign_url: string | null;
  signed_pdf_path: string | null;
  archived_entry_id: string | null;
  archived_storage_path: string | null;
};

const ACTIVE_SET = new Set(["DRAFT", "SENT", "PENDING", "SIGNING"]);
const COMPLETED_SET = new Set(["SIGNED", "COMPLETED", "ARCHIVED", "VOIDED", "CANCELLED"]);

/**
 * IMPORTANT:
 * - This page intentionally avoids any login redirects (OS auth gate only).
 * - Entity scoping is enforced via useEntity() (no Holdings hard-default).
 * - Active vs Completed keeps executed envelopes out of your face.
 *
 * DATA SOURCE:
 * Prefer a view that already joins governance_ledger + entities + envelope artifacts.
 * If you already have it, set FORGE_SOURCE = "v_forge_envelopes" and keep column names aligned.
 * Otherwise, you can point it to "signature_envelopes" and adjust selects accordingly.
 */
const FORGE_SOURCE = "v_forge_envelopes"; // <- change to your existing view/table if different

function fmt(ts: string | null) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function pillClass(kind: "gold" | "green" | "gray" | "red") {
  switch (kind) {
    case "gold":
      return "border-amber-400/40 bg-amber-500/10 text-amber-200";
    case "green":
      return "border-emerald-400/40 bg-emerald-500/10 text-emerald-200";
    case "red":
      return "border-rose-400/40 bg-rose-500/10 text-rose-200";
    default:
      return "border-white/10 bg-white/5 text-white/70";
  }
}

function statusKind(s: string) {
  const u = (s || "").toUpperCase();
  if (u === "SIGNED" || u === "COMPLETED" || u === "ARCHIVED") return "green";
  if (u === "VOIDED" || u === "CANCELLED") return "red";
  if (u === "SIGNING" || u === "PENDING" || u === "SENT") return "gold";
  return "gray";
}

export default function CiForgePage() {
  const { entity } = useEntity(); // must follow OS selector
  const [tab, setTab] = useState<ForgeTab>("active");
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<ForgeEnvelope[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ForgeEnvelope | null>(null);

  const entityKey = entity?.key || entity?.slug || null;

  const scopedRows = useMemo(() => {
    const filtered = entityKey
      ? rows.filter((r) => (r.entity_key || r.entity_slug || "").toLowerCase() === entityKey.toLowerCase())
      : rows;

    const byTab =
      tab === "active"
        ? filtered.filter((r) => ACTIVE_SET.has((r.status || "").toUpperCase()))
        : filtered.filter((r) => COMPLETED_SET.has((r.status || "").toUpperCase()));

    // newest first (created_at fallback updated_at)
    return byTab.sort((a, b) => {
      const ta = new Date(a.created_at || a.updated_at || 0).getTime();
      const tb = new Date(b.created_at || b.updated_at || 0).getTime();
      return tb - ta;
    });
  }, [rows, tab, entityKey]);

  async function load() {
    setLoading(true);
    setError(null);

    try {
      // Attempt: view/table already provides all columns we need
      // If your view doesn’t include some fields, it’s fine — they’ll just be null/undefined.
      const { data, error } = await supabase
        .from(FORGE_SOURCE)
        .select(
          [
            "id",
            "record_id",
            "record_title",
            "record_status",
            "entity_key",
            "entity_slug",
            "entity_name",
            "status",
            "created_at",
            "updated_at",
            "completed_at",
            "sign_url",
            "signed_pdf_path",
            "archived_entry_id",
            "archived_storage_path",
          ].join(",")
        )
        .limit(500);

      if (error) throw error;

      const normalized = (data || []).map((r: any) => ({
        id: String(r.id),
        record_id: r.record_id ? String(r.record_id) : null,
        record_title: r.record_title ?? null,
        record_status: r.record_status ?? null,
        entity_key: r.entity_key ?? null,
        entity_slug: r.entity_slug ?? null,
        entity_name: r.entity_name ?? null,
        status: (r.status ?? "UNKNOWN") as EnvelopeStatus,
        created_at: r.created_at ?? null,
        updated_at: r.updated_at ?? null,
        completed_at: r.completed_at ?? null,
        sign_url: r.sign_url ?? null,
        signed_pdf_path: r.signed_pdf_path ?? null,
        archived_entry_id: r.archived_entry_id ? String(r.archived_entry_id) : null,
        archived_storage_path: r.archived_storage_path ?? null,
      })) as ForgeEnvelope[];

      setRows(normalized);

      // keep selection stable if possible
      setSelected((prev) => {
        if (!prev) return normalized[0] || null;
        const hit = normalized.find((x) => x.id === prev.id);
        return hit || normalized[0] || null;
      });
    } catch (e: any) {
      setError(e?.message || "Failed to load Forge queue.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // If the current selection is outside the scoped tab, auto-pick first in scope.
    if (!selected) return;
    const visibleIds = new Set(scopedRows.map((r) => r.id));
    if (!visibleIds.has(selected.id)) setSelected(scopedRows[0] || null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, entityKey, scopedRows.length]);

  const selectedStatus = (selected?.status || "").toUpperCase();
  const isActive = ACTIVE_SET.has(selectedStatus);
  const isCompleted = COMPLETED_SET.has(selectedStatus);

  const headerTitle = entity?.label || entity?.name || "CI-Forge";
  const scopeLabel = entityKey ? `Scoped to: ${entityKey}` : "Scoped to: all entities";

  return (
    <div className="min-h-[calc(100vh-64px)] px-4 py-5">
      {/* Header */}
      <div className="mb-4 flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs text-white/50">CI-Forge</div>
            <div className="text-xl font-semibold text-white">{headerTitle}</div>
            <div className="mt-1 text-sm text-white/60">{scopeLabel}</div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={load}
              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10"
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>

            <div className="flex overflow-hidden rounded-xl border border-white/10 bg-white/5">
              <button
                onClick={() => setTab("active")}
                className={[
                  "px-3 py-2 text-sm",
                  tab === "active" ? "bg-amber-500/10 text-amber-200" : "text-white/70 hover:bg-white/10",
                ].join(" ")}
              >
                Active
              </button>
              <button
                onClick={() => setTab("completed")}
                className={[
                  "px-3 py-2 text-sm",
                  tab === "completed" ? "bg-amber-500/10 text-amber-200" : "text-white/70 hover:bg-white/10",
                ].join(" ")}
              >
                Completed
              </button>
            </div>
          </div>
        </div>

        {error ? (
          <div className="rounded-2xl border border-rose-400/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            {error}
            <div className="mt-1 text-xs text-rose-200/70">
              Tip: If you don’t have <code className="text-rose-200">v_forge_envelopes</code>, set{" "}
              <code className="text-rose-200">FORGE_SOURCE</code> to your real table/view.
            </div>
          </div>
        ) : null}
      </div>

      {/* 3-column OS layout */}
      <div className="grid grid-cols-12 gap-4">
        {/* Left: Queue */}
        <div className="col-span-12 md:col-span-4">
          <div className="rounded-2xl border border-white/10 bg-black/30 p-3">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-medium text-white/80">
                Queue <span className="text-white/40">({scopedRows.length})</span>
              </div>
              <div className="text-xs text-white/40">{tab === "active" ? "In execution" : "Finished"}</div>
            </div>

            <div className="max-h-[70vh] overflow-auto pr-1">
              {scopedRows.length === 0 ? (
                <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-white/60">
                  {tab === "active"
                    ? "No active envelopes for this entity."
                    : "No completed envelopes for this entity."}
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {scopedRows.map((r) => {
                    const active = selected?.id === r.id;
                    const kind = statusKind((r.status || "").toUpperCase()) as any;
                    return (
                      <button
                        key={r.id}
                        onClick={() => setSelected(r)}
                        className={[
                          "w-full rounded-2xl border px-3 py-3 text-left transition",
                          active
                            ? "border-amber-400/30 bg-amber-500/10"
                            : "border-white/10 bg-white/5 hover:bg-white/10",
                        ].join(" ")}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-white">
                              {r.record_title || "Untitled record"}
                            </div>
                            <div className="mt-1 truncate text-xs text-white/50">
                              {r.entity_name || r.entity_slug || r.entity_key || "—"}
                            </div>
                          </div>
                          <span
                            className={[
                              "shrink-0 rounded-full border px-2 py-1 text-[11px] uppercase tracking-wide",
                              pillClass(kind),
                            ].join(" ")}
                          >
                            {(r.status || "UNKNOWN").toString()}
                          </span>
                        </div>

                        <div className="mt-2 flex items-center justify-between text-[11px] text-white/45">
                          <span>Created: {fmt(r.created_at)}</span>
                          <span>{r.record_status ? `Ledger: ${r.record_status}` : ""}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Middle: Details */}
        <div className="col-span-12 md:col-span-4">
          <div className="rounded-2xl border border-white/10 bg-black/30 p-3">
            <div className="mb-2 text-sm font-medium text-white/80">Envelope</div>

            {!selected ? (
              <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-white/60">
                Select an envelope to view details.
              </div>
            ) : (
              <div className="space-y-3">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-white">
                        {selected.record_title || "Untitled record"}
                      </div>
                      <div className="mt-1 text-xs text-white/50">
                        Entity: {selected.entity_name || selected.entity_slug || selected.entity_key || "—"}
                      </div>
                    </div>
                    <span
                      className={[
                        "shrink-0 rounded-full border px-2 py-1 text-[11px] uppercase tracking-wide",
                        pillClass(statusKind(selectedStatus) as any),
                      ].join(" ")}
                    >
                      {selectedStatus || "UNKNOWN"}
                    </span>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-white/60">
                    <div className="rounded-xl border border-white/10 bg-black/20 p-2">
                      <div className="text-[11px] text-white/40">Created</div>
                      <div className="mt-0.5 text-white/70">{fmt(selected.created_at)}</div>
                    </div>
                    <div className="rounded-xl border border-white/10 bg-black/20 p-2">
                      <div className="text-[11px] text-white/40">Completed</div>
                      <div className="mt-0.5 text-white/70">{fmt(selected.completed_at)}</div>
                    </div>
                    <div className="col-span-2 rounded-xl border border-white/10 bg-black/20 p-2">
                      <div className="text-[11px] text-white/40">Ledger</div>
                      <div className="mt-0.5 text-white/70">
                        {selected.record_status || "—"}
                        {selected.record_id ? (
                          <span className="ml-2 text-white/35">(record_id: {selected.record_id})</span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Artifacts */}
                <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                  <div className="text-sm font-medium text-white/80">Artifacts</div>
                  <div className="mt-2 space-y-2 text-sm">
                    <ArtifactRow
                      label="Sign link"
                      value={selected.sign_url}
                      render={(v) => (
                        <a
                          href={v}
                          target="_blank"
                          rel="noreferrer"
                          className="text-amber-200 hover:underline"
                        >
                          Open signing page
                        </a>
                      )}
                    />
                    <ArtifactRow label="Signed PDF path" value={selected.signed_pdf_path} />
                    <ArtifactRow label="Archive entry_id" value={selected.archived_entry_id} />
                    <ArtifactRow label="Archive storage_path" value={selected.archived_storage_path} />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right: Actions + AXIOM advisory */}
        <div className="col-span-12 md:col-span-4">
          <div className="rounded-2xl border border-white/10 bg-black/30 p-3">
            <div className="mb-2 text-sm font-medium text-white/80">Actions</div>

            {!selected ? (
              <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-white/60">
                No selection.
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  {/* Approved → Open in Forge (this page) - CTA is wired elsewhere; here we give record link */}
                  <Link
                    href={selected.record_id ? `/ci-council?record=${selected.record_id}` : "/ci-council"}
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-center text-sm text-white/80 hover:bg-white/10"
                  >
                    Open in Council
                  </Link>

                  {/* Signed → Archive Now (the actual “Archive Now” action should be a server-side function elsewhere;
                      here we route to Archive registry for that entry/record) */}
                  <Link
                    href={
                      selected.archived_entry_id
                        ? `/ci-archive/minute-book`
                        : selected.record_id
                        ? `/ci-archive/ledger`
                        : "/ci-archive"
                    }
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-center text-sm text-white/80 hover:bg-white/10"
                  >
                    Open in CI-Archive
                  </Link>
                </div>

                <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                  <div className="text-sm font-medium text-white/80">Execution</div>
                  <div className="mt-2 text-sm text-white/60">
                    Forge is <span className="text-amber-200">signature-only</span>. If Council chose “direct archive,”
                    that record should bypass Forge but still generate the same archive-quality artifacts (PDF + hash +
                    registry).
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {selected.sign_url ? (
                      <a
                        href={selected.sign_url}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200 hover:bg-amber-500/15"
                      >
                        Open signing page
                      </a>
                    ) : (
                      <button
                        disabled
                        className="cursor-not-allowed rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/30"
                      >
                        Signing link unavailable
                      </button>
                    )}

                    {isActive ? (
                      <button
                        disabled
                        className="cursor-not-allowed rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/30"
                      >
                        Archive (locked until signed)
                      </button>
                    ) : (
                      <Link
                        href="/ci-archive/minute-book"
                        className="rounded-xl border border-emerald-400/20 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200 hover:bg-emerald-500/15"
                      >
                        Archive / Verify
                      </Link>
                    )}
                  </div>

                  <div className="mt-3 text-xs text-white/40">
                    Status gate:{" "}
                    <span className="text-white/60">
                      {isActive ? "active execution" : isCompleted ? "completed" : "unknown"}
                    </span>
                  </div>
                </div>

                <AxiomAdvisoryPanel
                  entityKey={entityKey}
                  recordId={selected.record_id}
                  envelopeStatus={selectedStatus}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ArtifactRow({
  label,
  value,
  render,
}: {
  label: string;
  value: string | null;
  render?: (v: string) => React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-xl border border-white/10 bg-black/20 px-3 py-2">
      <div className="text-xs text-white/45">{label}</div>
      <div className="min-w-0 text-right text-xs text-white/70">
        {value ? (render ? render(value) : <span className="break-all">{value}</span>) : "—"}
      </div>
    </div>
  );
}

/**
 * AXIOM tone rules (implemented here as UI discipline):
 * - Advisory-only, never blocks actions.
 * - Uses severity flags (INFO / WATCH / RISK) but no hard gates.
 * - Content is optional; if you later wire a real endpoint, this component will render it.
 */
function AxiomAdvisoryPanel({
  entityKey,
  recordId,
  envelopeStatus,
}: {
  entityKey: string | null;
  recordId: string | null;
  envelopeStatus: string;
}) {
  const [loading, setLoading] = useState(false);
  const [advice, setAdvice] = useState<string | null>(null);
  const [severity, setSeverity] = useState<"INFO" | "WATCH" | "RISK">("INFO");

  useEffect(() => {
    // Keep this non-blocking and resilient. If no endpoint exists, it simply stays silent.
    let cancelled = false;

    async function run() {
      setLoading(true);
      setAdvice(null);

      try {
        if (!recordId) return;

        // OPTIONAL: if you later add an API route, it can respond with:
        // { severity: "INFO"|"WATCH"|"RISK", advice: "..." }
        const res = await fetch(`/api/axiom/forge-advice?record_id=${encodeURIComponent(recordId)}`, {
          method: "GET",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
        });

        if (!res.ok) return;

        const json = await res.json();
        if (cancelled) return;

        const sev = String(json?.severity || "INFO").toUpperCase();
        if (sev === "RISK" || sev === "WATCH" || sev === "INFO") setSeverity(sev);
        setAdvice(typeof json?.advice === "string" ? json.advice : null);
      } catch {
        // silent by design
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [recordId]);

  const badge =
    severity === "RISK"
      ? pillClass("red")
      : severity === "WATCH"
      ? pillClass("gold")
      : pillClass("gray");

  const defaultCopy =
    envelopeStatus === "SIGNED" || envelopeStatus === "COMPLETED" || envelopeStatus === "ARCHIVED"
      ? "AXIOM: execution appears complete. Confirm archive artifacts are present (PDF + hash + registry)."
      : "AXIOM: signature execution in progress. Confirm parties list is correct and that you’re not bypassing archive discipline.";

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-white/80">AXIOM Advisory</div>
        <span className={["rounded-full border px-2 py-1 text-[11px] uppercase tracking-wide", badge].join(" ")}>
          {severity}
        </span>
      </div>

      <div className="mt-2 text-xs text-white/45">Entity scope: {entityKey || "—"}</div>

      <div className="mt-3 rounded-xl border border-white/10 bg-black/20 p-3 text-sm text-white/70">
        {loading ? "AXIOM is evaluating…" : advice || defaultCopy}
      </div>

      <div className="mt-2 text-xs text-white/40">
        Tone rule: advisory-only — never blocks, never redirects, never gates.
      </div>
    </div>
  );
}
