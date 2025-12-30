"use client";
export const dynamic = "force-dynamic";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";

type ForgeQueueItem = {
  ledger_id: string;
  title: string;
  ledger_status: string;
  created_at: string;

  entity_id: string;
  entity_name: string;
  entity_slug: string;

  envelope_id: string | null;
  envelope_status: string | null;

  parties_total: number | null;
  parties_signed: number | null;
  last_signed_at: string | null;
  days_since_last_signature: number | null;

  is_test?: boolean | null;
};

type StartSignatureResponse = {
  ok: boolean;
  envelope_id?: string;
  record_id?: string;
  entity_slug?: string;
  reused?: boolean;
  error?: string;
};

type SendInviteResponse = {
  ok: boolean;
  message?: string;
  error?: string;
};

type ArchiveSignedResolutionResponse = {
  ok: boolean;
  minute_book_entry_id?: string;
  governance_document_id?: string;
  already_archived?: boolean;
  error?: string;
};

type AxiomReviewResponse = {
  ok: boolean;
  record_id?: string;
  summary_id?: string | null;
  analysis_id?: string | null;
  advice_id?: string | null;
  compliance_review_id?: string | null;
  message?: string;
  error?: string;
};

type RiskLevel = "GREEN" | "AMBER" | "RED" | "IDLE";
type TabKey = "active" | "completed";
type AxiomTab = "advisory" | "summary" | "analysis" | "advice";

type AxiomLatest = {
  summary?:
    | { id: string; summary: string | null; generated_at: string | null; model: string | null }
    | null;
  analysis?:
    | { id: string; analysis: string | null; generated_at: string | null; model: string | null }
    | null;
  advice?:
    | {
        id: string;
        advice: string | null;
        recommendation: string | null;
        generated_at: string | null;
        model: string | null;
      }
    | null;
};

type PortalUrls = {
  signer_url?: string | null;
  viewer_url?: string | null;
  verify_url?: string | null;
  certificate_url?: string | null;
};

type ArchiveEvidence = {
  minute_book_entry_id: string | null;
  minute_book_title: string | null;
  minute_book_is_test: boolean | null;
  supporting_docs: Array<{
    id: string;
    doc_type: string | null;
    file_path: string | null;
    file_name: string | null;
    file_hash: string | null;
    mime_type: string | null;
    file_size: number | null;
    uploaded_at: string | null;
    signature_envelope_id: string | null;
    verified: boolean | null;
    registry_visible: boolean | null;
  }>;
  verified_document: null | {
    id: string;
    storage_bucket: string | null;
    storage_path: string | null;
    file_hash: string | null;
    verification_level: string | null;
    created_at: string | null;
  };
};

function fmt(iso: string | null | undefined) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function clamp(s: string, n: number) {
  const t = (s ?? "").trim();
  if (!t) return "";
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// Best-effort: surface Supabase Edge Function error body (helps debug 400/401/500)
async function extractFnError(err: any): Promise<string> {
  try {
    const anyErr = err as any;
    const ctx = anyErr?.context;
    const resp: Response | undefined = ctx?.response;

    if (resp && typeof resp.text === "function") {
      const t = await resp.text();
      if (t?.trim()) return t;
    }
  } catch {
    // ignore
  }
  return err?.message || "Request failed.";
}

export default function ForgeClient() {
  const { activeEntity } = useEntity();
  const { env } = useOsEnv(); // "ROT" | "SANDBOX"
  const isTest = env === "SANDBOX";

  const [tab, setTab] = useState<TabKey>("active");
  const [axiomTab, setAxiomTab] = useState<AxiomTab>("advisory");

  const [queue, setQueue] = useState<ForgeQueueItem[]>([]);
  const [loadingQueue, setLoadingQueue] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [primarySignerName, setPrimarySignerName] = useState("");
  const [primarySignerEmail, setPrimarySignerEmail] = useState("");
  const [ccEmails, setCcEmails] = useState("");

  const [isStarting, setIsStarting] = useState(false);
  const [isSendingInvite, setIsSendingInvite] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // AXIOM (sidecar-only)
  const [axiomLoading, setAxiomLoading] = useState(false);
  const [axiomError, setAxiomError] = useState<string | null>(null);
  const [axiomInfo, setAxiomInfo] = useState<string | null>(null);
  const [axiomLatest, setAxiomLatest] = useState<AxiomLatest>({});

  // Portal URLs (derived via RPC; avoids view column mismatch)
  const [portal, setPortal] = useState<PortalUrls>({});
  const [portalError, setPortalError] = useState<string | null>(null);

  // ✅ Archive Evidence (minute_book + supporting_docs + verified)
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<ArchiveEvidence>({
    minute_book_entry_id: null,
    minute_book_title: null,
    minute_book_is_test: null,
    supporting_docs: [],
    verified_document: null,
  });

  // --------------------------
  // Queue loader (entity + env scoped)
  // --------------------------
  async function fetchQueue() {
    setLoadingQueue(true);
    setError(null);
    setInfo(null);

    try {
      const selectCols = [
        "ledger_id",
        "title",
        "ledger_status",
        "created_at",
        "entity_id",
        "entity_name",
        "entity_slug",
        "envelope_id",
        "envelope_status",
        "parties_total",
        "parties_signed",
        "last_signed_at",
        "days_since_last_signature",
        "is_test",
      ].join(", ");

      const { data, error } = await supabase
        .from("v_forge_queue_latest")
        .select(selectCols)
        .eq("entity_slug", activeEntity)
        .eq("is_test", isTest)
        .order("created_at", { ascending: false });

      if (error) {
        console.error("CI-Forge queue error:", error);
        setQueue([]);
        setSelectedId(null);
        setError("Unable to load Forge queue for this entity/environment.");
        return;
      }

      const rows = ((data ?? []) as unknown as ForgeQueueItem[]) ?? [];
      setQueue(rows);
      setSelectedId(rows[0]?.ledger_id ?? null);
    } catch (err) {
      console.error("CI-Forge queue exception:", err);
      setQueue([]);
      setSelectedId(null);
      setError("Unable to load Forge queue for this entity/environment.");
    } finally {
      setLoadingQueue(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      await fetchQueue();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEntity, isTest]);

  // --------------------------
  // Tabs
  // --------------------------
  const isCompleted = (item: ForgeQueueItem) => item.envelope_status === "completed";
  const activeQueue = useMemo(() => queue.filter((q) => !isCompleted(q)), [queue]);
  const completedQueue = useMemo(() => queue.filter((q) => isCompleted(q)), [queue]);
  const visibleQueue = tab === "active" ? activeQueue : completedQueue;

  useEffect(() => {
    setSelectedId(visibleQueue[0]?.ledger_id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, activeEntity, isTest]);

  const selected = visibleQueue.find((q) => q.ledger_id === selectedId) ?? visibleQueue[0] ?? null;

  // Clear any previous portal info when switching records
  useEffect(() => {
    setPortal({});
    setPortalError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.ledger_id]);

  const envelopeLocked =
    !!selected?.envelope_status &&
    selected.envelope_status !== "cancelled" &&
    selected.envelope_status !== "expired";

  // --------------------------
  // Risk (UI only)
  // --------------------------
  const computeRiskLevel = (item: ForgeQueueItem): RiskLevel => {
    const days = item.days_since_last_signature ?? null;
    const status = item.envelope_status;

    if (!status || status === "draft" || status === "pending") {
      if (days == null) return "IDLE";
      if (days >= 7) return "RED";
      if (days >= 3) return "AMBER";
      return "GREEN";
    }

    if (status === "completed") {
      if (days != null && days >= 7) return "AMBER";
      return "GREEN";
    }

    if (status === "cancelled" || status === "expired") return "IDLE";
    return "IDLE";
  };

  const riskLightClasses = (risk: RiskLevel) => {
    switch (risk) {
      case "GREEN":
        return "bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.9)]";
      case "AMBER":
        return "bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.9)]";
      case "RED":
        return "bg-rose-500 shadow-[0_0_10px_rgba(248,113,113,0.9)]";
      default:
        return "bg-slate-500 shadow-[0_0_8px_rgba(148,163,184,0.9)]";
    }
  };

  const riskLabel = (risk: RiskLevel) => {
    if (risk === "RED") return "Dormant";
    if (risk === "AMBER") return "Delayed";
    if (risk === "GREEN") return "Healthy";
    return "Idle";
  };

  const envPill = () => (
    <span
      className={[
        "rounded-full px-2 py-1 text-[10px] font-semibold tracking-[0.18em] uppercase border",
        isTest
          ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
          : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
      ].join(" ")}
      title={isTest ? "SANDBOX (is_test=true)" : "RoT (is_test=false)"}
    >
      {isTest ? "SANDBOX" : "RoT"}
    </span>
  );

  function flashError(msg: string) {
    console.error(msg);
    setError(msg);
    setTimeout(() => setError(null), 6000);
  }

  function flashInfo(msg: string) {
    setInfo(msg);
    setTimeout(() => setInfo(null), 4500);
  }

  function flashAxiomError(msg: string) {
    console.error(msg);
    setAxiomError(msg);
    setTimeout(() => setAxiomError(null), 6500);
  }

  function flashAxiomInfo(msg: string) {
    setAxiomInfo(msg);
    setTimeout(() => setAxiomInfo(null), 5000);
  }

  async function refreshQueueKeepSelection(keepLedgerId?: string | null) {
    try {
      const selectCols = [
        "ledger_id",
        "title",
        "ledger_status",
        "created_at",
        "entity_id",
        "entity_name",
        "entity_slug",
        "envelope_id",
        "envelope_status",
        "parties_total",
        "parties_signed",
        "last_signed_at",
        "days_since_last_signature",
        "is_test",
      ].join(", ");

      const { data, error } = await supabase
        .from("v_forge_queue_latest")
        .select(selectCols)
        .eq("entity_slug", activeEntity)
        .eq("is_test", isTest)
        .order("created_at", { ascending: false });

      if (error) throw error;

      const rows = ((data ?? []) as unknown as ForgeQueueItem[]) ?? [];
      setQueue(rows);

      const nextVisible =
        tab === "active"
          ? rows.filter((r) => !isCompleted(r))
          : rows.filter((r) => isCompleted(r));

      const fallback = nextVisible[0]?.ledger_id ?? null;
      const desired =
        keepLedgerId && nextVisible.some((x) => x.ledger_id === keepLedgerId)
          ? keepLedgerId
          : fallback;

      setSelectedId(desired);
    } catch (e) {
      console.error("refreshQueue error", e);
    }
  }

  // --------------------------
  // Portal URLs (robust param name; supports old/new SQL funcs)
  // --------------------------
  async function loadPortalUrls(envelopeId: string) {
    setPortalError(null);
    setPortal({});

    try {
      const tryRpc = async (fn: string, args: any) => {
        const r = await supabase.rpc(fn as any, args as any);
        return r;
      };

      let r = await tryRpc("ci_portal_urls_rpc", { p_envelope_id: envelopeId });
      if (r.error) r = await tryRpc("ci_portal_urls_rpc", { envelope_id: envelopeId });

      if (r.error) r = await tryRpc("ci_portal_urls", { p_envelope_id: envelopeId });
      if (r.error) r = await tryRpc("ci_portal_urls", { envelope_id: envelopeId });

      if (r.error) {
        console.warn("Portal RPC error:", r.error);
        setPortalError("Portal URLs unavailable (RPC).");
        return;
      }

      const pu = (r.data as any) ?? {};
      const row = Array.isArray(pu) ? pu[0] : pu;

      setPortal({
        signer_url: row?.signer_url ?? row?.signer ?? null,
        viewer_url: row?.viewer_url ?? row?.viewer ?? null,
        verify_url: row?.verify_url ?? row?.verify ?? null,
        certificate_url: row?.certificate_url ?? row?.certificate ?? null,
      });
    } catch (e) {
      console.warn("loadPortalUrls exception:", e);
      setPortalError("Portal URLs unavailable.");
    }
  }

  useEffect(() => {
    if (!selected?.envelope_id) {
      setPortal({});
      setPortalError(null);
      return;
    }
    loadPortalUrls(selected.envelope_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.envelope_id]);

  // --------------------------
  // AXIOM: load latest artifacts (ledger tables)
  // --------------------------
  async function loadAxiomLatest(recordId: string) {
    setAxiomError(null);

    try {
      const [s, a, adv] = await Promise.all([
        supabase
          .from("ai_summaries")
          .select("id, summary, generated_at, model")
          .eq("record_id", recordId)
          .order("generated_at", { ascending: false })
          .limit(1)
          .maybeSingle(),

        supabase
          .from("ai_analyses")
          .select("id, analysis, generated_at, model")
          .eq("record_id", recordId)
          .order("generated_at", { ascending: false })
          .limit(1)
          .maybeSingle(),

        supabase
          .from("ai_advice")
          .select("id, advice, recommendation, generated_at, model")
          .eq("record_id", recordId)
          .order("generated_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      if (s.error) console.warn("AXIOM latest summary load error:", s.error);
      if (a.error) console.warn("AXIOM latest analysis load error:", a.error);
      if (adv.error) console.warn("AXIOM latest advice load error:", adv.error);

      setAxiomLatest({
        summary: (s.data as any) ?? null,
        analysis: (a.data as any) ?? null,
        advice: (adv.data as any) ?? null,
      });
    } catch (e) {
      console.error("loadAxiomLatest exception", e);
      flashAxiomError("Unable to load AXIOM artifacts.");
    }
  }

  useEffect(() => {
    if (!selected?.ledger_id) {
      setAxiomLatest({});
      return;
    }
    loadAxiomLatest(selected.ledger_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.ledger_id]);

  // --------------------------
  // ✅ Archive Evidence loader (minute book + supporting docs + verified)
  // --------------------------
  async function loadArchiveEvidence(recordId: string) {
    setEvidenceLoading(true);
    setEvidenceError(null);

    try {
      // 1) minute book entry (lane-safe)
      const mbe = await supabase
        .from("minute_book_entries")
        .select("id, title, is_test")
        .eq("source_record_id", recordId)
        .eq("is_test", isTest)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (mbe.error) {
        console.warn("minute_book_entries evidence error", mbe.error);
      }

      const minuteBookEntryId = (mbe.data as any)?.id ?? null;

      // 2) supporting docs (only if entry exists)
      let supporting_docs: ArchiveEvidence["supporting_docs"] = [];
      if (minuteBookEntryId) {
        const sd = await supabase
          .from("supporting_documents")
          .select(
            "id, doc_type, file_path, file_name, file_hash, mime_type, file_size, uploaded_at, signature_envelope_id, verified, registry_visible"
          )
          .eq("entry_id", minuteBookEntryId)
          .order("uploaded_at", { ascending: false });

        if (sd.error) {
          console.warn("supporting_documents evidence error", sd.error);
        } else {
          supporting_docs = ((sd.data ?? []) as any) ?? [];
        }
      }

      // 3) verified registry
      const vd = await supabase
        .from("verified_documents")
        .select("id, storage_bucket, storage_path, file_hash, verification_level, created_at")
        .eq("source_record_id", recordId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (vd.error) {
        console.warn("verified_documents evidence error", vd.error);
      }

      setEvidence({
        minute_book_entry_id: minuteBookEntryId,
        minute_book_title: (mbe.data as any)?.title ?? null,
        minute_book_is_test: (mbe.data as any)?.is_test ?? null,
        supporting_docs,
        verified_document: (vd.data as any) ?? null,
      });
    } catch (e) {
      console.error("loadArchiveEvidence exception", e);
      setEvidenceError("Unable to load archive evidence.");
      setEvidence({
        minute_book_entry_id: null,
        minute_book_title: null,
        minute_book_is_test: null,
        supporting_docs: [],
        verified_document: null,
      });
    } finally {
      setEvidenceLoading(false);
    }
  }

  useEffect(() => {
    if (!selected?.ledger_id) {
      setEvidence({
        minute_book_entry_id: null,
        minute_book_title: null,
        minute_book_is_test: null,
        supporting_docs: [],
        verified_document: null,
      });
      setEvidenceError(null);
      return;
    }
    loadArchiveEvidence(selected.ledger_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.ledger_id, isTest]);

  const alreadyArchived = !!evidence.minute_book_entry_id;

  // --------------------------
  // Actions (wiring preserved)
  // --------------------------
  async function onStartEnvelope(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);

    if (!selected) return;
    if (envelopeLocked) {
      flashInfo("Envelope already exists for this record.");
      return;
    }
    if (!primarySignerEmail.trim() || !primarySignerName.trim()) {
      flashError("Signer name + email are required.");
      return;
    }

    setIsStarting(true);
    try {
      const parties = [
        {
          signer_name: primarySignerName.trim(),
          signer_email: primarySignerEmail.trim(),
          role: "signer",
          signing_order: 1,
        },
      ];

      const { data, error } = await supabase.functions.invoke("start-signature", {
        body: {
          record_id: selected.ledger_id,
          entity_slug: selected.entity_slug,
          parties,
          entity_id: selected.entity_id,
          is_test: isTest,
          cc_emails: ccEmails
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
        },
      });

      if (error) {
        const msg = await extractFnError(error);
        throw new Error(msg);
      }

      const res = data as StartSignatureResponse;

      if (!res?.ok) {
        flashError(res?.error ?? "Unable to start envelope.");
        return;
      }

      flashInfo(res.reused ? "Existing envelope reused." : "Envelope started.");
      await refreshQueueKeepSelection(selected.ledger_id);
    } catch (err: any) {
      console.error("start-signature error", err);
      flashError(err?.message || "Unable to start envelope.");
    } finally {
      setIsStarting(false);
    }
  }

  async function onSendInvite() {
    setError(null);
    setInfo(null);

    if (!selected?.envelope_id) {
      flashError("No envelope found for this record.");
      return;
    }

    setIsSendingInvite(true);
    try {
      const { data, error } = await supabase.functions.invoke("send-signature-invite", {
        body: {
          envelope_id: selected.envelope_id,
          is_test: isTest,
        },
      });

      if (error) {
        const msg = await extractFnError(error);
        throw new Error(msg);
      }

      const res = data as SendInviteResponse;

      if (!res?.ok) {
        flashError(res?.error ?? "Unable to send invite.");
        return;
      }

      flashInfo(res.message ?? "Invite sent.");
      await refreshQueueKeepSelection(selected.ledger_id);
    } catch (err: any) {
      console.error("send-signature-invite error", err);
      flashError(err?.message || "Unable to send invite.");
    } finally {
      setIsSendingInvite(false);
    }
  }

  async function onArchiveSigned() {
    setError(null);
    setInfo(null);

    if (!selected?.envelope_id) {
      flashError("No envelope found for this record.");
      return;
    }
    if (!selected || selected.envelope_status !== "completed") {
      flashError("Envelope is not completed yet.");
      return;
    }

    setIsArchiving(true);
    try {
      const { data, error } = await supabase.functions.invoke("archive-signed-resolution", {
        body: {
          envelope_id: selected.envelope_id,
          is_test: isTest,
        },
      });

      if (error) {
        const msg = await extractFnError(error);
        throw new Error(msg);
      }

      const res = data as ArchiveSignedResolutionResponse;

      if (!res?.ok) {
        flashError(res?.error ?? "Unable to archive signed resolution.");
        return;
      }

      flashInfo(res.already_archived ? "Already archived." : "Archived into CI-Archive Minute Book.");
      await refreshQueueKeepSelection(selected.ledger_id);

      // ✅ refresh evidence so the user sees paths immediately
      await loadArchiveEvidence(selected.ledger_id);
    } catch (err: any) {
      console.error("archive-signed-resolution error", err);
      flashError(err?.message || "Unable to archive signed resolution.");
    } finally {
      setIsArchiving(false);
    }
  }

  // --------------------------
  // AXIOM: pre-signature review (advisory-only)
  // --------------------------
  async function onRunAxiomReview() {
    if (!selected) return;

    setAxiomError(null);
    setAxiomInfo(null);
    setAxiomLoading(true);

    try {
      const { data, error } = await supabase.functions.invoke("axiom-pre-signature-review", {
        body: {
          record_id: selected.ledger_id,
          entity_slug: selected.entity_slug,
          entity_id: selected.entity_id,
          is_test: isTest,
          envelope_id: selected.envelope_id ?? null,
          trigger: "forge-pre-signature",
        },
      });

      if (error) {
        const msg = await extractFnError(error);
        throw new Error(msg);
      }

      const res = data as AxiomReviewResponse;
      if (!res?.ok) {
        flashAxiomError(res?.error ?? "AXIOM review failed.");
        return;
      }

      flashAxiomInfo(res.message ?? "AXIOM review completed.");
      await loadAxiomLatest(selected.ledger_id);
      setAxiomTab("summary");
    } catch (e: any) {
      console.error("axiom-pre-signature-review error", e);
      flashAxiomError(e?.message || "Unable to run AXIOM review.");
    } finally {
      setAxiomLoading(false);
    }
  }

  const axiomAdvisory = useMemo(() => {
    if (!selected) {
      return {
        severity: "IDLE" as RiskLevel,
        bullets: ["Select an execution record to view intelligence."],
      };
    }

    const risk = computeRiskLevel(selected);
    const bullets: string[] = [];

    if (!selected.envelope_id) bullets.push("No envelope exists yet. Start the envelope to begin signing.");
    if (selected.envelope_id && selected.envelope_status !== "completed")
      bullets.push("Envelope is active. Monitor progress; resend invite if stalled.");
    if (selected.envelope_status === "completed")
      bullets.push("Envelope completed. Next action is Archive Now to generate archive-grade artifacts + registry entry.");

    bullets.push("AXIOM Review generates advisory intelligence (side-car).");
    bullets.push("AXIOM is advisory-only. It never blocks authority.");
    bullets.push("Signing PDF stays pristine; archive render embeds immutable AXIOM snapshot at seal-time.");

    return { severity: risk, bullets };
  }, [selected]);

  // --------------------------
  // UI Helpers
  // --------------------------
  const tabBtn = (k: TabKey, label: string, count: number) => (
    <button
      type="button"
      onClick={() => setTab(k)}
      className={[
        "rounded-full px-3 py-1.5 text-[11px] font-semibold transition border",
        tab === k
          ? "bg-slate-100 text-slate-950 border-white/20 shadow-md shadow-white/10"
          : "bg-slate-950/40 text-slate-300 border-slate-800 hover:border-slate-700 hover:text-slate-100",
      ].join(" ")}
    >
      {label} <span className="ml-1 text-[10px] opacity-70">({count})</span>
    </button>
  );

  const portalBtn = (href: string, label: string) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="flex-1 text-center rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2 text-[11px] font-semibold text-slate-200 hover:border-amber-500/40 hover:text-slate-100 transition"
    >
      {label}
    </a>
  );

  const axiomTabBtn = (k: AxiomTab, label: string) => (
    <button
      type="button"
      onClick={() => setAxiomTab(k)}
      className={[
        "rounded-full px-3 py-1.5 text-[11px] font-semibold transition border",
        axiomTab === k
          ? "bg-cyan-500/15 text-cyan-100 border-cyan-500/40"
          : "bg-slate-950/40 text-slate-300 border-slate-800 hover:border-slate-700 hover:text-slate-100",
      ].join(" ")}
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-full flex-col px-8 pt-6 pb-6">
      <div className="mb-4 shrink-0">
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs tracking-[0.3em] uppercase text-slate-500">CI-FORGE</div>
          {envPill()}
        </div>
        <h1 className="mt-1 text-lg font-semibold text-amber-300">Execution — Signature-required</h1>
        <p className="mt-1 text-[11px] text-slate-400">
          Entity-scoped via OS selector. Environment-scoped via OS env toggle (is_test). Forge is signature-only; archive artifacts are produced after completion.
        </p>
      </div>

      <div className="flex min-h-0 flex-1 justify-center overflow-hidden">
        <div className="flex h-full w-full max-w-[1400px] flex-col overflow-hidden rounded-3xl border border-slate-900 bg-black/60 px-6 py-5 shadow-[0_0_60px_rgba(15,23,42,0.9)]">
          <div className="mb-4 flex shrink-0 items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <div className="text-[11px] text-slate-400">
                Active Entity: <span className="font-semibold text-slate-100">{activeEntity}</span>{" "}
                <span className="ml-2">{envPill()}</span>
              </div>
              <div className="text-[11px] text-slate-500">
                Queue sourced from <span className="text-slate-300">v_forge_queue_latest</span>.
              </div>
            </div>

            <div className="flex items-center gap-2">
              {tabBtn("active", "Active", activeQueue.length)}
              {tabBtn("completed", "Completed", completedQueue.length)}
              <button
                type="button"
                onClick={() => refreshQueueKeepSelection(selected?.ledger_id ?? null)}
                className="rounded-full border border-slate-800 bg-slate-950/50 px-3 py-1.5 text-[11px] font-semibold text-slate-200 hover:border-slate-700 hover:text-slate-100 transition"
              >
                Refresh
              </button>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 gap-5 overflow-hidden">
            {/* Left */}
            <section className="w-[320px] shrink-0 overflow-hidden rounded-2xl border border-slate-900 bg-slate-950/40">
              <div className="border-b border-slate-900 px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
                  {tab === "active" ? "Active Execution Queue" : "Completed Envelopes"}
                </div>
                <div className="mt-1 text-[11px] text-slate-400">
                  {loadingQueue ? "Loading…" : `${visibleQueue.length} record(s)`}
                </div>
              </div>

              <div className="h-full overflow-y-auto px-2 py-2">
                {!visibleQueue.length && !loadingQueue ? (
                  <div className="px-3 py-3 text-[11px] text-slate-500">
                    Nothing here yet. When Council approves signature-required execution, it will appear in Forge.
                  </div>
                ) : null}

                {visibleQueue.map((q) => {
                  const risk = computeRiskLevel(q);
                  const selectedRow = q.ledger_id === selected?.ledger_id;

                  return (
                    <button
                      key={q.ledger_id}
                      type="button"
                      onClick={() => setSelectedId(q.ledger_id)}
                      className={[
                        "w-full text-left rounded-xl border px-3 py-2 mb-2 transition",
                        selectedRow
                          ? "border-amber-500/50 bg-amber-500/10"
                          : "border-slate-900 bg-black/30 hover:border-slate-800 hover:bg-black/40",
                      ].join(" ")}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-[12px] font-semibold text-slate-100">
                            {clamp(q.title || "Untitled", 52)}
                          </div>
                          <div className="mt-1 text-[10px] text-slate-500">
                            {q.envelope_status ? `Envelope: ${q.envelope_status}` : "No envelope yet"}
                          </div>
                        </div>

                        <div className="flex flex-col items-end gap-2">
                          <div
                            className={["h-2.5 w-2.5 rounded-full", riskLightClasses(risk)].join(" ")}
                            title={riskLabel(risk)}
                          />
                          <div className="text-[10px] text-slate-500">
                            {q.parties_signed ?? 0}/{q.parties_total ?? 0}
                          </div>
                        </div>
                      </div>

                      <div className="mt-2 flex items-center justify-between text-[10px] text-slate-500">
                        <span>{q.ledger_status}</span>
                        <span>{fmt(q.created_at)}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* Middle */}
            <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-slate-900 bg-slate-950/30">
              <div className="border-b border-slate-900 px-5 py-4">
                <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Execution</div>
                <div className="mt-1 text-sm font-semibold text-slate-100">
                  {selected ? selected.title : "No record selected"}
                </div>
                <div className="mt-1 text-[11px] text-slate-500">
                  Ledger Status: <span className="text-slate-300">{selected?.ledger_status ?? "—"}</span> • Envelope:{" "}
                  <span className="text-slate-300">{selected?.envelope_status ?? "—"}</span> • Env:{" "}
                  <span className="text-slate-300">{isTest ? "SANDBOX" : "RoT"}</span>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {!selected ? (
                  <div className="text-[11px] text-slate-500">Select a record from the queue.</div>
                ) : (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div className="rounded-2xl border border-slate-900 bg-black/30 p-4">
                        <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500 mb-2">Signer</div>

                        <div className="space-y-2">
                          <div>
                            <div className="text-[10px] text-slate-500 mb-1">Full name</div>
                            <input
                              value={primarySignerName}
                              onChange={(e) => setPrimarySignerName(e.target.value)}
                              className="w-full rounded-xl bg-slate-950/70 border border-slate-800 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500/50"
                              placeholder="Signer name"
                            />
                          </div>

                          <div>
                            <div className="text-[10px] text-slate-500 mb-1">Email</div>
                            <input
                              value={primarySignerEmail}
                              onChange={(e) => setPrimarySignerEmail(e.target.value)}
                              className="w-full rounded-xl bg-slate-950/70 border border-slate-800 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500/50"
                              placeholder="signer@email.com"
                            />
                          </div>

                          <div>
                            <div className="text-[10px] text-slate-500 mb-1">CC (comma-separated)</div>
                            <input
                              value={ccEmails}
                              onChange={(e) => setCcEmails(e.target.value)}
                              className="w-full rounded-xl bg-slate-950/70 border border-slate-800 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500/50"
                              placeholder="cc1@email.com, cc2@email.com"
                            />
                          </div>
                        </div>
                      </div>

                      <div className="rounded-2xl border border-slate-900 bg-black/30 p-4">
                        <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500 mb-2">Actions</div>

                        <div className="flex flex-col gap-2">
                          <form onSubmit={onStartEnvelope}>
                            <button
                              type="submit"
                              disabled={isStarting || envelopeLocked}
                              className={[
                                "w-full rounded-xl px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition",
                                isStarting || envelopeLocked
                                  ? "bg-emerald-500/20 text-emerald-200/60 cursor-not-allowed"
                                  : "bg-emerald-500 text-black hover:bg-emerald-400",
                              ].join(" ")}
                            >
                              {envelopeLocked ? "Envelope already created" : isStarting ? "Starting…" : "Start envelope"}
                            </button>
                          </form>

                          <button
                            type="button"
                            onClick={onSendInvite}
                            disabled={isSendingInvite || !selected.envelope_id}
                            className={[
                              "w-full rounded-xl px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition border",
                              isSendingInvite || !selected.envelope_id
                                ? "border-slate-800 bg-slate-950/30 text-slate-500 cursor-not-allowed"
                                : "border-slate-700 bg-slate-950/60 text-slate-200 hover:border-amber-500/40 hover:text-slate-100",
                            ].join(" ")}
                          >
                            {isSendingInvite ? "Sending…" : "Send invite"}
                          </button>

                          <button
                            type="button"
                            onClick={onArchiveSigned}
                            disabled={isArchiving || selected.envelope_status !== "completed"}
                            className={[
                              "w-full rounded-xl px-4 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition border",
                              isArchiving || selected.envelope_status !== "completed"
                                ? "border-slate-800 bg-slate-950/30 text-slate-500 cursor-not-allowed"
                                : "border-amber-500/60 bg-amber-500/10 text-amber-200 hover:bg-amber-500/15",
                            ].join(" ")}
                          >
                            {isArchiving ? "Archiving…" : alreadyArchived ? "Archive now (Already archived)" : "Archive now"}
                          </button>
                        </div>

                        <div className="mt-3 text-[11px] text-slate-500">
                          Forge is signature-only. Archive happens after completion and produces archive-quality PDF + hash.
                        </div>
                      </div>
                    </div>

                    {error && (
                      <div className="mt-3 text-[11px] text-red-400 bg-red-950/40 border border-red-800/60 rounded-xl px-3 py-2">
                        {error}
                      </div>
                    )}

                    {info && !error && (
                      <div className="mt-3 text-[11px] text-emerald-300 bg-emerald-950/40 border border-emerald-700/60 rounded-xl px-3 py-2">
                        {info}
                      </div>
                    )}
                  </>
                )}
              </div>

              <div className="border-t border-slate-900 px-5 py-3 text-[10px] text-slate-500 flex items-center justify-between">
                <span>CI-Forge · Oasis Digital Parliament Ledger</span>
                <span>{tab === "active" ? "Active tab" : "Completed tab"}</span>
              </div>
            </section>

            {/* Right */}
            <section className="w-[360px] shrink-0 overflow-hidden rounded-2xl border border-slate-900 bg-slate-950/35">
              <div className="border-b border-slate-900 px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">AXIOM + Portal</div>
                <div className="mt-1 text-[11px] text-slate-400">Advisory-only. Humans execute.</div>
              </div>

              <div className="h-full overflow-y-auto px-4 py-4 space-y-3">
                {/* ✅ Archive Evidence */}
                <div className="rounded-2xl border border-slate-900 bg-black/30 p-4">
                  <div className="flex items-center justify-between">
                    <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Archive Evidence</div>
                    <button
                      type="button"
                      onClick={() => (selected?.ledger_id ? loadArchiveEvidence(selected.ledger_id) : null)}
                      disabled={!selected?.ledger_id || evidenceLoading}
                      className={[
                        "rounded-full border px-3 py-1.5 text-[11px] font-semibold transition",
                        !selected?.ledger_id || evidenceLoading
                          ? "border-slate-800 bg-slate-950/30 text-slate-500 cursor-not-allowed"
                          : "border-slate-800 bg-slate-950/50 text-slate-200 hover:border-slate-700 hover:text-slate-100",
                      ].join(" ")}
                    >
                      {evidenceLoading ? "Loading…" : "Refresh"}
                    </button>
                  </div>

                  {evidenceError ? (
                    <div className="mt-3 text-[11px] text-red-400 bg-red-950/40 border border-red-800/60 rounded-xl px-3 py-2">
                      {evidenceError}
                    </div>
                  ) : null}

                  <div className="mt-3 rounded-xl border border-slate-900 bg-black/25 p-3">
                    <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Minute Book</div>
                    <div className="mt-1 text-[11px] text-slate-300">
                      Entry:{" "}
                      <span className="font-mono text-[10px] text-slate-200">
                        {evidence.minute_book_entry_id ? clamp(evidence.minute_book_entry_id, 16) : "—"}
                      </span>
                    </div>
                    <div className="mt-1 text-[10px] text-slate-500">
                      {evidence.minute_book_title ? clamp(evidence.minute_book_title, 60) : "No minute book entry detected for this lane."}
                    </div>

                    <div className="mt-3 text-[10px] uppercase tracking-[0.22em] text-slate-500">Supporting Docs</div>
                    {evidence.supporting_docs.length ? (
                      <div className="mt-2 space-y-2">
                        {evidence.supporting_docs.slice(0, 5).map((d) => (
                          <div key={d.id} className="rounded-lg border border-slate-900 bg-black/30 p-2">
                            <div className="flex items-center justify-between gap-2">
                              <div className="text-[11px] text-slate-200">{d.doc_type ?? "document"}</div>
                              <div className="text-[10px] text-slate-500">{fmt(d.uploaded_at)}</div>
                            </div>
                            <div className="mt-1 font-mono text-[10px] text-slate-400 break-all">
                              {d.file_path ?? "—"}
                            </div>
                            <div className="mt-1 text-[10px] text-slate-500">
                              Hash: <span className="font-mono">{d.file_hash ? clamp(d.file_hash, 18) : "—"}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-2 text-[10px] text-slate-500">
                        No supporting_documents found for this entry (yet). That usually means the archive function created the entry but didn’t register pointers.
                      </div>
                    )}

                    <div className="mt-3 text-[10px] uppercase tracking-[0.22em] text-slate-500">Verified Registry</div>
                    {evidence.verified_document ? (
                      <div className="mt-2 rounded-lg border border-slate-900 bg-black/30 p-2">
                        <div className="text-[11px] text-slate-200">
                          {evidence.verified_document.verification_level ?? "verified"}
                        </div>
                        <div className="mt-1 font-mono text-[10px] text-slate-400 break-all">
                          {evidence.verified_document.storage_bucket ?? "—"} · {evidence.verified_document.storage_path ?? "—"}
                        </div>
                        <div className="mt-1 text-[10px] text-slate-500">
                          Hash:{" "}
                          <span className="font-mono">
                            {evidence.verified_document.file_hash ? clamp(evidence.verified_document.file_hash, 18) : "—"}
                          </span>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-2 text-[10px] text-slate-500">
                        No verified_documents row for this record yet (this is why “seal/verify” feels missing).
                      </div>
                    )}
                  </div>

                  <div className="mt-2 text-[10px] text-slate-500">
                    This panel shows the *actual* bucket/path pointers so you don’t have to guess where SANDBOX artifacts landed.
                  </div>
                </div>

                {/* AXIOM */}
                <div className="rounded-2xl border border-slate-900 bg-black/30 p-4">
                  <div className="flex items-center justify-between">
                    <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">AXIOM</div>
                    <div className="flex items-center gap-2">
                      <div className={["h-2.5 w-2.5 rounded-full", riskLightClasses(axiomAdvisory.severity)].join(" ")} />
                      <div className="text-[10px] text-slate-400">{riskLabel(axiomAdvisory.severity)}</div>
                    </div>
                  </div>

                  <div className="mt-3 flex items-center gap-2 flex-wrap">
                    {axiomTabBtn("advisory", "Advisory")}
                    {axiomTabBtn("summary", "Summary")}
                    {axiomTabBtn("analysis", "Analysis")}
                    {axiomTabBtn("advice", "Advice")}
                  </div>

                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={onRunAxiomReview}
                      disabled={!selected || axiomLoading}
                      className={[
                        "flex-1 rounded-xl px-3 py-2 text-[11px] font-semibold tracking-[0.18em] uppercase transition border",
                        !selected || axiomLoading
                          ? "border-slate-800 bg-slate-950/30 text-slate-500 cursor-not-allowed"
                          : "border-cyan-500/50 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/15",
                      ].join(" ")}
                    >
                      {axiomLoading ? "Running…" : "Run AXIOM"}
                    </button>

                    <button
                      type="button"
                      onClick={() => (selected?.ledger_id ? loadAxiomLatest(selected.ledger_id) : null)}
                      disabled={!selected?.ledger_id || axiomLoading}
                      className={[
                        "rounded-xl px-3 py-2 text-[11px] font-semibold transition border",
                        !selected?.ledger_id || axiomLoading
                          ? "border-slate-800 bg-slate-950/30 text-slate-500 cursor-not-allowed"
                          : "border-slate-800 bg-slate-950/50 text-slate-200 hover:border-slate-700 hover:text-slate-100",
                      ].join(" ")}
                    >
                      Refresh
                    </button>
                  </div>

                  {axiomError && (
                    <div className="mt-3 text-[11px] text-red-400 bg-red-950/40 border border-red-800/60 rounded-xl px-3 py-2">
                      {axiomError}
                    </div>
                  )}

                  {axiomInfo && !axiomError && (
                    <div className="mt-3 text-[11px] text-cyan-200 bg-cyan-950/30 border border-cyan-800/50 rounded-xl px-3 py-2">
                      {axiomInfo}
                    </div>
                  )}

                  <div className="mt-3 rounded-xl border border-slate-900 bg-black/25 p-3">
                    {axiomTab === "advisory" ? (
                      <>
                        <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Advisory</div>
                        <ul className="mt-2 space-y-2 text-[11px] text-slate-300 list-disc pl-4">
                          {axiomAdvisory.bullets.map((b) => (
                            <li key={b}>{b}</li>
                          ))}
                        </ul>
                      </>
                    ) : null}

                    {axiomTab === "summary" ? (
                      <>
                        <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Latest Summary</div>
                        <div className="mt-1 text-[10px] text-slate-500">
                          {axiomLatest.summary?.generated_at ? fmt(axiomLatest.summary.generated_at) : "—"}
                          {axiomLatest.summary?.model ? ` · ${axiomLatest.summary.model}` : ""}
                        </div>
                        <div className="mt-2 text-[11px] text-slate-200 whitespace-pre-wrap">
                          {axiomLatest.summary?.summary?.trim() ? axiomLatest.summary.summary : "No summary yet."}
                        </div>
                      </>
                    ) : null}

                    {axiomTab === "analysis" ? (
                      <>
                        <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Latest Analysis</div>
                        <div className="mt-1 text-[10px] text-slate-500">
                          {axiomLatest.analysis?.generated_at ? fmt(axiomLatest.analysis.generated_at) : "—"}
                          {axiomLatest.analysis?.model ? ` · ${axiomLatest.analysis.model}` : ""}
                        </div>
                        <div className="mt-2 text-[11px] text-slate-200 whitespace-pre-wrap">
                          {axiomLatest.analysis?.analysis?.trim() ? axiomLatest.analysis.analysis : "No analysis yet."}
                        </div>
                      </>
                    ) : null}

                    {axiomTab === "advice" ? (
                      <>
                        <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Latest Advice</div>
                        <div className="mt-1 text-[10px] text-slate-500">
                          {axiomLatest.advice?.generated_at ? fmt(axiomLatest.advice.generated_at) : "—"}
                          {axiomLatest.advice?.model ? ` · ${axiomLatest.advice.model}` : ""}
                        </div>
                        <div className="mt-2 text-[11px] text-slate-200 whitespace-pre-wrap">
                          {axiomLatest.advice?.advice?.trim()
                            ? axiomLatest.advice.advice
                            : axiomLatest.advice?.recommendation?.trim()
                            ? axiomLatest.advice.recommendation
                            : "No advice yet."}
                        </div>
                      </>
                    ) : null}
                  </div>

                  <div className="mt-2 text-[10px] text-slate-500">
                    AXIOM is side-car until Archive seal-time. No mutations to signing PDFs.
                  </div>
                </div>

                {/* Portal */}
                <div className="rounded-2xl border border-slate-900 bg-black/30 p-4">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Portal</div>

                  <div className="mt-2 grid grid-cols-1 gap-2 text-[11px] text-slate-300">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">Envelope</span>
                      <span className="font-mono text-[10px] text-slate-300">
                        {selected?.envelope_id ? clamp(selected.envelope_id, 12) : "—"}
                      </span>
                    </div>

                    {portalError ? <div className="mt-2 text-[10px] text-slate-500">{portalError}</div> : null}

                    {portal.signer_url || portal.verify_url || portal.certificate_url ? (
                      <div className="mt-2 grid grid-cols-1 gap-2">
                        <div className="flex gap-2">
                          {portal.signer_url ? portalBtn(portal.signer_url, "Signer") : null}
                          {portal.verify_url ? portalBtn(portal.verify_url, "Verify") : null}
                        </div>
                        <div className="flex gap-2">
                          {portal.certificate_url ? portalBtn(portal.certificate_url, "Certificate") : null}
                        </div>
                      </div>
                    ) : (
                      <div className="mt-1 text-[10px] text-slate-500">
                        Portal links appear after an envelope exists (derived via ci_portal_urls_rpc / ci_portal_urls).
                      </div>
                    )}

                    <div className="mt-2 flex gap-2">
                      <a
                        href="/ci-archive/minute-book"
                        className="flex-1 text-center rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2 text-[11px] font-semibold text-slate-200 hover:border-amber-500/40 hover:text-slate-100 transition"
                      >
                        CI-Archive
                      </a>

                      <a
                        href="/ci-sign"
                        className="flex-1 text-center rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2 text-[11px] font-semibold text-slate-200 hover:border-amber-500/40 hover:text-slate-100 transition"
                      >
                        CI-Sign
                      </a>
                    </div>

                    <div className="text-[10px] text-slate-500 mt-1">
                      Links are derived via <span className="text-slate-300">ci_portal_urls_rpc(envelope_id)</span>{" "}
                      (fallback: <span className="text-slate-300">ci_portal_urls</span>). No view changes.
                    </div>
                  </div>
                </div>

                {/* Notes */}
                <div className="rounded-2xl border border-slate-900 bg-black/30 p-4">
                  <div className="flex items-center justify-between">
                    <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Forge Notes</div>
                    <div className="text-[10px] text-slate-500">(Local-only)</div>
                  </div>
                  <textarea
                    className="mt-2 w-full min-h-[160px] rounded-xl bg-slate-950/70 border border-slate-800 px-3 py-2 text-sm text-slate-100 resize-none"
                    placeholder="Track execution note(s), signer confirmations, and archiving notes."
                  />
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
