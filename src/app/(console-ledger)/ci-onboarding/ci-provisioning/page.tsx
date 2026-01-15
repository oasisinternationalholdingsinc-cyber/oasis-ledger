// src/app/(console-ledger)/ci-onboarding/ci-provisioning/page.tsx
"use client";
export const dynamic = "force-dynamic";

/**
 * CI • Provisioning (LOCKED CONTRACT)
 * ✅ SAME OS + modal language as CI-Admissions (no drift)
 * ✅ Queue source: public.v_onboarding_admissions_inbox (same as Admissions)
 * ✅ Invite = authentication only (Edge Function) → enables portal evidence upload
 * ✅ Complete Provisioning = creation (RPC) → entity + memberships
 * ✅ Complete Provisioning FIX: admissions_complete_provisioning requires (p_application_id, p_user_id)
 * ✅ Archive (ENTITY RETAINED): archives the application ONLY (RPC), never deletes identity
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

type QueueTab = "READY" | "PROVISIONED" | "ALL";

/** Minimal OS Modal (same pattern as CI-Admissions) */
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
            {subtitle ? (
              <div className="mt-1 text-sm text-white/55">{subtitle}</div>
            ) : null}
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
          Mutations are RPC/Functions only • Lane-safe via OsEnv + view lane column when present
        </div>
      </div>
    </div>
  );
}

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

export default function CiProvisioningPage() {
  // ---- entity (defensive) ----
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

  // ---- env lane (defensive) ----
  const env = useOsEnv() as any;
  const isTest: boolean = Boolean(
    env?.is_test ?? env?.isTest ?? env?.lane_is_test ?? env?.sandbox ?? env?.isSandbox
  );

  const [apps, setApps] = useState<InboxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [tab, setTab] = useState<QueueTab>("READY");
  const [q, setQ] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // ---- modals ----
  const [inviteOpen, setInviteOpen] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);

  // ✅ NEW: archive (entity retained) modal
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveNote, setArchiveNote] = useState("Archived from CI-Provisioning (entity retained).");

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

  const isArchived = useMemo(() => normStatus(selected?.status) === "ARCHIVED", [selected?.status]);

  // ---- load queue (same source as Admissions) ----
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
        if (res.error && /lane_is_test|42703|undefined column/i.test(res.error.message)) {
          res = await tryWithoutLane();
        }

        if (res.error) throw res.error;
        if (!alive) return;

        setApps((res.data || []) as InboxRow[]);

        const list = (res.data || []) as InboxRow[];
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

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = apps;

    // Queue tabs (client-side; DB statuses are enum + may be lowercase)
    if (tab === "READY") {
      // Ready for invite / evidence / provisioning: approved OR provisioning OR needs_info
      // (You can still invite even in needs_info so they can upload.)
      list = list.filter((a) => {
        const st = normStatus(a.status);
        return ["APPROVED", "PROVISIONING", "NEEDS_INFO", "IN_REVIEW", "SUBMITTED", "TRIAGE"].includes(st);
      });
    } else if (tab === "PROVISIONED") {
      list = list.filter((a) => normStatus(a.status) === "PROVISIONED");
    } // ALL = no extra filter

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
  }, [apps, tab, q]);

  // ---------------------------
  // Actions
  // ---------------------------

  /**
   * Invite (AUTH ONLY): Edge Function that grants portal access (evidence upload).
   * NOTE: This is intentionally NOT creation.
   */
  async function rpcSendPortalInvite() {
    if (!selected) return;
    setBusy(true);
    setNote(null);
    try {
      // canonical Edge Function name (already used in your system)
      const { data, error } = await supabase.functions.invoke("admissions-provision-portal-access", {
        body: { application_id: selected.id },
      });
      if (error) throw error;

      // optional: show returned info if present
      const msg =
        (data && (data.message || data.detail)) ||
        "Portal access invite sent (auth-only).";
      setNote(String(msg));
      setInviteOpen(false);
      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "Send Portal Access Invite failed.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Complete provisioning (CREATION): RPC creates entity + memberships.
   * ✅ FIX: admissions_complete_provisioning requires p_application_id + p_user_id.
   */
  async function rpcCompleteProvisioning() {
    if (!selected) return;
    setBusy(true);
    setNote(null);
    try {
      const { data: auth, error: authErr } = await supabase.auth.getUser();
      if (authErr) throw authErr;

      const uid = auth?.user?.id;
      if (!uid) throw new Error("No operator session (auth.uid missing).");

      const { error } = await supabase.rpc("admissions_complete_provisioning", {
        p_application_id: selected.id,
        p_user_id: uid,
      });
      if (error) throw error;

      setNote("Provisioning completed (entity + memberships created).");
      setCompleteOpen(false);
      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "Complete Provisioning failed.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Archive application (ENTITY RETAINED)
   * ✅ Archives the application only (parks workflow)
   * ✅ Never deletes entity or memberships (identity remains reusable)
   */
  async function rpcArchiveApplication() {
    if (!selected) return;
    setBusy(true);
    setNote(null);
    try {
      const { error } = await supabase.rpc("admissions_set_status", {
        p_application_id: selected.id,
        p_next_status: "archived",
        p_note: (archiveNote || "").trim() || "Archived from CI-Provisioning (entity retained).",
      });
      if (error) throw error;

      setNote("Application archived (entity retained).");
      setArchiveOpen(false);
      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "Archive failed.");
    } finally {
      setBusy(false);
    }
  }

  const statusBadge = (stRaw: string | null) => {
    const st = normStatus(stRaw);
    const base = "rounded-full border px-3 py-1 text-[11px] font-medium";
    if (st === "NEEDS_INFO")
      return `${base} border-amber-300/18 bg-amber-400/10 text-amber-100/90`;
    if (st === "IN_REVIEW" || st === "UNDER_REVIEW" || st === "TRIAGE")
      return `${base} border-sky-300/18 bg-sky-400/10 text-sky-100/90`;
    if (st === "APPROVED" || st === "PROVISIONING")
      return `${base} border-amber-300/18 bg-amber-400/10 text-amber-100/90`;
    if (st === "PROVISIONED")
      return `${base} border-emerald-300/18 bg-emerald-400/10 text-emerald-100/90`;
    if (st === "ARCHIVED")
      return `${base} border-white/10 bg-white/5 text-white/55`;
    return `${base} border-white/10 bg-white/5 text-white/70`;
  };

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
              Entity-scoped:{" "}
              <span className="text-white/70">{entityName || entityKey}</span> •
              Lane: <span className="text-white/70">{isTest ? "SANDBOX" : "RoT"}</span>
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
                <div className="text-xs font-semibold tracking-wide text-white/80">
                  Queue
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <Pill active={tab === "READY"} onClick={() => setTab("READY")}>
                    READY
                  </Pill>
                  <Pill
                    active={tab === "PROVISIONED"}
                    onClick={() => setTab("PROVISIONED")}
                  >
                    PROVISIONED
                  </Pill>
                  <Pill active={tab === "ALL"} onClick={() => setTab("ALL")}>
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
                ) : filtered.length === 0 ? (
                  <div className="p-4 text-sm text-white/50">No applications found.</div>
                ) : (
                  <div className="space-y-2 p-2">
                    {filtered.map((a) => {
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

          {/* Middle: application */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="text-xs font-semibold tracking-wide text-white/80">
                  Application
                </div>
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
                        <div className="text-xs font-semibold tracking-wide text-white/80">
                          Metadata
                        </div>
                        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-medium text-white/60">
                          jsonb
                        </span>
                      </div>

                      <div className="mt-3 space-y-3">
                        <Row k="source" v={meta?.source ? String(meta.source) : "—"} />
                        <Row k="notes" v={meta?.notes ? String(meta.notes) : "—"} />

                        <div className="mt-3 rounded-2xl border border-white/10 bg-black/25 p-3">
                          <div className="text-[10px] uppercase tracking-[0.22em] text-white/35">
                            raw
                          </div>
                          <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-white/70">
                            {safePrettyJSON(selected.metadata)}
                          </pre>
                        </div>
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
                <div className="text-xs font-semibold tracking-wide text-white/80">
                  Authority Panel
                </div>
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
                        ? "border-amber-300/20 bg-amber-400/12 text-amber-100 hover:bg-amber-400/16"
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

                  {/* ✅ NEW: Archive (entity retained) — modal-driven */}
                  <div className="mt-2 h-px w-full bg-white/10" />

                  <button
                    onClick={() => {
                      setArchiveNote("Archived from CI-Provisioning (entity retained).");
                      setArchiveOpen(true);
                    }}
                    disabled={!selected || busy || isArchived}
                    className={cx(
                      "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                      !selected || busy
                        ? "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                        : isArchived
                        ? "cursor-not-allowed border-white/10 bg-white/5 text-white/45"
                        : "border-white/10 bg-white/5 text-white/85 hover:border-amber-300/18 hover:bg-white/7"
                    )}
                  >
                    {isArchived ? "Archived (no action required)" : "Archive Application"}
                  </button>

                  <div className="mt-2 rounded-2xl border border-white/10 bg-black/18 p-4 text-sm text-white/60">
                    <div className="font-semibold text-white/80">Locked contract</div>
                    <div className="mt-1">
                      Invite = authentication only (enables portal evidence upload). Complete
                      Provisioning = creation (entity + memberships).
                    </div>
                    <div className="mt-2 text-xs text-white/45">
                      Archive closes the application only.{" "}
                      <span className="text-white/70 font-semibold">Entity remains</span> (reusable identity).
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
        confirmText={busy ? "Working…" : "Send invite"}
        cancelText="Cancel"
        busy={busy}
        onClose={() => (!busy ? setInviteOpen(false) : null)}
        onConfirm={rpcSendPortalInvite}
      >
        <div className="space-y-3 rounded-2xl border border-white/10 bg-black/20 p-4">
          <div className="text-sm text-white/75">
            This grants <span className="text-white/90 font-semibold">authentication access only</span> so the
            applicant can enter the portal and upload evidence.
          </div>
          <div className="text-xs text-white/45">
            No entity is created here. Evidence review happens in CI-Evidence.
          </div>
        </div>
      </OsModal>

      {/* Complete provisioning modal */}
      <OsModal
        open={completeOpen}
        title="Complete provisioning"
        subtitle={selected ? appTitle : undefined}
        confirmText={busy ? "Working…" : "Complete"}
        cancelText="Cancel"
        danger
        busy={busy}
        onClose={() => (!busy ? setCompleteOpen(false) : null)}
        onConfirm={rpcCompleteProvisioning}
      >
        <div className="space-y-3 rounded-2xl border border-rose-300/15 bg-rose-500/10 p-4">
          <div className="text-sm text-rose-50/90">
            This will create the entity + memberships and mark the application as{" "}
            <span className="font-semibold">PROVISIONED</span>.
          </div>
          <div className="text-xs text-rose-100/70">
            Use only after evidence has been reviewed/approved. (Creation action)
          </div>
        </div>
      </OsModal>

      {/* ✅ Archive modal (entity retained) */}
      <OsModal
        open={archiveOpen}
        title="Archive application"
        subtitle={selected ? appTitle : undefined}
        confirmText={busy ? "Working…" : "Archive"}
        cancelText="Cancel"
        busy={busy}
        onClose={() => (!busy ? setArchiveOpen(false) : null)}
        onConfirm={rpcArchiveApplication}
      >
        <div className="space-y-3">
          <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
            <div className="text-sm text-white/80">
              This will archive the <span className="font-semibold">application only</span>.
            </div>
            <div className="mt-2 text-xs text-white/45">
              Entity + memberships remain intact (reusable identity). No delete occurs here.
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-white/35">note</div>
            <textarea
              value={archiveNote}
              onChange={(e) => setArchiveNote(e.target.value)}
              className="mt-2 w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white/85 outline-none focus:border-amber-300/25"
              rows={3}
              placeholder="Archived from CI-Provisioning (entity retained)."
            />
            <div className="mt-2 text-xs text-white/45">
              Stored with the status change for audit clarity.
            </div>
          </div>
        </div>
      </OsModal>
    </div>
  );
}
