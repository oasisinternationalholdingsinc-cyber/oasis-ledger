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

  created_at: string | null;
  updated_at: string | null;

  lane_is_test?: boolean | null;
};

type EventRow = {
  id: string;
  application_id: string;
  event_type: string | null;
  note: string | null;
  created_at: string | null;
  metadata: any | null;
};

type DecisionRow = {
  id: string;
  application_id: string;
  decision: string | null;
  risk_tier: string | null;
  summary: string | null;
  reason: string | null;
  created_at: string | null;
  decided_by: string | null;
};

type TaskRow = {
  id: string;
  application_id: string;
  task_key: string | null;
  title: string | null;
  status: string | null;
  due_at: string | null;
  completed_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  metadata: any | null;
};

type ScopeTab = "BOTH" | "INTAKE" | "PROVISIONED";
type StatusTab = "ALL" | "NEEDS_INFO" | "ARCHIVED";

function Badge({ text }: { text: string }) {
  return (
    <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-medium text-white/70">
      {text}
    </span>
  );
}

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

export default function AdmissionsAuthorityConsole() {
  // ✅ Entity (defensive — matches CI-Evidence)
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

  // ✅ Lane (defensive — matches CI-Evidence)
  const env = useOsEnv() as any;
  const isTest: boolean = Boolean(env?.is_test ?? env?.isTest ?? env?.lane_is_test ?? env?.sandbox ?? env?.isSandbox);

  const [rows, setRows] = useState<InboxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [scope, setScope] = useState<ScopeTab>("BOTH");
  const [statusTab, setStatusTab] = useState<StatusTab>("ALL");
  const [q, setQ] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [events, setEvents] = useState<EventRow[]>([]);
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [sideErr, setSideErr] = useState<string | null>(null);
  const [sideLoading, setSideLoading] = useState(false);

  const selected = useMemo(() => rows.find((r) => r.id === selectedId) || null, [rows, selectedId]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = rows;

    // scope tabs
    if (scope === "INTAKE") {
      const allow = new Set(["SUBMITTED", "IN_REVIEW", "NEEDS_INFO"]);
      list = list.filter((r) => allow.has(normStatus(r.status)));
    } else if (scope === "PROVISIONED") {
      const allow = new Set(["PROVISIONED"]);
      list = list.filter((r) => allow.has(normStatus(r.status)));
    }

    // status tabs
    if (statusTab === "NEEDS_INFO") list = list.filter((r) => normStatus(r.status) === "NEEDS_INFO");
    if (statusTab === "ARCHIVED") list = list.filter((r) => normStatus(r.status) === "ARCHIVED");

    if (!needle) return list;

    return list.filter((r) => {
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
  }, [rows, q, scope, statusTab]);

  // -------- load queue (entity + lane scoped, lane fallback) --------
  useEffect(() => {
    let alive = true;

    (async () => {
      setLoading(true);
      setErr(null);

      try {
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

        const tryWithLane = async () => {
          const { data, error } = await supabase
            .from("v_onboarding_admissions_inbox")
            .select([...baseCols, "lane_is_test"].join(","))
            .eq("entity_slug", entityKey)
            .eq("lane_is_test", isTest)
            .order("created_at", { ascending: false });
          return { data, error };
        };

        const tryWithoutLane = async () => {
          const { data, error } = await supabase
            .from("v_onboarding_admissions_inbox")
            .select(baseCols.join(","))
            .eq("entity_slug", entityKey)
            .order("created_at", { ascending: false });
          return { data, error };
        };

        let res = await tryWithLane();
        if (res.error && /lane_is_test|42703|undefined column/i.test(res.error.message)) {
          res = await tryWithoutLane();
        }

        if (res.error) throw res.error;
        if (!alive) return;

        const next = (res.data || []) as InboxRow[];
        setRows(next);

        if (!selectedId && next.length) setSelectedId(next[0].id);
        else if (selectedId && !next.some((x) => x.id === selectedId)) setSelectedId(next[0]?.id ?? null);
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

  // -------- load right panel (events/decisions/tasks) --------
  useEffect(() => {
    let alive = true;

    (async () => {
      setEvents([]);
      setDecisions([]);
      setTasks([]);
      setSideErr(null);

      if (!selectedId) return;

      setSideLoading(true);
      try {
        // Events (optional table)
        const ev = await supabase
          .from("onboarding_events")
          .select(["id", "application_id", "event_type", "note", "created_at", "metadata"].join(","))
          .eq("application_id", selectedId)
          .order("created_at", { ascending: false });

        // Decisions (optional table)
        const dc = await supabase
          .from("onboarding_decisions")
          .select(["id", "application_id", "decision", "risk_tier", "summary", "reason", "created_at", "decided_by"].join(","))
          .eq("application_id", selectedId)
          .order("created_at", { ascending: false });

        // Tasks (optional table)
        const tk = await supabase
          .from("onboarding_provisioning_tasks")
          .select(["id", "application_id", "task_key", "title", "status", "due_at", "completed_at", "created_at", "updated_at", "metadata"].join(","))
          .eq("application_id", selectedId)
          .order("created_at", { ascending: false });

        if (!alive) return;

        // These tables may not exist in every env; tolerate missing relations.
        if (!ev.error) setEvents((ev.data || []) as any);
        if (!dc.error) setDecisions((dc.data || []) as any);
        if (!tk.error) setTasks((tk.data || []) as any);
      } catch (e: any) {
        if (!alive) return;
        setSideErr(e?.message || "Failed to load authority panel data.");
      } finally {
        if (!alive) return;
        setSideLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [selectedId, refreshKey]);

  // ---------------- RPC actions (NO raw updates) ----------------
  async function beginReview() {
    if (!selectedId) return;
    const { error } = await supabase.rpc("admissions_begin_review", { p_application_id: selectedId });
    if (error) return alert(error.message);
    setRefreshKey((n) => n + 1);
  }

  async function setStatus(next: "NEEDS_INFO" | "ARCHIVED") {
    if (!selectedId) return;
    const note =
      next === "NEEDS_INFO"
        ? "Needs additional information before admission can proceed."
        : "Soft-archived by operator.";
    const { error } = await supabase.rpc("admissions_set_status", {
      p_application_id: selectedId,
      p_next_status: next,
      p_note: note,
    });
    if (error) return alert(error.message);
    setRefreshKey((n) => n + 1);
  }

  async function approveForProvisioning() {
    if (!selectedId) return;
    const { error } = await supabase.rpc("admissions_record_decision", {
      p_application_id: selectedId,
      p_decision: "APPROVED",
      p_risk_tier: "medium",
      p_summary: "Approved for sandbox testing and provisioning.",
      p_reason: "Operator approved for controlled onboarding test.",
    });
    if (error) return alert(error.message);
    setRefreshKey((n) => n + 1);
  }

  async function hardDelete() {
    if (!selectedId) return;
    const reason = "Operator hard delete (guarded).";
    const ok = confirm("Hard delete is irreversible. Continue?");
    if (!ok) return;
    const { error } = await supabase.rpc("admissions_delete_application", {
      p_application_id: selectedId,
      p_reason: reason,
    });
    if (error) return alert(error.message);
    setSelectedId(null);
    setRefreshKey((n) => n + 1);
  }

  const title = useMemo(() => {
    if (!selected) return "No application selected";
    return (
      selected.organization_trade_name ||
      selected.organization_legal_name ||
      selected.applicant_email ||
      selected.id
    );
  }, [selected]);

  return (
    <div className="h-full w-full">
      <div className="mx-auto w-full max-w-[1500px] px-4 pb-10 pt-6">
        <div className="mb-5 flex items-end justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.28em] text-white/45">CI • Admissions</div>
            <div className="mt-1 text-2xl font-semibold text-white/90">Admissions · Authority Console</div>
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
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs font-semibold tracking-wide text-white/80">Queue</div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => setStatusTab("ALL")}
                      className={cx(
                        "rounded-full px-3 py-1 text-[11px] font-medium",
                        statusTab === "ALL"
                          ? "bg-white/8 text-white/85 ring-1 ring-white/12"
                          : "text-white/55 hover:text-white/75"
                      )}
                    >
                      All
                    </button>
                    <button
                      onClick={() => setStatusTab("NEEDS_INFO")}
                      className={cx(
                        "rounded-full px-3 py-1 text-[11px] font-medium",
                        statusTab === "NEEDS_INFO"
                          ? "bg-amber-400/10 text-amber-200 ring-1 ring-amber-300/20"
                          : "text-white/55 hover:text-white/75"
                      )}
                    >
                      Needs_Info
                    </button>
                    <button
                      onClick={() => setStatusTab("ARCHIVED")}
                      className={cx(
                        "rounded-full px-3 py-1 text-[11px] font-medium",
                        statusTab === "ARCHIVED"
                          ? "bg-white/8 text-white/85 ring-1 ring-white/12"
                          : "text-white/55 hover:text-white/75"
                      )}
                    >
                      Archived
                    </button>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {(["BOTH", "INTAKE", "PROVISIONED"] as ScopeTab[]).map((t) => (
                    <button
                      key={t}
                      onClick={() => setScope(t)}
                      className={cx(
                        "rounded-full px-3 py-1 text-[11px] font-medium",
                        scope === t
                          ? "bg-emerald-400/10 text-emerald-200 ring-1 ring-emerald-300/20"
                          : "text-white/55 hover:text-white/75"
                      )}
                    >
                      {t}
                    </button>
                  ))}
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
                      const name = a.organization_trade_name || a.organization_legal_name || a.applicant_email || a.id;
                      const st = a.status || "—";
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
                            <Badge text={st} />
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Middle: Snapshot */}
          <div className="col-span-12 lg:col-span-5">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-xs font-semibold tracking-wide text-white/80">Application</div>
                    <div className="mt-1 truncate text-sm text-white/60">{selected ? title : "Select an application"}</div>
                  </div>
                  {selected?.status ? <Badge text={selected.status} /> : null}
                </div>
              </div>

              <div className="p-4">
                {!selected ? (
                  <div className="text-sm text-white/50">Select an application to view details.</div>
                ) : (
                  <div className="space-y-4">
                    <div className="space-y-3 rounded-2xl border border-white/10 bg-black/20 p-4">
                      <Row k="Org (Legal)" v={selected.organization_legal_name || "—"} />
                      <Row k="Org (Trade)" v={selected.organization_trade_name || "—"} />
                      <Row k="Applicant" v={selected.applicant_email || "—"} />
                      <Row k="Org Email" v={selected.organization_email || "—"} />
                      <Row k="Type" v={selected.applicant_type || "—"} />
                      <Row k="App ID" v={selected.id} mono />
                      <Row k="Created" v={selected.created_at || "—"} />
                      <Row k="Updated" v={selected.updated_at || "—"} />
                    </div>

                    <div className="rounded-2xl border border-white/10 bg-black/18 p-4">
                      <div className="mb-2 text-xs font-semibold tracking-wide text-white/80">Read-only</div>
                      <div className="text-sm text-white/55">
                        Admissions is authority-only. Invite/activation is handled in CI-Provisioning. Evidence review is separate.
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right: Authority Panel */}
          <div className="col-span-12 lg:col-span-3">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="text-xs font-semibold tracking-wide text-white/80">Authority Panel</div>
                <div className="mt-1 text-sm text-white/55">Review · Decisions · Archive</div>
              </div>

              <div className="p-4">
                {!selected ? (
                  <div className="text-sm text-white/50">Select an application.</div>
                ) : (
                  <>
                    <div className="grid grid-cols-1 gap-2">
                      <button
                        onClick={beginReview}
                        className="rounded-2xl border border-emerald-300/20 bg-emerald-400/10 px-4 py-3 text-sm font-semibold text-emerald-200 hover:bg-emerald-400/14"
                      >
                        Begin Review
                      </button>

                      <button
                        onClick={approveForProvisioning}
                        className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-semibold text-white/85 hover:border-amber-300/20 hover:bg-white/7"
                      >
                        Approve (for Provisioning)
                      </button>

                      <button
                        onClick={() => setStatus("NEEDS_INFO")}
                        className="rounded-2xl border border-amber-300/20 bg-amber-400/10 px-4 py-3 text-sm font-semibold text-amber-200 hover:bg-amber-400/14"
                      >
                        Needs Info
                      </button>

                      <button
                        onClick={() => setStatus("ARCHIVED")}
                        className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-semibold text-white/70 hover:bg-white/7"
                      >
                        Archive (soft)
                      </button>

                      <button
                        onClick={hardDelete}
                        className="rounded-2xl border border-rose-300/20 bg-rose-400/10 px-4 py-3 text-sm font-semibold text-rose-200 hover:bg-rose-400/14"
                      >
                        Hard Delete
                      </button>
                    </div>

                    <div className="mt-4 rounded-2xl border border-white/10 bg-black/18 p-3">
                      <div className="text-[11px] uppercase tracking-[0.22em] text-white/45">Audit Trail</div>
                      <div className="mt-2 text-xs text-white/55">
                        {sideLoading ? (
                          "Loading…"
                        ) : sideErr ? (
                          <span className="text-rose-200">{sideErr}</span>
                        ) : (
                          <>
                            Events: <span className="text-white/75">{events.length}</span> · Decisions:{" "}
                            <span className="text-white/75">{decisions.length}</span> · Tasks:{" "}
                            <span className="text-white/75">{tasks.length}</span>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="mt-3 text-xs text-white/40">
                      Mutations are RPC-only. No raw updates.
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
