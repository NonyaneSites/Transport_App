import React, { useState, useMemo } from 'react';
import {
  Search, X, Banknote, Plus, CheckCircle2,
  Calendar, MapPin, User, Car, Filter, Trash2, Check,
} from 'lucide-react';
import { type LedgerEntry, evaluateLedgerSearch } from '@/lib/ledger';
import type { ManualCancellation } from '@/pages/RepPage';
import type { Passenger } from '@/lib/types';
import { shortDate } from '@/lib/dates';
import { CANCELLATION_FEE } from '@/lib/types';

function HighlightMatch({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q || !text) return <span>{text}</span>;

  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escaped})`, 'gi');
  const parts = text.split(regex);

  return (
    <span>
      {parts.map((part, i) =>
        part.toLowerCase() === q.toLowerCase() ? (
          <mark key={i} className="bg-crimson-500/30 text-crimson-200 font-bold px-0.5 rounded">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </span>
  );
}

interface CancellationSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  pastCancellations: LedgerEntry[];
  loading: boolean;
  collectedCancellationIds: Set<string>;
  onToggleCancellation: (id: string) => void;
  manualCancellations: ManualCancellation[];
  onAddManualCancellation: (initialName?: string) => void;
  onUpdateManualCancellation: (id: string, patch: Partial<ManualCancellation>) => void;
  onRemoveManualCancellation: (id: string) => void;
  vehicleRiders?: Passenger[];
  fare?: number;
}

export function CancellationSearchModal({
  isOpen,
  onClose,
  pastCancellations,
  loading,
  collectedCancellationIds,
  onToggleCancellation,
  manualCancellations,
  onAddManualCancellation,
  onUpdateManualCancellation,
  onRemoveManualCancellation,
  vehicleRiders = [],
  fare = CANCELLATION_FEE,
}: CancellationSearchModalProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [structureFilter, setStructureFilter] = useState('ALL');
  const [activeTab, setActiveTab] = useState<'all' | 'vehicle' | 'selected'>('all');

  // Unique structures present in the cancellations list
  const availableStructures = useMemo(() => {
    const set = new Set<string>();
    pastCancellations.forEach((e) => {
      if (e.structure && e.structure.trim()) {
        set.add(e.structure.trim().toUpperCase());
      }
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }, [pastCancellations]);

  // Names of current vehicle riders normalized
  const vehicleRiderNamesSet = useMemo(() => {
    return new Set(vehicleRiders.map((r) => r.fullName.trim().toLowerCase()));
  }, [vehicleRiders]);

  // Cancellations matching riders in this current vehicle
  const vehicleCancellations = useMemo(() => {
    return pastCancellations.filter((e) =>
      vehicleRiderNamesSet.has(e.passenger_name.trim().toLowerCase())
    );
  }, [pastCancellations, vehicleRiderNamesSet]);

  // Selected ledger entries
  const selectedEntries = useMemo(() => {
    return pastCancellations.filter((e) => collectedCancellationIds.has(e.id));
  }, [pastCancellations, collectedCancellationIds]);

  // Total cash collected from past cancellations
  const selectedLedgerCash = useMemo(() => {
    return selectedEntries.reduce((sum, e) => sum + (Number(e.structure_debt) || fare), 0);
  }, [selectedEntries, fare]);

  const manualCash = useMemo(() => {
    return manualCancellations.reduce((sum, c) => sum + (Number(c.amount) || 0), 0);
  }, [manualCancellations]);

  const totalSettledCash = selectedLedgerCash + manualCash;
  const totalSettledCount = selectedEntries.length + manualCancellations.length;

  // Filtered cancellations list based on tab, query, structure
  const filteredCancellations = useMemo(() => {
    const q = searchQuery.trim();

    let list = pastCancellations;
    if (activeTab === 'vehicle') {
      list = vehicleCancellations;
    } else if (activeTab === 'selected') {
      list = selectedEntries;
    }

    const filtered = list.filter((e) => {
      // Structure filter
      if (structureFilter !== 'ALL') {
        const entryStruct = (e.structure || '').trim().toUpperCase();
        if (entryStruct !== structureFilter) return false;
      }

      if (!q) return true;

      const { matched } = evaluateLedgerSearch(
        {
          passenger_name: e.passenger_name,
          structure: e.structure,
          general_notes: e.general_notes,
          sponsor_note: e.sponsor_note,
          date: e.date,
          service: e.service,
          rep_name: e.rep_name,
        },
        q
      );
      return matched;
    });

    if (!q) return filtered;

    return [...filtered].sort((a, b) => {
      const scoreA = evaluateLedgerSearch(
        {
          passenger_name: a.passenger_name,
          structure: a.structure,
          general_notes: a.general_notes,
          sponsor_note: a.sponsor_note,
          date: a.date,
          service: a.service,
          rep_name: a.rep_name,
        },
        q
      ).score;
      const scoreB = evaluateLedgerSearch(
        {
          passenger_name: b.passenger_name,
          structure: b.structure,
          general_notes: b.general_notes,
          sponsor_note: b.sponsor_note,
          date: b.date,
          service: b.service,
          rep_name: b.rep_name,
        },
        q
      ).score;
      return scoreB - scoreA;
    });
  }, [pastCancellations, vehicleCancellations, selectedEntries, activeTab, structureFilter, searchQuery]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 sm:p-4 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-2xl flex-col rounded-2xl border border-line bg-card shadow-2xl animate-slide-up overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5 bg-card-2/60">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-crimson-500/15 border border-crimson-500/30 text-crimson-400">
              <Banknote className="h-5 w-5" />
            </div>
            <div>
              <h2 className="font-display text-base font-bold text-ink">Find & Settle Cancellation Debt</h2>
              <p className="text-xs text-muted">
                Search the church cancellation ledger by passenger name to record their cash payment
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted hover:bg-card hover:text-ink transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Live Search & Filter Bar */}
        <div className="border-b border-line p-4 space-y-3 bg-card/90">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input
              type="text"
              autoFocus
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Type passenger name or surname (e.g. Sipho, Amo, Nhlabathi)..."
              className="input-field w-full pl-10 pr-10 text-sm font-medium py-2.5"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-1 text-muted hover:text-ink"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          {/* Tab buttons + Structure filter dropdown */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1 rounded-lg bg-card-2 p-1 border border-line text-xs font-semibold">
              <button
                type="button"
                onClick={() => setActiveTab('all')}
                className={`rounded px-3 py-1.5 transition-all ${
                  activeTab === 'all' ? 'bg-card text-ink shadow-xs font-bold' : 'text-muted hover:text-ink'
                }`}
              >
                All Ledger ({pastCancellations.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('vehicle')}
                className={`rounded px-3 py-1.5 transition-all ${
                  activeTab === 'vehicle'
                    ? 'bg-crimson-500/20 text-crimson-300 shadow-xs font-bold border border-crimson-500/40'
                    : vehicleCancellations.length > 0
                    ? 'text-warning font-bold'
                    : 'text-muted hover:text-ink'
                }`}
              >
                This Vehicle&apos;s Riders ({vehicleCancellations.length})
              </button>
              {totalSettledCount > 0 && (
                <button
                  type="button"
                  onClick={() => setActiveTab('selected')}
                  className={`rounded px-3 py-1.5 transition-all ${
                    activeTab === 'selected'
                      ? 'bg-emerald-500/20 text-emerald-300 shadow-xs font-bold border border-emerald-500/40'
                      : 'text-emerald-400 font-bold'
                  }`}
                >
                  Selected ({totalSettledCount})
                </button>
              )}
            </div>

            {/* Structure Filter */}
            {availableStructures.length > 0 && (
              <div className="flex items-center gap-1.5 text-xs">
                <Filter className="h-3.5 w-3.5 text-muted" />
                <select
                  value={structureFilter}
                  onChange={(e) => setStructureFilter(e.target.value)}
                  className="rounded-lg border border-line bg-card-2 px-2.5 py-1.5 text-xs font-semibold text-ink focus:outline-none focus:ring-1 focus:ring-crimson-500"
                >
                  <option value="ALL">All Structures</option>
                  {availableStructures.map((s) => (
                    <option key={s} value={s}>
                      Structure {s}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </div>

        {/* Results List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2.5 min-h-[220px]">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-12 text-center text-muted">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-crimson-500 border-t-transparent mb-2" />
              <p className="text-xs">Searching cancellation ledger...</p>
            </div>
          ) : filteredCancellations.length > 0 ? (
            filteredCancellations.map((entry) => {
              const isSelected = collectedCancellationIds.has(entry.id);
              const debtAmount = Number(entry.structure_debt) || fare;
              const isVehicleRider = vehicleRiderNamesSet.has(entry.passenger_name.trim().toLowerCase());

              return (
                <div
                  key={entry.id}
                  onClick={() => onToggleCancellation(entry.id)}
                  className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border p-3.5 transition-all cursor-pointer select-none ${
                    isSelected
                      ? 'border-emerald-500/60 bg-emerald-950/25 shadow-sm'
                      : 'border-line bg-card-2/40 hover:border-crimson-500/40 hover:bg-card-2/80'
                  }`}
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-sm font-bold ${isSelected ? 'text-emerald-200' : 'text-ink'}`}>
                        <HighlightMatch text={entry.passenger_name} query={searchQuery} />
                      </span>
                      {entry.structure && (
                        <span className="rounded bg-bg/70 px-1.5 py-0.5 font-mono text-[10px] font-bold text-muted border border-line/60">
                          {entry.structure}
                        </span>
                      )}
                      {isVehicleRider && (
                        <span className="rounded bg-crimson-500/20 px-1.5 py-0.5 text-[10px] font-bold text-crimson-300 border border-crimson-500/30">
                          Rider in this vehicle
                        </span>
                      )}
                      {isSelected && (
                        <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300 border border-emerald-500/40 flex items-center gap-1">
                          <Check className="h-3 w-3" /> Paying on this trip
                        </span>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                      <span className="flex items-center gap-1 text-ink/80">
                        <Calendar className="h-3.5 w-3.5 text-crimson-400" />
                        <strong>{entry.date ? shortDate(entry.date) : 'Unrecorded Date'}</strong>
                        {entry.service && <span className="text-muted">({entry.service})</span>}
                      </span>
                      {entry.vehicle_name && (
                        <span className="flex items-center gap-1">
                          <Car className="h-3.5 w-3.5 text-muted" />
                          <span>{entry.vehicle_name}</span>
                        </span>
                      )}
                      {entry.stop && (
                        <span className="flex items-center gap-1">
                          <MapPin className="h-3.5 w-3.5 text-muted" />
                          <span>{entry.stop}</span>
                        </span>
                      )}
                      {entry.rep_name && (
                        <span className="flex items-center gap-1">
                          <User className="h-3.5 w-3.5 text-muted" />
                          <span>Rep: {entry.rep_name}</span>
                        </span>
                      )}
                    </div>

                    {entry.general_notes && (
                      <p className="text-[11px] text-muted italic bg-bg/40 px-2 py-0.5 rounded border border-line/40 inline-block">
                        Note: {entry.general_notes}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center justify-between sm:justify-end gap-3 shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-line/50">
                    <div className="text-right">
                      <span className="font-mono text-base font-bold text-crimson-400">
                        R{debtAmount}
                      </span>
                      <span className="block text-[10px] text-muted">Cancellation Fee</span>
                    </div>

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleCancellation(entry.id);
                      }}
                      className={`rounded-lg px-3 py-2 text-xs font-bold transition-all shadow-xs flex items-center gap-1.5 ${
                        isSelected
                          ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                          : 'bg-crimson-600 text-white hover:bg-crimson-500'
                      }`}
                    >
                      {isSelected ? (
                        <>
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          <span>Selected</span>
                        </>
                      ) : (
                        <>
                          <Plus className="h-3.5 w-3.5" />
                          <span>Settle R{debtAmount}</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="rounded-xl border border-line bg-card-2/40 p-8 text-center">
              <Banknote className="mx-auto h-8 w-8 text-muted mb-2 opacity-50" />
              <p className="text-sm font-semibold text-ink">
                {searchQuery
                  ? `No cancellation record found matching "${searchQuery}"`
                  : 'No cancellation records in this category'}
              </p>
              <p className="mt-1 text-xs text-muted">
                {searchQuery
                  ? 'They may not be logged in the system yet. You can add a manual cancellation payment below.'
                  : 'Try searching by passenger first name or surname.'}
              </p>

              {searchQuery.trim() && (
                <button
                  type="button"
                  onClick={() => {
                    onAddManualCancellation(searchQuery.trim());
                    setSearchQuery('');
                  }}
                  className="mt-4 inline-flex items-center gap-2 rounded-lg bg-crimson-600 px-4 py-2 text-xs font-bold text-white shadow-sm hover:bg-crimson-500 transition-colors"
                >
                  <Plus className="h-4 w-4" />
                  <span>Record &ldquo;{searchQuery.trim()}&rdquo; as R{fare} Cancellation Payment</span>
                </button>
              )}
            </div>
          )}

          {/* Manual Extra Cancellations Section */}
          <div className="mt-4 border-t border-line pt-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-muted">
                Manual / Off-List Cancellation Payments
              </span>
              <button
                type="button"
                onClick={() => onAddManualCancellation()}
                className="flex items-center gap-1 text-xs font-bold text-crimson-400 hover:text-crimson-300"
              >
                <Plus className="h-3.5 w-3.5" />
                + Add Custom Payment
              </button>
            </div>

            {manualCancellations.length > 0 && (
              <div className="space-y-2">
                {manualCancellations.map((c) => (
                  <div
                    key={c.id}
                    className="flex flex-col gap-1.5 rounded-lg border border-crimson-500/30 bg-crimson-500/5 p-2.5 sm:flex-row sm:items-center"
                  >
                    <input
                      type="text"
                      value={c.passengerName}
                      onChange={(e) => onUpdateManualCancellation(c.id, { passengerName: e.target.value })}
                      placeholder="Passenger Name (e.g. Sipho Dlamini)"
                      className="input-field py-1.5 text-xs sm:flex-1 font-semibold"
                    />
                    <input
                      type="text"
                      value={c.structure ?? ''}
                      onChange={(e) => onUpdateManualCancellation(c.id, { structure: e.target.value })}
                      placeholder="Structure (e.g. S1)"
                      className="input-field py-1.5 text-xs sm:w-28 font-mono uppercase"
                    />
                    <div className="flex items-center gap-1 text-xs text-muted">
                      <span className="font-bold">R</span>
                      <input
                        type="number"
                        min="0"
                        step="10"
                        value={c.amount}
                        onChange={(e) =>
                          onUpdateManualCancellation(c.id, {
                            amount: Math.max(0, parseInt(e.target.value, 10) || 0),
                          })
                        }
                        className="input-field w-16 py-1 text-center text-xs font-mono font-bold"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => onRemoveManualCancellation(c.id)}
                      className="rounded-md p-1.5 text-muted hover:bg-crimson-900/30 hover:text-crimson-300"
                      title="Remove"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer Summary & Done Button */}
        <div className="border-t border-line bg-card-2/80 px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-muted">
                Selected for Settlement:
              </span>
              <span className="font-mono text-sm font-bold text-ink">
                {totalSettledCount} cancellation{totalSettledCount === 1 ? '' : 's'}
              </span>
              <span className="text-muted">·</span>
              <span className="font-display text-sm font-bold text-crimson-400">
                +R{totalSettledCash} cash
              </span>
            </div>
            <p className="text-[11px] text-muted">
              These will be deducted and cleared from the cancellation ledger when attendance is submitted.
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="btn-crimson px-5 py-2 text-xs font-bold shadow-md"
          >
            Done ({totalSettledCount} Settled)
          </button>
        </div>
      </div>
    </div>
  );
}
