"use client";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";

/**
 * CI-Forge (Signature-only execution queue)
 * - MUST follow OS selector (no Holdings hard-default)
 * - Active vs Completed tabs
 * - 3-column enterprise layout: Queue / Evidence + Actions / Metadata
 * - No in-module auth redirects
 * - No useSearchParams
 */

type ForgeTab = "active" | "completed";

type Severity = "ok" | "warn" | "risk";

type ForgeEnvelope = {
  id: string;
  created_at?: string | null;
  updated_at?: string | null;

  // common envelope fields (schema may vary)
  status?: string | null; // e.g. pending, sent, signing, signed, completed, archived
  title?: string | null;
  record_id?: string | null; // governance_ledger id sometimes stored here
  source_record_id?: string | null;
  entity_slug?: string | null;
  entity_key?: string | null;

  // artifact links / paths (optional)
  signed_pdf_path?: string | null;
  archived_entry_id?: string | null;
  envelope_url?: string | null;

  // catch-all
  [key: string]: any;
};

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function fmtTime(ts?: string | null) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}

function norm(s?: string | null) {
  return (s ?? "").toString().trim().toLowerCase();
}

function pickEntitySlug(entityCtx: unknown): string | null {
  const c: any = entityCtx as any;
  // Support a few likely shapes without relying on any single one
  return (
    c?.entitySlug ??
    c?.entity_slug ??
    c?.slug ??
    c?.selectedEntity?.slug ??
    c?.selected?.slug ??
    c?.current?.slug ??
    null
  );
}

function pickEntityLabel(entityCtx: unknown): string | null {
  const c: any = entityCtx as any;
  return (
    c?.entityLabel ??
    c?.entity_label ??
    c?.label ??
    c?.selectedEntity?.label ??
    c?.selectedEntity?.name ??
    c?.selected?.label ??
    c?.selected?.name ??
    c?.current?.label ??
    c?.current?.name ??
    null
  );
}

function isCompletedStatus(status?: string | null) {
  const s = norm(status);
  return (
    s === "signed" ||
    s === "completed" ||
    s === "done" ||
    s === "archived" ||
    s === "complete"
  );
}

function isActiveStatus(status?: string | null) {
  const s = norm(status);
  if (!s) return true; // treat unknown as active so it doesn't disappear
  return !isCompletedStatus(s);
}

function deriveTitle(row: ForgeEnvelope) {
  return (
    row.title ||
    row.record_title ||
    row.resolution_title ||
    row.document_title ||
    row.name ||
    `Envelope ${row.id.slice(0, 8)}`
  );
}

function deriveStatusLabel(row: ForgeEnvelope) {
  const s = row.status ?? row.envelope_status ?? row.state ?? "unknown";
  return String(s);
}

function deriveRecordId(row: ForgeEnvelope): string | null {
  return (
    row.record_id ||
    row.source_record_id ||
    row.governance_record_id ||
    row.resolution_id ||
    row.ledger_id ||
    null
  );
}

function deriveEntitySlugFromRow(row: ForgeEnvelope): string | null {
  return row.entity_slug || row.entity_key || row.entity || row.entityId || null;
}

function axiomAdvisoryFor(row: ForgeEnvelope): { severity: Severity; title: string; body: string } {
  // Advisory-only: never blocks, never changes wiring.
  const status = norm(row.status);
  if (status.includes("signed") || status.includes("completed") || status.includes("archived")) {
    return {
      severity: "ok",
      title: "AXIOM: Execution complete",
      body: "This envelope is complete. Next step is registry verification and lifecycle traceability (Archive link + hash evidence).",
    };
  }
  if (status.includes("sign") || status.includes("sent")) {
    return {
      severity: "warn",
      title: "AXIOM: Signature in progress",
      body: "Keep Forge signature-only discipline. After completion, ensure the signed PDF is archived to CI-Archive (minute book registry) with hash evidence.",
    };
  }
  return {
    severity: "risk",
    title: "AXIOM: Pending execution",
    body: "Confirm Council intent: signature-required execution only. Do not bypass PDF + archive discipline. Once signatures start, track completion then archive.",
  };
}

export default function ForgeClient() {
  const entityCtx = useEntity(); // <- DO NOT destructure { entity } (your TS error)
  const entitySlug = pickEntitySlug(entityCtx);
  const entityLabel = pickEntityLabel(entityCtx) ?? entitySlug ?? "—";

  const [tab, setTab] = useState<ForgeTab>("active");
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<ForgeEnvelope[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected = useMemo(
    () => rows.find((r) => r.id === selectedId) ?? null,
    [rows, selectedId]
  );

  const filtered = useMemo(() => {
    const scoped = rows.filter((r) => {
      // OS scope: if row has an entity marker, it must match the OS selector.
      // If row has no entity marker, keep it (prevents accidental hiding due to schema mismatch).
      if (!entitySlug) return true;
      const rowSlug = norm(deriveEntitySlugFromRow(r));
      if (!rowSlug) return true;
      return rowSlug === norm(entitySlug);
    });

    return scoped.filter((r) => {
      const st = r.status ?? r.envelope_status ?? r.state ?? null;
      return tab === "active" ? isActiveStatus(st) : isCompletedStatus(st);
    });
  }, [rows, tab, entitySlug]);

  async function load() {
    setLoading(true);
    setError(null);

    try {
      /**
       * IMPORTANT:
       * We don’t assume a brittle view name.
       * We read from signature_envelopes (most likely table) and keep the code schema-tolerant.
       */
      const { data, error: qErr } = await supabase
        .from("signature_envelopes")
        .select("*")
        .order("created_at", { ascending: false });

      if (qErr) throw qErr;

      const list = (data ?? []) as ForgeEnvelope[];
      setRows(list);

      // keep selection stable if possible
      if (selectedId && !list.some((r) => r.id === selectedId)) {
        setSelectedId(null);
      }
    } catch (e: any) {
      setError(e?.message ?? "Failed to load envelopes.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // reload when entity scope changes (OS selector)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entitySlug]);

  const showingCount = filtered.length;
  const totalCount = useMemo(() => {
    // total in this entity scope (for header)
    const scoped = rows.filter((r) => {
      if (!entitySlug) return true;
      const rowSlug = norm(deriveEntitySlugFromRow(r));
      if (!rowSlug) return true;
      return rowSlug === norm(entitySlug);
    });
    return scoped.length;
  }, [rows, entitySlug]);

  // ---- Actions (safe / wiring-neutral) ----

  async function openEnvelopeInNewTab() {
    if (!selected) return;
    const url =
      selected.envelope_url ||
      selected.sign_url ||
      selected.url ||
      selected.public_url ||
      null;

    if (url) {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }

    // fallback: if you have a hosted sign page that takes envelope id
    // adjust path if needed, but keep it non-breaking if absent
    window.open(`/sign?envelope=${selected.id}`, "_blank", "noopener,noreferrer");
  }

  async function openSignedPdfIfPresent() {
    if (!selected) return;
    const path =
      selected.signed_pdf_path ||
      selected.signed_storage_path ||
      selected.signed_file_path ||
      selected.storage_path ||
      null;

    if (!path) return;

    // If your signed PDF lives in a bucket and you have a download edge function,
    // you likely already have a route for it. We keep it generic:
    window.open(`/api/signed-pdf?path=${encodeURIComponent(path)}`, "_blank", "noopener,noreferrer");
  }

  async function openArchiveEntryIfPresent() {
    if (!selected) return;
    const entryId =
      selected.archived_entry_id ||
      selected.minute_book_entry_id ||
      selected.archive_entry_id ||
      null;

    if (!entryId) return;

    // Keep consistent with CI-Archive Minute Book deep-linking style
    window.open(`/ci-archive/minute-book?entry=${encodeURIComponent(entryId)}`, "_blank", "noopener,noreferrer");
  }

  // ---- UI ----

  const ax = selected ? axiomAdvisoryFor(selected) : null;

  return (
    <div className="w-full">
      {/* Header */}
      <div className="mb-5 rounded-2xl border border-white/10 bg-black/30 p-5 shadow-[0_0_0_1px_rgba(255,215,128,0.06)]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-lg font-semibold tracking-tight text-white">CI-Forge</div>
            <div className="text-sm text-white/60">
              Signature execution queue • OS-scoped • Archive discipline preserved
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="rounded-full border border-white/10 bg-black/30 px-3 py-1 text-xs text-white/70">
              Entity: <span className="text-white/90">{entitySlug ?? "—"}</span>
            </div>

            <button
              onClick={load}
              className={cx(
                "rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/90",
                "hover:border-[rgba(255,215,128,0.35)] hover:bg-white/10",
                loading && "opacity-60"
              )}
              disabled={loading}
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>

        {/* Tabs + counts */}
        <div className="mt-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-black/20 p-1">
            <button
              onClick={() => setTab("active")}
              className={cx(
                "rounded-xl px-4 py-2 text-sm",
                tab === "active"
                  ? "bg-white/10 text-white shadow-[0_0_0_1px_rgba(255,215,128,0.22)]"
                  : "text-white/60 hover:text-white/85"
              )}
            >
              Active
            </button>
            <button
              onClick={() => setTab("completed")}
              className={cx(
                "rounded-xl px-4 py-2 text-sm",
                tab === "completed"
                  ? "bg-[rgba(255,215,128,0.12)] text-[rgb(255,215,128)] shadow-[0_0_0_1px_rgba(255,215,128,0.30)]"
                  : "text-white/60 hover:text-white/85"
              )}
            >
              Completed
            </button>
          </div>

          <div className="text-xs text-white/55">
            Showing <span className="text-white/85">{showingCount}</span> of{" "}
            <span className="text-white/85">{totalCount}</span>
          </div>
        </div>

        {error ? (
          <div className="mt-3 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-200">
            {error}
          </div>
        ) : null}
      </div>

      {/* 3-column grid */}
      <div className="grid grid-cols-12 gap-4">
        {/* Column 1: Queue */}
        <div className="col-span-12 lg:col-span-5">
          <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
            <div className="mb-3 text-sm font-medium text-white/85">
              Envelopes
            </div>

            <div className="max-h-[62vh] overflow-auto pr-1">
              {filtered.length === 0 ? (
                <div className="rounded-xl border border-white/10 bg-black/20 p-4 text-sm text-white/55">
                  {tab === "active" ? "No active envelopes." : "No completed envelopes."}
                </div>
              ) : (
                <div className="space-y-2">
                  {filtered.map((r) => {
                    const isSel = r.id === selectedId;
                    const status = deriveStatusLabel(r);
                    const title = deriveTitle(r);
                    return (
                      <button
                        key={r.id}
                        onClick={() => setSelectedId(r.id)}
                        className={cx(
                          "w-full rounded-xl border p-3 text-left transition",
                          isSel
                            ? "border-[rgba(255,215,128,0.35)] bg-[rgba(255,215,128,0.08)]"
                            : "border-white/10 bg-black/20 hover:border-white/20 hover:bg-black/30"
                        )}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-white/90">
                              {title}
                            </div>
                            <div className="mt-0.5 truncate text-xs text-white/55">
                              {fmtTime(r.created_at ?? r.updated_at)}
                            </div>
                          </div>

                          <div className="shrink-0 rounded-full border border-white/10 bg-black/30 px-2 py-1 text-[11px] text-white/70">
                            {status}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Column 2: Evidence + Actions */}
        <div className="col-span-12 lg:col-span-7">
          <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="text-sm font-medium text-white/85">Evidence • Actions</div>
              {selected ? (
                <div className="text-xs text-white/50">
                  Selected: <span className="text-white/75">{selected.id.slice(0, 8)}</span>
                </div>
              ) : null}
            </div>

            {!selected ? (
              <div className="rounded-xl border border-white/10 bg-black/20 p-4 text-sm text-white/55">
                Select an envelope to view details.
              </div>
            ) : (
              <div className="grid grid-cols-12 gap-4">
                {/* Actions */}
                <div className="col-span-12 xl:col-span-6">
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                    <div className="mb-3 text-xs font-semibold tracking-wide text-white/70">
                      Actions
                    </div>

                    <div className="space-y-2">
                      <button
                        onClick={openEnvelopeInNewTab}
                        className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-left text-sm text-white/90 hover:border-[rgba(255,215,128,0.35)] hover:bg-white/10"
                      >
                        Open Envelope
                        <div className="text-xs text-white/50">
                          View signer status / execution context
                        </div>
                      </button>

                      <button
                        onClick={openSignedPdfIfPresent}
                        className={cx(
                          "w-full rounded-xl border px-3 py-2 text-left text-sm",
                          "border-white/10 bg-white/5 text-white/90 hover:border-[rgba(255,215,128,0.35)] hover:bg-white/10"
                        )}
                      >
                        Download / Open Signed PDF
                        <div className="text-xs text-white/50">
                          Uses existing signed artifact path if present
                        </div>
                      </button>

                      <button
                        onClick={openArchiveEntryIfPresent}
                        className={cx(
                          "w-full rounded-xl border px-3 py-2 text-left text-sm",
                          "border-white/10 bg-white/5 text-white/90 hover:border-[rgba(255,215,128,0.35)] hover:bg-white/10"
                        )}
                      >
                        Open in CI-Archive
                        <div className="text-xs text-white/50">
                          Deep-link to archived minute book entry (if linked)
                        </div>
                      </button>
                    </div>

                    {/* AXIOM advisory (non-blocking) */}
                    <div className="mt-4 rounded-2xl border border-white/10 bg-black/30 p-4">
                      <div className="mb-2 flex items-center justify-between">
                        <div className="text-xs font-semibold tracking-wide text-white/70">
                          AXIOM Advisory
                        </div>
                        <div
                          className={cx(
                            "rounded-full border px-2 py-0.5 text-[11px]",
                            ax?.severity === "ok" &&
                              "border-emerald-400/20 bg-emerald-400/10 text-emerald-200",
                            ax?.severity === "warn" &&
                              "border-[rgba(255,215,128,0.35)] bg-[rgba(255,215,128,0.10)] text-[rgb(255,215,128)]",
                            ax?.severity === "risk" &&
                              "border-red-400/20 bg-red-400/10 text-red-200"
                          )}
                        >
                          {ax?.severity?.toUpperCase() ?? "—"}
                        </div>
                      </div>
                      <div className="text-sm font-medium text-white/90">{ax?.title}</div>
                      <div className="mt-1 text-sm text-white/60">{ax?.body}</div>
                    </div>
                  </div>
                </div>

                {/* Metadata */}
                <div className="col-span-12 xl:col-span-6">
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                    <div className="mb-3 text-xs font-semibold tracking-wide text-white/70">
                      Metadata
                    </div>

                    <div className="space-y-3 text-sm">
                      <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                        <div className="text-xs text-white/50">Title</div>
                        <div className="mt-0.5 text-white/90">{deriveTitle(selected)}</div>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                          <div className="text-xs text-white/50">Status</div>
                          <div className="mt-0.5 text-white/90">{deriveStatusLabel(selected)}</div>
                        </div>
                        <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                          <div className="text-xs text-white/50">Entity</div>
                          <div className="mt-0.5 text-white/90">{entityLabel}</div>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                          <div className="text-xs text-white/50">Created</div>
                          <div className="mt-0.5 text-white/90">{fmtTime(selected.created_at)}</div>
                        </div>
                        <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                          <div className="text-xs text-white/50">Updated</div>
                          <div className="mt-0.5 text-white/90">{fmtTime(selected.updated_at)}</div>
                        </div>
                      </div>

                      <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                        <div className="text-xs text-white/50">Ledger Record</div>
                        <div className="mt-0.5 text-white/90">
                          {deriveRecordId(selected) ? (
                            <span className="break-all">{deriveRecordId(selected)}</span>
                          ) : (
                            "—"
                          )}
                        </div>
                      </div>

                      <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                        <div className="text-xs text-white/50">Signed PDF Path</div>
                        <div className="mt-0.5 break-all text-white/90">
                          {selected.signed_pdf_path ||
                            selected.signed_storage_path ||
                            selected.signed_file_path ||
                            selected.storage_path ||
                            "—"}
                        </div>
                      </div>

                      <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                        <div className="text-xs text-white/50">Archive Entry</div>
                        <div className="mt-0.5 break-all text-white/90">
                          {selected.archived_entry_id ||
                            selected.minute_book_entry_id ||
                            selected.archive_entry_id ||
                            "—"}
                        </div>
                      </div>
                    </div>

                    <div className="mt-4 text-xs text-white/45">
                      Forge remains signature-only. Council determines signature intent; both paths must still generate PDF + archive-quality artifacts.
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
