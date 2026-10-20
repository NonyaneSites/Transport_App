import React, { useState, useMemo, useEffect } from 'react';
import {
  X, UserPlus, Search, Users, MapPin, Check, Plus, AlertCircle, Phone
} from 'lucide-react';
import type { Passenger, Vehicle, ServiceType } from '@/lib/types';
import { isDreamWeekDate, DREAMWEEK_FARE } from '@/lib/types';
import { naturalCompare } from '@/lib/sort';

const CANONICAL_REHEARSAL_STOPS = ['Braam', 'DFC', 'Auckland Park / SABC', 'Soweto', 'West'];
const CANONICAL_SUNDAY_STOPS = ['Braam', 'DFC', 'Auckland Park', 'Soweto', 'West'];

interface Props {
  isOpen: boolean;
  onClose: () => void;
  initialVehicleId?: string | null;
  vehicles: Vehicle[];
  signups: Passenger[];
  service: ServiceType;
  date?: string;
  onAssignExisting: (passengerId: string, targetVehicleId: string) => void;
  onAddNewPassenger: (
    passenger: {
      fullName: string;
      stop: string;
      structure?: string;
      phone?: string;
      category?: 'Normal' | 'Ushers' | 'Choir' | 'Band';
      memberType?: 'FTV' | 'V' | 'M';
      legs?: 'both' | 'going' | 'return';
    },
    targetVehicleId?: string
  ) => void;
}

export function AddPersonToVehicleModal({
  isOpen,
  onClose,
  initialVehicleId,
  vehicles,
  signups,
  service,
  date,
  onAssignExisting,
  onAddNewPassenger,
}: Props) {
  const isRehearsal = service === 'Rehearsal';
  const isDW = date ? isDreamWeekDate(date) : false;

  const [activeTab, setActiveTab] = useState<'existing' | 'new'>('existing');
  const [targetVehicleId, setTargetVehicleId] = useState<string>(() => {
    return initialVehicleId || vehicles[0]?.id || '';
  });

  // Keep target vehicle in sync when initialVehicleId or vehicles change upon opening
  useEffect(() => {
    if (initialVehicleId) {
      setTargetVehicleId(initialVehicleId);
    } else if (vehicles.length > 0 && !targetVehicleId) {
      setTargetVehicleId(vehicles[0].id);
    }
  }, [initialVehicleId, vehicles, targetVehicleId]);

  // Tab 1 search & filter
  const [searchQuery, setSearchQuery] = useState('');
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  const [recentAssignedId, setRecentAssignedId] = useState<string | null>(null);

  // Tab 2 new passenger form
  const [newName, setNewName] = useState('');
  const [newStop, setNewStop] = useState('');
  const [newStructure, setNewStructure] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newCategory, setNewCategory] = useState<'Normal' | 'Ushers' | 'Choir' | 'Band'>('Normal');
  const [newMemberType, setNewMemberType] = useState<'' | 'FTV' | 'V' | 'M'>('');
  const [newLegs, setNewLegs] = useState<'both' | 'going' | 'return'>('both');
  const [formError, setFormError] = useState<string | null>(null);

  // Gather list of existing stops from signups + canonical stops
  const knownStops = useMemo(() => {
    const set = new Set<string>();
    const canonical = isRehearsal ? CANONICAL_REHEARSAL_STOPS : CANONICAL_SUNDAY_STOPS;
    canonical.forEach((s) => set.add(s));
    signups.forEach((p) => {
      if (p.stop && p.stop.trim()) set.add(p.stop.trim());
    });
    return Array.from(set).sort(naturalCompare);
  }, [signups, isRehearsal]);

  // Map of passenger ID -> vehicle
  const passengerVehicleMap = useMemo(() => {
    const map = new Map<string, Vehicle>();
    vehicles.forEach((v) => {
      v.riders.forEach((rId) => {
        map.set(String(rId), v);
      });
    });
    return map;
  }, [vehicles]);

  // Filtered signups for Tab 1
  const filteredSignups = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return signups.filter((p) => {
      const assignedVeh = passengerVehicleMap.get(String(p.id));
      if (unassignedOnly && assignedVeh) {
        return false;
      }
      if (!q) return true;
      const nameMatch = p.fullName.toLowerCase().includes(q);
      const stopMatch = (p.stop || '').toLowerCase().includes(q);
      const structMatch = (p.structure || '').toLowerCase().includes(q);
      const phoneMatch = (p.phone || '').includes(q);
      return nameMatch || stopMatch || structMatch || phoneMatch;
    });
  }, [signups, passengerVehicleMap, unassignedOnly, searchQuery]);

  const targetVehicle = vehicles.find((v) => v.id === targetVehicleId) || null;

  if (!isOpen) return null;

  function handleAssignExisting(p: Passenger) {
    onAssignExisting(String(p.id), targetVehicleId);
    setRecentAssignedId(String(p.id));
    setTimeout(() => {
      setRecentAssignedId((prev) => (prev === String(p.id) ? null : prev));
    }, 2000);
  }

  function handleCreateNew(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) {
      setFormError('Please enter passenger full name');
      return;
    }
    const stopToSave = newStop.trim();
    if (!stopToSave) {
      setFormError('Please select or enter a pickup stop');
      return;
    }

    // Warn before creating an entry already allocated anywhere in this manifest.
    // Matching names alone do not prove identity; the admin must choose the existing
    // record or explicitly confirm a genuinely different person.
    const normalized = (value: string) => value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
    const matches = signups.filter((p) => normalized(p.fullName) === normalized(newName));
    if (matches.length) {
      const detail = matches.map((p) => {
        const taxi = passengerVehicleMap.get(String(p.id));
        return `${p.fullName} (${p.structure || 'No structure'}) — ${taxi?.name || 'unassigned'}`;
      }).join('\n');
      const exactPhone = newPhone.trim() && matches.some((p) => p.phone?.replace(/\D/g, '') === newPhone.replace(/\D/g, ''));
      if (exactPhone) {
        setFormError('A passenger with this name and phone already exists. Use the Existing Passenger tab.');
        setActiveTab('existing');
        setSearchQuery(newName.trim());
        return;
      }
      if (!window.confirm(`Possible duplicate in this manifest:\n${detail}\n\nOnly continue if this is genuinely a different person. Cancel to assign the existing passenger.`)) {
        setActiveTab('existing');
        setSearchQuery(newName.trim());
        return;
      }
    }

    onAddNewPassenger(
      {
        fullName: newName.trim(),
        stop: stopToSave,
        structure: newStructure.trim() || undefined,
        phone: newPhone.trim() || undefined,
        category: newCategory,
        memberType: newMemberType || undefined,
        legs: isRehearsal ? newLegs : undefined,
      },
      targetVehicleId || undefined
    );

    // Reset and close
    setNewName('');
    setNewStop('');
    setNewPhone('');
    setNewStructure('');
    setFormError(null);
    onClose();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 animate-fade-in backdrop-blur-xs"
    >
      <div className="w-full max-w-xl max-h-[90vh] flex flex-col rounded-2xl border border-line bg-card shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line px-5 py-4 bg-card-2/60">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-crimson-500/15 border border-crimson-500/30 text-crimson-300">
              <UserPlus className="h-4 w-4" />
            </div>
            <div>
              <h2 className="font-display text-base font-bold text-ink">
                Add Someone to Vehicle
              </h2>
              <p className="text-xs text-muted">
                Assign an existing passenger or register a new walk-in
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

        {/* Target Vehicle Selector Bar */}
        <div className="border-b border-line/60 bg-bg/60 px-5 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 text-xs font-semibold text-muted">
            <span>Target Vehicle:</span>
            <select
              value={targetVehicleId}
              onChange={(e) => setTargetVehicleId(e.target.value)}
              className="input-field py-1 text-xs font-bold text-ink bg-card min-w-[200px]"
            >
              <option value="">Unassigned Pool (Waiting list)</option>
              {vehicles.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.type === 'Bus' ? '🚌' : '🚕'} {v.name} ({v.riders.length}/{v.capacity || (v.type === 'Taxi' ? 15 : 60)})
                </option>
              ))}
            </select>
          </div>
          {targetVehicle ? (
            <span className="text-xs text-muted">
              Capacity: <strong className="text-ink">{targetVehicle.riders.length}/{targetVehicle.capacity || (targetVehicle.type === 'Taxi' ? 15 : 60)}</strong>
            </span>
          ) : (
            <span className="text-xs text-amber-300 font-medium">
              Adds to Unassigned Pool
            </span>
          )}
        </div>

        {/* Tabs */}
        <div className="flex border-b border-line bg-card">
          <button
            type="button"
            onClick={() => setActiveTab('existing')}
            className={`flex-1 py-2.5 text-xs font-bold uppercase tracking-wider transition-all border-b-2 ${
              activeTab === 'existing'
                ? 'border-crimson-500 text-crimson-400 bg-crimson-500/5'
                : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            Choose Existing ({signups.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('new')}
            className={`flex-1 py-2.5 text-xs font-bold uppercase tracking-wider transition-all border-b-2 ${
              activeTab === 'new'
                ? 'border-crimson-500 text-crimson-400 bg-crimson-500/5'
                : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            + Create New Person
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {activeTab === 'existing' ? (
            <div className="space-y-3.5">
              {/* Search & Toggle */}
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search by name, stop, structure, phone..."
                    className="input-field pl-9 py-1.5 text-xs w-full"
                    autoFocus
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-ink"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer select-none whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={unassignedOnly}
                    onChange={(e) => setUnassignedOnly(e.target.checked)}
                    className="rounded border-line bg-card text-crimson-500 focus:ring-0"
                  />
                  <span>Unassigned Only</span>
                </label>
              </div>

              {/* Passenger List */}
              <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
                {filteredSignups.length === 0 ? (
                  <div className="rounded-xl border border-line bg-card-2/40 py-10 text-center text-xs text-muted">
                    <Users className="mx-auto h-7 w-7 text-line mb-2" />
                    <p className="font-semibold text-ink">No passengers found</p>
                    <p className="text-[11px] text-muted mt-0.5">
                      {searchQuery
                        ? 'Try adjusting your search query'
                        : unassignedOnly
                        ? 'All registered passengers are currently assigned to vehicles'
                        : 'No passengers registered yet. Use "+ Create New Person" to add someone.'}
                    </p>
                    <button
                      type="button"
                      onClick={() => setActiveTab('new')}
                      className="mt-3 btn-crimson text-xs py-1.5 px-3 inline-flex items-center gap-1.5"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span>Create New Person</span>
                    </button>
                  </div>
                ) : (
                  filteredSignups.map((p) => {
                    const assignedVeh = passengerVehicleMap.get(String(p.id));
                    const isAlreadyInTarget = Boolean(targetVehicleId && assignedVeh?.id === targetVehicleId);
                    const isRecentlyAssigned = recentAssignedId === String(p.id);

                    return (
                      <div
                        key={p.id}
                        className={`flex items-center justify-between gap-3 rounded-xl border p-3 transition-all ${
                          isAlreadyInTarget
                            ? 'border-emerald-500/30 bg-emerald-500/5'
                            : isRecentlyAssigned
                            ? 'border-crimson-500/50 bg-crimson-500/10'
                            : 'border-line/70 bg-card hover:border-line'
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-semibold text-xs text-ink">{p.fullName}</span>
                            {p.structure && (
                              <span className="badge bg-crimson-500/10 text-crimson-300 font-mono text-[10px]">
                                {p.structure}
                              </span>
                            )}
                            {p.legs && (
                              <span
                                className={`badge text-[10px] font-bold ${
                                  p.legs === 'both'
                                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                                    : p.legs === 'going'
                                    ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                                    : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                                }`}
                              >
                                {p.legs === 'both' ? '⇄ Both' : p.legs === 'going' ? '→ Going' : '← Return'}
                              </span>
                            )}
                          </div>
                          <div className="mt-1 flex items-center gap-2 text-[11px] text-muted flex-wrap">
                            <span className="flex items-center gap-0.5">
                              <MapPin className="h-3 w-3 text-crimson-400" />
                              {p.stop}
                            </span>
                            {p.phone && <span className="flex items-center gap-0.5"><Phone className="h-3 w-3 text-muted" />{p.phone}</span>}
                            <span>·</span>
                            {assignedVeh ? (
                              <span className="text-amber-300 font-medium">
                                In {assignedVeh.type === 'Bus' ? '🚌' : '🚕'} {assignedVeh.name}
                              </span>
                            ) : (
                              <span className="text-crimson-300 font-medium">⏳ Unassigned</span>
                            )}
                          </div>
                        </div>

                        <div className="shrink-0">
                          {isAlreadyInTarget ? (
                            <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-400 bg-emerald-500/15 border border-emerald-500/30 px-2.5 py-1 rounded-lg">
                              <Check className="h-3.5 w-3.5" />
                              On Board
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleAssignExisting(p)}
                              className="btn-crimson py-1 px-3 text-xs flex items-center gap-1 font-semibold"
                            >
                              <Plus className="h-3.5 w-3.5" />
                              <span>
                                {targetVehicle
                                  ? (assignedVeh ? `Move to ${targetVehicle.name}` : `Add to ${targetVehicle.name}`)
                                  : (assignedVeh ? 'Unassign' : 'Unassigned')}
                              </span>
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          ) : (
            <form onSubmit={handleCreateNew} className="space-y-4">
              {formError && (
                <div className="flex items-center gap-2 rounded-xl border border-crimson-500/30 bg-crimson-900/20 p-2.5 text-xs text-crimson-300">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{formError}</span>
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label className="block text-[11px] font-bold uppercase tracking-wider text-muted mb-1">
                    Full Name <span className="text-crimson-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => {
                      setNewName(e.target.value);
                      if (formError) setFormError(null);
                    }}
                    placeholder="e.g. Thato Ndwebi"
                    className="input-field w-full text-xs py-2"
                    required
                    autoFocus
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wider text-muted mb-1">
                    Pickup Stop <span className="text-crimson-400">*</span>
                  </label>
                  <input
                    type="text"
                    list="known-stops-list"
                    value={newStop}
                    onChange={(e) => {
                      setNewStop(e.target.value);
                      if (formError) setFormError(null);
                    }}
                    placeholder="Type or pick stop..."
                    className="input-field w-full text-xs py-2"
                    required
                  />
                  <datalist id="known-stops-list">
                    {knownStops.map((s) => (
                      <option key={s} value={s} />
                    ))}
                  </datalist>
                </div>

                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wider text-muted mb-1">
                    Structure / Zone (Optional)
                  </label>
                  <input
                    type="text"
                    value={newStructure}
                    onChange={(e) => setNewStructure(e.target.value)}
                    placeholder="e.g. S1, S2, S9..."
                    className="input-field w-full text-xs py-2"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wider text-muted mb-1">
                    Phone / WhatsApp (Optional)
                  </label>
                  <input
                    type="tel"
                    value={newPhone}
                    onChange={(e) => setNewPhone(e.target.value)}
                    placeholder="e.g. 071 234 5678"
                    className="input-field w-full text-xs py-2"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wider text-muted mb-1">
                    Attendee Status
                  </label>
                  <select
                    value={newMemberType}
                    onChange={(e) => setNewMemberType(e.target.value as '' | 'FTV' | 'V' | 'M')}
                    className="input-field w-full text-xs py-2 bg-card-2"
                  >
                    <option value="">Member / Default</option>
                    <option value="FTV">First Time Visitor (FTV)</option>
                    <option value="V">Visitor (V)</option>
                    <option value="M">Member (M)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wider text-muted mb-1">
                    Category
                  </label>
                  <select
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value as 'Normal' | 'Ushers' | 'Choir' | 'Band')}
                    className="input-field w-full text-xs py-2 bg-card-2"
                  >
                    <option value="Normal">Normal</option>
                    <option value="Ushers">Ushers</option>
                    <option value="Choir">Choir</option>
                    <option value="Band">Band</option>
                  </select>
                </div>

                {isRehearsal && (
                  <div className="sm:col-span-2">
                    <label className="block text-[11px] font-bold uppercase tracking-wider text-muted mb-1">
                      Rehearsal Legs & Fare
                    </label>
                    <select
                      value={newLegs}
                      onChange={(e) => setNewLegs(e.target.value as 'both' | 'going' | 'return')}
                      className="input-field w-full text-xs py-2 bg-card-2"
                    >
                      <option value="both">
                        Going & Return (Both Legs) — {isDW ? `R${DREAMWEEK_FARE} (DreamWeek)` : 'R70'}
                      </option>
                      <option value="going">
                        Going Only — {isDW ? `R${DREAMWEEK_FARE} (DreamWeek)` : 'R40'}
                      </option>
                      <option value="return">
                        Return Only — {isDW ? `R${DREAMWEEK_FARE} (DreamWeek)` : 'R40'}
                      </option>
                    </select>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-line">
                <button
                  type="button"
                  onClick={onClose}
                  className="btn-ghost py-2 px-3 text-xs"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-crimson py-2 px-4 text-xs font-bold flex items-center gap-1.5"
                >
                  <UserPlus className="h-4 w-4" />
                  <span>
                    Add to {targetVehicle ? targetVehicle.name : 'Unassigned Pool'}
                  </span>
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

export default AddPersonToVehicleModal;
