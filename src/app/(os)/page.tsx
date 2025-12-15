// src/app/(os)/page.tsx
export default function DashboardPlaceholder() {
  return (
    <div className="w-full h-full flex flex-col gap-6">
      <div className="max-w-xl">
        <h1 className="text-xl font-semibold text-slate-100 mb-2">
          Oasis OS • Shell Online
        </h1>
        <p className="text-sm text-slate-400 leading-relaxed">
          This is the empty living shell of the Oasis Digital Parliament
          organism. Use the mini-orb spine on the left to attach CI modules
          (Forge, Sentinel, Oracle, Archive, Council, and more) into this
          workspace.
        </p>
      </div>

      <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4 text-sm text-slate-300">
          <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500 mb-2">
            Step 1
          </div>
          <div className="font-medium mb-1">Wire Orb state to SQL</div>
          <p className="text-slate-400 text-xs">
            Replace the temporary Orb state with{" "}
            <code className="text-emerald-400">v_orb_state</code> and{" "}
            <code className="text-emerald-400">v_orb_state_global</code> from
            Supabase.
          </p>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4 text-sm text-slate-300">
          <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500 mb-2">
            Step 2
          </div>
          <div className="font-medium mb-1">Add module pages</div>
          <p className="text-slate-400 text-xs">
            Create simple <code className="text-emerald-400">page.tsx</code>{" "}
            files for Forge, Sentinel, Oracle, etc., and render their consoles
            inside this workspace.
          </p>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4 text-sm text-slate-300">
          <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500 mb-2">
            Step 3
          </div>
          <div className="font-medium mb-1">Enable Orb Focus mode</div>
          <p className="text-slate-400 text-xs">
            Later, clicking the Orb will open a small command lens to send
            questions to Sentinel, Oracle, or Council via CI-Kernel.
          </p>
        </div>
      </div>
    </div>
  );
}
