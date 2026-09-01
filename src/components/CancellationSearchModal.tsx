import React, { useState, useMemo } from 'react';
import {
  Search, X, Banknote, Plus, CheckCircle2,
  Calendar, MapPin, Car, Filter, Check, ChevronDown, ChevronUp,
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

interface DebtorGroup {
  normalizedName: string;
  displayName: string;
  structure: string;
  isVehicleRider: boolean;
  entries: LedgerEntry[];
  totalAmount: number;
  settledCount: number;
  settledAmount: number;
  allSettled: boolean;
  partialSettled: boolean;
}

interface CancellationSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  pastCancellations: LedgerEntry[];
  loading: boolean;
  collectedCancellationIds: Set<string>;
  onToggleCancellation: (id: string) => void;
  manualCancellations?: ManualCancellation[];
  onAddManualCancellation?: (initialName?: string) => void;
  onUpdateManualCancellation?: (id: string, patch: Partial<ManualCancellation>) => void;
  onRemoveManualCancellation?: (id: string) => void;
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
  manualCancellations = [],
  onAddManualCancellation,
  vehicleRiders = [],
  fare = CANCELLATION_FEE,
}: CancellationSearchModalProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [structureFilter, setStructureFilter] = useState('ALL');
  const [activeTab, setActiveTab] = useState<'all' | 'vehicle' | 'selected'>('all');
  const [expandedDebtors, setExpandedDebtors] = useState<Record<string, boolean>>({});

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

  // Selected ledger entries
  const selectedEntries = useMemo(() => {
    return pastCancellations.filter((e) => collectedCancellationIds.has(e.id));
  }, [pastCancellations, collectedCancellationIds]);

  const selectedLedgerCash = useMemo(() => {
    return selectedEntries.reduce((sum, e) => sum + (Number(e.structure_debt) || fare), 0);
  }, [selectedEntries, fare]);

  const manualCash = useMemo(() => {
    return manualCancellations.reduce((sum, c) => sum + (Number(c.amount) || 0), 0);
  }, [manualCancellations]);

  const totalSettledCash = selectedLedgerCash + manualCash;
  const totalSettledCount = selectedEntries.length + manualCancellations.length;

  // Group past cancellations by Debtor Person Name
  const debtorGroups = useMemo<DebtorGroup[]>(() => {
    const map = new Map<string, LedgerEntry[]>();

    pastCancellations.forEach((entry) => {
      const key = (entry.passenger_name || 'Unknown').trim().toLowerCase();
      if (!map.has(key)) {
        map.set(key, []);
      }
      map.get(key)!.push(entry);
    });

    const groups: DebtorGroup[] = [];
    map.forEach((entries, normalizedName) => {
      const displayName = entries[0]?.passenger_name?.trim() || 'Unknown';
      const structure = entries.find((e) => e.structure && e.structure.trim())?.structure?.trim() || '';
      const isVehicleRider = vehicleRiderNamesSet.has(normalizedName);
      const totalAmount = entries.reduce((sum, e) => sum + (Number(e.structure_debt) || fare), 0);
      const settledEntries = entries.filter((e) => collectedCancellationIds.has(e.id));
      const settledCount = settledEntries.length;
      const settledAmount = settledEntries.reduce((sum, e) => sum + (Number(e.structure_debt) || fare), 0);
      const allSettled = settledCount === entries.length && entries.length > 0;
      const partialSettled = settledCount > 0 && !allSettled;

      // Sort entries by date descending
      const sortedEntries = [...entries].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

      groups.push({
        normalizedName,
        displayName,
        structure,
        isVehicleRider,
        entries: sortedEntries,
        totalAmount,
        settledCount,
        settledAmount,
        allSettled,
        partialSettled,
      });
    });

    return groups;
  }, [pastCancellations, vehicleRiderNamesSet, collectedCancellationIds, fare]);

  // Filtered debtor groups based on tab, query, structure
  const filteredDebtorGroups = useMemo(() => {
    const q = searchQuery.trim();

    let list = debtorGroups;
    if (activeTab === 'vehicle') {
      list = list.filter((g) => g.isVehicleRider);
    } else if (activeTab === 'selected') {
      list = list.filter((g) => g.settledCount > 0);
    }

    const filtered = list.filter((g) => {
      // Structure filter
      if (structureFilter !== 'ALL') {
        const structUpper = g.structure.toUpperCase();
        if (structUpper !== structureFilter) return false;
      }

      if (!q) return true;

      // Check if group name matches or any entry note/date matches
      const groupMatch = evaluateLedgerSearch(
        {
          passenger_name: g.displayName,
          structure: g.structure,
        },
        q
      ).matched;

      if (groupMatch) return true;

      return g.entries.some((e) =>
        evaluateLedgerSearch(
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
        ).matched
      );
    });

    if (!q) {
      // Sort vehicle riders to top, then alphabetical
      return [...filtered].sort((a, b) => {
        if (a.isVehicleRider && !b.isVehicleRider) return -1;
        if (!a.isVehicleRider && b.isVehicleRider) return 1;
        return a.displayName.localeCompare(b.displayName);
      });
    }

    return [...filtered].sort((a, b) => {
      const scoreA = evaluateLedgerSearch({ passenger_name: a.displayName, structure: a.structure }, q).score;
      const scoreB = evaluateLedgerSearch({ passenger_name: b.displayName, structure: b.structure }, q).score;
      return scoreB - scoreA;
    });
  }, [debtorGroups, activeTab, structureFilter, searchQuery]);

  function toggleExpandDebtor(normalizedName: string) {
    setExpandedDebtors((prev) => ({
      ...prev,
      [normalizedName]: !prev[normalizedName],
    }));
  }

  function handleToggleAllForDebtor(group: DebtorGroup) {
    if (group.allSettled) {
      // Unsettle all
      group.entries.forEach((e) => {
        if (collectedCancellationIds.has(e.id)) {
          onToggleCancellation(e.id);
        }
      });
    } else {
      // Settle all remaining
      group.entries.forEach((e) => {
        if (!collectedCancellationIds.has(e.id)) {
          onToggleCancellation(e.id);
        }
      });
    }
  }

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3 sm:p-4 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-2xl flex-col rounded-2xl border border-line bg-card shadow-2xl animate-slide-up overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5 bg-card-2/60">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-crimson-500/15 border border-crimson-500/30 text-crimson-400 shrink-0">
              <Banknote className="h-5 w-5" />
            </div>
            <div>
              <h2 className="font-display text-base font-bold text-ink">Find & Settle Cancellation Debt</h2>
              <p className="text-xs text-muted">
                Search passengers with unpaid debt and tick which missed trips they are paying for today
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
        <div className="border-b border-line p-3.5 space-y-2.5 bg-card/95">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input
              type="text"
              autoFocus
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search passenger name, surname, or structure (e.g. Sipho, Mnisi, S1)..."
              className="input-field w-full pl-10 pr-10 text-sm font-medium py-2"
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

          {/* Filter tabs & Structure dropdown */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1 rounded-lg bg-card-2 p-1 border border-line text-xs font-semibold">
              <button
                type="button"
                onClick={() => setActiveTab('all')}
                className={`rounded px-2.5 py-1 transition-all ${
                  activeTab === 'all' ? 'bg-card text-ink shadow-xs font-bold' : 'text-muted hover:text-ink'
                }`}
              >
                All Debtors ({debtorGroups.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('vehicle')}
                className={`rounded px-2.5 py-1 transition-all ${
                  activeTab === 'vehicle'
                    ? 'bg-crimson-500/20 text-crimson-300 shadow-xs font-bold border border-crimson-500/40'
                    : debtorGroups.some((g) => g.isVehicleRider)
                    ? 'text-warning font-bold'
                    : 'text-muted hover:text-ink'
                }`}
              >
                Vehicle Riders ({debtorGroups.filter((g) => g.isVehicleRider).length})
              </button>
              {totalSettledCount > 0 && (
                <button
                  type="button"
                  onClick={() => setActiveTab('selected')}
                  className={`rounded px-2.5 py-1 transition-all ${
                    activeTab === 'selected'
                      ? 'bg-emerald-500/20 text-emerald-300 shadow-xs font-bold border border-emerald-500/40'
                      : 'text-emerald-400 font-bold'
                  }`}
                >
                  Selected ({totalSettledCount})
                </button>
              )}
            </div>

            {/* Structure Filter Dropdown */}
            {availableStructures.length > 0 && (
              <div className="flex items-center gap-1.5 text-xs">
                <Filter className="h-3 w-3 text-muted" />
                <select
                  value={structureFilter}
                  onChange={(e) => setStructureFilter(e.target.value)}
                  className="rounded-lg border border-line bg-card-2 px-2 py-1 text-xs font-semibold text-ink focus:outline-none focus:ring-1 focus:ring-crimson-500"
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

        {/* Debtor Groups Results List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-[240px]">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-12 text-center text-muted">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-crimson-500 border-t-transparent mb-2" />
              <p className="text-xs">Loading cancellation debt records...</p>
            </div>
          ) : filteredDebtorGroups.length > 0 ? (
            filteredDebtorGroups.map((group) => {
              const isExpanded = expandedDebtors[group.normalizedName] ?? (group.entries.length === 1 || !!searchQuery.trim());

              return (
                <div
                  key={group.normalizedName}
                  className={`rounded-xl border transition-all overflow-hidden ${
                    group.allSettled
                      ? 'border-emerald-500/60 bg-emerald-950/20 shadow-xs'
                      : group.partialSettled
                      ? 'border-amber-500/50 bg-amber-950/15 shadow-xs'
                      : 'border-line bg-card-2/40 hover:border-crimson-500/40 hover:bg-card-2/70'
                  }`}
                >
                  {/* Debtor Summary Bar */}
                  <div
                    onClick={() => toggleExpandDebtor(group.normalizedName)}
                    className="p-3 sm:p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 cursor-pointer select-none"
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-sm font-bold ${group.allSettled ? 'text-emerald-200' : 'text-ink'}`}>
                          <HighlightMatch text={group.displayName} query={searchQuery} />
                        </span>
                        {group.structure && (
                          <span className="rounded bg-bg/80 px-1.5 py-0.5 font-mono text-[10px] font-bold text-muted border border-line/60">
                            {group.structure}
                          </span>
                        )}
                        {group.isVehicleRider && (
                          <span className="rounded bg-crimson-500/20 px-1.5 py-0.5 text-[10px] font-bold text-crimson-300 border border-crimson-500/30">
                            Rider on this bus
                          </span>
                        )}
                        {group.allSettled ? (
                          <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300 border border-emerald-500/40 flex items-center gap-1">
                            <Check className="h-3 w-3" /> Fully Settled (+R{group.totalAmount})
                          </span>
                        ) : group.partialSettled ? (
                          <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-300 border border-amber-500/40 flex items-center gap-1">
                            <Check className="h-3 w-3" /> Partial: {group.settledCount}/{group.entries.length} Settled (+R{group.settledAmount})
                          </span>
                        ) : null}
                      </div>

                      <div className="flex items-center gap-2 text-xs text-muted">
                        <span>
                          {group.entries.length} unpaid trip{group.entries.length === 1 ? '' : 's'}
                        </span>
                        <span>•</span>
                        <span className="font-semibold text-ink">
                          Total Debt: R{group.totalAmount}
                        </span>
                        <span className="text-[11px] text-muted font-normal">
                          ({group.entries.map((e) => shortDate(e.date)).join(', ')})
                        </span>
                      </div>
                    </div>

                    {/* Action buttons on the header */}
                    <div className="flex items-center justify-between sm:justify-end gap-2 shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-line/50">
                      {/* Settle All Button */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleToggleAllForDebtor(group);
                        }}
                        className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-all shadow-xs flex items-center gap-1.5 ${
                          group.allSettled
                            ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                            : group.partialSettled
                            ? 'bg-amber-600 text-white hover:bg-amber-500'
                            : 'bg-crimson-600 text-white hover:bg-crimson-500'
                        }`}
                      >
                        {group.allSettled ? (
                          <>
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            <span>Paid All R{group.totalAmount}</span>
                          </>
                        ) : (
                          <>
                            <Plus className="h-3.5 w-3.5" />
                            <span>{group.entries.length > 1 ? `Settle All (R${group.totalAmount})` : `Settle R${group.totalAmount}`}</span>
                          </>
                        )}
                      </button>

                      {/* Expand / Collapse icon */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleExpandDebtor(group.normalizedName);
                        }}
                        className="rounded-lg p-1 text-muted hover:text-ink hover:bg-card transition-colors"
                        title={isExpanded ? 'Hide trip breakdown' : 'Show trip breakdown'}
                      >
                        {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>

                  {/* Expanded Breakdown of Individual Trip Dates */}
                  {isExpanded && (
                    <div className="border-t border-line/60 bg-card/60 p-2.5 space-y-1.5">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-muted px-1">
                        Select specific dates paid by passenger:
                      </div>
                      {group.entries.map((entry) => {
                        const isEntrySelected = collectedCancellationIds.has(entry.id);
                        const debtAmount = Number(entry.structure_debt) || fare;

                        return (
                          <div
                            key={entry.id}
                            onClick={() => onToggleCancellation(entry.id)}
                            className={`flex items-center justify-between gap-2.5 rounded-lg p-2 transition-all cursor-pointer border select-none ${
                              isEntrySelected
                                ? 'border-emerald-500/50 bg-emerald-950/30'
                                : 'border-line/70 bg-card hover:border-crimson-500/40 hover:bg-card-2'
                            }`}
                          >
                            <div className="min-w-0 flex-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
                              <span className="font-mono font-bold text-ink flex items-center gap-1">
                                <Calendar className="h-3 w-3 text-crimson-400" />
                                {entry.date ? shortDate(entry.date) : 'Undated'}
                              </span>
                              <span className="rounded bg-bg/80 px-1.5 py-0.5 font-mono text-[10px] font-bold text-muted border border-line/60">
                                {entry.service || 'PM'}
                              </span>
                              {entry.vehicle_name && (
                                <span className="text-muted text-[11px] flex items-center gap-1">
                                  <Car className="h-3 w-3 text-muted/80" />
                                  {entry.vehicle_name}
                                </span>
                              )}
                              {entry.stop && (
                                <span className="text-muted text-[11px] flex items-center gap-1">
                                  <MapPin className="h-3 w-3 text-muted/80" />
                                  {entry.stop}
                                </span>
                              )}
                              {entry.general_notes && (
                                <span className="text-muted italic text-[10px] bg-bg/40 px-1.5 py-0.5 rounded border border-line/40 truncate max-w-xs">
                                  {entry.general_notes}
                                </span>
                              )}
                            </div>

                            <div className="flex items-center gap-2 shrink-0">
                              <span className="font-mono text-xs font-bold text-crimson-400">
                                R{debtAmount}
                              </span>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onToggleCancellation(entry.id);
                                }}
                                className={`rounded px-2 py-0.5 text-xs font-bold transition-all flex items-center gap-1 shadow-xs ${
                                  isEntrySelected
                                    ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                                    : 'bg-card-2 text-ink border border-line hover:border-crimson-500/50 hover:bg-crimson-500/10'
                                }`}
                              >
                                {isEntrySelected ? (
                                  <>
                                    <Check className="h-3 w-3" />
                                    <span>Settled</span>
                                  </>
                                ) : (
                                  <>
                                    <Plus className="h-3 w-3" />
                                    <span>Settle</span>
                                  </>
                                )}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            <div className="rounded-xl border border-line bg-card-2/40 p-8 text-center">
              <Banknote className="mx-auto h-8 w-8 text-muted mb-2 opacity-50" />
              <p className="text-sm font-semibold text-ink">
                {searchQuery
                  ? `No cancellation debt record matching "${searchQuery}"`
                  : 'No cancellation records in this filter'}
              </p>
              <p className="mt-1 text-xs text-muted">
                {searchQuery
                  ? 'They may not be in the ledger yet. If they want to pay off-ledger cash, you can record it below.'
                  : 'Try searching by passenger first name or surname.'}
              </p>

              {searchQuery.trim() && onAddManualCancellation && (
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
        </div>

        {/* Footer Summary & Done Button */}
        <div className="border-t border-line bg-card-2/90 px-5 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-bold uppercase tracking-wider text-muted">
                Settled Today:
              </span>
              <span className="font-mono text-sm font-bold text-ink">
                {totalSettledCount} trip{totalSettledCount === 1 ? '' : 's'}
              </span>
              <span className="text-muted">·</span>
              <span className="font-display text-sm font-bold text-crimson-400">
                +R{totalSettledCash} cash collected
              </span>
            </div>
            <p className="text-[11px] text-muted">
              These debts will be automatically cleared from the ledger upon attendance submission.
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="btn-crimson px-5 py-2 text-xs font-bold shadow-md self-end sm:self-auto"
          >
            Done ({totalSettledCount} Selected)
          </button>
        </div>
      </div>
    </div>
  );
}
