"use client";
export const dynamic = "force-dynamic";

/**
 * CI • Billing (OPERATOR-ONLY — READ ONLY)
 * ✅ OS-aligned 3-pane console
 * ✅ Contamination-safe: NEVER hardcode corp names
 * ✅ Entity-safe: requires entity_id (uuid), resolves from OS context OR entities.slug
 * ✅ Lane-safe: filters by is_test when column exists, falls back if not
 * ✅ No mutations. No enforcement. No payment actions.
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

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="text-[10px] uppercase tracking-[0.22em] text-white/35">{k}</div>
      <div className="max-w-[72%] text-right text-sm text-white/80 break-words">{v}</div>
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

  // data
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [subs, setSubs] = useState<SubRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const selected = useMemo(
    () => subs.find((s) => s.id === selectedId) || null,
    [subs, selectedId]
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
      const { data, error } = await supabase
        .from("entities")
        .select("id")
        .eq("slug", entitySlug)
        .maybeSingle();

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

  // Load subscriptions (read-only)
  useEffect(() => {
    let alive = true;

    (async () => {
      setLoading(true);
      setErr(null);

      if (!entityId) {
        setSubs([]);
        setSelectedId(null);
        setLoading(false);
        return;
      }

      try {
        // Try with is_test (lane-safe) then fallback if column missing
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
        setSelectedId((prev) => {
          if (prev && list.some((x) => x.id === prev)) return prev;
          return list[0]?.id ?? null;
        });
      } catch (e: any) {
        if (!alive) return;
        setErr(e?.message || "Failed to load billing_subscriptions.");
      } finally {
        if (!alive) return;
        setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [entityId, isTest, refreshKey]);

  const shell =
    "rounded-3xl border border-white/10 bg-black/20 shadow-[0_28px_120px_rgba(0,0,0,0.55)] overflow-hidden";
  const header =
    "border-b border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent px-4 sm:px-6 py-4 sm:py-5";
  const body = "px-4 sm:px-6 py-5 sm:py-6";

  return (
    <div className="w-full">
      <div className="mx-auto w-full max-w-[1400px] px-4 pb-10 pt-4 sm:pt-6">
        <div className={shell}>
          <div className={header}>
            <div className="text-[10px] sm:text-xs tracking-[0.3em] uppercase text-slate-500">CI • Billing</div>
            <h1 className="mt-1 text-lg sm:text-xl font-semibold text-slate-50">Billing Console</h1>
            <p className="mt-1 max-w-3xl text-[11px] sm:text-xs text-slate-400 leading-relaxed">
              Operator visibility only. No enforcement. No mutations.
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-400">
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
                entity_id:{" "}
                <span className="text-slate-200 font-semibold">{entityId ? shortUUID(entityId) : "—"}</span>
              </span>

              <span className="ml-auto" />
              <button
                onClick={() => setRefreshKey((n) => n + 1)}
                className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase text-slate-200 hover:bg-white/7"
              >
                Refresh
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
                  Contamination-safe • Lane-safe • Read-only • No mutations
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-12 gap-4">
                {/* LEFT: Summary */}
                <div className="col-span-12 lg:col-span-3">
                  <div className="rounded-3xl border border-white/10 bg-black/20 overflow-hidden">
                    <div className="border-b border-white/10 p-4">
                      <div className="text-xs font-semibold tracking-wide text-white/80">Summary</div>
                      <div className="mt-1 text-[11px] text-white/45">Read-only billing state</div>
                    </div>

                    <div className="p-4 space-y-3">
                      {loading ? (
                        <div className="text-sm text-white/55">Loading…</div>
                      ) : err ? (
                        <div className="text-sm text-rose-200">{err}</div>
                      ) : (
                        <>
                          <Row k="Subscriptions" v={`${subs.length}`} />
                          <Row
                            k="Active"
                            v={
                              (() => {
                                const active = subs.find((s) => (s.status || "").toLowerCase() === "active");
                                return active ? shortUUID(active.id) : "—";
                              })()
                            }
                          />
                          <Row k="Lane" v={envLabel} />
                          <Row k="Entity" v={entitySlug} />
                        </>
                      )}
                    </div>

                    <div className="border-t border-white/10 p-3 text-[10px] text-white/35">
                      Source: public.billing_subscriptions • entity_id={shortUUID(entityId)} • lane={envLabel}
                    </div>
                  </div>
                </div>

                {/* MIDDLE: Subscriptions */}
                <div className="col-span-12 lg:col-span-5">
                  <div className="rounded-3xl border border-white/10 bg-black/20 overflow-hidden">
                    <div className="border-b border-white/10 p-4">
                      <div className="text-xs font-semibold tracking-wide text-white/80">Subscriptions</div>
                      <div className="mt-1 text-[11px] text-white/45">Newest first • select to inspect</div>
                    </div>

                    <div className="max-h-[560px] overflow-auto p-2">
                      {loading ? (
                        <div className="p-4 text-sm text-white/55">Loading…</div>
                      ) : err ? (
                        <div className="p-4 text-sm text-rose-200">{err}</div>
                      ) : subs.length === 0 ? (
                        <div className="p-4 text-sm text-white/55">
                          None registered (valid dormant state).
                        </div>
                      ) : (
                        <div className="space-y-2 p-2">
                          {subs.map((s) => {
                            const active = s.id === selectedId;
                            const st = (s.status || "—").toString();
                            const plan = (s.plan_key || s.plan_id || "—").toString();

                            return (
                              <button
                                key={s.id}
                                onClick={() => setSelectedId(s.id)}
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
                      )}
                    </div>

                    <div className="border-t border-white/10 p-3 text-[10px] text-white/35">
                      Read-only • No enforcement • No mutations
                    </div>
                  </div>
                </div>

                {/* RIGHT: Details */}
                <div className="col-span-12 lg:col-span-4">
                  <div className="rounded-3xl border border-white/10 bg-black/20 overflow-hidden">
                    <div className="border-b border-white/10 p-4">
                      <div className="text-xs font-semibold tracking-wide text-white/80">Details</div>
                      <div className="mt-1 text-[11px] text-white/45">
                        {selected ? "Subscription details" : "Select a subscription"}
                      </div>
                    </div>

                    <div className="p-4">
                      {!selected ? (
                        <div className="text-sm text-white/55">Select a row to inspect subscription details.</div>
                      ) : (
                        <div className="space-y-3">
                          <div className="space-y-3 rounded-2xl border border-white/10 bg-black/20 p-4">
                            <Row k="Subscription ID" v={selected.id} />
                            <Row k="Status" v={(selected.status ?? "—").toString()} />
                            <Row k="Plan key" v={(selected.plan_key ?? "—").toString()} />
                            <Row k="Plan id" v={(selected.plan_id ?? "—").toString()} />
                            <Row k="Provider" v={(selected.payment_provider ?? "—").toString()} />
                            <Row k="Provider cust" v={(selected.provider_customer_id ?? "—").toString()} />
                            <Row k="Provider sub" v={(selected.provider_subscription_id ?? "—").toString()} />
                            <Row k="Internal" v={(selected.is_internal ?? false) ? "true" : "false"} />
                            {"is_test" in (selected as any) ? <Row k="Lane flag" v={String((selected as any).is_test)} /> : null}
                          </div>

                          <div className="space-y-3 rounded-2xl border border-white/10 bg-black/20 p-4">
                            <Row k="Started" v={fmtISO(selected.started_at)} />
                            <Row k="Period start" v={fmtISO(selected.current_period_start)} />
                            <Row k="Period end" v={fmtISO(selected.current_period_end)} />
                            <Row k="Trial ends" v={fmtISO(selected.trial_ends_at)} />
                            <Row k="Cancel at" v={fmtISO(selected.cancel_at)} />
                            <Row k="Ended at" v={fmtISO(selected.ended_at)} />
                          </div>

                          <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                            <div className="text-[10px] uppercase tracking-[0.22em] text-white/35">metadata</div>
                            <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-white/70">
                              {(() => {
                                try {
                                  return JSON.stringify(selected.metadata ?? {}, null, 2);
                                } catch {
                                  return "—";
                                }
                              })()}
                            </pre>
                          </div>

                          <div className="text-[10px] text-white/35">
                            Entity-safe • Lane-safe • No hardcoded names • Read-only
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="border-t border-white/10 p-3 text-[10px] text-white/35">
                      Source: public.billing_subscriptions • entity_id={shortUUID(entityId)} • lane={envLabel}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Optional: Monthly usage view (if present) — we keep it dormant, no regressions */}
            <div className="mt-5 rounded-3xl border border-white/10 bg-black/20 px-4 py-3 text-[11px] text-slate-400">
              <div className="font-semibold text-slate-200">Next (Phase-2, optional)</div>
              <div className="mt-1 leading-relaxed text-slate-400">
                You already have <span className="text-slate-200 font-semibold">v_billing_usage_monthly</span>. We can
                surface it as a History tab once entity_id resolution is stable everywhere. No enforcement until you
                explicitly turn it on.
              </div>
            </div>
          </div>
        </div>

        <div className="mt-4 text-[10px] text-white/35">
          CI-Billing is operator-only visibility. Mutations/invoices come later via dedicated Edge Functions + archive-grade
          receipts (lane-safe, verifiable).
        </div>
      </div>
    </div>
  );
}
