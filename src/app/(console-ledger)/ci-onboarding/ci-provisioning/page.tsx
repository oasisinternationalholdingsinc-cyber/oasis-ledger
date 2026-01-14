"use client";

export const dynamic = "force-dynamic";

/**
 * CI-PROVISIONING — Provision & Activate (PRISTINE / LANE-SAFE)
 * -------------------------------------------------------------
 * ✅ This module owns:
 *   1) INVITE (AUTH ONLY): send “Set Password” invite for portal access
 *   2) COMPLETE PROVISIONING: create entity + memberships (RPC) once user exists
 *
 * ❌ Admissions must NOT run invites anymore. (Separation of concerns)
 *
 * HARD RULES:
 * - No corporate hardcoded names (entity flows from OS Global Bar)
 * - Lane-safe (SANDBOX vs RoT) via OsEnv is_test
 * - Read surfaces via views where possible; avoid column drift on base tables
 *
 * Known issue fixed:
 * - DO NOT select onboarding_applications.organization_email (it may not exist).
 *   Instead, derive invite email from applicant_email and/or view fields if present.
 */

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";

function cx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

type InboxRow = {
  id: string;
  entity_slug: string | null;
  organization_legal_name: string | null;
  applicant_email: string | null;
  status: string | null;
  submitted_at: string | null;

  // optional fields (view-dependent)
  organization_email?: string | null;
  org_email?: string | null;
  contact_email?: string | null;

  lane_is_test?: boolean | null;
};

type AppCore = {
  id: string;
  status: string | null;
  organization_legal_name: string | null;
  applicant_email: string | null;
  submitted_at: string | null;

  // critical to provisioning
  primary_contact_user_id: string | null;
};

type Step = "IDLE" | "BUSY";

function normStatus(s: string | null | undefined) {
  return (s || "").trim().toUpperCase();
}

function pickInviteEmail(app: InboxRow | AppCore | null): string {
  if (!app) return "";
  const anyApp = app as any;
  const candidates = [
    (anyApp.organization_email as string | null) || null,
    (anyApp.org_email as string | null) || null,
    (anyApp.contact_email as string | null) || null,
    (anyApp.applicant_email as string | null) || null,
  ].filter(Boolean) as string[];

  return (candidates[0] || "").trim();
}

export default function CiProvisioningPage() {
  const { entityKey, entityName } = useEntity();
  const { isTest } = useOsEnv();

  const [step, setStep] = useState<Step>("IDLE");
  const busy = step === "BUSY";

  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [rows, setRows] = useState<InboxRow[]>([]);
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"READY" | "ALL">("READY");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedRow = useMemo(
    () => rows.find((r) => r.id === selectedId) || null,
    [rows, selectedId]
  );

  const [app, setApp] = useState<AppCore | null>(null);

  // -----------------------------
  // LOAD APPLICATIONS (VIEW FIRST)
  // -----------------------------
  async function loadApps() {
    setErr(null);

    // We prefer the same read surface Admissions uses:
    // public.v_onboarding_admissions_inbox (entity-scoped, lane-aware)
    // BUT: be defensive in case some envs don’t expose lane columns.
    const base = supabase
      .from("v_onboarding_admissions_inbox")
      .select(
        "id, entity_slug, organization_legal_name, applicant_email, status, submitted_at, organization_email, org_email, contact_email, lane_is_test"
      )
      .eq("entity_slug", entityKey)
      .order("submitted_at", { ascending: false });

    // lane safe filter (if available)
    let data: any[] | null = null;
    let error: any = null;

    // try with lane filter first
    {
      const r = await base.eq("lane_is_test", isTest);
      data = (r.data as any[]) || null;
      error = r.error;
    }

    // fallback if lane column not present
    if (error && String(error.message || "").toLowerCase().includes("lane_is_test")) {
      const r2 = await supabase
        .from("v_onboarding_admissions_inbox")
        .select(
          "id, entity_slug, organization_legal_name, applicant_email, status, submitted_at, organization_email, org_email, contact_email"
        )
        .eq("entity_slug", entityKey)
        .order("submitted_at", { ascending: false });

      data = (r2.data as any[]) || null;
      error = r2.error;
    }

    if (error) {
      setErr(error.message || "Failed to load applications.");
      setRows([]);
      return;
    }

    setRows((data || []) as InboxRow[]);

    // Keep selection stable if possible
    if (!selectedId && (data || []).length) {
      setSelectedId((data || [])[0]?.id || null);
    }
  }

  // -----------------------------------------
  // LOAD SELECTED APP CORE (BASE TABLE, SAFE)
  // -----------------------------------------
  async function loadSelectedCore(appId: string) {
    setErr(null);
    setApp(null);

    // IMPORTANT: avoid columns that may not exist on onboarding_applications
    const { data, error } = await supabase
      .from("onboarding_applications")
      .select("id, status, organization_legal_name, applicant_email, submitted_at, primary_contact_user_id")
      .eq("id", appId)
      .maybeSingle();

    if (error) {
      setErr(error.message || "Failed to load application core.");
      return;
    }

    if (!data) {
      setErr("Application not found.");
      return;
    }

    setApp(data as AppCore);
  }

  useEffect(() => {
    loadApps();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityKey, isTest]);

  useEffect(() => {
    if (selectedId) loadSelectedCore(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // -----------------------------
  // FILTERED LIST
  // -----------------------------
  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    const pick = (s: string | null | undefined) => (s || "").toLowerCase();

    const list = rows.filter((r) => {
      const status = normStatus(r.status);
      if (tab === "READY") {
        // “Ready” = Approved / Provisioning / Needs_Info (operator workflow)
        if (!["APPROVED", "PROVISIONING", "NEEDS_INFO"].includes(status)) return false;
      }
      if (!qq) return true;

      return (
        pick(r.organization_legal_name).includes(qq) ||
        pick(r.applicant_email).includes(qq) ||
        pick(r.status).includes(qq)
      );
    });

    return list;
  }, [rows, q, tab]);

  // -----------------------------
  // INVITE (AUTH ONLY)
  // -----------------------------
  async function sendInvite() {
    setErr(null);
    setToast(null);
    if (!selectedId) return;

    const inviteEmail = pickInviteEmail(selectedRow) || pickInviteEmail(app);
    if (!inviteEmail) {
      setErr("Missing invite email (applicant_email).");
      return;
    }

    setStep("BUSY");
    try {
      // Canonical invite edge function (AUTH ONLY)
      // - creates/finds auth user
      // - sends invite / set-password link
      // - may set primary_contact_user_id on the application
      const { data, error } = await supabase.functions.invoke(
        "admissions-provision-portal-access",
        {
          body: {
            application_id: selectedId,
            invite_email: inviteEmail,
            lane_is_test: isTest, // harmless metadata; function may ignore
            entity_slug: entityKey, // harmless metadata; function may ignore
          },
        }
      );

      if (error) throw error;

      // refresh core after invite (so primary_contact_user_id can appear)
      await loadSelectedCore(selectedId);

      setToast(
        data?.ok
          ? "Invite sent. Client should receive Set Password link."
          : "Invite request completed."
      );
    } catch (e: any) {
      setErr(e?.message || "Invite failed.");
    } finally {
      setStep("IDLE");
    }
  }

  // -----------------------------
  // COMPLETE PROVISIONING
  // -----------------------------
  async function completeProvisioning() {
    setErr(null);
    setToast(null);
    if (!selectedId) return;

    const userId = app?.primary_contact_user_id || null;
    if (!userId) {
      setErr("Missing primary_contact_user_id. This is normally set after Invite → Set Password.");
      return;
    }

    setStep("BUSY");
    try {
      // Canonical RPC (SECURITY DEFINER)
      // - creates entity + memberships
      // - transitions application to PROVISIONED (state gated)
      const { data, error } = await supabase.rpc("admissions_complete_provisioning", {
        p_application_id: selectedId,
        p_user_id: userId,
      });

      if (error) throw error;

      await loadApps();
      await loadSelectedCore(selectedId);

      setToast(data?.ok ? "Provisioning complete." : "Provisioning RPC completed.");
    } catch (e: any) {
      setErr(e?.message || "Complete provisioning failed.");
    } finally {
      setStep("IDLE");
    }
  }

  // -----------------------------
  // QUICK STATUS CONTROLS (RPC)
  // -----------------------------
  async function setStatus(next: "NEEDS_INFO" | "PROVISIONING" | "ARCHIVED") {
    setErr(null);
    setToast(null);
    if (!selectedId) return;

    setStep("BUSY");
    try {
      const { error } = await supabase.rpc("admissions_set_status", {
        p_application_id: selectedId,
        p_next_status: next,
        p_note: null,
      });
      if (error) throw error;

      await loadApps();
      await loadSelectedCore(selectedId);

      setToast(`Status set: ${next}`);
    } catch (e: any) {
      setErr(e?.message || "Status update failed.");
    } finally {
      setStep("IDLE");
    }
  }

  // -----------------------------
  // DERIVED READINESS
  // -----------------------------
  const looksReady = useMemo(() => {
    const s = normStatus(app?.status);
    return ["APPROVED", "PROVISIONING"].includes(s);
  }, [app?.status]);

  const hasUser = !!app?.primary_contact_user_id;
  const isProvisioned = normStatus(app?.status) === "PROVISIONED";

  // -----------------------------
  // UI
  // -----------------------------
  return (
    <div className="p-6">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <div className="text-xs tracking-widest text-white/40">
            CI · PROVISIONING
          </div>
          <div className="text-2xl font-semibold text-white">
            Provision & Activate
          </div>
          <div className="mt-1 text-xs text-white/50">
            Entity-scoped: {entityKey || "—"} · Lane: {isTest ? "SANDBOX" : "RoT"}
            {entityName ? (
              <span className="text-white/35"> · {entityName}</span>
            ) : null}
          </div>
        </div>

        <button
          onClick={() => loadApps()}
          disabled={busy}
          className={cx(
            "rounded-full px-4 py-2 text-sm border transition",
            "border-white/10 bg-white/5 hover:bg-white/8 hover:border-white/15",
            busy && "opacity-60 cursor-not-allowed"
          )}
        >
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-12 gap-6">
        {/* LEFT: Applications */}
        <div className="col-span-12 lg:col-span-4">
          <div className="rounded-3xl border border-white/10 bg-black/20 p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-medium text-white/85">Applications</div>
              <div className="flex gap-2">
                <button
                  onClick={() => setTab("READY")}
                  className={cx(
                    "rounded-full px-3 py-1 text-xs border transition",
                    tab === "READY"
                      ? "border-amber-300/35 bg-amber-300/10 text-amber-200"
                      : "border-white/10 bg-white/5 text-white/60 hover:bg-white/8"
                  )}
                >
                  Ready
                </button>
                <button
                  onClick={() => setTab("ALL")}
                  className={cx(
                    "rounded-full px-3 py-1 text-xs border transition",
                    tab === "ALL"
                      ? "border-amber-300/35 bg-amber-300/10 text-amber-200"
                      : "border-white/10 bg-white/5 text-white/60 hover:bg-white/8"
                  )}
                >
                  All
                </button>
              </div>
            </div>

            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search org / email / status"
              className="w-full rounded-2xl border border-white/10 bg-black/30 px-4 py-2 text-sm text-white/85 placeholder:text-white/35 outline-none focus:border-amber-300/25"
            />

            <div className="mt-4 space-y-2">
              {filtered.length === 0 ? (
                <div className="text-sm text-white/40 py-8 text-center">
                  No applications found.
                </div>
              ) : (
                filtered.map((r) => {
                  const active = r.id === selectedId;
                  const status = normStatus(r.status) || "—";
                  return (
                    <button
                      key={r.id}
                      onClick={() => setSelectedId(r.id)}
                      className={cx(
                        "w-full text-left rounded-2xl p-4 border transition",
                        active
                          ? "border-amber-300/25 bg-black/35"
                          : "border-white/10 bg-black/15 hover:bg-black/25 hover:border-white/15"
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-white/90 truncate">
                            {r.organization_legal_name || "—"}
                          </div>
                          <div className="text-xs text-white/50 truncate">
                            {r.applicant_email || "—"}
                          </div>
                        </div>
                        <div
                          className={cx(
                            "shrink-0 rounded-full px-3 py-1 text-[11px] border",
                            active
                              ? "border-amber-300/25 text-amber-200 bg-amber-300/10"
                              : "border-white/10 text-white/55 bg-white/5"
                          )}
                        >
                          {status.toLowerCase()}
                        </div>
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            <div className="mt-4 text-[11px] text-white/35">
              Source: public.v_onboarding_admissions_inbox • entity_slug={entityKey} • lane={isTest ? "SANDBOX" : "RoT"}
            </div>
          </div>
        </div>

        {/* MID: Readiness */}
        <div className="col-span-12 lg:col-span-4">
          <div className="rounded-3xl border border-white/10 bg-black/20 p-5">
            <div className="text-sm font-medium text-white/85 mb-3">Readiness</div>

            <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
              <div className="text-sm text-white/80">
                {selectedRow?.organization_legal_name || "Select an application"}
              </div>
              <div className="text-xs text-white/45 mt-1">
                Invite is auth-only. Provisioning activates entity + memberships.
              </div>

              {err ? (
                <div className="mt-4 text-sm text-red-300">{err}</div>
              ) : null}

              {toast ? (
                <div className="mt-4 text-sm text-emerald-200">{toast}</div>
              ) : null}
            </div>

            <div className="mt-4 space-y-2 text-xs text-white/55">
              <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-black/20 px-4 py-3">
                <span>Invite email</span>
                <span className="text-white/75">
                  {pickInviteEmail(selectedRow) || pickInviteEmail(app) || "—"}
                </span>
              </div>

              <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-black/20 px-4 py-3">
                <span>Status</span>
                <span className="text-white/75">{normStatus(app?.status) || "—"}</span>
              </div>

              <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-black/20 px-4 py-3">
                <span>primary_contact_user_id</span>
                <span className="text-white/75 truncate max-w-[220px]">
                  {app?.primary_contact_user_id || "—"}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT: Authority */}
        <div className="col-span-12 lg:col-span-4">
          <div className="rounded-3xl border border-white/10 bg-black/20 p-5">
            <div className="text-sm font-medium text-white/85 mb-3">Authority</div>

            <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
              <div className="text-xs tracking-widest text-white/35 mb-3">
                STATE
              </div>

              <div className="space-y-2 text-xs">
                <RowYN label="Looks ready" yes={looksReady} />
                <RowYN label="Has user session" yes={hasUser} />
                <RowYN label="Provisioned" yes={isProvisioned} />
                <div className="flex items-center justify-between text-white/55 pt-2">
                  <span>App ID</span>
                  <span className="text-white/75">{selectedId || "—"}</span>
                </div>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-2">
              <button
                disabled={busy || !selectedId || !looksReady}
                onClick={sendInvite}
                className={cx(
                  "rounded-2xl px-4 py-3 text-sm border transition text-left",
                  "border-amber-300/25 bg-amber-300/10 text-amber-200 hover:bg-amber-300/13",
                  (!selectedId || !looksReady || busy) && "opacity-50 cursor-not-allowed"
                )}
              >
                Send Invite (Auth Only)
                <div className="text-[11px] text-amber-100/70 mt-1">
                  Sends Set-Password link. Does not create entity.
                </div>
              </button>

              <button
                disabled={busy || !selectedId || !hasUser || isProvisioned}
                onClick={completeProvisioning}
                className={cx(
                  "rounded-2xl px-4 py-3 text-sm border transition text-left",
                  "border-white/10 bg-white/5 text-white/85 hover:bg-white/8",
                  (!selectedId || !hasUser || isProvisioned || busy) &&
                    "opacity-50 cursor-not-allowed"
                )}
              >
                Complete Provisioning
                <div className="text-[11px] text-white/55 mt-1">
                  Calls admissions_complete_provisioning(app_id, user_id).
                </div>
              </button>
            </div>

            <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-4">
              <div className="text-xs tracking-widest text-white/35 mb-3">
                QUICK STATUS
              </div>
              <div className="grid grid-cols-3 gap-2">
                <button
                  disabled={busy || !selectedId}
                  onClick={() => setStatus("NEEDS_INFO")}
                  className={cx(
                    "rounded-xl px-3 py-2 text-xs border transition",
                    "border-white/10 bg-white/5 text-white/70 hover:bg-white/8",
                    (!selectedId || busy) && "opacity-50 cursor-not-allowed"
                  )}
                >
                  Needs Info
                </button>
                <button
                  disabled={busy || !selectedId}
                  onClick={() => setStatus("PROVISIONING")}
                  className={cx(
                    "rounded-xl px-3 py-2 text-xs border transition",
                    "border-white/10 bg-white/5 text-white/70 hover:bg-white/8",
                    (!selectedId || busy) && "opacity-50 cursor-not-allowed"
                  )}
                >
                  Provisioning
                </button>
                <button
                  disabled={busy || !selectedId}
                  onClick={() => setStatus("ARCHIVED")}
                  className={cx(
                    "rounded-xl px-3 py-2 text-xs border transition",
                    "border-white/10 bg-white/5 text-white/70 hover:bg-white/8",
                    (!selectedId || busy) && "opacity-50 cursor-not-allowed"
                  )}
                >
                  Archive
                </button>
              </div>

              <div className="mt-3 text-[11px] text-white/40">
                Invite belongs here (Provisioning). Admissions remains decision-only.
              </div>
            </div>

            {hasUser ? (
              <div className="mt-3 text-[11px] text-white/35">
                primary_contact_user_id is present — client should be able to sign in after setting password.
              </div>
            ) : (
              <div className="mt-3 text-[11px] text-amber-100/60">
                Missing primary_contact_user_id. This is normally set after Invite → Set Password.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function RowYN({ label, yes }: { label: string; yes: boolean }) {
  return (
    <div className="flex items-center justify-between text-white/55">
      <span>{label}</span>
      <span className={cx("font-medium", yes ? "text-emerald-200" : "text-white/40")}>
        {yes ? "YES" : "NO"}
      </span>
    </div>
  );
}
