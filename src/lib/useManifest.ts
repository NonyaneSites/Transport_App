import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase, MANIFESTS_TABLE } from './supabase';
import { loadManifest } from './manifest';
import type { Manifest, Vehicle, LiveSyncAction } from './types';

export interface ActiveCoRep {
  clientId: string;
  repName: string;
  lastSeen: number;
}

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
 * Intelligently merges an incoming manifest (from Supabase Realtime, broadcast, or poll)
 * with the locally active state so concurrent edits on other vehicles update seamlessly,
 * while the local rep's active vehicle working state is NEVER blown away.
 */
export function mergeIncomingManifest(
  current: Manifest | null,
  incoming: Manifest | null,
  activeVehicleId?: string
): Manifest | null {
  if (!incoming) return current;
  if (!current) return incoming;

  // If no specific vehicle is actively open for editing, incoming is authoritative
  if (!activeVehicleId) return incoming;

  const currentActiveVehicle = current.vehicles.find((v) => v.id === activeVehicleId);
  if (!currentActiveVehicle) return incoming;

  // Identify rider IDs belonging to the active vehicle
  const activeRiderIds = new Set(currentActiveVehicle.riders || []);

  // Merge vehicles: preserve active vehicle from current, but adopt all other vehicles from incoming
  const mergedVehicles = incoming.vehicles.map((incV) => {
    if (incV.id !== activeVehicleId) {
      return incV;
    }

    // It's the active vehicle:
    // If incoming vehicle has a newer draft from a co-rep (different updatedBy), merge it!
    const incDraft = incV.draftState;
    const curDraft = currentActiveVehicle.draftState;

    if (incDraft && curDraft && incDraft.updatedBy && incDraft.updatedBy !== curDraft.updatedBy) {
      const curTime = curDraft.updatedAt ? new Date(curDraft.updatedAt).getTime() : 0;
      const incTime = incDraft.updatedAt ? new Date(incDraft.updatedAt).getTime() : 0;
      if (incTime > curTime) {
        // Union attendance marks
        const combinedPresent = new Set([...(curDraft.presentIds || []), ...(incDraft.presentIds || [])]);
        const combinedAbsent = new Set([...(curDraft.absentIds || []), ...(incDraft.absentIds || [])]);
        // Absent takes precedence only if explicitly marked in incoming absent
        (incDraft.absentIds || []).forEach((id) => combinedPresent.delete(id));
        (incDraft.presentIds || []).forEach((id) => combinedAbsent.delete(id));

        return {
          ...currentActiveVehicle,
          submitted: incV.submitted || currentActiveVehicle.submitted,
          submittedAt: incV.submittedAt || currentActiveVehicle.submittedAt,
          submittedBy: incV.submittedBy || currentActiveVehicle.submittedBy,
          draftState: {
            ...curDraft,
            ...incDraft,
            presentIds: Array.from(combinedPresent),
            absentIds: Array.from(combinedAbsent),
            sponsoredIds: Array.from(new Set([...(curDraft.sponsoredIds || []), ...(incDraft.sponsoredIds || [])])),
            unpaidIds: Array.from(new Set([...(curDraft.unpaidIds || []), ...(incDraft.unpaidIds || [])])),
            notes: { ...(curDraft.notes || {}), ...(incDraft.notes || {}) },
          },
        };
      }
    }

    // Preserve local active vehicle state
    return {
      ...currentActiveVehicle,
      // If remote submitted status changed, respect that
      submitted: incV.submitted !== undefined ? incV.submitted : currentActiveVehicle.submitted,
      submittedAt: incV.submittedAt || currentActiveVehicle.submittedAt,
      submittedBy: incV.submittedBy || currentActiveVehicle.submittedBy,
    };
  });

  // Merge signups: keep local active vehicle's riders intact, update all other passengers from incoming
  const mergedSignups = incoming.signups.map((incP) => {
    if (activeRiderIds.has(incP.id)) {
      const curP = current.signups.find((p) => p.id === incP.id);
      return curP || incP;
    }
    return incP;
  });

  return {
    ...incoming,
    signups: mergedSignups,
    vehicles: mergedVehicles,
  };
}

export function useManifest(
  key: string | null,
  activeVehicleId?: string,
  onLiveAction?: (action: LiveSyncAction) => void
): {
  manifest: Manifest | null;
  loading: boolean;
  error: string | null;
  isSyncing: boolean;
  lastSyncedAt: number | null;
  activeCoReps: ActiveCoRep[];
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
  broadcastLiveAction: (action: LiveSyncAction) => void;
} {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeCoReps, setActiveCoReps] = useState<ActiveCoRep[]>([]);
  const activeCoRepsMapRef = useRef<Map<string, ActiveCoRep>>(new Map());
  const onLiveActionRef = useRef(onLiveAction);

  useEffect(() => {
    onLiveActionRef.current = onLiveAction;
  }, [onLiveAction]);

  const keyRef = useRef<string | null>(null);
  const manifestRef = useRef<Manifest | null>(null);
  const activeVehicleIdRef = useRef<string | undefined>(activeVehicleId);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const broadcastChannelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    manifestRef.current = manifest;
  }, [manifest]);

  useEffect(() => {
    activeVehicleIdRef.current = activeVehicleId;
    activeCoRepsMapRef.current.clear();
    setActiveCoReps([]);
  }, [activeVehicleId]);

  // Periodically prune stale co-reps (inactive for > 20 seconds)
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      let changed = false;
      activeCoRepsMapRef.current.forEach((val, cId) => {
        if (now - val.lastSeen > 20000) {
          activeCoRepsMapRef.current.delete(cId);
          changed = true;
        }
      });
      if (changed) {
        setActiveCoReps(Array.from(activeCoRepsMapRef.current.values()));
      }
    }, 4000);
    return () => clearInterval(interval);
  }, []);

  const handleIncomingLiveAction = useCallback((action: LiveSyncAction) => {
    if (!action) return;
    setLastSyncedAt(Date.now());

    // If this action is for our currently active vehicle, track co-rep presence
    if (activeVehicleIdRef.current && action.vehicleId === activeVehicleIdRef.current) {
      if (action.repName && action.clientId) {
        activeCoRepsMapRef.current.set(action.clientId, {
          clientId: action.clientId,
          repName: action.repName,
          lastSeen: Date.now(),
        });
        setActiveCoReps(Array.from(activeCoRepsMapRef.current.values()));
      }
    }

    onLiveActionRef.current?.(action);
  }, []);

  const broadcastLiveAction = useCallback((action: LiveSyncAction) => {
    if (!keyRef.current) return;
    if (broadcastChannelRef.current) {
      try {
        broadcastChannelRef.current.postMessage({ type: 'live_action', action });
      } catch {
        // Broadcast failed
      }
    }
    if (channelRef.current) {
      try {
        channelRef.current.send({
          type: 'broadcast',
          event: 'live_action',
          payload: action,
        });
      } catch {
        // Send failed
      }
    }
  }, []);

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
          if (keyRef.current !== key || !event.data) return;

          if (event.data.type === 'live_action' && event.data.action) {
            handleIncomingLiveAction(event.data.action);
            return;
          }

          if (event.data.type === 'vehicle_draft_delta' && event.data.vehicleId && event.data.draftState) {
            const { vehicleId, draftState, repName, licensePlate } = event.data;
            setManifest((prev) => {
              if (!prev) return prev;
              const isTargetActive = activeVehicleIdRef.current === vehicleId;
              const updatedVehicles = prev.vehicles.map((v) => {
                if (v.id !== vehicleId) return v;
                if (isTargetActive && v.draftState?.updatedBy === draftState.updatedBy) return v;
                return {
                  ...v,
                  draftState,
                  repName: repName?.trim() || draftState.repName?.trim() || v.repName,
                  licensePlate: licensePlate?.trim() || draftState.licensePlate?.trim() || v.licensePlate,
                };
              });
              return { ...prev, vehicles: updatedVehicles };
            });
            setLastSyncedAt(Date.now());
            return;
          }

          if (event.data.manifest) {
            const incoming = normalizeManifestData(event.data.manifest);
            if (incoming) {
              setManifest((prev) => mergeIncomingManifest(prev, incoming, activeVehicleIdRef.current));
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
          setManifest((prev) => mergeIncomingManifest(prev, loaded, activeVehicleIdRef.current));
          if (loaded?.updated_at) {
            lastKnownUpdatedAtRef.current = loaded.updated_at;
          }
          setLastSyncedAt(Date.now());
          setLoading(false);
        }
      } catch (e) {
        if (keyRef.current === key) {
          const fallback = await loadManifest(key).catch(() => null);
          setManifest((prev) => mergeIncomingManifest(prev, fallback, activeVehicleIdRef.current));
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
            setManifest((prev) => mergeIncomingManifest(prev, normalized, activeVehicleIdRef.current));
            setLastSyncedAt(Date.now());
          }
        }
      )
      .on('broadcast', { event: 'vehicle_draft_delta' }, (msg: {
        payload?: {
          vehicleId?: string;
          draftState?: Vehicle['draftState'];
          repName?: string;
          licensePlate?: string;
        };
      }) => {
        if (keyRef.current !== key || !msg.payload) return;
        const { vehicleId, draftState, repName, licensePlate } = msg.payload;
        if (!vehicleId || !draftState) return;

        setManifest((prev) => {
          if (!prev) return prev;
          const isTargetActive = activeVehicleIdRef.current === vehicleId;
          const updatedVehicles = prev.vehicles.map((v) => {
            if (v.id !== vehicleId) return v;
            // If it's our own active vehicle and same author, don't clobber
            if (isTargetActive && v.draftState?.updatedBy === draftState.updatedBy) return v;
            return {
              ...v,
              draftState,
              repName: repName?.trim() || draftState.repName?.trim() || v.repName,
              licensePlate: licensePlate?.trim() || draftState.licensePlate?.trim() || v.licensePlate,
            };
          });
          return { ...prev, vehicles: updatedVehicles };
        });
        setLastSyncedAt(Date.now());
      })
      .on('broadcast', { event: 'live_action' }, (msg: { payload?: LiveSyncAction }) => {
        if (keyRef.current !== key || !msg.payload) return;
        handleIncomingLiveAction(msg.payload);
      })
      .on('broadcast', { event: 'manifest_updated' }, (msg: { payload?: { manifest?: Partial<Manifest>; updated_at?: string } }) => {
        if (keyRef.current !== key) return;
        const incoming = normalizeManifestData(msg.payload?.manifest);
        if (incoming) {
          if (msg.payload?.updated_at) {
            lastKnownUpdatedAtRef.current = msg.payload.updated_at;
          }
          setManifest((prev) => mergeIncomingManifest(prev, incoming, activeVehicleIdRef.current));
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

    // 4. Lightweight Background Polling Fallback
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
            setManifest((prev) => mergeIncomingManifest(prev, fresh, activeVehicleIdRef.current));
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
    }, 4000);

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
  }, [key, handleIncomingLiveAction]);

  async function save(m: Manifest): Promise<void> {
    const normalized = normalizeManifestData(m) || m;
    if (!normalized || !key) return;

    // Fetch latest remote row to safely merge any other vehicles submitted or edited concurrently
    let finalToSave = normalized;
    try {
      const { data: latestRow } = await supabase
        .from(MANIFESTS_TABLE)
        .select('date, signups, vehicles, updated_at')
        .eq('date', key)
        .maybeSingle();

      if (latestRow) {
        const remoteNorm = normalizeManifestData(latestRow);
        if (remoteNorm) {
          const mergedVehicles = normalized.vehicles.map((localV) => {
            const remoteV = remoteNorm.vehicles.find((rv) => rv.id === localV.id);
            if (!remoteV) return localV;
            // If remote vehicle was already submitted or newer and local is not submitting this vehicle:
            if (remoteV.submitted && !localV.submitted) {
              return remoteV;
            }
            return localV;
          });

          // Also retain any vehicles that exist remotely but not locally
          remoteNorm.vehicles.forEach((rv) => {
            if (!mergedVehicles.some((mv) => mv.id === rv.id)) {
              mergedVehicles.push(rv);
            }
          });

          finalToSave = {
            ...normalized,
            vehicles: mergedVehicles,
          };
        }
      }
    } catch {
      // fallback to normalized
    }

    // Optimistically update local state immediately for zero-lag UI
    setManifest((prev) => mergeIncomingManifest(prev, finalToSave, activeVehicleIdRef.current));
    setLastSyncedAt(Date.now());

    // Broadcast across local tabs immediately
    if (broadcastChannelRef.current) {
      try {
        broadcastChannelRef.current.postMessage({ key: finalToSave.date, manifest: finalToSave });
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
          payload: { date: finalToSave.date, manifest: finalToSave },
        });
      } catch {
        // Broadcast failed
      }
    }

    const { error: upsertError, data } = await supabase
      .from(MANIFESTS_TABLE)
      .upsert(
        {
          date: finalToSave.date,
          signups: finalToSave.signups,
          vehicles: finalToSave.vehicles,
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

  /**
   * Conflict-safe multi-device vehicle draft update:
   * 1. Reads the latest remote manifest from the server to avoid overwriting changes
   *    made by reps on other vehicles or concurrent edits.
   * 2. Intelligently merges passenger check-ins for the target vehicle so co-reps
   *    do not wipe out each other's check-ins.
   * 3. Leaves all other vehicles, unassigned signups, and admin allocations 100% intact.
   * 4. Broadcasts targeted vehicle delta updates over WebSockets and BroadcastChannel.
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

    // 1. Fetch fresh manifest directly from remote server to preserve concurrent edits on OTHER vehicles
    let remoteManifest: Manifest | null = null;
    try {
      const { data: latestRow, error: fetchErr } = await supabase
        .from(MANIFESTS_TABLE)
        .select('date, signups, vehicles, updated_at')
        .eq('date', key)
        .maybeSingle();

      if (!fetchErr && latestRow) {
        remoteManifest = normalizeManifestData(latestRow);
      }
    } catch {
      remoteManifest = null;
    }

    if (!remoteManifest) {
      remoteManifest = manifestRef.current ?? manifest;
    }
    if (!remoteManifest) return;

    const pSet = presentIds ? new Set(presentIds) : (draftState?.presentIds ? new Set(draftState.presentIds) : null);
    const aSet = absentIds ? new Set(absentIds) : (draftState?.absentIds ? new Set(draftState.absentIds) : null);

    // 2. Only modify the present/absent flag of THIS specific vehicle's passengers
    const targetVehicle = remoteManifest.vehicles.find((v) => v.id === vehicleId);
    const vehicleRiderSet = new Set(targetVehicle?.riders ?? []);

    const updatedSignups = remoteManifest.signups.map((p) => {
      if (vehicleRiderSet.has(p.id)) {
        if (pSet && pSet.has(p.id)) return { ...p, present: true };
        if (aSet && aSet.has(p.id)) return { ...p, present: false };
      }
      return p;
    });

    // 3. Multi-device intelligent merge if another user edited this same vehicle's draft
    const existingDraft = targetVehicle?.draftState;
    let mergedDraft = draftState;

    if (existingDraft && draftState && existingDraft.updatedBy && existingDraft.updatedBy !== draftState.updatedBy) {
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
        updatedAt: draftState.updatedAt || new Date().toISOString(),
        updatedBy: draftState.updatedBy,
      };
    }

    // 4. Update ONLY the target vehicle, leaving all other vehicles completely untouched from the remote DB
    const updatedVehicles = remoteManifest.vehicles.map((v) => {
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
      ...remoteManifest,
      signups: updatedSignups,
      vehicles: updatedVehicles,
    };

    setManifest((prev) => mergeIncomingManifest(prev, mergedManifest, activeVehicleIdRef.current));
    setLastSyncedAt(Date.now());

    // Broadcast targeted vehicle delta across local tabs
    if (broadcastChannelRef.current) {
      try {
        broadcastChannelRef.current.postMessage({
          type: 'vehicle_draft_delta',
          key: mergedManifest.date,
          vehicleId,
          draftState: mergedDraft,
          repName: mergedDraft?.repName || repName,
          licensePlate: mergedDraft?.licensePlate || licensePlate,
          manifest: mergedManifest,
        });
      } catch {
        // Broadcast failed
      }
    }

    // Broadcast targeted vehicle delta across connected devices via Supabase channel
    if (channelRef.current) {
      try {
        channelRef.current.send({
          type: 'broadcast',
          event: 'vehicle_draft_delta',
          payload: {
            vehicleId,
            draftState: mergedDraft,
            repName: mergedDraft?.repName || repName,
            licensePlate: mergedDraft?.licensePlate || licensePlate,
          },
        });
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

  return {
    manifest,
    loading,
    error,
    isSyncing,
    lastSyncedAt,
    activeCoReps,
    refresh,
    save,
    updateVehicleDraft,
    broadcastLiveAction,
  };
}
