import { useLocation } from 'react-router-dom';
import { BookOpen, ShieldCheck } from 'lucide-react';

interface HeaderProps {
  current?: 'admin' | 'ledger';
}

export function Header({ current }: HeaderProps = {}) {
  const location = useLocation();

  const isLedger = current === 'ledger' || location.pathname === '/ledger';
  const isAdmin = current === 'admin' || location.pathname === '/admin' || location.pathname === '/';

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-card/90 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6">
        {/* Logo and Brand Name (No cross-page link) */}
        <div className="flex items-center gap-3 select-none">
          <img 
            src="/crc-logo.png" 
            alt="CRC Logo" 
            className="h-8 w-auto object-contain" 
          />
          <div>
            <h1 className="font-display text-sm font-bold tracking-tight text-ink sm:text-base">
              CRC Transport
            </h1>
            <p className="text-[10px] font-medium text-muted">
              Johannesburg
            </p>
          </div>
        </div>

        {/* Current Portal Badge (No cross-page navigation links) */}
        <div className="flex items-center gap-2">
          {isAdmin && (
            <div className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold bg-card-2 border border-line text-ink">
              <ShieldCheck className="h-3.5 w-3.5 text-crimson-400" />
              <span>Admin Dispatch</span>
            </div>
          )}
          {isLedger && (
            <div className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold bg-card-2 border border-line text-ink">
              <BookOpen className="h-3.5 w-3.5 text-amber-400" />
              <span>Cancellation Ledger</span>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
