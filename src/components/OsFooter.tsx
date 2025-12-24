export function OsFooter() {
  return (
    <footer className="fixed bottom-0 left-0 right-0 z-40 pointer-events-none">
      <div className="bg-gradient-to-r from-amber-950/80 via-amber-900/60 to-amber-950/80 border-t border-amber-700/40">
        <div className="mx-auto max-w-[1600px] px-6 py-2 flex items-center justify-between">
          <span className="text-[11px] tracking-wide text-amber-300">
            SANDBOX ENVIRONMENT
            <span className="mx-2 text-amber-500">•</span>
            Test artifacts only
            <span className="mx-2 text-amber-500">•</span>
            Not the system of record
          </span>

          <span className="text-[11px] text-amber-400/70">
            Style B active
          </span>
        </div>
      </div>
    </footer>
  );
}
