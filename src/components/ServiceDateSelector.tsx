import { useState } from 'react';
import { Calendar, Clock, Plus } from 'lucide-react';
import { type ServiceType } from '@/lib/types';
import { prettyDate } from '@/lib/dates';
import { useServiceTypes } from '@/lib/serviceTypes';
import { AdminServiceTypesModal } from './AdminServiceTypesModal';

interface Props {
  date: string;
  service: ServiceType;
  onDateChange: (d: string) => void;
  onServiceChange: (s: ServiceType) => void;
  allowManageServices?: boolean;
}

export function ServiceDateSelector({
  date,
  service,
  onDateChange,
  onServiceChange,
  allowManageServices = true,
}: Props) {
  const { serviceTypes } = useServiceTypes();
  const [modalOpen, setModalOpen] = useState(false);

  const currentConfig = serviceTypes.find((s) => s.value === service);

  return (
    <>
      <div className="card">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-5 w-1 rounded-full bg-crimson-500" />
            <h2 className="font-display text-sm font-bold uppercase tracking-wider text-ink">Service Selection</h2>
          </div>
          {allowManageServices && (
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="flex items-center gap-1 text-xs font-semibold text-crimson-400 hover:text-crimson-300 transition-colors px-2 py-1 rounded-md hover:bg-crimson-500/10"
              title="Add a custom service type (e.g. Funeral, Dreamweek) or change cancellation acronyms"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Add / Manage Services</span>
            </button>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">
              Service Date
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
            <div className="mb-1.5 flex items-center justify-between">
              <label className="block text-xs font-semibold uppercase tracking-wide text-muted">
                Service Type
              </label>
              {currentConfig && (
                <span className="font-mono text-[11px] font-bold text-crimson-400 bg-crimson-500/10 border border-crimson-500/25 px-1.5 py-0.5 rounded">
                  Acronym: ({currentConfig.acronym})
                </span>
              )}
            </div>
            <div className="relative">
              <Clock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <select
                value={service}
                onChange={(e) => onServiceChange(e.target.value as ServiceType)}
                className="input-field pl-10 pr-8 font-medium"
              >
                {serviceTypes.map((s) => (
                  <option key={s.value} value={s.value} className="bg-card-2 text-ink">
                    [{s.acronym}] {s.label}
                  </option>
                ))}
              </select>
            </div>
            <p className="mt-1.5 text-xs text-muted">
              {currentConfig?.description
                ? currentConfig.description
                : service === 'AM_Ushers'
                ? 'Ushers Early Service transport · Cancellation acronym: (AM)'
                : service === 'AM_Serving'
                ? 'AM Serving ministries transport · Cancellation acronym: (AM)'
                : service === 'AM_Normal'
                ? 'AM Standard Sunday service transport · Cancellation acronym: (AM)'
                : service.includes('Serving')
                ? 'PM Serving ministries transport · Cancellation acronym: (PM)'
                : currentConfig?.acronym
                ? `${currentConfig.label} transport · Cancellation acronym: (${currentConfig.acronym})`
                : 'Sunday service transport'}
            </p>
          </div>
        </div>
      </div>

      <AdminServiceTypesModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onSelectService={(newVal) => onServiceChange(newVal as ServiceType)}
      />
    </>
  );
}
