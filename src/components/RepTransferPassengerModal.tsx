import React, { useState } from 'react';
import { ArrowRightLeft, Check, Loader2, X, AlertCircle, Users, Car, Bus } from 'lucide-react';
import type { Passenger, Vehicle } from '@/lib/types';
import { hubDisplayName } from '@/lib/types';

interface RepTransferPassengerModalProps {
  isOpen: boolean;
  passenger: Passenger | null;
  currentVehicle: Vehicle | null;
  allVehicles: Vehicle[];
  onClose: () => void;
  onTransfer: (
    passenger: Passenger,
    targetVehicleId: string,
    markPresent: boolean,
    transferNote?: string
  ) => Promise<void>;
}

export function RepTransferPassengerModal({
  isOpen,
  passenger,
  currentVehicle,
  allVehicles,
  onClose,
  onTransfer,
}: RepTransferPassengerModalProps) {
  const [selectedTargetId, setSelectedTargetId] = useState<string>('');
  const [markPresent, setMarkPresent] = useState<boolean>(true);
  const [note, setNote] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen || !passenger) return null;

  const currentVehId = currentVehicle?.id || '';
  const availableVehicles = allVehicles.filter((v) => v.id !== currentVehId);

  async function handleConfirm() {
    if (!passenger) return;
    if (!selectedTargetId) {
      setError('Please select a destination vehicle or choose the unassigned pool.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await onTransfer(passenger, selectedTargetId, markPresent, note.trim() || undefined);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to transfer passenger. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const pStop = passenger.stop ? hubDisplayName('Taxi', passenger.stop) : 'Scheduled Stop';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm animate-fade-in">
      <div
        className="w-full max-w-lg rounded-2xl border border-line bg-card shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line px-5 py-4 bg-card-2/60">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-400">
              <ArrowRightLeft className="h-4.5 w-4.5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-ink">Move Passenger to Another Vehicle</h2>
              <p className="text-xs text-muted">
                Intentionally reallocate to another vehicle without ledger penalty
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg p-1.5 text-muted hover:bg-card-2 hover:text-ink transition-colors disabled:opacity-50"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto space-y-4">
          {error && (
            <div className="rounded-xl border border-crimson-500/40 bg-crimson-500/10 p-3 text-xs text-crimson-300 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 text-crimson-400 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {/* Passenger Details Card */}
          <div className="rounded-xl border border-line bg-card-2/70 p-3.5 space-y-2">
            <div className="flex items-start justify-between">
              <div>
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">Passenger</span>
                <h3 className="text-base font-bold text-ink flex items-center gap-2">
                  {passenger.fullName}
                  {passenger.structure && (
                    <span className="inline-flex items-center rounded-md bg-crimson-900/40 px-2 py-0.5 font-mono text-xs font-semibold text-crimson-300 border border-crimson-700/50">
                      {passenger.structure}
                    </span>
                  )}
                </h3>
              </div>
              <div className="text-right">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">Currently In</span>
                <div className="text-xs font-semibold text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-md px-2 py-0.5 mt-0.5">
                  {currentVehicle?.name || 'Current Vehicle'}
                </div>
              </div>
            </div>

            <div className="text-xs text-muted flex items-center gap-2 pt-1 border-t border-line/40">
              <span>📍 {pStop}</span>
              {passenger.notes && <span className="text-[11px] text-muted/80">• Note: {passenger.notes}</span>}
            </div>
          </div>

          {/* Reassurance Banner */}
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-200 flex items-start gap-2.5">
            <Check className="h-4 w-4 shrink-0 text-emerald-400 mt-0.5" />
            <div className="leading-relaxed">
              <strong>Zero Ledger Debt:</strong> When intentionally moving this passenger to another vehicle, they will <strong>NOT</strong> be recorded as an absentee or debt on the cancellation ledger.
            </div>
          </div>

          {/* Target Vehicle Selection */}
          <div className="space-y-2">
            <label className="block text-xs font-bold text-ink flex items-center justify-between">
              <span>Select Destination Vehicle:</span>
              <span className="text-[11px] font-normal text-muted">
                {availableVehicles.length} other vehicle(s) available
              </span>
            </label>

            <div className="grid grid-cols-1 gap-2 max-h-52 overflow-y-auto pr-1">
              {availableVehicles.map((v) => {
                const isSelected = selectedTargetId === v.id;
                const riderCount = (v.riders || []).length;
                const capacity = v.capacity || 15;
                const isFull = riderCount >= capacity;
                const IconComponent = v.type === 'Bus' ? Bus : Car;

                return (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => {
                      setSelectedTargetId(v.id);
                      setError(null);
                    }}
                    className={`flex items-center justify-between p-3 rounded-xl border text-left transition-all ${
                      isSelected
                        ? 'border-amber-500 bg-amber-500/15 shadow-sm ring-1 ring-amber-500/40'
                        : 'border-line bg-card-2/40 hover:bg-card-2 hover:border-line-bright'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className={`flex h-8 w-8 items-center justify-center rounded-lg border ${
                          isSelected
                            ? 'bg-amber-500/25 border-amber-500/50 text-amber-300'
                            : 'bg-card border-line text-muted'
                        }`}
                      >
                        <IconComponent className="h-4 w-4" />
                      </div>
                      <div>
                        <div className="text-xs font-bold text-ink flex items-center gap-1.5">
                          {v.name}
                          {v.submitted && (
                            <span className="text-[10px] text-emerald-400 font-normal font-mono bg-emerald-500/10 px-1.5 py-0.2 rounded border border-emerald-500/30">
                              submitted
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-muted">
                          {v.driverName ? `Driver: ${v.driverName}` : `${v.type || 'Taxi'}`}
                          {v.licensePlate ? ` • ${v.licensePlate}` : ''}
                        </div>
                      </div>
                    </div>

                    <div className="text-right">
                      <div
                        className={`text-xs font-mono font-semibold ${
                          isFull ? 'text-amber-400' : 'text-muted'
                        }`}
                      >
                        {riderCount} / {capacity}
                      </div>
                      <span className="text-[10px] text-muted">seats filled</span>
                    </div>
                  </button>
                );
              })}

              {/* Unassigned Pool Option */}
              <button
                type="button"
                onClick={() => {
                  setSelectedTargetId('unassigned');
                  setError(null);
                }}
                className={`flex items-center justify-between p-3 rounded-xl border text-left transition-all ${
                  selectedTargetId === 'unassigned'
                    ? 'border-amber-500 bg-amber-500/15 shadow-sm ring-1 ring-amber-500/40'
                    : 'border-dashed border-line bg-card-2/20 hover:bg-card-2/50'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`flex h-8 w-8 items-center justify-center rounded-lg border ${
                      selectedTargetId === 'unassigned'
                        ? 'bg-amber-500/25 border-amber-500/50 text-amber-300'
                        : 'bg-card border-line text-muted'
                    }`}
                  >
                    <Users className="h-4 w-4" />
                  </div>
                  <div>
                    <div className="text-xs font-bold text-ink">⏳ Move to Unassigned Pool</div>
                    <div className="text-[11px] text-muted">
                      Remove from this vehicle without allocating to another taxi yet
                    </div>
                  </div>
                </div>
              </button>
            </div>
          </div>

          {/* Options */}
          {selectedTargetId !== 'unassigned' && (
            <div className="pt-1">
              <label className="flex items-center gap-2 cursor-pointer select-none text-xs text-ink">
                <input
                  type="checkbox"
                  checked={markPresent}
                  onChange={(e) => setMarkPresent(e.target.checked)}
                  className="rounded border-line bg-card-2 text-crimson-500 focus:ring-crimson-500/30 h-4 w-4 cursor-pointer"
                />
                <span>
                  Mark as <strong>Present</strong> in destination vehicle (recommended)
                </span>
              </label>
            </div>
          )}

          {/* Transfer Note (Optional) */}
          <div className="space-y-1">
            <label className="block text-[11px] font-semibold text-muted">
              Transfer Note (optional)
            </label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Moved due to capacity, requested Taxi 2"
              className="input-field text-xs w-full"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2.5 border-t border-line px-5 py-3.5 bg-card-2/50">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="btn-secondary text-xs px-4 py-2"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={submitting || !selectedTargetId}
            className="btn-crimson text-xs font-bold px-4 py-2 flex items-center gap-1.5 disabled:opacity-40"
          >
            {submitting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Transferring…</span>
              </>
            ) : (
              <>
                <ArrowRightLeft className="h-3.5 w-3.5" />
                <span>Confirm Transfer</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
