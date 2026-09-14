import { Link, useLocation } from 'react-router-dom';
import { Bus, BookOpen, ShieldCheck } from 'lucide-react';

export function Header() {
  const location = useLocation();

  const isCurrent = (path: string) => {
    if (path === '/admin') return location.pathname === '/admin' || location.pathname === '/';
    return location.pathname === path;
  };

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-card/90 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6">
        {/* Logo and Brand Name */}
        <Link to="/" className="flex items-center gap-3 transition-opacity hover:opacity-90">
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
        </Link>

        {/* Navigation Tabs */}
        <nav className="flex items-center gap-1 sm:gap-1.5 rounded-xl bg-card-2 p-1 border border-line">
          <Link
            to="/admin"
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
              isCurrent('/admin')
                ? 'bg-card text-ink shadow-subtle border border-line-bright'
                : 'text-muted hover:text-ink'
            }`}
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            <span>Admin</span>
          </Link>

          <Link
            to="/rep"
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
              isCurrent('/rep')
                ? 'bg-card text-ink shadow-subtle border border-line-bright'
                : 'text-muted hover:text-ink'
            }`}
          >
            <Bus className="h-3.5 w-3.5" />
            <span>Rep Portal</span>
          </Link>

          <Link
            to="/ledger"
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
              isCurrent('/ledger')
                ? 'bg-card text-ink shadow-subtle border border-line-bright'
                : 'text-muted hover:text-ink'
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
