"use client";

export const dynamic = "force-dynamic";

/**
 * CI-PROVISIONING — PROVISION & ACTIVATE (PRISTINE / LOCKED)
 * ---------------------------------------------------------
 * Owns:
 * 1) INVITE (AUTH ONLY): send Set Password link
 * 2) COMPLETE PROVISIONING: entity + memberships
 *
 * Admissions is decision-only.
 */

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";

// ---------------------------------------------
// TYPES
// ---------------------------------------------
type InboxRow = {
  id: string;
  entity_slug: string | null;
  organization_legal_name: string | null;
  applicant_email: string | null;
  status: string | null;
  submitted_at: string | null;

  // optional / view-derived
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
  primary_contact_user_id: string | null;
};

type Step = "IDLE" | "BUSY";

// ---------------------------------------------
// HELPERS
// ---------------------------------------------
function cx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function normStatus(v?: string | null) {
  return (v || "").trim().toUpperCase();
}

function pickInviteEmail(row?: InboxRow | AppCore | null): string {
  if (!row) return "";
  const r: any = row;
  return (
    r.organization_email ||
    r.org_email ||
    r.contact_email ||
    r.applicant_email ||
    ""
  ).trim();
}

// ---------------------------------------------
// PAGE
// ---------------------------------------------
export default function CiProvisioningPage() {
  // -------------------------------------------
  // ENTITY (NO HARD FALLBACKS)
  // -------------------------------------------
  const entityCtx = useEntity() as any;
  const entityKey: string =
    entityCtx?.entityKey ||
    entityCtx?.activeEntity ||
    entityCtx?.entity_slug ||
    "";

  // -------------------------------------------
  // ENV / LANE (DEFENSIVE READ — TS SAFE)
  // -------------------------------------------
  const env = useOsEnv() as any;
  const isTest: boolean = Boolean(
    env?.is_test ??
      env?.isTest ??
      env?.lane_is_test ??
      env?.sandbox ??
      env?.isSandbox
  );

  // -------------------------------------------
  // STATE
  // -------------------------------------------
  const [rows, setRows] = useState<InboxRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedRow = useMemo(
    () => rows.find((r) => r.id === selectedId) || null,
    [rows, selectedId]
  );

  const [app, setApp] = useState<AppCore | null>(null);
  const [step, setStep] = useState<Step>("IDLE");
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const busy = step === "BUSY";

  // -------------------------------------------
  // LOAD INBOX (VIEW)
  // -------------------------------------------
  async function loadInbox() {
    setErr(null);

    const base = supabase
      .from("v_onboarding_admissions_inbox")
      .select(
        "id, entity_slug, organization_legal_name, applicant_email, status, submitted_at, organization_email, org_email, contact_email, lane_is_test"
      )
      .eq("entity_slug", entityKey)
      .order("submitted_at", { ascending: false });

    let data: any[] | null = null;
    let error: any = null;

    // try lane filter
    {
      const r = await base.eq("lane_is_test", isTest);
      data = r.data as any[] | null;
      error = r.error;
    }

    // fallback if lane column missing
    if (
      error &&
      String(error.message || "").toLowerCase().includes("lane")
    ) {
      const r2 = await supabase
        .from("v_onboarding_admissions_inbox")
        .select(
          "id, entity_slug, organization_legal_name, applicant_email, status, submitted_at, organization_email, org_email, contact_email"
        )
        .eq("entity_slug", entityKey)
        .order("submitted_at", { ascending: false });

      data = r2.data as any[] | null;
      error = r2.error;
    }

    if (error) {
      setErr(error.message || "Failed to load applications.");
      setRows([]);
      return;
    }

    setRows(data || []);
    if (!selectedId && data && data.length) {
      setSelectedId(data[0].id);
    }
  }

  // -------------------------------------------
  // LOAD CORE APPLICATION (BASE TABLE)
  // -------------------------------------------
  async function loadAppCore(appId: string) {
    setErr(null);
    setApp(null);

    const { data, error } = await supabase
      .from("onboarding_applications")
      .select(
        "id, status, organization_legal_name, applicant_email, submitted_at, primary_contact_user_id"
      )
      .eq("id", appId)
      .maybeSingle();

    if (error) {
      setErr(error.message || "Failed to load application.");
      return;
    }

    if (!data) {
      setErr("Application not found.");
      return;
    }

    setApp(data as AppCore);
  }

  useEffect(() => {
    if (entityKey) loadInbox();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityKey, isTest]);

  useEffect(() => {
    if (selectedId) loadAppCore(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // -------------------------------------------
  // INVITE (AUTH ONLY)
  // -------------------------------------------
  async function sendInvite() {
    setErr(null);
    setToast(null);

    if (!selectedId) return;

    const email = pickInviteEmail(selectedRow) || pickInviteEmail(app);
    if (!email) {
      setErr("Missing invite email.");
      return;
    }

    setStep("BUSY");
    try {
      const { error } = await supabase.functions.invoke(
        "admissions-provision-portal-access",
        {
          body: {
            application_id: selectedId,
            invite_email: email,
          },
        }
      );

      if (error) throw error;

      await loadAppCore(selectedId);
      setToast("Invite sent. Client will receive Set Password link.");
    } catch (e: any) {
      setErr(e?.message || "Invite failed.");
    } finally {
      setStep("IDLE");
    }
  }

  // -------------------------------------------
  // COMPLETE PROVISIONING
  // -------------------------------------------
  async function completeProvisioning() {
    setErr(null);
    setToast(null);

    if (!selectedId) return;
    if (!app?.primary_contact_user_id) {
      setErr("Missing primary_contact_user_id.");
      return;
    }

    setStep("BUSY");
    try {
      const { error } = await supabase.rpc(
        "admissions_complete_provisioning",
        {
          p_application_id: selectedId,
          p_user_id: app.primary_contact_user_id,
        }
      );

      if (error) throw error;

      await loadInbox();
      await loadAppCore(selectedId);
      setToast("Provisioning complete.");
    } catch (e: any) {
      setErr(e?.message || "Provisioning failed.");
    } finally {
      setStep("IDLE");
    }
  }

  const looksReady = ["APPROVED", "PROVISIONING"].includes(
    normStatus(app?.status)
  );
  const hasUser = Boolean(app?.primary_contact_user_id);
  const isProvisioned = normStatus(app?.status) === "PROVISIONED";

  // -------------------------------------------
  // UI
  // -------------------------------------------
  return (
    <div className="p-6 space-y-6">
      <h1 className="text-xl font-semibold">
        Provisioning · Provision & Activate
      </h1>

      <div className="grid grid-cols-[320px_1fr] gap-6">
        {/* LIST */}
        <div className="space-y-2">
          {rows.map((r) => (
            <button
              key={r.id}
              onClick={() => setSelectedId(r.id)}
              className={cx(
                "w-full text-left rounded-xl p-4 border",
                selectedId === r.id
                  ? "border-amber-400/40 bg-black/40"
                  : "border-white/10"
              )}
            >
              <div className="font-medium">
                {r.organization_legal_name || "—"}
              </div>
              <div className="text-xs text-white/60">
                {r.applicant_email || "—"}
              </div>
              <div className="text-xs mt-1 text-amber-300">
                {r.status || "—"}
              </div>
            </button>
          ))}
        </div>

        {/* DETAIL */}
        {selectedRow && (
          <div className="space-y-4">
            <div className="rounded-xl border border-white/10 p-4">
              <div className="font-medium">
                {selectedRow.organization_legal_name}
              </div>
              <div className="text-sm text-white/60">
                {pickInviteEmail(selectedRow) || "—"}
              </div>
            </div>

            {err && <div className="text-sm text-red-300">{err}</div>}
            {toast && <div className="text-sm text-emerald-200">{toast}</div>}

            <div className="flex flex-wrap gap-2">
              <button
                className="btn"
                disabled={busy || !looksReady}
                onClick={sendInvite}
              >
                Send Invite (Auth Only)
              </button>

              <button
                className="btn"
                disabled={busy || !hasUser || isProvisioned}
                onClick={completeProvisioning}
              >
                Complete Provisioning
              </button>
            </div>

            <div className="text-xs text-white/40">
              Invite grants portal access only. Entity + memberships created on
              provisioning.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
