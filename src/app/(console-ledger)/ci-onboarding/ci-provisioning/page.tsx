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

  organization_legal_name: string | null;
  organization_trade_name: string | null;
  applicant_email: string | null;
  organization_email: string | null;

  created_at: string | null;
  updated_at: string | null;

  lane_is_test?: boolean | null;
};

type Tab = "READY" | "ALL";

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

export default function CiProvisioningPage() {
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

  const [apps, setApps] = useState<InboxRow[]>([]);
  const [appsLoading, setAppsLoading] = useState(true);
  const [appsErr, setAppsErr] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>("READY");
  const [q, setQ] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);

  // Provisioning read model (what the module needs)
  const [primaryContactUserId, setPrimaryContactUserId] = useState<string | null>(null);
  const [provisioned, setProvisioned] = useState<boolean>(false);

  const selectedApp = useMemo(
    () => apps.find((a) => a.id === selectedAppId) || null,
    [apps, selectedAppId]
  );

  const filteredApps = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let rows = apps;

    // READY tab = things we can actually act on (NOT archived)
    if (tab === "READY") {
      const deny = new Set(["ARCHIVED"]);
      rows = rows.filter((r) => !deny.has(normStatus(r.status)));
    }

    if (!needle) return rows;

    return rows.filter((r) => {
      const blob = [
        r.organization_legal_name,
        r.organization_trade_name,
        r.applicant_email,
        r.organization_email,
        r.status,
        r.id,
      ]
        .filter(Boolean)
        .join(" • ")
        .toLowerCase();
      return blob.includes(needle);
    });
  }, [apps, q, tab]);

  // -------- load applications (entity + lane scoped, lane fallback) --------
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

        if (!selectedAppId && rows.length) setSelectedAppId(rows[0].id);
        else if (selectedAppId && !rows.some((r) => r.id === selectedAppId)) setSelectedAppId(rows[0]?.id ?? null);
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

  // -------- load provisioning state for selected app (defensive) --------
  useEffect(() => {
    let alive = true;

    (async () => {
      setPrimaryContactUserId(null);
      setProvisioned(false);

      if (!selectedAppId) return;

      try {
        // We read the authoritative provisioning state from the base application row.
        // Some columns may not exist in earlier schema revisions; tolerate failures.
        const baseTry = await supabase
          .from("onboarding_applications")
          .select("id,status,primary_contact_user_id")
          .eq("id", selectedAppId)
          .maybeSingle();

        if (!alive) return;

        if (!baseTry.error && baseTry.data) {
          const st = normStatus(baseTry.data.status);
          setPrimaryContactUserId((baseTry.data as any)?.primary_contact_user_id ?? null);
          setProvisioned(st === "PROVISIONED");
          return;
        }

        // If the table/column set differs in this env, we still operate safely:
        // - Invite can run based on applicant_email
        // - Complete Provisioning requires user_id (which comes after invite + set-password)
      } catch {
        // swallow — UI will remain in safe "unknown" state
      }
    })();

    return () => {
      alive = false;
    };
  }, [selectedAppId, refreshKey]);

  // ---------------- Actions ----------------
  async function runInvite() {
    if (!selectedApp) return;

    // Minimal payload: application_id + email (server can resolve more)
    const payload = {
      application_id: selectedApp.id,
      applicant_email: selectedApp.applicant_email,
      entity_slug: entityKey,
      lane_is_test: isTest,
    };

    // ✅ Standard Supabase Edge Functions invocation
    const { data, error } = await supabase.functions.invoke("admissions-provision-portal-access", {
      body: payload,
    });

    if (error) return alert(error.message);
    if ((data as any)?.ok === false) return alert((data as any)?.detail || (data as any)?.error || "Invite failed.");

    alert("Invite sent. Next step: user completes Set Password, then return here to Complete Provisioning.");
    setRefreshKey((n) => n + 1);
  }

  async function completeProvisioning() {
    if (!selectedAppId) return;

    if (!primaryContactUserId) {
      alert("Missing primary_contact_user_id. This is normally set after Invite → Set Password.");
      return;
    }

    const { error } = await supabase.rpc("admissions_complete_provisioning", {
      p_application_id: selectedAppId,
      p_user_id: primaryContactUserId,
    });

    if (error) return alert(error.message);

    alert("Provisioning complete (entity + memberships).");
    setRefreshKey((n) => n + 1);
  }

  const looksReady = useMemo(() => {
    if (!selectedApp) return false;
    // “Ready” here means: not archived AND has an email to invite
    return normStatus(selectedApp.status) !== "ARCHIVED" && !!selectedApp.applicant_email;
  }, [selectedApp]);

  const appTitle = useMemo(() => {
    if (!selectedApp) return "No application selected";
    return (
      selectedApp.organization_trade_name ||
      selectedApp.organization_legal_name ||
      selectedApp.applicant_email ||
      selectedApp.id
    );
  }, [selectedApp]);

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

          <button
            onClick={() => setRefreshKey((n) => n + 1)}
            className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs font-medium text-white/80 hover:border-amber-300/20 hover:bg-white/7"
          >
            Refresh
          </button>
        </div>

        <div className="grid grid-cols-12 gap-4">
          {/* Left */}
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
                      const name = a.organization_trade_name || a.organization_legal_name || a.applicant_email || a.id;
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
                            <Badge text={a.status || "—"} />
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Middle */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="text-xs font-semibold tracking-wide text-white/80">Readiness</div>
                <div className="mt-1 truncate text-sm text-white/60">{selectedAppId ? appTitle : "Select an application"}</div>
              </div>

              <div className="p-4">
                {!selectedApp ? (
                  <div className="text-sm text-white/50">Select an application.</div>
                ) : (
                  <div className="space-y-3 rounded-2xl border border-white/10 bg-black/20 p-4">
                    <Row k="Looks Ready" v={looksReady ? "YES" : "NO"} />
                    <Row k="Has User ID" v={primaryContactUserId ? "YES" : "NO"} />
                    <Row k="Provisioned" v={provisioned ? "YES" : "NO"} />
                    <Row k="App ID" v={selectedApp.id} mono />
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="text-xs font-semibold tracking-wide text-white/80">Authority</div>
                <div className="mt-1 truncate text-sm text-white/60">{selectedApp ? appTitle : "Select an application"}</div>
              </div>

              <div className="p-4">
                {!selectedApp ? (
                  <div className="text-sm text-white/50">Select an application.</div>
                ) : (
                  <>
                    <div className="flex flex-col gap-2">
                      <button
                        onClick={runInvite}
                        disabled={!looksReady}
                        className={cx(
                          "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                          looksReady
                            ? "border-white/10 bg-white/5 text-white/85 hover:border-amber-300/20 hover:bg-white/7"
                            : "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                        )}
                      >
                        Run Invite
                      </button>

                      <button
                        onClick={completeProvisioning}
                        disabled={!primaryContactUserId || provisioned}
                        className={cx(
                          "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                          primaryContactUserId && !provisioned
                            ? "border-emerald-300/20 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/14"
                            : "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                        )}
                      >
                        Complete Provisioning
                      </button>
                    </div>

                    <div className="mt-3 rounded-2xl border border-amber-300/15 bg-amber-400/5 p-3 text-xs text-amber-100/80">
                      {primaryContactUserId
                        ? "User ID present. You can Complete Provisioning."
                        : "Missing primary_contact_user_id. This is normally set after Invite → Set Password."}
                    </div>

                    <div className="mt-3 text-xs text-white/40">
                      RPC-only controls. Invite grants portal access (Set Password). Ledger activation happens only after provisioning.
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
