import { Link, useLocation } from 'react-router-dom';
import { BookOpen, ShieldCheck, Smartphone } from 'lucide-react';

interface HeaderProps {
  current?: 'admin' | 'ledger' | 'rep';
}

export function Header({ current }: HeaderProps = {}) {
  const location = useLocation();

  const isLedger = current === 'ledger' || location.pathname === '/ledger';
  const isRep = current === 'rep' || location.pathname === '/rep';
  const isAdmin = current === 'admin' || (!isLedger && !isRep);

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-card/95 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-2.5 sm:px-6">
        {/* Brand */}
        <Link to="/" className="flex items-center gap-2.5 transition hover:opacity-90">
          <img 
            src="/crc-logo.png" 
            alt="CRC Logo" 
            className="h-8 w-auto object-contain" 
          />
          <div>
            <div className="flex items-center gap-1.5">
              <h1 className="font-display text-sm font-bold tracking-tight text-ink sm:text-base">
                CRC Transport
              </h1>
              <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-crimson-500/15 text-crimson-400 border border-crimson-500/20">
                JHB
              </span>
            </div>
          </div>
        </Link>

        {/* Global Portals Navigation */}
        <nav className="flex items-center gap-1 sm:gap-2">
          <Link
            to="/admin"
            className={`flex items-center gap-1.5 rounded-lg px-2.5 sm:px-3 py-1.5 text-xs font-semibold transition ${
              isAdmin
                ? 'bg-crimson-600 text-white shadow-sm'
                : 'text-ink-muted hover:bg-card-2 hover:text-ink'
            }`}
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            <span>Admin</span>
          </Link>

          <Link
            to="/rep"
            className={`flex items-center gap-1.5 rounded-lg px-2.5 sm:px-3 py-1.5 text-xs font-semibold transition ${
              isRep
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'text-ink-muted hover:bg-card-2 hover:text-ink'
            }`}
          >
            <Smartphone className="h-3.5 w-3.5" />
            <span>Rep Portal</span>
          </Link>

          <Link
            to="/ledger"
            className={`flex items-center gap-1.5 rounded-lg px-2.5 sm:px-3 py-1.5 text-xs font-semibold transition ${
              isLedger
                ? 'bg-amber-600 text-white shadow-sm'
                : 'text-ink-muted hover:bg-card-2 hover:text-ink'
            }`}
          >
            <BookOpen className="h-3.5 w-3.5" />
            <span>Ledger</span>
          </Link>
        </nav>
      </div>
    </header>
  );
}
