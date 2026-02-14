// src/app/(console-ledger)/ci-onboarding/ci-billing/page.tsx
"use client";
export const dynamic = "force-dynamic";

/**
 * CI • Billing — OPERATOR CONSOLE (PRODUCTION — LOCKED)
 *
 * ✅ Registry-grade billing console (NO enforcement, NO payments)
 * ✅ Authority via Supabase Edge Functions (preferred)
 * ✅ NO Next.js API routes
 * ✅ Lane-safe (SANDBOX / RoT) — MUST NOT CONTAMINATE
 * ✅ Provider = active OS entity (issuer)
 * ✅ Customers are first-class (provider_entity_id + is_test scoped)
 * ✅ Subscription lifecycle (create / update / end)
 * ✅ Document registry:
 *    - Generate PDF (billing-generate-document) ✅
 *    - Attach external PDF (billing-attach-external-document)
 * ✅ Certification (billing-certify-document)
 * ✅ Resolver-backed Open PDF (resolve-billing-document)
 * ✅ Discovery export ZIP (export-billing-discovery-package)
 * ✅ AXIOM advisory snapshot (axiom-billing-snapshot)
 *
 * 🚫 NO REGRESSION ALLOWED
 *
 * PATCH (UI-ONLY IMPROVEMENT — NO WIRING REGRESSION):
 * ✅ Add “Generate Document” flow (billing-generate-document)
 * ✅ Load billing_documents robustly across schema variants:
 *    - some schemas use entity_id, others use provider_entity_id
 * ✅ Customer create prefers Edge Function if present; safe fallback to direct insert (non-breaking)
 *
 * PATCH (EMAIL DELIVERY — UI-FIRST, NO BACKEND BREAKAGE):
 * ✅ Adds Delivery → “Send Email” operator panel + modal
 * ✅ Prefers Edge Function if present: billing-send-document-email (optional)
 * ✅ Safe fallback: mailto: (no regression if Edge function not deployed)
 * ✅ Uses resolver to obtain signed PDF URL (server-side) when available
 *
 * PATCH (RESOLVER NO-REGRESSION ALIGNMENT):
 * ✅ mailto encoding fixed (do NOT encode the recipient in the mailto: scheme)
 * ✅ “Silent invoke” helper to avoid refresh/note spam when resolving PDF inside email compose
 * ✅ Delivery events load is lane+entity scoped when columns exist; safe fallback if columns missing
 *
 * PATCH (RESOLVER AUTHORITY — CERTIFIED):
 * ✅ Open Certified PDF now uses resolve-billing-document (NO client-side storage signing)
 * ✅ Email resolver prefers certified PDF when available
 *
 * PATCH (BILLING-GENERATE-DOCUMENT SCHEMA ALIGNMENT — NO REGRESSION):
 * ✅ Send entity_id (issuer) in addition to provider_entity_id
 *    (some deployments expect entity_id as canonical issuer field)
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
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    s,
  );
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

function isMissingColumnErr(e: any, col: string) {
  const msg = (e?.message || e?.toString?.() || "").toLowerCase();
  return msg.includes("column") && msg.includes(col.toLowerCase()) && msg.includes("does not exist");
}

function fromMoneyMinor(nMinor: number | null | undefined) {
  const n = Number.isFinite(Number(nMinor)) ? Number(nMinor) : 0;
  return (n / 100).toFixed(2);
}

function isoNowLocalDate() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
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

  // schema variants:
  entity_id?: string;
  provider_entity_id?: string;

  is_test: boolean;

  subscription_id?: string | null;
  document_type: string;
  status?: string;
  document_number?: string | null;
  invoice_number?: string | null;

  external_reference?: string | null;

  period_start?: string | null;
  period_end?: string | null;
  issued_at?: string | null;
  due_at?: string | null;
  voided_at?: string | null;

  currency?: string | null;

  amount_cents?: number | null;
  total_cents?: number | null;
  subtotal_amount?: number | null;
  tax_amount?: number | null;
  total_amount?: number | null;

  storage_bucket?: string | null;
  storage_path?: string | null;
  file_hash: string;
  content_type?: string | null;
  mime_type?: string | null;

  file_size_bytes?: number | null;

  line_items?: any;
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

  // legacy/schema drift tolerances (do not depend on)
  title?: string | null;
  document_kind?: string | null;
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
      <div className="absolute left-1/2 top-1/2 w-[94vw] max-w-[720px] -translate-x-1/2 -translate-y-1/2">
        <div className="rounded-3xl border border-white/12 bg-[#070A12]/90 shadow-[0_30px_80px_rgba(0,0,0,.55)]">
          <div className="border-b border-white/10 p-4 text-lg font-semibold text-white/90">
            {title}
          </div>
          <div className="space-y-3 p-4">{children}</div>
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
  const [generateOpen, setGenerateOpen] = useState(false);
  const [certifyOpen, setCertifyOpen] = useState(false);

  // EMAIL DELIVERY (UI)
  const [sendEmailOpen, setSendEmailOpen] = useState(false);
  const [emailTo, setEmailTo] = useState("");
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [emailIncludePdfLink, setEmailIncludePdfLink] = useState(true);
  const [emailExpiresMins, setEmailExpiresMins] = useState(60 * 24 * 3); // 3 days
  const [lastEmailPreview, setLastEmailPreview] = useState<{
    to: string;
    subject: string;
    body: string;
    pdf_url?: string | null;
    verify_url?: string | null;
  } | null>(null);

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

  // Generate document form (billing-generate-document)
  const [genDocType, setGenDocType] = useState<
    "invoice" | "contract" | "statement" | "receipt" | "credit_note" | "other"
  >("invoice");
  const [genTitle, setGenTitle] = useState("");
  const [genInvoiceNumber, setGenInvoiceNumber] = useState("");
  const [genCurrency, setGenCurrency] = useState("USD");
  const [genIssuedAt, setGenIssuedAt] = useState(isoNowLocalDate()); // yyyy-mm-dd
  const [genDueAt, setGenDueAt] = useState("");
  const [genPeriodStart, setGenPeriodStart] = useState("");
  const [genPeriodEnd, setGenPeriodEnd] = useState("");
  const [genNotes, setGenNotes] = useState("");
  const [genReason, setGenReason] = useState("");
  const [genRecipientName, setGenRecipientName] = useState("");
  const [genRecipientEmail, setGenRecipientEmail] = useState("");
  const [genLI1Desc, setGenLI1Desc] = useState("Service");
  const [genLI1Qty, setGenLI1Qty] = useState("1");
  const [genLI1Unit, setGenLI1Unit] = useState("0.00");
  const [genLI2Desc, setGenLI2Desc] = useState("");
  const [genLI2Qty, setGenLI2Qty] = useState("1");
  const [genLI2Unit, setGenLI2Unit] = useState("0.00");

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
    // Badge visible when there is any active non-internal subscription in the lane.
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
  }, [
    filteredCustomers.length,
    subsForCustomer.length,
    docsForCustomer.length,
    deliveryForCustomer.length,
    docsForCustomer,
  ]);

  const activeSub = useMemo(() => {
    const list = subsForCustomer;
    return list.find((s) => (s.status || "").toLowerCase() === "active") || null;
  }, [subsForCustomer]);

  const selectedPlan = useMemo(() => {
    const key = (planKey || "").trim();
    if (!key) return null;
    return plans.find((p) => p.code === key) || null;
  }, [planKey, plans]);

  const selectedSubPlan = useMemo(() => {
    const subKey = (selectedSub?.plan_key || "").trim();
    if (subKey) return plans.find((p) => p.code === subKey) || null;
    return plans.find((p) => p.id === selectedSub?.plan_id) || null;
  }, [selectedSub, plans]);

  const selectablePlans = useMemo(() => {
    const list = [...plans];
    list.sort((a, b) => {
      const ai = a.is_active ? 0 : 1;
      const bi = b.is_active ? 0 : 1;
      if (ai !== bi) return ai - bi;
      return (a.code || "").localeCompare(b.code || "");
    });
    return list;
  }, [plans]);

  /* ===================== core: Edge invoke helpers ===================== */

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

  // Silent invoke: no note spam, no refresh spam (used for resolver inside compose flows)
  async function invokeSilent(fn: string, body: any) {
    const { data, error } = await supabase.functions.invoke(fn, { body });
    if (error) throw error;
    return data;
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
      const { data: c } = await supabase
        .from("billing_customers")
        .select("*")
        .eq("provider_entity_id", providerEntityId)
        .eq("is_test", isTest)
        .order("created_at", { ascending: false });

      const rows = (c || []) as CustomerRow[];
      setCustomers(rows);

      if (!selectedCustomerId && rows[0]?.id) {
        setSelectedCustomerId(rows[0].id);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerEntityId, isTest, refreshKey]);

  useEffect(() => {
    (async () => {
      const { data: p } = await supabase.from("billing_plans").select("*").order("created_at", { ascending: false });
      setPlans((p || []) as PlanRow[]);
    })();
  }, [refreshKey]);

  useEffect(() => {
    if (!providerEntityId) return;
    (async () => {
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
      // Robust: try entity_id first, fallback to provider_entity_id if schema differs
      try {
        const { data: d, error } = await supabase
          .from("billing_documents")
          .select("*")
          .eq("entity_id", providerEntityId)
          .eq("is_test", isTest)
          .order("created_at", { ascending: false });

        if (error) throw error;

        const rows = (d || []) as DocRow[];
        setDocs(rows);
        setSelectedDoc(rows[0] ?? null);
      } catch (e: any) {
        if (isMissingColumnErr(e, "entity_id")) {
          const { data: d2, error: e2 } = await supabase
            .from("billing_documents")
            .select("*")
            .eq("provider_entity_id", providerEntityId)
            .eq("is_test", isTest)
            .order("created_at", { ascending: false });

          if (e2) {
            setDocs([]);
            setSelectedDoc(null);
            return;
          }

          const rows2 = (d2 || []) as DocRow[];
          setDocs(rows2);
          setSelectedDoc(rows2[0] ?? null);
        } else {
          setDocs([]);
          setSelectedDoc(null);
        }
      }
    })();
  }, [providerEntityId, isTest, refreshKey]);

  useEffect(() => {
    if (!providerEntityId) return;
    (async () => {
      // Prefer DB-side filtering if columns exist; fallback to client filter if not.
      try {
        const { data: e, error } = await supabase
          .from("billing_delivery_events")
          .select("*")
          .eq("entity_id", providerEntityId)
          .eq("is_test", isTest)
          .order("created_at", { ascending: false })
          .limit(200);

        if (error) throw error;

        const rows = (e || []) as DeliveryRow[];
        setDelivery(rows);
        setSelectedDelivery(rows[0] ?? null);
      } catch {
        // fallback: schema drift tolerant
        const { data: e2 } = await supabase.from("billing_delivery_events").select("*").order("created_at", {
          ascending: false,
        }).limit(200);

        const rows2 = (e2 || []) as DeliveryRow[];

        const filtered = rows2.filter((r) => {
          const sameLane = (r.is_test ?? null) === null ? true : Boolean(r.is_test) === isTest;
          const sameEntity = (r.entity_id ?? null) === null ? true : r.entity_id === providerEntityId;
          return sameLane && sameEntity;
        });

        setDelivery(filtered);
        setSelectedDelivery(filtered[0] ?? null);
      }
    })();
  }, [providerEntityId, isTest, refreshKey]);

  /* ===================== authority actions ===================== */

  async function runAxiom() {
    if (!providerEntityId) return alert("Missing provider entity_id");
    await invoke("axiom-billing-snapshot", { entity_id: providerEntityId, is_test: isTest });
  }

  async function openPdfViaResolver(doc: DocRow) {
    const data = await invoke("resolve-billing-document", {
      hash: doc.file_hash,
      document_id: doc.id,
      is_test: isTest,
      entity_id: providerEntityId,
      trigger: "ci_billing_open_pdf",
    });
    if (data?.urls?.pdf) window.open(data.urls.pdf, "_blank", "noopener,noreferrer");
  }

  // ✅ NO CLIENT-SIDE STORAGE SIGNING (resolver is authority)
  async function openCertifiedPdfViaResolver(doc: DocRow) {
    const data = await invoke("resolve-billing-document", {
      hash: doc.file_hash,
      document_id: doc.id,
      is_test: isTest,
      entity_id: providerEntityId,
      prefer_certified: true,
      trigger: "ci_billing_open_certified_pdf",
    });
    if (data?.urls?.pdf) window.open(data.urls.pdf, "_blank", "noopener,noreferrer");
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
    const data = await invoke("billing-certify-document", {
      billing_document_id: doc.id,
      force: certifyForce,
      trigger: "ci_billing_certify",
    });
    if (data?.verify_url) setNote("Certified. Verify URL ready.");
  }

  /* ===================== EMAIL DELIVERY (UI-FIRST) ===================== */

  function buildVerifyBillingUrl(fileHash: string) {
    const base = `${window.location.origin}/verify-billing.html`;
    return `${base}?hash=${encodeURIComponent(fileHash)}`;
  }

  function openSendEmail(doc?: DocRow | null) {
    const d = doc ?? selectedDoc;
    if (d) setSelectedDoc(d);

    const to = (selectedCustomer?.billing_email || (d as any)?.recipient_email || "").toString().trim();
    setEmailTo(to);

    const kind = safeStr((d as any)?.document_type || (d as any)?.document_kind || "billing");
    const inv = ((d as any)?.invoice_number || (d as any)?.document_number || "").toString().trim();
    const subj = inv ? `Oasis Billing — ${kind} • ${inv}` : `Oasis Billing — ${kind}`;
    setEmailSubject(subj);

    const verifyUrl = d?.file_hash ? buildVerifyBillingUrl(d.file_hash) : "";
    const body =
      `Hello,\n\n` +
      `Attached / linked is your Oasis billing document.\n\n` +
      (verifyUrl ? `Verify (hash-first): ${verifyUrl}\n\n` : "") +
      `Regards,\nOasis Digital Parliament`;
    setEmailBody(body);

    setLastEmailPreview(null);
    setSendEmailOpen(true);
  }

  async function sendEmailNow() {
    if (!providerEntityId) return alert("Missing provider entity_id");
    if (!selectedDoc) return alert("No document selected");
    const to = emailTo.trim();
    if (!to) return alert("Recipient email required");
    if (!emailSubject.trim()) return alert("Subject required");

    setBusy(true);
    setNote(null);
    try {
      // Step 1: Get a server-signed PDF URL (preferred) via resolver
      let pdfUrl: string | null = null;
      const verifyUrl = buildVerifyBillingUrl(selectedDoc.file_hash);

      try {
        if (emailIncludePdfLink) {
          const expiresInSeconds =
            Math.max(5, Math.min(60 * 24 * 14, Number(emailExpiresMins || 0))) * 60; // secs

          // Silent to avoid note/refresh spam during compose
          const resolved = await invokeSilent("resolve-billing-document", {
            hash: selectedDoc.file_hash,
            document_id: selectedDoc.id,
            is_test: isTest,
            entity_id: providerEntityId,
            expires_in: expiresInSeconds,
            prefer_certified: true,
            trigger: "ci_billing_email_resolve_pdf",
          });

          pdfUrl = resolved?.urls?.pdf || null;
        }
      } catch {
        // non-blocking: still can mailto fallback
      }

      const composedBody =
        emailBody +
        (emailIncludePdfLink && pdfUrl ? `\n\nPDF (signed link): ${pdfUrl}` : "") +
        (verifyUrl ? `\n\nVerify (hash-first): ${verifyUrl}` : "");

      setLastEmailPreview({
        to,
        subject: emailSubject.trim(),
        body: composedBody,
        pdf_url: pdfUrl,
        verify_url: verifyUrl,
      });

      // Step 2: Prefer Edge function if present (optional)
      try {
        const data = await invokeSilent("billing-send-document-email", {
          provider_entity_id: providerEntityId,
          is_test: isTest,
          customer_id: selectedCustomerId,
          document_id: selectedDoc.id,
          file_hash: selectedDoc.file_hash,
          to,
          subject: emailSubject.trim(),
          body: composedBody,
          pdf_url: pdfUrl,
          verify_url: verifyUrl,
          trigger: "ci_billing_send_email",
        });

        if (data?.ok === true || data?.status === "sent") {
          setNote("Email sent (Edge).");
          setSendEmailOpen(false);
          setRefreshKey((n) => n + 1);
          return;
        }

        throw new Error("Email function did not confirm sent.");
      } catch {
        // Step 3: mailto fallback (always available)
        const u = new URL(`mailto:${to}`); // IMPORTANT: do not encode the address in the scheme
        u.searchParams.set("subject", emailSubject.trim());
        u.searchParams.set("body", composedBody);
        window.location.href = u.toString();
        setNote("Opened mail composer (mailto fallback).");
        setSendEmailOpen(false);
        return;
      }
    } catch (e: any) {
      const msg = e?.message || "Send email failed";
      setNote(msg);
      alert(msg);
    } finally {
      setBusy(false);
    }
  }

  /* ===================== mutations (Edge) ===================== */

  async function createCustomer() {
    if (!providerEntityId) return alert("Missing provider entity_id");
    if (!custLegalName.trim()) return alert("legal_name required");
    if (!custBillingEmail.trim()) return alert("billing_email required");

    setBusy(true);
    setNote(null);
    try {
      // Prefer Edge Function if deployed (no regression if it isn't)
      try {
        const data = await invokeSilent("billing-create-customer", {
          provider_entity_id: providerEntityId,
          is_test: isTest,
          legal_name: custLegalName.trim(),
          billing_email: custBillingEmail.trim(),
          contact_name: custContactName.trim() || null,
          phone: custPhone.trim() || null,
          status: custStatus.trim() || "active",
          reason: "create customer (ci-billing)",
          trigger: "ci_billing_create_customer",
        });

        const newId = data?.customer_id || data?.id || null;
        if (newId) setSelectedCustomerId(String(newId));
        setNewCustomerOpen(false);

        setCustLegalName("");
        setCustBillingEmail("");
        setCustContactName("");
        setCustPhone("");
        setCustStatus("active");

        setNote("Customer created.");
        setRefreshKey((n) => n + 1);
        return;
      } catch {
        // fallback below
      }

      // Fallback (non-breaking): direct insert, still provider+lane safe
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
      const msg = e?.message || "Create customer failed";
      setNote(msg);
      alert(msg);
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
      code: planKey.trim(),
      plan: planKey.trim(),
      planKey: planKey.trim(),
      is_test: isTest,
      reason: reason.trim(),
      customer_id: selectedCustomerId,
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
      next_plan: planKey.trim(),
      plan_key: planKey.trim(),
      code: planKey.trim(),
      plan: planKey.trim(),
      planKey: planKey.trim(),
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
      customer_id: selectedCustomerId,
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

  // Generate billing document
  async function generateBillingDocument() {
    if (!providerEntityId) return alert("Missing provider entity_id");
    if (!genReason.trim()) return alert("reason required");

    const qty1 = Math.max(0, Number(genLI1Qty || "1") || 1);
    const unit1 = Math.max(0, Number(genLI1Unit || "0") || 0);

    const li: any[] = [
      { description: (genLI1Desc || "Service").trim(), quantity: qty1, unit_price: unit1 },
    ];

    const desc2 = genLI2Desc.trim();
    if (desc2) {
      const qty2 = Math.max(0, Number(genLI2Qty || "1") || 1);
      const unit2 = Math.max(0, Number(genLI2Unit || "0") || 0);
      li.push({ description: desc2, quantity: qty2, unit_price: unit2 });
    }

    const title =
      genTitle.trim() ||
      (genDocType === "invoice"
        ? "Invoice"
        : genDocType === "contract"
          ? "Contract"
          : genDocType === "statement"
            ? "Statement"
            : genDocType === "receipt"
              ? "Receipt"
              : genDocType === "credit_note"
                ? "Credit Note"
                : "Billing Document");

    const issuedIso = genIssuedAt.trim()
      ? new Date(`${genIssuedAt.trim()}T00:00:00.000Z`).toISOString()
      : new Date().toISOString();

    const dueIso = genDueAt.trim() ? new Date(`${genDueAt.trim()}T00:00:00.000Z`).toISOString() : null;

    const psIso = genPeriodStart.trim()
      ? new Date(`${genPeriodStart.trim()}T00:00:00.000Z`).toISOString()
      : null;

    const peIso = genPeriodEnd.trim()
      ? new Date(`${genPeriodEnd.trim()}T00:00:00.000Z`).toISOString()
      : null;

    const payload: any = {
      // ✅ CRITICAL: canonical issuer field (some deployments require this)
      entity_id: providerEntityId,

      // keep provider alias for backward compatibility
      provider_entity_id: providerEntityId,

      is_test: isTest,

      customer_id: selectedCustomerId ?? null,
      recipient_name: genRecipientName.trim() || selectedCustomer?.legal_name || null,
      recipient_email: genRecipientEmail.trim() || selectedCustomer?.billing_email || null,

      document_type: genDocType,

      // tolerated by some generators (safe if ignored); does NOT affect DB schema
      title,

      invoice_number: genInvoiceNumber.trim() || null,
      currency: (genCurrency || "USD").trim().toUpperCase(),
      issued_at: issuedIso,
      due_at: dueIso,

      period_start: psIso,
      period_end: peIso,

      notes: genNotes.trim() || null,
      line_items: li,

      reason: genReason.trim(),
      trigger: "ci_billing_generate_document",
    };

    const data = await invoke("billing-generate-document", payload);

    const newId = data?.document_id || null;
    const newHash = data?.file_hash || null;

    setGenerateOpen(false);

    setGenTitle("");
    setGenInvoiceNumber("");
    setGenIssuedAt(isoNowLocalDate());
    setGenDueAt("");
    setGenPeriodStart("");
    setGenPeriodEnd("");
    setGenNotes("");
    setGenReason("");
    setGenRecipientName("");
    setGenRecipientEmail("");
    setGenLI1Desc("Service");
    setGenLI1Qty("1");
    setGenLI1Unit("0.00");
    setGenLI2Desc("");
    setGenLI2Qty("1");
    setGenLI2Unit("0.00");

    if (newHash || newId) {
      try {
        const resolved = await invoke("resolve-billing-document", {
          hash: newHash,
          document_id: newId,
          is_test: isTest,
          entity_id: providerEntityId,
          trigger: "ci_billing_generate_document_open",
        });
        if (resolved?.urls?.pdf) window.open(resolved.urls.pdf, "_blank", "noopener,noreferrer");
      } catch {
        // non-blocking
      }
    }
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

  const selectedDocStatus = useMemo(() => {
    const s = (selectedDoc as any)?.status;
    if (s) return String(s);
    return "registered";
  }, [selectedDoc]);

  const selectedDocAmountText = useMemo(() => {
    if (!selectedDoc) return "—";
    const currency = (selectedDoc.currency ?? "—").toString();
    const cents = (selectedDoc as any).amount_cents ?? (selectedDoc as any).total_cents ?? null;

    if (Number.isFinite(Number(cents))) {
      return `${currency} ${fromMoneyMinor(Number(cents))}`;
    }

    const totalMajor = (selectedDoc as any).total_amount ?? (selectedDoc as any).subtotal_amount ?? null;
    if (Number.isFinite(Number(totalMajor))) {
      return `${currency} ${Number(totalMajor).toFixed(2)}`;
    }

    return currency;
  }, [selectedDoc]);

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

            <span
              className={cx(
                "rounded-full border px-3 py-1 text-[10px] font-semibold",
                isTest
                  ? "border-amber-300/20 bg-amber-400/12 text-amber-100"
                  : "border-sky-300/20 bg-sky-400/12 text-sky-100",
              )}
            >
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
          <div className="col-span-12 space-y-3 lg:col-span-3">
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
                        "w-full border-b border-white/5 px-3 py-2 text-left text-xs last:border-b-0",
                        selectedCustomerId === c.id
                          ? "bg-amber-400/10 text-white/90"
                          : "text-white/70 hover:bg-white/5",
                      )}
                    >
                      <div className="font-semibold">{c.legal_name}</div>
                      <div className="text-white/45">
                        {c.billing_email} • {shortUUID(c.id)}
                      </div>
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
            <div className="space-y-2 rounded-2xl border border-white/10 bg-black/20 p-3">
              <button
                disabled={!providerEntityId || busy}
                onClick={() => {
                  setPlanKey("");
                  setReason("");
                  setCreateSubOpen(true);
                }}
                className="w-full rounded-xl border border-emerald-300/20 bg-emerald-400/12 px-3 py-2 text-xs text-emerald-100 hover:bg-emerald-400/18 disabled:opacity-60"
              >
                Create Subscription
              </button>
              <button
                disabled={!selectedSub || busy}
                onClick={() => {
                  setPlanKey((selectedSub?.plan_key || "").trim());
                  setReason("");
                  setUpdateSubOpen(true);
                }}
                className="w-full rounded-xl border border-amber-300/20 bg-amber-400/12 px-3 py-2 text-xs text-amber-100 hover:bg-amber-400/18 disabled:opacity-60"
              >
                Update Subscription
              </button>
              <button
                disabled={!selectedSub || busy}
                onClick={() => {
                  setReason("");
                  setEndSubOpen(true);
                }}
                className="w-full rounded-xl border border-rose-300/20 bg-rose-500/12 px-3 py-2 text-xs text-rose-100 hover:bg-rose-500/18 disabled:opacity-60"
              >
                End Subscription
              </button>

              <div className="h-px bg-white/10" />

              <button
                disabled={!providerEntityId || busy}
                onClick={() => {
                  setGenRecipientName(selectedCustomer?.legal_name || "");
                  setGenRecipientEmail(selectedCustomer?.billing_email || "");
                  setGenReason("");
                  setGenerateOpen(true);
                }}
                className="w-full rounded-xl border border-amber-300/20 bg-amber-400/12 px-3 py-2 text-xs font-semibold text-amber-100 hover:bg-amber-400/18 disabled:opacity-60"
              >
                Generate Document (PDF)
              </button>

              <button
                disabled={!providerEntityId || busy}
                onClick={() => setAttachOpen(true)}
                className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 disabled:opacity-60"
              >
                Attach External Document (PDF)
              </button>

              <button
                disabled={busy || !selectedDoc || !selectedCustomer?.billing_email}
                onClick={() => openSendEmail(selectedDoc)}
                className="w-full rounded-xl border border-amber-300/20 bg-amber-400/12 px-3 py-2 text-xs font-semibold text-amber-100 hover:bg-amber-400/18 disabled:opacity-60"
                title={
                  !selectedDoc
                    ? "Select a document first"
                    : !selectedCustomer?.billing_email
                      ? "Select a customer with an email"
                      : ""
                }
              >
                Send Email (Delivery)
              </button>
            </div>
          </div>

          {/* MIDDLE LIST */}
          <div className="col-span-12 space-y-2 lg:col-span-5">
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
                        ? `${safeStr(r.document_type || r.document_kind)} • ${safeStr(r.status || "registered")}`
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
          <div className="col-span-12 space-y-3 lg:col-span-4">
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
                  <div className="col-span-2 rounded-xl border border-white/10 bg-black/10 p-3">
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
                      selectedSub.is_test
                        ? "border-amber-300/20 bg-amber-400/12 text-amber-100"
                        : "border-sky-300/20 bg-sky-400/12 text-sky-100",
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
                  <div className="col-span-2 rounded-xl border border-white/10 bg-black/10 p-3">
                    <div className="text-[10px] uppercase tracking-[0.22em] text-white/40">Provider IDs</div>
                    <div className="mt-1">
                      customer: {safeStr(selectedSub.provider_customer_id)} • sub:{" "}
                      {safeStr(selectedSub.provider_subscription_id)}
                    </div>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    disabled={busy}
                    onClick={() => {
                      setPlanKey((selectedSub?.plan_key || "").trim());
                      setReason("");
                      setUpdateSubOpen(true);
                    }}
                    className="rounded-full border border-amber-300/20 bg-amber-400/12 px-3 py-1 text-xs font-semibold text-amber-100 hover:bg-amber-400/18 disabled:opacity-60"
                  >
                    Change Plan
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => {
                      setReason("");
                      setEndSubOpen(true);
                    }}
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
                        {safeStr((selectedDoc as any).document_type || (selectedDoc as any).document_kind)} •{" "}
                        {safeStr(selectedDocStatus)}
                      </div>
                      <div className="mt-1 text-xs text-white/55">
                        doc_id: {shortUUID(selectedDoc.id)} • issued:{" "}
                        {fmtISO((selectedDoc as any).issued_at || null)}
                      </div>
                    </div>
                    <span
                      className={cx(
                        "rounded-full border px-2 py-[2px] text-[10px] font-semibold",
                        selectedDoc.is_test
                          ? "border-amber-300/20 bg-amber-400/12 text-amber-100"
                          : "border-sky-300/20 bg-sky-400/12 text-sky-100",
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
                        <button
                          disabled={busy || !selectedCustomer?.billing_email}
                          onClick={() => openSendEmail(selectedDoc)}
                          className="rounded-full border border-amber-300/20 bg-amber-400/12 px-3 py-1 text-xs font-semibold text-amber-100 hover:bg-amber-400/18 disabled:opacity-60"
                        >
                          Send Email
                        </button>
                      </div>
                    </div>

                    <div className="rounded-xl border border-white/10 bg-black/10 p-3">
                      <div className="text-[10px] uppercase tracking-[0.22em] text-white/40">Recipient</div>
                      <div className="mt-1">
                        {safeStr((selectedDoc as any).recipient_name)} • {safeStr((selectedDoc as any).recipient_email)}
                      </div>
                    </div>

                    <div className="rounded-xl border border-white/10 bg-black/10 p-3">
                      <div className="text-[10px] uppercase tracking-[0.22em] text-white/40">Amount</div>
                      <div className="mt-1">{selectedDocAmountText}</div>
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
                          disabled={busy || !selectedDoc.certified_at}
                          onClick={() => openCertifiedPdfViaResolver(selectedDoc)}
                          className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/80 hover:bg-white/10 disabled:opacity-60"
                          title={!selectedDoc.certified_at ? "Not certified yet" : "Open certified PDF via resolver"}
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
            {tab === "DELIVERY" && (
              <>
                <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold text-white/90">Send Email</div>
                      <div className="mt-1 text-xs text-white/55">
                        Operator-only. Prefers Edge email function if present, otherwise opens your mail client.
                      </div>
                    </div>
                    <span
                      className={cx(
                        "rounded-full border px-2 py-[2px] text-[10px] font-semibold",
                        isTest
                          ? "border-amber-300/20 bg-amber-400/12 text-amber-100"
                          : "border-sky-300/20 bg-sky-400/12 text-sky-100",
                      )}
                    >
                      {envLabel}
                    </span>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-white/70">
                    <div className="col-span-2 rounded-xl border border-white/10 bg-black/10 p-3">
                      <div className="text-[10px] uppercase tracking-[0.22em] text-white/40">Recipient</div>
                      <div className="mt-1">{safeStr(selectedCustomer?.billing_email)}</div>
                    </div>
                    <div className="rounded-xl border border-white/10 bg-black/10 p-3">
                      <div className="text-[10px] uppercase tracking-[0.22em] text-white/40">Selected doc</div>
                      <div className="mt-1">{selectedDoc ? shortUUID(selectedDoc.id) : "—"}</div>
                    </div>
                    <div className="rounded-xl border border-white/10 bg-black/10 p-3">
                      <div className="text-[10px] uppercase tracking-[0.22em] text-white/40">Hash</div>
                      <div className="mt-1 font-mono">{selectedDoc ? `${selectedDoc.file_hash.slice(0, 10)}…` : "—"}</div>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      disabled={busy || !selectedDoc || !selectedCustomer?.billing_email}
                      onClick={() => openSendEmail(selectedDoc)}
                      className="rounded-full border border-amber-300/20 bg-amber-400/12 px-3 py-2 text-xs font-semibold text-amber-100 hover:bg-amber-400/18 disabled:opacity-60"
                    >
                      Compose / Send
                    </button>
                    <button
                      disabled={busy || !selectedDoc}
                      onClick={() => setTab("DOCUMENTS")}
                      className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10 disabled:opacity-60"
                    >
                      Go to Documents
                    </button>
                  </div>

                  {lastEmailPreview && (
                    <div className="mt-3 rounded-xl border border-white/10 bg-black/10 p-3 text-xs text-white/70">
                      <div className="text-[10px] uppercase tracking-[0.22em] text-white/40">Last composed</div>
                      <div className="mt-2">
                        <div>
                          <span className="text-white/45">To:</span> {lastEmailPreview.to}
                        </div>
                        <div>
                          <span className="text-white/45">Subject:</span> {lastEmailPreview.subject}
                        </div>
                        {lastEmailPreview.pdf_url ? (
                          <div className="mt-1 break-all">
                            <span className="text-white/45">PDF:</span> {lastEmailPreview.pdf_url}
                          </div>
                        ) : null}
                        {lastEmailPreview.verify_url ? (
                          <div className="mt-1 break-all">
                            <span className="text-white/45">Verify:</span> {lastEmailPreview.verify_url}
                          </div>
                        ) : null}
                      </div>
                      <div className="mt-2 flex gap-2">
                        <button
                          onClick={async () => {
                            await copyToClipboard(JSON.stringify(lastEmailPreview, null, 2));
                            setNote("Email preview copied");
                          }}
                          className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/80 hover:bg-white/10"
                        >
                          Copy Preview JSON
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {selectedDelivery && (
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
              </>
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
              placeholder="e.g., Test Customer"
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
            <div className="mt-2 max-h-[140px] space-y-2 overflow-auto">
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
                      {p.name} • {p.currency} {p.price_minor} / {p.billing_period} •{" "}
                      {p.is_active ? "active" : "inactive"}
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
            Customer: {selectedCustomer ? `${selectedCustomer.legal_name} (${selectedCustomer.billing_email})` : "—"} •
            Lane: {envLabel}
          </div>
        </div>
      </OsModal>

      <OsModal
        open={updateSubOpen}
        title="Change subscription plan"
        confirmText="Apply Change"
        busy={busy}
        onClose={() => setUpdateSubOpen(false)}
        onConfirm={updateSubscription}
      >
        <div className="space-y-3">
          <div className="rounded-xl border border-white/10 bg-black/10 p-3">
            <div className="text-[10px] uppercase tracking-[0.22em] text-white/40">Current</div>
            <div className="mt-1 text-sm font-semibold text-white/90">
              {safeStr(selectedSub?.plan_key || selectedSubPlan?.code || selectedSub?.plan_id)}
            </div>
            <div className="mt-1 text-xs text-white/55">
              {selectedSubPlan
                ? `${safeStr(selectedSubPlan.name)} • ${selectedSubPlan.currency} ${selectedSubPlan.price_minor} / ${selectedSubPlan.billing_period}`
                : "Plan details not resolved (catalog may be empty)."}
            </div>
            <div className="mt-2 text-xs text-white/45">
              subscription_id: <span className="font-mono">{shortUUID(selectedSub?.id)}</span>
            </div>
          </div>

          <div>
            <div className="text-xs text-white/55">Select new plan (backend catalog) *</div>
            <select
              value={planKey}
              onChange={(e) => setPlanKey(e.target.value)}
              className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/90 outline-none"
            >
              <option value="" disabled>
                Choose a plan…
              </option>
              {selectablePlans.map((p) => (
                <option key={p.id} value={p.code}>
                  {p.code} — {p.name} ({p.is_active ? "active" : "inactive"})
                </option>
              ))}
            </select>
          </div>

          {selectedPlan && (
            <div className="rounded-xl border border-white/10 bg-black/10 p-3">
              <div className="text-[10px] uppercase tracking-[0.22em] text-white/40">Selected</div>
              <div className="mt-1 text-sm font-semibold text-white/90">{selectedPlan.code}</div>
              <div className="mt-1 text-xs text-white/55">
                {safeStr(selectedPlan.name)} • {selectedPlan.currency} {selectedPlan.price_minor} /{" "}
                {selectedPlan.billing_period}
              </div>
              {selectedPlan.description ? (
                <div className="mt-2 text-xs text-white/45">{selectedPlan.description}</div>
              ) : null}
              <div className="mt-2 text-xs text-white/45">
                plan_id: <span className="font-mono">{shortUUID(selectedPlan.id)}</span>
              </div>
            </div>
          )}

          <div className="text-xs text-white/55">Reason *</div>
          <input
            placeholder="reason (required, audited)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/90 outline-none"
          />

          <div className="text-xs text-white/45">
            Lane: {envLabel} • Registry-only (no enforcement). Backend records the change in metadata/audit.
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
        open={generateOpen}
        title="Generate billing document (PDF)"
        confirmText="Generate"
        busy={busy}
        onClose={() => setGenerateOpen(false)}
        onConfirm={generateBillingDocument}
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-white/55">Document type *</div>
              <select
                value={genDocType}
                onChange={(e) => setGenDocType(e.target.value as any)}
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
              <div className="text-xs text-white/55">Currency</div>
              <input
                value={genCurrency}
                onChange={(e) => setGenCurrency(e.target.value)}
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/90 outline-none"
                placeholder="USD"
              />
            </div>

            <div className="col-span-2">
              <div className="text-xs text-white/55">Title (optional)</div>
              <input
                value={genTitle}
                onChange={(e) => setGenTitle(e.target.value)}
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/90 outline-none"
                placeholder="Leave blank for default"
              />
            </div>

            <div>
              <div className="text-xs text-white/55">Issued date</div>
              <input
                type="date"
                value={genIssuedAt}
                onChange={(e) => setGenIssuedAt(e.target.value)}
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/90 outline-none"
              />
            </div>

            <div>
              <div className="text-xs text-white/55">Due date (optional)</div>
              <input
                type="date"
                value={genDueAt}
                onChange={(e) => setGenDueAt(e.target.value)}
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/90 outline-none"
              />
            </div>

            <div>
              <div className="text-xs text-white/55">Period start (optional)</div>
              <input
                type="date"
                value={genPeriodStart}
                onChange={(e) => setGenPeriodStart(e.target.value)}
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/90 outline-none"
              />
            </div>

            <div>
              <div className="text-xs text-white/55">Period end (optional)</div>
              <input
                type="date"
                value={genPeriodEnd}
                onChange={(e) => setGenPeriodEnd(e.target.value)}
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/90 outline-none"
              />
            </div>

            <div className="col-span-2">
              <div className="text-xs text-white/55">Invoice # (optional)</div>
              <input
                value={genInvoiceNumber}
                onChange={(e) => setGenInvoiceNumber(e.target.value)}
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/90 outline-none"
                placeholder="Optional"
              />
            </div>

            <div>
              <div className="text-xs text-white/55">Recipient name</div>
              <input
                value={genRecipientName}
                onChange={(e) => setGenRecipientName(e.target.value)}
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/90 outline-none"
                placeholder={selectedCustomer?.legal_name || "Optional"}
              />
            </div>

            <div>
              <div className="text-xs text-white/55">Recipient email</div>
              <input
                value={genRecipientEmail}
                onChange={(e) => setGenRecipientEmail(e.target.value)}
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/90 outline-none"
                placeholder={selectedCustomer?.billing_email || "Optional"}
              />
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/10 p-3">
            <div className="text-[10px] uppercase tracking-[0.22em] text-white/40">Line items</div>

            <div className="mt-2 grid grid-cols-12 gap-2">
              <div className="col-span-7">
                <div className="text-[11px] text-white/55">Description</div>
                <input
                  value={genLI1Desc}
                  onChange={(e) => setGenLI1Desc(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/90 outline-none"
                />
              </div>
              <div className="col-span-2">
                <div className="text-[11px] text-white/55">Qty</div>
                <input
                  value={genLI1Qty}
                  onChange={(e) => setGenLI1Qty(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/90 outline-none"
                />
              </div>
              <div className="col-span-3">
                <div className="text-[11px] text-white/55">Unit price</div>
                <input
                  value={genLI1Unit}
                  onChange={(e) => setGenLI1Unit(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/90 outline-none"
                  placeholder="0.00"
                />
              </div>

              <div className="col-span-7">
                <input
                  value={genLI2Desc}
                  onChange={(e) => setGenLI2Desc(e.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/70 outline-none"
                  placeholder="(optional) second line item description"
                />
              </div>
              <div className="col-span-2">
                <input
                  value={genLI2Qty}
                  onChange={(e) => setGenLI2Qty(e.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/70 outline-none"
                />
              </div>
              <div className="col-span-3">
                <input
                  value={genLI2Unit}
                  onChange={(e) => setGenLI2Unit(e.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/70 outline-none"
                  placeholder="0.00"
                />
              </div>
            </div>

            <div className="mt-2 text-xs text-white/45">
              Total is calculated by the Edge function from line items (registry-grade, audited).
            </div>
          </div>

          <div>
            <div className="text-xs text-white/55">Notes (optional)</div>
            <textarea
              value={genNotes}
              onChange={(e) => setGenNotes(e.target.value)}
              className="mt-1 w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/80 outline-none"
              rows={3}
              placeholder="Optional notes rendered into the PDF."
            />
          </div>

          <div>
            <div className="text-xs text-white/55">Reason *</div>
            <input
              value={genReason}
              onChange={(e) => setGenReason(e.target.value)}
              className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/90 outline-none"
              placeholder="required (audited)"
            />
          </div>

          <div className="text-xs text-white/45">
            Provider: <span className="font-mono">{shortUUID(providerEntityId)}</span> • Customer:{" "}
            {selectedCustomer ? selectedCustomer.legal_name : "—"} • Lane: {envLabel}
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
            <input type="checkbox" checked={certifyForce} onChange={(e) => setCertifyForce(e.target.checked)} />
            Force (overwrite certified PDF path if exists)
          </label>
          <div className="text-xs text-white/45">
            document_id: <span className="font-mono">{shortUUID(selectedDoc?.id)}</span>
          </div>
        </div>
      </OsModal>

      {/* EMAIL MODAL */}
      <OsModal
        open={sendEmailOpen}
        title="Send billing document (email)"
        confirmText="Send"
        busy={busy}
        onClose={() => setSendEmailOpen(false)}
        onConfirm={sendEmailNow}
      >
        <div className="space-y-3">
          <div className="text-xs text-white/60">
            Doc: <span className="font-mono">{shortUUID(selectedDoc?.id)}</span> • Hash:{" "}
            <span className="font-mono">{selectedDoc ? `${selectedDoc.file_hash.slice(0, 12)}…` : "—"}</span>
          </div>

          <div>
            <div className="text-xs text-white/55">To *</div>
            <input
              value={emailTo}
              onChange={(e) => setEmailTo(e.target.value)}
              className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/90 outline-none"
              placeholder="recipient@domain.com"
            />
          </div>

          <div>
            <div className="text-xs text-white/55">Subject *</div>
            <input
              value={emailSubject}
              onChange={(e) => setEmailSubject(e.target.value)}
              className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/90 outline-none"
            />
          </div>

          <div>
            <div className="text-xs text-white/55">Message</div>
            <textarea
              value={emailBody}
              onChange={(e) => setEmailBody(e.target.value)}
              className="mt-1 w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/80 outline-none"
              rows={6}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex items-center gap-2 text-xs text-white/70">
              <input
                type="checkbox"
                checked={emailIncludePdfLink}
                onChange={(e) => setEmailIncludePdfLink(e.target.checked)}
              />
              Include signed PDF link
            </label>

            <div>
              <div className="text-xs text-white/55">Link expiry (minutes)</div>
              <input
                value={String(emailExpiresMins)}
                onChange={(e) => setEmailExpiresMins(Number(e.target.value || "0"))}
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/90 outline-none"
                placeholder="4320"
              />
            </div>
          </div>

          <div className="text-xs text-white/45">
            Prefers Edge function <span className="font-mono">billing-send-document-email</span> if deployed; otherwise opens
            mail client (mailto).
          </div>
        </div>
      </OsModal>
    </div>
  );
}
