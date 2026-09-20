import { useState, useEffect, useMemo } from 'react';
import {
  X,
  ArrowRightLeft,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import type { Passenger, Vehicle, ServiceType } from '@/lib/types';
import { SERVICE_TYPES } from '@/lib/types';
import { parseManifestKey } from '@/lib/dates';
import { sortVehiclesNatural } from '@/lib/sort';
import { getServiceVehicles, transferPassengerAcrossServices } from '@/lib/transfer';

interface ChangeServiceModalProps {
  isOpen: boolean;
  onClose: () => void;
  passenger: Passenger | null;
  currentService: ServiceType;
  manifestDate: string;
  onSuccess: (message: string, transferredPassengerId: string) => void;
}

export function ChangeServiceModal({
  isOpen,
  onClose,
  passenger,
  currentService,
  manifestDate,
  onSuccess,
}: ChangeServiceModalProps) {
  const { date: sessionDate } = parseManifestKey(manifestDate);

  const otherServices = useMemo(() => {
    return SERVICE_TYPES.filter((s) => s.value !== currentService);
  }, [currentService]);

  const [targetService, setTargetService] = useState<ServiceType>(
    otherServices[0]?.value || 'PM_Normal'
  );
  const [targetVehicleId, setTargetVehicleId] = useState<string>('unassigned');
  const [targetVehicles, setTargetVehicles] = useState<Vehicle[]>([]);
  const [loadingVehicles, setLoadingVehicles] = useState<boolean>(false);
  const [isSponsored, setIsSponsored] = useState<boolean>(false);
  const [sponsorNote, setSponsorNote] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && otherServices.length > 0) {
      // Pick sensible default (e.g., if currently AM_Normal, offer PM_Normal, etc.)
      const preferred =
        otherServices.find((s) => (currentService.startsWith('AM') ? s.value === 'PM_Normal' : s.value === 'AM_Normal')) ||
        otherServices[0];
      setTargetService(preferred?.value || 'PM_Normal');
      setTargetVehicleId('unassigned');
      setIsSponsored(Boolean(passenger?.sponsored));
      setSponsorNote(passenger?.sponsorNote || '');
      setError(null);
    }
  }, [isOpen, currentService, passenger, otherServices]);

  // Load vehicles for target service
  useEffect(() => {
    if (!isOpen || !sessionDate || !targetService) return;

    let cancelled = false;
    setLoadingVehicles(true);
    setTargetVehicles([]);

    getServiceVehicles(sessionDate, targetService)
      .then((vehicles) => {
        if (!cancelled) {
          setTargetVehicles(sortVehiclesNatural(vehicles));
          setTargetVehicleId('unassigned');
          setLoadingVehicles(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('[ChangeServiceModal] Failed loading target vehicles:', err);
          setLoadingVehicles(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, sessionDate, targetService]);

  if (!isOpen || !passenger) return null;

  const currentServiceDef = SERVICE_TYPES.find((s) => s.value === currentService);
  const targetServiceDef = SERVICE_TYPES.find((s) => s.value === targetService);

  async function handleConfirm() {
    if (!passenger) return;

    setSubmitting(true);
    setError(null);

    try {
      const res = await transferPassengerAcrossServices({
        date: sessionDate,
        fromService: currentService,
        toService: targetService,
        passengerId: passenger.id,
        toVehicleId: targetVehicleId,
        isSponsored,
        sponsorNote: sponsorNote.trim() || undefined,
      });

      if (!res.success) {
        setError(res.error || 'Failed to change service. Please try again.');
        setSubmitting(false);
        return;
      }

      const targetVehObj = targetVehicles.find((v) => v.id === targetVehicleId);
      const destVehName = targetVehicleId === 'unassigned' ? 'Unassigned Pool' : (targetVehObj?.name || 'Vehicle');

      setSubmitting(false);
      onSuccess(
        `✓ Moved ${passenger.fullName} to ${targetServiceDef?.label || targetService} (${destVehName})`,
        passenger.id
      );
      onClose();
    } catch (err) {
      console.error('[ChangeServiceModal] Error during transfer:', err);
      setError(err instanceof Error ? err.message : 'Transfer failed due to a network error.');
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs animate-fade-in">
      <div
        className="w-full max-w-md rounded-2xl border border-line bg-card p-5 shadow-2xl space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line pb-3">
          <div className="flex items-center gap-2">
            <div className="rounded-lg bg-sky-500/15 p-2 text-sky-400 border border-sky-500/30">
              <ArrowRightLeft className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-ink">Change Passenger Service</h3>
              <p className="text-xs text-muted">Move to a different Sunday service</p>
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

        {/* Passenger Summary Box */}
        <div className="rounded-xl border border-line/60 bg-bg/50 p-3 text-xs space-y-1">
          <div className="flex items-center justify-between">
            <span className="font-bold text-ink text-sm">{passenger.fullName}</span>
            {passenger.structure && (
              <span className="badge bg-crimson-500/15 text-crimson-300 font-mono">
                {passenger.structure}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 text-muted">
            <span>Stop: <strong className="text-ink">{passenger.stop || 'Unassigned'}</strong></span>
            <span>·</span>
            <span>Current: <strong className="text-sky-400">{currentServiceDef?.label || currentService}</strong></span>
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 rounded-xl border border-crimson-500/40 bg-crimson-500/10 p-3 text-xs text-crimson-300">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Form Fields */}
        <div className="space-y-3 text-xs">
          {/* Target Service */}
          <div>
            <label className="mb-1 block font-semibold text-muted uppercase text-[10px] tracking-wide">
              Destination Service
            </label>
            <select
              value={targetService}
              onChange={(e) => setTargetService(e.target.value as ServiceType)}
              className="input-field py-2 text-xs w-full bg-card-2 font-medium"
            >
              {otherServices.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label} ({s.period})
                </option>
              ))}
            </select>
          </div>

          {/* Target Vehicle */}
          <div>
            <label className="mb-1 block font-semibold text-muted uppercase text-[10px] tracking-wide">
              Vehicle Allocation in Destination Service
            </label>
            {loadingVehicles ? (
              <div className="flex items-center gap-2 py-2 text-muted">
                <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
                <span>Loading available vehicles...</span>
              </div>
            ) : (
              <select
                value={targetVehicleId}
                onChange={(e) => setTargetVehicleId(e.target.value)}
                className="input-field py-2 text-xs w-full bg-card-2"
              >
                <option value="unassigned">⏳ Unassigned Pool (Wait for allocation)</option>
                {targetVehicles.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.type === 'Bus' ? '🚌' : '🚕'} {v.name} ({v.riders?.length || 0} riders)
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Optional: Sponsorship Toggle */}
          <div className="rounded-xl border border-line/60 bg-card-2/40 p-3 space-y-2">
            <label className="flex items-center gap-2 cursor-pointer font-medium text-ink">
              <input
                type="checkbox"
                checked={isSponsored}
                onChange={(e) => setIsSponsored(e.target.checked)}
                className="rounded border-line text-crimson-500 focus:ring-crimson-400"
              />
              <span>Mark as Sponsored in new service</span>
            </label>
            {isSponsored && (
              <input
                type="text"
                value={sponsorNote}
                onChange={(e) => setSponsorNote(e.target.value)}
                placeholder="Optional sponsorship note (e.g. S9 structure sponsorship)"
                className="input-field py-1.5 text-xs w-full"
              />
            )}
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center justify-end gap-2 border-t border-line pt-3">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="btn-ghost py-2 px-3 text-xs"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={submitting}
            className="btn-primary py-2 px-4 text-xs font-semibold flex items-center gap-1.5 shadow-sm"
          >
            {submitting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Moving...</span>
              </>
            ) : (
              <>
                <ArrowRightLeft className="h-3.5 w-3.5" />
                <span>Confirm Service Change</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
