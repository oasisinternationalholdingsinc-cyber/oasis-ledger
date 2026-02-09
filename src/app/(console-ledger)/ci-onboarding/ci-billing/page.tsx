"use client";
export const dynamic = "force-dynamic";

/**
 * CI • Billing (OPERATOR-ONLY — PRODUCTION)
 *
 * Registry-grade billing console with explicit authority actions.
 * No enforcement. No payments. No SQL ops.
 *
 * Wired Edge Functions:
 * - billing-create-subscription
 * - billing-update-subscription
 * - billing-end-subscription
 * - billing-generate-document
 * - billing-attach-external-document
 * - export-billing-discovery-package
 * - axiom-billing-snapshot (read-only)
 */

import React, { useEffect, useMemo, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";

/* ---------------- utils ---------------- */

function cx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function shortUUID(u?: string | null) {
  if (!u) return "—";
  return u.length > 14 ? `${u.slice(0, 8)}…${u.slice(-4)}` : u;
}

function fmtISO(v: any) {
  if (!v) return "—";
  const d = new Date(v);
  return isNaN(d.getTime()) ? String(v) : d.toISOString();
}

async function copyToClipboard(t: string) {
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    return false;
  }
}

/* ---------------- types ---------------- */

type SubRow = {
  id: string;
  entity_id: string;
  status?: string | null;
  plan_key?: string | null;
  plan_id?: string | null;
  is_internal?: boolean | null;
  is_test?: boolean | null;
  created_at?: string | null;
  metadata?: any | null;
};

type DocRow = {
  id: string;
  entity_id: string;
  document_type?: string | null;
  title?: string | null;
  storage_bucket?: string | null;
  storage_path?: string | null;
  file_hash?: string | null;
  is_test?: boolean | null;
  created_at?: string | null;
  metadata?: any | null;
};

type Tab = "SUBSCRIPTIONS" | "DOCUMENTS";

/* ---------------- modal ---------------- */

function OsModal({
  open,
  title,
  children,
  confirmText,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  confirmText: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100]">
      <div className="absolute inset-0 bg-black/60" onClick={!busy ? onClose : undefined} />
      <div className="absolute left-1/2 top-1/2 w-[94vw] max-w-[560px] -translate-x-1/2 -translate-y-1/2">
        <div className="rounded-3xl border border-white/12 bg-[#070A12]/90">
          <div className="border-b border-white/10 p-4 text-lg font-semibold text-white/90">
            {title}
          </div>
          <div className="p-4 space-y-3">{children}</div>
          <div className="flex justify-end gap-2 border-t border-white/10 p-4">
            <button
              disabled={busy}
              onClick={onClose}
              className="rounded-full border border-white/10 px-4 py-2 text-xs text-white/70"
            >
              Cancel
            </button>
            <button
              disabled={busy}
              onClick={onConfirm}
              className="rounded-full border border-amber-300/20 bg-amber-400/12 px-4 py-2 text-xs font-semibold text-amber-100"
            >
              {confirmText}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ===================== PAGE ===================== */

export default function CiBillingPage() {
  const ec = useEntity() as any;
  const env = useOsEnv() as any;

  const entitySlug =
    ec?.activeEntity || ec?.entitySlug || ec?.entity_slug || ec?.entityKey || "entity";

  const entityLabel =
    ec?.entityName || ec?.activeEntityName || ec?.label || ec?.name || entitySlug;

  const isTest = Boolean(env?.is_test ?? env?.isTest ?? env?.sandbox);
  const envLabel = isTest ? "SANDBOX" : "RoT";

  const [entityId, setEntityId] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>("SUBSCRIPTIONS");
  const [subs, setSubs] = useState<SubRow[]>([]);
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [selectedSub, setSelectedSub] = useState<SubRow | null>(null);
  const [selectedDoc, setSelectedDoc] = useState<DocRow | null>(null);

  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  /* -------- authority modals -------- */
  const [createSubOpen, setCreateSubOpen] = useState(false);
  const [updateSubOpen, setUpdateSubOpen] = useState(false);
  const [endSubOpen, setEndSubOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);

  const [planKey, setPlanKey] = useState("");
  const [reason, setReason] = useState("");
  const [externalTitle, setExternalTitle] = useState("");
  const [externalUrl, setExternalUrl] = useState("");

  /* ---------- resolve entity_id ---------- */
  useEffect(() => {
    (async () => {
      const direct = ec?.entityId || ec?.activeEntityId || ec?.entity_id;
      if (direct) {
        setEntityId(direct);
        return;
      }
      const { data } = await supabase
        .from("entities")
        .select("id")
        .eq("slug", entitySlug)
        .maybeSingle();
      setEntityId(data?.id ?? null);
    })();
  }, [entitySlug]);

  /* ---------- load subscriptions ---------- */
  useEffect(() => {
    if (!entityId) return;
    (async () => {
      const { data } = await supabase
        .from("billing_subscriptions")
        .select("*")
        .eq("entity_id", entityId)
        .order("created_at", { ascending: false });
      setSubs((data || []) as SubRow[]);
      setSelectedSub((data || [])[0] ?? null);
    })();
  }, [entityId, isTest, refreshKey]);

  /* ---------- load documents ---------- */
  useEffect(() => {
    if (!entityId) return;
    (async () => {
      const { data } = await supabase
        .from("billing_documents")
        .select("*")
        .eq("entity_id", entityId)
        .order("created_at", { ascending: false });
      setDocs((data || []) as DocRow[]);
      setSelectedDoc((data || [])[0] ?? null);
    })();
  }, [entityId, isTest, refreshKey]);

  /* ---------- derived ---------- */
  const commercialIntent = subs.some(
    (s) => (s.status || "").toLowerCase() === "active" && !s.is_internal
  );

  /* ---------- invoke helper ---------- */
  async function invoke(fn: string, body: any) {
    setBusy(true);
    setNote(null);
    try {
      const { error } = await supabase.functions.invoke(fn, { body });
      if (error) throw error;
      setNote("Action completed.");
      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e.message || fn + " failed");
    } finally {
      setBusy(false);
    }
  }

  async function openStorage(bucket?: string | null, path?: string | null) {
    if (!bucket || !path) return;
    const { data } = await supabase.storage.from(bucket).createSignedUrl(path, 90);
    if (data?.signedUrl) window.open(data.signedUrl, "_blank");
  }

  /* ================= UI ================= */

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6">
      <div className="rounded-3xl border border-white/10 bg-black/20">
        {/* header */}
        <div className="border-b border-white/10 p-4">
          <div className="text-xs uppercase tracking-[0.3em] text-slate-500">
            CI • Billing
          </div>
          <div className="mt-1 flex items-center gap-3">
            <h1 className="text-xl font-semibold text-white/90">
              Billing Console
            </h1>
            {commercialIntent ? (
              <span className="rounded-full border border-emerald-300/20 bg-emerald-400/12 px-3 py-1 text-[10px] font-semibold text-emerald-100">
                Commercial Intent
              </span>
            ) : (
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[10px] text-white/45">
                Internal / Non-Billable
              </span>
            )}
          </div>
          <div className="mt-2 text-xs text-white/45">
            Entity: {entityLabel} • Lane: {envLabel} • entity_id:{" "}
            {shortUUID(entityId)}
          </div>
        </div>

        {/* tabs */}
        <div className="flex gap-2 border-b border-white/10 px-4 py-2">
          {(["SUBSCRIPTIONS", "DOCUMENTS"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cx(
                "rounded-full px-3 py-1 text-xs",
                tab === t
                  ? "bg-white/10 text-white"
                  : "text-white/50 hover:text-white"
              )}
            >
              {t}
            </button>
          ))}
        </div>

        {/* body */}
        <div className="grid grid-cols-12 gap-4 p-4">
          {/* LEFT */}
          <div className="col-span-12 lg:col-span-3 space-y-3">
            <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-xs text-white/70">
              <div>Subscriptions: {subs.length}</div>
              <div>Documents: {docs.length}</div>
              {note ? <div className="mt-2 text-amber-200">{note}</div> : null}
            </div>

            <button
              disabled={!entityId || busy}
              onClick={() =>
                invoke("axiom-billing-snapshot", {
                  entity_id: entityId,
                  is_test: isTest,
                })
              }
              className="w-full rounded-2xl border border-sky-300/20 bg-sky-400/12 px-4 py-2 text-xs font-semibold text-sky-100"
            >
              Run AXIOM Advisory
            </button>

            {/* authority actions */}
            <div className="rounded-2xl border border-white/10 bg-black/20 p-3 space-y-2">
              <button
                onClick={() => setCreateSubOpen(true)}
                className="w-full rounded-xl border border-emerald-300/20 bg-emerald-400/12 px-3 py-2 text-xs text-emerald-100"
              >
                Create Subscription
              </button>
              <button
                disabled={!selectedSub}
                onClick={() => setUpdateSubOpen(true)}
                className="w-full rounded-xl border border-amber-300/20 bg-amber-400/12 px-3 py-2 text-xs text-amber-100"
              >
                Update Subscription
              </button>
              <button
                disabled={!selectedSub}
                onClick={() => setEndSubOpen(true)}
                className="w-full rounded-xl border border-rose-300/20 bg-rose-500/12 px-3 py-2 text-xs text-rose-100"
              >
                End Subscription
              </button>
              <button
                onClick={() => setAttachOpen(true)}
                className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs"
              >
                Attach External Document
              </button>
            </div>
          </div>

          {/* MIDDLE */}
          <div className="col-span-12 lg:col-span-5 space-y-2">
            {tab === "SUBSCRIPTIONS"
              ? subs.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setSelectedSub(s)}
                    className={cx(
                      "w-full rounded-2xl border p-3 text-left",
                      selectedSub?.id === s.id
                        ? "border-amber-300/25 bg-black/40"
                        : "border-white/10 bg-black/20"
                    )}
                  >
                    <div className="text-sm font-semibold text-white/90">
                      {s.plan_key || s.plan_id || "Subscription"}
                    </div>
                    <div className="text-xs text-white/45">
                      {shortUUID(s.id)} • {fmtISO(s.created_at)}
                    </div>
                  </button>
                ))
              : docs.map((d) => (
                  <button
                    key={d.id}
                    onClick={() => setSelectedDoc(d)}
                    className={cx(
                      "w-full rounded-2xl border p-3 text-left",
                      selectedDoc?.id === d.id
                        ? "border-amber-300/25 bg-black/40"
                        : "border-white/10 bg-black/20"
                    )}
                  >
                    <div className="text-sm font-semibold text-white/90">
                      {d.title || d.document_type || "Billing Document"}
                    </div>
                    <div className="text-xs text-white/45">
                      {shortUUID(d.id)} • {fmtISO(d.created_at)}
                    </div>
                  </button>
                ))}
          </div>

          {/* RIGHT */}
          <div className="col-span-12 lg:col-span-4 space-y-3">
            {tab === "DOCUMENTS" && selectedDoc ? (
              <>
                <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-xs">
                  <div>Hash: {selectedDoc.file_hash || "—"}</div>
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() =>
                        openStorage(
                          selectedDoc.storage_bucket,
                          selectedDoc.storage_path
                        )
                      }
                      className="rounded-full border border-white/10 px-3 py-1"
                    >
                      Open PDF
                    </button>
                    <button
                      onClick={async () => {
                        if (selectedDoc.file_hash) {
                          await copyToClipboard(selectedDoc.file_hash);
                          setNote("Hash copied");
                        }
                      }}
                      className="rounded-full border border-white/10 px-3 py-1"
                    >
                      Copy Hash
                    </button>
                  </div>
                </div>

                <button
                  disabled={!selectedDoc}
                  onClick={() =>
                    invoke("export-billing-discovery-package", {
                      entity_id: entityId,
                      is_test: isTest,
                      hash: selectedDoc.file_hash,
                      document_id: selectedDoc.id,
                    })
                  }
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-2 text-xs"
                >
                  Export Discovery ZIP
                </button>
              </>
            ) : null}
          </div>
        </div>
      </div>

      {/* ===== MODALS ===== */}

      <OsModal
        open={createSubOpen}
        title="Create subscription"
        confirmText="Create"
        busy={busy}
        onClose={() => setCreateSubOpen(false)}
        onConfirm={() =>
          invoke("billing-create-subscription", {
            entity_id: entityId,
            plan_key: planKey,
            is_test: isTest,
            reason,
          })
        }
      >
        <input
          placeholder="plan_key"
          value={planKey}
          onChange={(e) => setPlanKey(e.target.value)}
          className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm"
        />
        <input
          placeholder="reason (required)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm"
        />
      </OsModal>

      <OsModal
        open={updateSubOpen}
        title="Update subscription"
        confirmText="Update"
        busy={busy}
        onClose={() => setUpdateSubOpen(false)}
        onConfirm={() =>
          invoke("billing-update-subscription", {
            subscription_id: selectedSub?.id,
            plan_key: planKey,
            reason,
          })
        }
      >
        <input
          placeholder="new plan_key"
          value={planKey}
          onChange={(e) => setPlanKey(e.target.value)}
          className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm"
        />
        <input
          placeholder="reason (required)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm"
        />
      </OsModal>

      <OsModal
        open={endSubOpen}
        title="End subscription"
        confirmText="End"
        busy={busy}
        onClose={() => setEndSubOpen(false)}
        onConfirm={() =>
          invoke("billing-end-subscription", {
            subscription_id: selectedSub?.id,
            reason,
          })
        }
      >
        <input
          placeholder="reason (required)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm"
        />
      </OsModal>

      <OsModal
        open={attachOpen}
        title="Attach external billing document"
        confirmText="Attach"
        busy={busy}
        onClose={() => setAttachOpen(false)}
        onConfirm={() =>
          invoke("billing-attach-external-document", {
            entity_id: entityId,
            title: externalTitle,
            source_url: externalUrl,
            is_test: isTest,
          })
        }
      >
        <input
          placeholder="Document title"
          value={externalTitle}
          onChange={(e) => setExternalTitle(e.target.value)}
          className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm"
        />
        <input
          placeholder="Source URL"
          value={externalUrl}
          onChange={(e) => setExternalUrl(e.target.value)}
          className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm"
        />
      </OsModal>
    </div>
  );
}
