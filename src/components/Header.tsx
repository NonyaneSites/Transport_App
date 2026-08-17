import { Link, useLocation } from 'react-router-dom';
import { Bus, BookOpen, ShieldCheck } from 'lucide-react';

export function Header() {
  const location = useLocation();

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-card/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6">
        
        {/* Logo and Brand Name */}
        <Link to="/" className="flex items-center gap-3 transition-opacity hover:opacity-90">
          <img 
            src="/crc-logo.png" 
            alt="CRC Logo" 
            className="h-9 w-auto object-contain" 
          />
          <div>
            <h1 className="font-display text-base font-bold tracking-tight text-ink sm:text-lg">
              CRC Transport
            </h1>
            <p className="text-[10px] font-medium text-muted sm:text-xs">
              Johannesburg Ministry
            </p>
          </div>
        </Link>

        {/* Navigation Tabs */}
        <nav className="flex items-center gap-1 sm:gap-2">
          <Link
            to="/admin"
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
              location.pathname === '/admin' || location.pathname === '/'
                ? 'bg-crimson-500/15 text-crimson-300 border border-crimson-500/30'
                : 'text-muted hover:text-ink'
            }`}
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Admin</span>
          </Link>

          <Link
            to="/rep"
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
              location.pathname === '/rep'
                ? 'bg-crimson-500/15 text-crimson-300 border border-crimson-500/30'
                : 'text-muted hover:text-ink'
            }`}
          >
            <Bus className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Rep Portal</span>
          </Link>

          <Link
            to="/ledger"
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
              location.pathname === '/ledger'
                ? 'bg-crimson-500/15 text-crimson-300 border border-crimson-500/30'
                : 'text-muted hover:text-ink'
            }`}
          >
            <BookOpen className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Ledger</span>
          </Link>
        </nav>
      </div>
    </header>
  );
}
