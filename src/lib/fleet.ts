import { supabase, FLEET_TABLE, mockStorage } from './supabase';
import type { FleetVehicle } from './types';

// Default starter fleet when table is initially empty
export const DEFAULT_STARTER_FLEET: Omit<FleetVehicle, 'id' | 'created_at' | 'updated_at'>[] = [
  {
    name: 'Quantum 1',
    type: 'Taxi',
    capacity: 15,
    default_stop: 'Braamfontein',
    is_active: true,
    notes: 'Standard 15-seater Toyota Quantum',
  },
  {
    name: 'Quantum 2',
    type: 'Taxi',
    capacity: 15,
    default_stop: 'Braamfontein',
    is_active: true,
    notes: 'Standard 15-seater Toyota Quantum',
  },
  {
    name: 'Quantum 3',
    type: 'Taxi',
    capacity: 15,
    default_stop: 'Braamfontein',
    is_active: true,
    notes: 'Standard 15-seater Toyota Quantum',
  },
  {
    name: 'Quantum 4',
    type: 'Taxi',
    capacity: 15,
    default_stop: 'Braamfontein',
    is_active: true,
    notes: 'Standard 15-seater Toyota Quantum',
  },
  {
    name: 'Main Bus 1',
    type: 'Bus',
    capacity: 60,
    default_stop: 'Soweto Hub',
    is_active: true,
    notes: '60-seater Main Coach Bus',
  },
  {
    name: 'Main Bus 2',
    type: 'Bus',
    capacity: 60,
    default_stop: 'Soweto Hub',
    is_active: true,
    notes: '60-seater Main Coach Bus',
  },
];

/**
 * Normalizes a database row to a FleetVehicle object
 */
export function dbRowToFleetVehicle(row: Record<string, unknown>): FleetVehicle {
  return {
    id: String(row.id || ''),
    name: String(row.name || ''),
    type: row.type === 'Bus' ? 'Bus' : 'Taxi',
    capacity: typeof row.capacity === 'number' && row.capacity > 0 ? row.capacity : (row.type === 'Bus' ? 60 : 15),
    license_plate: row.license_plate ? String(row.license_plate) : undefined,
    driver_name: row.driver_name ? String(row.driver_name) : undefined,
    driver_phone: row.driver_phone ? String(row.driver_phone) : undefined,
    default_rep: row.default_rep ? String(row.default_rep) : undefined,
    default_stop: row.default_stop ? String(row.default_stop) : undefined,
    notes: row.notes ? String(row.notes) : undefined,
    is_active: row.is_active !== false,
    created_at: row.created_at ? String(row.created_at) : undefined,
    updated_at: row.updated_at ? String(row.updated_at) : undefined,
  };
}

/**
 * Converts a FleetVehicle to a database row for Supabase
 */
export function fleetVehicleToDbRow(v: Partial<FleetVehicle>): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id: v.id,
    name: v.name?.trim(),
    type: v.type === 'Bus' ? 'Bus' : 'Taxi',
    capacity: typeof v.capacity === 'number' && v.capacity > 0 ? v.capacity : (v.type === 'Bus' ? 60 : 15),
    license_plate: v.license_plate?.trim() || null,
    driver_name: v.driver_name?.trim() || null,
    driver_phone: v.driver_phone?.trim() || null,
    default_rep: v.default_rep?.trim() || null,
    default_stop: v.default_stop?.trim() || null,
    notes: v.notes?.trim() || null,
    is_active: v.is_active !== false,
    updated_at: now,
  };
}

/**
 * Initializes starter vehicles in the mockStorage if empty
 */
function ensureLocalStarterFleet(): FleetVehicle[] {
  const current = mockStorage.getTable(FLEET_TABLE);
  if (current.length > 0) {
    return current.map((r) => dbRowToFleetVehicle(r));
  }

  const seeded: FleetVehicle[] = DEFAULT_STARTER_FLEET.map((item, idx) => ({
    ...item,
    id: `fleet-seed-${idx + 1}`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }));

  mockStorage.setTable(FLEET_TABLE, seeded.map((v) => fleetVehicleToDbRow(v)));
  return seeded;
}

/**
 * Loads all fleet vehicles (both active and inactive) from Supabase / server / local storage.
 */
export async function listFleetVehicles(): Promise<FleetVehicle[]> {
  try {
    // 1. Try fetching from server API endpoint first if available
    try {
      const res = await fetch('/api/fleet');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          // Sync to mock storage
          mockStorage.setTable(FLEET_TABLE, data.map((v) => fleetVehicleToDbRow(v)));
          return data.map((r) => dbRowToFleetVehicle(r));
        }
      }
    } catch {
      // Ignore server fetch error, continue to Supabase
    }

    // 2. Direct Supabase query
    const { data, error } = await supabase
      .from(FLEET_TABLE)
      .select('*')
      .order('name', { ascending: true });

    if (!error && Array.isArray(data) && data.length > 0) {
      // Sync to mock storage
      mockStorage.setTable(FLEET_TABLE, data.map((v) => fleetVehicleToDbRow(v)));
      return data.map((r) => dbRowToFleetVehicle(r));
    }
  } catch (err) {
    console.warn('[Fleet] Remote list query error, using local/seeded storage:', err);
  }

  // 3. Fallback to mock/local storage
  return ensureLocalStarterFleet();
}

/**
 * Saves (inserts or updates) a fleet vehicle in Supabase & local storage
 */
export async function saveFleetVehicle(vehicle: Partial<FleetVehicle>): Promise<FleetVehicle> {
  const id = vehicle.id || `fleet-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const fullVehicle: FleetVehicle = {
    id,
    name: vehicle.name?.trim() || 'Unnamed Vehicle',
    type: vehicle.type === 'Bus' ? 'Bus' : 'Taxi',
    capacity: typeof vehicle.capacity === 'number' && vehicle.capacity > 0 ? vehicle.capacity : (vehicle.type === 'Bus' ? 60 : 15),
    license_plate: vehicle.license_plate?.trim() || undefined,
    driver_name: vehicle.driver_name?.trim() || undefined,
    driver_phone: vehicle.driver_phone?.trim() || undefined,
    default_rep: vehicle.default_rep?.trim() || undefined,
    default_stop: vehicle.default_stop?.trim() || undefined,
    notes: vehicle.notes?.trim() || undefined,
    is_active: vehicle.is_active !== false,
    updated_at: new Date().toISOString(),
    created_at: vehicle.created_at || new Date().toISOString(),
  };

  const row = fleetVehicleToDbRow(fullVehicle);
  mockStorage.upsert(FLEET_TABLE, row, 'id');

  // Trigger browser event so any open screens re-render instantly
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('crc_fleet_updated', { detail: fullVehicle }));
  }

  // Sync to server API
  try {
    await fetch('/api/fleet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fullVehicle),
    });
  } catch {
    // Ignore server error
  }

  // Sync to Supabase directly
  try {
    await supabase.from(FLEET_TABLE).upsert(row, { onConflict: 'id' });
  } catch (err) {
    console.warn('[Fleet] Supabase upsert error:', err);
  }

  return fullVehicle;
}

/**
 * Deletes a fleet vehicle
 */
export async function deleteFleetVehicle(id: string): Promise<boolean> {
  if (!id) return false;

  const current = mockStorage.getTable(FLEET_TABLE);
  mockStorage.setTable(FLEET_TABLE, current.filter((r) => String(r.id) !== id));

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('crc_fleet_updated', { detail: { id, deleted: true } }));
  }

  try {
    await fetch(`/api/fleet/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch {
    // Ignore server error
  }

  try {
    await supabase.from(FLEET_TABLE).delete().eq('id', id);
  } catch (err) {
    console.warn('[Fleet] Supabase delete error:', err);
  }

  return true;
}
