import { supabase, MANIFESTS_TABLE, mockStorage } from './supabase';
import type { Manifest, Passenger, Vehicle } from './types';
import { hubDisplayName } from './types';
export { parseGoogleSheetSignups, type RawSheetRow } from './importer';

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
  try {
    const { data, error } = await supabase
      .from(MANIFESTS_TABLE)
      .select('date, signups, vehicles, created_at, updated_at')
      .order('date', { ascending: false });
    if (error) {
      console.warn('[Manifest] Remote list failed, returning local cached manifests:', error);
    }
    if (data && Array.isArray(data)) {
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
  } catch (err) {
    console.warn('[Manifest] Exception listing manifests, checking local cache:', err);
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
  if (!manifest) return [];
  return manifest.signups.filter((p) => !p.assignedTo);
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
