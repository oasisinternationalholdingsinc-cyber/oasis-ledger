"use client";
export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser as supabase } from "@/lib/supabaseClient";
import { useEntity } from "@/components/OsEntityContext";
import { useOsEnv } from "@/components/OsEnvContext";

/* -------------------------------- helpers -------------------------------- */

function cx(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function normStatus(s: string | null | undefined) {
  return (s || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="text-xs uppercase tracking-[0.22em] text-white/35">{k}</div>
      <div className="max-w-[70%] text-right text-sm text-white/80">{v}</div>
    </div>
  );
}

/* -------------------------------- OS MODAL -------------------------------- */

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
            {subtitle && (
              <div className="mt-1 text-sm text-white/55">{subtitle}</div>
            )}
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
          Mutations are authority-only • No side effects
        </div>
      </div>
    </div>
  );
}

/* -------------------------------- types -------------------------------- */

type ProvisionRow = {
  id: string;
  status: string | null;
  applicant_email: string | null;
  organization_legal_name: string | null;
  organization_trade_name: string | null;
  created_at: string | null;
  updated_at?: string | null;
  entity_slug: string | null;
  metadata?: any | null;
  lane_is_test?: boolean | null;
};

/* =============================== PAGE ===================================== */

export default function CiProvisioningPage() {
  /* -------- entity + lane -------- */
  const ec = useEntity() as any;
  const entityKey =
    ec?.entityKey || ec?.activeEntity || ec?.entity_slug || "";
  const entityName =
    ec?.entityName || ec?.activeEntityName || entityKey;

  const env = useOsEnv() as any;
  const isTest = Boolean(
    env?.is_test ?? env?.isTest ?? env?.lane_is_test ?? env?.sandbox
  );

  /* -------- state -------- */
  const [rows, setRows] = useState<ProvisionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  /* -------- modals -------- */
  const [inviteOpen, setInviteOpen] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);

  const selected = useMemo(
    () => rows.find((r) => r.id === selectedId) || null,
    [rows, selectedId]
  );

  const title = useMemo(() => {
    if (!selected) return "Select application";
    return (
      selected.organization_trade_name ||
      selected.organization_legal_name ||
      selected.applicant_email ||
      selected.id
    );
  }, [selected]);

  /* -------- load queue -------- */
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const baseCols = [
          "id",
          "status",
          "applicant_email",
          "organization_legal_name",
          "organization_trade_name",
          "created_at",
          "updated_at",
          "entity_slug",
          "metadata",
        ];

        let q = supabase
          .from("v_onboarding_provisioning_queue")
          .select([...baseCols, "lane_is_test"].join(","))
          .eq("entity_slug", entityKey)
          .eq("lane_is_test", isTest)
          .order("created_at", { ascending: false });

        const { data, error } = await q;
        if (error) throw error;
        if (!alive) return;

        setRows((data || []) as ProvisionRow[]);
        if (!selectedId && data?.length) setSelectedId(data[0].id);
      } catch (e: any) {
        setErr(e?.message || "Failed to load provisioning queue.");
      } finally {
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [entityKey, isTest, refreshKey]);

  /* ========================== ACTIONS ==================================== */

  async function sendInvite() {
    if (!selected) return;
    setBusy(true);
    setNote(null);
    try {
      const { error } = await supabase.functions.invoke(
        "admissions-provision-portal-access",
        { body: { application_id: selected.id } }
      );
      if (error) throw error;
      setNote("Portal access invite sent.");
      setInviteOpen(false);
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
      const { error } = await supabase.rpc(
        "admissions_complete_provisioning",
        { p_application_id: selected.id }
      );
      if (error) throw error;
      setNote("Provisioning complete. Entity created.");
      setCompleteOpen(false);
      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "Complete provisioning failed.");
    } finally {
      setBusy(false);
    }
  }

  /* ============================= UI ===================================== */

  return (
    <div className="h-full w-full">
      <div className="mx-auto w-full max-w-[1400px] px-4 pb-10 pt-6">
        {/* Header */}
        <div className="mb-5">
          <div className="text-[11px] uppercase tracking-[0.28em] text-white/45">
            CI • Provisioning
          </div>
          <div className="mt-1 text-2xl font-semibold text-white/90">
            Provisioning Console
          </div>
          <div className="mt-1 text-sm text-white/50">
            Entity: <span className="text-white/70">{entityName}</span> • Lane:{" "}
            <span className="text-white/70">{isTest ? "SANDBOX" : "RoT"}</span>
          </div>
        </div>

        <div className="grid grid-cols-12 gap-4">
          {/* Queue */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20">
              <div className="border-b border-white/10 p-4 text-xs font-semibold text-white/80">
                Queue
              </div>
              <div className="max-h-[560px] overflow-auto p-2">
                {loading ? (
                  <div className="p-4 text-sm text-white/50">Loading…</div>
                ) : err ? (
                  <div className="p-4 text-sm text-rose-200">{err}</div>
                ) : (
                  rows.map((r) => (
                    <button
                      key={r.id}
                      onClick={() => setSelectedId(r.id)}
                      className={cx(
                        "w-full rounded-2xl border p-4 text-left transition mb-2",
                        r.id === selectedId
                          ? "border-amber-300/25 bg-black/35"
                          : "border-white/10 bg-black/15 hover:bg-black/22"
                      )}
                    >
                      <div className="text-sm font-semibold text-white/85">
                        {r.organization_trade_name ||
                          r.organization_legal_name ||
                          r.applicant_email}
                      </div>
                      <div className="mt-1 text-xs text-white/45">
                        {r.applicant_email}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Details */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 p-4">
              {!selected ? (
                <div className="text-sm text-white/50">
                  Select an application.
                </div>
              ) : (
                <div className="space-y-3">
                  <Row k="Org" v={title} />
                  <Row k="Email" v={selected.applicant_email || "—"} />
                  <Row k="Status" v={selected.status || "—"} />
                  <Row k="App ID" v={selected.id} />
                  {note && (
                    <div className="mt-2 rounded-2xl border border-white/10 bg-black/20 p-3 text-xs text-white/70">
                      {note}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Authority */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 p-4">
              <div className="text-xs font-semibold tracking-wide text-white/80 mb-3">
                Authority
              </div>

              <div className="flex flex-col gap-2">
                <button
                  disabled={!selected || busy}
                  onClick={() => setInviteOpen(true)}
                  className={cx(
                    "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                    selected && !busy
                      ? "border-amber-300/20 bg-amber-400/10 text-amber-100"
                      : "border-white/10 bg-white/3 text-white/35"
                  )}
                >
                  Send Portal Access Invite
                </button>

                <button
                  disabled={!selected || busy}
                  onClick={() => setCompleteOpen(true)}
                  className={cx(
                    "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                    selected && !busy
                      ? "border-emerald-300/20 bg-emerald-400/10 text-emerald-100"
                      : "border-white/10 bg-white/3 text-white/35"
                  )}
                >
                  Complete Provisioning
                </button>

                <div className="mt-2 text-xs text-white/50">
                  Invite = access only. Provisioning = creation.
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Invite modal */}
      <OsModal
        open={inviteOpen}
        title="Send portal access invite"
        subtitle={title}
        confirmText={busy ? "Sending…" : "Send Invite"}
        busy={busy}
        onClose={() => (!busy ? setInviteOpen(false) : null)}
        onConfirm={sendInvite}
      >
        <div className="text-sm text-white/75">
          This grants authentication access only so the applicant can upload
          evidence. No entities are created.
        </div>
      </OsModal>

      {/* Complete provisioning modal */}
      <OsModal
        open={completeOpen}
        title="Complete provisioning"
        subtitle={title}
        confirmText={busy ? "Working…" : "Create Entity"}
        danger
        busy={busy}
        onClose={() => (!busy ? setCompleteOpen(false) : null)}
        onConfirm={completeProvisioning}
      >
        <div className="text-sm text-rose-100/90">
          This will create the entity, memberships, and mark the application
          PROVISIONED. This action is irreversible.
        </div>
      </OsModal>
    </div>
  );
}
