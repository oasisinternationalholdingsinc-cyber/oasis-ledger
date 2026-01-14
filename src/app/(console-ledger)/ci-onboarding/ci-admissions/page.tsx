// ci-onboarding/ci-admissions/page.tsx
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
  submitted_at: string | null;
  triaged_at: string | null;
  decided_at: string | null;
  provisioned_at: string | null;
  created_at: string | null;
  updated_at: string | null;

  applicant_type: string | null;
  applicant_name: string | null;
  applicant_email: string | null;
  applicant_phone: string | null;

  organization_legal_name: string | null;
  organization_trade_name: string | null;
  organization_email: string | null; // in your view it aliases applicant_email
  website: string | null;

  incorporation_number: string | null;
  jurisdiction_country: string | null;
  jurisdiction_region: string | null;

  intent: string | null; // ✅ use this as the "request"
  requested_services: any | null;
  expected_start_date: string | null;

  risk_tier: string | null;
  risk_notes: string | null;

  entity_id: string | null;
  entity_slug: string | null;

  primary_contact_user_id: string | null;
  assigned_to: string | null;
  decided_by: string | null;
  created_by: string | null;

  metadata: any | null;

  // Optional columns if you later add them to the view
  lane_is_test?: boolean | null;
  is_test?: boolean | null;
};

type AppTab = "INTAKE" | "ALL" | "ARCHIVED";

function Pill({
  active,
  onClick,
  children,
  tone,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  tone?: "neutral" | "good" | "warn";
}) {
  const base = "rounded-full px-3 py-1 text-[11px] font-medium transition";
  const activeCls =
    tone === "good"
      ? "bg-emerald-400/10 text-emerald-200 ring-1 ring-emerald-300/20"
      : tone === "warn"
        ? "bg-amber-400/10 text-amber-200 ring-1 ring-amber-300/20"
        : "bg-white/8 text-white/85 ring-1 ring-white/12";
  const idle = "text-white/55 hover:text-white/75";

  return (
    <button onClick={onClick} className={cx(base, active ? activeCls : idle)}>
      {children}
    </button>
  );
}

function KV({
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

export default function CiAdmissionsPage() {
  // ✅ Entity (defensive; matches Evidence page)
  const ec = useEntity() as any;
  const entityKey: string =
    (ec?.entityKey as string) ||
    (ec?.activeEntity as string) ||
    (ec?.entity_slug as string) ||
    "";

  const entityName: string =
    (ec?.entityName as string) ||
    (ec?.activeEntityName as string) ||
    (ec?.entities?.find?.(
      (x: any) => x?.slug === entityKey || x?.key === entityKey
    )?.name as string) ||
    entityKey;

  // ✅ Env (defensive; fixes your build error)
  const env = useOsEnv() as any;
  const isTest: boolean = Boolean(
    env?.is_test ?? env?.isTest ?? env?.lane_is_test ?? env?.sandbox ?? env?.isSandbox
  );

  const [tab, setTab] = useState<AppTab>("INTAKE");
  const [q, setQ] = useState("");

  const [rows, setRows] = useState<InboxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [refreshKey, setRefreshKey] = useState(0);

  // action state
  const [busy, setBusy] = useState<string | null>(null);

  const selected = useMemo(
    () => rows.find((r) => r.id === selectedId) || null,
    [rows, selectedId]
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = rows;

    if (tab === "INTAKE") {
      const allow = new Set(["SUBMITTED", "IN_REVIEW", "NEEDS_INFO"]);
      list = list.filter((r) => allow.has(normStatus(r.status)));
    } else if (tab === "ARCHIVED") {
      list = list.filter((r) => normStatus(r.status) === "ARCHIVED");
    }

    if (!needle) return list;

    return list.filter((r) => {
      const blob = [
        r.organization_legal_name,
        r.organization_trade_name,
        r.applicant_name,
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
  }, [rows, q, tab]);

  // -------- load inbox (entity-scoped; lane-safe if lane columns exist) --------
  useEffect(() => {
    let alive = true;

    (async () => {
      setLoading(true);
      setErr(null);

      try {
        const baseCols = [
          "id",
          "status",
          "submitted_at",
          "triaged_at",
          "decided_at",
          "provisioned_at",
          "created_at",
          "updated_at",
          "applicant_type",
          "applicant_name",
          "applicant_email",
          "applicant_phone",
          "organization_legal_name",
          "organization_trade_name",
          "organization_email",
          "website",
          "incorporation_number",
          "jurisdiction_country",
          "jurisdiction_region",
          "intent",
          "requested_services",
          "expected_start_date",
          "risk_tier",
          "risk_notes",
          "entity_id",
          "entity_slug",
          "primary_contact_user_id",
          "assigned_to",
          "decided_by",
          "created_by",
          "metadata",
        ];

        const tryWithLane = async (laneCol: "lane_is_test" | "is_test") => {
          const { data, error } = await supabase
            .from("v_onboarding_admissions_inbox")
            .select([...baseCols, laneCol].join(","))
            .eq("entity_slug", entityKey)
            .eq(laneCol, isTest)
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

        // Attempt lane-safe first, but fall back cleanly if the view doesn't have the columns.
        let res = await tryWithLane("lane_is_test");
        if (
          res.error &&
          /lane_is_test|42703|undefined column/i.test(res.error.message)
        ) {
          res = await tryWithLane("is_test");
        }
        if (
          res.error &&
          /is_test|42703|undefined column/i.test(res.error.message)
        ) {
          res = await tryWithoutLane();
        }

        if (res.error) throw res.error;
        if (!alive) return;

        const list = (res.data || []) as InboxRow[];
        setRows(list);

        if (!selectedId && list.length) setSelectedId(list[0].id);
        else if (selectedId && !list.some((x) => x.id === selectedId)) {
          setSelectedId(list[0]?.id ?? null);
        }
      } catch (e: any) {
        if (!alive) return;
        setErr(e?.message || "Failed to load admissions inbox.");
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

  const selectedTitle = useMemo(() => {
    if (!selected) return "Select an application";
    return (
      selected.organization_trade_name ||
      selected.organization_legal_name ||
      selected.applicant_email ||
      selected.id
    );
  }, [selected]);

  async function rpc(name: string, args: Record<string, any>) {
    const { error } = await supabase.rpc(name, args);
    if (error) throw error;
  }

  async function beginReview() {
    if (!selected) return;
    setBusy("begin");
    try {
      await rpc("admissions_begin_review", { p_application_id: selected.id });
      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "Begin review failed.");
    } finally {
      setBusy(null);
    }
  }

  async function archive() {
    if (!selected) return;
    setBusy("archive");
    try {
      await rpc("admissions_set_status", {
        p_application_id: selected.id,
        p_next_status: "ARCHIVED",
        p_note: "Archived from console.",
      });
      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "Archive failed.");
    } finally {
      setBusy(null);
    }
  }

  /**
   * ✅ INVITE = AUTH ONLY
   * Calls the Edge Function that sends a Supabase Auth invite / set-password link.
   * Provisioning (entity creation/memberships/tasks) stays in CI-Provisioning.
   */
  async function runInvite() {
    if (!selected) return;
    if (!selected.applicant_email) {
      alert("Missing applicant_email on this application.");
      return;
    }

    setBusy("invite");
    try {
      const { data, error } = await supabase.functions.invoke(
        "admissions-provision-portal-access",
        {
          body: {
            application_id: selected.id,
            applicant_email: selected.applicant_email,
            // keep body minimal: auth-only contract
            mode: "INVITE_ONLY",
          },
        }
      );

      if (error) throw error;

      // If your function returns ok:false, surface it.
      if (data && data.ok === false) {
        throw new Error(data.error || data.detail || "Invite failed.");
      }

      alert("Invite sent. Client will set a password via the secure link.");
      setRefreshKey((n) => n + 1);
    } catch (e: any) {
      alert(e?.message || "Invite failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="h-full w-full">
      <div className="mx-auto w-full max-w-[1400px] px-4 pb-10 pt-6">
        <div className="mb-5 flex items-end justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.28em] text-white/45">
              CI • Admissions
            </div>
            <div className="mt-1 text-2xl font-semibold text-white/90">
              Admissions Console
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
          {/* Left: Queue */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-semibold tracking-wide text-white/80">
                    Inbox
                  </div>
                  <div className="flex gap-2">
                    <Pill
                      active={tab === "INTAKE"}
                      onClick={() => setTab("INTAKE")}
                      tone="good"
                    >
                      Intake
                    </Pill>
                    <Pill active={tab === "ALL"} onClick={() => setTab("ALL")}>
                      All
                    </Pill>
                    <Pill
                      active={tab === "ARCHIVED"}
                      onClick={() => setTab("ARCHIVED")}
                      tone="neutral"
                    >
                      Archived
                    </Pill>
                  </div>
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
                              <div className="truncate text-sm font-semibold text-white/88">
                                {name}
                              </div>
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

          {/* Middle: Application */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="text-xs font-semibold tracking-wide text-white/80">
                  Application
                </div>
                <div className="mt-1 truncate text-sm text-white/60">
                  {selectedTitle}
                </div>
              </div>

              <div className="p-4">
                {!selected ? (
                  <div className="text-sm text-white/50">Select an application.</div>
                ) : (
                  <>
                    <div className="space-y-3 rounded-2xl border border-white/10 bg-black/20 p-4">
                      <KV k="Status" v={selected.status || "—"} />
                      <KV k="Applicant" v={selected.applicant_name || "—"} />
                      <KV k="Applicant Email" v={selected.applicant_email || "—"} mono />
                      <KV k="Applicant Phone" v={selected.applicant_phone || "—"} />
                      <KV k="Org Legal" v={selected.organization_legal_name || "—"} />
                      <KV k="Org Trade" v={selected.organization_trade_name || "—"} />
                      <KV k="Website" v={selected.website || "—"} />
                      <KV
                        k="Jurisdiction"
                        v={
                          [selected.jurisdiction_region, selected.jurisdiction_country]
                            .filter(Boolean)
                            .join(", ") || "—"
                        }
                      />
                      <KV k="Incorp #" v={selected.incorporation_number || "—"} mono />
                      <KV
                        k="Request (intent)"
                        v={selected.intent || "—"}
                      />
                      <KV
                        k="Services"
                        v={
                          selected.requested_services
                            ? JSON.stringify(selected.requested_services)
                            : "—"
                        }
                        mono
                      />
                      <KV k="Start" v={selected.expected_start_date || "—"} />
                      <KV k="Risk Tier" v={selected.risk_tier || "—"} />
                      <KV k="Risk Notes" v={selected.risk_notes || "—"} />
                    </div>

                    <div className="mt-4 grid grid-cols-2 gap-2">
                      <button
                        onClick={beginReview}
                        disabled={busy !== null}
                        className={cx(
                          "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                          busy
                            ? "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                            : "border-white/10 bg-white/5 text-white/85 hover:border-amber-300/20 hover:bg-white/7"
                        )}
                      >
                        Begin Review
                      </button>

                      <button
                        onClick={archive}
                        disabled={busy !== null}
                        className={cx(
                          "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                          busy
                            ? "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                            : "border-white/10 bg-white/5 text-white/85 hover:border-amber-300/20 hover:bg-white/7"
                        )}
                      >
                        Archive
                      </button>
                    </div>

                    <div className="mt-2 rounded-2xl border border-amber-300/15 bg-amber-400/5 p-4">
                      <div className="text-[11px] uppercase tracking-[0.22em] text-amber-200/70">
                        Invite (Auth Only)
                      </div>
                      <div className="mt-1 text-sm text-white/70">
                        Sends a secure set-password link to the applicant.{" "}
                        <span className="text-white/55">
                          No entity creation. No memberships. Provisioning happens in CI-Provisioning.
                        </span>
                      </div>

                      <button
                        onClick={runInvite}
                        disabled={busy !== null}
                        className={cx(
                          "mt-3 w-full rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                          busy
                            ? "cursor-not-allowed border-white/10 bg-white/3 text-white/35"
                            : "border-emerald-300/20 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/14"
                        )}
                      >
                        {busy === "invite" ? "Sending Invite…" : "Run Invite"}
                      </button>
                    </div>

                    <div className="pt-3 text-xs text-white/40">
                      Admissions is read-only authority + decisions. Provisioning is a separate module.
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Right: Metadata / operator view */}
          <div className="col-span-12 lg:col-span-4">
            <div className="rounded-3xl border border-white/10 bg-black/20 shadow-[0_30px_140px_rgba(0,0,0,0.55)]">
              <div className="border-b border-white/10 p-4">
                <div className="text-xs font-semibold tracking-wide text-white/80">
                  Operator Notes
                </div>
                <div className="mt-1 truncate text-sm text-white/60">
                  {selected ? "Metadata + internal context" : "Select an application"}
                </div>
              </div>

              <div className="p-4">
                {!selected ? (
                  <div className="text-sm text-white/50">Select an application.</div>
                ) : (
                  <>
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                      <div className="text-[11px] uppercase tracking-[0.22em] text-white/45">
                        Raw metadata
                      </div>
                      <pre className="mt-3 max-h-[360px] overflow-auto whitespace-pre-wrap break-words rounded-2xl border border-white/10 bg-black/25 p-3 text-[12px] leading-5 text-white/70">
                        {JSON.stringify(selected.metadata ?? {}, null, 2)}
                      </pre>
                      <div className="mt-3 text-xs text-white/40">
                        If you want the “email body” visible in-console, store it in metadata (or add a dedicated column/event feed).
                      </div>
                    </div>

                    <div className="mt-4 text-[10px] text-white/35">
                      Source: public.v_onboarding_admissions_inbox • entity_slug={entityKey} •
                      env={isTest ? "SANDBOX" : "RoT"}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-5 text-[10px] text-white/35">
          Lane note: UI is lane-aware via OS env. Query is lane-filtered only if the view exposes lane columns.
        </div>
      </div>
    </div>
  );
}
