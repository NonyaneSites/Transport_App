export function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function parseDate(yyyyMmDd?: string | null): Date {
  if (!yyyyMmDd || typeof yyyyMmDd !== 'string') return new Date();
  const parts = yyyyMmDd.split('-');
  if (parts.length < 3) return new Date(yyyyMmDd);
  const [y, m, d] = parts.map(Number);
  if (isNaN(y) || isNaN(m) || isNaN(d)) return new Date();
  return new Date(y, m - 1, d);
}

export function upcomingSunday(): string {
  const now = new Date();
  const day = now.getDay();
  const diff = (7 - day) % 7;
  const sunday = new Date(now);
  sunday.setDate(now.getDate() + diff);
  return formatDate(sunday);
}

export function prettyDate(yyyyMmDd?: string | null): string {
  if (!yyyyMmDd) return '—';
  const d = parseDate(yyyyMmDd);
  if (isNaN(d.getTime())) return yyyyMmDd;
  return d.toLocaleDateString('en-ZA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

/** DD/MM/YYYY — used on the Cancellation Ledger, e.g. "08/02/2026" */
export function shortDate(yyyyMmDd?: string | null): string {
  if (!yyyyMmDd) return '—';
  const d = parseDate(yyyyMmDd);
  if (isNaN(d.getTime())) return yyyyMmDd;
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${d.getFullYear()}`;
}

export function manifestKey(date: string, service: string): string {
  return `${date}_${service}`;
}

export function parseManifestKey(key?: string | null): { date: string; service: string } {
  if (!key || typeof key !== 'string') return { date: '', service: '' };
  const idx = key.indexOf('_');
  if (idx === -1) return { date: key, service: '' };
  const date = key.slice(0, idx);
  const service = key.slice(idx + 1);
  return { date, service };
}
