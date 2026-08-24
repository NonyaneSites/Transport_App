import { useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';
import { MANIFESTS_TABLE } from './supabase';
import type { Manifest, Vehicle } from './types';

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

export function useManifest(key: string | null): {
  manifest: Manifest | null;
  loading: boolean;
  error: string | null;
  save: (m: Manifest) => Promise<void>;
  updateVehicleDraft: (
    vehicleId: string,
    draftState: Vehicle['draftState'],
    repName?: string,
    licensePlate?: string,
    presentIds?: string[],
    absentIds?: string[]
  ) => Promise<void>;
} {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const keyRef = useRef<string | null>(null);

  // Track the updatedAt timestamp of the last thing WE saved.
  // Used to suppress our own realtime echoes without blocking external updates.
  const lastSavedUpdatedAtRef = useRef<string | null>(null);

  useEffect(() => {
    if (!key) {
      setManifest(null);
      setLoading(false);
      return;
    }
    keyRef.current = key;
    setLoading(true);
    setError(null);

    let channel: ReturnType<typeof supabase.channel> | null = null;

    (async () => {
      try {
        const { data, error: loadError } = await supabase
          .from(MANIFESTS_TABLE)
          .select('date, signups, vehicles, created_at, updated_at')
          .eq('date', key)
          .maybeSingle();
        if (loadError) throw loadError;
        if (keyRef.current === key) {
          setManifest(normalizeManifestData(data));
          setLoading(false);
        }
      } catch (e) {
        if (keyRef.current === key) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    })();

    channel = supabase
      .channel(`manifest:${key}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: MANIFESTS_TABLE, filter: `date=eq.${key}` },
        (payload) => {
          if (keyRef.current !== key) return;

          const row = payload.new as (Partial<Manifest> & { updated_at?: string }) | null;
          if (!row) return;

          // Suppress echoes of our own saves only — external updates (e.g. from the
          // Admin page) must always flow through so the Rep sees them immediately.
          // We identify our own echo by comparing the DB-assigned updated_at timestamp
          // against the one we received back from our most recent save.
          if (
            lastSavedUpdatedAtRef.current &&
            row.updated_at === lastSavedUpdatedAtRef.current
          ) {
            return;
          }

          const normalized = normalizeManifestData(row);
          if (normalized) {
            setManifest(normalized);
          }
        }
      )
      .subscribe();

    return () => {
      keyRef.current = null;
      if (channel) supabase.removeChannel(channel);
    };
  }, [key]);

  async function save(m: Manifest): Promise<void> {
    const normalized = normalizeManifestData(m) || m;
    // Optimistically update local state immediately for zero-lag UI
    setManifest(normalized);
    const { error: upsertError, data } = await supabase
      .from(MANIFESTS_TABLE)
      .upsert(
        {
          date: normalized.date,
          signups: normalized.signups,
          vehicles: normalized.vehicles,
        },
        { onConflict: 'date' }
      )
      .select('updated_at')
      .single();
    if (upsertError) throw upsertError;
    // Record the server-assigned updated_at so we can suppress only our own echo
    if (data?.updated_at) {
      lastSavedUpdatedAtRef.current = data.updated_at;
    }
  }

  /**
   * Conflict-safe vehicle draft update:
   * Merges changes strictly for `vehicleId` without overwriting other vehicles,
   * unassigned signups, or admin allocations that might have occurred concurrently.
   */
  async function updateVehicleDraft(
    vehicleId: string,
    draftState: Vehicle['draftState'],
    repName?: string,
    licensePlate?: string,
    presentIds?: string[],
    absentIds?: string[]
  ): Promise<void> {
    if (!key) return;

    // 1. Fetch latest server row to avoid stale manifest overwrites
    let baseManifest: Manifest | null = manifest;
    try {
      const { data: latestRow } = await supabase
        .from(MANIFESTS_TABLE)
        .select('date, signups, vehicles, created_at, updated_at')
        .eq('date', key)
        .maybeSingle();
      if (latestRow) {
        baseManifest = normalizeManifestData(latestRow);
      }
    } catch {
      /* fallback to local baseManifest */
    }

    if (!baseManifest) return;

    const pSet = presentIds ? new Set(presentIds) : null;
    const aSet = absentIds ? new Set(absentIds) : null;

    // 2. Only modify the present/absent flag of this specific vehicle's passengers
    const targetVehicle = baseManifest.vehicles.find((v) => v.id === vehicleId);
    const vehicleRiderSet = new Set(targetVehicle?.riders ?? []);

    const updatedSignups = baseManifest.signups.map((p) => {
      if (vehicleRiderSet.has(p.id)) {
        if (pSet && pSet.has(p.id)) return { ...p, present: true };
        if (aSet && aSet.has(p.id)) return { ...p, present: false };
      }
      return p;
    });

    // 3. Only update the target vehicle's draft state, leaving other vehicles untouched
    const updatedVehicles = baseManifest.vehicles.map((v) => {
      if (v.id === vehicleId) {
        return {
          ...v,
          repName: repName?.trim() || v.repName,
          licensePlate: licensePlate?.trim() || v.licensePlate,
          draftState,
        };
      }
      return v;
    });

    const mergedManifest: Manifest = {
      ...baseManifest,
      signups: updatedSignups,
      vehicles: updatedVehicles,
    };

    setManifest(mergedManifest);

    const { error: upsertError, data } = await supabase
      .from(MANIFESTS_TABLE)
      .upsert(
        {
          date: mergedManifest.date,
          signups: mergedManifest.signups,
          vehicles: mergedManifest.vehicles,
        },
        { onConflict: 'date' }
      )
      .select('updated_at')
      .single();

    if (upsertError) throw upsertError;
    if (data?.updated_at) {
      lastSavedUpdatedAtRef.current = data.updated_at;
    }
  }

  return { manifest, loading, error, save, updateVehicleDraft };
}
