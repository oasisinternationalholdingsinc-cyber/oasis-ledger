// src/app/(console-ledger)/ci-onboarding/ci-admissions/page.tsx
"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";

function cx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function normStatus(s: string | null | undefined) {
  return (s || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
}

type InboxRow = {
  id: string;
  entity_id: string | null;
  entity_slug: string | null;

  status: string | null;
  applicant_type: string | null;

  organization_legal_name: string | null;
  organization_trade_name: string | null;

  applicant_email: string | null;
  organization_email: string | null;

  request?: string | null;
  notes?: string | null;
  applicant_name?: string | null;
  applicant_phone?: string | null;

  website?: string | null;
  incorporation_number?: string | null;
  jurisdiction_country?: string | null;
  jurisdiction_region?: string | null;

  requested_services?: any | null;

  submitted_at?: string | null;
  created_at: string | null;
  updated_at: string | null;

  lane_is_test?: boolean | null;
};

type Tab = "ALL" | "NEEDS_INFO" | "ARCHIVED";
type LaneTab = "BOTH" | "INTAKE" | "PROVISIONED";

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="text-xs uppercase tracking-[0.22em] text-white/35">{k}</div>
      <div
        className={cx(
          "max-w-[70%] text-right text-sm text-white/80",
          mono && "font-mono text-[12px] leading-5 text-white/70"
        )}
      >
        {v}
      </div>
    </div>
  );
}

async function rpcAlert(name: string, args: Record<string, any>) {
  const { error } = await supabase.rpc(name as any, args as any);
  if (error) throw error;
}

export default function AdmissionsAuthorityConsole() {
  // ✅ EntityContextValue varies across repo. Read defensively like CI-Evidence.
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

  // ✅ OsEnvContextValue varies. NEVER destructure isTest.
  const env = useOsEnv() as any;
  const isTest: boolean = Boolean(
    env?.is_test ?? env?.isTest ?? env?.lane_is_test ?? env?.sandbox ?? env?.isSandbox
  );

  const [rows, setRows] = useState<InboxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>("ALL");
  const [laneTab, setLaneTab] = useState<LaneTab>("BOTH");
  const [q, setQ] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(null);

  // lightweight audit counters (optional)
  const [audit, setAudit] = useState<{ events: number; decisions: number; tasks: number }>({
    events: 0,
    decisions: 0,
    tasks: 0,
  });

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const selected = useMemo(() => rows.find((r) => r.id === selectedId) || null, [rows, selectedId]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let out = rows;

    // top status tabs
    if (tab === "NEEDS_INFO") out = out.filter((r) => normStatus(r.status) === "NEEDS_INFO");
    if (tab === "ARCHIVED") out = out.filter((r) => normStatus(r.status) === "ARCHIVED");

    // lane-style queue tabs (intake vs provisioned)
    if (laneTab === "INTAKE") {
      const allow = new Set(["SUBMITTED", "IN_REVIEW", "NEEDS_INFO"]);
      out = out.filter((r) => allow.has(normStatus(r.status)));
    }
    if (laneTab === "PROVISIONED") out = out.filter((r) => normStatus(r.status) === "PROVISIONED");

    if (!needle) return out;

    return out.filter((r) => {
      const blob = [
        r.organization_legal_name,
        r.organization_trade_name,
        r.applicant_email,
        r.organization_email,
        r.status,
        r.applicant_type,
        r.id,
      ]
        .filter(Boolean)
        .join(" • ")
        .toLowerCase();
      return blob.includes(needle);
    });
  }, [rows, q, tab, laneTab]);

  // -------- load queue (entity + lane scoped) --------
  useEffect(() => {
    let alive = true;

    (async () => {
      setLoading(true);
      setErr(null);

      try {
        // core cols always expected
        const baseCols = [
          "id",
          "entity_id",
          "entity_slug",
          "status",
          "applicant_type",
          "organization_legal_name",
          "organization_trade_name",
          "applicant_email",
          "organization_email",
          "created_at",
          "updated_at",
        ];

        // optional enrichment (safe-fallback if view doesn't expose them)
        const optCols = [
          "request",
          "notes",
          "applicant_name",
          "applicant_phone",
          "website",
          "incorporation_number",
          "jurisdiction_country",
          "jurisdiction_region",
          "requested_services",
          "submitted_at",
        ];

        const tryWithLane = async () => {
          const { data, error } = await supabase
            .from("v_onboarding_admissions_inbox")
            .select([...baseCols, ...optCols, "lane_is_test"].join(","))
            .eq("entity_slug", entityKey)
            .eq("lane_is_test", isTest)
            .order("created_at", { ascending: false });

          return { data, error };
        };

        const tryWithoutLane = async () => {
          // first try with opt cols, then fall back to base only
          const { data, error } = await supabase
            .from("v_onboarding_admissions_inbox")
            .select([...baseCols, ...optCols].join(","))
            .eq("entity_slug", entityKey)
            .order("created_at", { ascending: false });

          // if opt cols not present, retry base only
          if (error && /42703|column|undefined/i.test(error.message)) {
            const r2 = await supabase
              .from("v_onboarding_admissions_inbox")
              .select(baseCols.join(","))
              .eq("entity_slug", entityKey)
              .order("created_at", { ascending: false });
            return { data: r2.data, error: r2.error };
          }

          return { data, error };
        };

        let res = await tryWithLane();

        // lane col missing? fall back safely
        if (res.error && /lane_is_test|42703|undefined column/i.test(res.error.message)) {
          res = await tryWithoutLane();
        } else if (res.error && /request|notes|applicant_name|applicant_phone|requested_services/i.test(res.error.message)) {
          // opt cols missing in view — retry without opt cols (still lane-safe)
          const { data, error } = await supabase
            .from("v_onboarding_admissions_inbox")
            .select([...baseCols, "lane_is_test"].join(","))
            .eq("entity_slug", entityKey)
            .eq("lane_is_test", isTest)
            .order("created_at", { ascending: false });
          res = { data, error };
        }

        if (res.error) throw res.error;
        if (!alive) return;

        const next = (res.data || []) as InboxRow[];
        setRows(next);

        if (!selectedId && next.length) setSelectedId(next[0].id);
        else if (selectedId && !next.some((r) => r.id === selectedId)) setSelectedId(next[0]?.id ?? null);
      } catch (e: any) {
        if (!alive) return;
        setErr(e?.message || "Failed to load admissions queue.");
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

  // -------- optional audit counts --------
  useEffect(() => {
    let alive = true;

    (async () => {
      if (!selectedId) {
        setAudit({ events: 0, decisions: 0, tasks: 0 });
        return;
      }

      // These may not exist or may be RLS-protected — treat as optional.
      const safeCount = async (table: string) => {
        try {
          const { count, error } = await supabase
            .from(table)
            .select("id", { count: "exact", head: true })
            .eq("application_id", selectedId);
          if (error) return 0;
          return count || 0;
        } catch {
          return 0;
        }
      };

      const [events, decisions, tasks] = await Promise.all([
        safeCount("onboarding_events"),
        safeCount("onboarding_decisions"),
        safeCount("onboarding_provisioning_tasks"),
      ]);

      if (!alive) return;
      setAudit({ events, decisions, tasks });
    })();

    return () => {
      alive = false;
    };
  }, [selectedId]);

  const title = useMemo(() => {
    if (!selected) return "No application selected";
    return (
      selected.organization_trade_name ||
      selected.organization_legal_name ||
      selected.applicant_email ||
      selected.id
    );
  }, [selected]);

  async function runAction(label: string, fn: () => Promise<void>) {
    if (!selected) return;
    setBusyAction(label);
    try {
      await fn();
      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "Action failed.");
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="h-full w-full">
      <div className="mx-auto w-full max-w-[1400px] px-4 pb-10 pt-6">
        <div className="mb-5 flex items-end justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.28em] text-white/45">CI • Admissions</div>
            <div className="mt-1 text-2xl font-semibold text-white/90">Admissions • Authority Console</div>
            <div className="mt-1 text-sm text-white/50">
              Entity-scoped: <span className="text-white/70">{entityName || entityKey}</span> • Lane:{" "}
              <span className="text-white/70">{isTest ? "SANDBOX" : "RoT"}</span>
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
          {/* Left: Queue */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-semibold tracking-wide text-white/80">Queue</div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setTab("ALL")}
                      className={cx(
                        "rounded-full px-3 py-1 text-[11px] font-medium",
                        tab === "ALL" ? "bg-white/8 text-white/85 ring-1 ring-white/12" : "text-white/55 hover:text-white/75"
                      )}
                    >
                      All
                    </button>
                    <button
                      onClick={() => setTab("NEEDS_INFO")}
                      className={cx(
                        "rounded-full px-3 py-1 text-[11px] font-medium",
                        tab === "NEEDS_INFO"
                          ? "bg-amber-400/10 text-amber-200 ring-1 ring-amber-300/20"
                          : "text-white/55 hover:text-white/75"
                      )}
                    >
                      Needs_Info
                    </button>
                    <button
                      onClick={() => setTab("ARCHIVED")}
                      className={cx(
                        "rounded-full px-3 py-1 text-[11px] font-medium",
                        tab === "ARCHIVED" ? "bg-white/8 text-white/85 ring-1 ring-white/12" : "text-white/55 hover:text-white/75"
                      )}
                    >
                      Archived
                    </button>
                  </div>
                </div>

                <div className="mt-3 flex items-center gap-2">
                  <button
                    onClick={() => setLaneTab("BOTH")}
                    className={cx(
                      "rounded-full px-3 py-1 text-[11px] font-medium",
                      laneTab === "BOTH"
                        ? "bg-emerald-400/10 text-emerald-200 ring-1 ring-emerald-300/20"
                        : "text-white/55 hover:text-white/75"
                    )}
                  >
                    BOTH
                  </button>
                  <button
                    onClick={() => setLaneTab("INTAKE")}
                    className={cx(
                      "rounded-full px-3 py-1 text-[11px] font-medium",
                      laneTab === "INTAKE" ? "bg-white/8 text-white/85 ring-1 ring-white/12" : "text-white/55 hover:text-white/75"
                    )}
                  >
                    INTAKE
                  </button>
                  <button
                    onClick={() => setLaneTab("PROVISIONED")}
                    className={cx(
                      "rounded-full px-3 py-1 text-[11px] font-medium",
                      laneTab === "PROVISIONED" ? "bg-white/8 text-white/85 ring-1 ring-white/12" : "text-white/55 hover:text-white/75"
                    )}
                  >
                    PROVISIONED
                  </button>
                </div>

                <div className="mt-3">
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search… applicant / org / email / status"
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
                      const name =
                        a.organization_trade_name || a.organization_legal_name || a.applicant_email || a.id;
                      const status = a.status || "—";

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
                            <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-medium text-white/70">
                              {status}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Middle: Application */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="text-xs font-semibold tracking-wide text-white/80">Application</div>
                <div className="mt-1 truncate text-sm text-white/60">{selected ? title : "Select an application"}</div>
              </div>

              <div className="p-4">
                {!selected ? (
                  <div className="text-sm text-white/50">Select an application to review.</div>
                ) : (
                  <>
                    <div className="mb-4 rounded-2xl border border-white/10 bg-black/20 p-4">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div className="text-xs font-semibold tracking-wide text-white/80">Core</div>
                        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-medium text-white/70">
                          {selected.status || "—"}
                        </span>
                      </div>

                      <div className="space-y-3">
                        <Row k="ORG (LEGAL)" v={selected.organization_legal_name || "—"} />
                        <Row k="ORG (TRADE)" v={selected.organization_trade_name || "—"} />
                        <Row k="APPLICANT" v={selected.applicant_email || "—"} />
                        <Row k="ORG EMAIL" v={selected.organization_email || "—"} />
                        <Row k="TYPE" v={selected.applicant_type || "—"} />
                        <Row k="APP ID" v={selected.id} mono />
                        <Row k="CREATED" v={selected.created_at || "—"} />
                        <Row k="UPDATED" v={selected.updated_at || "—"} />
                      </div>
                    </div>

                    {/* Optional: intake details (only shown when present in view) */}
                    {(selected.request || selected.notes || selected.applicant_name || selected.applicant_phone) && (
                      <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                        <div className="mb-3 text-xs font-semibold tracking-wide text-white/80">Intake</div>
                        <div className="space-y-3">
                          {selected.applicant_name ? <Row k="CONTACT" v={selected.applicant_name} /> : null}
                          {selected.applicant_phone ? <Row k="PHONE" v={selected.applicant_phone} /> : null}
                          {selected.website ? <Row k="WEBSITE" v={selected.website} /> : null}
                          {selected.incorporation_number ? <Row k="INC #" v={selected.incorporation_number} mono /> : null}
                          {(selected.jurisdiction_country || selected.jurisdiction_region) ? (
                            <Row
                              k="JURISDICTION"
                              v={[selected.jurisdiction_country, selected.jurisdiction_region].filter(Boolean).join(" • ")}
                            />
                          ) : null}
                        </div>

                        {selected.request ? (
                          <div className="mt-4 rounded-2xl border border-white/10 bg-black/25 p-4">
                            <div className="mb-2 text-[11px] uppercase tracking-[0.24em] text-white/45">Request</div>
                            <div className="whitespace-pre-wrap text-sm text-white/78">{selected.request}</div>
                          </div>
                        ) : null}

                        {selected.notes ? (
                          <div className="mt-3 rounded-2xl border border-white/10 bg-black/25 p-4">
                            <div className="mb-2 text-[11px] uppercase tracking-[0.24em] text-white/45">Notes</div>
                            <div className="whitespace-pre-wrap text-sm text-white/78">{selected.notes}</div>
                          </div>
                        ) : null}
                      </div>
                    )}

                    <div className="mt-4 text-xs text-white/40">
                      Read-only console surface. Evidence review is separate. Invite/activation happens in CI-Provisioning.
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Right: Authority */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="text-xs font-semibold tracking-wide text-white/80">Authority Panel</div>
                <div className="mt-1 truncate text-sm text-white/60">Review • Decisions • Archive</div>
              </div>

              <div className="p-4">
                {!selected ? (
                  <div className="text-sm text-white/50">Select an application.</div>
                ) : (
                  <>
                    <div className="space-y-2">
                      <button
                        disabled={!!busyAction}
                        onClick={() =>
                          runAction("BEGIN_REVIEW", async () => {
                            await rpcAlert("admissions_begin_review", { p_application_id: selected.id });
                          })
                        }
                        className={cx(
                          "w-full rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                          busyAction
                            ? "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                            : "border-emerald-300/20 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/14"
                        )}
                      >
                        Begin Review
                      </button>

                      <button
                        disabled={!!busyAction}
                        onClick={() =>
                          runAction("APPROVE", async () => {
                            await rpcAlert("admissions_record_decision", {
                              p_application_id: selected.id,
                              p_decision: "APPROVE",
                              p_risk_tier: "medium",
                              p_summary: "Approved for provisioning.",
                              p_reason: "Meets intake requirements.",
                            });
                          })
                        }
                        className={cx(
                          "w-full rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                          busyAction
                            ? "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                            : "border-white/10 bg-white/5 text-white/85 hover:border-amber-300/20 hover:bg-white/7"
                        )}
                      >
                        Approve (for Provisioning)
                      </button>

                      <button
                        disabled={!!busyAction}
                        onClick={() =>
                          runAction("NEEDS_INFO", async () => {
                            const msg = prompt("Message to applicant (NEEDS_INFO):", "Please provide additional documentation.");
                            if (!msg) return;
                            await rpcAlert("admissions_request_info", {
                              p_application_id: selected.id,
                              p_message: msg,
                              p_channels: ["email"],
                              p_due_at: null,
                              p_next_status: "NEEDS_INFO",
                            });
                          })
                        }
                        className={cx(
                          "w-full rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                          busyAction
                            ? "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                            : "border-amber-300/20 bg-amber-400/10 text-amber-200 hover:bg-amber-400/14"
                        )}
                      >
                        Needs Info
                      </button>

                      <button
                        disabled={!!busyAction}
                        onClick={() =>
                          runAction("ARCHIVE", async () => {
                            await rpcAlert("admissions_set_status", {
                              p_application_id: selected.id,
                              p_next_status: "ARCHIVED",
                              p_note: "Archived (soft).",
                            });
                          })
                        }
                        className={cx(
                          "w-full rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                          busyAction
                            ? "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                            : "border-white/10 bg-white/5 text-white/75 hover:bg-white/7"
                        )}
                      >
                        Archive (soft)
                      </button>

                      <button
                        disabled={!!busyAction}
                        onClick={() =>
                          runAction("HARD_DELETE", async () => {
                            const ok = confirm("Hard delete application? Only do this for terminal states.");
                            if (!ok) return;
                            const reason = prompt("Reason for delete:", "Cleanup / test data");
                            if (!reason) return;
                            await rpcAlert("admissions_delete_application", {
                              p_application_id: selected.id,
                              p_reason: reason,
                            });
                          })
                        }
                        className={cx(
                          "w-full rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                          busyAction
                            ? "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                            : "border-rose-300/20 bg-rose-400/10 text-rose-200 hover:bg-rose-400/14"
                        )}
                      >
                        Hard Delete
                      </button>
                    </div>

                    <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-4">
                      <div className="mb-2 text-[11px] uppercase tracking-[0.24em] text-white/45">Audit Trail</div>
                      <div className="text-xs text-white/55">
                        Events: <span className="text-white/75">{audit.events}</span> • Decisions:{" "}
                        <span className="text-white/75">{audit.decisions}</span> • Tasks:{" "}
                        <span className="text-white/75">{audit.tasks}</span>
                      </div>
                      <div className="mt-2 text-[11px] text-white/40">
                        Mutations are RPC-only. No raw updates.
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-5 text-[10px] text-white/35">
          Source: public.v_onboarding_admissions_inbox • entity_slug={entityKey} • lane={isTest ? "SANDBOX" : "RoT"}
        </div>
      </div>
    </div>
  );
}
