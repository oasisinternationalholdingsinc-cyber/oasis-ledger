// src/app/(os)/page.tsx
export default function DashboardPlaceholder() {
  return (
    <div className="w-full h-full flex flex-col gap-6">
      {/* HEADER */}
      <div className="max-w-3xl">
        <div className="text-[11px] uppercase tracking-[0.28em] text-slate-500">
          Operator Console
        </div>
        <h1 className="mt-2 text-2xl font-semibold text-slate-100">
          Oasis OS • Governance Console
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-400">
          Authority flow across Admissions, Drafts, Council, Forge, Archive, and Verified
          surfaces. This dashboard is a docket — instrumentation first, action second.
        </p>
      </div>

      {/* INSTRUMENTATION BAND */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        {[
          { k: "Admissions", v: "—", sub: "Inbox" },
          { k: "Drafts", v: "—", sub: "Needs work" },
          { k: "Council", v: "—", sub: "Pending" },
          { k: "Forge", v: "—", sub: "Active" },
          { k: "Archive", v: "—", sub: "Exceptions" },
          { k: "Verified", v: "—", sub: "Today" },
        ].map((x) => (
          <div
            key={x.k}
            className="rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-3"
          >
            <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">
              {x.k}
            </div>
            <div className="mt-2 flex items-baseline justify-between gap-3">
              <div className="text-lg font-semibold text-slate-100">{x.v}</div>
              <div className="text-[11px] text-slate-500">{x.sub}</div>
            </div>
          </div>
        ))}
      </div>

      {/* MAIN DOCKET SURFACE */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* LEFT: PRIORITY QUEUE */}
        <section className="lg:col-span-5">
          <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">
                  Priority Queue
                </div>
                <div className="mt-2 text-sm text-slate-300">
                  Top items requiring authority attention. Cross-module docket.
                </div>
              </div>

              <div className="rounded-full border border-slate-800 bg-slate-950/70 px-3 py-1 text-[10px] uppercase tracking-[0.22em] text-slate-500">
                Placeholder
              </div>
            </div>

            <div className="mt-4 space-y-3">
              {[
                {
                  dot: "bg-amber-300/80",
                  lane: "SANDBOX",
                  mod: "Admissions",
                  state: "IN_REVIEW",
                  title: "Oasis Custodial Registry",
                  age: "—",
                },
                {
                  dot: "bg-amber-300/80",
                  lane: "SANDBOX",
                  mod: "Council",
                  state: "PENDING",
                  title: "Resolution awaiting decision",
                  age: "—",
                },
                {
                  dot: "bg-slate-500/70",
                  lane: "SANDBOX",
                  mod: "Forge",
                  state: "ACTIVE",
                  title: "Envelope signing in progress",
                  age: "—",
                },
                {
                  dot: "bg-red-400/80",
                  lane: "SANDBOX",
                  mod: "Archive",
                  state: "EXCEPTION",
                  title: "Missing primary pointer",
                  age: "—",
                },
                {
                  dot: "bg-slate-500/70",
                  lane: "SANDBOX",
                  mod: "Drafts",
                  state: "NEEDS_WORK",
                  title: "Draft requires edits before finalize",
                  age: "—",
                },
              ].map((r, i) => (
                <div
                  key={i}
                  className="group rounded-2xl border border-slate-800 bg-slate-950/70 p-4 transition hover:border-amber-300/25 hover:bg-slate-950"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`h-2 w-2 rounded-full ${r.dot}`} />
                        <span className="text-[10px] uppercase tracking-[0.22em] text-slate-500">
                          {r.mod}
                        </span>
                        <span className="rounded-full border border-slate-800 bg-slate-950/60 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-slate-400">
                          {r.state}
                        </span>
                        <span className="rounded-full border border-slate-800 bg-slate-950/60 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-slate-500">
                          {r.lane}
                        </span>
                      </div>

                      <div className="mt-2 text-sm font-semibold text-slate-100">
                        {r.title}
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        Age: {r.age} • Click to focus (wired later)
                      </div>
                    </div>

                    <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-1.5 text-xs font-semibold text-slate-200 opacity-80 transition group-hover:border-amber-300/25 group-hover:opacity-100">
                      Open
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 text-xs text-slate-500">
              This list will be driven by a single “dashboard snapshot” query (counts + top
              docket items) to avoid fragmented wiring.
            </div>
          </div>
        </section>

        {/* CENTER: FOCUS PANE */}
        <section className="lg:col-span-4">
          <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
            <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">
              Focus
            </div>
            <div className="mt-2 text-sm text-slate-300">
              Select an item in the docket to view the case file, state, and primary action.
            </div>

            <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
              <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">
                No item selected
              </div>
              <div className="mt-2 text-sm text-slate-400">
                The console is designed for single-case operation: one record in focus,
                actions deliberate, audit implied.
              </div>

              <div className="mt-4 grid grid-cols-1 gap-2">
                {[
                  "Begin Review",
                  "Request Info",
                  "Approve / Route",
                  "Reject / Archive",
                ].map((x) => (
                  <div
                    key={x}
                    className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs font-semibold text-slate-400"
                  >
                    {x} (disabled)
                  </div>
                ))}
              </div>

              <div className="mt-4 text-xs text-slate-500">
                Wired later: actions become context-aware based on module + state (Admissions,
                Drafts, Council, Forge, Archive).
              </div>
            </div>
          </div>
        </section>

        {/* RIGHT: AXIOM BRIEF */}
        <section className="lg:col-span-3">
          <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[10px] uppercase tracking-[0.22em] text-amber-300/85">
                  AXIOM Brief
                </div>
                <div className="mt-2 text-sm text-slate-300">
                  Quiet advisory signals. Non-blocking. Links to docket items once wired.
                </div>
              </div>

              <div className="rounded-full border border-slate-800 bg-slate-950/70 px-3 py-1 text-[10px] uppercase tracking-[0.22em] text-slate-500">
                Read-only
              </div>
            </div>

            <div className="mt-4 space-y-3">
              {[
                { s: "🟢", t: "System stable. No authority backlog detected." },
                { s: "🟡", t: "3 items exceed expected dwell time (review recommended)." },
                { s: "🔴", t: "1 archive exception requires repair before verification." },
              ].map((x, i) => (
                <div
                  key={i}
                  className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4"
                >
                  <div className="flex items-start gap-3">
                    <div className="text-sm">{x.s}</div>
                    <div className="text-sm text-slate-200">{x.t}</div>
                  </div>
                  <div className="mt-2 text-xs text-slate-500">
                    Wired later: each signal becomes a deep link into the docket.
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 rounded-2xl border border-amber-300/20 bg-amber-950/10 p-4">
              <div className="text-[10px] uppercase tracking-[0.22em] text-amber-200">
                Discipline
              </div>
              <div className="mt-2 text-sm text-slate-300">
                AXIOM advises. Authority decides. Nothing blocks execution.
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* ACTIVITY FEED */}
      <section className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-slate-500">
              Recent Activity
            </div>
            <div className="mt-2 text-sm text-slate-300">
              Latest actions across the organism. Audit-style, calm, chronological.
            </div>
          </div>

          <div className="rounded-full border border-slate-800 bg-slate-950/70 px-3 py-1 text-[10px] uppercase tracking-[0.22em] text-slate-500">
            Placeholder
          </div>
        </div>

        <div className="mt-4 space-y-2">
          {[
            "Admissions: status changed → IN_REVIEW",
            "Council: decision recorded → APPROVED",
            "Forge: envelope completed → SIGNED",
            "Archive: record sealed → VERIFIED REGISTERED",
          ].map((x, i) => (
            <div
              key={i}
              className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-sm text-slate-300"
            >
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0 truncate">{x}</div>
                <div className="text-xs text-slate-500">—</div>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 text-xs text-slate-500">
          Wired later: a single activity feed (last 20) with lane + entity + deep links.
        </div>
      </section>
    </div>
  );
}
