import { Link, useLocation } from 'react-router-dom';
import { BookOpen, ShieldCheck, Smartphone } from 'lucide-react';
import { useConnection } from '@/lib/useConnection';

interface HeaderProps {
  current?: 'admin' | 'ledger' | 'rep';
}

export function Header({ current }: HeaderProps = {}) {
  const location = useLocation();
  const connectionState = useConnection();

  const isLedger = current === 'ledger' || location.pathname === '/ledger';
  const isRep = current === 'rep' || location.pathname === '/rep';

  const brandContent = (
    <div className="flex items-center gap-2.5 select-none">
      <img 
        src="/crc-logo-96.webp" 
        alt="CRC Logo" 
        className="h-8 w-8 object-contain" 
        width="32"
        height="32"
      />
      <div>
        <div className="flex items-center gap-1.5">
          <h1 className="font-display text-sm font-bold tracking-tight text-ink sm:text-base">
            CRC Transport
          </h1>
          <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-crimson-500/15 text-crimson-400 border border-crimson-500/20">
            JHB
          </span>
          <span className="hidden sm:inline-flex text-[10px] font-mono text-muted/80 px-1.5 py-0.5 rounded bg-card-2 border border-line">
            v3.1 · Oct 2026
          </span>
        </div>
      </div>
    </div>
  );

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-card/95 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-2.5 sm:px-6">
        {/* Brand: non-navigating on Rep page, links to Admin on Admin/Ledger */}
        {isRep ? (
          brandContent
        ) : (
          <Link to="/admin" className="hover:opacity-90 transition-opacity" title="CRC Transport Home">
            {brandContent}
          </Link>
        )}

        {/* Portal Badges & Connection Indicator */}
        <div className="flex items-center gap-2">
          {/* Supabase Reachability Dot */}
          <div
            className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-card-2/60 border border-line text-xs select-none"
            title={
              connectionState === 'online'
                ? 'Database Connected (Supabase reachable)'
                : 'Database Offline / Unreachable'
            }
          >
            <span
              className={`h-2 w-2 rounded-full transition-colors ${
                connectionState === 'online'
                  ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]'
                  : 'bg-crimson-500 shadow-[0_0_8px_rgba(239,68,68,0.7)] animate-pulse'
              }`}
            />
            <span className="text-[10px] font-medium text-muted hidden sm:inline">
              {connectionState === 'online' ? 'Connected' : 'Offline'}
            </span>
          </div>
          {isRep ? (
            /* Rep Portal: Show Rep Portal badge only (not accessible to admin from reps) */
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 rounded-lg px-2.5 sm:px-3 py-1.5 text-xs font-semibold border bg-emerald-500/15 text-emerald-300 border-emerald-500/30">
                <Smartphone className="h-3.5 w-3.5" />
                <span>Rep Portal</span>
              </div>
            </div>
          ) : isLedger ? (
            /* Ledger Page: Can navigate to Admin and Rep Portal */
            <>
              <div className="flex items-center gap-1.5 rounded-lg px-2.5 sm:px-3 py-1.5 text-xs font-semibold border bg-amber-500/15 text-amber-300 border-amber-500/30">
                <BookOpen className="h-3.5 w-3.5" />
                <span>Cancellation Ledger</span>
              </div>
              <Link
                to="/admin"
                className="flex items-center gap-1.5 rounded-lg px-2.5 sm:px-3 py-1.5 text-xs font-semibold border border-crimson-500/30 bg-crimson-500/10 text-crimson-300 hover:bg-crimson-500/20 transition-colors"
                title="Switch to Admin Portal"
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Go to </span>
                <span>Admin</span>
              </Link>
              <Link
                to="/rep"
                className="flex items-center gap-1.5 rounded-lg px-2.5 sm:px-3 py-1.5 text-xs font-semibold border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 transition-colors"
                title="Open Reps Portal"
              >
                <Smartphone className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Rep </span>
                <span>Portal</span>
              </Link>
            </>
          ) : (
            /* Admin Page: Can navigate to Ledger, Rep Portal & Account Authorizations */
            <>
              <div className="flex items-center gap-1.5 rounded-lg px-2.5 sm:px-3 py-1.5 text-xs font-semibold border bg-crimson-500/15 text-crimson-300 border-crimson-500/30">
                <ShieldCheck className="h-3.5 w-3.5" />
                <span>Admin Portal</span>
              </div>
              <Link
                to="/ledger"
                className="flex items-center gap-1.5 rounded-lg px-2.5 sm:px-3 py-1.5 text-xs font-semibold border border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 transition-colors"
                title="Switch to Cancellation Ledger"
              >
                <BookOpen className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Go to </span>
                <span>Ledger</span>
              </Link>
              <Link
                to="/rep"
                className="flex items-center gap-1.5 rounded-lg px-2.5 sm:px-3 py-1.5 text-xs font-semibold border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 transition-colors"
                title="Open Reps Mobile Portal"
              >
                <Smartphone className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Rep </span>
                <span>Portal</span>
              </Link>
              <Link
                to="/admin/approve"
                className="flex items-center gap-1.5 rounded-lg px-2.5 sm:px-3 py-1.5 text-xs font-semibold border border-line bg-card-2 text-ink hover:bg-card transition-colors"
                title="Account Authorizations"
              >
                <span>Users</span>
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
