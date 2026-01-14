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
  status: string | null;

  applicant_email: string | null;
  organization_email: string | null;

  organization_legal_name: string | null;
  organization_trade_name: string | null;

  primary_contact_user_id: string | null;

  entity_slug: string | null;
  created_at: string | null;

  lane_is_test?: boolean | null;
};

type AppTab = "READY" | "ALL";

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="text-xs uppercase tracking-[0.22em] text-white/35">{k}</div>
      <div className="max-w-[70%] text-right text-sm text-white/80">{v}</div>
    </div>
  );
}

export default function CiProvisioningPage() {
  // ---- entity (defensive, like CI-Evidence) ----
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

  // ---- env lane (defensive, like CI-Evidence) ----
  const env = useOsEnv() as any;
  const isTest: boolean = Boolean(
    env?.is_test ?? env?.isTest ?? env?.lane_is_test ?? env?.sandbox ?? env?.isSandbox
  );

  const [apps, setApps] = useState<InboxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [tab, setTab] = useState<AppTab>("READY");
  const [q, setQ] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const selected = useMemo(
    () => apps.find((a) => a.id === selectedId) || null,
    [apps, selectedId]
  );

  // ---- load provisioning candidates (lane-safe if view supports lane, else fallback) ----
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
          "primary_contact_user_id",
          "entity_slug",
          "created_at",
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

        if (res.error) throw res.error;
        if (!alive) return;

        const list = (res.data || []) as InboxRow[];
        setApps(list);

        if (!selectedId && list.length) setSelectedId(list[0].id);
        else if (selectedId && !list.some((r) => r.id === selectedId)) setSelectedId(list[0]?.id ?? null);
      } catch (e: any) {
        if (!alive) return;
        setErr(e?.message || "Failed to load provisioning queue.");
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

    if (tab === "READY") {
      // “Ready” means: approved/decisioned intake AND has an applicant email.
      // (We don’t hard-assume exact enum names; we accept common ones.)
      const okStatuses = new Set(["APPROVED", "APPROVE", "PROVISIONING", "IN_PROVISIONING", "NEEDS_INFO"]);
      list = list.filter((a) => {
        const st = normStatus(a.status);
        const hasEmail = !!(a.applicant_email || a.organization_email);
        return hasEmail && (okStatuses.has(st) || st === "IN_REVIEW" || st === "SUBMITTED");
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
  }, [apps, tab, q]);

  const appTitle = useMemo(() => {
    if (!selected) return "Select an application";
    return (
      selected.organization_trade_name ||
      selected.organization_legal_name ||
      selected.applicant_email ||
      selected.id
    );
  }, [selected]);

  const looksReady = useMemo(() => {
    if (!selected) return false;
    const hasEmail = !!(selected.applicant_email || selected.organization_email);
    // In your UX, invite can happen before primary_contact_user_id exists.
    return hasEmail;
  }, [selected]);

  async function runInvite() {
    if (!selected) return;
    setBusy(true);
    setNote(null);

    try {
      // Keep this aligned to your existing backend contract:
      // Edge Function: admissions-provision-portal-access
      const { data, error } = await supabase.functions.invoke("admissions-provision-portal-access", {
        body: { application_id: selected.id },
      });

      if (error) throw error;

      // Show any returned info, then refresh to pick up primary_contact_user_id when it arrives.
      setNote(data?.message || "Invite issued.");
      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "Run Invite failed.");
    } finally {
      setBusy(false);
    }
  }

  async function completeProvisioning() {
    if (!selected) return;

    const userId = selected.primary_contact_user_id;
    if (!userId) {
      alert("Missing primary_contact_user_id. This is normally set after Invite → Set Password.");
      return;
    }

    setBusy(true);
    setNote(null);

    try {
      // RPC-only:
      // admissions_complete_provisioning(p_application_id, p_user_id)
      const { error } = await supabase.rpc("admissions_complete_provisioning", {
        p_application_id: selected.id,
        p_user_id: userId,
      });

      if (error) throw error;

      setNote("Provisioning completed.");
      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "Complete Provisioning failed.");
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
          {/* Left: applications */}
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

          {/* Middle: readiness */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="text-xs font-semibold tracking-wide text-white/80">Readiness</div>
                <div className="mt-1 truncate text-sm text-white/60">{selectedId ? appTitle : "Select an application"}</div>
              </div>

              <div className="p-4">
                {!selected ? (
                  <div className="text-sm text-white/50">Select an application.</div>
                ) : (
                  <div className="space-y-3 rounded-2xl border border-white/10 bg-black/20 p-4">
                    <Row k="Looks ready" v={looksReady ? "YES" : "NO"} />
                    <Row k="Has user id" v={selected.primary_contact_user_id ? "YES" : "NO"} />
                    <Row k="Provisioned" v={normStatus(selected.status) === "PROVISIONED" ? "YES" : "NO"} />
                    <Row k="App ID" v={selected.id} />
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right: authority */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="text-xs font-semibold tracking-wide text-white/80">Authority</div>
                <div className="mt-1 truncate text-sm text-white/60">{selected ? appTitle : "Select an application"}</div>
              </div>

              <div className="p-4">
                <div className="flex flex-col gap-2">
                  <button
                    onClick={runInvite}
                    disabled={!selected || !looksReady || busy}
                    className={cx(
                      "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                      selected && looksReady && !busy
                        ? "border-white/10 bg-white/5 text-white/85 hover:border-amber-300/20 hover:bg-white/7"
                        : "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                    )}
                  >
                    Run Invite
                  </button>

                  <button
                    onClick={completeProvisioning}
                    disabled={!selected || !selected?.primary_contact_user_id || busy}
                    className={cx(
                      "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                      selected?.primary_contact_user_id && !busy
                        ? "border-emerald-300/20 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/14"
                        : "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                    )}
                  >
                    Complete Provisioning
                  </button>

                  <div className="pt-2 text-xs text-white/40">
                    RPC-only controls. Invite grants portal access (Set Password). Ledger activation happens only after provisioning.
                  </div>

                  {selected && !selected.primary_contact_user_id && (
                    <div className="mt-2 rounded-2xl border border-amber-300/18 bg-amber-400/10 p-3 text-xs text-amber-100/90">
                      Missing <span className="font-mono">primary_contact_user_id</span>. This is normally set after Invite → Set Password.
                    </div>
                  )}

                  {note && (
                    <div className="mt-2 rounded-2xl border border-white/10 bg-black/20 p-3 text-xs text-white/70">
                      {note}
                    </div>
                  )}
                </div>
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
