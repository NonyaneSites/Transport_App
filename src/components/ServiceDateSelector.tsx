import { Calendar, Clock } from 'lucide-react';
import { SERVICE_TYPES, type ServiceType } from '@/lib/types';
import { prettyDate } from '@/lib/dates';

interface Props {
  date: string;
  service: ServiceType;
  onDateChange: (d: string) => void;
  onServiceChange: (s: ServiceType) => void;
}

export function ServiceDateSelector({ date, service, onDateChange, onServiceChange }: Props) {
  return (
    <div className="card">
      <div className="mb-4 flex items-center gap-2">
        <div className="h-5 w-1 rounded-full bg-crimson-500" />
        <h2 className="font-display text-sm font-bold uppercase tracking-wider text-ink">Service Selection</h2>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">
            Sunday Date
          </label>
          <div className="relative">
            <Calendar className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input
              type="date"
              value={date}
              onChange={(e) => onDateChange(e.target.value)}
              className="input-field pl-10"
            />
          </div>
          {date && /^\d{4}-\d{2}-\d{2}$/.test(date) && prettyDate(date) !== '—' && (
            <p className="mt-1.5 text-xs text-muted">{prettyDate(date)}</p>
          )}
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">
            Service Type
          </label>
          <div className="relative">
            <Clock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <select
              value={service}
              onChange={(e) => onServiceChange(e.target.value as ServiceType)}
              className="input-field pl-10"
            >
              {SERVICE_TYPES.map((s) => (
                <option key={s.value} value={s.value} className="bg-card-2 text-ink">
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <p className="mt-1.5 text-xs text-muted">
            {service === 'AM_Ushers'
              ? 'Ushers Early Service transport'
              : service === 'AM_Serving'
              ? 'AM Serving ministries transport'
              : service === 'AM_Normal'
              ? 'AM Standard Sunday service transport'
              : service.includes('Serving')
              ? 'PM Serving ministries transport'
              : 'PM Standard Sunday service transport'}
          </p>
        </div>
      </div>
    </div>
  );
}
