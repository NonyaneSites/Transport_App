import React, { useState, useMemo, useEffect } from 'react';
import { HeartHandshake, X, Search, Trash2, Plus, Check, Loader2, AlertCircle } from 'lucide-react';
import type { Passenger, Vehicle, ExternalSponsee, ServiceType } from '@/lib/types';
import { SERVICE_TYPES, getFareForDate } from '@/lib/types';
import { loadManifest, vehicleRiders } from '@/lib/manifest';
import { manifestKey, shortDate } from '@/lib/dates';

interface CrossTaxiSponsorshipModalProps {
  isOpen: boolean;
  onClose: () => void;
  thisVehicleName: string;
  thisVehicleRiders: Passenger[];
  otherVehiclesWithRiders: { vehicle: Vehicle; riders: Passenger[] }[];
  externalSponsees: ExternalSponsee[];
  onAddExternalSponsorship: (data: {
    payerId?: string;
    payerName?: string;
    sponseeId?: string;
    sponseeName: string;
    taxiName: string;
    targetVehicleId?: string;
    targetService?: string;
    targetServiceLabel?: string;
    amount: number;
    note?: string;
  }) => Promise<void>;
  onRemoveSponsee: (id: string) => void;
  fare?: number;
  currentDate?: string;
  currentService?: ServiceType;
  currentServiceLabel?: string;
}

interface SponseeCandidate {
  passenger: Passenger;
  vehicle: Vehicle;
  serviceValue: ServiceType;
  serviceLabel: string;
}

export interface SelectedSponseeItem {
  id: string;
  fullName: string;
  vehicleId: string;
  vehicleName: string;
  serviceValue?: string;
  serviceLabel?: string;
  structure?: string;
  stop?: string;
  amount: number;
}

export function CrossTaxiSponsorshipModal({
  isOpen,
  onClose,
  thisVehicleName,
  thisVehicleRiders,
  otherVehiclesWithRiders,
  externalSponsees,
  onAddExternalSponsorship,
  onRemoveSponsee,
  fare,
  currentDate,
  currentService,
  currentServiceLabel,
}: CrossTaxiSponsorshipModalProps) {
  const effectiveFare = fare !== undefined ? fare : getFareForDate(currentDate);
  const [payerMode, setPayerMode] = useState<'select' | 'custom'>('select');
  const [selectedPayerId, setSelectedPayerId] = useState<string>('');
  const [customPayerName, setCustomPayerName] = useState('');

  // Target Service Selection: defaults to 'CURRENT', or can be a specific ServiceType or 'ALL'
  const [targetServiceFilter, setTargetServiceFilter] = useState<string>('CURRENT');
  const [sponseeSearchQuery, setSponseeSearchQuery] = useState('');
  
  // Multi-person selection state
  const [selectedSponsees, setSelectedSponsees] = useState<SelectedSponseeItem[]>([]);

  // Custom sponsee addition fallback
  const [isAddingCustomSponsee, setIsAddingCustomSponsee] = useState(false);
  const [customSponseeName, setCustomSponseeName] = useState('');
  const [customSponseeTaxi, setCustomSponseeTaxi] = useState('');
  const [customSponseeStructure, setCustomSponseeStructure] = useState('');

  const [sponsorNote, setSponsorNote] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Cache for loaded manifests across services for this date
  const [manifestCache, setManifestCache] = useState<Record<string, { vehicle: Vehicle; riders: Passenger[]; service: ServiceType; serviceLabel: string }[]>>({});
  const [loadingServices, setLoadingServices] = useState(false);

  // Format current service label
  const activeServiceLabel = currentServiceLabel || SERVICE_TYPES.find((s) => s.value === currentService)?.label || 'Current Service';

  // Total cash for currently selected sponsees
  const totalSelectedCash = useMemo(() => {
    return selectedSponsees.reduce((sum, s) => sum + (Number(s.amount) || effectiveFare), 0);
  }, [selectedSponsees, effectiveFare]);

  // Load vehicles created by admin for a selected service on this date
  useEffect(() => {
    if (!isOpen || !currentDate) return;
    if (targetServiceFilter === 'CURRENT') return;

    const servicesToLoad: ServiceType[] =
      targetServiceFilter === 'ALL'
        ? SERVICE_TYPES.map((s) => s.value)
        : [targetServiceFilter as ServiceType];

    const missingServices = servicesToLoad.filter((s) => !manifestCache[s]);
    if (missingServices.length === 0) return;

    let isMounted = true;
    setLoadingServices(true);

    Promise.all(
      missingServices.map(async (st) => {
        try {
          const key = manifestKey(currentDate, st);
          const m = await loadManifest(key);
          const sDef = SERVICE_TYPES.find((s) => s.value === st);
          const sLabel = sDef ? sDef.label : st;

          if (!m || !Array.isArray(m.vehicles)) {
            return { service: st, groups: [] };
          }

          // Extract only the admin-created vehicles and their allocated riders
          const groups = m.vehicles.map((v) => ({
            vehicle: v,
            riders: vehicleRiders(m, v),
            service: st,
            serviceLabel: sLabel,
          }));

          return { service: st, groups };
        } catch (err) {
          console.warn('[CrossTaxiModal] Failed loading manifest for service:', st, err);
          return { service: st, groups: [] };
        }
      })
    ).then((results) => {
      if (!isMounted) return;
      setManifestCache((prev) => {
        const next = { ...prev };
        for (const res of results) {
          next[res.service] = res.groups;
        }
        return next;
      });
      setLoadingServices(false);
    });

    return () => {
      isMounted = false;
    };
  }, [isOpen, currentDate, targetServiceFilter, manifestCache]);

  // Aggregate candidate riders strictly from the vehicles the admin made
  const candidatePool: SponseeCandidate[] = useMemo(() => {
    const list: SponseeCandidate[] = [];

    if (targetServiceFilter === 'CURRENT') {
      // Current service: use otherVehiclesWithRiders
      for (const group of otherVehiclesWithRiders) {
        for (const rider of group.riders) {
          list.push({
            passenger: rider,
            vehicle: group.vehicle,
            serviceValue: currentService || ('PM_Normal' as ServiceType),
            serviceLabel: activeServiceLabel,
          });
        }
      }
    } else if (targetServiceFilter === 'ALL') {
      // All services that day: include current service other vehicles + other services' vehicles
      for (const group of otherVehiclesWithRiders) {
        for (const rider of group.riders) {
          list.push({
            passenger: rider,
            vehicle: group.vehicle,
            serviceValue: currentService || ('PM_Normal' as ServiceType),
            serviceLabel: activeServiceLabel,
          });
        }
      }
      for (const st of Object.keys(manifestCache)) {
        if (st === currentService) continue;
        const groups = manifestCache[st] || [];
        for (const g of groups) {
          for (const rider of g.riders) {
            list.push({
              passenger: rider,
              vehicle: g.vehicle,
              serviceValue: g.service,
              serviceLabel: g.serviceLabel,
            });
          }
        }
      }
    } else {
      // Specific selected service
      const groups = manifestCache[targetServiceFilter] || [];
      for (const g of groups) {
        // Exclude current vehicle if viewing same service
        if (g.service === currentService && g.vehicle.name.toLowerCase() === thisVehicleName.toLowerCase()) {
          continue;
        }
        for (const rider of g.riders) {
          list.push({
            passenger: rider,
            vehicle: g.vehicle,
            serviceValue: g.service,
            serviceLabel: g.serviceLabel,
          });
        }
      }
    }

    return list;
  }, [targetServiceFilter, otherVehiclesWithRiders, manifestCache, currentService, activeServiceLabel, thisVehicleName]);

  // Filter candidates by search term
  const searchMatches = useMemo(() => {
    const query = sponseeSearchQuery.trim().toLowerCase();
    if (!query) return [];

    return candidatePool.filter((c) => {
      const nameMatch = c.passenger.fullName.toLowerCase().includes(query);
      const structMatch = c.passenger.structure ? c.passenger.structure.toLowerCase().includes(query) : false;
      const vehMatch = c.vehicle.name.toLowerCase().includes(query);
      return nameMatch || structMatch || vehMatch;
    }).slice(0, 20);
  }, [candidatePool, sponseeSearchQuery]);

  const totalExternalCash = useMemo(() => {
    return externalSponsees.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
  }, [externalSponsees]);

  // Toggle or add candidate to selected list
  function toggleCandidate(candidate: SponseeCandidate) {
    setErrorMsg(null);
    const candidateId = String(candidate.passenger.id);
    const existingIndex = selectedSponsees.findIndex((s) => s.id === candidateId);

    if (existingIndex >= 0) {
      // Remove
      setSelectedSponsees((prev) => prev.filter((_, idx) => idx !== existingIndex));
    } else {
      // Add
      const newItem: SelectedSponseeItem = {
        id: candidateId,
        fullName: candidate.passenger.fullName,
        vehicleId: candidate.vehicle.id,
        vehicleName: candidate.vehicle.name,
        serviceValue: candidate.serviceValue,
        serviceLabel: candidate.serviceLabel,
        structure: candidate.passenger.structure,
        stop: candidate.passenger.stop,
        amount: effectiveFare,
      };
      setSelectedSponsees((prev) => [...prev, newItem]);
    }
  }

  function handleAddCustomSponsee() {
    if (!customSponseeName.trim()) {
      setErrorMsg('Please enter a sponsee passenger name.');
      return;
    }
    const cleanTaxi = customSponseeTaxi.trim() || 'Other Vehicle';
    const fakeId = `custom-sponsee-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const newItem: SelectedSponseeItem = {
      id: fakeId,
      fullName: customSponseeName.trim(),
      vehicleId: '',
      vehicleName: cleanTaxi,
      serviceValue: targetServiceFilter !== 'CURRENT' && targetServiceFilter !== 'ALL' ? targetServiceFilter : currentService,
      serviceLabel: activeServiceLabel,
      structure: customSponseeStructure.trim() || undefined,
      amount: effectiveFare,
    };
    setSelectedSponsees((prev) => [...prev, newItem]);
    setCustomSponseeName('');
    setCustomSponseeTaxi('');
    setCustomSponseeStructure('');
    setIsAddingCustomSponsee(false);
  }

  function updateSponseeAmount(id: string, amount: number) {
    setSelectedSponsees((prev) =>
      prev.map((s) => (s.id === id ? { ...s, amount: Math.max(0, amount) } : s))
    );
  }

  function removeSelectedSponsee(id: string) {
    setSelectedSponsees((prev) => prev.filter((s) => s.id !== id));
  }

  if (!isOpen) return null;

  async function handleAdd() {
    setErrorMsg(null);
    setSuccessMsg(null);

    let finalPayer = '';
    if (payerMode === 'select' && selectedPayerId) {
      finalPayer = thisVehicleRiders.find((r) => String(r.id) === String(selectedPayerId))?.fullName || '';
    } else {
      finalPayer = customPayerName.trim();
    }
    if (!finalPayer) {
      finalPayer = `Passenger in ${thisVehicleName || 'this vehicle'}`;
    }

    if (selectedSponsees.length === 0) {
      setErrorMsg('Please select at least 1 passenger to sponsor.');
      return;
    }

    try {
      setIsSubmitting(true);

      // Sponsor ALL selected people
      for (const sponsee of selectedSponsees) {
        await onAddExternalSponsorship({
          payerId: selectedPayerId || undefined,
          payerName: finalPayer,
          sponseeId: sponsee.id.startsWith('custom-') ? undefined : sponsee.id,
          sponseeName: sponsee.fullName,
          taxiName: sponsee.vehicleName,
          targetVehicleId: sponsee.vehicleId || undefined,
          targetService: sponsee.serviceValue,
          targetServiceLabel: sponsee.serviceLabel,
          amount: sponsee.amount > 0 ? sponsee.amount : effectiveFare,
          note: sponsorNote.trim() || undefined,
        });
      }

      setSuccessMsg(`✓ Successfully sponsored ${selectedSponsees.length} passenger${selectedSponsees.length > 1 ? 's' : ''}!`);
      setTimeout(() => {
        setSuccessMsg(null);
        // Reset form
        setSelectedPayerId('');
        setCustomPayerName('');
        setSponseeSearchQuery('');
        setSelectedSponsees([]);
        setSponsorNote('');
      }, 1500);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Failed to record sponsorship');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 backdrop-blur-sm animate-fade-in">
      <div className="card max-h-[92vh] w-full max-w-xl overflow-y-auto border-amber-500/40 bg-card p-4 sm:p-5 shadow-2xl space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line pb-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/20 text-amber-300">
              <HeartHandshake className="h-4 w-4" />
            </div>
            <div>
              <h2 className="font-display text-sm sm:text-base font-bold text-ink flex items-center gap-2">
                Cross-Taxi Sponsorships
                {externalSponsees.length > 0 && (
                  <span className="rounded bg-amber-500/20 px-2 py-0.5 text-xs font-bold text-amber-300 border border-amber-500/30">
                    {externalSponsees.length} Active (+R{totalExternalCash})
                  </span>
                )}
              </h2>
              <p className="text-[11px] text-muted">
                Collect fare cash in <span className="text-amber-300 font-semibold">{thisVehicleName}</span> for one or multiple riders in other vehicles
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-muted hover:bg-card-2 hover:text-ink transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Existing Sponsees List */}
        {externalSponsees.length > 0 && (
          <div className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
            <div className="flex items-center justify-between text-xs font-bold text-amber-300">
              <span>Active Sponsees Paid from this Taxi:</span>
              <span className="font-mono text-ink">Total: +R{totalExternalCash}</span>
            </div>
            <div className="divide-y divide-line/60 max-h-40 overflow-y-auto pr-1">
              {externalSponsees.map((s) => (
                <div key={s.id} className="flex items-center justify-between py-2 text-xs">
                  <div className="min-w-0 pr-2">
                    <div className="font-semibold text-ink flex items-center gap-1.5 flex-wrap">
                      <span>{s.sponseeName}</span>
                      <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-300 border border-amber-500/30 font-medium">
                        In {s.taxiName}
                      </span>
                      {s.targetServiceLabel && (
                        <span className="rounded bg-card-2 px-1.5 py-0.5 text-[9px] text-muted border border-line">
                          {s.targetServiceLabel}
                        </span>
                      )}
                      <span className="font-mono font-bold text-emerald-400">R{s.amount}</span>
                    </div>
                    <div className="text-[11px] text-muted">
                      Paid by: <span className="text-ink font-medium">{s.payerName}</span>
                      {s.note && <span> · "{s.note}"</span>}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onRemoveSponsee(s.id)}
                    className="rounded p-1 text-crimson-400 hover:bg-crimson-500/20 transition-colors shrink-0"
                    title="Remove sponsorship"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Add Sponsorship Form */}
        <div className="rounded-xl border border-line bg-card-2/50 p-3.5 text-xs space-y-3.5">
          <div className="font-bold text-ink flex items-center justify-between text-xs uppercase tracking-wide">
            <div className="flex items-center gap-1.5">
              <Plus className="h-3.5 w-3.5 text-amber-400" />
              <span>Record Cross Sponsorship (Multi-Person Supported)</span>
            </div>
            {selectedSponsees.length > 0 && (
              <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold text-amber-300 border border-amber-500/40">
                {selectedSponsees.length} Selected (R{totalSelectedCash})
              </span>
            )}
          </div>

          {errorMsg && (
            <div className="rounded-lg border border-crimson-500/40 bg-crimson-500/10 p-2.5 text-xs text-crimson-300 flex items-center gap-1.5 animate-fade-in">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {successMsg && (
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-2.5 text-xs text-emerald-300 flex items-center gap-1.5 animate-fade-in">
              <Check className="h-4 w-4 shrink-0 text-emerald-400" />
              <span>{successMsg}</span>
            </div>
          )}

          {/* Step 1: Who is paying? */}
          <div className="space-y-1.5">
            <label className="block font-semibold text-ink text-[11px]">
              1. Who is paying? (Passenger in {thisVehicleName}):
            </label>
            <div className="flex gap-2 text-[11px]">
              <button
                type="button"
                onClick={() => setPayerMode('select')}
                className={`px-2 py-1 rounded text-[11px] font-medium border ${
                  payerMode === 'select'
                    ? 'border-amber-500/60 bg-amber-500/20 text-amber-200'
                    : 'border-line text-muted hover:text-ink'
                }`}
              >
                Select from this taxi ({thisVehicleRiders.length})
              </button>
              <button
                type="button"
                onClick={() => setPayerMode('custom')}
                className={`px-2 py-1 rounded text-[11px] font-medium border ${
                  payerMode === 'custom'
                    ? 'border-amber-500/60 bg-amber-500/20 text-amber-200'
                    : 'border-line text-muted hover:text-ink'
                }`}
              >
                Enter Custom Name
              </button>
            </div>

            {payerMode === 'select' ? (
              <select
                value={selectedPayerId}
                onChange={(e) => setSelectedPayerId(e.target.value)}
                className="input-field py-1.5 text-xs"
              >
                <option value="">-- Choose passenger in this vehicle --</option>
                {thisVehicleRiders.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.fullName} {r.structure ? `(${r.structure})` : ''} - {r.stop}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={customPayerName}
                onChange={(e) => setCustomPayerName(e.target.value)}
                placeholder="Enter payer name (e.g. John Dlamini)"
                className="input-field py-1.5 text-xs"
              />
            )}
          </div>

          {/* Step 2: Service Selection & Search Rider(s) */}
          <div className="space-y-2 pt-1 border-t border-line/60">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5">
              <label className="block font-semibold text-ink text-[11px]">
                2. Which service is the other passenger travelling in?
              </label>
              {currentDate && (
                <span className="text-[10px] text-muted font-mono">{shortDate(currentDate)}</span>
              )}
            </div>

            {/* Service selector dropdown */}
            <div className="relative">
              <select
                value={targetServiceFilter}
                onChange={(e) => {
                  setTargetServiceFilter(e.target.value);
                }}
                className="input-field py-1.5 text-xs font-semibold bg-card cursor-pointer border-amber-500/40 text-amber-300"
              >
                <option value="CURRENT">
                  ⭐ Current Service: {activeServiceLabel}
                </option>
                <option value="ALL">
                  🌐 All Services on {currentDate || 'this date'}
                </option>
                <optgroup label="Specific Services Today:">
                  {SERVICE_TYPES.map((st) => (
                    <option key={st.value} value={st.value}>
                      {st.label}
                    </option>
                  ))}
                </optgroup>
              </select>
              {loadingServices && (
                <div className="absolute right-8 top-1/2 -translate-y-1/2 flex items-center gap-1 text-[10px] text-amber-300 font-medium">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>Loading vehicles…</span>
                </div>
              )}
            </div>

            {/* Search Box */}
            <div className="space-y-1.5 pt-1">
              <div className="flex items-center justify-between">
                <label className="block font-semibold text-ink text-[11px]">
                  Search passenger name(s) across vehicles:
                </label>
                <button
                  type="button"
                  onClick={() => setIsAddingCustomSponsee(!isAddingCustomSponsee)}
                  className="text-[11px] text-amber-300 hover:text-amber-200 underline font-medium"
                >
                  {isAddingCustomSponsee ? 'Hide Custom Entry' : '+ Custom Name Sponsee'}
                </button>
              </div>

              {/* Custom Sponsee Input Section */}
              {isAddingCustomSponsee && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 space-y-2 animate-fade-in">
                  <p className="text-[11px] text-amber-200 font-semibold">
                    Add passenger manually if not in pre-allocated list:
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <input
                      type="text"
                      placeholder="Passenger Name (e.g. Sipho)"
                      value={customSponseeName}
                      onChange={(e) => setCustomSponseeName(e.target.value)}
                      className="input-field py-1 text-xs"
                    />
                    <input
                      type="text"
                      placeholder="Vehicle / Taxi Name (e.g. Taxi 2)"
                      value={customSponseeTaxi}
                      onChange={(e) => setCustomSponseeTaxi(e.target.value)}
                      className="input-field py-1 text-xs"
                    />
                    <input
                      type="text"
                      placeholder="Structure (e.g. S1)"
                      value={customSponseeStructure}
                      onChange={(e) => setCustomSponseeStructure(e.target.value)}
                      className="input-field py-1 text-xs"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleAddCustomSponsee}
                    className="btn-amber text-xs py-1 px-3 w-full font-bold"
                  >
                    Add to Sponsorship List (+R{effectiveFare})
                  </button>
                </div>
              )}

              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
                <input
                  type="text"
                  value={sponseeSearchQuery}
                  onChange={(e) => setSponseeSearchQuery(e.target.value)}
                  placeholder="Type name or structure (e.g. Sipho, Sarah, S2)... select multiple"
                  className="input-field py-1.5 pl-8 text-xs font-medium"
                />
                {sponseeSearchQuery && (
                  <button
                    type="button"
                    onClick={() => setSponseeSearchQuery('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-ink text-xs"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            {/* Selected Sponsees Cards (Multi-Person Basket) */}
            {selectedSponsees.length > 0 && (
              <div className="rounded-xl border border-amber-500/50 bg-amber-500/10 p-3 space-y-2 animate-fade-in">
                <div className="flex items-center justify-between text-xs font-bold text-amber-300">
                  <div className="flex items-center gap-1.5">
                    <Check className="h-4 w-4 text-emerald-400" />
                    <span>Passengers to Sponsor ({selectedSponsees.length}):</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-ink">Total Cash: R{totalSelectedCash}</span>
                    <button
                      type="button"
                      onClick={() => setSelectedSponsees([])}
                      className="text-[10px] text-crimson-300 hover:text-crimson-200 underline"
                    >
                      Clear all
                    </button>
                  </div>
                </div>

                <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                  {selectedSponsees.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-card p-2 text-xs"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-bold text-ink flex items-center gap-1.5 flex-wrap">
                          <span>{item.fullName}</span>
                          {item.structure && (
                            <span className="rounded bg-card-2 px-1 py-0.2 text-[10px] text-muted border border-line">
                              {item.structure}
                            </span>
                          )}
                          <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300 border border-amber-500/30">
                            In {item.vehicleName}
                          </span>
                          {item.serviceLabel && (
                            <span className="text-[10px] text-muted truncate max-w-[120px]">
                              · {item.serviceLabel}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Custom fare per person & remove */}
                      <div className="flex items-center gap-1.5 shrink-0">
                        <div className="flex items-center gap-1">
                          <span className="text-[10px] text-muted font-mono">R</span>
                          <input
                            type="number"
                            min={0}
                            step={10}
                            value={item.amount}
                            onChange={(e) => updateSponseeAmount(item.id, Number(e.target.value))}
                            className="w-14 rounded border border-line bg-card-2 px-1 py-0.5 text-xs font-mono font-bold text-ink text-right"
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => removeSelectedSponsee(item.id)}
                          className="rounded p-1 text-muted hover:text-crimson-300 hover:bg-card-2 transition-colors"
                          title="Remove from list"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Live Search Candidate Results with Multi-Select checkmarks */}
            {sponseeSearchQuery.trim().length > 0 && (
              <div className="rounded-lg border border-line bg-card p-1.5 space-y-1 max-h-52 overflow-y-auto">
                <div className="text-[10px] text-muted font-semibold uppercase px-2 py-0.5">
                  Click to select / unselect candidates ({searchMatches.length} matching):
                </div>
                {searchMatches.length > 0 ? (
                  searchMatches.map((candidate) => {
                    const isSelected = selectedSponsees.some((s) => s.id === String(candidate.passenger.id));
                    return (
                      <button
                        key={`${candidate.serviceValue}-${candidate.vehicle.id}-${candidate.passenger.id}`}
                        type="button"
                        onClick={() => toggleCandidate(candidate)}
                        className={`flex w-full items-center justify-between rounded px-2.5 py-1.5 text-left text-xs transition-colors border ${
                          isSelected
                            ? 'bg-amber-500/20 border-amber-500/60 text-amber-200'
                            : 'hover:bg-card-2 border-transparent hover:border-line'
                        }`}
                      >
                        <div className="min-w-0 pr-2 flex items-center gap-2">
                          <div
                            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                              isSelected
                                ? 'bg-amber-500 border-amber-500 text-black'
                                : 'border-line text-transparent'
                            }`}
                          >
                            <Check className="h-3 w-3 stroke-[3]" />
                          </div>
                          <div>
                            <div className="font-semibold text-ink flex items-center gap-1.5 flex-wrap">
                              <span>{candidate.passenger.fullName}</span>
                              {candidate.passenger.structure && (
                                <span className="rounded bg-card-2 px-1 py-0.2 text-[9px] text-muted border border-line">
                                  {candidate.passenger.structure}
                                </span>
                              )}
                            </div>
                            <div className="text-[10px] text-muted truncate">
                              Stop: {candidate.passenger.stop || 'Standard'}
                            </div>
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-0.5 shrink-0">
                          <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-300 border border-amber-500/30">
                            {candidate.vehicle.name}
                          </span>
                          {candidate.serviceLabel && (
                            <span className="text-[9px] text-muted truncate max-w-[130px]">
                              {candidate.serviceLabel}
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })
                ) : (
                  <div className="p-3 text-center text-xs text-muted space-y-1">
                    <p className="font-semibold text-ink">No passenger found matching "{sponseeSearchQuery.trim()}"</p>
                    <p className="text-[11px] text-muted">
                      Use the "+ Custom Name Sponsee" button above if you need to sponsor someone not in the system yet.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Step 3: Optional General Note */}
          <div className="pt-1 border-t border-line/60">
            <label className="block font-semibold text-ink text-[11px] mb-1">Optional Note for All Sponsees:</label>
            <input
              type="text"
              value={sponsorNote}
              onChange={(e) => setSponsorNote(e.target.value)}
              placeholder="e.g. Cell leader paying for attendees / Parent paying for family"
              className="input-field py-1.5 text-xs"
            />
          </div>

          {/* Submit Button (Multi-person enabled) */}
          <button
            type="button"
            onClick={handleAdd}
            disabled={isSubmitting || selectedSponsees.length === 0}
            className={`w-full py-2.5 text-xs font-bold flex items-center justify-center gap-1.5 shadow-sm rounded-xl transition-all ${
              selectedSponsees.length > 0 && !isSubmitting
                ? 'btn-amber cursor-pointer hover:scale-[1.01]'
                : 'bg-card-2 border border-line text-muted cursor-not-allowed opacity-60'
            }`}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Auto-Sponsoring {selectedSponsees.length} passenger{selectedSponsees.length > 1 ? 's' : ''}…</span>
              </>
            ) : selectedSponsees.length > 0 ? (
              <>
                <HeartHandshake className="h-4 w-4" />
                <span>
                  Collect +R{totalSelectedCash} & Auto-Sponsor {selectedSponsees.length}{' '}
                  {selectedSponsees.length === 1 ? `(${selectedSponsees[0].fullName})` : `Passengers`}
                </span>
              </>
            ) : (
              <span>Select one or more passengers above to record sponsorship</span>
            )}
          </button>
        </div>

        {/* Footer */}
        <div className="flex justify-end pt-2 border-t border-line">
          <button
            type="button"
            onClick={onClose}
            className="btn-secondary text-xs px-4 py-1.5"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
