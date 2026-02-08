"use client";
export const dynamic = "force-dynamic";

/**
 * CI • Billing (LOCKED CONTRACT — NO REGRESSIONS)
 * ✅ Read-only operator console (observability only)
 * ✅ Data source: public.billing_subscriptions (direct read; no RPC required)
 * ✅ Entity-safe: scoped by active entity_id from OsEntityContext (no hardcoded corps)
 * ✅ Lane-safe: tries is_test filter if column exists; falls back gracefully if not
 * ✅ OS-native 3-pane layout (Finder-style): Summary | Subscriptions | Details
 * ❌ No mutations, no enforcement, no provider coupling
 */

import React, { useEffect, useMemo, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";

function cx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function fmtDate(ts?: string | null) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}

function fmtShortDate(ts?: string | null) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleDateString();
}

function safePrettyJSON(x: any) {
  try {
    if (x == null) return "—";
    return JSON.stringify(x, null, 2);
  } catch {
    return "—";
  }
}

type BillingSubRow = {
  id: string;
  entity_id: string;

  plan_id: string;
  plan_key: string | null;

  status: string; // text (not enforced yet)
  started_at: string;
  current_period_start: string;
  current_period_end: string | null;

  trial_ends_at: string | null;
  cancel_at: string | null;
  ended_at: string | null;

  payment_provider: string | null;
  provider_customer_id: string | null;
  provider_subscription_id: string | null;

  is_internal: boolean;
  created_by: string | null;

  created_at: string;
  updated_at: string;

  metadata: any;

  // optional lane column (may not exist yet)
  is_test?: boolean | null;
};

type LeftTab = "SUMMARY" | "HISTORY";

function statusUpper(s?: string | null) {
  return (s || "").trim().toUpperCase();
}

function isTrialActive(row: BillingSubRow) {
  if (!row.trial_ends_at) return false;
  const t = new Date(row.trial_ends_at).getTime();
  return Number.isFinite(t) && t > Date.now();
}

function resolveActive(rows: BillingSubRow[]) {
  // deterministic and conservative:
  // 1) prefer rows not ended and status=ACTIVE (case-insensitive)
  // 2) else prefer rows not ended with active trial window
  // 3) else newest row
  const notEnded = rows.filter((r) => !r.ended_at);
  const active = notEnded.find((r) => statusUpper(r.status) === "ACTIVE");
  if (active) return active;

  const trial = notEnded.find((r) => isTrialActive(r));
  if (trial) return trial;

  return rows[0] || null;
}

export default function CiBillingPage() {
  // ---- entity context (defensive) ----
  const ec = useEntity() as any;

  const entityId: string =
    (ec?.activeEntityId as string) ||
    (ec?.entityId as string) ||
    (ec?.entity_id as string) ||
    "";

  const entitySlug: string =
    (ec?.activeEntity as string) ||
    (ec?.entitySlug as string) ||
    (ec?.entity_slug as string) ||
    "";

  const entityLabel: string =
    (ec?.entityName as string) ||
    (ec?.activeEntityName as string) ||
    (ec?.label as string) ||
    (ec?.name as string) ||
    entitySlug ||
    (entityId ? entityId.slice(0, 8) : "entity");

  // ---- env lane (defensive) ----
  const env = useOsEnv() as any;
  const isTest: boolean = Boolean(
    env?.is_test ?? env?.isTest ?? env?.lane_is_test ?? env?.sandbox ?? env?.isSandbox
  );
  const envLabel = isTest ? "SANDBOX" : "RoT";

  // ---- state ----
  const [rows, setRows] = useState<BillingSubRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const [leftTab, setLeftTab] = useState<LeftTab>("SUMMARY");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // ---- load billing subscriptions (read-only) ----
  useEffect(() => {
    let alive = true;

    (async () => {
      setLoading(true);
      setErr(null);

      if (!entityId) {
        setErr("Missing active entity_id from OS context.");
        setRows([]);
        setLoading(false);
        return;
      }

      try {
        const baseCols = [
          "id",
          "entity_id",
          "plan_id",
          "plan_key",
          "status",
          "started_at",
          "current_period_start",
          "current_period_end",
          "trial_ends_at",
          "cancel_at",
          "ended_at",
          "payment_provider",
          "provider_customer_id",
          "provider_subscription_id",
          "is_internal",
          "created_by",
          "created_at",
          "updated_at",
          "metadata",
        ];

        const tryWithLane = async () => {
          // if is_test exists, enforce lane
          const { data, error } = await supabase
            .from("billing_subscriptions")
            .select([...baseCols, "is_test"].join(","))
            .eq("entity_id", entityId)
            .eq("is_test", isTest)
            .order("created_at", { ascending: false });
          return { data, error };
        };

        const tryWithoutLane = async () => {
          const { data, error } = await supabase
            .from("billing_subscriptions")
            .select(baseCols.join(","))
            .eq("entity_id", entityId)
            .order("created_at", { ascending: false });
          return { data, error };
        };

        let res = await tryWithLane();
        if (res.error && /is_test|42703|undefined column/i.test(res.error.message)) {
          res = await tryWithoutLane();
        }
        if (res.error) throw res.error;

        if (!alive) return;

        const list = (res.data || []) as BillingSubRow[];
        setRows(list);

        if (!selectedId && list.length) setSelectedId(list[0].id);
        else if (selectedId && !list.some((r) => r.id === selectedId)) setSelectedId(list[0]?.id ?? null);
      } catch (e: any) {
        if (!alive) return;
        setErr(e?.message || "Failed to load billing subscriptions.");
        setRows([]);
      } finally {
        if (!alive) return;
        setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId, isTest, refreshKey]);

  const selected = useMemo(() => rows.find((r) => r.id === selectedId) || null, [rows, selectedId]);

  const activeSub = useMemo(() => resolveActive(rows), [rows]);

  const activeBadge = useMemo(() => {
    if (!activeSub) return { label: "None", cls: "border-white/10 bg-white/5 text-white/65" };
    const st = statusUpper(activeSub.status);
    if (st === "ACTIVE")
      return { label: "Active", cls: "border-emerald-300/18 bg-emerald-400/10 text-emerald-100/90" };
    if (isTrialActive(activeSub))
      return { label: "Trial", cls: "border-amber-300/18 bg-amber-400/10 text-amber-100/90" };
    if (activeSub.ended_at)
      return { label: "Ended", cls: "border-white/10 bg-white/5 text-white/60" };
    return { label: st || "Unknown", cls: "border-white/10 bg-white/5 text-white/70" };
  }, [activeSub]);

  const shell =
    "rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)] overflow-hidden";

  const paneHeader = "border-b border-white/10 p-4";
  const paneBody = "p-4";

  const Pill = ({
    active,
    onClick,
    children,
  }: {
    active: boolean;
    onClick: () => void;
    children: React.ReactNode;
  }) => (
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

  const Badge = ({ cls, children }: { cls: string; children: React.ReactNode }) => (
    <span className={cx("rounded-full border px-3 py-1 text-[11px] font-medium", cls)}>{children}</span>
  );

  return (
    <div className="h-full w-full">
      <div className="mx-auto w-full max-w-[1400px] px-4 pb-10 pt-6">
        {/* Header */}
        <div className="mb-5 flex items-end justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.28em] text-white/45">CI • Billing</div>
            <div className="mt-1 text-2xl font-semibold text-white/90">Billing Console</div>
            <div className="mt-1 text-sm text-white/50">
              Entity: <span className="text-white/70">{entityLabel}</span> • Lane:{" "}
              <span className="text-white/70">{envLabel}</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setRefreshKey((n) => n + 1)}
              className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs font-medium text-white/80 hover:border-amber-300/20 hover:bg-white/7"
            >
              Refresh
            </button>
          </div>
        </div>

        <div className="grid grid-cols-12 gap-4">
          {/* Left: Summary / History */}
          <div className="col-span-12 lg:col-span-4">
            <div className={shell}>
              <div className={paneHeader}>
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs font-semibold tracking-wide text-white/80">Summary</div>
                  <Badge cls={activeBadge.cls}>{activeBadge.label}</Badge>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <Pill active={leftTab === "SUMMARY"} onClick={() => setLeftTab("SUMMARY")}>
                    Summary
                  </Pill>
                  <Pill active={leftTab === "HISTORY"} onClick={() => setLeftTab("HISTORY")}>
                    History
                  </Pill>
                </div>
              </div>

              <div className={paneBody}>
                {err ? (
                  <div className="rounded-2xl border border-rose-300/15 bg-rose-500/10 p-4 text-sm text-rose-100/90">
                    {err}
                  </div>
                ) : loading ? (
                  <div className="text-sm text-white/50">Loading…</div>
                ) : leftTab === "SUMMARY" ? (
                  <div className="space-y-4">
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                      <div className="text-[10px] uppercase tracking-[0.22em] text-white/35">Resolved subscription</div>

                      {activeSub ? (
                        <div className="mt-3 space-y-2">
                          <div className="flex items-center justify-between gap-4">
                            <div className="text-sm font-semibold text-white/85">
                              {activeSub.plan_key || activeSub.plan_id || "Plan"}
                            </div>
                            <Badge
                              cls={
                                statusUpper(activeSub.status) === "ACTIVE"
                                  ? "border-emerald-300/18 bg-emerald-400/10 text-emerald-100/90"
                                  : isTrialActive(activeSub)
                                  ? "border-amber-300/18 bg-amber-400/10 text-amber-100/90"
                                  : "border-white/10 bg-white/5 text-white/70"
                              }
                            >
                              {statusUpper(activeSub.status) || "UNKNOWN"}
                            </Badge>
                          </div>

                          <div className="grid grid-cols-2 gap-3 pt-2 text-sm">
                            <div>
                              <div className="text-[10px] uppercase tracking-[0.22em] text-white/35">Provider</div>
                              <div className="mt-1 text-white/75">{activeSub.payment_provider || "—"}</div>
                            </div>
                            <div>
                              <div className="text-[10px] uppercase tracking-[0.22em] text-white/35">Internal</div>
                              <div className="mt-1 text-white/75">{activeSub.is_internal ? "Yes" : "No"}</div>
                            </div>
                            <div>
                              <div className="text-[10px] uppercase tracking-[0.22em] text-white/35">Period start</div>
                              <div className="mt-1 text-white/75">{fmtShortDate(activeSub.current_period_start)}</div>
                            </div>
                            <div>
                              <div className="text-[10px] uppercase tracking-[0.22em] text-white/35">Period end</div>
                              <div className="mt-1 text-white/75">{fmtShortDate(activeSub.current_period_end)}</div>
                            </div>
                            <div className="col-span-2">
                              <div className="text-[10px] uppercase tracking-[0.22em] text-white/35">Trial ends</div>
                              <div className="mt-1 text-white/75">{fmtDate(activeSub.trial_ends_at)}</div>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="mt-3 text-sm text-white/55">
                          No subscription registered for this entity in this lane.
                        </div>
                      )}
                    </div>

                    <div className="rounded-2xl border border-white/10 bg-black/18 p-4 text-xs text-white/55">
                      <span className="text-white/75 font-semibold">Read-only:</span> CI-Billing does not issue invoices,
                      does not change subscription state, and does not enforce access. It is an operator truth surface.
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                      <div className="text-[10px] uppercase tracking-[0.22em] text-white/35">Counts</div>
                      <div className="mt-2 flex items-center justify-between">
                        <div className="text-sm text-white/70">Total records</div>
                        <div className="text-sm font-semibold text-white/85">{rows.length}</div>
                      </div>
                      <div className="mt-2 flex items-center justify-between">
                        <div className="text-sm text-white/70">Active</div>
                        <div className="text-sm font-semibold text-white/85">
                          {rows.filter((r) => !r.ended_at && statusUpper(r.status) === "ACTIVE").length}
                        </div>
                      </div>
                      <div className="mt-2 flex items-center justify-between">
                        <div className="text-sm text-white/70">Trial</div>
                        <div className="text-sm font-semibold text-white/85">
                          {rows.filter((r) => !r.ended_at && isTrialActive(r)).length}
                        </div>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-white/10 bg-black/18 p-4 text-xs text-white/55">
                      This panel is intentionally simple. A canonical resolver RPC can be added later once behavior is
                      proven internally.
                    </div>
                  </div>
                )}
              </div>

              <div className="border-t border-white/10 p-3 text-[10px] text-white/35">
                Source: public.billing_subscriptions • entity_id={entityId ? entityId.slice(0, 8) + "…" : "—"} • lane=
                {envLabel}
              </div>
            </div>
          </div>

          {/* Middle: Subscriptions list */}
          <div className="col-span-12 lg:col-span-4">
            <div className={shell}>
              <div className={paneHeader}>
                <div className="text-xs font-semibold tracking-wide text-white/80">Subscriptions</div>
                <div className="mt-1 text-sm text-white/55">Newest first • select to inspect</div>
              </div>

              <div className="max-h-[640px] overflow-auto p-2">
                {loading ? (
                  <div className="p-4 text-sm text-white/50">Loading…</div>
                ) : err ? (
                  <div className="p-4 text-sm text-rose-200">{err}</div>
                ) : rows.length === 0 ? (
                  <div className="p-4 text-sm text-white/50">No subscription rows yet.</div>
                ) : (
                  <div className="space-y-2 p-2">
                    {rows.map((r) => {
                      const active = r.id === selectedId;
                      const st = statusUpper(r.status);
                      const trial = isTrialActive(r);
                      const ended = Boolean(r.ended_at);

                      const badgeCls = ended
                        ? "border-white/10 bg-white/5 text-white/60"
                        : st === "ACTIVE"
                        ? "border-emerald-300/18 bg-emerald-400/10 text-emerald-100/90"
                        : trial
                        ? "border-amber-300/18 bg-amber-400/10 text-amber-100/90"
                        : "border-white/10 bg-white/5 text-white/70";

                      const title = r.plan_key || r.plan_id || "Plan";
                      const subtitle = `${r.payment_provider || "manual"} • ${fmtShortDate(r.current_period_start)} → ${fmtShortDate(
                        r.current_period_end
                      )}`;

                      return (
                        <button
                          key={r.id}
                          onClick={() => setSelectedId(r.id)}
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
                              <div className="mt-1 truncate text-xs text-white/45">{subtitle}</div>
                              {r.is_internal ? (
                                <div className="mt-2 inline-flex items-center rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-medium text-white/65">
                                  Internal
                                </div>
                              ) : null}
                            </div>
                            <Badge cls={badgeCls}>{st || "—"}</Badge>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="border-t border-white/10 p-3 text-[10px] text-white/35">
                Read-only • No enforcement • No mutations
              </div>
            </div>
          </div>

          {/* Right: Details */}
          <div className="col-span-12 lg:col-span-4">
            <div className={shell}>
              <div className={paneHeader}>
                <div className="text-xs font-semibold tracking-wide text-white/80">Details</div>
                <div className="mt-1 text-sm text-white/55">{selected ? selected.id : "Select a subscription"}</div>
              </div>

              <div className={paneBody}>
                {!selected ? (
                  <div className="text-sm text-white/50">Select a row to inspect subscription details.</div>
                ) : (
                  <div className="space-y-4">
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-white/88">
                            {selected.plan_key || selected.plan_id || "Plan"}
                          </div>
                          <div className="mt-1 text-xs text-white/45">
                            Provider: {selected.payment_provider || "manual"}
                          </div>
                        </div>
                        <Badge
                          cls={
                            selected.ended_at
                              ? "border-white/10 bg-white/5 text-white/60"
                              : statusUpper(selected.status) === "ACTIVE"
                              ? "border-emerald-300/18 bg-emerald-400/10 text-emerald-100/90"
                              : isTrialActive(selected)
                              ? "border-amber-300/18 bg-amber-400/10 text-amber-100/90"
                              : "border-white/10 bg-white/5 text-white/70"
                          }
                        >
                          {statusUpper(selected.status) || "—"}
                        </Badge>
                      </div>

                      <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                        <div>
                          <div className="text-[10px] uppercase tracking-[0.22em] text-white/35">Started</div>
                          <div className="mt-1 text-white/75">{fmtDate(selected.started_at)}</div>
                        </div>
                        <div>
                          <div className="text-[10px] uppercase tracking-[0.22em] text-white/35">Created</div>
                          <div className="mt-1 text-white/75">{fmtDate(selected.created_at)}</div>
                        </div>

                        <div>
                          <div className="text-[10px] uppercase tracking-[0.22em] text-white/35">Period start</div>
                          <div className="mt-1 text-white/75">{fmtDate(selected.current_period_start)}</div>
                        </div>
                        <div>
                          <div className="text-[10px] uppercase tracking-[0.22em] text-white/35">Period end</div>
                          <div className="mt-1 text-white/75">{fmtDate(selected.current_period_end)}</div>
                        </div>

                        <div>
                          <div className="text-[10px] uppercase tracking-[0.22em] text-white/35">Trial ends</div>
                          <div className="mt-1 text-white/75">{fmtDate(selected.trial_ends_at)}</div>
                        </div>
                        <div>
                          <div className="text-[10px] uppercase tracking-[0.22em] text-white/35">Cancel at</div>
                          <div className="mt-1 text-white/75">{fmtDate(selected.cancel_at)}</div>
                        </div>

                        <div>
                          <div className="text-[10px] uppercase tracking-[0.22em] text-white/35">Ended at</div>
                          <div className="mt-1 text-white/75">{fmtDate(selected.ended_at)}</div>
                        </div>
                        <div>
                          <div className="text-[10px] uppercase tracking-[0.22em] text-white/35">Internal</div>
                          <div className="mt-1 text-white/75">{selected.is_internal ? "Yes" : "No"}</div>
                        </div>

                        <div className="col-span-2">
                          <div className="text-[10px] uppercase tracking-[0.22em] text-white/35">Provider IDs</div>
                          <div className="mt-2 rounded-2xl border border-white/10 bg-black/25 p-3 text-xs text-white/70">
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-white/45">customer</span>
                              <span className="truncate">{selected.provider_customer_id || "—"}</span>
                            </div>
                            <div className="mt-2 flex items-center justify-between gap-3">
                              <span className="text-white/45">subscription</span>
                              <span className="truncate">{selected.provider_subscription_id || "—"}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-white/10 bg-black/18 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-xs font-semibold tracking-wide text-white/80">Metadata</div>
                        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-medium text-white/60">
                          jsonb
                        </span>
                      </div>

                      <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-2xl border border-white/10 bg-black/25 p-3 font-mono text-[12px] leading-5 text-white/70">
                        {safePrettyJSON(selected.metadata)}
                      </pre>
                    </div>

                    <div className="rounded-2xl border border-white/10 bg-black/18 p-4 text-xs text-white/55">
                      <span className="text-white/75 font-semibold">Future-safe:</span> A canonical resolver RPC and enum
                      enforcement can be added later without changing this UI’s structure.
                    </div>
                  </div>
                )}
              </div>

              <div className="border-t border-white/10 p-3 text-[10px] text-white/35">
                Entity-safe • Lane-safe fallback • No hardcoded names
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-5 text-[10px] text-white/35">
          Source: public.billing_subscriptions • entity_id={entityId ? entityId.slice(0, 8) + "…" : "—"} • lane={envLabel}
        </div>
      </div>
    </div>
  );
}
