import { useLocation } from 'react-router-dom';
import { BookOpen, ShieldCheck, Smartphone } from 'lucide-react';

interface HeaderProps {
  current?: 'admin' | 'ledger' | 'rep';
}

export function Header({ current }: HeaderProps = {}) {
  const location = useLocation();

  const isLedger = current === 'ledger' || location.pathname === '/ledger';
  const isRep = current === 'rep' || location.pathname === '/rep';

  const portalConfig = isLedger
    ? {
        label: 'Cancellation Ledger',
        badgeClass: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
        Icon: BookOpen,
      }
    : isRep
    ? {
        label: 'Rep Portal',
        badgeClass: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
        Icon: Smartphone,
      }
    : {
        label: 'Admin Portal',
        badgeClass: 'bg-crimson-500/15 text-crimson-300 border-crimson-500/30',
        Icon: ShieldCheck,
      };

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-card/95 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-2.5 sm:px-6">
        {/* Brand (static, non-navigating to prevent page swapping) */}
        <div className="flex items-center gap-2.5 select-none">
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
        </div>

        {/* Current Portal Badge (isolated - no links to switch pages) */}
        <div className="flex items-center gap-2">
          <div className={`flex items-center gap-1.5 rounded-lg px-2.5 sm:px-3 py-1.5 text-xs font-semibold border ${portalConfig.badgeClass}`}>
            <portalConfig.Icon className="h-3.5 w-3.5" />
            <span>{portalConfig.label}</span>
          </div>
        </div>
      </div>
    </header>
  );
}
