import { useState, useEffect, useMemo } from 'react';
import {
  X,
  HeartHandshake,
  Loader2,
  AlertTriangle,
  FileText,
  Share2,
} from 'lucide-react';
import type { Manifest, Passenger, Vehicle, ServiceType } from '@/lib/types';
import { SERVICE_TYPES, CANCELLATION_FEE } from '@/lib/types';
import { parseManifestKey } from '@/lib/dates';
import { sortVehiclesNatural } from '@/lib/sort';
import { getCompatibleServices, getServiceVehicles, transferPassengerAcrossServices } from '@/lib/transfer';
import { supabase } from '@/lib/supabase';
import {
  LEDGER_TABLE,
  recordReportedSponsorships,
  sanitizePassengerDisplayName,
  normalizeStructureCode,
  cleanSponsorshipNote,
} from '@/lib/ledger';

interface TransferSponsorshipModalProps {
  isOpen: boolean;
  onClose: () => void;
  manifest: Manifest;
  currentService: ServiceType;
  initialPassenger?: Passenger | null;
  onSuccess: (message: string, transferredPassengerId?: string) => void;
}

export function TransferSponsorshipModal({
  isOpen,
  onClose,
  manifest,
  currentService,
  initialPassenger,
  onSuccess,
}: TransferSponsorshipModalProps) {
  const { date: sessionDate } = parseManifestKey(manifest.date);

  // Compatible target services in the same time session window (AM or PM)
  const compatibleServices = useMemo(
    () => getCompatibleServices(currentService).filter((s) => s !== currentService),
    [currentService]
  );

  const [selectedPassengerId, setSelectedPassengerId] = useState<string>(
    initialPassenger?.id || ''
  );
  const [destinationType, setDestinationType] = useState<'ledger' | 'service'>('ledger');
  const [targetService, setTargetService] = useState<ServiceType>(
    compatibleServices[0] || 'PM_Normal'
  );
  const [targetVehicleId, setTargetVehicleId] = useState<string>('unassigned');
  const [isSponsored, setIsSponsored] = useState<boolean>(true);
  const [sponsorNote, setSponsorNote] = useState<string>('');
  const [loadingVehicles, setLoadingVehicles] = useState<boolean>(false);
  const [targetVehicles, setTargetVehicles] = useState<Vehicle[]>([]);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Sync state when initialPassenger or modal opens
  useEffect(() => {
    if (isOpen) {
      const pId = initialPassenger?.id || manifest.signups[0]?.id || '';
      setSelectedPassengerId(pId);
      const defaultTarget = compatibleServices[0] || 'PM_Normal';
      setTargetService(defaultTarget);
      setTargetVehicleId('unassigned');
      setIsSponsored(true);

      // Preserve existing passenger note if attached
      const p = initialPassenger || manifest.signups.find((item) => item.id === pId);
      let existingNote = p?.sponsorNote || '';
      if (!existingNote && p) {
        const v = manifest.vehicles.find((veh) => veh.riders?.includes(p.id));
        if (v?.draftState?.notes?.[p.id]) {
          existingNote = v.draftState.notes[p.id];
        }
      }

      setSponsorNote(cleanSponsorshipNote(existingNote));
      setError(null);
    }
  }, [isOpen, initialPassenger, currentService, manifest.signups, manifest.vehicles, compatibleServices]);

  // Load vehicles of the target service whenever targetService changes
  useEffect(() => {
    if (!isOpen || !sessionDate || !targetService || destinationType !== 'service') return;

    let cancelled = false;
    setLoadingVehicles(true);
    setTargetVehicles([]);

    getServiceVehicles(sessionDate, targetService)
      .then((vehicles) => {
        if (!cancelled) {
          setTargetVehicles(sortVehiclesNatural(vehicles));
          // Default to first vehicle if available, else unassigned
          if (vehicles.length > 0) {
            setTargetVehicleId(vehicles[0].id);
          } else {
            setTargetVehicleId('unassigned');
          }
          setLoadingVehicles(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('[TransferModal] Failed loading target vehicles:', err);
          setLoadingVehicles(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, sessionDate, targetService, destinationType]);

  if (!isOpen) return null;

  const currentDef = SERVICE_TYPES.find((s) => s.value === currentService);
  const selectedPassenger = manifest.signups.find((p) => p.id === selectedPassengerId);

  // Partition signups for the dropdown: Unassigned vs Assigned
  const unassignedSignups = manifest.signups.filter((p) => !p.assignedTo);
  const assignedSignups = manifest.signups.filter((p) => p.assignedTo);

  async function handleConfirmTransfer() {
    if (!selectedPassengerId) {
      setError('Please select a passenger to transfer.');
      return;
    }

    setSubmitting(true);
    setError(null);

    const passengerToTransfer = manifest.signups.find((p) => p.id === selectedPassengerId);
    const pName = passengerToTransfer?.fullName || 'Passenger';
    const struct = normalizeStructureCode(passengerToTransfer?.structure);
    const cleanName = sanitizePassengerDisplayName(pName);
    const effectiveNote = cleanSponsorshipNote(sponsorNote);

    try {
      if (destinationType === 'ledger') {
        const parentVeh = manifest.vehicles.find((v) => v.riders?.includes(selectedPassengerId));
        const ledgerEntryId = `spon_debt_${selectedPassengerId}_${Date.now()}`;
        const entryNote = effectiveNote;

        const row = {
          id: ledgerEntryId,
          manifest_key: manifest.date,
          date: sessionDate,
          service: currentDef?.label || currentService,
          passenger_name: cleanName,
          stop: passengerToTransfer?.stop || '',
          structure: struct || '',
          vehicle_name: parentVeh?.name || 'Vehicle',
          submitted_by: parentVeh?.repName || 'Admin',
          rep_name: parentVeh?.repName || 'Admin',
          license_plate: parentVeh?.licensePlate || '',
          sponsored: true,
          sponsor_note: entryNote,
          structure_debt: CANCELLATION_FEE,
          general_notes: entryNote,
          submitted_at: new Date().toISOString(),
        };

        await supabase.from(LEDGER_TABLE).upsert(row, { onConflict: 'id' });

        await recordReportedSponsorships(
          manifest.date,
          sessionDate,
          currentDef?.label || currentService,
          [{
            id: String(selectedPassengerId),
            fullName: cleanName,
            structure: struct,
            stop: passengerToTransfer?.stop || '',
            sponsorNote: effectiveNote,
          }],
          [cleanName],
          parentVeh?.name || 'Vehicle',
          parentVeh?.repName || 'Admin'
        );

        setSubmitting(false);
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('crc_ledger_updated'));
          window.dispatchEvent(new CustomEvent('crc_sponsorships_updated'));
        }

        onSuccess(
          `Successfully recorded ${cleanName} on Structure ${struct || 'Unassigned'} Ledger (R40 Debt) with note: "${effectiveNote}".`,
          selectedPassengerId
        );
        onClose();
        return;
      }

      // Destination is another service
      if (!targetService) {
        setError('Please select a target service.');
        setSubmitting(false);
        return;
      }

      const targetVehObj = targetVehicles.find((v) => v.id === targetVehicleId);
      const targetVehName = targetVehicleId === 'unassigned' ? 'Unassigned Pool' : (targetVehObj?.name || 'Vehicle');
      const targetServiceDef = SERVICE_TYPES.find((s) => s.value === targetService);

      const res = await transferPassengerAcrossServices({
        date: sessionDate,
        fromService: currentService,
        toService: targetService,
        passengerId: selectedPassengerId,
        toVehicleId: targetVehicleId,
        isSponsored,
        sponsorNote: effectiveNote,
        markPresent: passengerToTransfer?.present ?? false,
        sourceManifest: manifest,
      });

      setSubmitting(false);

      if (!res.success) {
        setError(res.error || 'Failed to transfer passenger.');
        return;
      }

      onSuccess(
        `Successfully moved ${pName} to ${targetServiceDef?.label || targetService} (${targetVehName})${
          isSponsored ? ' as an Unaccounted Sponsorship' : ''
        }.`,
        selectedPassengerId
      );
      onClose();
    } catch (transferErr) {
      setSubmitting(false);
      setError(transferErr instanceof Error ? transferErr.message : 'Transfer failed unexpectedly.');
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-lg rounded-2xl border border-line bg-card shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line px-5 py-4 bg-card-2/50">
          <div className="flex items-center gap-2.5">
            <div className="rounded-xl bg-amber-500/15 p-2 text-amber-300 border border-amber-500/30">
              <HeartHandshake className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-display text-base font-bold text-ink">
                Transfer Sponsorship & Debt
              </h3>
              <p className="text-xs text-muted">
                {currentDef?.label || currentService} · {sessionDate}
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

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {error && (
            <div className="flex items-center gap-2 rounded-xl border border-crimson-500/30 bg-crimson-500/10 p-3 text-xs text-crimson-300 animate-shake">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* 1. Passenger Selection */}
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted">
              Select Passenger
            </label>
            <select
              value={selectedPassengerId}
              onChange={(e) => {
                setSelectedPassengerId(e.target.value);
                const p = manifest.signups.find((item) => item.id === e.target.value);
                let existing = p?.sponsorNote || '';
                if (!existing && p) {
                  const v = manifest.vehicles.find((veh) => veh.riders?.includes(p.id));
                  if (v?.draftState?.notes?.[p.id]) existing = v.draftState.notes[p.id];
                }
                setSponsorNote(cleanSponsorshipNote(existing));
              }}
              className="input-field py-2 text-xs w-full bg-card-2"
            >
              <option value="" disabled className="bg-card-2">
                Choose a person to transfer...
              </option>

              {unassignedSignups.length > 0 && (
                <optgroup label="⏳ Waiting / Unassigned (Cannot Fit)" className="bg-card-2 text-crimson-300 font-bold">
                  {unassignedSignups.map((p) => (
                    <option key={p.id} value={p.id} className="bg-card-2 text-ink">
                      {p.fullName} ({p.structure || 'No Struct'}) · {p.stop} [Unassigned]
                    </option>
                  ))}
                </optgroup>
              )}

              {assignedSignups.length > 0 && (
                <optgroup label="👥 Assigned to Vehicles" className="bg-card-2 text-muted">
                  {assignedSignups.map((p) => {
                    const veh = manifest.vehicles.find((v) => v.id === p.assignedTo);
                    return (
                      <option key={p.id} value={p.id} className="bg-card-2 text-ink">
                        {p.fullName} ({p.structure || 'No Struct'}) · {veh?.name || 'Assigned'}
                      </option>
                    );
                  })}
                </optgroup>
              )}
            </select>
          </div>

          {/* Selected Passenger Info Summary */}
          {selectedPassenger && (
            <div className="rounded-xl border border-line bg-card-2/40 p-3 text-xs flex items-center justify-between gap-3">
              <div>
                <div className="font-semibold text-ink">{selectedPassenger.fullName}</div>
                <div className="text-muted text-[11px] mt-0.5">
                  Stop: <span className="text-ink">{selectedPassenger.stop}</span> · Structure: <span className="text-ink font-semibold text-amber-300">{selectedPassenger.structure || '—'}</span>
                </div>
              </div>
              <div>
                {selectedPassenger.assignedTo ? (
                  <span className="badge bg-card-2 text-muted text-[10px]">
                    {manifest.vehicles.find((v) => v.id === selectedPassenger.assignedTo)?.name || 'Assigned'}
                  </span>
                ) : (
                  <span className="badge bg-crimson-500/15 text-crimson-300 text-[10px] font-semibold">
                    ⏳ Unassigned / Waiting
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Transfer Mode Tabs */}
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted">
              Transfer Destination
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setDestinationType('ledger')}
                className={`flex items-center justify-center gap-2 rounded-xl border p-2.5 text-xs font-semibold transition-all ${
                  destinationType === 'ledger'
                    ? 'border-crimson-500 bg-crimson-500/15 text-crimson-300 shadow-sm'
                    : 'border-line bg-card-2/40 text-muted hover:text-ink'
                }`}
              >
                <FileText className="h-4 w-4" />
                <span>Structure Debt Ledger (R40)</span>
              </button>

              <button
                type="button"
                onClick={() => setDestinationType('service')}
                className={`flex items-center justify-center gap-2 rounded-xl border p-2.5 text-xs font-semibold transition-all ${
                  destinationType === 'service'
                    ? 'border-amber-500 bg-amber-500/15 text-amber-300 shadow-sm'
                    : 'border-line bg-card-2/40 text-muted hover:text-ink'
                }`}
              >
                <Share2 className="h-4 w-4" />
                <span>To Other Service</span>
              </button>
            </div>
          </div>

          {destinationType === 'ledger' ? (
            <div className="rounded-xl border border-crimson-500/30 bg-crimson-950/20 p-3.5 space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-muted">Target Ledger:</span>
                <span className="font-bold text-amber-300">Structure {selectedPassenger?.structure || 'Unassigned'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted">Debt Amount:</span>
                <span className="font-bold text-crimson-400">R40.00 (Unaccounted Sponsorship)</span>
              </div>
              <p className="text-[11px] text-muted pt-1 border-t border-line/50">
                Immediately records this sponsorship as an outstanding debt under this passenger's structure in the Cancellation & Debt Ledger.
              </p>
            </div>
          ) : (
            <>
              {/* Source -> Target Service Mapping */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-center">
                {/* From Service */}
                <div className="rounded-xl border border-line bg-card-2/30 p-3">
                  <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted mb-1">
                    From Service
                  </span>
                  <div className="font-bold text-ink text-xs flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-crimson-500" />
                    {currentDef?.label || currentService}
                  </div>
                </div>

                {/* To Service */}
                <div>
                  <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted">
                    To Service (Same Session)
                  </label>
                  <select
                    value={targetService}
                    onChange={(e) => setTargetService(e.target.value as ServiceType)}
                    className="input-field py-2 text-xs w-full bg-card-2 font-medium"
                  >
                    {compatibleServices.map((st) => {
                      const def = SERVICE_TYPES.find((s) => s.value === st);
                      return (
                        <option key={st} value={st} className="bg-card-2">
                          {def?.label || st}
                        </option>
                      );
                    })}
                  </select>
                </div>
              </div>

              {/* Destination Vehicle Selection */}
              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted flex items-center justify-between">
                  <span>Target Vehicle in {SERVICE_TYPES.find((s) => s.value === targetService)?.mode || targetService}</span>
                  {loadingVehicles && (
                    <span className="flex items-center gap-1 text-[11px] text-muted font-normal">
                      <Loader2 className="h-3 w-3 animate-spin text-amber-400" />
                      Loading vehicles...
                    </span>
                  )}
                </label>

                <select
                  value={targetVehicleId}
                  onChange={(e) => setTargetVehicleId(e.target.value)}
                  disabled={loadingVehicles}
                  className="input-field py-2 text-xs w-full bg-card-2"
                >
                  <option value="unassigned" className="bg-card-2 text-crimson-300 font-semibold">
                    ⏳ Unassigned Pool (Transfer to destination unassigned queue)
                  </option>

                  {targetVehicles.map((v) => {
                    const repLabel = v.repName ? ` · Rep: ${v.repName}` : '';
                    return (
                      <option key={v.id} value={v.id} className="bg-card-2 text-ink">
                        {v.type === 'Bus' ? '🚌' : '🚕'} {v.name} ({v.riders.length} riders{repLabel})
                      </option>
                    );
                  })}
                </select>
                {targetVehicles.length === 0 && !loadingVehicles && (
                  <p className="mt-1 text-[11px] text-muted">
                    No vehicles configured in {targetService} yet. Passenger will be placed in the Unassigned Pool.
                  </p>
                )}
              </div>
            </>
          )}

          {/* Sponsorship & Notes Settings */}
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3.5 space-y-3">
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted">
                Sponsorship / Note Details
              </label>
              <input
                type="text"
                value={sponsorNote}
                onChange={(e) => setSponsorNote(e.target.value)}
                placeholder="e.g. Paid in cash, John in Taxi 2, Unaccounted"
                className="input-field py-1.5 text-xs w-full bg-card-2"
              />
              <p className="mt-1 text-[10px] text-muted">
                This note will be permanently recorded in the ledger and visible during financial reconciliation.
              </p>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-line px-5 py-3.5 bg-card-2/60">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="btn-ghost px-4 py-2 text-xs"
          >
            Cancel
          </button>

          <button
            type="button"
            onClick={handleConfirmTransfer}
            disabled={submitting || !selectedPassengerId}
            className="btn-crimson px-4 py-2 text-xs font-semibold flex items-center gap-2 shadow-md disabled:opacity-50"
          >
            {submitting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Processing...</span>
              </>
            ) : destinationType === 'ledger' ? (
              <>
                <FileText className="h-4 w-4" />
                <span>Transfer to Ledger (R40)</span>
              </>
            ) : (
              <>
                <HeartHandshake className="h-4 w-4" />
                <span>Confirm & Transfer</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

