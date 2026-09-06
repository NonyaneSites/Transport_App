import { useState } from 'react';
import { X, Bus, Car, Save, Trash2, AlertCircle } from 'lucide-react';
import type { Vehicle } from '@/lib/types';

interface EditVehicleModalProps {
  vehicle: Vehicle;
  onSave: (vehicleId: string, updates: Partial<Vehicle>) => void;
  onClose: () => void;
  onDelete?: (vehicleId: string) => void;
}

export function EditVehicleModal({ vehicle, onSave, onClose, onDelete }: EditVehicleModalProps) {
  const [name, setName] = useState(vehicle.name || '');
  const [type, setType] = useState<'Bus' | 'Taxi'>(vehicle.type || 'Bus');
  const [licensePlate, setLicensePlate] = useState(vehicle.licensePlate || '');
  const [driverName, setDriverName] = useState(vehicle.driverName || '');
  const [driverPhone, setDriverPhone] = useState(vehicle.driverPhone || '');
  const [capacity, setCapacity] = useState<string>(
    vehicle.capacity ? String(vehicle.capacity) : (vehicle.type === 'Taxi' ? '15' : '60')
  );
  const [repName, setRepName] = useState(vehicle.repName || '');
  const [generalNotes, setGeneralNotes] = useState(vehicle.generalNotes || '');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = name.trim();
    if (!cleanName) return;

    const parsedCap = parseInt(capacity, 10);
    const updates: Partial<Vehicle> = {
      name: cleanName,
      type,
      licensePlate: licensePlate.trim() || undefined,
      driverName: driverName.trim() || undefined,
      driverPhone: driverPhone.trim() || undefined,
      capacity: !isNaN(parsedCap) && parsedCap > 0 ? parsedCap : (type === 'Taxi' ? 15 : 60),
      repName: repName.trim() || undefined,
      generalNotes: generalNotes.trim() || undefined,
    };

    onSave(vehicle.id, updates);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 animate-fade-in">
      <div className="relative w-full max-w-lg rounded-2xl border border-line bg-card p-6 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line pb-4">
          <div className="flex items-center gap-2.5">
            <div className={`p-2 rounded-xl ${type === 'Bus' ? 'bg-primary/20 text-accent' : 'bg-amber-500/20 text-amber-400'}`}>
              {type === 'Bus' ? <Bus className="h-5 w-5" /> : <Car className="h-5 w-5" />}
            </div>
            <div>
              <h2 className="text-lg font-bold text-ink">Edit Vehicle</h2>
              <p className="text-xs text-muted">Update details, type, plate, or capacity</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted hover:bg-bg hover:text-ink transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          {/* Vehicle Name */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-muted mb-1.5">
              Vehicle Name <span className="text-crimson-400">*</span>
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Soweto Express 1, Braamfontein Taxi 2"
              className="input-field w-full"
            />
          </div>

          {/* Type & Capacity */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-muted mb-1.5">
                Vehicle Type
              </label>
              <div className="flex rounded-xl border border-line bg-bg p-1">
                <button
                  type="button"
                  onClick={() => {
                    setType('Bus');
                    if (!vehicle.capacity || capacity === '15') setCapacity('60');
                  }}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-bold transition-all ${
                    type === 'Bus'
                      ? 'bg-accent text-white shadow-xs'
                      : 'text-muted hover:text-ink'
                  }`}
                >
                  <Bus className="h-3.5 w-3.5" />
                  <span>Bus</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setType('Taxi');
                    if (!vehicle.capacity || capacity === '60') setCapacity('15');
                  }}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-bold transition-all ${
                    type === 'Taxi'
                      ? 'bg-amber-600 text-white shadow-xs'
                      : 'text-muted hover:text-ink'
                  }`}
                >
                  <Car className="h-3.5 w-3.5" />
                  <span>Taxi</span>
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-muted mb-1.5">
                Target Capacity
              </label>
              <input
                type="number"
                min="1"
                max="150"
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
                placeholder={type === 'Bus' ? '60' : '15'}
                className="input-field w-full font-mono"
              />
            </div>
          </div>

          {/* License Plate & Transport Rep */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-muted mb-1.5">
                License Plate / Reg
              </label>
              <input
                type="text"
                value={licensePlate}
                onChange={(e) => setLicensePlate(e.target.value)}
                placeholder="e.g. AB 12 CD GP"
                className="input-field w-full font-mono uppercase"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-muted mb-1.5">
                Transport Rep
              </label>
              <input
                type="text"
                value={repName}
                onChange={(e) => setRepName(e.target.value)}
                placeholder="Rep full name"
                className="input-field w-full"
              />
            </div>
          </div>

          {/* Driver Name & Phone */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-muted mb-1.5">
                Driver Name
              </label>
              <input
                type="text"
                value={driverName}
                onChange={(e) => setDriverName(e.target.value)}
                placeholder="Driver full name"
                className="input-field w-full"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-muted mb-1.5">
                Driver Phone
              </label>
              <input
                type="tel"
                value={driverPhone}
                onChange={(e) => setDriverPhone(e.target.value)}
                placeholder="e.g. 082 123 4567"
                className="input-field w-full font-mono"
              />
            </div>
          </div>

          {/* General Notes */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-muted mb-1.5">
              General / Dispatch Notes
            </label>
            <textarea
              rows={2}
              value={generalNotes}
              onChange={(e) => setGeneralNotes(e.target.value)}
              placeholder="Instructions for driver or passengers..."
              className="input-field w-full text-xs"
            />
          </div>

          {/* Actions & Delete Confirmation */}
          <div className="pt-3 border-t border-line flex items-center justify-between gap-3">
            {onDelete && (
              <div>
                {!confirmDelete ? (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    className="inline-flex items-center gap-1.5 text-xs text-crimson-400 hover:text-crimson-300 font-medium py-2 px-2.5 rounded-lg hover:bg-crimson-900/20 transition-colors"
                  >
                    <Trash2 className="h-4 w-4" />
                    <span>Delete Vehicle</span>
                  </button>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-crimson-300 font-semibold flex items-center gap-1">
                      <AlertCircle className="h-3.5 w-3.5" /> Confirm?
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        onDelete(vehicle.id);
                        onClose();
                      }}
                      className="px-2.5 py-1 text-xs font-bold rounded-lg bg-crimson-600 text-white hover:bg-crimson-500 shadow-xs transition-all"
                    >
                      Yes, Delete
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(false)}
                      className="px-2 py-1 text-xs text-muted hover:text-ink transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center gap-2 ml-auto">
              <button
                type="button"
                onClick={onClose}
                className="btn-ghost py-2 px-4 text-xs"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn-crimson py-2 px-4 text-xs font-bold inline-flex items-center gap-1.5 shadow-sm"
              >
                <Save className="h-4 w-4" />
                <span>Save Changes</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
