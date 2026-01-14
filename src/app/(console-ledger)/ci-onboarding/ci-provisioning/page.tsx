// src/app/(console-ledger)/ci-onboarding/ci-provisioning/page.tsx
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

  // may exist on view, but not guaranteed (keep optional)
  primary_contact_user_id?: string | null;
};

type AppCore = {
  id: string;
  status: string | null;
  organization_legal_name: string | null;
  organization_trade_name: string | null;
  applicant_email: string | null;
  organization_email: string | null;

  // these exist in your table (based on your screenshots / flow)
  primary_contact_user_id?: string | null;
  intake_entity_id?: string | null;

  // optional / may or may not exist
  decided_at?: string | null;
  decided_by?: string | null;
  assigned_to?: string | null;
  metadata?: any | null;
};

type EvidenceRow = {
  id: string;
  application_id: string;
  kind: string;
  title: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
  file_name: string | null;
  mime_type: string | null;
  file_hash: string | null;
  size_bytes: number | null;
  uploaded_at: string | null;
  is_verified: boolean | null;
  verified_at: string | null;
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

type Tab = "READY" | "ALL";

export default function CiProvisioningPage() {
  // Entity (defensive — matches CI-Evidence approach)
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

  // Lane (defensive — matches CI-Evidence approach)
  const env = useOsEnv() as any;
  const isTest: boolean = Boolean(env?.is_test ?? env?.isTest ?? env?.lane_is_test ?? env?.sandbox ?? env?.isSandbox);

  const [apps, setApps] = useState<InboxRow[]>([]);
  const [appsLoading, setAppsLoading] = useState(true);
  const [appsErr, setAppsErr] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>("READY");
  const [q, setQ] = useState("");

  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);

  const [appCore, setAppCore] = useState<AppCore | null>(null);
  const [coreErr, setCoreErr] = useState<string | null>(null);
  const [coreLoading, setCoreLoading] = useState(false);

  const [evidence, setEvidence] = useState<EvidenceRow[]>([]);
  const [evErr, setEvErr] = useState<string | null>(null);
  const [evLoading, setEvLoading] = useState(false);

  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [taskErr, setTaskErr] = useState<string | null>(null);
  const [taskLoading, setTaskLoading] = useState(false);

  const [refreshKey, setRefreshKey] = useState(0);
  const [busy, setBusy] = useState(false);

  // ---------- filtered apps ----------
  const filteredApps = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let rows = apps;

    if (tab === "READY") {
      // “Ready for provisioning” typically means: approved / provisioning / needs_info (depending on your ops)
      // We keep it permissive and let you control via UI.
      const allow = new Set(["APPROVED", "PROVISIONING", "PROVISIONED"]);
      rows = rows.filter((r) => allow.has(normStatus(r.status)));
    }

    if (!needle) return rows;

    return rows.filter((r) => {
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
  }, [apps, q, tab]);

  // ---------- load applications (entity + lane scoped) ----------
  useEffect(() => {
    let alive = true;

    (async () => {
      setAppsLoading(true);
      setAppsErr(null);

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

        const rows = (res.data || []) as InboxRow[];
        setApps(rows);

        if (!selectedAppId && rows.length) {
          setSelectedAppId(rows[0].id);
        } else if (selectedAppId && !rows.some((r) => r.id === selectedAppId)) {
          setSelectedAppId(rows[0]?.id ?? null);
        }
      } catch (e: any) {
        if (!alive) return;
        setAppsErr(e?.message || "Failed to load applications.");
      } finally {
        if (!alive) return;
        setAppsLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityKey, isTest, refreshKey]);

  // ---------- load selected application core row (table) ----------
  useEffect(() => {
    let alive = true;

    (async () => {
      setAppCore(null);
      setCoreErr(null);
      if (!selectedAppId) return;

      setCoreLoading(true);
      try {
        // Keep this minimal + tolerant (your schema has drift history)
        const cols = [
          "id",
          "status",
          "organization_legal_name",
          "organization_trade_name",
          "applicant_email",
          "organization_email",
          "primary_contact_user_id",
          "intake_entity_id",
          "decided_at",
          "decided_by",
          "assigned_to",
          "metadata",
        ].join(",");

        const { data, error } = await supabase.from("onboarding_applications").select(cols).eq("id", selectedAppId).single();

        if (error) throw error;
        if (!alive) return;

        setAppCore((data || null) as AppCore | null);
      } catch (e: any) {
        if (!alive) return;
        setCoreErr(e?.message || "Failed to load application row.");
      } finally {
        if (!alive) return;
        setCoreLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [selectedAppId, refreshKey]);

  // ---------- load evidence ----------
  useEffect(() => {
    let alive = true;

    (async () => {
      setEvidence([]);
      setEvErr(null);
      if (!selectedAppId) return;

      setEvLoading(true);
      try {
        const { data, error } = await supabase
          .from("onboarding_evidence")
          .select(
            [
              "id",
              "application_id",
              "kind",
              "title",
              "storage_bucket",
              "storage_path",
              "file_name",
              "mime_type",
              "file_hash",
              "size_bytes",
              "uploaded_at",
              "is_verified",
              "verified_at",
            ].join(",")
          )
          .eq("application_id", selectedAppId)
          .order("uploaded_at", { ascending: false });

        if (error) throw error;
        if (!alive) return;

        setEvidence((data || []) as EvidenceRow[]);
      } catch (e: any) {
        if (!alive) return;
        setEvErr(e?.message || "Failed to load evidence.");
      } finally {
        if (!alive) return;
        setEvLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [selectedAppId, refreshKey]);

  // ---------- load provisioning tasks ----------
  useEffect(() => {
    let alive = true;

    (async () => {
      setTasks([]);
      setTaskErr(null);
      if (!selectedAppId) return;

      setTaskLoading(true);
      try {
        const { data, error } = await supabase
          .from("onboarding_provisioning_tasks")
          .select(
            [
              "id",
              "application_id",
              "task_key",
              "title",
              "status",
              "due_at",
              "completed_at",
              "created_at",
              "updated_at",
              "metadata",
            ].join(",")
          )
          .eq("application_id", selectedAppId)
          .order("created_at", { ascending: true });

        if (error) throw error;
        if (!alive) return;

        setTasks((data || []) as TaskRow[]);
      } catch (e: any) {
        if (!alive) return;
        setTaskErr(e?.message || "Failed to load provisioning tasks.");
      } finally {
        if (!alive) return;
        setTaskLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [selectedAppId, refreshKey]);

  const selectedApp = useMemo(() => apps.find((a) => a.id === selectedAppId) || null, [apps, selectedAppId]);

  const appTitle = useMemo(() => {
    if (!selectedApp) return "No application selected";
    return selectedApp.organization_trade_name || selectedApp.organization_legal_name || selectedApp.applicant_email || selectedApp.id;
  }, [selectedApp]);

  const evidenceStats = useMemo(() => {
    const total = evidence.length;
    const verified = evidence.filter((e) => !!e.is_verified).length;
    return { total, verified, pending: Math.max(0, total - verified) };
  }, [evidence]);

  const taskStats = useMemo(() => {
    const total = tasks.length;
    const done = tasks.filter((t) => normStatus(t.status) === "DONE" || normStatus(t.status) === "COMPLETED").length;
    const open = Math.max(0, total - done);
    return { total, done, open };
  }, [tasks]);

  const status = normStatus(appCore?.status || selectedApp?.status);
  const hasUser = Boolean(appCore?.primary_contact_user_id);
  const alreadyProvisioned = status === "PROVISIONED";

  // Suggested readiness: approved/provisioning + has user + at least 1 evidence (you can tighten later)
  const looksReady =
    (status === "APPROVED" || status === "PROVISIONING" || status === "PROVISIONED") &&
    hasUser &&
    evidenceStats.total >= 1;

  async function completeProvisioning() {
    if (!selectedAppId) return;
    const userId = appCore?.primary_contact_user_id || null;

    if (!userId) {
      alert("No primary_contact_user_id on this application yet. Run Invite / Set Password first.");
      return;
    }

    // guard: allow but confirm if it “doesn’t look ready”
    if (!looksReady && !alreadyProvisioned) {
      const ok = window.confirm(
        "This application does not look fully ready (missing evidence or status). Complete provisioning anyway?"
      );
      if (!ok) return;
    }

    setBusy(true);
    try {
      const { error } = await supabase.rpc("admissions_complete_provisioning", {
        p_application_id: selectedAppId,
        p_user_id: userId,
      });

      if (error) throw error;

      // refresh everything
      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "Complete provisioning failed.");
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(next: "NEEDS_INFO" | "PROVISIONING" | "ARCHIVED") {
    if (!selectedAppId) return;

    const map: Record<string, string> = {
      NEEDS_INFO: "needs_info",
      PROVISIONING: "provisioning",
      ARCHIVED: "archived",
    };

    const note =
      next === "NEEDS_INFO"
        ? "Requesting additional information prior to provisioning."
        : next === "PROVISIONING"
        ? "Marked provisioning in progress."
        : "Archived from active queue.";

    setBusy(true);
    try {
      const { error } = await supabase.rpc("admissions_set_status", {
        p_application_id: selectedAppId,
        p_next_status: map[next],
        p_note: note,
      });
      if (error) throw error;
      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "Status update failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full w-full">
      <div className="mx-auto w-full max-w-[1400px] px-4 pb-10 pt-6">
        <div className="mb-5 flex items-end justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.28em] text-white/45">CI • Provisioning</div>
            <div className="mt-1 text-2xl font-semibold text-white/90">Provision & Activate</div>
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
          {/* Left: Applications */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-semibold tracking-wide text-white/80">Applications</div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setTab("READY")}
                      className={cx(
                        "rounded-full px-3 py-1 text-[11px] font-medium",
                        tab === "READY"
                          ? "bg-amber-300/10 text-amber-100 ring-1 ring-amber-300/20"
                          : "text-white/55 hover:text-white/75"
                      )}
                    >
                      Ready
                    </button>
                    <button
                      onClick={() => setTab("ALL")}
                      className={cx(
                        "rounded-full px-3 py-1 text-[11px] font-medium",
                        tab === "ALL"
                          ? "bg-white/8 text-white/85 ring-1 ring-white/12"
                          : "text-white/55 hover:text-white/75"
                      )}
                    >
                      All
                    </button>
                  </div>
                </div>

                <div className="mt-3">
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search org / email / status"
                    className="w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-2 text-sm text-white/85 placeholder:text-white/35 outline-none focus:border-amber-300/25"
                  />
                </div>
              </div>

              <div className="max-h-[560px] overflow-auto p-2">
                {appsLoading ? (
                  <div className="p-4 text-sm text-white/50">Loading…</div>
                ) : appsErr ? (
                  <div className="p-4 text-sm text-rose-200">{appsErr}</div>
                ) : filteredApps.length === 0 ? (
                  <div className="p-4 text-sm text-white/50">No applications found.</div>
                ) : (
                  <div className="space-y-2 p-2">
                    {filteredApps.map((a) => {
                      const active = a.id === selectedAppId;
                      const name = a.organization_trade_name || a.organization_legal_name || a.applicant_email || a.id;
                      const st = a.status || "—";
                      return (
                        <button
                          key={a.id}
                          onClick={() => setSelectedAppId(a.id)}
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
                              {st}
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

          {/* Middle: Readiness */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="text-xs font-semibold tracking-wide text-white/80">Readiness</div>
                <div className="mt-1 truncate text-sm text-white/60">{selectedAppId ? appTitle : "Select an application"}</div>
              </div>

              <div className="p-4">
                {!selectedAppId ? (
                  <div className="text-sm text-white/50">Select an application to inspect provisioning readiness.</div>
                ) : coreLoading ? (
                  <div className="text-sm text-white/50">Loading…</div>
                ) : coreErr ? (
                  <div className="text-sm text-rose-200">{coreErr}</div>
                ) : (
                  <>
                    <div className="space-y-3 rounded-2xl border border-white/10 bg-black/20 p-4">
                      <Row k="Status" v={appCore?.status || selectedApp?.status || "—"} />
                      <Row k="Applicant" v={appCore?.applicant_email || selectedApp?.applicant_email || "—"} />
                      <Row k="Org Email" v={appCore?.organization_email || selectedApp?.organization_email || "—"} />
                      <Row
                        k="Primary User"
                        v={appCore?.primary_contact_user_id ? "PRESENT" : "MISSING"}
                      />
                      <Row k="User ID" v={appCore?.primary_contact_user_id || "—"} mono />
                      <Row k="Evidence" v={`${evidenceStats.total} total • ${evidenceStats.verified} verified`} />
                      <Row k="Tasks" v={`${taskStats.total} total • ${taskStats.done} done`} />
                    </div>

                    <div className="mt-4 grid grid-cols-2 gap-2">
                      <div className="rounded-2xl border border-white/10 bg-black/18 p-4">
                        <div className="text-[11px] uppercase tracking-[0.22em] text-white/35">Evidence</div>
                        <div className="mt-2 text-lg font-semibold text-white/85">{evidenceStats.total}</div>
                        <div className="mt-1 text-xs text-white/45">
                          {evLoading ? "Loading…" : evErr ? evErr : `${evidenceStats.verified} verified • ${evidenceStats.pending} pending`}
                        </div>
                      </div>

                      <div className="rounded-2xl border border-white/10 bg-black/18 p-4">
                        <div className="text-[11px] uppercase tracking-[0.22em] text-white/35">Provisioning Tasks</div>
                        <div className="mt-2 text-lg font-semibold text-white/85">{taskStats.open}</div>
                        <div className="mt-1 text-xs text-white/45">
                          {taskLoading ? "Loading…" : taskErr ? taskErr : `${taskStats.done} completed • ${taskStats.total} total`}
                        </div>
                      </div>
                    </div>

                    <div className="mt-4">
                      <div className="text-[11px] uppercase tracking-[0.22em] text-white/35">Task List</div>
                      <div className="mt-2 max-h-[220px] overflow-auto rounded-2xl border border-white/10 bg-black/15 p-2">
                        {taskLoading ? (
                          <div className="p-3 text-sm text-white/50">Loading…</div>
                        ) : taskErr ? (
                          <div className="p-3 text-sm text-rose-200">{taskErr}</div>
                        ) : tasks.length === 0 ? (
                          <div className="p-3 text-sm text-white/50">No provisioning tasks created.</div>
                        ) : (
                          <div className="space-y-2 p-2">
                            {tasks.map((t) => {
                              const st = normStatus(t.status);
                              const done = st === "DONE" || st === "COMPLETED";
                              return (
                                <div
                                  key={t.id}
                                  className={cx(
                                    "rounded-2xl border px-3 py-3",
                                    done ? "border-emerald-300/15 bg-emerald-400/5" : "border-white/10 bg-black/18"
                                  )}
                                >
                                  <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <div className="truncate text-sm font-semibold text-white/85">
                                        {t.title || t.task_key || "Task"}
                                      </div>
                                      <div className="mt-1 truncate text-xs text-white/45">
                                        {t.task_key || "—"} {t.due_at ? `• due ${t.due_at}` : ""}
                                      </div>
                                    </div>
                                    <span
                                      className={cx(
                                        "rounded-full border px-3 py-1 text-[11px] font-medium",
                                        done
                                          ? "border-emerald-300/20 bg-emerald-400/10 text-emerald-200"
                                          : "border-white/10 bg-white/5 text-white/65"
                                      )}
                                    >
                                      {t.status || "—"}
                                    </span>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="pt-3 text-xs text-white/40">
                      Provisioning is the **activation gate**. Invite/Set-Password can allow portal access, but **entity + memberships**
                      are only created when provisioning is completed.
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
                <div className="text-xs font-semibold tracking-wide text-white/80">Authority</div>
                <div className="mt-1 truncate text-sm text-white/60">{selectedAppId ? appTitle : "Select an application"}</div>
              </div>

              <div className="p-4">
                {!selectedAppId ? (
                  <div className="text-sm text-white/50">Select an application to run provisioning actions.</div>
                ) : (
                  <>
                    <div className="space-y-3 rounded-2xl border border-white/10 bg-black/20 p-4">
                      <Row k="Looks Ready" v={looksReady ? "YES" : "NO"} />
                      <Row k="Has User Session" v={hasUser ? "YES" : "NO"} />
                      <Row k="Provisioned" v={alreadyProvisioned ? "YES" : "NO"} />
                      <Row k="App ID" v={selectedAppId} mono />
                    </div>

                    <div className="mt-4 flex flex-col gap-2">
                      <button
                        onClick={completeProvisioning}
                        disabled={busy || alreadyProvisioned || !hasUser}
                        className={cx(
                          "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                          alreadyProvisioned
                            ? "cursor-not-allowed border-emerald-300/15 bg-emerald-400/5 text-emerald-200/50"
                            : !hasUser
                            ? "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                            : "border-amber-300/20 bg-amber-300/10 text-amber-100 hover:bg-amber-300/14"
                        )}
                      >
                        {alreadyProvisioned ? "Already Provisioned" : busy ? "Working…" : "Complete Provisioning"}
                      </button>

                      <div className="grid grid-cols-3 gap-2">
                        <button
                          onClick={() => setStatus("NEEDS_INFO")}
                          disabled={busy}
                          className={cx(
                            "rounded-2xl border px-3 py-3 text-sm font-semibold transition",
                            busy
                              ? "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                              : "border-white/10 bg-white/5 text-white/80 hover:border-amber-300/20 hover:bg-white/7"
                          )}
                        >
                          Needs Info
                        </button>

                        <button
                          onClick={() => setStatus("PROVISIONING")}
                          disabled={busy}
                          className={cx(
                            "rounded-2xl border px-3 py-3 text-sm font-semibold transition",
                            busy
                              ? "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                              : "border-white/10 bg-white/5 text-white/80 hover:border-amber-300/20 hover:bg-white/7"
                          )}
                        >
                          Provisioning
                        </button>

                        <button
                          onClick={() => setStatus("ARCHIVED")}
                          disabled={busy}
                          className={cx(
                            "rounded-2xl border px-3 py-3 text-sm font-semibold transition",
                            busy
                              ? "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                              : "border-rose-300/20 bg-rose-400/10 text-rose-200 hover:bg-rose-400/14"
                          )}
                        >
                          Archive
                        </button>
                      </div>

                      <div className="pt-2 text-xs text-white/40">
                        RPC-only controls. <span className="text-white/60">Complete Provisioning</span> calls{" "}
                        <span className="font-mono text-white/60">admissions_complete_provisioning(app_id, user_id)</span>.
                      </div>

                      {!hasUser && (
                        <div className="mt-1 rounded-2xl border border-amber-300/20 bg-amber-300/10 p-3 text-xs text-amber-100/90">
                          Missing <span className="font-mono">primary_contact_user_id</span>. This is normally set after Invite → Set Password.
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-5 text-[10px] text-white/35">
          Source: public.v_onboarding_admissions_inbox + public.onboarding_applications • entity_slug={entityKey} • lane={isTest ? "SANDBOX" : "RoT"}
        </div>
      </div>
    </div>
  );
}
