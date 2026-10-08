import { useState, useEffect, useMemo } from 'react';
import { X, MapPin, Check, Plus } from 'lucide-react';
import type { Passenger } from '@/lib/types';
import { ROUTE_SEQUENCE } from '@/lib/types';
import { allowedLegsUpgrades } from '@/lib/rehearsal';

interface ChangeStopModalProps {
  isOpen: boolean;
  onClose: () => void;
  passenger: Passenger | null;
  existingStops?: string[];
  isRehearsal?: boolean;
  onConfirm: (passengerId: string, newStop: string, newLegs?: 'both' | 'going' | 'return') => void;
}

export function ChangeStopModal({
  isOpen,
  onClose,
  passenger,
  existingStops = [],
  isRehearsal,
  onConfirm,
}: ChangeStopModalProps) {
  const [selectedStop, setSelectedStop] = useState('');
  const [customStop, setCustomStop] = useState('');
  const [useCustom, setUseCustom] = useState(false);
  const [selectedLegs, setSelectedLegs] = useState<'both' | 'going' | 'return'>('both');

  // Combine unique stops from canonical sequence and existing manifest
  const combinedStops = useMemo(() => {
    return Array.from(
      new Set([
        'DFC bus stop',
        'YMCA',
        'Gate 7',
        'Braam',
        'EOH',
        'Solomon Mahlangu',
        'Campus Central on empire',
        'Saratoga',
        'Argyle',
        'Junction',
        'Knockando',
        'Education Campus',
        'Charlotte Maxeke',
        'Amic Deck - David Webster',
        'Barnato',
        'UJ Bunting',
        'Richmond',
        'Ghandi Square',
        'Maboneng',
        'Urban Circle',
        'The Fields',
        ...existingStops,
        ...ROUTE_SEQUENCE,
      ])
    ).filter(Boolean);
  }, [existingStops]);

  useEffect(() => {
    if (isOpen && passenger) {
      setSelectedStop(passenger.stop || combinedStops[0] || 'DFC bus stop');
      setCustomStop('');
      setUseCustom(false);
      setSelectedLegs(passenger.legs || 'both');
    }
  }, [isOpen, passenger, combinedStops]);

  if (!isOpen || !passenger) return null;

  const handleSave = () => {
    const finalStop = (useCustom ? customStop : selectedStop).trim();
    if (!finalStop) return;
    onConfirm(passenger.id, finalStop, isRehearsal ? selectedLegs : passenger.legs);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs animate-fade-in">
      <div
        className="w-full max-w-sm rounded-2xl border border-line bg-card p-5 shadow-2xl space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line pb-3">
          <div className="flex items-center gap-2">
            <div className="rounded-lg bg-crimson-500/15 p-2 text-crimson-400 border border-crimson-500/30">
              <MapPin className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-ink">Change Pickup Stop</h3>
              <p className="text-xs text-muted truncate max-w-[200px]">{passenger.fullName}</p>
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

        {/* Current Stop Banner */}
        <div className="rounded-xl border border-line/60 bg-bg/50 p-2.5 text-xs flex items-center justify-between">
          <span className="text-muted">Current Stop:</span>
          <span className="font-bold text-ink">{passenger.stop || 'Unassigned'}</span>
        </div>

        {/* Selection mode */}
        <div className="space-y-3 text-xs">
          {!useCustom ? (
            <div>
              <label className="mb-1 block font-semibold text-muted uppercase text-[10px] tracking-wide">
                Select Standard Stop / Hub
              </label>
              <select
                value={selectedStop}
                onChange={(e) => setSelectedStop(e.target.value)}
                className="input-field py-2 text-xs w-full bg-card-2 font-medium"
              >
                {combinedStops.map((stop) => (
                  <option key={stop} value={stop}>
                    {stop}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setUseCustom(true)}
                className="mt-2 inline-flex items-center gap-1 text-[11px] text-crimson-400 hover:text-crimson-300 font-medium"
              >
                <Plus className="h-3 w-3" />
                <span>Enter custom stop name instead</span>
              </button>
            </div>
          ) : (
            <div>
              <label className="mb-1 block font-semibold text-muted uppercase text-[10px] tracking-wide">
                Custom Stop Name
              </label>
              <input
                type="text"
                value={customStop}
                onChange={(e) => setCustomStop(e.target.value)}
                placeholder="e.g. 100 Juta Street, Auckland Park Gate 3"
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && handleSave()}
                className="input-field py-2 text-xs w-full"
              />
              <button
                type="button"
                onClick={() => setUseCustom(false)}
                className="mt-2 inline-flex items-center gap-1 text-[11px] text-sky-400 hover:text-sky-300 font-medium"
              >
                ← Back to standard stops list
              </button>
            </div>
          )}

          {/* Rehearsal Legs Selection */}
          {isRehearsal && (() => {
            const allowedLegs = allowedLegsUpgrades(passenger.legs);
            return (
              <div className="pt-2 border-t border-line/60">
                <label className="mb-1 block font-semibold text-muted uppercase text-[10px] tracking-wide">
                  Rehearsal Transport Legs / Fare
                </label>
                <div className="grid grid-cols-3 gap-1.5">
                  <button
                    type="button"
                    onClick={() => setSelectedLegs('both')}
                    className={`py-1.5 px-2 rounded-lg text-xs font-semibold border transition-all ${
                      selectedLegs === 'both'
                        ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50 ring-1 ring-emerald-500/40'
                        : 'bg-card-2 text-muted border-line hover:text-ink'
                    }`}
                  >
                    Both (R70)
                  </button>
                  <button
                    type="button"
                    disabled={!allowedLegs.includes('going')}
                    onClick={() => setSelectedLegs('going')}
                    className={`py-1.5 px-2 rounded-lg text-xs font-semibold border transition-all ${
                      !allowedLegs.includes('going')
                        ? 'opacity-40 cursor-not-allowed bg-card-2/40 text-muted/60 border-line/40'
                        : selectedLegs === 'going'
                        ? 'bg-sky-500/20 text-sky-300 border-sky-500/50 ring-1 ring-sky-500/40'
                        : 'bg-card-2 text-muted border-line hover:text-ink'
                    }`}
                  >
                    Going (R40)
                  </button>
                  <button
                    type="button"
                    disabled={!allowedLegs.includes('return')}
                    onClick={() => setSelectedLegs('return')}
                    className={`py-1.5 px-2 rounded-lg text-xs font-semibold border transition-all ${
                      !allowedLegs.includes('return')
                        ? 'opacity-40 cursor-not-allowed bg-card-2/40 text-muted/60 border-line/40'
                        : selectedLegs === 'return'
                        ? 'bg-sky-500/20 text-sky-300 border-sky-500/50 ring-1 ring-sky-500/40'
                        : 'bg-card-2 text-muted border-line hover:text-ink'
                    }`}
                  >
                    Return (R40)
                  </button>
                </div>
                <p className="mt-1.5 text-[10px] text-amber-300/90 font-medium">
                  Legs can only be upgraded to Going & Return
                </p>
              </div>
            );
          })()}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-line pt-3">
          <button
            type="button"
            onClick={onClose}
            className="btn-ghost py-1.5 px-3 text-xs"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={useCustom ? !customStop.trim() : !selectedStop.trim()}
            className="btn-crimson py-1.5 px-3 text-xs font-semibold flex items-center gap-1.5 shadow-sm disabled:opacity-40"
          >
            <Check className="h-3.5 w-3.5" />
            <span>Update Stop</span>
          </button>
        </div>
      </div>
    </div>
  );
}
