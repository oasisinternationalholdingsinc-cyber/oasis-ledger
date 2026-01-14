"use client";
export const dynamic = "force-dynamic";

/**
 * CI • PROVISIONING — Provision & Activate (PRISTINE / LANE-SAFE)
 * --------------------------------------------------------------
 * Queue surface: public.v_onboarding_admissions_inbox (entity + lane scoped)
 * State surface: public.onboarding_applications (primary_contact_user_id, status)
 *
 * Invite/Auth SHOULD live here (not in Admissions).
 * Complete provisioning can live here too (button disabled until user_id exists).
 *
 * NOTE: We intentionally do NOT query onboarding_applications.organization_email
 * because your DB threw: "column onboarding_applications.organization_email does not exist".
 */

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
  // NOTE: this exists on the VIEW; we never touch onboarding_applications.organization_email
  organization_email: string | null;
  created_at: string | null;
  updated_at: string | null;
  lane_is_test?: boolean | null;
};

type AppState = {
  id: string;
  status: string | null;
  primary_contact_user_id: string | null;
  submitted_at: string | null;
  updated_at: string | null;
};

type QueueTab = "READY" | "ALL";

export default function CiProvisioningPage() {
  // ✅ EntityContextValue: defensive read (same as CI-Evidence)
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

  // ✅ OsEnvContextValue: defensive read + label fallback (prevents “blank queue”)
  const env = useOsEnv() as any;
  const laneLabel = String(env?.lane ?? env?.os_env ?? env?.env ?? env?.label ?? env?.mode ?? "").toUpperCase();
  const isTest: boolean = Boolean(
    env?.is_test ?? env?.isTest ?? env?.lane_is_test ?? env?.sandbox ?? env?.isSandbox ?? (laneLabel === "SANDBOX")
  );

  const [apps, setApps] = useState<InboxRow[]>([]);
  const [appsLoading, setAppsLoading] = useState(true);
  const [appsErr, setAppsErr] = useState<string | null>(null);

  const [tab, setTab] = useState<QueueTab>("READY");
  const [q, setQ] = useState("");

  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const selectedApp = useMemo(
    () => apps.find((a) => a.id === selectedAppId) || null,
    [apps, selectedAppId]
  );

  const [laneFallbackUsed, setLaneFallbackUsed] = useState(false);

  const [appState, setAppState] = useState<AppState | null>(null);
  const [stateLoading, setStateLoading] = useState(false);
  const [stateErr, setStateErr] = useState<string | null>(null);

  const [busy, setBusy] = useState<null | "INVITE" | "COMPLETE">(null);

  const [refreshKey, setRefreshKey] = useState(0);

  const filteredApps = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let rows = apps;

    // READY = things we can/should invite + provision (approved / needs action)
    if (tab === "READY") {
      const allow = new Set(["APPROVED", "IN_REVIEW", "NEEDS_INFO", "SUBMITTED"]);
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

  // ----------------------------
  // LOAD QUEUE (VIEW) — lane-safe with fallback
  // ----------------------------
  useEffect(() => {
    let alive = true;

    (async () => {
      setAppsLoading(true);
      setAppsErr(null);
      setLaneFallbackUsed(false);

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

        // lane column missing? (same as CI-Evidence)
        if (res.error && /lane_is_test|42703|undefined column/i.test(res.error.message)) {
          res = await tryWithoutLane();
        }

        // lane exists but env boolean may be wrong: if 0 rows, retry without lane
        if (!res.error && (res.data?.length ?? 0) === 0) {
          const fb = await tryWithoutLane();
          if (!fb.error && (fb.data?.length ?? 0) > 0) {
            res = fb;
            setLaneFallbackUsed(true);
          }
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

  // ----------------------------
  // LOAD APP STATE (TABLE) — only fields we know are safe
  // ----------------------------
  useEffect(() => {
    let alive = true;

    (async () => {
      setAppState(null);
      setStateErr(null);

      if (!selectedAppId) return;

      setStateLoading(true);
      try {
        const { data, error } = await supabase
          .from("onboarding_applications")
          .select(["id", "status", "primary_contact_user_id", "submitted_at", "updated_at"].join(","))
          .eq("id", selectedAppId)
          .maybeSingle();

        if (error) throw error;
        if (!alive) return;

        setAppState((data || null) as AppState | null);
      } catch (e: any) {
        if (!alive) return;
        setStateErr(e?.message || "Failed to load provisioning state.");
      } finally {
        if (!alive) return;
        setStateLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [selectedAppId, refreshKey]);

  const title = useMemo(() => {
    if (!selectedApp) return "Select an application";
    return (
      selectedApp.organization_trade_name ||
      selectedApp.organization_legal_name ||
      selectedApp.applicant_email ||
      selectedApp.id
    );
  }, [selectedApp]);

  // ----------------------------
  // ACTIONS (Invite + Complete)
  // ----------------------------

  async function runInvite() {
    if (!selectedAppId) return;
    setBusy("INVITE");

    try {
      /**
       * IMPORTANT: keep wiring stable.
       * If your project uses a different function name, change ONLY the string below.
       * This is the standard we built around: an Edge Function that triggers Supabase Auth invite.
       */
      const { data, error } = await supabase.functions.invoke("admissions-provision-portal-access", {
        body: { application_id: selectedAppId },
      });

      if (error) throw error;

      // Optional: if function returns user_id, refresh state immediately
      // (primary_contact_user_id may still be null until Set Password completes)
      if (data?.user_id || data?.ok) {
        setRefreshKey((n) => n + 1);
      } else {
        setRefreshKey((n) => n + 1);
      }
    } catch (e: any) {
      alert(e?.message || "Invite failed.");
    } finally {
      setBusy(null);
    }
  }

  async function completeProvisioning() {
    if (!selectedAppId) return;
    if (!appState?.primary_contact_user_id) return;

    setBusy("COMPLETE");
    try {
      const { error } = await supabase.rpc("admissions_complete_provisioning", {
        p_application_id: selectedAppId,
        p_user_id: appState.primary_contact_user_id,
      });
      if (error) throw error;

      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "Complete provisioning failed.");
    } finally {
      setBusy(null);
    }
  }

  // ----------------------------
  // READINESS
  // ----------------------------
  const looksReady = useMemo(() => {
    const s = normStatus(appState?.status ?? selectedApp?.status);
    return s === "APPROVED" || s === "PROVISIONING" || s === "PROVISIONED";
  }, [appState?.status, selectedApp?.status]);

  const hasUserId = !!appState?.primary_contact_user_id;

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
              {laneFallbackUsed && (
                <span className="ml-2 rounded-full border border-amber-300/20 bg-amber-400/10 px-3 py-1 text-[11px] font-medium text-amber-200">
                  lane-mismatch fallback
                </span>
              )}
            </div>
          </div>

          <button
            onClick={() => setRefreshKey((n) => n + 1)}
            className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs font-medium text-white/80 hover:border-amber-300/20 hover:bg-white/7"
          >
            Refresh
          </button>
        </div>

        <div className="grid grid-cols-12 gap-4">
          {/* LEFT: applications */}
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
                          ? "bg-emerald-400/10 text-emerald-200 ring-1 ring-emerald-300/20"
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
                      const name =
                        a.organization_trade_name || a.organization_legal_name || a.applicant_email || a.id;
                      const status = a.status || "—";
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

          {/* MIDDLE: readiness */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="text-xs font-semibold tracking-wide text-white/80">Readiness</div>
                <div className="mt-1 truncate text-sm text-white/60">{selectedApp ? title : "Select an application"}</div>
              </div>

              <div className="p-4">
                {!selectedAppId ? (
                  <div className="text-sm text-white/50">Select an application to provision.</div>
                ) : stateLoading ? (
                  <div className="text-sm text-white/50">Loading…</div>
                ) : stateErr ? (
                  <div className="text-sm text-rose-200">{stateErr}</div>
                ) : (
                  <div className="space-y-3 rounded-2xl border border-white/10 bg-black/20 p-4">
                    <div className="flex items-center justify-between">
                      <div className="text-[11px] uppercase tracking-[0.22em] text-white/35">Looks ready</div>
                      <div className="text-sm font-semibold text-white/80">{looksReady ? "YES" : "NO"}</div>
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="text-[11px] uppercase tracking-[0.22em] text-white/35">Has user id</div>
                      <div className="text-sm font-semibold text-white/80">{hasUserId ? "YES" : "NO"}</div>
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="text-[11px] uppercase tracking-[0.22em] text-white/35">Provisioned</div>
                      <div className="text-sm font-semibold text-white/80">
                        {normStatus(appState?.status) === "PROVISIONED" ? "YES" : "NO"}
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <div className="text-[11px] uppercase tracking-[0.22em] text-white/35">App id</div>
                      <div className="max-w-[70%] truncate text-right font-mono text-[12px] leading-5 text-white/70">
                        {selectedAppId}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* RIGHT: authority */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="text-xs font-semibold tracking-wide text-white/80">Authority</div>
                <div className="mt-1 text-sm text-white/60">{selectedApp ? title : "Select an application"}</div>
              </div>

              <div className="p-4 space-y-2">
                <button
                  onClick={runInvite}
                  disabled={!selectedAppId || busy !== null}
                  className={cx(
                    "w-full rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                    selectedAppId && !busy
                      ? "border-white/10 bg-white/5 text-white/85 hover:border-amber-300/20 hover:bg-white/7"
                      : "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                  )}
                >
                  {busy === "INVITE" ? "Sending Invite…" : "Run Invite"}
                </button>

                <button
                  onClick={completeProvisioning}
                  disabled={!selectedAppId || !hasUserId || busy !== null}
                  className={cx(
                    "w-full rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                    selectedAppId && hasUserId && !busy
                      ? "border-emerald-300/20 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/14"
                      : "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                  )}
                >
                  {busy === "COMPLETE" ? "Completing…" : "Complete Provisioning"}
                </button>

                <div className="pt-2 text-xs text-white/40">
                  RPC-only controls. Complete Provisioning calls{" "}
                  <span className="font-mono text-white/55">admissions_complete_provisioning(app_id, user_id)</span>.
                </div>

                {!hasUserId && selectedAppId && (
                  <div className="mt-3 rounded-2xl border border-amber-300/15 bg-amber-400/10 p-3 text-xs text-amber-200">
                    Missing <span className="font-mono">primary_contact_user_id</span>. This is normally set after Invite → Set
                    Password.
                  </div>
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
