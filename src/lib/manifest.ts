import { supabase, MANIFESTS_TABLE } from './supabase';
import type { Manifest, Passenger, Vehicle } from './types';

export async function loadManifest(key: string): Promise<Manifest | null> {
  const { data, error } = await supabase
    .from(MANIFESTS_TABLE)
    .select('date, signups, vehicles, created_at, updated_at')
    .eq('date', key)
    .maybeSingle();
  if (error) throw error;
  return (data as Manifest) ?? null;
}

export async function upsertManifest(manifest: Manifest): Promise<void> {
  const { error } = await supabase
    .from(MANIFESTS_TABLE)
    .upsert(
      {
        date: manifest.date,
        signups: manifest.signups,
        vehicles: manifest.vehicles,
      },
      { onConflict: 'date' }
    );
  if (error) throw error;
}

export async function listAllManifests(): Promise<Manifest[]> {
  const { data, error } = await supabase
    .from(MANIFESTS_TABLE)
    .select('date, signups, vehicles, created_at, updated_at')
    .order('date', { ascending: false });
  if (error) throw error;
  return (data as Manifest[]) ?? [];
}

export async function deleteManifest(key: string): Promise<void> {
  const { error } = await supabase.from(MANIFESTS_TABLE).delete().eq('date', key);
  if (error) throw error;
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
    const stop = p.stop || 'Unknown';
    if (!map[stop]) map[stop] = [];
    map[stop].push(p);
  }
  return map;
}

export function vehicleRiders(manifest: Manifest | null, vehicle: Vehicle): Passenger[] {
  if (!manifest) return [];
  return vehicle.riders
    .map((id) => manifest.signups.find((p) => p.id === id))
    .filter((p): p is Passenger => Boolean(p));
}
