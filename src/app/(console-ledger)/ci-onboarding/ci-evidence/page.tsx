// src/app/(console-ledger)/ci-onboarding/ci-evidence/page.tsx
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
  uploaded_by: string | null;
  uploaded_at: string | null;
  is_verified: boolean | null;
  verified_by: string | null;
  verified_at: string | null;
  metadata: any | null;
};

type AppTab = "INTAKE" | "ALL";

function Row({
  k,
  v,
  mono,
}: {
  k: string;
  v: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="text-xs uppercase tracking-[0.22em] text-white/35">
        {k}
      </div>
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

export default function CiEvidencePage() {
  // ✅ FIX: your EntityContextValue does NOT expose `entity` (TS error).
  // We keep wiring intact by reading only stable fields, with safe fallbacks.
  const ec = useEntity() as any;
  const entityKey: string =
    (ec?.entityKey as string) ||
    (ec?.activeEntity as string) ||
    (ec?.entity_slug as string) ||
    "";

  const entityName: string =
    (ec?.entityName as string) ||
    (ec?.activeEntityName as string) ||
    (ec?.entities?.find?.((x: any) => x?.slug === entityKey || x?.key === entityKey)
      ?.name as string) ||
    entityKey;

  const { isTest } = useOsEnv();

  const [apps, setApps] = useState<InboxRow[]>([]);
  const [appsLoading, setAppsLoading] = useState(true);
  const [appsErr, setAppsErr] = useState<string | null>(null);

  const [tab, setTab] = useState<AppTab>("INTAKE");
  const [q, setQ] = useState("");

  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);

  const [evidence, setEvidence] = useState<EvidenceRow[]>([]);
  const [evLoading, setEvLoading] = useState(false);
  const [evErr, setEvErr] = useState<string | null>(null);

  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(
    null
  );

  const [refreshKey, setRefreshKey] = useState(0);

  const selectedApp = useMemo(
    () => apps.find((a) => a.id === selectedAppId) || null,
    [apps, selectedAppId]
  );

  const selectedEvidence = useMemo(
    () => evidence.find((e) => e.id === selectedEvidenceId) || null,
    [evidence, selectedEvidenceId]
  );

  const filteredApps = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let rows = apps;

    if (tab === "INTAKE") {
      const allow = new Set(["SUBMITTED", "IN_REVIEW", "NEEDS_INFO"]);
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
        if (
          res.error &&
          /lane_is_test|42703|undefined column/i.test(res.error.message)
        ) {
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

  // -------- load evidence for selected application --------
  useEffect(() => {
    let alive = true;

    (async () => {
      setEvidence([]);
      setSelectedEvidenceId(null);
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
              "uploaded_by",
              "uploaded_at",
              "is_verified",
              "verified_by",
              "verified_at",
              "metadata",
            ].join(",")
          )
          .eq("application_id", selectedAppId)
          .order("uploaded_at", { ascending: false });

        if (error) throw error;
        if (!alive) return;

        const rows = (data || []) as EvidenceRow[];
        setEvidence(rows);
        if (rows.length) setSelectedEvidenceId(rows[0].id);
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

  async function openEvidence(e: EvidenceRow) {
    if (!e.storage_bucket || !e.storage_path) return;

    const { data, error } = await supabase.storage
      .from(e.storage_bucket)
      .createSignedUrl(e.storage_path, 60);

    if (error || !data?.signedUrl) {
      alert(error?.message || "Could not create signed URL.");
      return;
    }
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  }

  async function setVerified(e: EvidenceRow, next: boolean) {
    const note = next ? "Evidence verified." : "Evidence unverified.";
    const { error } = await supabase.rpc("admissions_verify_evidence", {
      p_evidence_id: e.id,
      p_is_verified: next,
      p_note: note,
    });

    if (error) {
      alert(error.message);
      return;
    }

    setEvidence((prev) =>
      prev.map((x) =>
        x.id === e.id
          ? {
              ...x,
              is_verified: next,
              verified_at: next ? new Date().toISOString() : null,
            }
          : x
      )
    );
  }

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
            <div className="text-[11px] uppercase tracking-[0.28em] text-white/45">
              CI • Evidence
            </div>
            <div className="mt-1 text-2xl font-semibold text-white/90">
              Evidence Review
            </div>
            <div className="mt-1 text-sm text-white/50">
              Entity-scoped:{" "}
              <span className="text-white/70">{entityName || entityKey}</span> •
              Lane:{" "}
              <span className="text-white/70">
                {isTest ? "SANDBOX" : "RoT"}
              </span>
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
                  <div className="text-xs font-semibold tracking-wide text-white/80">
                    Applications
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setTab("INTAKE")}
                      className={cx(
                        "rounded-full px-3 py-1 text-[11px] font-medium",
                        tab === "INTAKE"
                          ? "bg-emerald-400/10 text-emerald-200 ring-1 ring-emerald-300/20"
                          : "text-white/55 hover:text-white/75"
                      )}
                    >
                      Intake
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
                    placeholder="Search applicant / email / status"
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
                  <div className="p-4 text-sm text-white/50">
                    No applications found.
                  </div>
                ) : (
                  <div className="space-y-2 p-2">
                    {filteredApps.map((a) => {
                      const active = a.id === selectedAppId;
                      const name =
                        a.organization_trade_name ||
                        a.organization_legal_name ||
                        a.applicant_email ||
                        a.id;
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
                              <div className="truncate text-sm font-semibold text-white/88">
                                {name}
                              </div>
                              <div className="mt-1 truncate text-xs text-white/45">
                                {a.applicant_email ||
                                  a.organization_email ||
                                  "—"}
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
                <div className="text-xs font-semibold tracking-wide text-white/80">
                  Evidence
                </div>
                <div className="mt-1 truncate text-sm text-white/60">
                  {selectedAppId ? appTitle : "Select an application"}
                </div>
              </div>

              <div className="max-h-[560px] overflow-auto p-2">
                {!selectedAppId ? (
                  <div className="p-4 text-sm text-white/50">
                    Select an application to view evidence.
                  </div>
                ) : evLoading ? (
                  <div className="p-4 text-sm text-white/50">Loading…</div>
                ) : evErr ? (
                  <div className="p-4 text-sm text-rose-200">{evErr}</div>
                ) : evidence.length === 0 ? (
                  <div className="p-4 text-sm text-white/50">
                    No evidence uploaded yet.
                  </div>
                ) : (
                  <div className="space-y-2 p-2">
                    {evidence.map((e) => {
                      const active = e.id === selectedEvidenceId;
                      const title =
                        e.title ||
                        (e.kind ? e.kind.replaceAll("_", " ") : "Evidence");
                      const badge = e.is_verified ? "VERIFIED" : "PENDING";
                      return (
                        <button
                          key={e.id}
                          onClick={() => setSelectedEvidenceId(e.id)}
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
                                {title}
                              </div>
                              <div className="mt-1 truncate text-xs text-white/45">
                                {e.file_name || e.storage_path || "—"}
                              </div>
                            </div>

                            <span
                              className={cx(
                                "rounded-full border px-3 py-1 text-[11px] font-medium",
                                e.is_verified
                                  ? "border-emerald-300/20 bg-emerald-400/10 text-emerald-200"
                                  : "border-white/10 bg-white/5 text-white/65"
                              )}
                            >
                              {badge}
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

          {/* Right */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="text-xs font-semibold tracking-wide text-white/80">
                  Details
                </div>
                <div className="mt-1 truncate text-sm text-white/60">
                  {selectedEvidence
                    ? selectedEvidence.title ||
                      selectedEvidence.kind?.replaceAll("_", " ") ||
                      selectedEvidence.id
                    : "Select evidence"}
                </div>
              </div>

              <div className="p-4">
                {!selectedEvidence ? (
                  <div className="text-sm text-white/50">
                    Select an evidence item to review.
                  </div>
                ) : (
                  <>
                    <div className="space-y-3 rounded-2xl border border-white/10 bg-black/20 p-4">
                      <Row k="Kind" v={selectedEvidence.kind || "—"} />
                      <Row k="File" v={selectedEvidence.file_name || "—"} />
                      <Row k="MIME" v={selectedEvidence.mime_type || "—"} />
                      <Row
                        k="Size"
                        v={
                          selectedEvidence.size_bytes != null
                            ? `${selectedEvidence.size_bytes.toLocaleString()} bytes`
                            : "—"
                        }
                      />
                      <Row k="Hash" v={selectedEvidence.file_hash || "—"} mono />
                      <Row
                        k="Stored"
                        v={
                          selectedEvidence.storage_bucket &&
                          selectedEvidence.storage_path
                            ? `${selectedEvidence.storage_bucket}/${selectedEvidence.storage_path}`
                            : "—"
                        }
                        mono
                      />
                      <Row k="Uploaded" v={selectedEvidence.uploaded_at || "—"} />
                      <Row
                        k="Verified"
                        v={
                          selectedEvidence.is_verified
                            ? `YES${
                                selectedEvidence.verified_at
                                  ? ` • ${selectedEvidence.verified_at}`
                                  : ""
                              }`
                            : "NO"
                        }
                      />
                    </div>

                    <div className="mt-4 flex flex-col gap-2">
                      <button
                        onClick={() => openEvidence(selectedEvidence)}
                        disabled={
                          !selectedEvidence.storage_bucket ||
                          !selectedEvidence.storage_path
                        }
                        className={cx(
                          "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                          selectedEvidence.storage_bucket &&
                            selectedEvidence.storage_path
                            ? "border-white/10 bg-white/5 text-white/85 hover:border-amber-300/20 hover:bg-white/7"
                            : "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                        )}
                      >
                        Open Document
                      </button>

                      <div className="grid grid-cols-2 gap-2">
                        <button
                          onClick={() => setVerified(selectedEvidence, true)}
                          disabled={!!selectedEvidence.is_verified}
                          className={cx(
                            "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                            selectedEvidence.is_verified
                              ? "cursor-not-allowed border-emerald-300/15 bg-emerald-400/5 text-emerald-200/40"
                              : "border-emerald-300/20 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/14"
                          )}
                        >
                          Verify
                        </button>

                        <button
                          onClick={() => setVerified(selectedEvidence, false)}
                          disabled={!selectedEvidence.is_verified}
                          className={cx(
                            "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                            !selectedEvidence.is_verified
                              ? "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                              : "border-rose-300/20 bg-rose-400/10 text-rose-200 hover:bg-rose-400/14"
                          )}
                        >
                          Unverify
                        </button>
                      </div>

                      <div className="pt-2 text-xs text-white/40">
                        Read-only console. Evidence submission happens in the
                        public portal. Verification is RPC-only.
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-5 text-[10px] text-white/35">
          Source: public.v_onboarding_admissions_inbox • entity_slug={entityKey} •
          lane={isTest ? "SANDBOX" : "RoT"}
        </div>
      </div>
    </div>
  );
}
