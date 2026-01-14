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

  // provisioning signals (optional, view-dependent)
  primary_contact_user_id?: string | null;
  provisioned_at?: string | null;

  lane_is_test?: boolean | null;

  created_at: string | null;
  updated_at: string | null;
};

type AppTab = "READY" | "ALL";

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

  const [apps, setApps] = useState<InboxRow[]>([]);
  const [appsLoading, setAppsLoading] = useState(true);
  const [appsErr, setAppsErr] = useState<string | null>(null);

  const [tab, setTab] = useState<AppTab>("READY");
  const [q, setQ] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const selected = useMemo(() => apps.find((a) => a.id === selectedId) || null, [apps, selectedId]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let rows = apps;

    if (tab === "READY") {
      // "Ready" means: approved for provisioning but not provisioned yet.
      // We keep it forgiving: allow NEEDS_INFO too (your screenshot shows it),
      // but the operator sees readiness flags in the middle panel.
      const allow = new Set(["APPROVED", "NEEDS_INFO", "IN_REVIEW", "SUBMITTED"]);
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
        r.id,
      ]
        .filter(Boolean)
        .join(" • ")
        .toLowerCase();
      return blob.includes(needle);
    });
  }, [apps, q, tab]);

  // -------- load applications (entity + lane scoped) --------
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

        // optional provisioning cols (may not exist in view)
        const optCols = ["primary_contact_user_id", "provisioned_at"];

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
          const { data, error } = await supabase
            .from("v_onboarding_admissions_inbox")
            .select([...baseCols, ...optCols].join(","))
            .eq("entity_slug", entityKey)
            .order("created_at", { ascending: false });

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

        if (res.error && /lane_is_test|42703|undefined column/i.test(res.error.message)) {
          res = await tryWithoutLane();
        } else if (res.error && /primary_contact_user_id|provisioned_at/i.test(res.error.message)) {
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

        const rows = (res.data || []) as InboxRow[];
        setApps(rows);

        if (!selectedId && rows.length) setSelectedId(rows[0].id);
        else if (selectedId && !rows.some((r) => r.id === selectedId)) setSelectedId(rows[0]?.id ?? null);
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

  const appTitle = useMemo(() => {
    if (!selected) return "No application selected";
    return (
      selected.organization_trade_name ||
      selected.organization_legal_name ||
      selected.applicant_email ||
      selected.id
    );
  }, [selected]);

  const looksReady = useMemo(() => {
    if (!selected) return false;
    // treat "APPROVED" as ready, but don't hard-require it to avoid breaking flows
    return normStatus(selected.status) === "APPROVED" || normStatus(selected.status) === "NEEDS_INFO" || normStatus(selected.status) === "IN_REVIEW";
  }, [selected]);

  const hasUserId = useMemo(() => {
    if (!selected) return false;
    return !!(selected as any).primary_contact_user_id;
  }, [selected]);

  const provisioned = useMemo(() => {
    if (!selected) return false;
    return normStatus(selected.status) === "PROVISIONED" || !!(selected as any).provisioned_at;
  }, [selected]);

  async function runInvite() {
    if (!selected) return;

    setBusy("invite");
    try {
      // ✅ Wiring-safe default: invoke Edge Function if it exists
      // (matches what your Network panel showed).
      const { data, error } = await supabase.functions.invoke("admissions-provision-portal-access", {
        body: { application_id: selected.id },
      });

      if (error) throw error;

      // best-effort refresh
      setRefreshKey((n) => n + 1);

      // optional toast
      if (data?.ok === false) alert(data?.error || "Invite failed.");
    } catch (e: any) {
      alert(e?.message || "Invite failed.");
    } finally {
      setBusy(null);
    }
  }

  async function completeProvisioning() {
    if (!selected) return;

    const primaryUserId = (selected as any).primary_contact_user_id as string | null | undefined;
    if (!primaryUserId) {
      alert("Missing primary_contact_user_id. This is normally set after Invite → Set Password.");
      return;
    }

    setBusy("complete");
    try {
      const { error } = await supabase.rpc("admissions_complete_provisioning" as any, {
        p_application_id: selected.id,
        p_user_id: primaryUserId,
      } as any);

      if (error) throw error;

      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "Complete provisioning failed.");
    } finally {
      setBusy(null);
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
                        tab === "ALL" ? "bg-white/8 text-white/85 ring-1 ring-white/12" : "text-white/55 hover:text-white/75"
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
                ) : filtered.length === 0 ? (
                  <div className="p-4 text-sm text-white/50">No applications found.</div>
                ) : (
                  <div className="space-y-2 p-2">
                    {filtered.map((a) => {
                      const active = a.id === selectedId;
                      const name = a.organization_trade_name || a.organization_legal_name || a.applicant_email || a.id;
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

          {/* Middle */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="text-xs font-semibold tracking-wide text-white/80">Readiness</div>
                <div className="mt-1 truncate text-sm text-white/60">{selected ? appTitle : "Select an application"}</div>
              </div>

              <div className="p-4">
                {!selected ? (
                  <div className="text-sm text-white/50">Select an application.</div>
                ) : (
                  <div className="space-y-3 rounded-2xl border border-white/10 bg-black/20 p-4">
                    <Row k="LOOKS READY" v={looksReady ? "YES" : "NO"} />
                    <Row k="HAS USER ID" v={hasUserId ? "YES" : "NO"} />
                    <Row k="PROVISIONED" v={provisioned ? "YES" : "NO"} />
                    <Row k="APP ID" v={selected.id} mono />
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
                <div className="mt-1 truncate text-sm text-white/60">{selected ? appTitle : "Select an application"}</div>
              </div>

              <div className="p-4">
                {!selected ? (
                  <div className="text-sm text-white/50">Select an application.</div>
                ) : (
                  <>
                    <button
                      onClick={runInvite}
                      disabled={busy === "invite"}
                      className={cx(
                        "w-full rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                        busy === "invite"
                          ? "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                          : "border-white/10 bg-white/5 text-white/85 hover:border-amber-300/20 hover:bg-white/7"
                      )}
                    >
                      Run Invite
                    </button>

                    <button
                      onClick={completeProvisioning}
                      disabled={busy === "complete" || !hasUserId}
                      className={cx(
                        "mt-2 w-full rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                        busy === "complete" || !hasUserId
                          ? "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                          : "border-emerald-300/20 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/14"
                      )}
                    >
                      Complete Provisioning
                    </button>

                    <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 p-4">
                      <div className="text-[11px] uppercase tracking-[0.24em] text-white/45">Operator Notes</div>
                      <div className="mt-2 text-xs text-white/55">
                        RPC-only controls. Invite grants portal access (Set Password). Complete Provisioning calls{" "}
                        <span className="font-mono text-white/70">admissions_complete_provisioning(app_id, user_id)</span>.
                      </div>

                      {!hasUserId ? (
                        <div className="mt-3 rounded-2xl border border-amber-300/20 bg-amber-400/10 p-3 text-xs text-amber-200">
                          Missing <span className="font-mono">primary_contact_user_id</span>. This is normally set after Invite → Set Password.
                        </div>
                      ) : null}
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
