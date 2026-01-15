"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";

/**
 * CI • Provisioning (OS-aligned to CI-Admissions)
 * ✅ Uses the SAME source view as Admissions: public.v_onboarding_admissions_inbox
 * ✅ Lane-safe: tries lane_is_test if present, falls back if not
 * ✅ Invite = auth only (Edge Function)
 * ✅ Complete Provisioning = creation (RPC)
 * ✅ Same OsModal + 3-column console layout
 */

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

type InboxRow = {
  id: string;
  status: string | null;

  applicant_email: string | null;
  applicant_name?: string | null;

  organization_legal_name: string | null;
  organization_trade_name: string | null;

  primary_contact_user_id: string | null;

  entity_slug: string | null;
  created_at: string | null;
  updated_at?: string | null;

  requested_services?: any | null;
  metadata?: any | null;

  // optional lane exposure from view
  lane_is_test?: boolean | null;
};

type TopTab = "READY" | "PROVISIONED" | "ALL";

function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "rounded-full px-3 py-1 text-[11px] font-medium transition",
        active
          ? "bg-white/8 text-white/85 ring-1 ring-white/12"
          : "text-white/55 hover:text-white/80"
      )}
    >
      {children}
    </button>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="text-xs uppercase tracking-[0.22em] text-white/35">{k}</div>
      <div className="max-w-[70%] text-right text-sm text-white/80">{v}</div>
    </div>
  );
}

/** Minimal OS Modal (same as CI-Admissions) */
function OsModal({
  open,
  title,
  subtitle,
  children,
  confirmText = "Confirm",
  cancelText = "Cancel",
  danger,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  busy?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100]">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-[6px]"
        onClick={busy ? undefined : onClose}
      />
      <div className="absolute left-1/2 top-1/2 w-[94vw] max-w-[560px] -translate-x-1/2 -translate-y-1/2">
        <div className="relative overflow-hidden rounded-3xl border border-white/12 bg-[#070A12]/80 shadow-[0_40px_160px_rgba(0,0,0,0.70)]">
          <div className="pointer-events-none absolute inset-0 opacity-60 [background:radial-gradient(900px_500px_at_70%_-20%,rgba(250,204,21,0.14),transparent_55%),radial-gradient(700px_420px_at_10%_0%,rgba(56,189,248,0.10),transparent_50%)]" />
          <div className="relative border-b border-white/10 p-5">
            <div className="text-[11px] uppercase tracking-[0.28em] text-white/45">
              Authority • Action
            </div>
            <div className="mt-2 text-xl font-semibold text-white/90">{title}</div>
            {subtitle ? <div className="mt-1 text-sm text-white/55">{subtitle}</div> : null}
          </div>

          <div className="relative p-5">{children}</div>

          <div className="relative flex items-center justify-end gap-2 border-t border-white/10 p-4">
            <button
              disabled={busy}
              onClick={onClose}
              className={cx(
                "rounded-full border px-4 py-2 text-xs font-semibold transition",
                busy
                  ? "border-white/10 bg-white/3 text-white/35"
                  : "border-white/10 bg-white/5 text-white/75 hover:bg-white/7 hover:border-white/15"
              )}
            >
              {cancelText}
            </button>
            <button
              disabled={busy}
              onClick={onConfirm}
              className={cx(
                "rounded-full border px-4 py-2 text-xs font-semibold transition",
                danger
                  ? busy
                    ? "border-rose-300/15 bg-rose-500/10 text-rose-200/40"
                    : "border-rose-300/20 bg-rose-500/12 text-rose-100 hover:bg-rose-500/16"
                  : busy
                  ? "border-amber-300/15 bg-amber-400/10 text-amber-100/40"
                  : "border-amber-300/20 bg-amber-400/12 text-amber-100 hover:bg-amber-400/16"
              )}
            >
              {confirmText}
            </button>
          </div>
        </div>

        <div className="mt-3 text-center text-[10px] text-white/35">
          Invite = authentication only • Complete Provisioning = creation • Mutations are authority-only
        </div>
      </div>
    </div>
  );
}

export default function CiProvisioningPage() {
  // ---- entity (defensive; same pattern as Admissions) ----
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

  // ---- env lane (defensive; same pattern as Admissions) ----
  const env = useOsEnv() as any;
  const isTest: boolean = Boolean(
    env?.is_test ?? env?.isTest ?? env?.lane_is_test ?? env?.sandbox ?? env?.isSandbox
  );

  const [apps, setApps] = useState<InboxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [topTab, setTopTab] = useState<TopTab>("READY");
  const [q, setQ] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // ---- modals ----
  const [inviteOpen, setInviteOpen] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);

  const selected = useMemo(
    () => apps.find((a) => a.id === selectedId) || null,
    [apps, selectedId]
  );

  const appTitle = useMemo(() => {
    if (!selected) return "Select an application";
    return (
      selected.organization_trade_name ||
      selected.organization_legal_name ||
      selected.applicant_email ||
      selected.id
    );
  }, [selected]);

  const meta = useMemo(() => {
    const m = selected?.metadata;
    return (m && typeof m === "object" ? (m as any) : {}) as any;
  }, [selected?.metadata]);

  // ---- load queue from SAME view as Admissions (lane-safe fallback) ----
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
          "applicant_name",
          "organization_legal_name",
          "organization_trade_name",
          "primary_contact_user_id",
          "entity_slug",
          "created_at",
          "updated_at",
          "requested_services",
          "metadata",
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
        if (res.error && /lane_is_test|42703|undefined column|schema cache/i.test(res.error.message)) {
          res = await tryWithoutLane();
        }

        if (res.error) throw res.error;
        if (!alive) return;

        const list = (res.data || []) as InboxRow[];
        setApps(list);

        if (!selectedId && list.length) setSelectedId(list[0].id);
        else if (selectedId && !list.some((r) => r.id === selectedId))
          setSelectedId(list[0]?.id ?? null);
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

  // ---- provisioning-focused filter (client-side; no schema assumptions) ----
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = apps;

    const stIn = (a: InboxRow, allowed: string[]) => allowed.includes(normStatus(a.status));

    if (topTab === "READY") {
      // Ready for invite/evidence/provisioning actions (keep wide, no regressions)
      list = list.filter((a) =>
        stIn(a, ["SUBMITTED", "IN_REVIEW", "NEEDS_INFO", "APPROVED", "PROVISIONING"])
      );
    } else if (topTab === "PROVISIONED") {
      list = list.filter((a) => stIn(a, ["PROVISIONED"]));
    }

    if (!needle) return list;

    return list.filter((a) => {
      const blob = [
        a.organization_trade_name,
        a.organization_legal_name,
        a.applicant_name,
        a.applicant_email,
        a.status,
        a.id,
      ]
        .filter(Boolean)
        .join(" • ")
        .toLowerCase();
      return blob.includes(needle);
    });
  }, [apps, topTab, q]);

  const statusBadge = (stRaw: string | null) => {
    const st = normStatus(stRaw);
    const base = "rounded-full border px-3 py-1 text-[11px] font-medium";
    if (st === "NEEDS_INFO") return `${base} border-amber-300/18 bg-amber-400/10 text-amber-100/90`;
    if (st === "IN_REVIEW") return `${base} border-sky-300/18 bg-sky-400/10 text-sky-100/90`;
    if (st === "APPROVED" || st === "PROVISIONING")
      return `${base} border-emerald-300/18 bg-emerald-400/10 text-emerald-100/90`;
    if (st === "PROVISIONED") return `${base} border-emerald-300/18 bg-emerald-400/10 text-emerald-100/90`;
    return `${base} border-white/10 bg-white/5 text-white/70`;
  };

  // ---------------- authority actions (NO NEW WIRING) ----------------

  async function sendPortalInvite() {
    if (!selected) return;
    setBusy(true);
    setNote(null);
    try {
      // ✅ Existing Edge Function (auth only)
      const { error } = await supabase.functions.invoke("admissions-provision-portal-access", {
        body: { application_id: selected.id },
      });
      if (error) throw error;

      setNote("Portal access invite sent (authentication only).");
      setInviteOpen(false);
      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "Invite failed.");
    } finally {
      setBusy(false);
    }
  }

  async function completeProvisioning() {
    if (!selected) return;
    setBusy(true);
    setNote(null);
    try {
      // ✅ Existing RPC (creation)
      const { error } = await supabase.rpc("admissions_complete_provisioning", {
        p_application_id: selected.id,
      });
      if (error) throw error;

      setNote("Complete provisioning finished (entity + memberships created).");
      setCompleteOpen(false);
      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "Complete provisioning failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full w-full">
      <div className="mx-auto w-full max-w-[1400px] px-4 pb-10 pt-6">
        {/* Header */}
        <div className="mb-5 flex items-end justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.28em] text-white/45">
              CI • Provisioning
            </div>
            <div className="mt-1 text-2xl font-semibold text-white/90">
              Provisioning Console
            </div>
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
          {/* Left: queue */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="text-xs font-semibold tracking-wide text-white/80">Queue</div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <Pill active={topTab === "READY"} onClick={() => setTopTab("READY")}>
                    READY
                  </Pill>
                  <Pill active={topTab === "PROVISIONED"} onClick={() => setTopTab("PROVISIONED")}>
                    PROVISIONED
                  </Pill>
                  <Pill active={topTab === "ALL"} onClick={() => setTopTab("ALL")}>
                    ALL
                  </Pill>
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
                ) : (topTab === "ALL" ? apps : filtered).length === 0 ? (
                  <div className="p-4 text-sm text-white/50">No applications found.</div>
                ) : (
                  <div className="space-y-2 p-2">
                    {(topTab === "ALL" ? apps : filtered).map((a) => {
                      const active = a.id === selectedId;
                      const name =
                        a.organization_trade_name ||
                        a.organization_legal_name ||
                        a.applicant_email ||
                        a.id;
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
                              <div className="truncate text-sm font-semibold text-white/88">
                                {name}
                              </div>
                              <div className="mt-1 truncate text-xs text-white/45">
                                {a.applicant_email || "—"}
                              </div>
                            </div>
                            <span className={statusBadge(a.status)}>{a.status || "—"}</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="border-t border-white/10 p-3 text-[10px] text-white/35">
                Source: public.v_onboarding_admissions_inbox (same as CI-Admissions)
              </div>
            </div>
          </div>

          {/* Middle: details */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="text-xs font-semibold tracking-wide text-white/80">Application</div>
                <div className="mt-1 truncate text-sm text-white/60">
                  {selected ? appTitle : "Select an application"}
                </div>
              </div>

              <div className="p-4">
                {!selected ? (
                  <div className="text-sm text-white/50">Select an application.</div>
                ) : (
                  <div className="space-y-4">
                    <div className="space-y-3 rounded-2xl border border-white/10 bg-black/20 p-4">
                      <Row k="Org (legal)" v={selected.organization_legal_name || "—"} />
                      <Row k="Org (trade)" v={selected.organization_trade_name || "—"} />
                      <Row k="Applicant" v={selected.applicant_email || "—"} />
                      <Row k="Status" v={selected.status || "—"} />
                      <Row k="App ID" v={selected.id} />
                      <Row k="Created" v={selected.created_at || "—"} />
                      <Row k="Updated" v={selected.updated_at || "—"} />
                    </div>

                    <div className="rounded-2xl border border-white/10 bg-black/18 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-xs font-semibold tracking-wide text-white/80">Metadata</div>
                        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-medium text-white/60">
                          jsonb
                        </span>
                      </div>

                      <div className="mt-3 rounded-2xl border border-white/10 bg-black/25 p-3">
                        <div className="text-[10px] uppercase tracking-[0.22em] text-white/35">
                          raw
                        </div>
                        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-white/70">
                          {safePrettyJSON(meta)}
                        </pre>
                      </div>
                    </div>

                    {note && (
                      <div className="rounded-2xl border border-white/10 bg-black/20 p-3 text-xs text-white/70">
                        {note}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right: authority */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="text-xs font-semibold tracking-wide text-white/80">Authority Panel</div>
                <div className="mt-1 truncate text-sm text-white/60">
                  Invite • Evidence • Complete Provisioning
                </div>
              </div>

              <div className="p-4">
                <div className="flex flex-col gap-2">
                  <button
                    onClick={() => setInviteOpen(true)}
                    disabled={!selected || busy}
                    className={cx(
                      "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                      selected && !busy
                        ? "border-amber-300/20 bg-amber-400/10 text-amber-100 hover:bg-amber-400/14 hover:border-amber-300/25"
                        : "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                    )}
                  >
                    Send Portal Access Invite
                  </button>

                  <button
                    onClick={() => setCompleteOpen(true)}
                    disabled={!selected || busy}
                    className={cx(
                      "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                      selected && !busy
                        ? "border-rose-300/18 bg-rose-500/10 text-rose-100 hover:bg-rose-500/14"
                        : "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                    )}
                  >
                    Complete Provisioning
                  </button>

                  <div className="mt-2 rounded-2xl border border-white/10 bg-black/18 p-4 text-sm text-white/60">
                    <div className="font-semibold text-white/80">Locked contract</div>
                    <div className="mt-1">
                      Invite = authentication only (enables portal evidence upload). Complete Provisioning = creation (entity + memberships).
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* footer */}
        <div className="mt-5 text-[10px] text-white/35">
          Source: public.v_onboarding_admissions_inbox • entity_slug={entityKey} • lane={isTest ? "SANDBOX" : "RoT"}
        </div>
      </div>

      {/* Invite modal */}
      <OsModal
        open={inviteOpen}
        title="Send portal access invite"
        subtitle={selected ? appTitle : undefined}
        confirmText={busy ? "Working…" : "Send Invite"}
        cancelText="Cancel"
        busy={busy}
        onClose={() => (!busy ? setInviteOpen(false) : null)}
        onConfirm={sendPortalInvite}
      >
        <div className="space-y-3">
          <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-white/75">
            This action grants authentication access only, so the applicant can log into the Portal and upload evidence.
            <div className="mt-2 text-xs text-white/45">
              No entity is created here.
            </div>
          </div>
        </div>
      </OsModal>

      {/* Complete modal */}
      <OsModal
        open={completeOpen}
        title="Complete provisioning"
        subtitle={selected ? appTitle : undefined}
        confirmText={busy ? "Working…" : "Create Entity"}
        cancelText="Cancel"
        danger
        busy={busy}
        onClose={() => (!busy ? setCompleteOpen(false) : null)}
        onConfirm={completeProvisioning}
      >
        <div className="space-y-3">
          <div className="rounded-2xl border border-rose-300/15 bg-rose-500/10 p-4 text-sm text-rose-100/90">
            This will create the entity + memberships and mark the application as PROVISIONED.
            <div className="mt-2 text-xs text-rose-100/70">
              Use only after evidence has been reviewed/approved.
            </div>
          </div>
        </div>
      </OsModal>
    </div>
  );
}
