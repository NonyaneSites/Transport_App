export function Footer() {
  return (
    <footer className="mt-16 border-t border-line bg-card/40">
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-3 px-6 py-5 text-center sm:flex-row sm:text-left">
        <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2.5">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-crimson-500/10 border border-crimson-500/25 px-2.5 py-0.5 text-[11px] font-mono font-medium text-crimson-300">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
            v2.5.0 · Updated Aug 2026
          </span>
          <span className="hidden sm:inline text-xs text-muted">·</span>
          <p className="text-xs text-muted">
            CRC Johannesburg · Transport Ministry Dispatch System
          </p>
        </div>
        <p className="font-display text-xs font-semibold text-crimson-400">
          2026 — The Year of Invasion, the Second Wave of Love
        </p>
      </div>
    </footer>
  );
}
