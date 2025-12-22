"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";

type ForgeTab = "active" | "completed";

type ForgeEnvelope = {
  id: string;
  entity_key?: string | null;
  entity_slug?: string | null;
  record_id?: string | null;
  record_title?: string | null;
  status?: string | null;
  created_at?: string | null;
  updated_at?: string | null;

  // optional artifact fields (may or may not exist in your view/table)
  signed_pdf_path?: string | null;
  archived_entry_id?: string | null;
  archive_registry_id?: string | null;
  minute_book_entry_id?: string | null;
};

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function resolveEntitySlug(ctx: unknown): string | null {
  const c: any = ctx ?? {};
  return (
    c.entitySlug ??
    c.slug ??
    c.entity_key ??
    c.entityKey ??
    c.entity?.slug ??
    c.entity?.entity_slug ??
    c.entity?.entity_key ??
    c.selectedEntity?.slug ??
    c.selectedEntity?.entity_slug ??
    c.selectedEntity?.entity_key ??
    null
  );
}

function isCompletedStatus(status?: string | null) {
  const s = (status ?? "").toLowerCase();
  // tune these labels to your exact signature pipeline statuses
  return (
    s === "completed" ||
    s === "signed" ||
    s === "archived" ||
    s === "done" ||
    s === "complete"
  );
}

function prettyStatus(status?: string | null) {
  const s = (status ?? "").trim();
  return s.length ? s.toUpperCase() : "UNKNOWN";
}

async function tryFetchForgeRows(entitySlug: string | null): Promise<ForgeEnvelope[]> {
  // We try a dashboard view first (best for joins), then fall back to the base table.
  // This keeps wiring working even if you renamed things during refactors.
  const targets: Array<{ kind: "view" | "table"; name: string }> = [
    { kind: "view", name: "v_forge_envelopes" },
    { kind: "view", name: "v_signature_envelopes_dashboard" },
    { kind: "table", name: "signature_envelopes" },
  ];

  let lastError: any = null;

  for (const t of targets) {
    const q = supabase.from(t.name).select("*").order("created_at", { ascending: false });

    // entity scoping
    // (some schemas use entity_key, others entity_slug)
    if (entitySlug) {
      // try applying both in a permissive way:
      // if a column doesn't exist, PostgREST returns an error and we fall through to next target.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _q = q.or(`entity_key.eq.${entitySlug},entity_slug.eq.${entitySlug}`);
    }

    const { data, error } = await q;
    if (!error && Array.isArray(data)) {
      return data as ForgeEnvelope[];
    }
    lastError = error;
  }

  // If everything failed, surface nothing (UI stays stable) and log for dev.
  // No throwing so OS shell doesn’t crash.
  console.error("[CI-FORGE] Failed to fetch envelopes:", lastError);
  return [];
}

export default function ForgeClient() {
  const ctx = useEntity(); // DO NOT destructure { entity } — your context type doesn't have it
  const entitySlug = useMemo(() => resolveEntitySlug(ctx), [ctx]);

  const [tab, setTab] = useState<ForgeTab>("active");
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<ForgeEnvelope[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = useMemo(
    () => rows.find((r) => r.id === selectedId) ?? null,
    [rows, selectedId]
  );

  const filtered = useMemo(() => {
    if (tab === "active") return rows.filter((r) => !isCompletedStatus(r.status));
    return rows.filter((r) => isCompletedStatus(r.status));
  }, [rows, tab]);

  async function refresh() {
    setLoading(true);
    try {
      const data = await tryFetchForgeRows(entitySlug);
      setRows(data);

      // keep selection stable when possible
      if (selectedId && !data.some((r) => r.id === selectedId)) {
        setSelectedId(data[0]?.id ?? null);
      }
      if (!selectedId) setSelectedId(data[0]?.id ?? null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entitySlug]);

  // ---- Artifact links (kept simple + non-breaking) ----
  const signAppBase = "https://sign.oasisintlholdings.com";
  const openEnvelope = (id: string) => {
    // if you have a dedicated Forge signing UI route, swap this
    window.open(`${signAppBase}/sign.html?envelope_id=${encodeURIComponent(id)}`, "_blank");
  };

  const openArchiveEntry = (entryId: string) => {
    // adjust if your CI-Archive minute-book route expects query params instead
    window.open(`/ci-archive/minute-book?entry=${encodeURIComponent(entryId)}`, "_blank");
  };

  const openSignedPdfDirect = (path: string) => {
    // If you require Edge Function download-signed-pdf, replace this with that endpoint.
    // Keeping it generic so it never breaks compilation.
    window.open(path, "_blank");
  };

  async function archiveNow(row: ForgeEnvelope) {
    // This is intentionally non-blocking + safe:
    // If you already have a canonical RPC/Edge Function, wire it here without changing UI.
    //
    // Recommended: call a single RPC like `archive_signed_envelope(p_envelope_id uuid)`
    // or your existing "download-signed-pdf" + register logic.
    //
    // For now, we just try a conventional RPC name; if absent, we log and do nothing.
    if (!row?.id) return;

    setLoading(true);
    try {
      const { data, error } = await supabase.rpc("archive_signed_envelope", {
        p_envelope_id: row.id,
      });

      if (error) {
        console.warn("[CI-FORGE] archive_signed_envelope RPC missing or failed:", error);
        return;
      }

      console.log("[CI-FORGE] Archive RPC ok:", data);
      await refresh();
    } finally {
      setLoading(false);
    }
  }

  // ---- UI ----
  return (
    <div className="min-h-[calc(100vh-64px)] w-full p-4">
      <div className="mx-auto max-w-6xl">
        {/* Header */}
        <div className="mb-4 flex flex-col gap-2 rounded-2xl border border-white/10 bg-black/40 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-lg font-semibold text-white">CI-Forge</div>
              <div className="text-sm text-white/60">
                Signature execution queue • OS-scoped • Archive discipline preserved
              </div>
            </div>

            <div className="flex items-center gap-2">
              <div className="rounded-full border border-white/10 bg-black/50 px-3 py-1 text-xs text-white/70">
                Entity: <span className="text-white">{entitySlug ?? "All / Unscoped"}</span>
              </div>

              <button
                onClick={refresh}
                disabled={loading}
                className={cx(
                  "rounded-xl border border-white/10 px-3 py-2 text-sm",
                  "bg-black/50 text-white hover:bg-black/70",
                  loading && "opacity-60"
                )}
              >
                {loading ? "Refreshing…" : "Refresh"}
              </button>
            </div>
          </div>

          {/* Tabs */}
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => setTab("active")}
              className={cx(
                "rounded-xl px-3 py-2 text-sm",
                tab === "active"
                  ? "bg-yellow-500/15 text-yellow-200 border border-yellow-500/20"
                  : "bg-black/40 text-white/70 border border-white/10 hover:bg-black/60"
              )}
            >
              Active
            </button>
            <button
              onClick={() => setTab("completed")}
              className={cx(
                "rounded-xl px-3 py-2 text-sm",
                tab === "completed"
                  ? "bg-yellow-500/15 text-yellow-200 border border-yellow-500/20"
                  : "bg-black/40 text-white/70 border border-white/10 hover:bg-black/60"
              )}
            >
              Completed
            </button>

            <div className="ml-auto text-xs text-white/50">
              Showing <span className="text-white">{filtered.length}</span> of{" "}
              <span className="text-white">{rows.length}</span>
            </div>
          </div>
        </div>

        {/* 3-column OS layout */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          {/* Left: List */}
          <div className="lg:col-span-5 rounded-2xl border border-white/10 bg-black/40 overflow-hidden">
            <div className="border-b border-white/10 px-4 py-3 text-sm text-white/70">
              Envelopes
            </div>

            <div className="max-h-[70vh] overflow-auto">
              {filtered.length === 0 ? (
                <div className="p-6 text-sm text-white/60">
                  {tab === "active"
                    ? "No active envelopes."
                    : "No completed envelopes."}
                </div>
              ) : (
                <div className="divide-y divide-white/5">
                  {filtered.map((r) => {
                    const active = r.id === selectedId;
                    return (
                      <button
                        key={r.id}
                        onClick={() => setSelectedId(r.id)}
                        className={cx(
                          "w-full text-left px-4 py-3 transition",
                          active ? "bg-yellow-500/10" : "hover:bg-white/5"
                        )}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-white">
                              {r.record_title ?? r.record_id ?? "Untitled record"}
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-white/55">
                              <span className="rounded-full border border-white/10 bg-black/40 px-2 py-0.5">
                                {prettyStatus(r.status)}
                              </span>
                              {r.entity_key || r.entity_slug ? (
                                <span className="rounded-full border border-white/10 bg-black/40 px-2 py-0.5">
                                  {(r.entity_key ?? r.entity_slug) as string}
                                </span>
                              ) : null}
                              {r.created_at ? (
                                <span className="opacity-70">
                                  {new Date(r.created_at).toLocaleString()}
                                </span>
                              ) : null}
                            </div>
                          </div>

                          <div className="shrink-0 text-xs text-white/40">
                            #{r.id.slice(0, 6)}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Right: Evidence / Actions */}
          <div className="lg:col-span-7 rounded-2xl border border-white/10 bg-black/40 overflow-hidden">
            <div className="border-b border-white/10 px-4 py-3 text-sm text-white/70">
              Evidence • Actions
            </div>

            <div className="p-4">
              {!selected ? (
                <div className="text-sm text-white/60">Select an envelope to view details.</div>
              ) : (
                <div className="space-y-4">
                  {/* Summary */}
                  <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
                    <div className="text-sm font-semibold text-white">
                      {selected.record_title ?? "Execution Packet"}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 text-xs text-white/60">
                      <span className="rounded-full border border-yellow-500/20 bg-yellow-500/10 px-2 py-0.5 text-yellow-100">
                        {prettyStatus(selected.status)}
                      </span>
                      {selected.record_id ? (
                        <span className="rounded-full border border-white/10 bg-black/40 px-2 py-0.5">
                          record_id: {selected.record_id.slice(0, 8)}…
                        </span>
                      ) : null}
                      <span className="rounded-full border border-white/10 bg-black/40 px-2 py-0.5">
                        envelope: {selected.id.slice(0, 8)}…
                      </span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
                    <div className="mb-3 text-xs uppercase tracking-wide text-white/50">
                      Actions
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => openEnvelope(selected.id)}
                        className="rounded-xl border border-yellow-500/20 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-100 hover:bg-yellow-500/15"
                      >
                        Open Envelope
                      </button>

                      {selected.signed_pdf_path ? (
                        <button
                          onClick={() => openSignedPdfDirect(selected.signed_pdf_path as string)}
                          className="rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm text-white/80 hover:bg-black/60"
                        >
                          Open Signed PDF
                        </button>
                      ) : null}

                      {selected.minute_book_entry_id || selected.archived_entry_id ? (
                        <button
                          onClick={() =>
                            openArchiveEntry(
                              (selected.minute_book_entry_id ??
                                selected.archived_entry_id) as string
                            )
                          }
                          className="rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm text-white/80 hover:bg-black/60"
                        >
                          Open in CI-Archive
                        </button>
                      ) : null}

                      {/* Archive Now = only meaningful if signed/completed; still safe if clicked */}
                      <button
                        onClick={() => archiveNow(selected)}
                        disabled={loading}
                        className={cx(
                          "rounded-xl border border-white/10 px-3 py-2 text-sm",
                          "bg-black/40 text-white/80 hover:bg-black/60",
                          loading && "opacity-60"
                        )}
                        title="Calls RPC archive_signed_envelope(p_envelope_id). If your RPC is named differently, rename it inside archiveNow()."
                      >
                        Archive Now
                      </button>
                    </div>

                    <div className="mt-3 text-xs text-white/45">
                      Forge stays signature-only. Council decides signature vs direct archive; both paths must produce
                      archive-quality artifacts (PDF + hash + registry entry).
                    </div>
                  </div>

                  {/* Metadata Zone */}
                  <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
                    <div className="mb-3 text-xs uppercase tracking-wide text-white/50">
                      Metadata
                    </div>
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <div className="rounded-xl border border-white/10 bg-black/40 p-3">
                        <div className="text-xs text-white/50">Status</div>
                        <div className="text-sm text-white">{prettyStatus(selected.status)}</div>
                      </div>

                      <div className="rounded-xl border border-white/10 bg-black/40 p-3">
                        <div className="text-xs text-white/50">Entity</div>
                        <div className="text-sm text-white">
                          {(selected.entity_key ?? selected.entity_slug ?? entitySlug ?? "—") as string}
                        </div>
                      </div>

                      <div className="rounded-xl border border-white/10 bg-black/40 p-3">
                        <div className="text-xs text-white/50">Created</div>
                        <div className="text-sm text-white">
                          {selected.created_at ? new Date(selected.created_at).toLocaleString() : "—"}
                        </div>
                      </div>

                      <div className="rounded-xl border border-white/10 bg-black/40 p-3">
                        <div className="text-xs text-white/50">Updated</div>
                        <div className="text-sm text-white">
                          {selected.updated_at ? new Date(selected.updated_at).toLocaleString() : "—"}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* AXIOM advisory placeholder (advisory-only, never blocking) */}
                  <div className="rounded-2xl border border-yellow-500/15 bg-yellow-500/5 p-4">
                    <div className="text-xs uppercase tracking-wide text-yellow-100/70">
                      AXIOM Advisory (non-blocking)
                    </div>
                    <div className="mt-2 text-sm text-yellow-50/80">
                      Advisory-only panel placeholder. Severity flags allowed; never blocks execution.
                      (Wire Council first, then Forge.)
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer spacing */}
        <div className="h-10" />
      </div>
    </div>
  );
}
