// src/app/(console-ledger)/ci-onboarding/ci-admissions/page.tsx
"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";

function cx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function normStatus(s: string | null | undefined) {
  return (s || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
}

function safePrettyJSON(x: any) {
  try {
    if (x == null) return "—";
    return JSON.stringify(x, null, 2);
  } catch {
    return "—";
  }
}

function fmtWhen(ts: string | null | undefined) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString();
}

async function ensureSessionOrThrow() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (!data.session) throw new Error("Not authenticated. Please sign in again.");
  return data.session;
}

/**
 * Retry helper for enum-casing drift (NO backend changes).
 * We try a preferred value first, then optional fallbacks if the DB complains about enum input.
 */
async function rpcWithEnumFallback<TArgs extends Record<string, any>>(
  fn: string,
  args: TArgs,
  fallbacks: Array<Partial<TArgs>>,
  enumErrorRegex = /invalid input value for enum|22P02/i
) {
  let lastErr: any = null;

  // try primary
  {
    const { data, error } = await supabase.rpc(fn as any, args as any);
    if (!error) return { data };
    lastErr = error;
    if (!enumErrorRegex.test(error.message || "")) throw error;
  }

  // try fallbacks
  for (const patch of fallbacks) {
    const next = { ...args, ...patch };
    const { data, error } = await supabase.rpc(fn as any, next as any);
    if (!error) return { data };
    lastErr = error;
    if (!enumErrorRegex.test(error.message || "")) throw error;
  }

  throw lastErr;
}

type InboxRow = {
  id: string;
  status: string | null;

  applicant_email: string | null;
  organization_email: string | null;

  organization_legal_name: string | null;
  organization_trade_name: string | null;

  entity_slug: string | null;
  created_at: string | null;
  updated_at?: string | null;

  requested_services?: any | null;
  metadata?: any | null;

  lane_is_test?: boolean | null;

  // optional fields if present in view
  risk_tier?: string | null;
  decision?: string | null;
};

type TopTab = "INBOX" | "ARCHIVED";
type SubTab = "BOTH" | "INTAKE" | "PROVISIONED";

type ModalMode =
  | null
  | { kind: "SUMMARY"; title: string; defaultText?: string; onSubmit: (summary: string) => Promise<void> }
  | {
      kind: "DECISION";
      title: string;
      actionLabel: string;
      defaultSummary?: string;
      defaultReason?: string;
      onSubmit: (summary: string, reason: string) => Promise<void>;
    }
  | {
      kind: "REQUEST_INFO";
      title: string;
      defaultMessage?: string;
      onSubmit: (payload: {
        message: string;
        channels: string[];
        dueAt: string | null;
      }) => Promise<void>;
    }
  | {
      kind: "CONFIRM";
      title: string;
      body: string;
      confirmLabel: string;
      tone?: "danger" | "neutral";
      onConfirm: () => Promise<void>;
    };

function OsModalShell({
  open,
  title,
  subtitle,
  children,
  onClose,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      {/* backdrop */}
      <button
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/70 backdrop-blur-[6px]"
      />
      {/* panel */}
      <div
        className={cx(
          "relative w-full max-w-[640px] overflow-hidden rounded-[28px] border border-white/10",
          "bg-gradient-to-b from-[#0B1220]/92 via-black/55 to-black/35",
          "shadow-[0_40px_160px_rgba(0,0,0,0.75)]"
        )}
      >
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute -top-24 left-1/2 h-56 w-[520px] -translate-x-1/2 rounded-full bg-amber-300/10 blur-3xl" />
          <div className="absolute -bottom-24 right-[-80px] h-56 w-56 rounded-full bg-emerald-300/10 blur-3xl" />
        </div>

        <div className="relative border-b border-white/10 p-5">
          <div className="text-[11px] uppercase tracking-[0.28em] text-white/45">Authority Surface</div>
          <div className="mt-1 text-xl font-semibold text-white/90">{title}</div>
          {subtitle ? <div className="mt-1 text-sm text-white/50">{subtitle}</div> : null}

          <button
            onClick={onClose}
            className="absolute right-4 top-4 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/70 hover:border-amber-300/20 hover:bg-white/7"
          >
            Close
          </button>
        </div>

        <div className="relative p-5">{children}</div>
      </div>
    </div>
  );
}

function FieldLabel({ children }: { children: string }) {
  return <div className="text-[11px] uppercase tracking-[0.26em] text-white/40">{children}</div>;
}

function Pill({ children, tone }: { children: string; tone?: "gold" | "emerald" | "neutral" }) {
  const cls =
    tone === "gold"
      ? "border-amber-300/20 bg-amber-400/10 text-amber-100/90"
      : tone === "emerald"
      ? "border-emerald-300/20 bg-emerald-400/10 text-emerald-100/90"
      : "border-white/10 bg-white/5 text-white/70";
  return (
    <span className={cx("rounded-full border px-3 py-1 text-[11px] font-medium", cls)}>{children}</span>
  );
}

export default function CiAdmissionsPage() {
  // ---- entity (STRICT: no corporate fallbacks, neutral) ----
  const ec = useEntity() as any;
  const entityKey: string =
    (ec?.entityKey as string) ||
    (ec?.activeEntity as string) ||
    (ec?.entity_slug as string) ||
    "";
  const entityName: string =
    (ec?.entityName as string) ||
    (ec?.activeEntityName as string) ||
    (ec?.entities?.find?.((x: any) => x?.slug === entityKey || x?.key === entityKey)?.name as string) ||
    entityKey;

  // ---- env lane (defensive) ----
  const env = useOsEnv() as any;
  const isTest: boolean = Boolean(env?.is_test ?? env?.isTest ?? env?.lane_is_test ?? env?.sandbox ?? env?.isSandbox);

  const [apps, setApps] = useState<InboxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [topTab, setTopTab] = useState<TopTab>("INBOX");
  const [subTab, setSubTab] = useState<SubTab>("BOTH");
  const [q, setQ] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const [modal, setModal] = useState<ModalMode>(null);

  const selected = useMemo(() => apps.find((a) => a.id === selectedId) || null, [apps, selectedId]);

  const meta = useMemo(() => {
    const m = selected?.metadata;
    return (m && typeof m === "object" ? (m as any) : {}) as any;
  }, [selected?.metadata]);

  // ---- load inbox (lane-safe if view supports lane, else fallback) ----
  useEffect(() => {
    let alive = true;

    (async () => {
      setLoading(true);
      setErr(null);

      try {
        const cols = [
          "id",
          "status",
          "applicant_email",
          "organization_email",
          "organization_legal_name",
          "organization_trade_name",
          "entity_slug",
          "created_at",
          "updated_at",
          "requested_services",
          "metadata",
          // optional if view has them (safe to request; if missing we handle)
          "risk_tier",
          "decision",
        ];

        const tryWithLane = async () => {
          const { data, error } = await supabase
            .from("v_onboarding_admissions_inbox")
            .select([...cols, "lane_is_test"].join(","))
            .eq("entity_slug", entityKey)
            .eq("lane_is_test", isTest)
            .order("created_at", { ascending: false });
          return { data, error };
        };

        const tryWithoutLane = async () => {
          const { data, error } = await supabase
            .from("v_onboarding_admissions_inbox")
            .select(cols.join(","))
            .eq("entity_slug", entityKey)
            .order("created_at", { ascending: false });
          return { data, error };
        };

        let res = await tryWithLane();
        if (res.error && /lane_is_test|42703|undefined column/i.test(res.error.message)) {
          res = await tryWithoutLane();
        }

        // if optional columns are missing, retry with a minimal select (NO regressions)
        if (res.error && /risk_tier|decision|42703|undefined column/i.test(res.error.message)) {
          const minimal = [
            "id",
            "status",
            "applicant_email",
            "organization_email",
            "organization_legal_name",
            "organization_trade_name",
            "entity_slug",
            "created_at",
            "updated_at",
            "requested_services",
            "metadata",
          ];
          const { data, error } = await supabase
            .from("v_onboarding_admissions_inbox")
            .select(minimal.join(","))
            .eq("entity_slug", entityKey)
            .order("created_at", { ascending: false });

          if (error) throw error;
          res = { data, error: null as any };
        }

        if (res.error) throw res.error;
        if (!alive) return;

        const list = (res.data || []) as InboxRow[];
        setApps(list);

        if (!selectedId && list.length) setSelectedId(list[0].id);
        else if (selectedId && !list.some((r) => r.id === selectedId)) setSelectedId(list[0]?.id ?? null);
      } catch (e: any) {
        if (!alive) return;
        setErr(e?.message || "Failed to load admissions inbox.");
      } finally {
        if (!alive) return;
        setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityKey, isTest, refreshKey]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = apps;

    // top-level filter
    list = list.filter((a) => {
      const st = normStatus(a.status);
      const isArchived = st === "ARCHIVED";
      return topTab === "ARCHIVED" ? isArchived : !isArchived;
    });

    // sub filter
    if (subTab !== "BOTH") {
      list = list.filter((a) => {
        const st = normStatus(a.status);
        if (subTab === "INTAKE") {
          // intake-ish: submitted/triage/in_review/needs_info/under_review (any casing) + not provisioned
          return !["PROVISIONED"].includes(st);
        }
        if (subTab === "PROVISIONED") {
          return st === "PROVISIONED";
        }
        return true;
      });
    }

    if (!needle) return list;

    return list.filter((a) => {
      const blob = [
        a.organization_trade_name,
        a.organization_legal_name,
        a.applicant_email,
        a.organization_email,
        a.status,
        a.id,
      ]
        .filter(Boolean)
        .join(" • ")
        .toLowerCase();
      return blob.includes(needle);
    });
  }, [apps, topTab, subTab, q]);

  const appTitle = useMemo(() => {
    if (!selected) return "Select an application";
    return selected.organization_trade_name || selected.organization_legal_name || selected.applicant_email || selected.id;
  }, [selected]);

  const statusPillTone = useMemo(() => {
    const st = normStatus(selected?.status);
    if (st === "PROVISIONED") return "emerald" as const;
    if (st === "NEEDS_INFO") return "gold" as const;
    return "neutral" as const;
  }, [selected?.status]);

  // ---------------- RPC ACTIONS (LOCKED CONTRACTS) ----------------

  async function beginReview() {
    if (!selected) return;
    setBusy(true);
    setNote(null);
    try {
      await ensureSessionOrThrow();

      // admissions_begin_review(p_application_id uuid)
      const { error } = await supabase.rpc("admissions_begin_review", {
        p_application_id: selected.id,
      });
      if (error) throw error;

      setNote("Review started.");
      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "Begin Review failed.");
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(nextStatus: string, noteText: string) {
    if (!selected) return;
    await ensureSessionOrThrow();

    // admissions_set_status(p_application_id uuid, p_next_status onboarding_status, p_note text)
    const primary = {
      p_application_id: selected.id,
      p_next_status: nextStatus,
      p_note: noteText,
    };

    // casing fallbacks (because your enum table currently has mixed labels)
    const candidates = Array.from(
      new Set([
        nextStatus,
        nextStatus.toLowerCase(),
        nextStatus.toUpperCase(),
        nextStatus.replace(/[\s-]+/g, "_").toLowerCase(),
        nextStatus.replace(/[\s-]+/g, "_").toUpperCase(),
      ])
    );

    const fallbacks = candidates.slice(1).map((s) => ({ p_next_status: s }));
    await rpcWithEnumFallback("admissions_set_status", primary, fallbacks);
  }

  async function approveForProvisioning() {
    if (!selected) return;

    setModal({
      kind: "DECISION",
      title: "Approve for provisioning",
      actionLabel: "Approve",
      defaultSummary: "Approved for provisioning.",
      defaultReason: "Meets intake requirements.",
      onSubmit: async (summary, reason) => {
        setBusy(true);
        setNote(null);
        try {
          await ensureSessionOrThrow();

          // ✅ IMPORTANT: use FLEX to avoid enum casing fights forever.
          // admissions_record_decision_flex(p_application_id, p_decision_text, p_risk_tier_text, p_summary, p_reason)
          const riskText =
            (selected.risk_tier as string) ||
            (meta?.risk_tier as string) ||
            "medium";

          const { error } = await supabase.rpc("admissions_record_decision_flex", {
            p_application_id: selected.id,
            p_decision_text: "APPROVE",
            p_risk_tier_text: String(riskText || "medium"),
            p_summary: summary || "Approved for provisioning.",
            p_reason: reason || "Meets intake requirements.",
          });
          if (error) throw error;

          // Optional: if your backend advances status internally, great.
          // If not, we can gently move to provisioning without breaking anything:
          try {
            await setStatus("provisioning", "Decision recorded: APPROVE");
          } catch {
            // do nothing; decision is still recorded
          }

          setNote("Approved for provisioning.");
          setRefreshKey((n) => n + 1);
        } finally {
          setBusy(false);
          setModal(null);
        }
      },
    });
  }

  async function decline() {
    if (!selected) return;

    setModal({
      kind: "DECISION",
      title: "Decline application",
      actionLabel: "Decline",
      defaultSummary: "Declined.",
      defaultReason: "Does not meet intake requirements.",
      onSubmit: async (summary, reason) => {
        setBusy(true);
        setNote(null);
        try {
          await ensureSessionOrThrow();

          const riskText = (selected.risk_tier as string) || (meta?.risk_tier as string) || "medium";

          const { error } = await supabase.rpc("admissions_record_decision_flex", {
            p_application_id: selected.id,
            p_decision_text: "DECLINE",
            p_risk_tier_text: String(riskText || "medium"),
            p_summary: summary || "Declined.",
            p_reason: reason || "Does not meet intake requirements.",
          });
          if (error) throw error;

          try {
            await setStatus("declined", "Decision recorded: DECLINE");
          } catch {}

          setNote("Declined.");
          setRefreshKey((n) => n + 1);
        } finally {
          setBusy(false);
          setModal(null);
        }
      },
    });
  }

  async function requestInfo() {
    if (!selected) return;

    setModal({
      kind: "REQUEST_INFO",
      title: "Request more information",
      defaultMessage: "Please provide the missing details required to proceed.",
      onSubmit: async ({ message, channels, dueAt }) => {
        setBusy(true);
        setNote(null);
        try {
          await ensureSessionOrThrow();

          // admissions_request_info(p_application_id, p_message, p_channels, p_due_at, p_next_status)
          // We'll try common enum forms for p_next_status (needs_info variants).
          const baseArgs = {
            p_application_id: selected.id,
            p_message: message,
            p_channels: channels.length ? channels : ["email"],
            p_due_at: dueAt ? new Date(dueAt).toISOString() : null,
            p_next_status: "needs_info",
          };

          await rpcWithEnumFallback(
            "admissions_request_info",
            baseArgs,
            [
              { p_next_status: "NEEDS_INFO" },
              { p_next_status: "needs_info" },
              { p_next_status: "Needs_Info" as any },
              { p_next_status: "NEEDS-INFO" as any },
            ],
            /invalid input value for enum|22P02/i
          );

          setNote("Information requested.");
          setRefreshKey((n) => n + 1);
        } finally {
          setBusy(false);
          setModal(null);
        }
      },
    });
  }

  async function archiveSoft() {
    if (!selected) return;

    setModal({
      kind: "CONFIRM",
      title: "Archive (soft)",
      body: "This will archive the application (RPC-only). You can still locate it under Archived.",
      confirmLabel: "Archive",
      tone: "neutral",
      onConfirm: async () => {
        setBusy(true);
        setNote(null);
        try {
          await setStatus("archived", "Archived (soft) via Admissions Console.");
          setNote("Archived.");
          setRefreshKey((n) => n + 1);
        } finally {
          setBusy(false);
          setModal(null);
        }
      },
    });
  }

  async function hardDelete() {
    if (!selected) return;

    setModal({
      kind: "CONFIRM",
      title: "Hard delete",
      body: "This is permanent. Only use for test data you explicitly want removed.",
      confirmLabel: "Delete",
      tone: "danger",
      onConfirm: async () => {
        setBusy(true);
        setNote(null);
        try {
          await ensureSessionOrThrow();

          // admissions_delete_application(p_application_id uuid, p_reason text)
          const { error } = await supabase.rpc("admissions_delete_application", {
            p_application_id: selected.id,
            p_reason: "Hard delete requested by authority operator.",
          });
          if (error) throw error;

          setNote("Deleted.");
          setSelectedId(null);
          setRefreshKey((n) => n + 1);
        } finally {
          setBusy(false);
          setModal(null);
        }
      },
    });
  }

  // ---------------- UI ----------------

  return (
    <div className="h-full w-full">
      <div className="mx-auto w-full max-w-[1500px] px-4 pb-10 pt-6">
        {/* Header */}
        <div className="mb-5 flex items-end justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.28em] text-white/45">CI • Admissions</div>
            <div className="mt-1 text-2xl font-semibold text-white/90">Admissions Console</div>
            <div className="mt-1 text-sm text-white/50">
              Entity-scoped: <span className="text-white/70">{entityName || entityKey || "—"}</span> • Lane:{" "}
              <span className="text-white/70">{isTest ? "SANDBOX" : "RoT"}</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {note ? (
              <div className="hidden md:flex items-center gap-2 rounded-full border border-white/10 bg-black/20 px-4 py-2 text-xs text-white/70">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-300/70" />
                {note}
              </div>
            ) : null}

            <button
              onClick={() => setRefreshKey((n) => n + 1)}
              className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs font-medium text-white/80 hover:border-amber-300/20 hover:bg-white/7"
            >
              Refresh
            </button>
          </div>
        </div>

        {/* Layout */}
        <div className="grid grid-cols-12 gap-4">
          {/* Left: Inbox */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-xs font-semibold tracking-wide text-white/80">Inbox</div>
                    <div className="mt-1 flex flex-wrap gap-2">
                      <button
                        onClick={() => setTopTab("INBOX")}
                        className={cx(
                          "rounded-full px-3 py-1 text-[11px] font-medium",
                          topTab === "INBOX"
                            ? "bg-white/8 text-white/85 ring-1 ring-white/12"
                            : "text-white/55 hover:text-white/75"
                        )}
                      >
                        Intake
                      </button>
                      <button
                        onClick={() => setTopTab("ARCHIVED")}
                        className={cx(
                          "rounded-full px-3 py-1 text-[11px] font-medium",
                          topTab === "ARCHIVED"
                            ? "bg-white/8 text-white/85 ring-1 ring-white/12"
                            : "text-white/55 hover:text-white/75"
                        )}
                      >
                        Archived
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <Pill tone="neutral">{subTab}</Pill>
                  </div>
                </div>

                <div className="mt-3 flex items-center justify-between gap-2">
                  <div className="flex gap-2">
                    {(["BOTH", "INTAKE", "PROVISIONED"] as SubTab[]).map((t) => (
                      <button
                        key={t}
                        onClick={() => setSubTab(t)}
                        className={cx(
                          "rounded-full px-3 py-1 text-[11px] font-medium",
                          subTab === t
                            ? "bg-amber-400/10 text-amber-200 ring-1 ring-amber-300/20"
                            : "text-white/55 hover:text-white/75"
                        )}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="mt-3">
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search org / applicant / email / status"
                    className="w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-2 text-sm text-white/85 placeholder:text-white/35 outline-none focus:border-amber-300/25"
                  />
                </div>
              </div>

              <div className="max-h-[560px] overflow-auto p-2">
                {loading ? (
                  <div className="p-4 text-sm text-white/50">Loading…</div>
                ) : err ? (
                  <div className="p-4 text-sm text-rose-200">{err}</div>
                ) : filtered.length === 0 ? (
                  <div className="p-4 text-sm text-white/50">No applications found.</div>
                ) : (
                  <div className="space-y-2 p-2">
                    {filtered.map((a) => {
                      const active = a.id === selectedId;
                      const name = a.organization_trade_name || a.organization_legal_name || a.applicant_email || a.id;
                      const status = a.status || "—";
                      const st = normStatus(a.status);

                      const badgeTone =
                        st === "PROVISIONED" ? "emerald" : st === "NEEDS_INFO" ? "gold" : "neutral";

                      return (
                        <button
                          key={a.id}
                          onClick={() => setSelectedId(a.id)}
                          className={cx(
                            "w-full rounded-2xl border p-4 text-left transition",
                            active
                              ? "border-amber-300/25 bg-black/35 shadow-[0_0_0_1px_rgba(250,204,21,0.10)]"
                              : "border-white/10 bg-black/15 hover:border-white/16 hover:bg-black/22"
                          )}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-semibold text-white/88">{name}</div>
                              <div className="mt-1 truncate text-xs text-white/45">
                                {a.applicant_email || a.organization_email || "—"}
                              </div>
                            </div>
                            <Pill tone={badgeTone as any}>{status}</Pill>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="border-t border-white/10 p-4 text-[10px] text-white/35">
                Source: public.v_onboarding_admissions_inbox • entity_slug={entityKey || "—"} • lane={isTest ? "SANDBOX" : "RoT"}
              </div>
            </div>
          </div>

          {/* Middle: Application */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="text-xs font-semibold tracking-wide text-white/80">Application</div>
                <div className="mt-1 truncate text-sm text-white/60">{selected ? appTitle : "Select an application"}</div>
              </div>

              <div className="p-4">
                {!selected ? (
                  <div className="text-sm text-white/50">Select an application.</div>
                ) : (
                  <div className="space-y-4">
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-white/88">{appTitle}</div>
                          <div className="mt-1 text-xs text-white/45">
                            {selected.applicant_email || selected.organization_email || "—"}
                          </div>
                        </div>
                        <Pill tone={statusPillTone as any}>{selected.status || "—"}</Pill>
                      </div>

                      <div className="mt-4 space-y-3">
                        <div className="grid grid-cols-2 gap-3">
                          <div className="rounded-2xl border border-white/10 bg-black/18 p-3">
                            <FieldLabel>App ID</FieldLabel>
                            <div className="mt-2 break-all font-mono text-[12px] leading-5 text-white/75">{selected.id}</div>
                          </div>
                          <div className="rounded-2xl border border-white/10 bg-black/18 p-3">
                            <FieldLabel>Type</FieldLabel>
                            <div className="mt-2 text-sm text-white/75">{meta?.type || "organization"}</div>
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                          <div className="rounded-2xl border border-white/10 bg-black/18 p-3">
                            <FieldLabel>Created</FieldLabel>
                            <div className="mt-2 text-sm text-white/75">{fmtWhen(selected.created_at)}</div>
                          </div>
                          <div className="rounded-2xl border border-white/10 bg-black/18 p-3">
                            <FieldLabel>Updated</FieldLabel>
                            <div className="mt-2 text-sm text-white/75">{fmtWhen(selected.updated_at || null)}</div>
                          </div>
                        </div>

                        <div className="rounded-2xl border border-white/10 bg-black/18 p-3">
                          <FieldLabel>Requested services</FieldLabel>
                          <div className="mt-2 text-sm text-white/75 whitespace-pre-wrap">
                            {selected.requested_services ? JSON.stringify(selected.requested_services) : "—"}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Metadata */}
                    <div className="rounded-2xl border border-white/10 bg-black/18 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-xs font-semibold tracking-wide text-white/80">Metadata</div>
                        <Pill>jsonb</Pill>
                      </div>

                      <div className="mt-3 space-y-3">
                        <div className="grid grid-cols-1 gap-3">
                          <div className="rounded-2xl border border-white/10 bg-black/25 p-3">
                            <div className="flex items-center justify-between">
                              <FieldLabel>source</FieldLabel>
                              <span className="text-xs text-white/45">{meta?.source ? String(meta.source) : "—"}</span>
                            </div>
                            <div className="mt-2 text-sm text-white/70 whitespace-pre-wrap">
                              {meta?.request_brief ? String(meta.request_brief) : "—"}
                            </div>
                            {meta?.notes ? <div className="mt-2 text-xs text-white/50">{String(meta.notes)}</div> : null}
                          </div>

                          <div className="rounded-2xl border border-white/10 bg-black/25 p-3">
                            <FieldLabel>raw</FieldLabel>
                            <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-white/70">
                              {safePrettyJSON(selected.metadata)}
                            </pre>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-white/10 bg-black/18 p-4 text-sm text-white/60">
                      <div className="font-semibold text-white/80">Read-only discipline</div>
                      <div className="mt-1">Admissions is authority-only. Invite/activation occurs in CI-Provisioning.</div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right: Authority */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="text-xs font-semibold tracking-wide text-white/80">Authority Panel</div>
                <div className="mt-1 truncate text-sm text-white/60">{selected ? appTitle : "Select an application"}</div>
              </div>

              <div className="p-4">
                <div className="flex flex-col gap-2">
                  <button
                    onClick={beginReview}
                    disabled={!selected || busy}
                    className={cx(
                      "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                      selected && !busy
                        ? "border-emerald-300/20 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/14"
                        : "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                    )}
                  >
                    Begin Review
                  </button>

                  <button
                    onClick={approveForProvisioning}
                    disabled={!selected || busy}
                    className={cx(
                      "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                      selected && !busy
                        ? "border-white/10 bg-white/5 text-white/85 hover:border-amber-300/20 hover:bg-white/7"
                        : "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                    )}
                  >
                    Approve (for Provisioning)
                  </button>

                  <button
                    onClick={requestInfo}
                    disabled={!selected || busy}
                    className={cx(
                      "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                      selected && !busy
                        ? "border-amber-300/18 bg-amber-400/10 text-amber-100/90 hover:bg-amber-400/14"
                        : "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                    )}
                  >
                    Needs Info
                  </button>

                  <button
                    onClick={decline}
                    disabled={!selected || busy}
                    className={cx(
                      "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                      selected && !busy
                        ? "border-rose-300/20 bg-rose-400/10 text-rose-200 hover:bg-rose-400/14"
                        : "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                    )}
                  >
                    Decline
                  </button>

                  <button
                    onClick={archiveSoft}
                    disabled={!selected || busy}
                    className={cx(
                      "mt-2 rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                      selected && !busy
                        ? "border-white/10 bg-black/20 text-white/75 hover:border-white/16 hover:bg-black/28"
                        : "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                    )}
                  >
                    Archive (soft)
                  </button>

                  <button
                    onClick={hardDelete}
                    disabled={!selected || busy}
                    className={cx(
                      "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                      selected && !busy
                        ? "border-rose-300/18 bg-black/15 text-rose-200/80 hover:bg-rose-400/10"
                        : "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                    )}
                  >
                    Hard Delete
                  </button>

                  <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 p-3 text-xs text-white/50">
                    Mutations are <span className="text-white/70">RPC-only</span>. Decisions use{" "}
                    <span className="font-mono text-white/70">admissions_record_decision_flex</span> to stay casing-safe.
                  </div>

                  {note ? (
                    <div className="mt-2 rounded-2xl border border-white/10 bg-black/20 p-3 text-xs text-white/70">
                      {note}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ---------------- MODALS ---------------- */}
      <OsModalShell
        open={modal != null}
        title={
          modal?.kind === "SUMMARY"
            ? modal.title
            : modal?.kind === "DECISION"
            ? modal.title
            : modal?.kind === "REQUEST_INFO"
            ? modal.title
            : modal?.kind === "CONFIRM"
            ? modal.title
            : "Authority"
        }
        subtitle={selected ? appTitle : undefined}
        onClose={() => (busy ? null : setModal(null))}
      >
        {modal?.kind === "DECISION" ? (
          <DecisionModalBody
            busy={busy}
            actionLabel={modal.actionLabel}
            defaultSummary={modal.defaultSummary}
            defaultReason={modal.defaultReason}
            onSubmit={modal.onSubmit}
            onCancel={() => setModal(null)}
          />
        ) : null}

        {modal?.kind === "REQUEST_INFO" ? (
          <RequestInfoModalBody
            busy={busy}
            defaultMessage={modal.defaultMessage}
            onSubmit={modal.onSubmit}
            onCancel={() => setModal(null)}
          />
        ) : null}

        {modal?.kind === "SUMMARY" ? (
          <SummaryModalBody
            busy={busy}
            defaultText={modal.defaultText}
            onSubmit={modal.onSubmit}
            onCancel={() => setModal(null)}
          />
        ) : null}

        {modal?.kind === "CONFIRM" ? (
          <ConfirmModalBody
            busy={busy}
            body={modal.body}
            confirmLabel={modal.confirmLabel}
            tone={modal.tone}
            onConfirm={modal.onConfirm}
            onCancel={() => setModal(null)}
          />
        ) : null}
      </OsModalShell>
    </div>
  );
}

function SummaryModalBody({
  busy,
  defaultText,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  defaultText?: string;
  onSubmit: (text: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [text, setText] = useState(defaultText || "");
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
        <FieldLabel>Summary</FieldLabel>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          className="mt-2 w-full rounded-2xl border border-white/10 bg-black/25 p-3 text-sm text-white/85 placeholder:text-white/35 outline-none focus:border-amber-300/25"
          placeholder="Write a short operator summary…"
        />
      </div>

      <div className="flex items-center justify-end gap-2">
        <button
          onClick={onCancel}
          disabled={busy}
          className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs text-white/70 hover:border-white/16 hover:bg-white/7 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={() => onSubmit(text)}
          disabled={busy}
          className="rounded-full border border-amber-300/20 bg-amber-400/10 px-5 py-2 text-xs font-semibold text-amber-100/90 hover:bg-amber-400/14 disabled:opacity-50"
        >
          Submit
        </button>
      </div>
    </div>
  );
}

function DecisionModalBody({
  busy,
  actionLabel,
  defaultSummary,
  defaultReason,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  actionLabel: string;
  defaultSummary?: string;
  defaultReason?: string;
  onSubmit: (summary: string, reason: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [summary, setSummary] = useState(defaultSummary || "");
  const [reason, setReason] = useState(defaultReason || "");
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
        <FieldLabel>Decision summary</FieldLabel>
        <textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={3}
          className="mt-2 w-full rounded-2xl border border-white/10 bg-black/25 p-3 text-sm text-white/85 placeholder:text-white/35 outline-none focus:border-amber-300/25"
          placeholder="Short summary…"
        />
      </div>

      <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
        <FieldLabel>Reason</FieldLabel>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={4}
          className="mt-2 w-full rounded-2xl border border-white/10 bg-black/25 p-3 text-sm text-white/85 placeholder:text-white/35 outline-none focus:border-amber-300/25"
          placeholder="Operator reason…"
        />
      </div>

      <div className="flex items-center justify-end gap-2">
        <button
          onClick={onCancel}
          disabled={busy}
          className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs text-white/70 hover:border-white/16 hover:bg-white/7 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={() => onSubmit(summary, reason)}
          disabled={busy}
          className="rounded-full border border-amber-300/20 bg-amber-400/10 px-5 py-2 text-xs font-semibold text-amber-100/90 hover:bg-amber-400/14 disabled:opacity-50"
        >
          {actionLabel}
        </button>
      </div>
    </div>
  );
}

function RequestInfoModalBody({
  busy,
  defaultMessage,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  defaultMessage?: string;
  onSubmit: (payload: { message: string; channels: string[]; dueAt: string | null }) => Promise<void>;
  onCancel: () => void;
}) {
  const [message, setMessage] = useState(defaultMessage || "");
  const [channels, setChannels] = useState<{ email: boolean; sms: boolean }>({ email: true, sms: false });
  const [dueAt, setDueAt] = useState<string>("");

  const chanList = useMemo(() => {
    const out: string[] = [];
    if (channels.email) out.push("email");
    if (channels.sms) out.push("sms");
    return out;
  }, [channels]);

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
        <FieldLabel>Message</FieldLabel>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={5}
          className="mt-2 w-full rounded-2xl border border-white/10 bg-black/25 p-3 text-sm text-white/85 placeholder:text-white/35 outline-none focus:border-amber-300/25"
          placeholder="What do you need from the applicant?"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
          <FieldLabel>Channels</FieldLabel>
          <div className="mt-2 flex flex-col gap-2 text-sm text-white/75">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={channels.email}
                onChange={(e) => setChannels((c) => ({ ...c, email: e.target.checked }))}
              />
              Email
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={channels.sms}
                onChange={(e) => setChannels((c) => ({ ...c, sms: e.target.checked }))}
              />
              SMS
            </label>
          </div>
          <div className="mt-2 text-xs text-white/45">Selected: {chanList.join(", ") || "—"}</div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
          <FieldLabel>Due date</FieldLabel>
          <input
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
            type="datetime-local"
            className="mt-2 w-full rounded-2xl border border-white/10 bg-black/25 px-3 py-2 text-sm text-white/85 outline-none focus:border-amber-300/25"
          />
          <div className="mt-2 text-xs text-white/45">Optional. Leave empty for no due date.</div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2">
        <button
          onClick={onCancel}
          disabled={busy}
          className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs text-white/70 hover:border-white/16 hover:bg-white/7 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={() => onSubmit({ message, channels: chanList, dueAt: dueAt || null })}
          disabled={busy || !message.trim()}
          className="rounded-full border border-amber-300/20 bg-amber-400/10 px-5 py-2 text-xs font-semibold text-amber-100/90 hover:bg-amber-400/14 disabled:opacity-50"
        >
          Send request
        </button>
      </div>
    </div>
  );
}

function ConfirmModalBody({
  busy,
  body,
  confirmLabel,
  tone,
  onConfirm,
  onCancel,
}: {
  busy: boolean;
  body: string;
  confirmLabel: string;
  tone?: "danger" | "neutral";
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}) {
  const cls =
    tone === "danger"
      ? "border-rose-300/20 bg-rose-400/10 text-rose-200 hover:bg-rose-400/14"
      : "border-amber-300/20 bg-amber-400/10 text-amber-100/90 hover:bg-amber-400/14";

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-white/70">
        {body}
      </div>

      <div className="flex items-center justify-end gap-2">
        <button
          onClick={onCancel}
          disabled={busy}
          className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs text-white/70 hover:border-white/16 hover:bg-white/7 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={() => onConfirm()}
          disabled={busy}
          className={cx("rounded-full border px-5 py-2 text-xs font-semibold disabled:opacity-50", cls)}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}
