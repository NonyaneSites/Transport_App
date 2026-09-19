import { useState, useEffect, useMemo } from 'react';
import {
  X,
  HeartHandshake,
  Loader2,
  AlertTriangle,
} from 'lucide-react';
import type { Manifest, Passenger, Vehicle, ServiceType } from '@/lib/types';
import { SERVICE_TYPES } from '@/lib/types';
import { parseManifestKey } from '@/lib/dates';
import { sortVehiclesNatural } from '@/lib/sort';
import { getCompatibleServices, getServiceVehicles, transferPassengerAcrossServices } from '@/lib/transfer';

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
      const fromDef = SERVICE_TYPES.find((s) => s.value === currentService);
      setSponsorNote(`Unaccounted Sponsorship (from ${fromDef?.mode || currentService})`);
      setError(null);
    }
  }, [isOpen, initialPassenger, currentService, manifest.signups, compatibleServices]);

  // Load vehicles of the target service whenever targetService changes
  useEffect(() => {
    if (!isOpen || !sessionDate || !targetService) return;

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
  }, [isOpen, sessionDate, targetService]);

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
    if (!targetService) {
      setError('Please select a target service.');
      return;
    }

    setSubmitting(true);
    setError(null);

    const passengerToTransfer = manifest.signups.find((p) => p.id === selectedPassengerId);
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
      sponsorNote: sponsorNote.trim() || 'Unaccounted Sponsorship',
      markPresent: passengerToTransfer?.present ?? false,
      sourceManifest: manifest,
    });

    setSubmitting(false);

    if (!res.success) {
      setError(res.error || 'Failed to transfer passenger.');
      return;
    }

    const pName = passengerToTransfer?.fullName || 'Passenger';
    onSuccess(
      `Successfully moved ${pName} to ${targetServiceDef?.label || targetService} (${targetVehName})${
        isSponsored ? ' as an Unaccounted Sponsorship' : ''
      }.`,
      selectedPassengerId
    );
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-lg rounded-2xl border border-line bg-card shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line px-5 py-4 bg-card-2/60">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-500/15 text-amber-300 border border-amber-500/30">
              <HeartHandshake className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-display text-sm font-bold text-ink">
                Send as Unaccounted Sponsorship
              </h3>
              <p className="text-[11px] text-muted">
                Move a person across service types in the same session
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted hover:bg-card-2 hover:text-ink transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 overflow-y-auto">
          {error && (
            <div className="flex items-center gap-2 rounded-xl border border-crimson-500/30 bg-crimson-900/20 p-3 text-xs text-crimson-300">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* 1. Passenger Selection */}
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted">
              Select Passenger ({manifest.signups.length} total signups in {currentDef?.mode || currentService})
            </label>
            <select
              value={selectedPassengerId}
              onChange={(e) => {
                setSelectedPassengerId(e.target.value);
                const p = manifest.signups.find((item) => item.id === e.target.value);
                if (p?.sponsored || isSponsored) {
                  const fromDef = SERVICE_TYPES.find((s) => s.value === currentService);
                  setSponsorNote(p?.sponsorNote || `Unaccounted Sponsorship (from ${fromDef?.mode || currentService})`);
                }
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
                  Stop: <span className="text-ink">{selectedPassenger.stop}</span> · Structure: <span className="text-ink">{selectedPassenger.structure || '—'}</span>
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

          {/* 2. Source -> Target Service Mapping */}
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

          {/* 3. Destination Vehicle Selection */}
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

          {/* 4. Sponsorship & Notes Settings */}
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3.5 space-y-3">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={isSponsored}
                onChange={(e) => setIsSponsored(e.target.checked)}
                className="h-4 w-4 rounded border-line text-amber-500 focus:ring-amber-400/20 bg-card-2"
              />
              <span className="text-xs font-semibold text-amber-200">
                Mark as Unaccounted Sponsorship
              </span>
            </label>

            {isSponsored && (
              <div>
                <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted">
                  Sponsorship / Destination Note
                </label>
                <input
                  type="text"
                  value={sponsorNote}
                  onChange={(e) => setSponsorNote(e.target.value)}
                  placeholder="e.g. Unaccounted Sponsorship (from PM Serving)"
                  className="input-field py-1.5 text-xs w-full bg-card-2"
                />
                <p className="mt-1 text-[10px] text-muted">
                  Recorded on the destination vehicle roster and transport ledger as an unaccounted sponsorship.
                </p>
              </div>
            )}
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
                <span>Transferring...</span>
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
