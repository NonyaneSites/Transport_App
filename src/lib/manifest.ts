import { supabase, MANIFESTS_TABLE, mockStorage } from './supabase';
import type { Manifest, Passenger, Vehicle, VehicleDraftState } from './types';
import { hubDisplayName } from './types';
import { normalizePassengerText, getSubmissionTimestampEpoch } from './importer';
export { parseGoogleSheetSignups, type RawSheetRow } from './importer';

/**
 * Normalizes a raw manifest payload (from Supabase, broadcast, or local storage)
 * into a well-formed Manifest with safe array defaults.
 */
export function normalizeManifestData(raw: Partial<Manifest> | null | undefined): Manifest | null {
  if (!raw || !raw.date) return null;
  return {
    date: raw.date,
    signups: Array.isArray(raw.signups) ? raw.signups : [],
    vehicles: Array.isArray(raw.vehicles)
      ? raw.vehicles.map((v: Vehicle) => ({
          ...v,
          riders: Array.isArray(v.riders) ? v.riders : [],
          orderedStops: Array.isArray(v.orderedStops) ? v.orderedStops : [],
        }))
      : [],
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };
}

/**
 * Pure function to apply a walk-in passenger to a manifest, with no database dependencies.
 */
export function applyWalkInToManifest(
  currentManifest: Manifest,
  vehicleId: string,
  walkInPassenger: Passenger,
  extraDraftUpdate?: Partial<VehicleDraftState>
): Manifest {
  const existingIndex = currentManifest.signups.findIndex((p) => p.id === walkInPassenger.id);
  let nextSignups: Passenger[];
  if (existingIndex >= 0) {
    nextSignups = [...currentManifest.signups];
    nextSignups[existingIndex] = { ...currentManifest.signups[existingIndex], ...walkInPassenger };
  } else {
    nextSignups = [...currentManifest.signups, walkInPassenger];
  }

  const poolKey = hubDisplayName(
    currentManifest.vehicles.find((v) => v.id === vehicleId)?.type,
    walkInPassenger.stop || 'Walk-In'
  );

  const nextVehicles = currentManifest.vehicles.map((v) => {
    if (v.id !== vehicleId) return v;

    const riders = Array.isArray(v.riders) ? v.riders : [];
    const nextRiders = riders.includes(walkInPassenger.id) ? riders : [...riders, walkInPassenger.id];

    const orderedStops = Array.isArray(v.orderedStops) ? v.orderedStops : [];
    const nextOrderedStops = orderedStops.includes(poolKey) ? orderedStops : [...orderedStops, poolKey];

    const currentDraft = v.draftState || {};
    const presentIds = currentDraft.presentIds || [];
    const nextPresentIds = presentIds.includes(walkInPassenger.id)
      ? presentIds
      : [...presentIds, walkInPassenger.id];

    const absentIds = (currentDraft.absentIds || []).filter((id) => id !== walkInPassenger.id);

    const nextDraftState: VehicleDraftState = {
      ...currentDraft,
      repName: extraDraftUpdate?.repName?.trim() || currentDraft.repName || v.repName || '',
      licensePlate: extraDraftUpdate?.licensePlate?.trim() || currentDraft.licensePlate || v.licensePlate || '',
      generalNotes: extraDraftUpdate?.generalNotes !== undefined ? extraDraftUpdate.generalNotes : (currentDraft.generalNotes || ''),
      notes: { ...(currentDraft.notes || {}), ...(extraDraftUpdate?.notes || {}) },
      presentIds: nextPresentIds,
      absentIds,
      sponsoredIds: currentDraft.sponsoredIds || [],
      unpaidIds: currentDraft.unpaidIds || [],
      updatedAt: new Date().toISOString(),
      updatedBy: extraDraftUpdate?.updatedBy || currentDraft.updatedBy,
    };

    return {
      ...v,
      riders: nextRiders,
      orderedStops: nextOrderedStops,
      draftState: nextDraftState,
    };
  });

  return {
    ...currentManifest,
    signups: nextSignups,
    vehicles: nextVehicles,
    updated_at: new Date().toISOString(),
  };
}

/**
 * CONCURRENCY-SAFE SAVE RECONCILIATION
 *
 * Problem this solves: multiple reps/admins can be editing the manifest at the same time.
 * A caller builds its "next manifest" from whatever it last had in memory (`baseline`), which
 * can be a few seconds stale by the time the save actually reaches the server. Blindly writing
 * that "next manifest" over the shared row would silently discard anything anyone else changed
 * in between (a vehicle someone else just added, a submission someone else just made, etc).
 *
 * Instead: we look at what actually CHANGED between `baseline` (what the caller believed was
 * true when it started editing) and `incoming` (what the caller wants to save) to infer intent
 * (this vehicle was added / this vehicle was removed / this vehicle's fields changed / this
 * signup was added or edited), then we replay just that intent on top of the freshest possible
 * copy of the row (`remote`, fetched immediately before writing). Anything nobody touched is
 * always taken from `remote`, so concurrent edits by other people are preserved.
 */
export function reconcileManifestForSave(
  baseline: Manifest | null,
  incoming: Manifest,
  remote: Manifest | null
): Manifest {
  // No remote row yet, or it's for a different session key: nothing to reconcile against.
  if (!remote || remote.date !== incoming.date) {
    return incoming;
  }
  // No known baseline (e.g. very first save of a session): we can't tell intent apart from
  // "stale copy", so fall back to trusting the incoming manifest as-is.
  if (!baseline || baseline.date !== incoming.date) {
    return incoming;
  }

  function reconcileList<T extends { id: string }>(baseList: T[], incomingList: T[], remoteList: T[]): T[] {
    const baseMap = new Map(baseList.map((item) => [item.id, item]));
    const incomingMap = new Map(incomingList.map((item) => [item.id, item]));

    // Intentional removal: present in baseline, missing from incoming.
    const removedIds = new Set(baseList.filter((item) => !incomingMap.has(item.id)).map((item) => item.id));

    // Intentional add/edit: new to baseline, or different from baseline's version.
    const changedOrNew = incomingList.filter((item) => {
      const baseItem = baseMap.get(item.id);
      return !baseItem || JSON.stringify(baseItem) !== JSON.stringify(item);
    });

    const mergedMap = new Map(remoteList.filter((item) => !removedIds.has(item.id)).map((item) => [item.id, item]));
    changedOrNew.forEach((item) => mergedMap.set(item.id, item));

    // Preserve remote ordering, then append anything genuinely new at the end.
    const remoteOrderIds = remoteList.map((item) => item.id).filter((id) => !removedIds.has(id));
    const newIds = changedOrNew.map((item) => item.id).filter((id) => !remoteOrderIds.includes(id));
    return [...remoteOrderIds, ...newIds]
      .map((id) => mergedMap.get(id))
      .filter((item): item is T => Boolean(item));
  }

  return {
    ...incoming,
    vehicles: reconcileList(baseline.vehicles, incoming.vehicles, remote.vehicles),
    signups: reconcileList(baseline.signups, incoming.signups, remote.signups),
  };
}

export async function loadManifest(key: string): Promise<Manifest | null> {
  try {
    const { data, error } = await supabase
      .from(MANIFESTS_TABLE)
      .select('date, signups, vehicles, created_at, updated_at')
      .eq('date', key)
      .maybeSingle();
    if (error) {
      console.warn('[Manifest] Failed to load remote manifest, reading local store:', error);
    }
    if (data) {
      return {
        date: data.date,
        signups: Array.isArray(data.signups) ? data.signups : [],
        vehicles: Array.isArray(data.vehicles)
          ? data.vehicles.map((v: Vehicle) => ({
              ...v,
              riders: Array.isArray(v.riders) ? v.riders : [],
              orderedStops: Array.isArray(v.orderedStops) ? v.orderedStops : [],
            }))
          : [],
        created_at: data.created_at,
        updated_at: data.updated_at,
      };
    }
  } catch (err) {
    console.warn('[Manifest] Exception loading manifest, checking local store:', err);
  }

  // Fallback to local storage
  const localRow = mockStorage.getTable(MANIFESTS_TABLE).find((r) => r.date === key);
  if (!localRow) return null;
  return {
    date: String(localRow.date),
    signups: Array.isArray(localRow.signups) ? (localRow.signups as Passenger[]) : [],
    vehicles: Array.isArray(localRow.vehicles) ? (localRow.vehicles as Vehicle[]) : [],
    created_at: typeof localRow.created_at === 'string' ? localRow.created_at : undefined,
    updated_at: typeof localRow.updated_at === 'string' ? localRow.updated_at : undefined,
  };
}

export async function upsertManifest(manifest: Manifest): Promise<void> {
  // Save to Supabase (source of truth) with a local-storage fallback if offline.
  try {
    const { error } = await supabase
      .from(MANIFESTS_TABLE)
      .upsert(
        {
          date: manifest.date,
          signups: Array.isArray(manifest.signups) ? manifest.signups : [],
          vehicles: Array.isArray(manifest.vehicles) ? manifest.vehicles : [],
        },
        { onConflict: 'date' }
      );
    if (error) {
      console.warn('[Manifest] Remote upsert failed, saving to local store:', error);
      mockStorage.setTable(
        MANIFESTS_TABLE,
        [
          ...mockStorage.getTable(MANIFESTS_TABLE).filter((r) => r.date !== manifest.date),
          {
            date: manifest.date,
            signups: manifest.signups,
            vehicles: manifest.vehicles,
            updated_at: new Date().toISOString(),
          },
        ]
      );
    }
  } catch (err) {
    console.warn('[Manifest] Exception in upsertManifest, saving locally:', err);
    mockStorage.setTable(
      MANIFESTS_TABLE,
      [
        ...mockStorage.getTable(MANIFESTS_TABLE).filter((r) => r.date !== manifest.date),
        {
          date: manifest.date,
          signups: manifest.signups,
          vehicles: manifest.vehicles,
          updated_at: new Date().toISOString(),
        },
      ]
    );
  }
}

export async function listAllManifests(): Promise<Manifest[]> {
  // Supabase (silent fallback to local storage if offline / not provisioned)
  try {
    const { data, error } = await supabase
      .from(MANIFESTS_TABLE)
      .select('date, signups, vehicles, created_at, updated_at')
      .order('date', { ascending: false });
    if (!error && data && Array.isArray(data) && data.length > 0) {
      return data.map((d) => ({
        date: d.date,
        signups: Array.isArray(d.signups) ? d.signups : [],
        vehicles: Array.isArray(d.vehicles)
          ? d.vehicles.map((v: Vehicle) => ({
              ...v,
              riders: Array.isArray(v.riders) ? v.riders : [],
              orderedStops: Array.isArray(v.orderedStops) ? v.orderedStops : [],
            }))
          : [],
        created_at: d.created_at,
        updated_at: d.updated_at,
      }));
    }
  } catch {
    // Non-critical network/offline fallback
  }

  // Fallback to local storage
  const localRows = mockStorage.getTable(MANIFESTS_TABLE);
  return localRows.map((d) => ({
    date: String(d.date ?? ''),
    signups: Array.isArray(d.signups) ? (d.signups as Passenger[]) : [],
    vehicles: Array.isArray(d.vehicles) ? (d.vehicles as Vehicle[]) : [],
    created_at: typeof d.created_at === 'string' ? d.created_at : undefined,
    updated_at: typeof d.updated_at === 'string' ? d.updated_at : undefined,
  }));
}

export async function deleteManifest(key: string): Promise<void> {
  try {
    const { error } = await supabase.from(MANIFESTS_TABLE).delete().eq('date', key);
    if (error) {
      console.warn('[Manifest] Remote delete error, deleting locally:', error);
    }
  } catch (err) {
    console.warn('[Manifest] Exception deleting manifest, deleting locally:', err);
  }
  mockStorage.setTable(
    MANIFESTS_TABLE,
    mockStorage.getTable(MANIFESTS_TABLE).filter((r) => r.date !== key)
  );
}

export function emptyManifest(key: string): Manifest {
  return { date: key, signups: [], vehicles: [] };
}

export function findPassenger(manifest: Manifest | null, id: string): Passenger | undefined {
  return manifest?.signups.find((p) => p.id === id);
}

export function findVehicle(manifest: Manifest | null, id: string): Vehicle | undefined {
  return manifest?.vehicles.find((v) => v.id === id);
}

export function unassignedPassengers(manifest: Manifest | null): Passenger[] {
  if (!manifest || !Array.isArray(manifest.signups)) return [];

  // Identify all passengers already assigned to a vehicle
  const allocatedIds = new Set<string>();
  const allocatedPersons = new Set<string>();

  for (const v of manifest.vehicles || []) {
    for (const rId of v.riders || []) {
      allocatedIds.add(rId);
      const rider = manifest.signups.find((s) => s.id === rId);
      if (rider) {
        const norm = normalizePassengerText(rider.fullName);
        if (norm) allocatedPersons.add(norm);
      }
    }
  }

  // Filter raw unassigned signups
  const rawUnassigned = manifest.signups.filter((p) => !p.assignedTo && !allocatedIds.has(p.id));

  // Deduplicate among unassigned by person: keep only the most recent signup and exclude anyone already allocated
  const personMap = new Map<string, { passenger: Passenger; epoch: number; index: number }>();

  rawUnassigned.forEach((p, idx) => {
    const norm = normalizePassengerText(p.fullName);
    if (!norm) {
      personMap.set(`unnamed-${p.id || idx}`, { passenger: p, epoch: 0, index: idx });
      return;
    }

    // If person already has an assigned vehicle in this manifest, exclude their stale unassigned duplicate
    if (allocatedPersons.has(norm)) {
      return;
    }

    const epoch = getSubmissionTimestampEpoch(p.timestamp, idx);
    const existing = personMap.get(norm);

    if (!existing) {
      personMap.set(norm, { passenger: p, epoch, index: idx });
    } else {
      // Prioritize the most recent signup
      if (epoch > existing.epoch || (epoch === existing.epoch && idx > existing.index)) {
        personMap.set(norm, { passenger: p, epoch, index: idx });
      }
    }
  });

  return Array.from(personMap.values()).map((item) => item.passenger);
}

export function passengersByStop(passengers: Passenger[]): Record<string, Passenger[]> {
  const map: Record<string, Passenger[]> = {};
  for (const p of passengers) {
    const rawStop = (p.stop || '').trim();
    const stop = (!rawStop || rawStop.toLowerCase() === 'unknown' || rawStop.toLowerCase() === 'unspecified')
      ? 'Unassigned Stop'
      : rawStop;
    if (!map[stop]) map[stop] = [];
    map[stop].push(p);
  }
  return map;
}

/**
 * Groups unassigned passengers into the pool the Admin should see for a
 * given vehicle type: Taxis see consolidated Master Hubs, Buses see the
 * explicit raw sub-stops. See hubDisplayName in ./types for the mapping.
 */
export function passengersByPoolGroup(
  passengers: Passenger[],
  vehicleType: 'Bus' | 'Taxi'
): Record<string, Passenger[]> {
  const map: Record<string, Passenger[]> = {};
  for (const p of passengers) {
    const key = hubDisplayName(vehicleType, p.stop);
    if (!map[key]) map[key] = [];
    map[key].push(p);
  }
  return map;
}

export function vehicleRiders(manifest: Manifest | null, vehicle: Vehicle): Passenger[] {
  if (!manifest) return [];
  return vehicle.riders
    .map((id) => manifest.signups.find((p) => p.id === id))
    .filter((p): p is Passenger => Boolean(p));
}
