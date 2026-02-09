"use client";
export const dynamic = "force-dynamic";

/**
 * CI • Billing (OPERATOR-ONLY — VISIBILITY + CONTROLLED ACTIONS)
 * ✅ OS-aligned 3-pane console
 * ✅ Contamination-safe: NEVER hardcode corp names
 * ✅ Entity-safe: requires entity_id (uuid), resolves from OS context OR entities.slug
 * ✅ Lane-safe: filters by is_test when column exists, falls back if not
 * ✅ No enforcement. No payment actions.
 *
 * Operator capabilities (PRODUCTION SAFE):
 * ✅ Read subscriptions (table)
 * ✅ Read billing documents (table) + open PDF + copy hash
 * ✅ Generate billing document (Edge Function, service_role)
 * ✅ Export billing discovery package (Edge Function, non-mutating ZIP)
 */

import React, { useEffect, useMemo, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";

function cx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function shortUUID(u: string | null | undefined) {
  const s = (u || "").trim();
  if (!s) return "—";
  if (s.length <= 10) return s;
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

function fmtISO(v: any) {
  const s = (v ?? "").toString().trim();
  if (!s) return "—";
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return d.toISOString();
  } catch {
    return s;
  }
}

function safeJson(x: any) {
  try {
    if (x == null) return "—";
    return JSON.stringify(x, null, 2);
  } catch {
    return "—";
  }
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

type SubRow = {
  id: string;
  entity_id: string;

  status: string | null;

  plan_key?: string | null;
  plan_id?: string | null;

  payment_provider?: string | null;
  provider_customer_id?: string | null;
  provider_subscription_id?: string | null;

  started_at?: string | null;
  current_period_start?: string | null;
  current_period_end?: string | null;
  trial_ends_at?: string | null;
  cancel_at?: string | null;
  ended_at?: string | null;

  is_internal?: boolean | null;
  is_test?: boolean | null;

  created_at?: string | null;
  updated_at?: string | null;
  created_by?: string | null;

  metadata?: any | null;
};

type DocRow = {
  id: string;
  entity_id: string;

  // expected registry-like fields (your checkpoint says billing_documents is registry-grade)
  document_type?: string | null; // if present
  title?: string | null; // if present
  storage_bucket: string | null;
  storage_path: string | null;
  file_hash: string | null;

  // lane + timestamps
  is_test?: boolean | null;
  created_at?: string | null;
  created_by?: string | null;

  metadata?: any | null;
};

type Tab = "SUBSCRIPTIONS" | "DOCUMENTS";

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="text-[10px] uppercase tracking-[0.22em] text-white/35">{k}</div>
      <div className="max-w-[72%] text-right text-sm text-white/80 break-words">{v}</div>
    </div>
  );
}

/** Minimal OS Modal (same style family as your other consoles) */
function OsModal({
  open,
  title,
  subtitle,
  children,
  confirmText = "Confirm",
  cancelText = "Cancel",
  danger,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  busy?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100]">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-[6px]"
        onClick={busy ? undefined : onClose}
      />
      <div className="absolute left-1/2 top-1/2 w-[94vw] max-w-[620px] -translate-x-1/2 -translate-y-1/2">
        <div className="relative overflow-hidden rounded-3xl border border-white/12 bg-[#070A12]/80 shadow-[0_40px_160px_rgba(0,0,0,0.70)]">
          <div className="pointer-events-none absolute inset-0 opacity-60 [background:radial-gradient(900px_500px_at_70%_-20%,rgba(250,204,21,0.14),transparent_55%),radial-gradient(700px_420px_at_10%_0%,rgba(56,189,248,0.10),transparent_50%)]" />
          <div className="relative border-b border-white/10 p-5">
            <div className="text-[11px] uppercase tracking-[0.28em] text-white/45">Authority • Action</div>
            <div className="mt-2 text-xl font-semibold text-white/90">{title}</div>
            {subtitle ? <div className="mt-1 text-sm text-white/55">{subtitle}</div> : null}
          </div>

          <div className="relative p-5">{children}</div>

          <div className="relative flex items-center justify-end gap-2 border-t border-white/10 p-4">
            <button
              disabled={busy}
              onClick={onClose}
              className={cx(
                "rounded-full border px-4 py-2 text-xs font-semibold transition",
                busy
                  ? "border-white/10 bg-white/3 text-white/35"
                  : "border-white/10 bg-white/5 text-white/75 hover:bg-white/7 hover:border-white/15"
              )}
            >
              {cancelText}
            </button>
            <button
              disabled={busy}
              onClick={onConfirm}
              className={cx(
                "rounded-full border px-4 py-2 text-xs font-semibold transition",
                danger
                  ? busy
                    ? "border-rose-300/15 bg-rose-500/10 text-rose-200/40"
                    : "border-rose-300/20 bg-rose-500/12 text-rose-100 hover:bg-rose-500/16"
                  : busy
                  ? "border-amber-300/15 bg-amber-400/10 text-amber-100/40"
                  : "border-amber-300/20 bg-amber-400/12 text-amber-100 hover:bg-amber-400/16"
              )}
            >
              {confirmText}
            </button>
          </div>
        </div>

        <div className="mt-3 text-center text-[10px] text-white/35">
          Mutations only via Edge Functions • Lane-safe • Entity-safe • No enforcement
        </div>
      </div>
    </div>
  );
}

export default function CiBillingPage() {
  const ec = useEntity() as any;
  const env = useOsEnv() as any;

  // slug/key from OS context (contamination-safe)
  const entitySlug: string =
    (ec?.activeEntity as string) ||
    (ec?.entitySlug as string) ||
    (ec?.entity_slug as string) ||
    (ec?.entityKey as string) ||
    "entity";

  const entityLabel: string = useMemo(() => {
    const fromCtx =
      (ec?.entityName as string) ||
      (ec?.activeEntityName as string) ||
      (ec?.label as string) ||
      (ec?.name as string);
    return fromCtx?.trim() ? fromCtx : entitySlug;
  }, [ec, entitySlug]);

  // lane (defensive)
  const isTest: boolean = Boolean(
    env?.is_test ?? env?.isTest ?? env?.lane_is_test ?? env?.sandbox ?? env?.isSandbox
  );
  const envLabel = isTest ? "SANDBOX" : "RoT";

  // entity_id (uuid) resolution
  const [entityId, setEntityId] = useState<string | null>(null);
  const [entityIdErr, setEntityIdErr] = useState<string | null>(null);

  // UI
  const [tab, setTab] = useState<Tab>("SUBSCRIPTIONS");
  const [refreshKey, setRefreshKey] = useState(0);

  // Subscriptions
  const [subsLoading, setSubsLoading] = useState(true);
  const [subsErr, setSubsErr] = useState<string | null>(null);
  const [subs, setSubs] = useState<SubRow[]>([]);
  const [selectedSubId, setSelectedSubId] = useState<string | null>(null);

  // Documents
  const [docsLoading, setDocsLoading] = useState(true);
  const [docsErr, setDocsErr] = useState<string | null>(null);
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);

  // Actions
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // Modals
  const [genOpen, setGenOpen] = useState(false);
  const [genTitle, setGenTitle] = useState("Invoice");
  const [genMeta, setGenMeta] = useState<string>("{}");

  const [exportOpen, setExportOpen] = useState(false);

  const selectedSub = useMemo(
    () => subs.find((s) => s.id === selectedSubId) || null,
    [subs, selectedSubId]
  );

  const selectedDoc = useMemo(
    () => docs.find((d) => d.id === selectedDocId) || null,
    [docs, selectedDocId]
  );

  async function resolveEntityId(): Promise<string | null> {
    setEntityIdErr(null);

    // 1) direct uuid from OS context if present
    const direct =
      (ec?.activeEntityId as string) ||
      (ec?.entityId as string) ||
      (ec?.entity_id as string) ||
      null;

    if (direct && direct.toString().trim().length >= 32) return direct.toString().trim();

    // 2) fallback resolver: entities table by slug
    try {
      const { data, error } = await supabase.from("entities").select("id").eq("slug", entitySlug).maybeSingle();
      if (error) throw error;
      if (data?.id) return data.id as string;

      setEntityIdErr("Entity not found in entities table for slug: " + entitySlug);
      return null;
    } catch (e: any) {
      setEntityIdErr(e?.message || "Failed to resolve entity_id from entities.slug.");
      return null;
    }
  }

  // Resolve entity_id on mount / slug changes
  useEffect(() => {
    let alive = true;
    (async () => {
      const id = await resolveEntityId();
      if (!alive) return;
      setEntityId(id);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entitySlug]);

  // Load subscriptions
  useEffect(() => {
    let alive = true;

    (async () => {
      setSubsLoading(true);
      setSubsErr(null);

      if (!entityId) {
        setSubs([]);
        setSelectedSubId(null);
        setSubsLoading(false);
        return;
      }

      try {
        const tryWithLane = async () => {
          const { data, error } = await supabase
            .from("billing_subscriptions")
            .select("*")
            .eq("entity_id", entityId)
            .eq("is_test", isTest)
            .order("created_at", { ascending: false });
          return { data, error };
        };

        const tryWithoutLane = async () => {
          const { data, error } = await supabase
            .from("billing_subscriptions")
            .select("*")
            .eq("entity_id", entityId)
            .order("created_at", { ascending: false });
          return { data, error };
        };

        let res = await tryWithLane();
        if (res.error && /is_test|42703|undefined column/i.test(res.error.message)) {
          res = await tryWithoutLane();
        }
        if (res.error) throw res.error;

        const list = (res.data || []) as SubRow[];
        if (!alive) return;

        setSubs(list);
        setSelectedSubId((prev) => (prev && list.some((x) => x.id === prev) ? prev : list[0]?.id ?? null));
      } catch (e: any) {
        if (!alive) return;
        setSubsErr(e?.message || "Failed to load billing_subscriptions.");
      } finally {
        if (!alive) return;
        setSubsLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [entityId, isTest, refreshKey]);

  // Load documents
  useEffect(() => {
    let alive = true;

    (async () => {
      setDocsLoading(true);
      setDocsErr(null);

      if (!entityId) {
        setDocs([]);
        setSelectedDocId(null);
        setDocsLoading(false);
        return;
      }

      try {
        const tryWithLane = async () => {
          const { data, error } = await supabase
            .from("billing_documents")
            .select("*")
            .eq("entity_id", entityId)
            .eq("is_test", isTest)
            .order("created_at", { ascending: false });
          return { data, error };
        };

        const tryWithoutLane = async () => {
          const { data, error } = await supabase
            .from("billing_documents")
            .select("*")
            .eq("entity_id", entityId)
            .order("created_at", { ascending: false });
          return { data, error };
        };

        let res = await tryWithLane();
        if (res.error && /is_test|42703|undefined column/i.test(res.error.message)) {
          res = await tryWithoutLane();
        }
        if (res.error) throw res.error;

        const list = (res.data || []) as DocRow[];
        if (!alive) return;

        setDocs(list);
        setSelectedDocId((prev) => (prev && list.some((x) => x.id === prev) ? prev : list[0]?.id ?? null));
      } catch (e: any) {
        if (!alive) return;
        setDocsErr(e?.message || "Failed to load billing_documents.");
      } finally {
        if (!alive) return;
        setDocsLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [entityId, isTest, refreshKey]);

  // ---- Actions ----

  async function openStorage(bucket: string, path: string) {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 90);
    if (error || !data?.signedUrl) {
      alert(error?.message || "Could not create signed URL.");
      return;
    }
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  }

  async function actionGenerateDocument() {
    if (!entityId) return;
    setBusy(true);
    setNote(null);
    try {
      let parsedMeta: any = {};
      try {
        parsedMeta = genMeta?.trim() ? JSON.parse(genMeta) : {};
      } catch {
        parsedMeta = { note: "invalid_json_metadata_input" };
      }

      // SAFE payload: minimal required fields + optional subscription anchor if selected.
      const body: any = {
        entity_id: entityId,
        is_test: isTest,
        title: genTitle?.trim() || "Invoice",
        subscription_id: selectedSub?.id ?? null,
        metadata: parsedMeta,
      };

      const { data, error } = await supabase.functions.invoke("billing-generate-document", { body });
      if (error) throw error;

      setNote((data && (data.message || data.detail)) || "Billing document generation requested.");
      setGenOpen(false);

      // refresh docs after generation
      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "billing-generate-document failed.");
    } finally {
      setBusy(false);
    }
  }

  async function actionExportDiscovery() {
    if (!entityId) return;
    setBusy(true);
    setNote(null);
    try {
      // hash-first (ideal), then doc_id as fallback; never guess ledger concepts here.
      const body: any = {
        entity_id: entityId,
        is_test: isTest,
        hash: selectedDoc?.file_hash ?? null,
        document_id: selectedDoc?.id ?? null,
      };

      const { data, error } = await supabase.functions.invoke("export-billing-discovery-package", { body });
      if (error) throw error;

      const url =
        data?.url || data?.signed_url || data?.signedUrl || data?.download_url || data?.downloadUrl || null;

      if (url && typeof url === "string") {
        window.open(url, "_blank", "noopener,noreferrer");
        setNote("Discovery package exported.");
      } else {
        setNote((data && (data.message || data.detail)) || "Export completed (no URL returned).");
      }

      setExportOpen(false);
    } catch (e: any) {
      alert(e?.message || "export-billing-discovery-package failed.");
    } finally {
      setBusy(false);
    }
  }

  const shell =
    "rounded-3xl border border-white/10 bg-black/20 shadow-[0_28px_120px_rgba(0,0,0,0.55)] overflow-hidden";
  const header =
    "border-b border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent px-4 sm:px-6 py-4 sm:py-5";
  const body = "px-4 sm:px-6 py-5 sm:py-6";

  const TabBtn = ({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) => (
    <button
      onClick={onClick}
      className={cx(
        "rounded-full px-3 py-1 text-[11px] font-medium transition",
        active ? "bg-white/8 text-white/85 ring-1 ring-white/12" : "text-white/55 hover:text-white/80"
      )}
    >
      {children}
    </button>
  );

  return (
    <div className="w-full">
      <div className="mx-auto w-full max-w-[1400px] px-4 pb-10 pt-4 sm:pt-6">
        <div className={shell}>
          <div className={header}>
            <div className="text-[10px] sm:text-xs tracking-[0.3em] uppercase text-slate-500">CI • Billing</div>
            <h1 className="mt-1 text-lg sm:text-xl font-semibold text-slate-50">Billing Console</h1>
            <p className="mt-1 max-w-3xl text-[11px] sm:text-xs text-slate-400 leading-relaxed">
              Operator visibility + controlled registry actions. No enforcement. No payment actions.
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-2 text-[11px] text-slate-400">
              <span>
                Entity: <span className="text-emerald-300 font-medium">{entityLabel}</span>
              </span>
              <span className="text-slate-700">•</span>
              <span>
                Lane:{" "}
                <span className={cx("font-semibold", isTest ? "text-amber-300" : "text-sky-300")}>{envLabel}</span>
              </span>
              <span className="text-slate-700">•</span>
              <span>
                entity_id: <span className="text-slate-200 font-semibold">{entityId ? shortUUID(entityId) : "—"}</span>
              </span>

              <span className="ml-auto" />

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setRefreshKey((n) => n + 1)}
                  className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7"
                >
                  Refresh
                </button>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <TabBtn active={tab === "SUBSCRIPTIONS"} onClick={() => setTab("SUBSCRIPTIONS")}>
                Subscriptions
              </TabBtn>
              <TabBtn active={tab === "DOCUMENTS"} onClick={() => setTab("DOCUMENTS")}>
                Documents
              </TabBtn>

              <span className="ml-auto" />

              {/* Operator actions (safe) */}
              <button
                onClick={() => setGenOpen(true)}
                disabled={!entityId || busy}
                className={cx(
                  "rounded-full border px-4 py-2 text-[10px] font-semibold tracking-[0.14em] uppercase transition",
                  entityId && !busy
                    ? "border-amber-300/20 bg-amber-400/12 text-amber-100 hover:bg-amber-400/16"
                    : "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                )}
                title="Generates a billing PDF + registry row via Edge Function"
              >
                Generate Document
              </button>

              <button
                onClick={() => setExportOpen(true)}
                disabled={!entityId || busy || !selectedDoc}
                className={cx(
                  "rounded-full border px-4 py-2 text-[10px] font-semibold tracking-[0.14em] uppercase transition",
                  entityId && !busy && !!selectedDoc
                    ? "border-white/10 bg-white/5 text-white/85 hover:border-amber-300/18 hover:bg-white/7"
                    : "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                )}
                title="Exports a non-mutating discovery ZIP via Edge Function"
              >
                Export Discovery
              </button>
            </div>
          </div>

          <div className={body}>
            {/* Guardrail: entity_id required */}
            {!entityId ? (
              <div className="rounded-3xl border border-rose-300/15 bg-rose-500/10 p-4 text-sm text-rose-100/90">
                <div className="font-semibold">Missing active entity_id from OS context.</div>
                <div className="mt-2 text-rose-100/70">
                  Billing is UUID-anchored. It will not guess. Resolve entity_id via OS context or entities.slug.
                </div>
                {entityIdErr ? <div className="mt-2 text-rose-200">{entityIdErr}</div> : null}
                <div className="mt-3 text-[11px] text-white/45">
                  Contamination-safe • Lane-safe • Operator-only
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-12 gap-4">
                {/* LEFT: Summary */}
                <div className="col-span-12 lg:col-span-3">
                  <div className="rounded-3xl border border-white/10 bg-black/20 overflow-hidden">
                    <div className="border-b border-white/10 p-4">
                      <div className="text-xs font-semibold tracking-wide text-white/80">Summary</div>
                      <div className="mt-1 text-[11px] text-white/45">Registry state (operator visibility)</div>
                    </div>

                    <div className="p-4 space-y-3">
                      <Row k="Lane" v={envLabel} />
                      <Row k="Entity" v={entitySlug} />
                      <Row k="Subscriptions" v={`${subs.length}`} />
                      <Row k="Documents" v={`${docs.length}`} />

                      <Row
                        k="Active sub"
                        v={(() => {
                          const active = subs.find((s) => (s.status || "").toLowerCase() === "active");
                          return active ? shortUUID(active.id) : "—";
                        })()}
                      />
                      <Row
                        k="Latest doc"
                        v={(() => {
                          const top = docs[0];
                          return top ? shortUUID(top.id) : "—";
                        })()}
                      />

                      {note ? (
                        <div className="rounded-2xl border border-white/10 bg-black/25 p-3 text-xs text-white/70">
                          {note}
                        </div>
                      ) : null}
                    </div>

                    <div className="border-t border-white/10 p-3 text-[10px] text-white/35">
                      Entity-safe • Lane-safe • No enforcement
                    </div>
                  </div>

                  <div className="mt-4 rounded-3xl border border-white/10 bg-black/20 p-4">
                    <div className="text-xs font-semibold tracking-wide text-white/80">Operator notes</div>
                    <div className="mt-2 text-[11px] leading-relaxed text-white/45">
                      Documents are registry-grade (bucket/path + SHA-256). Export is non-mutating. Generation is Edge-only.
                    </div>
                  </div>
                </div>

                {/* MIDDLE: List */}
                <div className="col-span-12 lg:col-span-5">
                  <div className="rounded-3xl border border-white/10 bg-black/20 overflow-hidden">
                    <div className="border-b border-white/10 p-4">
                      <div className="text-xs font-semibold tracking-wide text-white/80">
                        {tab === "SUBSCRIPTIONS" ? "Subscriptions" : "Documents"}
                      </div>
                      <div className="mt-1 text-[11px] text-white/45">
                        Newest first • select to inspect
                      </div>
                    </div>

                    <div className="max-h-[560px] overflow-auto p-2">
                      {tab === "SUBSCRIPTIONS" ? (
                        subsLoading ? (
                          <div className="p-4 text-sm text-white/55">Loading…</div>
                        ) : subsErr ? (
                          <div className="p-4 text-sm text-rose-200">{subsErr}</div>
                        ) : subs.length === 0 ? (
                          <div className="p-4 text-sm text-white/55">None registered (valid dormant state).</div>
                        ) : (
                          <div className="space-y-2 p-2">
                            {subs.map((s) => {
                              const active = s.id === selectedSubId;
                              const st = (s.status || "—").toString();
                              const plan = (s.plan_key || s.plan_id || "—").toString();

                              return (
                                <button
                                  key={s.id}
                                  onClick={() => setSelectedSubId(s.id)}
                                  className={cx(
                                    "w-full rounded-2xl border p-4 text-left transition",
                                    active
                                      ? "border-amber-300/25 bg-black/35 shadow-[0_0_0_1px_rgba(250,204,21,0.10)]"
                                      : "border-white/10 bg-black/15 hover:border-white/16 hover:bg-black/22"
                                  )}
                                >
                                  <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <div className="truncate text-sm font-semibold text-white/88">
                                        {plan === "—" ? "Subscription" : plan}
                                      </div>
                                      <div className="mt-1 truncate text-xs text-white/45">
                                        {shortUUID(s.id)} • {fmtISO(s.created_at)}
                                      </div>
                                    </div>

                                    <span
                                      className={cx(
                                        "rounded-full border px-3 py-1 text-[11px] font-medium",
                                        st.toLowerCase() === "active"
                                          ? "border-emerald-300/18 bg-emerald-400/10 text-emerald-100/90"
                                          : "border-white/10 bg-white/5 text-white/70"
                                      )}
                                    >
                                      {st}
                                    </span>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        )
                      ) : docsLoading ? (
                        <div className="p-4 text-sm text-white/55">Loading…</div>
                      ) : docsErr ? (
                        <div className="p-4 text-sm text-rose-200">{docsErr}</div>
                      ) : docs.length === 0 ? (
                        <div className="p-4 text-sm text-white/55">No billing documents yet (valid dormant state).</div>
                      ) : (
                        <div className="space-y-2 p-2">
                          {docs.map((d) => {
                            const active = d.id === selectedDocId;
                            const title =
                              (d.title || d.document_type || "Billing Document").toString();
                            const hash = d.file_hash || "—";

                            return (
                              <button
                                key={d.id}
                                onClick={() => setSelectedDocId(d.id)}
                                className={cx(
                                  "w-full rounded-2xl border p-4 text-left transition",
                                  active
                                    ? "border-amber-300/25 bg-black/35 shadow-[0_0_0_1px_rgba(250,204,21,0.10)]"
                                    : "border-white/10 bg-black/15 hover:border-white/16 hover:bg-black/22"
                                )}
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="truncate text-sm font-semibold text-white/88">{title}</div>
                                    <div className="mt-1 truncate text-xs text-white/45">
                                      {shortUUID(d.id)} • {fmtISO(d.created_at)}
                                    </div>
                                    <div className="mt-1 truncate text-[11px] text-white/35 font-mono">
                                      {hash === "—" ? "—" : `${hash.slice(0, 14)}…${hash.slice(-10)}`}
                                    </div>
                                  </div>

                                  <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-medium text-white/70">
                                    {d.file_hash ? "HASHED" : "PENDING"}
                                  </span>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    <div className="border-t border-white/10 p-3 text-[10px] text-white/35">
                      Read-only browsing • Controlled actions via Edge (Generate / Export)
                    </div>
                  </div>
                </div>

                {/* RIGHT: Details */}
                <div className="col-span-12 lg:col-span-4">
                  <div className="rounded-3xl border border-white/10 bg-black/20 overflow-hidden">
                    <div className="border-b border-white/10 p-4">
                      <div className="text-xs font-semibold tracking-wide text-white/80">Details</div>
                      <div className="mt-1 text-[11px] text-white/45">
                        {tab === "SUBSCRIPTIONS"
                          ? selectedSub
                            ? "Subscription details"
                            : "Select a subscription"
                          : selectedDoc
                          ? "Document details"
                          : "Select a document"}
                      </div>
                    </div>

                    <div className="p-4">
                      {tab === "SUBSCRIPTIONS" ? (
                        !selectedSub ? (
                          <div className="text-sm text-white/55">Select a subscription to inspect.</div>
                        ) : (
                          <div className="space-y-3">
                            <div className="space-y-3 rounded-2xl border border-white/10 bg-black/20 p-4">
                              <Row k="Subscription ID" v={selectedSub.id} />
                              <Row k="Status" v={(selectedSub.status ?? "—").toString()} />
                              <Row k="Plan key" v={(selectedSub.plan_key ?? "—").toString()} />
                              <Row k="Plan id" v={(selectedSub.plan_id ?? "—").toString()} />
                              <Row k="Provider" v={(selectedSub.payment_provider ?? "—").toString()} />
                              <Row k="Provider cust" v={(selectedSub.provider_customer_id ?? "—").toString()} />
                              <Row k="Provider sub" v={(selectedSub.provider_subscription_id ?? "—").toString()} />
                              <Row k="Internal" v={(selectedSub.is_internal ?? false) ? "true" : "false"} />
                              {"is_test" in (selectedSub as any) ? (
                                <Row k="Lane flag" v={String((selectedSub as any).is_test)} />
                              ) : null}
                            </div>

                            <div className="space-y-3 rounded-2xl border border-white/10 bg-black/20 p-4">
                              <Row k="Started" v={fmtISO(selectedSub.started_at)} />
                              <Row k="Period start" v={fmtISO(selectedSub.current_period_start)} />
                              <Row k="Period end" v={fmtISO(selectedSub.current_period_end)} />
                              <Row k="Trial ends" v={fmtISO(selectedSub.trial_ends_at)} />
                              <Row k="Cancel at" v={fmtISO(selectedSub.cancel_at)} />
                              <Row k="Ended at" v={fmtISO(selectedSub.ended_at)} />
                            </div>

                            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                              <div className="text-[10px] uppercase tracking-[0.22em] text-white/35">metadata</div>
                              <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-white/70">
                                {safeJson(selectedSub.metadata ?? {})}
                              </pre>
                            </div>
                          </div>
                        )
                      ) : !selectedDoc ? (
                        <div className="text-sm text-white/55">Select a billing document to inspect.</div>
                      ) : (
                        <div className="space-y-3">
                          <div className="space-y-3 rounded-2xl border border-white/10 bg-black/20 p-4">
                            <Row k="Document ID" v={selectedDoc.id} />
                            <Row k="Type" v={(selectedDoc.document_type ?? selectedDoc.title ?? "—").toString()} />
                            <Row k="Created" v={fmtISO(selectedDoc.created_at)} />
                            <Row k="Hash" v={(selectedDoc.file_hash ?? "—").toString()} />
                            <Row
                              k="Storage"
                              v={
                                selectedDoc.storage_bucket && selectedDoc.storage_path
                                  ? `${selectedDoc.storage_bucket}/${selectedDoc.storage_path}`
                                  : "—"
                              }
                            />
                            {"is_test" in (selectedDoc as any) ? (
                              <Row k="Lane flag" v={String((selectedDoc as any).is_test)} />
                            ) : null}
                          </div>

                          <div className="grid grid-cols-2 gap-2">
                            <button
                              onClick={() =>
                                selectedDoc.storage_bucket && selectedDoc.storage_path
                                  ? openStorage(selectedDoc.storage_bucket, selectedDoc.storage_path)
                                  : null
                              }
                              disabled={!selectedDoc.storage_bucket || !selectedDoc.storage_path}
                              className={cx(
                                "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                                selectedDoc.storage_bucket && selectedDoc.storage_path
                                  ? "border-white/10 bg-white/5 text-white/85 hover:border-amber-300/20 hover:bg-white/7"
                                  : "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                              )}
                            >
                              Open PDF
                            </button>

                            <button
                              onClick={async () => {
                                const txt = selectedDoc.file_hash || "";
                                if (!txt) return;
                                const ok = await copyToClipboard(txt);
                                setNote(ok ? "Hash copied." : "Copy failed.");
                              }}
                              disabled={!selectedDoc.file_hash}
                              className={cx(
                                "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                                selectedDoc.file_hash
                                  ? "border-amber-300/15 bg-amber-300/10 text-amber-100 hover:bg-amber-300/14"
                                  : "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                              )}
                            >
                              Copy Hash
                            </button>
                          </div>

                          <div className="grid grid-cols-2 gap-2">
                            <button
                              onClick={async () => {
                                const ptr =
                                  selectedDoc.storage_bucket && selectedDoc.storage_path
                                    ? `${selectedDoc.storage_bucket}/${selectedDoc.storage_path}`
                                    : "";
                                if (!ptr) return;
                                const ok = await copyToClipboard(ptr);
                                setNote(ok ? "Storage pointer copied." : "Copy failed.");
                              }}
                              disabled={!selectedDoc.storage_bucket || !selectedDoc.storage_path}
                              className={cx(
                                "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                                selectedDoc.storage_bucket && selectedDoc.storage_path
                                  ? "border-white/10 bg-white/5 text-white/85 hover:border-amber-300/18 hover:bg-white/7"
                                  : "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                              )}
                            >
                              Copy Pointer
                            </button>

                            <button
                              onClick={() => setExportOpen(true)}
                              disabled={busy || !selectedDoc}
                              className={cx(
                                "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                                !busy && selectedDoc
                                  ? "border-white/10 bg-white/5 text-white/85 hover:border-amber-300/18 hover:bg-white/7"
                                  : "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                              )}
                            >
                              Export ZIP
                            </button>
                          </div>

                          <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                            <div className="text-[10px] uppercase tracking-[0.22em] text-white/35">metadata</div>
                            <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-white/70">
                              {safeJson(selectedDoc.metadata ?? {})}
                            </pre>
                          </div>

                          <div className="text-[10px] text-white/35">
                            Registry-grade: hash-first verification model • Operator-only
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="border-t border-white/10 p-3 text-[10px] text-white/35">
                      Entity-safe • Lane-safe • No hardcoded names • No enforcement
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Phase-2 hint (kept calm, no drift) */}
            <div className="mt-5 rounded-3xl border border-white/10 bg-black/20 px-4 py-3 text-[11px] text-slate-400">
              <div className="font-semibold text-slate-200">Next (optional)</div>
              <div className="mt-1 leading-relaxed text-slate-400">
                Surface <span className="text-slate-200 font-semibold">billing_documents</span> verification (public
                verify-billing) once you want external proof. Still no enforcement until you explicitly turn it on.
              </div>
            </div>
          </div>
        </div>

        <div className="mt-4 text-[10px] text-white/35">
          CI-Billing is internal operator tooling. Generation + export are Edge-only. No payments, no enforcement, no SQL required for daily ops.
        </div>
      </div>

      {/* Generate document modal */}
      <OsModal
        open={genOpen}
        title="Generate billing document"
        subtitle={`${entityLabel} • ${envLabel}${selectedSub ? ` • sub:${shortUUID(selectedSub.id)}` : ""}`}
        confirmText={busy ? "Working…" : "Generate"}
        cancelText="Cancel"
        busy={busy}
        onClose={() => (!busy ? setGenOpen(false) : null)}
        onConfirm={actionGenerateDocument}
      >
        <div className="space-y-3">
          <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
            <div className="text-sm text-white/80">
              This calls <span className="font-semibold">billing-generate-document</span> (Edge). It generates a PDF and registers it.
            </div>
            <div className="mt-2 text-xs text-white/45">
              No enforcement. No payment. Lane-safe via <span className="font-mono">is_test</span>.
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-white/35">title</div>
            <input
              value={genTitle}
              onChange={(e) => setGenTitle(e.target.value)}
              className="mt-2 w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white/85 outline-none focus:border-amber-300/25"
              placeholder="Invoice"
            />
            <div className="mt-2 text-xs text-white/45">
              This is operator-visible metadata only (does not alter enforcement).
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-white/35">metadata (json)</div>
            <textarea
              value={genMeta}
              onChange={(e) => setGenMeta(e.target.value)}
              className="mt-2 w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white/85 outline-none focus:border-amber-300/25 font-mono"
              rows={5}
              placeholder='{"note":"internal test"}'
            />
            <div className="mt-2 text-xs text-white/45">
              Safe payload. If invalid JSON, generation still proceeds with a minimal fallback marker.
            </div>
          </div>
        </div>
      </OsModal>

      {/* Export modal */}
      <OsModal
        open={exportOpen}
        title="Export billing discovery package"
        subtitle={selectedDoc ? `${selectedDoc.document_type || "Document"} • ${shortUUID(selectedDoc.id)}` : `${entityLabel} • ${envLabel}`}
        confirmText={busy ? "Working…" : "Export"}
        cancelText="Cancel"
        busy={busy}
        onClose={() => (!busy ? setExportOpen(false) : null)}
        onConfirm={actionExportDiscovery}
      >
        <div className="space-y-3">
          <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
            <div className="text-sm text-white/80">
              This calls <span className="font-semibold">export-billing-discovery-package</span> (Edge).
            </div>
            <div className="mt-2 text-xs text-white/45">
              Hash-first when available (<span className="font-mono">file_hash</span>). Non-mutating ZIP.
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/20 p-4 space-y-2">
            <Row k="entity_id" v={entityId ? entityId : "—"} />
            <Row k="lane" v={envLabel} />
            <Row k="document_id" v={selectedDoc ? selectedDoc.id : "—"} />
            <Row k="hash" v={selectedDoc?.file_hash || "—"} />
          </div>

          <div className="text-[11px] text-white/45">
            If your Edge function expects different keys, it will return a clear error and we’ll align the payload — no SQL required.
          </div>
        </div>
      </OsModal>
    </div>
  );
}
