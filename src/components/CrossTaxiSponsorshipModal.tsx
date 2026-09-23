import React, { useState, useMemo } from 'react';
import { HeartHandshake, X, Search, Trash2, Plus, Check } from 'lucide-react';
import type { Passenger, Vehicle, ExternalSponsee } from '@/lib/types';

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
    amount: number;
    note?: string;
  }) => Promise<void>;
  onRemoveSponsee: (id: string) => void;
  fare?: number;
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
  fare = 40,
}: CrossTaxiSponsorshipModalProps) {
  const [payerMode, setPayerMode] = useState<'select' | 'custom'>('select');
  const [selectedPayerId, setSelectedPayerId] = useState<string>('');
  const [customPayerName, setCustomPayerName] = useState('');
  const [sponseeSearchQuery, setSponseeSearchQuery] = useState('');
  const [selectedSponsee, setSelectedSponsee] = useState<{
    id?: string;
    fullName: string;
    vehicleId?: string;
    vehicleName: string;
    structure?: string;
  } | null>(null);
  const [customSponseeName, setCustomSponseeName] = useState('');
  const [customTaxiName, setCustomTaxiName] = useState('');
  const [sponsorAmount, setSponsorAmount] = useState<number>(fare);
  const [sponsorNote, setSponsorNote] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Search candidate riders across all other taxis
  const searchMatches = useMemo(() => {
    if (!otherVehiclesWithRiders || !sponseeSearchQuery.trim()) return [];
    const term = sponseeSearchQuery.trim().toLowerCase();
    const matches: { passenger: Passenger; vehicle: Vehicle }[] = [];
    for (const group of otherVehiclesWithRiders) {
      for (const rider of group.riders) {
        if (
          rider.fullName.toLowerCase().includes(term) ||
          (rider.structure && rider.structure.toLowerCase().includes(term))
        ) {
          matches.push({ passenger: rider, vehicle: group.vehicle });
        }
      }
    }
    return matches.slice(0, 10);
  }, [otherVehiclesWithRiders, sponseeSearchQuery]);

  const totalExternalCash = useMemo(() => {
    return externalSponsees.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
  }, [externalSponsees]);

  if (!isOpen) return null;

  async function handleAdd() {
    setErrorMsg(null);
    let finalPayer = '';
    if (payerMode === 'select' && selectedPayerId) {
      finalPayer = thisVehicleRiders.find((r) => String(r.id) === String(selectedPayerId))?.fullName || '';
    } else {
      finalPayer = customPayerName.trim();
    }
    if (!finalPayer) {
      finalPayer = `Passenger in ${thisVehicleName || 'this vehicle'}`;
    }

    const finalSponsee = selectedSponsee?.fullName || customSponseeName.trim() || sponseeSearchQuery.trim();
    const finalTaxi = selectedSponsee?.vehicleName || customTaxiName.trim();

    if (!finalSponsee) {
      setErrorMsg('Please enter or search for the passenger being sponsored in another taxi.');
      return;
    }
    if (!finalTaxi) {
      setErrorMsg('Please specify which taxi/vehicle they are travelling in.');
      return;
    }

    try {
      setIsSubmitting(true);
      await onAddExternalSponsorship({
        payerId: selectedPayerId || undefined,
        payerName: finalPayer,
        sponseeId: selectedSponsee?.id,
        sponseeName: finalSponsee,
        taxiName: finalTaxi,
        targetVehicleId: selectedSponsee?.vehicleId,
        amount: sponsorAmount > 0 ? sponsorAmount : fare,
        note: sponsorNote.trim() || undefined,
      });

      // Reset form
      setSelectedPayerId('');
      setCustomPayerName('');
      setSponseeSearchQuery('');
      setSelectedSponsee(null);
      setCustomSponseeName('');
      setCustomTaxiName('');
      setSponsorAmount(fare);
      setSponsorNote('');
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Failed to record sponsorship');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 backdrop-blur-sm animate-fade-in">
      <div className="card max-h-[92vh] w-full max-w-lg overflow-y-auto border-amber-500/40 bg-card p-4 sm:p-5 shadow-2xl space-y-4">
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
                Collect fare cash in <span className="text-amber-300 font-semibold">{thisVehicleName}</span> for a rider in another taxi
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
              <span>Active Sponsees from this Taxi:</span>
              <span className="font-mono text-ink">Total: +R{totalExternalCash}</span>
            </div>
            <div className="divide-y divide-line/60">
              {externalSponsees.map((s) => (
                <div key={s.id} className="flex items-center justify-between py-2 text-xs">
                  <div className="min-w-0 pr-2">
                    <div className="font-semibold text-ink flex items-center gap-1.5 flex-wrap">
                      <span>{s.sponseeName}</span>
                      <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-300 border border-amber-500/30">
                        In {s.taxiName}
                      </span>
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
        <div className="rounded-xl border border-line bg-card-2/50 p-3.5 text-xs space-y-3">
          <div className="font-bold text-ink flex items-center gap-1.5 text-xs uppercase tracking-wide">
            <Plus className="h-3.5 w-3.5 text-amber-400" />
            <span>Record New Cross-Taxi Sponsorship</span>
          </div>

          {errorMsg && (
            <div className="rounded-lg border border-crimson-500/40 bg-crimson-500/10 p-2.5 text-xs text-crimson-300">
              {errorMsg}
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

          {/* Step 2: Who are they paying for? */}
          <div className="space-y-1.5">
            <label className="block font-semibold text-ink text-[11px]">
              2. Who are they paying for? (Search rider in another taxi):
            </label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
              <input
                type="text"
                value={sponseeSearchQuery}
                onChange={(e) => {
                  setSponseeSearchQuery(e.target.value);
                  if (selectedSponsee && selectedSponsee.fullName !== e.target.value) {
                    setSelectedSponsee(null);
                  }
                }}
                placeholder="Type name to search other taxis (e.g. Sipho, Sarah)..."
                className="input-field py-1.5 pl-8 text-xs font-medium"
              />
            </div>

            {/* Selected Sponsee Card */}
            {selectedSponsee && (
              <div className="flex items-center justify-between rounded-lg border border-emerald-500/40 bg-emerald-950/30 p-2 text-xs">
                <div className="flex items-center gap-1.5">
                  <Check className="h-4 w-4 text-emerald-400 shrink-0" />
                  <div>
                    <span className="font-bold text-ink">{selectedSponsee.fullName}</span>
                    {selectedSponsee.structure && (
                      <span className="ml-1 text-muted">({selectedSponsee.structure})</span>
                    )}
                    <div className="text-[11px] text-emerald-300">
                      Vehicle: <span className="font-semibold">{selectedSponsee.vehicleName}</span>
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedSponsee(null)}
                  className="text-xs text-muted hover:text-ink px-1.5 py-0.5 rounded border border-line"
                >
                  Change
                </button>
              </div>
            )}

            {/* Candidate Search Matches */}
            {!selectedSponsee && sponseeSearchQuery.trim().length > 1 && (
              <div className="rounded-lg border border-line bg-card p-1.5 space-y-1 max-h-40 overflow-y-auto">
                {searchMatches.length > 0 ? (
                  searchMatches.map(({ passenger, vehicle }) => (
                    <button
                      key={`${vehicle.id}-${passenger.id}`}
                      type="button"
                      onClick={() => {
                        setSelectedSponsee({
                          id: passenger.id,
                          fullName: passenger.fullName,
                          vehicleId: vehicle.id,
                          vehicleName: vehicle.name,
                          structure: passenger.structure,
                        });
                        setSponseeSearchQuery(passenger.fullName);
                      }}
                      className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs hover:bg-card-2 transition-colors"
                    >
                      <div>
                        <span className="font-semibold text-ink">{passenger.fullName}</span>
                        {passenger.structure && (
                          <span className="ml-1 text-muted text-[10px]">({passenger.structure})</span>
                        )}
                        <span className="ml-1 text-muted text-[10px]">· {passenger.stop}</span>
                      </div>
                      <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-300">
                        {vehicle.name}
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="p-2 text-center text-xs text-muted">
                    No matching passengers in other taxis. You can enter details manually below.
                  </div>
                )}
              </div>
            )}

            {/* Fallback Manual Entry */}
            {!selectedSponsee && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                <input
                  type="text"
                  value={customSponseeName}
                  onChange={(e) => setCustomSponseeName(e.target.value)}
                  placeholder="Or type full name"
                  className="input-field py-1 text-xs"
                />
                <input
                  type="text"
                  value={customTaxiName}
                  onChange={(e) => setCustomTaxiName(e.target.value)}
                  placeholder="Which taxi? (e.g. Taxi 4)"
                  className="input-field py-1 text-xs"
                />
              </div>
            )}
          </div>

          {/* Step 3: Fare & Note */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <label className="block font-semibold text-ink text-[11px] mb-1">Fare Amount (R):</label>
              <input
                type="number"
                min={0}
                step={10}
                value={sponsorAmount}
                onChange={(e) => setSponsorAmount(Math.max(0, Number(e.target.value)))}
                className="input-field py-1.5 text-xs font-mono font-bold"
              />
            </div>
            <div>
              <label className="block font-semibold text-ink text-[11px] mb-1">Optional Note:</label>
              <input
                type="text"
                value={sponsorNote}
                onChange={(e) => setSponsorNote(e.target.value)}
                placeholder="e.g. Sister, Zone 3 friend"
                className="input-field py-1.5 text-xs"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={handleAdd}
            disabled={isSubmitting}
            className="btn-amber w-full py-2 text-xs font-bold flex items-center justify-center gap-1.5 shadow-sm"
          >
            <HeartHandshake className="h-4 w-4" />
            <span>{isSubmitting ? 'Recording...' : `Collect +R${sponsorAmount} & Auto-Sponsor Rider`}</span>
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
