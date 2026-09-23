import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase, MANIFESTS_TABLE, VEHICLES_TABLE, mockStorage } from './supabase';
import {
  loadManifest,
  normalizeManifestData,
  applyWalkInToManifest,
  reconcileManifestForSave,
  saveVehicleToDb,
  syncVehiclesToDb,
  dbRowToVehicle,
  resetManifest,
} from './manifest';
import { saveManifestToServer } from './serverApi';
import type { Manifest, Vehicle, Passenger, VehicleDraftState, LiveSyncAction } from './types';

export interface ActiveCoRep {
  clientId: string;
  repName: string;
  lastSeen: number;
}

export { normalizeManifestData };

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
  // CRITICAL: Strict session boundary. If current and incoming are for different dates/manifest keys,
  // NEVER merge! The incoming manifest is the only valid state for its date and service.
  if (!current || current.date !== incoming.date) return incoming;

  // If no specific vehicle is actively open for editing, incoming is authoritative,
  // but protect submitted vehicles from being accidentally un-submitted by stale broadcasts
  if (!activeVehicleId) {
    const currentVehMap = new Map((current?.vehicles || []).map((v) => [v.id, v]));
    const safeVehicles = incoming.vehicles.map((incV) => {
      const curV = currentVehMap.get(incV.id);
      if (curV?.submitted && !incV.submitted) {
        return {
          ...incV,
          submitted: true,
          submittedAt: curV.submittedAt || incV.submittedAt,
          submittedBy: curV.submittedBy || incV.submittedBy,
        };
      }
      return incV;
    });
    return {
      ...incoming,
      vehicles: safeVehicles,
    };
  }

  const currentActiveVehicle = current.vehicles.find((v) => v.id === activeVehicleId);
  if (!currentActiveVehicle) return incoming;

  // Merge vehicles: adopt authoritative remote draftState and riders from server / admin allocation
  const mergedVehicles = incoming.vehicles.map((incV) => {
    if (incV.id !== activeVehicleId) {
      return incV;
    }

    // It's the active vehicle: incoming riders from admin allocation is authoritative!
    // NEVER resurrect riders that were removed or unassigned.
    const activeRiders = Array.isArray(incV.riders) ? incV.riders : [];
    const activeRiderSet = new Set(activeRiders);

    const incDraft = incV.draftState;
    const curDraft = currentActiveVehicle.draftState;

    // Prune any draft presence/absence for riders that are no longer in this vehicle
    const cleanDraftState: VehicleDraftState = incDraft
      ? {
          ...(curDraft || {}),
          ...incDraft,
          presentIds: (incDraft.presentIds !== undefined ? incDraft.presentIds : (curDraft?.presentIds || [])).filter((id) => activeRiderSet.has(id)),
          absentIds: (incDraft.absentIds !== undefined ? incDraft.absentIds : (curDraft?.absentIds || [])).filter((id) => activeRiderSet.has(id)),
          sponsoredIds: (incDraft.sponsoredIds !== undefined ? incDraft.sponsoredIds : (curDraft?.sponsoredIds || [])).filter((id) => activeRiderSet.has(id)),
          unpaidIds: (incDraft.unpaidIds !== undefined ? incDraft.unpaidIds : (curDraft?.unpaidIds || [])).filter((id) => activeRiderSet.has(id)),
          absentPaidIds: (incDraft.absentPaidIds !== undefined ? incDraft.absentPaidIds : (curDraft?.absentPaidIds || [])).filter((id) => activeRiderSet.has(id)),
          notes: Object.fromEntries(
            Object.entries({ ...(curDraft?.notes || {}), ...(incDraft.notes || {}) }).filter(([k]) => activeRiderSet.has(k))
          ),
          updatedAt: incDraft.updatedAt || curDraft?.updatedAt || new Date().toISOString(),
          updatedBy: incDraft.updatedBy || curDraft?.updatedBy,
        }
      : (curDraft || {});

    return {
      ...incV,
      riders: activeRiders,
      orderedStops: incV.orderedStops || currentActiveVehicle.orderedStops || [],
      submitted: Boolean(incV.submitted || currentActiveVehicle.submitted),
      submittedAt: incV.submittedAt || currentActiveVehicle.submittedAt,
      submittedBy: incV.submittedBy || currentActiveVehicle.submittedBy,
      draftState: cleanDraftState,
    };
  });

  // Merge signups: ensure newly created walk-in signups on this active vehicle are preserved,
  // but DO NOT resurrect signups that were deleted or moved to another service on the server!
  const incomingIds = new Set(incoming.signups.map((p) => p.id));
  const localOnlySignups = current.signups.filter(
    (p) => !incomingIds.has(p.id) && p.walkIn && currentActiveVehicle?.riders?.includes(p.id)
  );

  return {
    ...incoming,
    signups: [...incoming.signups, ...localOnlySignups],
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
  reset: () => Promise<void>;
  updateVehicleDraft: (
    vehicleId: string,
    draftState: Vehicle['draftState'],
    repName?: string,
    licensePlate?: string,
    presentIds?: string[],
    absentIds?: string[]
  ) => Promise<void>;
  appendWalkIn: (
    vehicleId: string,
    newPassenger: Passenger,
    draftUpdate?: Partial<Vehicle['draftState']>
  ) => Promise<Manifest>;
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

  // Periodically prune stale co-reps (inactive for > 35 seconds)
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      let changed = false;
      activeCoRepsMapRef.current.forEach((val, cId) => {
        if (now - val.lastSeen > 35000) {
          activeCoRepsMapRef.current.delete(cId);
          changed = true;
        }
      });
      if (changed) {
        setActiveCoReps(Array.from(activeCoRepsMapRef.current.values()));
      }
    }, 5000);
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

  const isChannelSubscribedRef = useRef(false);

  const safeChannelSend = useCallback((payload: { type: 'broadcast'; event: string; payload: unknown }) => {
    if (!channelRef.current) return;
    try {
      const ch = channelRef.current as unknown as {
        state?: string;
        channelAdapter?: { canPush?: () => boolean };
        send?: (p: unknown) => Promise<unknown>;
        httpSend?: (event: string, payload: unknown, opts?: unknown) => Promise<unknown>;
      };
      const canPush = typeof ch.channelAdapter?.canPush === 'function'
        ? Boolean(ch.channelAdapter.canPush())
        : ch.state === 'joined';

      if (canPush) {
        ch.send?.(payload)?.catch?.(() => {});
      } else if (typeof ch.httpSend === 'function') {
        const eventName = payload.event || 'broadcast';
        const eventData = payload.payload !== undefined && payload.payload !== null
          ? payload.payload
          : {};
        ch.httpSend(eventName, eventData)?.catch?.(() => {});
      } else if (typeof ch.send === 'function') {
        ch.send(payload)?.catch?.(() => {});
      }
    } catch {
      // Send failed non-critically
    }
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
    safeChannelSend({
      type: 'broadcast',
      event: 'live_action',
      payload: action,
    });
  }, [safeChannelSend]);

  // Track the updatedAt timestamp of the last thing WE saved.
  // Used to suppress our own realtime echoes without blocking external updates.
  const lastSavedUpdatedAtRef = useRef<string | null>(null);
  const lastKnownUpdatedAtRef = useRef<string | null>(null);
  const lastLocalSaveTimeRef = useRef<number>(0);

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
    // CRITICAL: Immediately clear out any previous date's manifest from state so it never bleeds over!
    setManifest(null);
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
              if (!prev || prev.date !== key) return prev;
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
            if (incoming && incoming.date === key) {
              setManifest((prev) => (prev && prev.date === key ? mergeIncomingManifest(prev, incoming, activeVehicleIdRef.current) : incoming));
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
          if (loaded) {
            setManifest((prev) => (prev && prev.date === key ? mergeIncomingManifest(prev, loaded, activeVehicleIdRef.current) : loaded));
            if (loaded.updated_at) {
              lastKnownUpdatedAtRef.current = loaded.updated_at;
            }
          } else {
            // New or empty date session: initialize an isolated, clean empty manifest!
            setManifest((prev) => (prev && prev.date === key ? prev : { date: key, signups: [], vehicles: [] }));
          }
          setLastSyncedAt(Date.now());
          setLoading(false);
        }
      } catch (e) {
        if (keyRef.current === key) {
          const fallback = await loadManifest(key).catch(() => null);
          if (fallback) {
            setManifest((prev) => (prev && prev.date === key ? mergeIncomingManifest(prev, fallback, activeVehicleIdRef.current) : fallback));
            if (fallback.updated_at) {
              lastKnownUpdatedAtRef.current = fallback.updated_at;
            }
          } else {
            setManifest((prev) => (prev && prev.date === key ? prev : { date: key, signups: [], vehicles: [] }));
          }
          if (!fallback) {
            setError(e instanceof Error ? e.message : String(e));
          }
          setLastSyncedAt(Date.now());
          setLoading(false);
        }
      }
    })();

    // 3. Supabase Realtime channel setup (both postgres_changes AND fast websocket broadcast)
    const setupChannel = () => {
      if (!key || keyRef.current !== key) return;
      if (channelRef.current) {
        try {
          supabase.removeChannel(channelRef.current);
        } catch {
          // ignore
        }
        channelRef.current = null;
      }

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

            // Suppress echoes of our own recent saves
            if (Date.now() - lastLocalSaveTimeRef.current < 4000) {
              return;
            }

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
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: VEHICLES_TABLE, filter: `manifest_key=eq.${key}` },
          (payload) => {
            if (keyRef.current !== key) return;
            // Suppress echoes of our own recent saves
            if (Date.now() - lastLocalSaveTimeRef.current < 4000) {
              return;
            }

            const row = payload.new as Record<string, unknown> | null;
            if (!row || !row.id) return;
            const incomingVehicle = dbRowToVehicle(row);

            setManifest((prev) => {
              if (!prev || prev.date !== key) return prev;
              const isTargetActive = activeVehicleIdRef.current === incomingVehicle.id;
              const idx = prev.vehicles.findIndex((v) => v.id === incomingVehicle.id);
              let updatedVehicles: Vehicle[];
              if (idx !== -1) {
                if (isTargetActive && prev.vehicles[idx].draftState?.updatedBy === incomingVehicle.draftState?.updatedBy) {
                  return prev;
                }
                updatedVehicles = [...prev.vehicles];
                updatedVehicles[idx] = incomingVehicle;
              } else {
                updatedVehicles = [...prev.vehicles, incomingVehicle];
              }
              return { ...prev, vehicles: updatedVehicles };
            });
            setLastSyncedAt(Date.now());
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
        });

      (channel as unknown as { on: (event: string, filter: unknown, cb: (msg: { payload?: unknown }) => void) => typeof channel })
        .on('broadcast', { event: 'live_action' }, (msg: { payload?: unknown }) => {
          if (keyRef.current !== key || !msg.payload) return;
          handleIncomingLiveAction(msg.payload as LiveSyncAction);
        })
        .on('broadcast', { event: 'manifest_updated' }, (msg: { payload?: unknown }) => {
          if (keyRef.current !== key) return;
          const typedMsg = msg.payload as { manifest?: Partial<Manifest>; updated_at?: string } | undefined;
          const incoming = normalizeManifestData(typedMsg?.manifest);
          if (incoming) {
            if (typedMsg?.updated_at) {
              lastKnownUpdatedAtRef.current = typedMsg.updated_at;
            }
            setManifest((prev) => mergeIncomingManifest(prev, incoming, activeVehicleIdRef.current));
            setLastSyncedAt(Date.now());
          }
        })
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            isChannelSubscribedRef.current = true;
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            isChannelSubscribedRef.current = false;
          }
        });

      channelRef.current = channel;
    };

    setupChannel();

    // 4. Lightweight Background Polling Fallback
    // Guarantees cross-device sync even when mobile devices throttle websockets or if replication is disabled
    const pollCheck = async () => {
      if (!key || keyRef.current !== key) return;
      if (Date.now() - lastLocalSaveTimeRef.current < 5000) return;
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
    }, 15000);

    // 5. Trigger on tab visible, network online, or pageshow (guarded against overwriting local saves):
    const handleResume = async () => {
      if (!key || keyRef.current !== key) return;
      if (Date.now() - lastLocalSaveTimeRef.current < 5000) return;

      // Reconnect websocket if dropped or disconnected
      if (!isChannelSubscribedRef.current) {
        setupChannel();
      }

      // Force an immediate fresh reload from server
      try {
        const fresh = await loadManifest(key);
        if (fresh && keyRef.current === key) {
          if (fresh.updated_at) {
            lastKnownUpdatedAtRef.current = fresh.updated_at;
          }
          manifestRef.current = fresh;
          setManifest((prev) => mergeIncomingManifest(prev, fresh, activeVehicleIdRef.current));
          setLastSyncedAt(Date.now());
          if (broadcastChannelRef.current) {
            try {
              broadcastChannelRef.current.postMessage({ key: fresh.date, manifest: fresh });
            } catch {
              // broadcast failed
            }
          }
        }
      } catch (err) {
        console.warn('[useManifest] Error during resume refresh:', err);
      }
    };

    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && !document.hidden) {
        handleResume();
      }
    };
    const handleOnline = () => {
      handleResume();
    };
    const handlePageShow = () => {
      handleResume();
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', handleOnline);
      window.addEventListener('pageshow', handlePageShow);
    }

    return () => {
      keyRef.current = null;
      clearInterval(pollInterval);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', handleOnline);
        window.removeEventListener('pageshow', handlePageShow);
      }
      if (broadcastChannelRef.current) {
        broadcastChannelRef.current.close();
        broadcastChannelRef.current = null;
      }
      if (channelRef.current) {
        isChannelSubscribedRef.current = false;
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [key, handleIncomingLiveAction]);

  async function save(m: Manifest): Promise<void> {
    const normalized = normalizeManifestData(m) || m;
    if (!normalized || !key) return;

    // Strict boundary: Never save a manifest whose date does not match the active session key
    if (normalized.date !== key) {
      console.warn(`[useManifest] Refusing cross-date save attempt: manifest date '${normalized.date}' does not match active session key '${key}'`);
      return;
    }

    // Capture what this caller believed was true BEFORE its own edit, so we can tell the
    // difference between "this is what I intentionally changed" and "this is stale data I
    // never touched" once we reconcile against the freshest copy of the row below.
    const baseline = manifestRef.current;
    manifestRef.current = normalized;
    lastLocalSaveTimeRef.current = Date.now();

    // 1. Optimistically update local state immediately for zero-lag UI
    setManifest(normalized);
    setLastSyncedAt(Date.now());

    // 2. Fetch the freshest possible copy of the row and reconcile
    let merged = normalized;
    try {
      // Load complete remote manifest including individual vehicles from transport_vehicles
      const remote = await loadManifest(key).catch(() => null);
      if (remote && remote.date === key) {
        merged = reconcileManifestForSave(baseline, normalized, remote);
      }
    } catch (err) {
      console.warn('[useManifest] Could not fetch latest manifest before saving, saving as-is:', err);
    }

    // 3. Broadcast across local browser tabs immediately
    if (broadcastChannelRef.current) {
      try {
        broadcastChannelRef.current.postMessage({ key: merged.date, manifest: merged });
      } catch {
        // Broadcast failed
      }
    }

    // 4. Broadcast across connected devices via Supabase channel
    safeChannelSend({
      type: 'broadcast',
      event: 'manifest_updated',
      payload: { date: merged.date, manifest: merged },
    });

    // 5. Update local state and timestamp with the authoritative reconciled result
    manifestRef.current = merged;
    lastLocalSaveTimeRef.current = Date.now();
    setManifest(merged);

    // 6. Persist the reconciled manifest to Supabase (source of truth), with local fallback
    try {
      // Also persist each vehicle individually to transport_vehicles for granular control
      await syncVehiclesToDb(merged.date, merged.vehicles).catch((err) => {
        console.warn('[useManifest] Error saving individual vehicles:', err);
      });

      // Also persist to server endpoint for instant multi-client replication
      saveManifestToServer(merged).catch(() => {});

      const { error: upsertError, data } = await supabase
        .from(MANIFESTS_TABLE)
        .upsert(
          {
            date: merged.date,
            signups: merged.signups,
            vehicles: merged.vehicles,
          },
          { onConflict: 'date' }
        )
        .select('updated_at')
        .maybeSingle();

      if (upsertError) {
        console.warn('[useManifest] Supabase upsert error, syncing to local storage:', upsertError);
        mockStorage.upsert(MANIFESTS_TABLE, {
          date: merged.date,
          signups: merged.signups,
          vehicles: merged.vehicles,
          updated_at: new Date().toISOString(),
        });
      } else if (data?.updated_at) {
        lastSavedUpdatedAtRef.current = data.updated_at;
        lastKnownUpdatedAtRef.current = data.updated_at;
      }
    } catch (err) {
      console.warn('[useManifest] Exception during supabase save, falling back locally:', err);
      mockStorage.upsert(MANIFESTS_TABLE, {
        date: merged.date,
        signups: merged.signups,
        vehicles: merged.vehicles,
        updated_at: new Date().toISOString(),
      });
    }
  }

  async function reset(): Promise<void> {
    if (!key) return;
    const emptyManifest: Manifest = {
      date: key,
      signups: [],
      vehicles: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    lastLocalSaveTimeRef.current = Date.now();
    // 1. Clear local state immediately
    manifestRef.current = emptyManifest;
    setManifest(emptyManifest);
    setLastSyncedAt(Date.now());

    // 2. Broadcast across browser tabs
    if (broadcastChannelRef.current) {
      try {
        broadcastChannelRef.current.postMessage({ key, manifest: emptyManifest });
      } catch {
        // ignore
      }
    }

    // 3. Broadcast across connected devices via channel
    safeChannelSend({
      type: 'broadcast',
      event: 'manifest_updated',
      payload: { date: key, manifest: emptyManifest },
    });

    // 4. Wipe from backend / DB
    await resetManifest(key);
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
      remoteManifest = await loadManifest(key).catch(() => null);
    } catch {
      remoteManifest = null;
    }

    if (!remoteManifest) {
      remoteManifest = manifestRef.current ?? manifest;
    }
    if (!remoteManifest) return;

    // 2. Multi-device intelligent merge if another user edited this same vehicle's draft
    const targetVehicle = remoteManifest.vehicles.find((v) => v.id === vehicleId);
    const vehicleRiderSet = new Set(targetVehicle?.riders ?? []);
    const existingDraft = targetVehicle?.draftState;
    const localPresentIds = presentIds ?? draftState?.presentIds ?? [];
    const localAbsentIds = absentIds ?? draftState?.absentIds ?? [];
    let mergedDraft = draftState ? { ...draftState, presentIds: localPresentIds, absentIds: localAbsentIds } : draftState;

    if (existingDraft && draftState && existingDraft.updatedBy !== draftState.updatedBy) {
      const now = Date.now();
      const localEditedMap = draftState.recentlyEditedRiders || {};

      const combinedPresent = new Set(localPresentIds);
      const combinedAbsent = new Set(localAbsentIds);

      (existingDraft.presentIds ?? []).forEach((id) => {
        const lastEdit = localEditedMap[id] ?? 0;
        // If local rep did not edit this rider in the last 15s, preserve remote present mark
        if (now - lastEdit > 15000 && !combinedAbsent.has(id)) {
          combinedPresent.add(id);
        }
      });
      (existingDraft.absentIds ?? []).forEach((id) => {
        const lastEdit = localEditedMap[id] ?? 0;
        // If local rep did not edit this rider in the last 15s, preserve remote absent mark
        if (now - lastEdit > 15000 && !combinedPresent.has(id)) {
          combinedAbsent.add(id);
        }
      });

      // Merge sponsorships: preserve existing sponsorships from other reps
      const mergedSponsored = new Set(draftState.sponsoredIds ?? []);
      (existingDraft.sponsoredIds ?? []).forEach((id) => {
        const lastEdit = localEditedMap[id] ?? 0;
        if (now - lastEdit > 15000) {
          mergedSponsored.add(id);
        }
      });

      // Merge unpaid marks: preserve existing unpaid flags from other reps
      const mergedUnpaid = new Set(draftState.unpaidIds ?? []);
      (existingDraft.unpaidIds ?? []).forEach((id) => {
        const lastEdit = localEditedMap[id] ?? 0;
        if (now - lastEdit > 15000) {
          mergedUnpaid.add(id);
        }
      });

      // Merge absent paid marks: preserve existing absent paid flags from other reps
      const mergedAbsentPaid = new Set(draftState.absentPaidIds ?? []);
      (existingDraft.absentPaidIds ?? []).forEach((id) => {
        const lastEdit = localEditedMap[id] ?? 0;
        if (now - lastEdit > 15000) {
          mergedAbsentPaid.add(id);
        }
      });

      // Merge manual cancellations by ID
      const manualMap = new Map<string, { id: string; passengerName: string; structure?: string; amount: number; note?: string }>();
      (existingDraft.manualCancellations ?? []).forEach((c) => manualMap.set(c.id, c));
      (draftState.manualCancellations ?? []).forEach((c) => manualMap.set(c.id, c));

      // Merge external sponsees by ID
      const sponseeMap = new Map<string, { id: string; sponseeName: string; taxiName: string; amount: number }>();
      (existingDraft.externalSponsees ?? []).forEach((s) => sponseeMap.set(s.id, s));
      (draftState.externalSponsees ?? []).forEach((s) => sponseeMap.set(s.id, s));

      mergedDraft = {
        ...existingDraft,
        ...draftState,
        presentIds: Array.from(combinedPresent),
        absentIds: Array.from(combinedAbsent),
        sponsoredIds: Array.from(mergedSponsored),
        unpaidIds: Array.from(mergedUnpaid),
        absentPaidIds: Array.from(mergedAbsentPaid),
        notes: { ...(existingDraft.notes ?? {}), ...(draftState.notes ?? {}) },
        repName: draftState.repName?.trim() || existingDraft.repName || targetVehicle?.repName,
        licensePlate: draftState.licensePlate?.trim() || existingDraft.licensePlate || targetVehicle?.licensePlate,
        coReps: Array.from(new Set([...(existingDraft.coReps ?? []), ...(draftState.coReps ?? [])])).filter(Boolean),
        settledLedgerIds: Array.from(new Set([...(existingDraft.settledLedgerIds ?? []), ...(draftState.settledLedgerIds ?? [])])),
        manualCancellations: Array.from(manualMap.values()),
        externalSponsees: Array.from(sponseeMap.values()),
        updatedAt: draftState.updatedAt || new Date().toISOString(),
        updatedBy: draftState.updatedBy,
      };
    }

    // 3. Update passenger present status using the merged draft
    const finalPresentSet = new Set(mergedDraft?.presentIds ?? []);
    const finalAbsentSet = new Set(mergedDraft?.absentIds ?? []);

    const updatedSignups: Passenger[] = remoteManifest.signups.map((p): Passenger => {
      if (vehicleRiderSet.has(p.id)) {
        if (finalPresentSet.has(p.id)) return { ...p, present: true };
        if (finalAbsentSet.has(p.id)) return { ...p, present: false };
        return { ...p, present: p.present ?? false };
      }
      return p;
    });

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

    // Broadcast lightweight, targeted vehicle delta across connected devices via Supabase channel
    // (Notice: we omit broadcasting the entire church manifest on every tap, saving massive egress & mobile data!)
    safeChannelSend({
      type: 'broadcast',
      event: 'vehicle_draft_delta',
      payload: {
        vehicleId,
        draftState: mergedDraft,
        repName: mergedDraft?.repName || repName,
        licensePlate: mergedDraft?.licensePlate || licensePlate,
      },
    });

    try {
      const updatedVehicleRecord = updatedVehicles.find((v) => v.id === vehicleId);
      if (updatedVehicleRecord) {
        saveVehicleToDb(mergedManifest.date, updatedVehicleRecord).catch((err) => {
          console.warn('[useManifest] Error saving individual vehicle:', err);
        });
      }

      const { data } = await supabase
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

      if (data?.updated_at) {
        lastSavedUpdatedAtRef.current = data.updated_at;
        lastKnownUpdatedAtRef.current = data.updated_at;
      }
    } catch {
      // Supabase is secondary; Firestore is primary cloud database
    }
  }

  /**
   * Appends a walk-in to the manifest. Reads the freshest copy of the row immediately before
   * writing so a walk-in added by one rep can never be lost to a stale write from another.
   */
  const appendWalkIn = useCallback(
    async (
      vehicleId: string,
      newPassenger: Passenger,
      draftUpdate?: Partial<VehicleDraftState>
    ): Promise<Manifest> => {
      const activeKey = keyRef.current || key;
      if (!activeKey) throw new Error('No active manifest key');
      setIsSyncing(true);
      try {
        const { data: latestRow } = await supabase
          .from(MANIFESTS_TABLE)
          .select('date, signups, vehicles, updated_at')
          .eq('date', activeKey)
          .maybeSingle();
        const remote = (latestRow ? normalizeManifestData(latestRow) : null) || { date: activeKey, signups: [], vehicles: [] };

        const updated = applyWalkInToManifest(remote, vehicleId, newPassenger, draftUpdate);

        // Persist target vehicle individually to transport_vehicles
        const updatedTargetVehicle = updated.vehicles.find((v) => v.id === vehicleId);
        if (updatedTargetVehicle) {
          saveVehicleToDb(updated.date, updatedTargetVehicle).catch((err) => {
            console.warn('[useManifest] Error saving walk-in vehicle individually:', err);
          });
        }

        const { data: saved } = await supabase
          .from(MANIFESTS_TABLE)
          .upsert(
            { date: updated.date, signups: updated.signups, vehicles: updated.vehicles },
            { onConflict: 'date' }
          )
          .select('updated_at')
          .maybeSingle();
        if (saved?.updated_at) {
          lastSavedUpdatedAtRef.current = saved.updated_at;
          lastKnownUpdatedAtRef.current = saved.updated_at;
          updated.updated_at = saved.updated_at;
        }

        setManifest((prev) => mergeIncomingManifest(prev, updated, activeVehicleIdRef.current));
        setLastSyncedAt(Date.now());

        if (broadcastChannelRef.current) {
          try {
            broadcastChannelRef.current.postMessage({
              type: 'manifest_updated',
              manifest: updated,
            });
          } catch {
            // Broadcast failed non-critically
          }
        }
        safeChannelSend({
          type: 'broadcast',
          event: 'manifest_updated',
          payload: { date: updated.date, manifest: updated },
        });

        return updated;
      } finally {
        setIsSyncing(false);
      }
    },
    [key, safeChannelSend]
  );

  return {
    manifest,
    loading,
    error,
    isSyncing,
    lastSyncedAt,
    activeCoReps,
    refresh,
    save,
    reset,
    updateVehicleDraft,
    appendWalkIn,
    broadcastLiveAction,
  };
}
