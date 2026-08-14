import { NavLink } from 'react-router-dom';
import { Cross, Radio, BookOpen } from 'lucide-react';
import { useConnection, type ConnectionState } from '@/lib/useConnection';

type PageKey = 'admin' | 'ledger';

interface HeaderProps {
  current?: PageKey;
}

const NAV_ITEMS: { key: PageKey; label: string; to: string; icon: React.ReactNode }[] = [
  { key: 'admin', label: 'Admin Dispatch', to: '/', icon: <Radio className="h-4 w-4" /> },
  { key: 'ledger', label: 'Cancellation Ledger', to: '/ledger', icon: <BookOpen className="h-4 w-4" /> },
];

function StatusDot({ state }: { state: ConnectionState }) {
  const color =
    state === 'online' ? 'bg-success' : state === 'offline' ? 'bg-crimson-500' : 'bg-yellow-500';
  const label = state === 'online' ? 'Live' : state === 'offline' ? 'Offline' : 'Connecting';
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-line bg-card-2 px-3 py-1.5 text-xs font-medium">
      <span className={`h-2 w-2 rounded-full ${color} animate-pulse-dot`} />
      <span className={state === 'online' ? 'text-success-light' : state === 'offline' ? 'text-crimson-300' : 'text-yellow-400'}>
        {label}
      </span>
    </span>
  );
}

export function Header({ current }: HeaderProps) {
  const conn = useConnection();
  const activeKey = current ?? 'admin';
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/90 backdrop-blur-md">
      <div className="bg-grid absolute inset-0 opacity-40 pointer-events-none" />
      <div className="relative mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex items-center gap-3">
          {/* CRC Logo */}
          <div className="relative flex h-12 w-12 items-center justify-center rounded-xl bg-crimson-500/15 border-2 border-crimson-500/40 shadow-crimson">
            <Cross className="h-6 w-6 text-crimson-400" strokeWidth={2.5} />
            <span className="absolute -right-0.5 -top-0.5 flex h-3 w-3">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success/60" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-success" />
            </span>
          </div>
          <div className="leading-tight">
            <div className="font-display text-base font-bold tracking-tight text-ink">
              CRC Johannesburg <span className="text-crimson-400">Transport</span>
            </div>
            <div className="hidden text-[11px] font-medium text-muted sm:block">
              2026 — The Year of Invasion, the Second Wave of Love
            </div>
          </div>
        </div>

        <nav className="flex items-center gap-1 overflow-x-auto">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.key}
              to={item.to}
              className={`nav-link ${activeKey === item.key ? 'nav-link-active' : 'nav-link-inactive'}`}
            >
              {item.icon}
              {item.label}
            </NavLink>
          ))}
          <div className="ml-2 hidden sm:block">
            <StatusDot state={conn} />
          </div>
        </nav>
      </div>
    </header>
  );
}
