import React, { useState, useEffect, useMemo } from 'react';
import {
  Bus, Car, Plus, Trash2, Edit2, X, Shield, RefreshCw,
  Search, Phone, User, MapPin, CheckCircle2, AlertCircle
} from 'lucide-react';
import type { FleetVehicle } from '@/lib/types';
import { listFleetVehicles, saveFleetVehicle, deleteFleetVehicle } from '@/lib/fleet';

interface FleetManagementModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectVehicleForService?: (vehicle: FleetVehicle) => void;
}

export function FleetManagementModal({
  isOpen,
  onClose,
  onSelectVehicleForService,
}: FleetManagementModalProps) {
  const [fleet, setFleet] = useState<FleetVehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'ALL' | 'Bus' | 'Taxi'>('ALL');
  const [editingVehicle, setEditingVehicle] = useState<Partial<FleetVehicle> | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const loadFleet = async () => {
    setLoading(true);
    try {
      const data = await listFleetVehicles();
      setFleet(data);
    } catch (err) {
      console.warn('Failed to load fleet:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadFleet();
    }
  }, [isOpen]);

  const showNotification = (type: 'success' | 'error', text: string) => {
    setNotification({ type, text });
    setTimeout(() => setNotification(null), 3500);
  };

  const filteredFleet = useMemo(() => {
    return fleet.filter((v) => {
      const matchType = typeFilter === 'ALL' || v.type === typeFilter;
      const q = search.trim().toLowerCase();
      const matchSearch =
        !q ||
        v.name.toLowerCase().includes(q) ||
        (v.license_plate && v.license_plate.toLowerCase().includes(q)) ||
        (v.driver_name && v.driver_name.toLowerCase().includes(q)) ||
        (v.default_rep && v.default_rep.toLowerCase().includes(q)) ||
        (v.default_stop && v.default_stop.toLowerCase().includes(q));
      return matchType && matchSearch;
    });
  }, [fleet, search, typeFilter]);

  const taxiCount = fleet.filter((v) => v.type === 'Taxi').length;
  const busCount = fleet.filter((v) => v.type === 'Bus').length;
  const totalCapacity = fleet.reduce((sum, v) => sum + (v.capacity || 0), 0);

  const handleStartAdd = () => {
    setEditingVehicle({
      name: '',
      type: 'Taxi',
      capacity: 15,
      license_plate: '',
      driver_name: '',
      driver_phone: '',
      default_rep: '',
      default_stop: '',
      notes: '',
      is_active: true,
    });
  };

  const handleStartEdit = (v: FleetVehicle) => {
    setEditingVehicle({ ...v });
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingVehicle || !editingVehicle.name?.trim()) return;

    setSaving(true);
    try {
      const saved = await saveFleetVehicle({
        ...editingVehicle,
        name: editingVehicle.name.trim(),
        capacity: Number(editingVehicle.capacity) || (editingVehicle.type === 'Bus' ? 60 : 15),
      });

      setFleet((prev) => {
        const idx = prev.findIndex((v) => v.id === saved.id);
        if (idx !== -1) {
          const next = [...prev];
          next[idx] = saved;
          return next;
        }
        return [...prev, saved];
      });

      setEditingVehicle(null);
      showNotification('success', `Saved vehicle "${saved.name}" to Supabase fleet table`);
    } catch (err) {
      showNotification('error', 'Failed to save vehicle: ' + String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteFleetVehicle(id);
      setFleet((prev) => prev.filter((v) => v.id !== id));
      setConfirmDeleteId(null);
      showNotification('success', 'Vehicle removed from Supabase fleet table');
    } catch (err) {
      showNotification('error', 'Failed to delete vehicle: ' + String(err));
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 sm:p-4 backdrop-blur-xs animate-fade-in">
      <div className="relative flex max-h-[92vh] w-full max-w-4xl flex-col rounded-2xl border border-line bg-card shadow-2xl overflow-hidden">
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-line px-5 py-4 bg-card-2/40">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/15 border border-accent/30 text-accent">
              <Bus className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-display text-lg font-bold text-ink">Fleet Management</h2>
                <span className="badge bg-card-2 text-ink-muted border border-line text-[11px]">
                  Supabase Table: fleet_vehicles
                </span>
              </div>
              <p className="text-xs text-muted">
                Centralized registry of all transport buses and taxis with capacities, drivers, and default routes.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted hover:bg-card-2 hover:text-ink transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Notification banner */}
        {notification && (
          <div
            className={`flex items-center gap-2 px-5 py-2.5 text-xs font-semibold ${
              notification.type === 'success'
                ? 'bg-emerald-500/15 text-emerald-300 border-b border-emerald-500/30'
                : 'bg-crimson-500/15 text-crimson-300 border-b border-crimson-500/30'
            }`}
          >
            {notification.type === 'success' ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
            <span>{notification.text}</span>
          </div>
        )}

        {/* Summary Metric Chips & Filter Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3 bg-card-2/20">
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <span className="badge bg-card-2 text-ink border border-line px-2.5 py-1">
              <strong>{fleet.length}</strong> Total Vehicles
            </span>
            <span className="badge bg-amber-500/15 text-amber-300 border border-amber-500/30 px-2.5 py-1">
              <strong>{taxiCount}</strong> Taxis (15-seaters)
            </span>
            <span className="badge bg-accent/15 text-accent px-2.5 py-1">
              <strong>{busCount}</strong> Buses
            </span>
            <span className="badge bg-card-2 text-muted border border-line px-2.5 py-1">
              Seating Capacity: <strong className="text-ink ml-1">{totalCapacity}</strong>
            </span>
          </div>

          <div className="flex items-center gap-2 ml-auto">
            <button
              onClick={handleStartAdd}
              className="btn-crimson text-xs py-1.5 px-3 flex items-center gap-1.5 shadow-sm"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Add Vehicle to Fleet</span>
            </button>
            <button
              onClick={loadFleet}
              disabled={loading}
              title="Refresh from Supabase"
              className="rounded-lg border border-line bg-card-2 p-1.5 text-muted hover:text-ink transition-colors"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* Search & Type filter */}
        <div className="flex flex-col sm:flex-row items-center gap-2 border-b border-line px-5 py-2.5 bg-card">
          <div className="relative flex-1 w-full">
            <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-muted" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, driver, license plate, or default stop..."
              className="input-field pl-8.5 py-1.5 text-xs w-full"
            />
          </div>

          <div className="flex items-center gap-1 self-stretch sm:self-auto">
            {(['ALL', 'Bus', 'Taxi'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTypeFilter(t)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
                  typeFilter === t
                    ? 'bg-ink text-bg font-bold shadow-xs'
                    : 'bg-card-2 text-muted hover:text-ink'
                }`}
              >
                {t === 'ALL' ? 'All Types' : t === 'Bus' ? 'Buses' : 'Taxis'}
              </button>
            ))}
          </div>
        </div>

        {/* Main Content Area */}
        <div className="flex-1 overflow-y-auto p-5">
          {loading && fleet.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted">
              <RefreshCw className="h-6 w-6 animate-spin mb-2" />
              <p className="text-xs">Loading fleet table from Supabase...</p>
            </div>
          ) : filteredFleet.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Bus className="h-10 w-10 text-muted/50 mb-3" />
              <h3 className="text-sm font-bold text-ink">No Vehicles Found</h3>
              <p className="text-xs text-muted max-w-sm mt-1 mb-4">
                {search ? 'No fleet vehicles match your search filter.' : 'Your fleet table has no vehicles registered yet.'}
              </p>
              <button
                onClick={handleStartAdd}
                className="btn-crimson text-xs py-1.5 px-3 flex items-center gap-1.5"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Add First Vehicle</span>
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
              {filteredFleet.map((v) => (
                <div
                  key={v.id}
                  className="rounded-xl border border-line bg-card p-4 hover:border-line-bright transition-all shadow-xs flex flex-col justify-between"
                >
                  <div>
                    {/* Header line */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <div
                          className={`p-2 rounded-lg ${
                            v.type === 'Bus' ? 'bg-primary/20 text-accent' : 'bg-amber-500/20 text-amber-400'
                          }`}
                        >
                          {v.type === 'Bus' ? <Bus className="h-4 w-4" /> : <Car className="h-4 w-4" />}
                        </div>
                        <div>
                          <h4 className="text-sm font-bold text-ink leading-tight">{v.name}</h4>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-[11px] font-semibold text-muted">{v.type}</span>
                            <span className="text-[11px] text-muted">•</span>
                            <span className="text-[11px] font-mono font-medium text-ink">
                              {v.capacity} seats
                            </span>
                            {v.license_plate && (
                              <>
                                <span className="text-[11px] text-muted">•</span>
                                <span className="text-[10px] font-mono bg-card-2 border border-line px-1.5 py-0.5 rounded text-ink font-semibold">
                                  {v.license_plate}
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleStartEdit(v)}
                          className="rounded-lg p-1 text-muted hover:bg-card-2 hover:text-ink transition-colors"
                          title="Edit vehicle details"
                        >
                          <Edit2 className="h-3.5 w-3.5" />
                        </button>
                        {confirmDeleteId === v.id ? (
                          <div className="flex items-center gap-1 bg-crimson-900/30 p-1 rounded-lg border border-crimson-500/30">
                            <button
                              onClick={() => handleDelete(v.id)}
                              className="px-1.5 py-0.5 rounded bg-crimson-600 text-[10px] font-bold text-white hover:bg-crimson-500"
                            >
                              Delete
                            </button>
                            <button
                              onClick={() => setConfirmDeleteId(null)}
                              className="text-[10px] text-muted hover:text-ink px-1"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setConfirmDeleteId(v.id)}
                            className="rounded-lg p-1 text-muted hover:bg-crimson-900/20 hover:text-crimson-400 transition-colors"
                            title="Delete vehicle from Supabase"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Metadata details */}
                    <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-muted border-t border-line/60 pt-2.5">
                      {v.driver_name && (
                        <div className="flex items-center gap-1.5 truncate">
                          <User className="h-3 w-3 text-muted shrink-0" />
                          <span className="truncate">Driver: <strong className="text-ink">{v.driver_name}</strong></span>
                        </div>
                      )}
                      {v.driver_phone && (
                        <div className="flex items-center gap-1.5 truncate">
                          <Phone className="h-3 w-3 text-muted shrink-0" />
                          <span className="font-mono text-ink truncate">{v.driver_phone}</span>
                        </div>
                      )}
                      {v.default_stop && (
                        <div className="flex items-center gap-1.5 truncate">
                          <MapPin className="h-3 w-3 text-muted shrink-0" />
                          <span className="truncate">Hub: <strong className="text-ink">{v.default_stop}</strong></span>
                        </div>
                      )}
                      {v.default_rep && (
                        <div className="flex items-center gap-1.5 truncate">
                          <Shield className="h-3 w-3 text-muted shrink-0" />
                          <span className="truncate">Rep: <strong className="text-ink">{v.default_rep}</strong></span>
                        </div>
                      )}
                    </div>

                    {v.notes && (
                      <p className="mt-2 text-[11px] text-muted italic bg-card-2/40 rounded p-1.5 border border-line/40">
                        {v.notes}
                      </p>
                    )}
                  </div>

                  {/* Add to Active Service Button (if callback provided) */}
                  {onSelectVehicleForService && (
                    <div className="mt-3 pt-2.5 border-t border-line/60 flex items-center justify-end">
                      <button
                        onClick={() => {
                          onSelectVehicleForService(v);
                          showNotification('success', `Added ${v.name} to active session`);
                        }}
                        className="btn-ghost py-1 px-2.5 text-[11px] font-semibold text-accent hover:text-accent flex items-center gap-1 border border-accent/30 bg-accent/5 hover:bg-accent/10"
                      >
                        <Plus className="h-3 w-3" />
                        <span>Add to Current Session</span>
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Edit / Add Modal Popup Overlay */}
        {editingVehicle && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/80 p-4 animate-fade-in backdrop-blur-xs">
            <div className="w-full max-w-lg rounded-xl border border-line bg-card p-6 shadow-2xl">
              <div className="flex items-center justify-between border-b border-line pb-3 mb-4">
                <h3 className="text-sm font-bold text-ink">
                  {editingVehicle.id ? 'Edit Fleet Vehicle' : 'Add Vehicle to Fleet'}
                </h3>
                <button
                  type="button"
                  onClick={() => setEditingVehicle(null)}
                  className="rounded-lg p-1 text-muted hover:text-ink"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <form onSubmit={handleSave} className="space-y-3.5 text-xs">
                <div>
                  <label className="block font-semibold uppercase tracking-wider text-muted mb-1">
                    Vehicle Name <span className="text-crimson-400">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={editingVehicle.name || ''}
                    onChange={(e) => setEditingVehicle({ ...editingVehicle, name: e.target.value })}
                    placeholder="e.g. Quantum 5, Braam Bus 2"
                    className="input-field w-full text-xs"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block font-semibold uppercase tracking-wider text-muted mb-1">
                      Type
                    </label>
                    <select
                      value={editingVehicle.type || 'Taxi'}
                      onChange={(e) => {
                        const newType = e.target.value as 'Bus' | 'Taxi';
                        setEditingVehicle({
                          ...editingVehicle,
                          type: newType,
                          capacity: newType === 'Bus' ? 60 : 15,
                        });
                      }}
                      className="input-field w-full text-xs"
                    >
                      <option value="Taxi">Taxi (Quantum)</option>
                      <option value="Bus">Bus</option>
                    </select>
                  </div>

                  <div>
                    <label className="block font-semibold uppercase tracking-wider text-muted mb-1">
                      Target Capacity
                    </label>
                    <input
                      type="number"
                      min="1"
                      max="150"
                      value={editingVehicle.capacity || 15}
                      onChange={(e) =>
                        setEditingVehicle({ ...editingVehicle, capacity: parseInt(e.target.value, 10) || 15 })
                      }
                      className="input-field w-full font-mono text-xs"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block font-semibold uppercase tracking-wider text-muted mb-1">
                      License Plate / Reg
                    </label>
                    <input
                      type="text"
                      value={editingVehicle.license_plate || ''}
                      onChange={(e) => setEditingVehicle({ ...editingVehicle, license_plate: e.target.value })}
                      placeholder="e.g. CA 123-456"
                      className="input-field w-full font-mono uppercase text-xs"
                    />
                  </div>

                  <div>
                    <label className="block font-semibold uppercase tracking-wider text-muted mb-1">
                      Default Stop / Hub
                    </label>
                    <input
                      type="text"
                      value={editingVehicle.default_stop || ''}
                      onChange={(e) => setEditingVehicle({ ...editingVehicle, default_stop: e.target.value })}
                      placeholder="e.g. Braamfontein, DFC"
                      className="input-field w-full text-xs"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block font-semibold uppercase tracking-wider text-muted mb-1">
                      Driver Name
                    </label>
                    <input
                      type="text"
                      value={editingVehicle.driver_name || ''}
                      onChange={(e) => setEditingVehicle({ ...editingVehicle, driver_name: e.target.value })}
                      placeholder="Driver full name"
                      className="input-field w-full text-xs"
                    />
                  </div>

                  <div>
                    <label className="block font-semibold uppercase tracking-wider text-muted mb-1">
                      Driver Phone
                    </label>
                    <input
                      type="tel"
                      value={editingVehicle.driver_phone || ''}
                      onChange={(e) => setEditingVehicle({ ...editingVehicle, driver_phone: e.target.value })}
                      placeholder="082 123 4567"
                      className="input-field w-full font-mono text-xs"
                    />
                  </div>
                </div>

                <div>
                  <label className="block font-semibold uppercase tracking-wider text-muted mb-1">
                    Default Assigned Rep
                  </label>
                  <input
                    type="text"
                    value={editingVehicle.default_rep || ''}
                    onChange={(e) => setEditingVehicle({ ...editingVehicle, default_rep: e.target.value })}
                    placeholder="Transport rep name"
                    className="input-field w-full text-xs"
                  />
                </div>

                <div>
                  <label className="block font-semibold uppercase tracking-wider text-muted mb-1">
                    Notes
                  </label>
                  <textarea
                    rows={2}
                    value={editingVehicle.notes || ''}
                    onChange={(e) => setEditingVehicle({ ...editingVehicle, notes: e.target.value })}
                    placeholder="Dispatch or maintenance notes..."
                    className="input-field w-full text-xs"
                  />
                </div>

                <div className="flex items-center justify-end gap-2 pt-3 border-t border-line">
                  <button
                    type="button"
                    onClick={() => setEditingVehicle(null)}
                    className="btn-ghost py-1.5 px-3 text-xs"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={saving || !editingVehicle.name?.trim()}
                    className="btn-crimson py-1.5 px-3 text-xs font-bold"
                  >
                    {saving ? 'Saving...' : 'Save to Supabase Fleet'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
