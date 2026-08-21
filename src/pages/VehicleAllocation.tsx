import { useState } from 'react';
import { Bus, Car, Plus, Trash2, Users, ArrowRight, Undo2, X, UserCog, MoveRight, CheckCircle2, ChevronDown, ChevronRight, MapPin, MessageCircle, Check, Clock, StickyNote, ArrowUp, ArrowDown } from 'lucide-react';
import type { Manifest, Passenger, Vehicle, ServiceType } from '@/lib/types';
import { hubDisplayName, sortByRouteSequence, SERVICE_TYPES } from '@/lib/types';
import { sortVehiclesNatural } from '@/lib/sort';
import { passengersByStop, passengersByPoolGroup, unassignedPassengers, allocateSubStopsIntact } from '@/lib/manifest';
import { parseManifestKey, shortDate } from '@/lib/dates';
import { detectVehicleRep } from '@/lib/officialReps';

interface Props {
  manifest: Manifest;
  serviceLabel: string;
  service: ServiceType;
  onSave: (m: Manifest) => Promise<void>;
}

export function VehicleAllocation({ manifest, serviceLabel, service, onSave }: Props) {
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<'Bus' | 'Taxi'>('Bus');
  const [selectedPoolKey, setSelectedPoolKey] = useState('');
  const [assignQty, setAssignQty] = useState('');
  const [expandedVehicle, setExpandedVehicle] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [moveFromVehicle, setMoveFromVehicle] = useState<string>('');
  const [movePassengerId, setMovePassengerId] = useState<string>('');
  const [moveToVehicle, setMoveToVehicle] = useState<string>('');
  const [showSubmitted, setShowSubmitted] = useState(false);
  const [highlightRep, setHighlightRep] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const unassigned = unassignedPassengers(manifest);

  const stopsMap = passengersByStop(unassigned);
  const stopNames = sortByRouteSequence(
    Object.keys(stopsMap).filter((s) => stopsMap[s].length > 0),
    (s) => s
  );

  const sortedVehicles = sortVehiclesNatural(manifest.vehicles);
  const submittedVehicles = sortVehiclesNatural(manifest.vehicles.filter((v) => v.submitted));

  function poolForVehicleType(vehicleType: 'Bus' | 'Taxi'): { key: string; count: number }[] {
    const map = passengersByPoolGroup(unassigned, vehicleType);
    const keys = sortByRouteSequence(
      Object.keys(map).filter((k) => map[k].length > 0),
      (k) => k
    );
    return keys.map((k) => ({ key: k, count: map[k].length }));
  }

  function ridersGroupedByHub(vehicle: Vehicle): { label: string; riders: Passenger[] }[] {
    const riders = riderPassengers(vehicle);
    const groups: Record<string, Passenger[]> = {};
    for (const r of riders) {
      const label = hubDisplayName(vehicle.type, r.stop);
      if (!groups[label]) groups[label] = [];
      groups[label].push(r);
    }
    const order = vehicle.orderedStops ?? [];
    const orderedLabels = order.filter((l) => groups[l]);
    const extraLabels = Object.keys(groups)
      .filter((l) => !orderedLabels.includes(l))
      .sort((a, b) => groups[b].length - groups[a].length);
    return [...orderedLabels, ...extraLabels].map((label) => ({ label, riders: groups[label] }));
  }

  async function addVehicle() {
    if (!newName.trim()) return;
    const vehicle: Vehicle = {
      id: `veh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: newName.trim(),
      type: newType,
      riders: [],
      orderedStops: [],
    };
    await onSave({ ...manifest, vehicles: [...manifest.vehicles, vehicle] });
    setNewName('');
  }

  async function removeVehicle(vehicleId: string) {
    const vehicle = manifest.vehicles.find((v) => v.id === vehicleId);
    if (!vehicle) return;
    const updatedSignups = manifest.signups.map((p) =>
      vehicle.riders.includes(p.id) ? { ...p, assignedTo: null } : p
    );
    const updatedVehicles = manifest.vehicles.filter((v) => v.id !== vehicleId);
    await onSave({ ...manifest, signups: updatedSignups, vehicles: updatedVehicles });
  }

  async function assignToVehicle(vehicleId: string, poolKey: string, qty: number | 'all') {
    const vehicle = manifest.vehicles.find((v) => v.id === vehicleId);
    if (!vehicle || !poolKey) return;

    const pool = unassigned.filter((p) => hubDisplayName(vehicle.type, p.stop) === poolKey);
    const requestedCount = qty === 'all' ? pool.length : Math.min(qty, pool.length);
    if (requestedCount <= 0) return;

    // Apply Atomic Sub-Stop Grouping Allocation
    const { allocated: toAssign } = allocateSubStopsIntact(pool, requestedCount);
    if (toAssign.length === 0) return;

    const updatedSignups = manifest.signups.map((p) => {
      const match = toAssign.find((t) => t.id === p.id);
      if (match) return { ...p, assignedTo: vehicleId };
      return p;
    });

    const updatedVehicles = manifest.vehicles.map((v) => {
      if (v.id !== vehicleId) return v;
      const orderedStops = v.orderedStops ?? [];
      const nextOrderedStops = orderedStops.includes(poolKey) ? orderedStops : [...orderedStops, poolKey];
      const newRiderIds = [...v.riders, ...toAssign.map((p) => p.id)];
      const allRiders = newRiderIds.map((id) => updatedSignups.find((s) => s.id === id)).filter(Boolean) as Passenger[];

      // Auto-detect official structure rep if none explicitly set
      const autoRep = !v.repName ? detectVehicleRep(allRiders) : v.repName;

      return {
        ...v,
        riders: newRiderIds,
        orderedStops: nextOrderedStops,
        repName: autoRep ?? v.repName,
      };
    });

    await onSave({ ...manifest, signups: updatedSignups, vehicles: updatedVehicles });
    setSelectedPoolKey('');
    setAssignQty('');
  }

  async function unassignRider(vehicleId: string, passengerId: string) {
    const updatedSignups = manifest.signups.map((p) =>
      p.id === passengerId ? { ...p, assignedTo: null } : p
    );
    const updatedVehicles = manifest.vehicles.map((v) =>
      v.id === vehicleId ? { ...v, riders: v.riders.filter((id) => id !== passengerId) } : v
    );
    await onSave({ ...manifest, signups: updatedSignups, vehicles: updatedVehicles });
  }

  async function unassignAllFromVehicle(vehicleId: string) {
    const vehicle = manifest.vehicles.find((v) => v.id === vehicleId);
    if (!vehicle || vehicle.riders.length === 0) return;
    const updatedSignups = manifest.signups.map((p) =>
      vehicle.riders.includes(p.id) ? { ...p, assignedTo: null } : p
    );
    const updatedVehicles = manifest.vehicles.map((v) =>
      v.id === vehicleId ? { ...v, riders: [], orderedStops: [] } : v
    );
    await onSave({ ...manifest, signups: updatedSignups, vehicles: updatedVehicles });
  }

  async function setRepName(vehicleId: string, repName: string) {
    const updatedVehicles = manifest.vehicles.map((v) =>
      v.id === vehicleId ? { ...v, repName } : v
    );
    await onSave({ ...manifest, vehicles: updatedVehicles });
  }

  async function setStopTime(vehicleId: string, label: string, time: string) {
    const updatedVehicles = manifest.vehicles.map((v) =>
      v.id === vehicleId ? { ...v, stopTimes: { ...(v.stopTimes ?? {}), [label]: time } } : v
    );
    await onSave({ ...manifest, vehicles: updatedVehicles });
  }

  async function setVehicleNote(vehicleId: string, note: string) {
    const updatedVehicles = manifest.vehicles.map((v) =>
      v.id === vehicleId ? { ...v, generalNotes: note } : v
    );
    await onSave({ ...manifest, vehicles: updatedVehicles });
  }

  /**
   * Manual Route Shift Controls for vehicle.orderedStops
   */
  async function moveStopOrder(vehicleId: string, stopLabel: string, direction: 'up' | 'down') {
    const vehicle = manifest.vehicles.find((v) => v.id === vehicleId);
    if (!vehicle) return;

    const currentOrder = ridersGroupedByHub(vehicle).map((g) => g.label);
    const idx = currentOrder.indexOf(stopLabel);
    if (idx === -1) return;

    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= currentOrder.length) return;

    const newOrder = [...currentOrder];
    const [moved] = newOrder.splice(idx, 1);
    newOrder.splice(targetIdx, 0, moved);

    const updatedVehicles = manifest.vehicles.map((v) =>
      v.id === vehicleId ? { ...v, orderedStops: newOrder } : v
    );
    await onSave({ ...manifest, vehicles: updatedVehicles });
  }

  async function movePassenger(passengerId: string, fromVehicleId: string, toVehicleId: string) {
    if (!passengerId || !toVehicleId || fromVehicleId === toVehicleId) return;
    const toVehicle = manifest.vehicles.find((v) => v.id === toVehicleId);
    const passenger = manifest.signups.find((p) => p.id === passengerId);
    if (!toVehicle || !passenger) return;
    const poolKey = hubDisplayName(toVehicle.type, passenger.stop);

    const updatedSignups = manifest.signups.map((p) =>
      p.id === passengerId ? { ...p, assignedTo: toVehicleId } : p
    );
    const updatedVehicles = manifest.vehicles.map((v) => {
      if (v.id === fromVehicleId) {
        return { ...v, riders: v.riders.filter((id) => id !== passengerId) };
      }
      if (v.id === toVehicleId) {
        const orderedStops = v.orderedStops ?? [];
        const nextOrderedStops = orderedStops.includes(poolKey) ? orderedStops : [...orderedStops, poolKey];
        const newRiderIds = [...v.riders, passengerId];
        const allRiders = newRiderIds.map((id) => updatedSignups.find((s) => s.id === id)).filter(Boolean) as Passenger[];
        const autoRep = !v.repName ? detectVehicleRep(allRiders) : v.repName;
        return { ...v, riders: newRiderIds, orderedStops: nextOrderedStops, repName: autoRep ?? v.repName };
      }
      return v;
    });
    await onSave({ ...manifest, signups: updatedSignups, vehicles: updatedVehicles });
    setMoveFromVehicle('');
    setMovePassengerId('');
    setMoveToVehicle('');
  }

  function riderPassengers(vehicle: Vehicle): Passenger[] {
    return vehicle.riders
      .map((id) => manifest.signups.find((p) => p.id === id))
      .filter((p): p is Passenger => Boolean(p));
  }

  async function wrap(fn: () => Promise<void>) {
    setSaving(true);
    try {
      await fn();
    } finally {
      setSaving(false);
    }
  }

  function periodLabel(period: 'AM' | 'PM'): string {
    return period === 'AM' ? 'Morning' : 'Evening';
  }

  function buildWhatsAppManifest(): string {
    const lines: string[] = [];
    const { date: sessionDate } = parseManifestKey(manifest.date);
    const def = SERVICE_TYPES.find((s) => s.value === service);
    const header = def ? `${periodLabel(def.period)} ${def.mode} Taxis` : `${serviceLabel} Taxis`;
    lines.push(`*${header}*`);
    lines.push(`*${shortDate(sessionDate)}*`);

    const vehiclesToExport = sortVehiclesNatural(manifest.vehicles.filter((v) => !v.submitted));

    for (const vehicle of vehiclesToExport) {
      const riders = riderPassengers(vehicle);
      if (riders.length === 0) continue;

      lines.push(`*${vehicle.name}*`);

      const groups = ridersGroupedByHub(vehicle);
      for (const group of groups) {
        const time = vehicle.stopTimes?.[group.label];
        lines.push(time ? `\u{1F6D1} ${group.label} - *${time}*` : `\u{1F6D1} ${group.label}`);
      }

      const note = (vehicle.generalNotes ?? '').trim();
      if (note) lines.push(`*(${note})*`);
    }

    return lines.join('\n');
  }

  async function copyWhatsApp() {
    const text = buildWhatsAppManifest();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <div className="card">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="h-5 w-1 rounded-full bg-crimson-500" />
          <h2 className="font-display text-sm font-bold uppercase tracking-wider text-ink">Vehicle Route Allocation</h2>
          {saving && <span className="text-xs text-muted">Saving...</span>}
        </div>
        {manifest.vehicles.length > 0 && manifest.vehicles.some((v) => riderPassengers(v).length > 0) && (
          <button
            onClick={copyWhatsApp}
            className="btn-success px-3 py-2 text-xs"
            title="Copy WhatsApp manifest to clipboard"
          >
            {copied ? <Check className="h-4 w-4" /> : <MessageCircle className="h-4 w-4" />}
            {copied ? 'Copied!' : 'Copy WhatsApp Manifest'}
          </button>
        )}
      </div>

      {/* Add vehicle */}
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">Vehicle Name</label>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && wrap(addVehicle)}
            placeholder="e.g. Bus 1, Taxi 7"
            className="input-field"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">Type</label>
          <select
            value={newType}
            onChange={(e) => setNewType(e.target.value as 'Bus' | 'Taxi')}
            className="input-field"
          >
            <option value="Bus" className="bg-card-2">Bus</option>
            <option value="Taxi" className="bg-card-2">Taxi</option>
          </select>
        </div>
        <button onClick={() => wrap(addVehicle)} disabled={!newName.trim() || saving} className="btn-crimson">
          <Plus className="h-4 w-4" />
          Add Vehicle
        </button>
      </div>

      {/* Move person between vehicles */}
      {manifest.vehicles.length >= 2 && (
        <div className="mb-5 rounded-xl border border-warning/20 bg-warning/5 p-4">
          <div className="mb-2 flex items-center gap-2">
            <MoveRight className="h-4 w-4 text-warning" />
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">Move a person to a different vehicle</span>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted">From Vehicle</label>
              <select value={moveFromVehicle} onChange={(e) => { setMoveFromVehicle(e.target.value); setMovePassengerId(''); }} className="input-field py-2 text-xs">
                <option value="" className="bg-card-2">Select...</option>
                {sortVehiclesNatural(manifest.vehicles.filter(v => v.riders.length > 0)).map((v) => (
                  <option key={v.id} value={v.id} className="bg-card-2">{v.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted">Person</label>
              <select value={movePassengerId} onChange={(e) => setMovePassengerId(e.target.value)} className="input-field py-2 text-xs" disabled={!moveFromVehicle}>
                <option value="" className="bg-card-2">Select...</option>
                {moveFromVehicle && riderPassengers(manifest.vehicles.find(v => v.id === moveFromVehicle)!).map((p) => (
                  <option key={p.id} value={p.id} className="bg-card-2">{p.fullName} ({p.structure || '—'})</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted">To Vehicle</label>
              <div className="flex gap-1.5">
                <select value={moveToVehicle} onChange={(e) => setMoveToVehicle(e.target.value)} className="input-field py-2 text-xs" disabled={!movePassengerId}>
                  <option value="" className="bg-card-2">Select...</option>
                  {sortVehiclesNatural(manifest.vehicles.filter(v => v.id !== moveFromVehicle)).map((v) => (
                    <option key={v.id} value={v.id} className="bg-card-2">{v.name}</option>
                  ))}
                </select>
                <button
                  onClick={() => wrap(() => movePassenger(movePassengerId, moveFromVehicle, moveToVehicle))}
                  disabled={!movePassengerId || !moveToVehicle || saving}
                  className="btn-crimson px-3 py-2 text-xs whitespace-nowrap"
                >
                  <ArrowRight className="h-3.5 w-3.5" />
                  Move
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Unassigned pool overview */}
      {unassigned.length > 0 && (
        <div className="mb-5 rounded-xl border border-line bg-card-2/50 p-4">
          <div className="mb-2 flex items-center gap-2">
            <Users className="h-4 w-4 text-muted" />
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">Unassigned Pool</span>
            <span className="badge bg-crimson-500/15 text-crimson-300">{unassigned.length} waiting</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {stopNames.map((stop) => (
              <span key={stop} className="inline-flex items-center gap-1 rounded-md bg-bg/60 px-2 py-1 text-xs text-muted">
                {stop} <span className="font-semibold text-crimson-300">({stopsMap[stop].length} remaining)</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Vehicle cards */}
      {manifest.vehicles.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10 text-center">
          <Bus className="h-8 w-8 text-line" />
          <p className="text-sm text-muted">No vehicles created yet. Add a vehicle above to start assigning passengers.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {sortedVehicles.map((vehicle) => {
            const riders = riderPassengers(vehicle);
            const isExpanded = expandedVehicle === vehicle.id;
            const Icon = vehicle.type === 'Bus' ? Bus : Car;
            const pool = poolForVehicleType(vehicle.type);
            const groupedHubs = ridersGroupedByHub(vehicle);
            return (
              <div
                key={vehicle.id}
                className={`overflow-hidden rounded-xl border transition-all hover:border-crimson-500/30 ${
                  vehicle.submitted ? 'border-success/30 bg-success/5' : 'border-line bg-card-2'
                }`}
              >
                <div className="flex items-center justify-between gap-3 p-4">
                  <button
                    onClick={() => { setExpandedVehicle(isExpanded ? null : vehicle.id); setSelectedPoolKey(''); setAssignQty(''); }}
                    className="flex flex-1 items-center gap-3 text-left"
                  >
                    <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${
                      vehicle.type === 'Bus' ? 'bg-crimson-500/15 text-crimson-400' : 'bg-success/15 text-success-light'
                    }`}>
                      <Icon className="h-5 w-5" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-ink">{vehicle.name}</span>
                        {vehicle.submitted && (
                          <span className="badge bg-success/15 text-success-light text-[10px]">Submitted</span>
                        )}
                      </div>
                      <div className="text-xs text-muted">
                        {vehicle.type} - {riders.length} passenger{riders.length !== 1 ? 's' : ''}
                        {vehicle.repName ? ' - Rep: ' + vehicle.repName : ''}
                        {vehicle.licensePlate ? ' - ' + vehicle.licensePlate : ''}
                      </div>
                    </div>
                  </button>
                  <div className="flex items-center gap-2">
                    {riders.length > 0 && (
                      <button
                        onClick={() => wrap(() => unassignAllFromVehicle(vehicle.id))}
                        disabled={saving}
                        title="Return all riders to unassigned pool"
                        className="btn-ghost px-2.5 py-2"
                      >
                        <Undo2 className="h-4 w-4" />
                      </button>
                    )}
                    <button
                      onClick={() => wrap(() => removeVehicle(vehicle.id))}
                      disabled={saving}
                      title="Delete vehicle"
                      className="rounded-lg border border-crimson-500/20 bg-crimson-900/20 p-2 text-crimson-300 transition-all hover:border-crimson-500 hover:bg-crimson-900/40"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t border-line bg-bg/40 p-4 animate-fade-in">
                    {/* Rep assignment */}
                    <div className="mb-4 flex items-center gap-2">
                      <UserCog className="h-4 w-4 text-muted" />
                      <label className="text-[10px] font-semibold uppercase tracking-wide text-muted">Transport Rep</label>
                      <input
                        type="text"
                        value={vehicle.repName ?? ''}
                        onChange={(e) => setRepName(vehicle.id, e.target.value)}
                        placeholder="Type rep name"
                        className="input-field flex-1 py-1.5 text-xs"
                      />
                    </div>

                    <div className="mb-4 flex items-center gap-2">
                      <StickyNote className="h-4 w-4 text-muted" />
                      <label className="text-[10px] font-semibold uppercase tracking-wide text-muted whitespace-nowrap">Redirect Note</label>
                      <input
                        type="text"
                        value={vehicle.generalNotes ?? ''}
                        onChange={(e) => setVehicleNote(vehicle.id, e.target.value)}
                        placeholder="e.g. Student Digzz people please Go to YMCA"
                        className="input-field flex-1 py-1.5 text-xs"
                      />
                    </div>

                    {/* Assign controls */}
                    <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end">
                      <div className="flex-1">
                        <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted">
                          {vehicle.type === 'Taxi' ? 'Hub Pool' : 'Stop Pool'}
                        </label>
                        <select
                          value={selectedPoolKey}
                          onChange={(e) => setSelectedPoolKey(e.target.value)}
                          className="input-field py-2 text-xs"
                        >
                          <option value="" className="bg-card-2">Select {vehicle.type === 'Taxi' ? 'hub' : 'stop'}...</option>
                          {pool.map(({ key, count }) => (
                            <option key={key} value={key} className="bg-card-2">
                              {key} ({count} remaining)
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="w-24">
                        <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted">Qty</label>
                        <input
                          type="number"
                          min="1"
                          value={assignQty}
                          onChange={(e) => setAssignQty(e.target.value)}
                          placeholder="all"
                          className="input-field py-2 text-xs"
                        />
                      </div>
                      <button
                        onClick={() => wrap(() => assignToVehicle(
                          vehicle.id,
                          selectedPoolKey,
                          assignQty ? Math.max(1, parseInt(assignQty, 10) || 1) : 'all'
                        ))}
                        disabled={!selectedPoolKey || saving}
                        className="btn-success py-2 text-xs"
                      >
                        <ArrowRight className="h-3.5 w-3.5" />
                        Assign
                      </button>
                    </div>

                    {/* Rider list */}
                    {riders.length === 0 ? (
                      <p className="py-3 text-center text-xs text-muted">No passengers assigned to this vehicle yet.</p>
                    ) : (
                      <div className="space-y-3">
                        {groupedHubs.map((group, index) => (
                          <div key={group.label}>
                            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                              <MapPin className="h-3 w-3 text-crimson-400" />
                              <span className="text-[11px] font-semibold uppercase tracking-wide text-crimson-300">{group.label}</span>
                              <span className="text-[10px] text-muted">({group.riders.length})</span>
                              
                              {/* Re-orderable Route Controls */}
                              <div className="flex items-center gap-0.5 ml-2">
                                <button
                                  onClick={(e) => { e.stopPropagation(); wrap(() => moveStopOrder(vehicle.id, group.label, 'up')); }}
                                  disabled={index === 0 || saving}
                                  className="p-1 rounded text-muted hover:bg-card-2 disabled:opacity-30"
                                  title="Move up"
                                >
                                  <ArrowUp className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); wrap(() => moveStopOrder(vehicle.id, group.label, 'down')); }}
                                  disabled={index === groupedHubs.length - 1 || saving}
                                  className="p-1 rounded text-muted hover:bg-card-2 disabled:opacity-30"
                                  title="Move down"
                                >
                                  <ArrowDown className="h-3.5 w-3.5" />
                                </button>
                              </div>

                              <span className="ml-auto flex items-center gap-1">
                                <Clock className="h-3 w-3 text-muted" />
                                <input
                                  type="time"
                                  value={vehicle.stopTimes?.[group.label] ?? ''}
                                  onChange={(e) => setStopTime(vehicle.id, group.label, e.target.value)}
                                  className="input-field w-24 py-0.5 text-[11px]"
                                  title="Pickup time for the WhatsApp export"
                                />
                              </span>
                            </div>
                            <div className="space-y-1.5">
                              {group.riders.map((p) => {
                                const isRepHighlight = highlightRep === p.fullName;
                                return (
                                  <div
                                    key={p.id}
                                    className={`flex items-center justify-between gap-2 rounded-lg px-3 py-2 transition-all cursor-pointer ${
                                      isRepHighlight ? 'ring-2 ring-crimson-500/60 bg-crimson-500/10' : ''
                                    } ${p.present ? 'bg-success/10' : 'bg-card-2/80'}`}
                                    onClick={() => setHighlightRep(highlightRep === p.fullName ? null : p.fullName)}
                                  >
                                    <div className="flex items-center gap-2">
                                      <span className={`text-sm ${p.present ? 'text-success-light' : 'text-ink'}`}>
                                        {p.fullName}
                                        {vehicle.repName && p.fullName === vehicle.repName && (
                                          <span className="ml-1 text-crimson-400">*</span>
                                        )}
                                      </span>
                                      {p.structure && (
                                        <span className="rounded bg-bg/60 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-muted">{p.structure}</span>
                                      )}
                                      <span className="badge bg-bg/60 text-muted text-[10px]">{p.stop}</span>
                                      {p.present && (
                                        <span className="badge bg-success/15 text-success-light text-[10px]">Present</span>
                                      )}
                                      {p.sponsored && (
                                        <span className="badge bg-warning/15 text-warning text-[10px]">Sponsored</span>
                                      )}
                                    </div>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); wrap(() => unassignRider(vehicle.id, p.id)); }}
                                      disabled={saving}
                                      className="rounded-md p-1 text-muted transition-colors hover:bg-crimson-900/30 hover:text-crimson-300"
                                      title="Return to pool"
                                    >
                                      <X className="h-3.5 w-3.5" />
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Submitted vehicles accordion */}
      {submittedVehicles.length > 0 && (
        <div className="mt-5 overflow-hidden rounded-xl border border-success/20 bg-success/5">
          <button
            onClick={() => setShowSubmitted(!showSubmitted)}
            className="flex w-full items-center justify-between gap-2 p-4 text-left transition-colors hover:bg-success/10"
          >
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-success-light" />
              <span className="text-xs font-semibold uppercase tracking-wide text-success-light">
                Submitted Vehicles ({submittedVehicles.length})
              </span>
            </div>
            {showSubmitted ? <ChevronDown className="h-4 w-4 text-muted" /> : <ChevronRight className="h-4 w-4 text-muted" />}
          </button>
          {showSubmitted && (
            <div className="divide-y divide-line/60 border-t border-success/20 animate-fade-in">
              {submittedVehicles.map((v) => {
                const vRiders = riderPassengers(v);
                const vPresent = vRiders.filter((r) => r.present).length;
                return (
                  <div key={v.id} className="p-4">
                    <div className="flex items-center gap-3">
                      <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${
                        v.type === 'Bus' ? 'bg-crimson-500/15 text-crimson-400' : 'bg-success/15 text-success-light'
                      }`}>
                        {v.type === 'Bus' ? <Bus className="h-4 w-4" /> : <Car className="h-4 w-4" />}
                      </div>
                      <div className="flex-1">
                        <div className="text-sm font-semibold text-ink">{v.name}</div>
                        <div className="text-xs text-muted">
                          {'Rep: ' + (v.repName || v.submittedBy || '—')}
                          {v.licensePlate ? ' - Plate: ' + v.licensePlate : ''}
                          {v.submittedAt ? ' - ' + new Date(v.submittedAt).toLocaleString('en-ZA', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }) : ''}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-display text-sm font-bold text-success-light">{vPresent}/{vRiders.length}</div>
                        <div className="text-[10px] text-muted">present</div>
                      </div>
                    </div>
                    {v.generalNotes && (
                      <div className="mt-2 rounded-lg bg-card-2/60 px-3 py-2 text-xs text-muted">
                        <span className="font-semibold text-ink">Notes: </span>{v.generalNotes}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}