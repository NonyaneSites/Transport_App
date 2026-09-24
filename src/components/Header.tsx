import { Link, useLocation } from 'react-router-dom';
import { BookOpen, ShieldCheck, Smartphone } from 'lucide-react';

interface HeaderProps {
  current?: 'admin' | 'ledger' | 'rep';
}

export function Header({ current }: HeaderProps = {}) {
  const location = useLocation();

  const isLedger = current === 'ledger' || location.pathname === '/ledger';
  const isRep = current === 'rep' || location.pathname === '/rep';

  const brandContent = (
    <div className="flex items-center gap-2.5 select-none">
      <img 
        src="/crc-logo.png" 
        alt="CRC Logo" 
        className="h-8 w-auto object-contain" 
      />
      <div>
        <div className="flex items-center gap-1.5">
          <h1 className="font-display text-sm font-bold tracking-tight text-white sm:text-base">
            CRC Transport
          </h1>
          <span className="text-[8px] uppercase tracking-wider font-bold px-0.5 py-0.5 text-white border border-white/20 rounded-md">
            JHB
          </span>
        </div>
      </div>
    </div>
  );

  return (
    <header className="sticky top-0 z-40 border-b-[3px] border-[#E11D48] bg-[#031435] backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-2.5 sm:px-6">
        {/* Brand: non-navigating on Rep page, links to Admin on Admin/Ledger */}
        {isRep ? (
          brandContent
        ) : (
          <Link to="/admin" className="hover:opacity-90 transition-opacity" title="CRC Transport Home">
            {brandContent}
          </Link>
        )}

        {/* Portal Badges & Restricted Cross-Page Navigation */}
        <div className="flex items-center gap-2">
          {isRep ? (
            /* Rep Portal: Isolated, strictly NO links to Ledger or Admin */
            <div className="flex items-center gap-1.5 rounded-lg px-2.5 sm:px-3 py-1.5 text-xs font-semibold border bg-emerald-500/40 text-white border-emerald-500/30">
              <Smartphone className="h-3.5 w-3.5" />
              <span>Rep Portal</span>
            </div>
          ) : isLedger ? (
            /* Ledger Page: Can navigate to Admin, but NOT to Rep */
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
                <span>Admin Portal</span>
              </Link>
            </>
          ) : (
            /* Admin Page: Can navigate to Ledger, but NOT to Rep */
            <>
              <div className="flex items-center gap-1.5 rounded-lg px-2.5 sm:px-3 py-1.5 text-xs font-semibold border bg-crimson-500/60 text-card-3 border-crimson-500/30">
                <ShieldCheck className="h-3.5 w-3.5" />
                <span>Admin Portal</span>
              </div>
              <Link
                to="/ledger"
                className="flex items-center gap-1.5 rounded-lg px-2.5 sm:px-3 py-1.5 text-xs font-semibold border border-rose-500/30 bg-rose-500/60 text-card-3 hover:bg-rose-400/85 transition-colors"
                title="Switch to Cancellation Ledger"
              >
                <BookOpen className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Go to </span>
                <span>Cancellation Ledger</span>
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
