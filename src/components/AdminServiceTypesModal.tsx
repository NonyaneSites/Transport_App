import { useState } from 'react';
import { X, Plus, Trash2, Tag, Calendar, Check, AlertCircle, Sparkles, Layers } from 'lucide-react';
import { useServiceTypes } from '@/lib/serviceTypes';
import type { ServiceTypeConfig } from '@/lib/types';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSelectService?: (serviceValue: string) => void;
}

export function AdminServiceTypesModal({ isOpen, onClose, onSelectService }: Props) {
  const { serviceTypes, addServiceType, deleteServiceType, loading } = useServiceTypes();

  const [name, setName] = useState('');
  const [acronym, setAcronym] = useState('');
  const [period, setPeriod] = useState<'AM' | 'PM' | 'OTHER'>('AM');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [deletingVal, setDeletingVal] = useState<string | null>(null);

  if (!isOpen) return null;

  const cleanAcronym = (acronym || name.slice(0, 3)).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);

    const cleanName = name.trim();
    if (!cleanName) {
      setError('Service name is required.');
      return;
    }

    if (!cleanAcronym) {
      setError('Cancellation acronym is required (e.g. FS, DW, AM).');
      return;
    }

    setSaving(true);
    try {
      const created = await addServiceType({
        label: cleanName,
        acronym: cleanAcronym,
        period,
        mode: 'Special',
        description: description.trim(),
      });

      setSuccessMsg(`Service type "${created.label}" (${created.acronym}) added successfully.`);
      setName('');
      setAcronym('');
      setDescription('');
      setPeriod('AM');

      if (onSelectService) {
        onSelectService(created.value);
      }

      setTimeout(() => {
        setSuccessMsg(null);
      }, 3500);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to create service type.';
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (service: ServiceTypeConfig) => {
    if (service.isSystem) return;
    if (!window.confirm(`Are you sure you want to remove "${service.label}" (${service.acronym})?`)) {
      return;
    }

    setDeletingVal(service.value);
    try {
      await deleteServiceType(service.value);
      setSuccessMsg(`Removed "${service.label}".`);
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to delete service.';
      setError(msg);
    } finally {
      setDeletingVal(null);
    }
  };

  const applyPreset = (presetName: string, presetAcronym: string, presetPeriod: 'AM' | 'PM' | 'OTHER', presetDesc: string) => {
    setName(presetName);
    setAcronym(presetAcronym);
    setPeriod(presetPeriod);
    setDescription(presetDesc);
    setError(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-4 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative flex max-h-[92vh] w-full max-w-2xl flex-col rounded-2xl border border-line bg-card shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line px-5 py-4 bg-card-2/60">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-crimson-500/15 text-crimson-400 border border-crimson-500/25">
              <Layers className="h-5 w-5" />
            </div>
            <div>
              <h2 className="font-display text-base font-bold text-ink">Service Types & Cancellation Acronyms</h2>
              <p className="text-xs text-muted">Manage church services, Dreamweek, and special event acronyms</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted hover:bg-card-2 hover:text-ink transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {error && (
            <div className="flex items-center gap-2 rounded-xl bg-crimson-500/10 border border-crimson-500/30 p-3 text-xs text-crimson-400">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {successMsg && (
            <div className="flex items-center gap-2 rounded-xl bg-success/15 border border-success/30 p-3 text-xs text-success-light">
              <Check className="h-4 w-4 shrink-0" />
              <span>{successMsg}</span>
            </div>
          )}

          {/* Quick Presets */}
          <div className="rounded-xl border border-line bg-card-2/40 p-3.5">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-ink">
              <Sparkles className="h-3.5 w-3.5 text-amber-400" />
              <span>Quick Presets</span>
              <span className="text-[11px] text-muted font-normal">(Click to autofill new service form)</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() =>
                  applyPreset('Funeral Service', 'FS', 'AM', 'Saturday church funeral service transport')
                }
                className="btn-ghost border-line text-xs py-1 px-2.5 hover:border-crimson-500/40 hover:bg-crimson-500/10 text-ink"
              >
                Funeral Service <span className="font-mono text-[10px] text-crimson-400 font-bold ml-1">(FS)</span>
              </button>
              <button
                type="button"
                onClick={() =>
                  applyPreset('Dreamweek Morning', 'DWM', 'AM', 'Dreamweek morning sessions transport')
                }
                className="btn-ghost border-line text-xs py-1 px-2.5 hover:border-sky-500/40 hover:bg-sky-500/10 text-ink"
              >
                Dreamweek Morning <span className="font-mono text-[10px] text-sky-400 font-bold ml-1">(DWM)</span>
              </button>
              <button
                type="button"
                onClick={() =>
                  applyPreset('Dreamweek Evening', 'DWE', 'PM', 'Dreamweek evening services transport')
                }
                className="btn-ghost border-line text-xs py-1 px-2.5 hover:border-purple-500/40 hover:bg-purple-500/10 text-ink"
              >
                Dreamweek Evening <span className="font-mono text-[10px] text-purple-400 font-bold ml-1">(DWE)</span>
              </button>
              <button
                type="button"
                onClick={() =>
                  applyPreset('Leaders Meeting', 'LM', 'AM', 'Church leadership gathering transport')
                }
                className="btn-ghost border-line text-xs py-1 px-2.5 hover:border-emerald-500/40 hover:bg-emerald-500/10 text-ink"
              >
                Leaders Meeting <span className="font-mono text-[10px] text-emerald-400 font-bold ml-1">(LM)</span>
              </button>
            </div>
          </div>

          {/* Add New Service Form */}
          <form onSubmit={handleAdd} className="rounded-xl border border-line bg-card p-4 space-y-4">
            <div className="flex items-center justify-between border-b border-line pb-2.5">
              <span className="text-xs font-bold uppercase tracking-wider text-ink">Add New Service Type</span>
              <span className="text-[11px] text-muted">All services operate with full dispatch & allocation</span>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-semibold text-muted">
                  Service Name <span className="text-crimson-400">*</span>
                </label>
                <input
                  type="text"
                  placeholder="e.g. Funeral Service, Dreamweek Morning"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (!acronym) {
                      setAcronym(e.target.value.replace(/[^a-zA-Z0-9]/g, '').slice(0, 3).toUpperCase());
                    }
                  }}
                  className="input-field w-full text-xs py-2"
                  required
                />
              </div>

              <div>
                <label className="mb-1 flex items-center justify-between text-xs font-semibold text-muted">
                  <span>Cancellation Acronym <span className="text-crimson-400">*</span></span>
                  <span className="text-[10px] text-ink-muted">Appears on debt list</span>
                </label>
                <div className="relative">
                  <Tag className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
                  <input
                    type="text"
                    placeholder="e.g. FS, DWM, DW"
                    maxLength={8}
                    value={acronym}
                    onChange={(e) => setAcronym(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                    className="input-field w-full pl-9 text-xs py-2 font-mono font-bold tracking-wider"
                    required
                  />
                </div>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-semibold text-muted">
                  Time Period / Session Window
                </label>
                <select
                  value={period}
                  onChange={(e) => setPeriod(e.target.value as 'AM' | 'PM' | 'OTHER')}
                  className="input-field w-full text-xs py-2"
                >
                  <option value="AM" className="bg-card-2">Morning (AM)</option>
                  <option value="PM" className="bg-card-2">Afternoon / Evening (PM)</option>
                  <option value="OTHER" className="bg-card-2">Special / All Day</option>
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-muted">
                  Description / Notes (Optional)
                </label>
                <input
                  type="text"
                  placeholder="e.g. Saturday church funeral transport"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="input-field w-full text-xs py-2"
                />
              </div>
            </div>

            {/* Live Notation Preview */}
            <div className="flex items-center justify-between rounded-lg bg-card-2/70 px-3 py-2 text-xs border border-line/60">
              <span className="text-muted">Cancellation Notation Preview:</span>
              <span className="font-mono font-bold text-crimson-400">
                12/09/26({cleanAcronym || 'CODE'})
              </span>
            </div>

            <div className="flex justify-end pt-1">
              <button
                type="submit"
                disabled={saving || !name.trim()}
                className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5"
              >
                <Plus className="h-4 w-4" />
                <span>{saving ? 'Adding Service...' : 'Create Service Type'}</span>
              </button>
            </div>
          </form>

          {/* Active Service Types List */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase tracking-wider text-muted">
                Active Service Types ({serviceTypes.length})
              </h3>
              {loading && <span className="text-[11px] text-muted">Updating...</span>}
            </div>

            <div className="overflow-hidden rounded-xl border border-line divide-y divide-line/60">
              {serviceTypes.map((s) => (
                <div
                  key={s.value}
                  className="flex items-center justify-between px-4 py-3 bg-card hover:bg-card-2/40 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <span className="badge font-mono font-bold text-[11px] px-2 py-0.5 bg-crimson-500/15 text-crimson-300 border border-crimson-500/30">
                      {s.acronym}
                    </span>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-ink">{s.label}</span>
                        {s.isSystem ? (
                          <span className="badge bg-card-2 text-[10px] text-muted border border-line/70">
                            Default
                          </span>
                        ) : (
                          <span className="badge bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-[10px]">
                            Custom
                          </span>
                        )}
                        <span className="text-[10px] text-muted">
                          {s.period === 'AM' ? 'Morning (AM)' : s.period === 'PM' ? 'Evening (PM)' : 'Special'}
                        </span>
                      </div>
                      {s.description && (
                        <p className="text-[11px] text-muted mt-0.5">{s.description}</p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {onSelectService && (
                      <button
                        type="button"
                        onClick={() => {
                          onSelectService(s.value);
                          onClose();
                        }}
                        className="btn-ghost border-line text-[11px] py-1 px-2 text-ink hover:bg-card-2"
                      >
                        Select
                      </button>
                    )}

                    {!s.isSystem && (
                      <button
                        type="button"
                        disabled={deletingVal === s.value}
                        onClick={() => handleDelete(s)}
                        className="rounded p-1.5 text-muted hover:text-crimson-400 hover:bg-crimson-500/10 transition-colors"
                        title={`Delete ${s.label}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-line px-5 py-3 bg-card-2/50 text-xs text-muted">
          <div className="flex items-center gap-1.5">
            <Calendar className="h-3.5 w-3.5 text-muted" />
            <span>Select any service type on the dispatch control or rep page.</span>
          </div>
          <button
            onClick={onClose}
            className="btn-ghost border-line text-xs py-1.5 px-3"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
