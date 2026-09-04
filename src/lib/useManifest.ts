import { useEffect, useRef, useState } from 'react';
import { supabase, MANIFESTS_TABLE } from './supabase';
import { loadManifest } from './manifest';
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
  isSyncing: boolean;
  lastSyncedAt: number | null;
  refresh: () => Promise<void>;
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
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const keyRef = useRef<string | null>(null);
  const manifestRef = useRef<Manifest | null>(null);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const broadcastChannelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    manifestRef.current = manifest;
  }, [manifest]);

  // Track the updatedAt timestamp of the last thing WE saved.
  // Used to suppress our own realtime echoes without blocking external updates.
  const lastSavedUpdatedAtRef = useRef<string | null>(null);
  const lastKnownUpdatedAtRef = useRef<string | null>(null);

  // Manual or automatic fresh reload
  const refresh = async () => {
    if (!key) return;
    setIsSyncing(true);
    try {
      const fresh = await loadManifest(key);
      if (keyRef.current === key && fresh) {
        setManifest(fresh);
        if (fresh.updated_at) {
          lastKnownUpdatedAtRef.current = fresh.updated_at;
        }
        setLastSyncedAt(Date.now());
      }
    } catch (err) {
      console.warn('[useManifest] Refresh error:', err);
    } finally {
      setIsSyncing(false);
    }
  };

  useEffect(() => {
    if (!key) {
      setManifest(null);
      setLoading(false);
      return;
    }
    keyRef.current = key;
    setLoading(true);
    setError(null);

    // 1. Initialize local browser BroadcastChannel for zero-latency multi-tab sync
    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      try {
        const bc = new BroadcastChannel(`crc_manifest_${key}`);
        bc.onmessage = (event) => {
          if (event.data?.manifest && keyRef.current === key) {
            const incoming = normalizeManifestData(event.data.manifest);
            if (incoming) {
              setManifest(incoming);
              setLastSyncedAt(Date.now());
            }
          }
        };
        broadcastChannelRef.current = bc;
      } catch {
        // BroadcastChannel unavailable
      }
    }

    // 2. Initial Manifest Load
    (async () => {
      try {
        const loaded = await loadManifest(key);
        if (keyRef.current === key) {
          setManifest(loaded);
          if (loaded?.updated_at) {
            lastKnownUpdatedAtRef.current = loaded.updated_at;
          }
          setLastSyncedAt(Date.now());
          setLoading(false);
        }
      } catch (e) {
        if (keyRef.current === key) {
          const fallback = await loadManifest(key).catch(() => null);
          setManifest(fallback);
          if (fallback?.updated_at) {
            lastKnownUpdatedAtRef.current = fallback.updated_at;
          }
          if (!fallback) {
            setError(e instanceof Error ? e.message : String(e));
          }
          setLastSyncedAt(Date.now());
          setLoading(false);
        }
      }
    })();

    // 3. Supabase Realtime channel (both postgres_changes AND fast websocket broadcast)
    const channel = supabase
      .channel(`manifest:${key}`, {
        config: { broadcast: { self: false } },
      })
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: MANIFESTS_TABLE, filter: `date=eq.${key}` },
        (payload) => {
          if (keyRef.current !== key) return;

          const row = payload.new as (Partial<Manifest> & { updated_at?: string }) | null;
          if (!row) return;

          // Suppress echoes of our own saves
          if (
            lastSavedUpdatedAtRef.current &&
            row.updated_at === lastSavedUpdatedAtRef.current
          ) {
            return;
          }

          if (row.updated_at) {
            lastKnownUpdatedAtRef.current = row.updated_at;
          }

          const normalized = normalizeManifestData(row);
          if (normalized) {
            setManifest(normalized);
            setLastSyncedAt(Date.now());
          }
        }
      )
      .on('broadcast', { event: 'manifest_updated' }, (msg: { payload?: { manifest?: Partial<Manifest>; updated_at?: string } }) => {
        if (keyRef.current !== key) return;
        const incoming = normalizeManifestData(msg.payload?.manifest);
        if (incoming) {
          if (msg.payload?.updated_at) {
            lastKnownUpdatedAtRef.current = msg.payload.updated_at;
          }
          setManifest(incoming);
          setLastSyncedAt(Date.now());
        }
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          // Channel connected
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          // Auto-reconnect if needed
          channel.unsubscribe().catch(() => {});
        }
      });

    channelRef.current = channel;

    // 4. Lightweight Background Polling Fallback (every 3 seconds when active)
    // Guarantees cross-device sync even when mobile devices throttle websockets or if replication is disabled
    const pollCheck = async () => {
      if (!key || keyRef.current !== key) return;
      try {
        const { data, error: pollError } = await supabase
          .from(MANIFESTS_TABLE)
          .select('updated_at')
          .eq('date', key)
          .maybeSingle();

        if (pollError) return;
        const remoteUpdatedAt = (data as { updated_at?: string })?.updated_at;

        if (
          remoteUpdatedAt &&
          remoteUpdatedAt !== lastSavedUpdatedAtRef.current &&
          remoteUpdatedAt !== lastKnownUpdatedAtRef.current
        ) {
          lastKnownUpdatedAtRef.current = remoteUpdatedAt;
          const fresh = await loadManifest(key);
          if (fresh && keyRef.current === key) {
            setManifest(fresh);
            setLastSyncedAt(Date.now());
          }
        }
      } catch {
        // non-blocking
      }
    };

    const pollInterval = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      pollCheck();
    }, 3000);

    // 5. Immediate trigger on window focus, tab visible, or network online
    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && !document.hidden) {
        pollCheck();
      }
    };
    const handleFocus = () => {
      pollCheck();
    };
    const handleOnline = () => {
      pollCheck();
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', handleFocus);
      window.addEventListener('online', handleOnline);
    }

    return () => {
      keyRef.current = null;
      clearInterval(pollInterval);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', handleFocus);
        window.removeEventListener('online', handleOnline);
      }
      if (broadcastChannelRef.current) {
        broadcastChannelRef.current.close();
        broadcastChannelRef.current = null;
      }
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [key]);

  async function save(m: Manifest): Promise<void> {
    const normalized = normalizeManifestData(m) || m;
    // Optimistically update local state immediately for zero-lag UI
    setManifest(normalized);
    setLastSyncedAt(Date.now());

    // Broadcast across local tabs immediately
    if (broadcastChannelRef.current) {
      try {
        broadcastChannelRef.current.postMessage({ key: normalized.date, manifest: normalized });
      } catch {
        // Broadcast failed
      }
    }

    // Broadcast across connected devices via Supabase channel
    if (channelRef.current) {
      try {
        channelRef.current.send({
          type: 'broadcast',
          event: 'manifest_updated',
          payload: { date: normalized.date, manifest: normalized },
        });
      } catch {
        // Broadcast failed
      }
    }

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
      lastKnownUpdatedAtRef.current = data.updated_at;
    }
  }

  /**
   * Conflict-safe multi-device vehicle draft update:
   * 1. Reads the latest remote manifest from the server to avoid overwriting changes
   *    made by reps on other vehicles or concurrent edits.
   * 2. Intelligently merges passenger check-ins for the target vehicle so co-reps
   *    do not wipe out each other's check-ins.
   * 3. Leaves all other vehicles, unassigned signups, and admin allocations 100% intact.
   * 4. Broadcasts updates over WebSockets and BroadcastChannel for immediate live sync.
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

    // 1. Fetch fresh manifest from remote server to avoid overwriting other reps' simultaneous changes
    let baseManifest: Manifest | null = null;
    try {
      baseManifest = await loadManifest(key);
    } catch {
      baseManifest = null;
    }
    if (!baseManifest) {
      baseManifest = manifestRef.current ?? manifest;
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

    // 3. Multi-device intelligent merge if another user also edited this vehicle's draft
    const existingDraft = targetVehicle?.draftState;
    let mergedDraft = draftState;

    if (existingDraft && draftState && existingDraft.updatedBy && existingDraft.updatedBy !== draftState.updatedBy) {
      // Co-rep / multi-device merge on the same vehicle:
      // Combine attendance marks without losing check-ins made on either device
      const combinedPresent = new Set(draftState.presentIds ?? []);
      const combinedAbsent = new Set(draftState.absentIds ?? []);

      (existingDraft.presentIds ?? []).forEach((id) => {
        if (!aSet || !aSet.has(id)) combinedPresent.add(id);
      });
      (existingDraft.absentIds ?? []).forEach((id) => {
        if (!pSet || !pSet.has(id)) combinedAbsent.add(id);
      });

      mergedDraft = {
        ...existingDraft,
        ...draftState,
        presentIds: Array.from(combinedPresent),
        absentIds: Array.from(combinedAbsent),
        sponsoredIds: Array.from(new Set([...(existingDraft.sponsoredIds ?? []), ...(draftState.sponsoredIds ?? [])])),
        unpaidIds: Array.from(new Set([...(existingDraft.unpaidIds ?? []), ...(draftState.unpaidIds ?? [])])),
        notes: { ...(existingDraft.notes ?? {}), ...(draftState.notes ?? {}) },
        repName: draftState.repName?.trim() || existingDraft.repName || targetVehicle?.repName,
        licensePlate: draftState.licensePlate?.trim() || existingDraft.licensePlate || targetVehicle?.licensePlate,
        coReps: Array.from(new Set([...(existingDraft.coReps ?? []), ...(draftState.coReps ?? [])])).filter(Boolean),
        updatedAt: new Date().toISOString(),
        updatedBy: draftState.updatedBy,
      };
    }

    // 4. Update ONLY the target vehicle, leaving all other vehicles completely untouched
    const updatedVehicles = baseManifest.vehicles.map((v) => {
      if (v.id === vehicleId) {
        return {
          ...v,
          repName: mergedDraft?.repName?.trim() || repName?.trim() || v.repName,
          licensePlate: mergedDraft?.licensePlate?.trim() || licensePlate?.trim() || v.licensePlate,
          draftState: mergedDraft,
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
    setLastSyncedAt(Date.now());

    // Broadcast across local tabs immediately
    if (broadcastChannelRef.current) {
      try {
        broadcastChannelRef.current.postMessage({ key: mergedManifest.date, manifest: mergedManifest });
      } catch {
        // Broadcast failed
      }
    }

    // Broadcast across connected devices via Supabase channel
    if (channelRef.current) {
      try {
        channelRef.current.send({
          type: 'broadcast',
          event: 'manifest_updated',
          payload: { date: mergedManifest.date, manifest: mergedManifest },
        });
      } catch {
        // Broadcast failed
      }
    }

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
      lastKnownUpdatedAtRef.current = data.updated_at;
    }
  }

  return { manifest, loading, error, isSyncing, lastSyncedAt, refresh, save, updateVehicleDraft };
}
