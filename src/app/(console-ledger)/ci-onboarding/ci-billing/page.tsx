"use client";
export const dynamic = "force-dynamic";

/**
 * CI • Billing — OPERATOR CONSOLE (PRODUCTION — LOCKED)
 *
 * ✅ Registry-grade billing console (NO enforcement, NO payments)
 * ✅ ALL authority via Supabase Edge Functions (already deployed)
 * ✅ NO Next.js API routes
 * ✅ Lane-safe (SANDBOX / RoT) — MUST NOT CONTAMINATE
 * ✅ Provider = active OS entity (issuer)
 * ✅ Customers are first-class (provider_entity_id + is_test scoped)
 * ✅ Subscription lifecycle (create / update / end)
 * ✅ Document registry (attach external PDF)
 * ✅ Certification (billing-certify-document)
 * ✅ Resolver-backed Open PDF (resolve-billing-document)
 * ✅ Discovery export ZIP (export-billing-discovery-package)
 * ✅ AXIOM advisory snapshot (axiom-billing-snapshot)
 *
 * 🚫 NO REGRESSION ALLOWED
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";

/* ===================== utils ===================== */

function cx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function shortUUID(u?: string | null) {
  if (!u) return "—";
  return u.length > 14 ? `${u.slice(0, 8)}…${u.slice(-4)}` : u;
}

function fmtISO(v?: string | null) {
  if (!v) return "—";
  const d = new Date(v);
  return isNaN(d.getTime()) ? v : d.toISOString();
}

async function copyToClipboard(t: string) {
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    return false;
  }
}

function safeStr(v: any) {
  const s = (v ?? "").toString().trim();
  return s ? s : "—";
}

function isUuid(v: any) {
  const s = (v ?? "").toString().trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    bin += String.fromCharCode(...bytes.slice(i, i + chunkSize));
  }
  return btoa(bin);
}

/* ===================== types ===================== */

type CustomerRow = {
  id: string;
  provider_entity_id: string;
  is_test: boolean;
  legal_name: string;
  billing_email: string;
  contact_name?: string | null;
  phone?: string | null;
  address?: any | null;
  status: string;
  metadata: any;
  created_at?: string | null;
  updated_at?: string | null;
};

type PlanRow = {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  billing_period: string;
  price_minor: number;
  currency: string;
  is_active: boolean;
  entitlements: any;
  created_at?: string | null;
};

type SubRow = {
  id: string;
  entity_id: string;
  plan_id: string;
  plan_key?: string | null;
  status: string;
  started_at: string;
  current_period_start: string;
  current_period_end?: string | null;
  cancel_at?: string | null;
  trial_ends_at?: string | null;
  ended_at?: string | null;
  payment_provider?: string | null;
  provider_customer_id?: string | null;
  provider_subscription_id?: string | null;
  created_by?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  is_internal: boolean;
  is_test: boolean;
  source: string;
  customer_id?: string | null;
  metadata: any;
};

type DocRow = {
  id: string;
  entity_id: string;
  is_test: boolean;

  subscription_id?: string | null;
  document_type: string; // enum
  status: string; // enum
  document_number?: string | null;

  external_reference?: string | null;

  period_start?: string | null;
  period_end?: string | null;
  issued_at: string;
  voided_at?: string | null;

  currency: string; // enum
  subtotal_amount?: number | null;
  tax_amount?: number | null;
  total_amount?: number | null;

  storage_bucket: string;
  storage_path: string;
  file_hash: string;
  content_type: string;

  file_size_bytes?: number | null;

  line_items: any;
  metadata: any;

  created_by?: string | null;
  created_at?: string | null;
  updated_at?: string | null;

  certified_at?: string | null;
  certified_by?: string | null;
  certified_storage_bucket?: string | null;
  certified_storage_path?: string | null;
  certified_file_hash?: string | null;

  customer_id?: string | null;
  recipient_name?: string | null;
  recipient_email?: string | null;
};

type DeliveryRow = {
  id: string;
  entity_id?: string | null;
  is_test?: boolean | null;
  document_id: string;
  file_hash?: string | null;
  channel: string;
  recipient: string;
  status: string;
  provider?: string | null;
  provider_message_id?: string | null;
  error?: string | null;
  metadata: any;
  created_by?: string | null;
  created_at?: string | null;
  customer_id?: string | null;
};

type Tab = "CUSTOMERS" | "SUBSCRIPTIONS" | "DOCUMENTS" | "DELIVERY";

/* ===================== modal ===================== */

function OsModal({
  open,
  title,
  confirmText,
  busy,
  danger,
  onClose,
  onConfirm,
  children,
}: {
  open: boolean;
  title: string;
  confirmText: string;
  busy: boolean;
  danger?: boolean;
  onClose: () => void;
  onConfirm: () => void;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100]">
      <div className="absolute inset-0 bg-black/60" onClick={!busy ? onClose : undefined} />
      <div className="absolute left-1/2 top-1/2 w-[94vw] max-w-[640px] -translate-x-1/2 -translate-y-1/2">
        <div className="rounded-3xl border border-white/12 bg-[#070A12]/90 shadow-[0_30px_80px_rgba(0,0,0,.55)]">
          <div className="border-b border-white/10 p-4 text-lg font-semibold text-white/90">{title}</div>
          <div className="p-4 space-y-3">{children}</div>
          <div className="flex justify-end gap-2 border-t border-white/10 p-4">
            <button
              disabled={busy}
              onClick={onClose}
              className="rounded-full border border-white/10 px-4 py-2 text-xs text-white/70 hover:bg-white/5 disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              disabled={busy}
              onClick={onConfirm}
              className={cx(
                "rounded-full border px-4 py-2 text-xs font-semibold disabled:opacity-60",
                danger
                  ? "border-rose-300/20 bg-rose-500/12 text-rose-100 hover:bg-rose-500/18"
                  : "border-amber-300/20 bg-amber-400/12 text-amber-100 hover:bg-amber-400/18",
              )}
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

  // Provider identity (OS Entity = issuer)
  const entitySlug = ec?.entitySlug || ec?.entityKey || ec?.activeEntity || "entity";
  const entityLabel = ec?.entityName || ec?.label || ec?.name || entitySlug;

  // Lane safety (robust: avoid SANDBOX toggle writing to RoT)
  const isTest = Boolean(
    env?.is_test ??
      env?.isTest ??
      env?.lane_is_test ??
      env?.isSandbox ??
      env?.sandbox ??
      env?.env?.is_test ??
      false,
  );
  const envLabel = isTest ? "SANDBOX" : "RoT";

  const [providerEntityId, setProviderEntityId] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>("SUBSCRIPTIONS");

  // Registries
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [subs, setSubs] = useState<SubRow[]>([]);
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [delivery, setDelivery] = useState<DeliveryRow[]>([]);

  // Selection
  const [customerQuery, setCustomerQuery] = useState("");
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);

  const [selectedSub, setSelectedSub] = useState<SubRow | null>(null);
  const [selectedDoc, setSelectedDoc] = useState<DocRow | null>(null);
  const [selectedDelivery, setSelectedDelivery] = useState<DeliveryRow | null>(null);

  // UX
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Modals
  const [newCustomerOpen, setNewCustomerOpen] = useState(false);
  const [createSubOpen, setCreateSubOpen] = useState(false);
  const [updateSubOpen, setUpdateSubOpen] = useState(false);
  const [endSubOpen, setEndSubOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [certifyOpen, setCertifyOpen] = useState(false);

  // New customer form
  const [custLegalName, setCustLegalName] = useState("");
  const [custBillingEmail, setCustBillingEmail] = useState("");
  const [custContactName, setCustContactName] = useState("");
  const [custPhone, setCustPhone] = useState("");
  const [custStatus, setCustStatus] = useState("active");

  // Subscription form
  const [planKey, setPlanKey] = useState("");
  const [reason, setReason] = useState("");

  // Attach external document form (matches Edge function contract)
  const [attachDocumentType, setAttachDocumentType] = useState("invoice");
  const [attachSource, setAttachSource] = useState("manual");
  const [attachPeriod, setAttachPeriod] = useState(""); // e.g. 2026-02
  const [attachReason, setAttachReason] = useState("");
  const [attachFile, setAttachFile] = useState<File | null>(null);
  const attachInputRef = useRef<HTMLInputElement | null>(null);

  // Certify form
  const [certifyForce, setCertifyForce] = useState(false);

  /* ===================== derived ===================== */

  const filteredCustomers = useMemo(() => {
    const q = customerQuery.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter((c) => {
      const a = (c.legal_name || "").toLowerCase();
      const b = (c.billing_email || "").toLowerCase();
      return a.includes(q) || b.includes(q);
    });
  }, [customers, customerQuery]);

  const selectedCustomer = useMemo(() => {
    return customers.find((c) => c.id === selectedCustomerId) || null;
  }, [customers, selectedCustomerId]);

  const subsForCustomer = useMemo(() => {
    if (!selectedCustomerId) return subs;
    return subs.filter((s) => (s.customer_id ?? null) === selectedCustomerId);
  }, [subs, selectedCustomerId]);

  const docsForCustomer = useMemo(() => {
    if (!selectedCustomerId) return docs;
    return docs.filter((d) => (d.customer_id ?? null) === selectedCustomerId);
  }, [docs, selectedCustomerId]);

  const deliveryForCustomer = useMemo(() => {
    if (!selectedCustomerId) return delivery;
    return delivery.filter((e) => (e.customer_id ?? null) === selectedCustomerId);
  }, [delivery, selectedCustomerId]);

  const commercialIntent = useMemo(() => {
    // A “Commercial Intent” badge is visible when there is any active non-internal subscription in the lane.
    return subs.some((s) => (s.status || "").toLowerCase() === "active" && !s.is_internal);
  }, [subs]);

  const counts = useMemo(() => {
    const laneDocs = docsForCustomer;
    const certified = laneDocs.filter((d) => !!d.certified_at).length;
    return {
      customers: filteredCustomers.length,
      subs: subsForCustomer.length,
      docs: docsForCustomer.length,
      certified,
      delivery: deliveryForCustomer.length,
    };
  }, [filteredCustomers.length, subsForCustomer.length, docsForCustomer.length, deliveryForCustomer.length, docsForCustomer]);

  const activeSub = useMemo(() => {
    const list = subsForCustomer;
    return list.find((s) => (s.status || "").toLowerCase() === "active") || null;
  }, [subsForCustomer]);

  /* ===================== core: Edge invoke helper ===================== */

  async function invoke(fn: string, body: any) {
    setBusy(true);
    setNote(null);
    try {
      const { data, error } = await supabase.functions.invoke(fn, { body });
      if (error) throw error;
      setNote("Action completed.");
      setRefreshKey((n) => n + 1);
      return data;
    } catch (e: any) {
      const msg = e?.message || "Action failed";
      setNote(msg);
      alert(msg);
      throw e;
    } finally {
      setBusy(false);
    }
  }

  /* ===================== resolve provider entity_id ===================== */

  useEffect(() => {
    (async () => {
      const direct = ec?.entityId || ec?.activeEntityId || ec?.entity_id;
      if (direct && isUuid(direct)) {
        setProviderEntityId(direct);
        return;
      }
      const { data, error } = await supabase.from("entities").select("id").eq("slug", entitySlug).maybeSingle();
      if (error) {
        setProviderEntityId(null);
        return;
      }
      setProviderEntityId(data?.id ?? null);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entitySlug]);

  /* ===================== load registries (lane-safe) ===================== */

  useEffect(() => {
    if (!providerEntityId) return;
    (async () => {
      // Customers: provider scoped
      const { data: c } = await supabase
        .from("billing_customers")
        .select("*")
        .eq("provider_entity_id", providerEntityId)
        .eq("is_test", isTest)
        .order("created_at", { ascending: false });

      const rows = (c || []) as CustomerRow[];
      setCustomers(rows);

      // auto-select first if none selected
      if (!selectedCustomerId && rows[0]?.id) {
        setSelectedCustomerId(rows[0].id);
      }
    })();
  }, [providerEntityId, isTest, refreshKey]); // keep selectedCustomerId out to avoid loops

  useEffect(() => {
    // Plans are not lane-scoped in your schema (global catalog)
    (async () => {
      const { data: p } = await supabase.from("billing_plans").select("*").order("created_at", { ascending: false });
      setPlans((p || []) as PlanRow[]);
    })();
  }, [refreshKey]);

  useEffect(() => {
    if (!providerEntityId) return;
    (async () => {
      // Subscriptions: entity_id is provider
      const { data: s } = await supabase
        .from("billing_subscriptions")
        .select("*")
        .eq("entity_id", providerEntityId)
        .eq("is_test", isTest)
        .order("created_at", { ascending: false });

      const rows = (s || []) as SubRow[];
      setSubs(rows);
      setSelectedSub(rows[0] ?? null);
    })();
  }, [providerEntityId, isTest, refreshKey]);

  useEffect(() => {
    if (!providerEntityId) return;
    (async () => {
      // Documents: entity_id is provider
      const { data: d } = await supabase
        .from("billing_documents")
        .select("*")
        .eq("entity_id", providerEntityId)
        .eq("is_test", isTest)
        .order("created_at", { ascending: false });

      const rows = (d || []) as DocRow[];
      setDocs(rows);
      setSelectedDoc(rows[0] ?? null);
    })();
  }, [providerEntityId, isTest, refreshKey]);

  useEffect(() => {
    (async () => {
      // Delivery events: may have nullable entity_id/is_test; we filter best-effort by provider + lane.
      // If some rows are null, they’ll still show once selected by customer filter.
      const { data: e } = await supabase
        .from("billing_delivery_events")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200);

      const rows = (e || []) as DeliveryRow[];

      const filtered = rows.filter((r) => {
        const sameLane = (r.is_test ?? null) === null ? true : Boolean(r.is_test) === isTest;
        const sameEntity = (r.entity_id ?? null) === null ? true : r.entity_id === providerEntityId;
        return sameLane && sameEntity;
      });

      setDelivery(filtered);
      setSelectedDelivery(filtered[0] ?? null);
    })();
  }, [providerEntityId, isTest, refreshKey]);

  /* ===================== authority actions ===================== */

  async function runAxiom() {
    if (!providerEntityId) return alert("Missing provider entity_id");
    await invoke("axiom-billing-snapshot", { entity_id: providerEntityId, is_test: isTest });
  }

  async function openPdfViaResolver(doc: DocRow) {
    // Resolver is hash-first; we pass both hash + id (tolerated)
    const data = await invoke("resolve-billing-document", {
      hash: doc.file_hash,
      document_id: doc.id,
      is_test: isTest,
      entity_id: providerEntityId,
      trigger: "ci_billing_open_pdf",
    });
    if (data?.urls?.pdf) window.open(data.urls.pdf, "_blank", "noopener,noreferrer");
  }

  async function openCertifiedPdfClient(doc: DocRow) {
    // Resolver resolves by billing_documents.file_hash; certified uses dedicated pointers.
    // We open certified PDF via Storage signed url directly (NO backend changes).
    const b = (doc.certified_storage_bucket ?? "").toString().trim();
    const p = (doc.certified_storage_path ?? "").toString().trim();
    if (!b || !p) return alert("No certified storage pointer on this document.");
    const { data, error } = await supabase.storage.from(b).createSignedUrl(p, 60 * 10);
    if (error || !data?.signedUrl) return alert(error?.message || "Failed to sign certified PDF URL.");
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  }

  async function exportDiscovery(doc: DocRow) {
    const data = await invoke("export-billing-discovery-package", {
      hash: doc.file_hash,
      document_id: doc.id,
      include_pdf: true,
      trigger: "ci_billing_export_discovery",
    });
    if (data?.url) window.open(data.url, "_blank", "noopener,noreferrer");
  }

  async function certifyDocument(doc: DocRow) {
    // billing-certify-document expects billing_document_id/document_id; operator JWT is required by your code.
    const data = await invoke("billing-certify-document", {
      billing_document_id: doc.id,
      force: certifyForce,
      // verify_base_url optional; default is sign.oasisintlholdings.com
      trigger: "ci_billing_certify",
    });
    if (data?.verify_url) {
      setNote(`Certified. Verify URL ready.`);
    }
  }

  /* ===================== mutations (Edge) ===================== */

  async function createCustomer() {
    if (!providerEntityId) return alert("Missing provider entity_id");
    if (!custLegalName.trim()) return alert("legal_name required");
    if (!custBillingEmail.trim()) return alert("billing_email required");

    // We insert directly (operator console, RLS should allow provider operators).
    // If you later want an RPC, this can be swapped with NO UI regression.
    setBusy(true);
    setNote(null);
    try {
      const { data: row, error } = await supabase
        .from("billing_customers")
        .insert({
          provider_entity_id: providerEntityId,
          is_test: isTest,
          legal_name: custLegalName.trim(),
          billing_email: custBillingEmail.trim(),
          contact_name: custContactName.trim() || null,
          phone: custPhone.trim() || null,
          address: null,
          status: custStatus.trim() || "active",
          metadata: {},
        })
        .select("*")
        .single();

      if (error) throw error;
      setNote("Customer created.");
      setRefreshKey((n) => n + 1);
      setSelectedCustomerId(row?.id ?? null);
      setNewCustomerOpen(false);

      setCustLegalName("");
      setCustBillingEmail("");
      setCustContactName("");
      setCustPhone("");
      setCustStatus("active");
    } catch (e: any) {
      alert(e?.message || "Create customer failed");
    } finally {
      setBusy(false);
    }
  }

  async function createSubscription() {
    if (!providerEntityId) return alert("Missing provider entity_id");
    if (!planKey.trim()) return alert("plan_key required");
    if (!reason.trim()) return alert("reason required");

    await invoke("billing-create-subscription", {
      entity_id: providerEntityId,
      plan_key: planKey.trim(),
      is_test: isTest,
      reason: reason.trim(),
      customer_id: selectedCustomerId, // optional; tolerated
      trigger: "ci_billing_create_subscription",
    });

    setCreateSubOpen(false);
    setPlanKey("");
    setReason("");
  }

  async function updateSubscription() {
    if (!selectedSub?.id) return alert("No subscription selected");
    if (!planKey.trim()) return alert("plan_key required");
    if (!reason.trim()) return alert("reason required");

    await invoke("billing-update-subscription", {
      subscription_id: selectedSub.id,
      plan_key: planKey.trim(),
      reason: reason.trim(),
      trigger: "ci_billing_update_subscription",
    });

    setUpdateSubOpen(false);
    setPlanKey("");
    setReason("");
  }

  async function endSubscription() {
    if (!selectedSub?.id) return alert("No subscription selected");
    if (!reason.trim()) return alert("reason required");

    await invoke("billing-end-subscription", {
      subscription_id: selectedSub.id,
      reason: reason.trim(),
      trigger: "ci_billing_end_subscription",
    });

    setEndSubOpen(false);
    setReason("");
  }

  async function attachExternalDocument() {
    if (!providerEntityId) return alert("Missing provider entity_id");
    if (!attachReason.trim()) return alert("reason required");
    if (!attachFile) return alert("PDF file required");

    const b64 = await fileToBase64(attachFile);

    await invoke("billing-attach-external-document", {
      entity_id: providerEntityId,
      document_type: attachDocumentType,
      period: attachPeriod.trim() || null,
      source: attachSource,
      file_name: attachFile.name,
      mime_type: attachFile.type || "application/pdf",
      base64_file: b64,
      is_test: isTest,
      reason: attachReason.trim(),
      customer_id: selectedCustomerId, // optional; tolerated if backend ignores
      trigger: "ci_billing_attach_external_document",
    });

    setAttachOpen(false);
    setAttachReason("");
    setAttachPeriod("");
    setAttachSource("manual");
    setAttachDocumentType("invoice");
    setAttachFile(null);
    if (attachInputRef.current) attachInputRef.current.value = "";
  }

  /* ===================== UI helpers ===================== */

  const listRows = useMemo(() => {
    if (tab === "CUSTOMERS") return filteredCustomers;
    if (tab === "SUBSCRIPTIONS") return subsForCustomer;
    if (tab === "DOCUMENTS") return docsForCustomer;
    return deliveryForCustomer;
  }, [tab, filteredCustomers, subsForCustomer, docsForCustomer, deliveryForCustomer]);

  const selectedId = useMemo(() => {
    if (tab === "CUSTOMERS") return selectedCustomerId;
    if (tab === "SUBSCRIPTIONS") return selectedSub?.id ?? null;
    if (tab === "DOCUMENTS") return selectedDoc?.id ?? null;
    return selectedDelivery?.id ?? null;
  }, [tab, selectedCustomerId, selectedSub, selectedDoc, selectedDelivery]);

  function selectRow(r: any) {
    if (tab === "CUSTOMERS") {
      setSelectedCustomerId(r.id);
      // keep other selections but re-point to first relevant
      const s = subs.filter((x) => (x.customer_id ?? null) === r.id)[0] || subs[0] || null;
      const d = docs.filter((x) => (x.customer_id ?? null) === r.id)[0] || docs[0] || null;
      setSelectedSub(s);
      setSelectedDoc(d);
      return;
    }
    if (tab === "SUBSCRIPTIONS") setSelectedSub(r);
    if (tab === "DOCUMENTS") setSelectedDoc(r);
    if (tab === "DELIVERY") setSelectedDelivery(r);
  }

  /* ===================== render ===================== */

  return (
    <div className="mx-auto max-w-[1480px] px-4 py-6">
      <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_80px_rgba(0,0,0,.35)]">
        {/* HEADER */}
        <div className="border-b border-white/10 p-4">
          <div className="text-xs uppercase tracking-[0.3em] text-slate-500">CI • Billing</div>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold text-white/90">Billing Console</h1>

            {commercialIntent ? (
              <span className="rounded-full border border-emerald-300/20 bg-emerald-400/12 px-3 py-1 text-[10px] font-semibold text-emerald-100">
                Commercial Intent
              </span>
            ) : (
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[10px] text-white/50">
                Internal / Non-Billable
              </span>
            )}

            <span className={cx(
              "rounded-full border px-3 py-1 text-[10px] font-semibold",
              isTest ? "border-amber-300/20 bg-amber-400/12 text-amber-100" : "border-sky-300/20 bg-sky-400/12 text-sky-100",
            )}>
              Lane: {envLabel}
            </span>
          </div>

          <div className="mt-2 text-xs text-white/45">
            Provider (OS Entity): {entityLabel} • provider_entity_id: {shortUUID(providerEntityId)} • Selected customer:{" "}
            {selectedCustomer ? `${selectedCustomer.legal_name} (${selectedCustomer.billing_email})` : "—"}
          </div>
        </div>

        {/* TABS */}
        <div className="flex flex-wrap gap-2 border-b border-white/10 px-4 py-2">
          {(["CUSTOMERS", "SUBSCRIPTIONS", "DOCUMENTS", "DELIVERY"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cx(
                "rounded-full px-3 py-1 text-xs transition",
                tab === t ? "bg-white/10 text-white" : "text-white/55 hover:text-white",
              )}
            >
              {t}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2">
            <button
              disabled={busy}
              onClick={() => setRefreshKey((n) => n + 1)}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70 hover:bg-white/10 disabled:opacity-60"
            >
              Refresh
            </button>
          </div>
        </div>

        {/* BODY */}
        <div className="grid grid-cols-12 gap-4 p-4">
          {/* LEFT RAIL */}
          <div className="col-span-12 lg:col-span-3 space-y-3">
            {/* Customer selector */}
            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <div className="text-xs font-semibold text-white/80">Customer</div>
              <div className="mt-2">
                <input
                  placeholder="Search customers…"
                  value={customerQuery}
                  onChange={(e) => setCustomerQuery(e.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/90 placeholder:text-white/35 outline-none"
                />
              </div>

              <div className="mt-2 max-h-[180px] overflow-auto rounded-xl border border-white/10 bg-black/10">
                {filteredCustomers.length === 0 ? (
                  <div className="p-3 text-xs text-white/50">No customers in this lane.</div>
                ) : (
                  filteredCustomers.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => {
                        setSelectedCustomerId(c.id);
                        setTab("SUBSCRIPTIONS");
                      }}
                      className={cx(
                        "w-full px-3 py-2 text-left text-xs border-b border-white/5 last:border-b-0",
                        selectedCustomerId === c.id ? "bg-amber-400/10 text-white/90" : "hover:bg-white/5 text-white/70",
                      )}
                    >
                      <div className="font-semibold">{c.legal_name}</div>
                      <div className="text-white/45">{c.billing_email} • {shortUUID(c.id)}</div>
                    </button>
                  ))
                )}
              </div>

              <div className="mt-3 flex gap-2">
                <button
                  disabled={!providerEntityId || busy}
                  onClick={() => setNewCustomerOpen(true)}
                  className="w-full rounded-xl border border-emerald-300/20 bg-emerald-400/12 px-3 py-2 text-xs font-semibold text-emerald-100 hover:bg-emerald-400/18 disabled:opacity-60"
                >
                  New Customer
                </button>
              </div>
            </div>

            {/* KPIs */}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                <div className="text-[10px] uppercase tracking-[0.25em] text-white/40">Active</div>
                <div className="mt-1 text-sm font-semibold text-white/90">
                  {activeSub ? (activeSub.plan_key || safeStr(activeSub.plan_id)) : "—"}
                </div>
                <div className="mt-1 text-xs text-white/45">{activeSub ? safeStr(activeSub.status) : "No active sub"}</div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                <div className="text-[10px] uppercase tracking-[0.25em] text-white/40">Docs</div>
                <div className="mt-1 text-sm font-semibold text-white/90">{counts.docs}</div>
                <div className="mt-1 text-xs text-white/45">Certified: {counts.certified}</div>
              </div>
            </div>

            {/* Notes */}
            <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-xs text-white/70">
              <div>Customers: {counts.customers}</div>
              <div>Subscriptions: {counts.subs}</div>
              <div>Documents: {counts.docs}</div>
              <div>Delivery: {counts.delivery}</div>
              {note && <div className="mt-2 text-amber-200">{note}</div>}
            </div>

            {/* Authority actions */}
            <button
              disabled={!providerEntityId || busy}
              onClick={runAxiom}
              className="w-full rounded-2xl border border-sky-300/20 bg-sky-400/12 px-4 py-2 text-xs font-semibold text-sky-100 hover:bg-sky-400/18 disabled:opacity-60"
            >
              Run AXIOM Advisory
            </button>

            {/* Mutation actions */}
            <div className="rounded-2xl border border-white/10 bg-black/20 p-3 space-y-2">
              <button
                disabled={!providerEntityId || busy}
                onClick={() => setCreateSubOpen(true)}
                className="w-full rounded-xl border border-emerald-300/20 bg-emerald-400/12 px-3 py-2 text-xs text-emerald-100 hover:bg-emerald-400/18 disabled:opacity-60"
              >
                Create Subscription
              </button>
              <button
                disabled={!selectedSub || busy}
                onClick={() => setUpdateSubOpen(true)}
                className="w-full rounded-xl border border-amber-300/20 bg-amber-400/12 px-3 py-2 text-xs text-amber-100 hover:bg-amber-400/18 disabled:opacity-60"
              >
                Update Subscription
              </button>
              <button
                disabled={!selectedSub || busy}
                onClick={() => setEndSubOpen(true)}
                className="w-full rounded-xl border border-rose-300/20 bg-rose-500/12 px-3 py-2 text-xs text-rose-100 hover:bg-rose-500/18 disabled:opacity-60"
              >
                End Subscription
              </button>
              <div className="h-px bg-white/10" />
              <button
                disabled={!providerEntityId || busy}
                onClick={() => setAttachOpen(true)}
                className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 disabled:opacity-60"
              >
                Attach External Document (PDF)
              </button>
            </div>
          </div>

          {/* MIDDLE LIST */}
          <div className="col-span-12 lg:col-span-5 space-y-2">
            {listRows.length === 0 ? (
              <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-white/55">
                No records in this tab (lane + provider + customer scoped).
              </div>
            ) : (
              listRows.map((r: any) => {
                const isSelected = selectedId === r.id;
                const headline =
                  tab === "CUSTOMERS"
                    ? r.legal_name
                    : tab === "SUBSCRIPTIONS"
                    ? r.plan_key || safeStr(r.plan_id)
                    : tab === "DOCUMENTS"
                    ? `${r.document_type} • ${r.status}`
                    : `${r.channel} • ${r.status}`;

                const subline =
                  tab === "CUSTOMERS"
                    ? r.billing_email
                    : tab === "SUBSCRIPTIONS"
                    ? `status: ${safeStr(r.status)} • ${fmtISO(r.created_at)}`
                    : tab === "DOCUMENTS"
                    ? `hash: ${r.file_hash?.slice(0, 10)}… • ${fmtISO(r.created_at)}`
                    : `recipient: ${safeStr(r.recipient)} • ${fmtISO(r.created_at)}`;

                const laneBadge =
                  tab === "CUSTOMERS"
                    ? r.is_test
                    : tab === "SUBSCRIPTIONS"
                    ? r.is_test
                    : tab === "DOCUMENTS"
                    ? r.is_test
                    : r.is_test;

                return (
                  <button
                    key={r.id}
                    onClick={() => selectRow(r)}
                    className={cx(
                      "w-full rounded-2xl border p-3 text-left transition",
                      isSelected ? "border-amber-300/25 bg-black/40" : "border-white/10 bg-black/20 hover:bg-black/30",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-semibold text-white/90">{headline}</div>
                      <span
                        className={cx(
                          "rounded-full border px-2 py-[2px] text-[10px] font-semibold",
                          laneBadge ? "border-amber-300/20 bg-amber-400/12 text-amber-100" : "border-sky-300/20 bg-sky-400/12 text-sky-100",
                        )}
                      >
                        {laneBadge ? "SANDBOX" : "RoT"}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-white/45">{subline}</div>
                    <div className="mt-1 text-[11px] text-white/40">{shortUUID(r.id)}</div>
                  </button>
                );
              })
            )}
          </div>

          {/* RIGHT DETAILS */}
          <div className="col-span-12 lg:col-span-4 space-y-3">
            {/* CUSTOMER DETAILS */}
            {tab === "CUSTOMERS" && selectedCustomer && (
              <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <div className="text-sm font-semibold text-white/90">{selectedCustomer.legal_name}</div>
                <div className="mt-1 text-xs text-white/60">{selectedCustomer.billing_email}</div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-white/65">
                  <div className="rounded-xl border border-white/10 bg-black/10 p-3">
                    <div className="text-[10px] uppercase tracking-[0.22em] text-white/40">Status</div>
                    <div className="mt-1">{safeStr(selectedCustomer.status)}</div>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-black/10 p-3">
                    <div className="text-[10px] uppercase tracking-[0.22em] text-white/40">Lane</div>
                    <div className="mt-1">{selectedCustomer.is_test ? "SANDBOX" : "RoT"}</div>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-black/10 p-3 col-span-2">
                    <div className="text-[10px] uppercase tracking-[0.22em] text-white/40">Contact</div>
                    <div className="mt-1">
                      {safeStr(selectedCustomer.contact_name)} • {safeStr(selectedCustomer.phone)}
                    </div>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={async () => {
                      await copyToClipboard(selectedCustomer.billing_email);
                      setNote("Customer email copied");
                    }}
                    className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/80 hover:bg-white/10"
                  >
                    Copy Email
                  </button>
                  <button
                    onClick={async () => {
                      await copyToClipboard(selectedCustomer.id);
                      setNote("Customer id copied");
                    }}
                    className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/80 hover:bg-white/10"
                  >
                    Copy Customer ID
                  </button>
                </div>
              </div>
            )}

            {/* SUBSCRIPTION DETAILS */}
            {tab === "SUBSCRIPTIONS" && selectedSub && (
              <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold text-white/90">
                      {selectedSub.plan_key || safeStr(selectedSub.plan_id)}
                    </div>
                    <div className="mt-1 text-xs text-white/55">
                      status: {safeStr(selectedSub.status)} • sub_id: {shortUUID(selectedSub.id)}
                    </div>
                  </div>
                  <span
                    className={cx(
                      "rounded-full border px-2 py-[2px] text-[10px] font-semibold",
                      selectedSub.is_test ? "border-amber-300/20 bg-amber-400/12 text-amber-100" : "border-sky-300/20 bg-sky-400/12 text-sky-100",
                    )}
                  >
                    {selectedSub.is_test ? "SANDBOX" : "RoT"}
                  </span>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-white/70">
                  <div className="rounded-xl border border-white/10 bg-black/10 p-3">
                    <div className="text-[10px] uppercase tracking-[0.22em] text-white/40">Started</div>
                    <div className="mt-1">{fmtISO(selectedSub.started_at)}</div>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-black/10 p-3">
                    <div className="text-[10px] uppercase tracking-[0.22em] text-white/40">Trial ends</div>
                    <div className="mt-1">{fmtISO(selectedSub.trial_ends_at || null)}</div>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-black/10 p-3">
                    <div className="text-[10px] uppercase tracking-[0.22em] text-white/40">Period start</div>
                    <div className="mt-1">{fmtISO(selectedSub.current_period_start)}</div>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-black/10 p-3">
                    <div className="text-[10px] uppercase tracking-[0.22em] text-white/40">Period end</div>
                    <div className="mt-1">{fmtISO(selectedSub.current_period_end || null)}</div>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-black/10 p-3 col-span-2">
                    <div className="text-[10px] uppercase tracking-[0.22em] text-white/40">Provider IDs</div>
                    <div className="mt-1">
                      customer: {safeStr(selectedSub.provider_customer_id)} • sub: {safeStr(selectedSub.provider_subscription_id)}
                    </div>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    disabled={busy}
                    onClick={() => setUpdateSubOpen(true)}
                    className="rounded-full border border-amber-300/20 bg-amber-400/12 px-3 py-1 text-xs font-semibold text-amber-100 hover:bg-amber-400/18 disabled:opacity-60"
                  >
                    Update
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => setEndSubOpen(true)}
                    className="rounded-full border border-rose-300/20 bg-rose-500/12 px-3 py-1 text-xs font-semibold text-rose-100 hover:bg-rose-500/18 disabled:opacity-60"
                  >
                    End
                  </button>
                  <button
                    onClick={async () => {
                      await copyToClipboard(selectedSub.id);
                      setNote("Subscription id copied");
                    }}
                    className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/80 hover:bg-white/10"
                  >
                    Copy ID
                  </button>
                </div>
              </div>
            )}

            {/* DOCUMENT DETAILS */}
            {tab === "DOCUMENTS" && selectedDoc && (
              <>
                <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold text-white/90">
                        {selectedDoc.document_type} • {selectedDoc.status}
                      </div>
                      <div className="mt-1 text-xs text-white/55">
                        doc_id: {shortUUID(selectedDoc.id)} • issued: {fmtISO(selectedDoc.issued_at)}
                      </div>
                    </div>
                    <span
                      className={cx(
                        "rounded-full border px-2 py-[2px] text-[10px] font-semibold",
                        selectedDoc.is_test ? "border-amber-300/20 bg-amber-400/12 text-amber-100" : "border-sky-300/20 bg-sky-400/12 text-sky-100",
                      )}
                    >
                      {selectedDoc.is_test ? "SANDBOX" : "RoT"}
                    </span>
                  </div>

                  <div className="mt-3 space-y-2 text-xs text-white/70">
                    <div className="rounded-xl border border-white/10 bg-black/10 p-3">
                      <div className="text-[10px] uppercase tracking-[0.22em] text-white/40">Hash (source)</div>
                      <div className="mt-1 break-all font-mono text-[11px] text-white/80">{selectedDoc.file_hash}</div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button
                          disabled={busy}
                          onClick={async () => {
                            await copyToClipboard(selectedDoc.file_hash);
                            setNote("Hash copied");
                          }}
                          className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/80 hover:bg-white/10"
                        >
                          Copy Hash
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => openPdfViaResolver(selectedDoc)}
                          className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/80 hover:bg-white/10"
                        >
                          Open PDF (resolver)
                        </button>
                      </div>
                    </div>

                    <div className="rounded-xl border border-white/10 bg-black/10 p-3">
                      <div className="text-[10px] uppercase tracking-[0.22em] text-white/40">Recipient</div>
                      <div className="mt-1">
                        {safeStr(selectedDoc.recipient_name)} • {safeStr(selectedDoc.recipient_email)}
                      </div>
                    </div>

                    <div className="rounded-xl border border-white/10 bg-black/10 p-3">
                      <div className="text-[10px] uppercase tracking-[0.22em] text-white/40">Totals</div>
                      <div className="mt-1">
                        {selectedDoc.currency} • subtotal: {safeStr(selectedDoc.subtotal_amount)} • tax:{" "}
                        {safeStr(selectedDoc.tax_amount)} • total: {safeStr(selectedDoc.total_amount)}
                      </div>
                    </div>

                    <div className="rounded-xl border border-white/10 bg-black/10 p-3">
                      <div className="text-[10px] uppercase tracking-[0.22em] text-white/40">Certification</div>
                      <div className="mt-1">
                        {selectedDoc.certified_at ? (
                          <span className="text-emerald-200">
                            Certified at {fmtISO(selectedDoc.certified_at)} • hash:{" "}
                            <span className="font-mono">{selectedDoc.certified_file_hash?.slice(0, 12)}…</span>
                          </span>
                        ) : (
                          <span className="text-white/55">Not certified</span>
                        )}
                      </div>

                      <div className="mt-2 flex flex-wrap gap-2">
                        <button
                          disabled={busy}
                          onClick={() => setCertifyOpen(true)}
                          className="rounded-full border border-amber-300/20 bg-amber-400/12 px-3 py-1 text-xs font-semibold text-amber-100 hover:bg-amber-400/18 disabled:opacity-60"
                        >
                          Certify Document
                        </button>

                        <button
                          disabled={busy || !selectedDoc.certified_storage_bucket || !selectedDoc.certified_storage_path}
                          onClick={() => openCertifiedPdfClient(selectedDoc)}
                          className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/80 hover:bg-white/10 disabled:opacity-60"
                        >
                          Open Certified PDF
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                <button
                  disabled={busy}
                  onClick={() => exportDiscovery(selectedDoc)}
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-2 text-xs text-white/85 hover:bg-white/10 disabled:opacity-60"
                >
                  Export Discovery ZIP
                </button>
              </>
            )}

            {/* DELIVERY DETAILS */}
            {tab === "DELIVERY" && selectedDelivery && (
              <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <div className="text-sm font-semibold text-white/90">
                  {selectedDelivery.channel} • {selectedDelivery.status}
                </div>
                <div className="mt-1 text-xs text-white/55">
                  delivery_id: {shortUUID(selectedDelivery.id)} • doc_id: {shortUUID(selectedDelivery.document_id)}
                </div>

                <div className="mt-3 space-y-2 text-xs text-white/70">
                  <div className="rounded-xl border border-white/10 bg-black/10 p-3">
                    <div className="text-[10px] uppercase tracking-[0.22em] text-white/40">Recipient</div>
                    <div className="mt-1">{safeStr(selectedDelivery.recipient)}</div>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-black/10 p-3">
                    <div className="text-[10px] uppercase tracking-[0.22em] text-white/40">Provider</div>
                    <div className="mt-1">
                      {safeStr(selectedDelivery.provider)} • msg: {safeStr(selectedDelivery.provider_message_id)}
                    </div>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-black/10 p-3">
                    <div className="text-[10px] uppercase tracking-[0.22em] text-white/40">Error</div>
                    <div className="mt-1">{safeStr(selectedDelivery.error)}</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ===================== MODALS ===================== */}

      <OsModal
        open={newCustomerOpen}
        title="New customer (provider-scoped)"
        confirmText="Create"
        busy={busy}
        onClose={() => setNewCustomerOpen(false)}
        onConfirm={createCustomer}
      >
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <div className="text-xs text-white/55">Legal name *</div>
            <input
              value={custLegalName}
              onChange={(e) => setCustLegalName(e.target.value)}
              className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/90 outline-none"
              placeholder="e.g., Holdings Test Customer"
            />
          </div>
          <div className="col-span-2">
            <div className="text-xs text-white/55">Billing email *</div>
            <input
              value={custBillingEmail}
              onChange={(e) => setCustBillingEmail(e.target.value)}
              className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/90 outline-none"
              placeholder="billing@customer.com"
            />
          </div>
          <div>
            <div className="text-xs text-white/55">Contact name</div>
            <input
              value={custContactName}
              onChange={(e) => setCustContactName(e.target.value)}
              className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/90 outline-none"
              placeholder="Optional"
            />
          </div>
          <div>
            <div className="text-xs text-white/55">Phone</div>
            <input
              value={custPhone}
              onChange={(e) => setCustPhone(e.target.value)}
              className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/90 outline-none"
              placeholder="Optional"
            />
          </div>
          <div className="col-span-2">
            <div className="text-xs text-white/55">Status</div>
            <input
              value={custStatus}
              onChange={(e) => setCustStatus(e.target.value)}
              className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/90 outline-none"
              placeholder="active"
            />
          </div>
          <div className="col-span-2 text-xs text-white/45">
            Provider: <span className="font-mono">{shortUUID(providerEntityId)}</span> • Lane: {envLabel}
          </div>
        </div>
      </OsModal>

      <OsModal
        open={createSubOpen}
        title="Create subscription"
        confirmText="Create"
        busy={busy}
        onClose={() => setCreateSubOpen(false)}
        onConfirm={createSubscription}
      >
        <div className="space-y-3">
          <div className="text-xs text-white/55">Plan key *</div>
          <input
            placeholder="plan_key (e.g., internal_trial / standard_monthly)"
            value={planKey}
            onChange={(e) => setPlanKey(e.target.value)}
            className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/90 outline-none"
          />
          <div className="rounded-xl border border-white/10 bg-black/10 p-3">
            <div className="text-[10px] uppercase tracking-[0.22em] text-white/40">Available plans (catalog)</div>
            <div className="mt-2 max-h-[140px] overflow-auto space-y-2">
              {plans.length === 0 ? (
                <div className="text-xs text-white/50">No plans loaded.</div>
              ) : (
                plans.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setPlanKey(p.code)}
                    className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-left text-xs text-white/75 hover:bg-white/5"
                    type="button"
                  >
                    <div className="font-semibold text-white/90">{p.code}</div>
                    <div className="text-white/45">
                      {p.name} • {p.currency} {p.price_minor} / {p.billing_period} • {p.is_active ? "active" : "inactive"}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="text-xs text-white/55">Reason *</div>
          <input
            placeholder="reason (required, audited)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/90 outline-none"
          />
          <div className="text-xs text-white/45">
            Customer: {selectedCustomer ? `${selectedCustomer.legal_name} (${selectedCustomer.billing_email})` : "—"} • Lane: {envLabel}
          </div>
        </div>
      </OsModal>

      <OsModal
        open={updateSubOpen}
        title="Update subscription"
        confirmText="Update"
        busy={busy}
        onClose={() => setUpdateSubOpen(false)}
        onConfirm={updateSubscription}
      >
        <div className="space-y-3">
          <div className="text-xs text-white/55">New plan key *</div>
          <input
            placeholder="new plan_key"
            value={planKey}
            onChange={(e) => setPlanKey(e.target.value)}
            className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/90 outline-none"
          />
          <div className="text-xs text-white/55">Reason *</div>
          <input
            placeholder="reason (required, audited)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/90 outline-none"
          />
          <div className="text-xs text-white/45">
            subscription_id: <span className="font-mono">{shortUUID(selectedSub?.id)}</span>
          </div>
        </div>
      </OsModal>

      <OsModal
        open={endSubOpen}
        title="End subscription"
        confirmText="End"
        danger
        busy={busy}
        onClose={() => setEndSubOpen(false)}
        onConfirm={endSubscription}
      >
        <div className="space-y-3">
          <div className="text-xs text-white/55">Reason *</div>
          <input
            placeholder="reason (required, audited)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/90 outline-none"
          />
          <div className="text-xs text-white/45">
            subscription_id: <span className="font-mono">{shortUUID(selectedSub?.id)}</span>
          </div>
        </div>
      </OsModal>

      <OsModal
        open={attachOpen}
        title="Attach external billing document (PDF)"
        confirmText="Attach"
        busy={busy}
        onClose={() => setAttachOpen(false)}
        onConfirm={attachExternalDocument}
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-white/55">Document type *</div>
              <select
                value={attachDocumentType}
                onChange={(e) => setAttachDocumentType(e.target.value)}
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/90 outline-none"
              >
                <option value="invoice">invoice</option>
                <option value="receipt">receipt</option>
                <option value="credit_note">credit_note</option>
                <option value="statement">statement</option>
                <option value="contract">contract</option>
                <option value="other">other</option>
              </select>
            </div>
            <div>
              <div className="text-xs text-white/55">Source *</div>
              <select
                value={attachSource}
                onChange={(e) => setAttachSource(e.target.value)}
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/90 outline-none"
              >
                <option value="manual">manual</option>
                <option value="contract">contract</option>
                <option value="legacy">legacy</option>
                <option value="wire">wire</option>
                <option value="other">other</option>
              </select>
            </div>
          </div>

          <div>
            <div className="text-xs text-white/55">Period (optional)</div>
            <input
              value={attachPeriod}
              onChange={(e) => setAttachPeriod(e.target.value)}
              className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/90 outline-none"
              placeholder="e.g., 2026-02"
            />
          </div>

          <div>
            <div className="text-xs text-white/55">Reason *</div>
            <input
              value={attachReason}
              onChange={(e) => setAttachReason(e.target.value)}
              className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/90 outline-none"
              placeholder="required (audited)"
            />
          </div>

          <div>
            <div className="text-xs text-white/55">PDF file *</div>
            <input
              ref={attachInputRef}
              type="file"
              accept="application/pdf"
              onChange={(e) => setAttachFile(e.target.files?.[0] ?? null)}
              className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/80 outline-none"
            />
            <div className="mt-1 text-xs text-white/45">
              Selected: {attachFile ? `${attachFile.name} (${Math.round(attachFile.size / 1024)} KB)` : "—"}
            </div>
          </div>

          <div className="text-xs text-white/45">
            Provider: <span className="font-mono">{shortUUID(providerEntityId)}</span> • Customer:{" "}
            {selectedCustomer ? selectedCustomer.legal_name : "—"} • Lane: {envLabel}
          </div>
        </div>
      </OsModal>

      <OsModal
        open={certifyOpen}
        title="Certify billing document"
        confirmText="Certify"
        busy={busy}
        onClose={() => setCertifyOpen(false)}
        onConfirm={async () => {
          if (!selectedDoc) return alert("No document selected");
          await certifyDocument(selectedDoc);
          setCertifyOpen(false);
          setCertifyForce(false);
        }}
      >
        <div className="space-y-3">
          <div className="text-xs text-white/70">
            This stamps a registry-grade certification page and writes:
            <div className="mt-1 text-white/45">
              certified_at • certified_storage_bucket/path • certified_file_hash • verify_url
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs text-white/70">
            <input
              type="checkbox"
              checked={certifyForce}
              onChange={(e) => setCertifyForce(e.target.checked)}
            />
            Force (overwrite certified PDF path if exists)
          </label>
          <div className="text-xs text-white/45">
            document_id: <span className="font-mono">{shortUUID(selectedDoc?.id)}</span>
          </div>
        </div>
      </OsModal>
    </div>
  );
}
