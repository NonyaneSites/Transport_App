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
import {
  connectSyncEvents,
  isServerOnline,
  updateVehicleDraftOnServer,
  saveManifestToServer,
  fetchManifestFromServer,
  broadcastLiveActionToServer,
} from './serverApi';
import type { Manifest, Vehicle, Passenger, VehicleDraftState, LiveSyncAction } from './types';

export interface ActiveCoRep {
  clientId: string;
  repName: string;
  lastSeen: number;
}

export type ManifestSyncStatus = 'synced' | 'syncing' | 'failed' | 'offline';

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
    const currentVehMap = new Map((current?.vehicles || []).map((v) => [String(v.id), v]));
    const safeVehicles = incoming.vehicles.map((incV) => {
      const curV = currentVehMap.get(String(incV.id));
      const wasSubmitted = Boolean(curV?.submitted || curV?.draftState?.submitted);
      if (wasSubmitted && !incV.submitted) {
        return {
          ...incV,
          submitted: true,
          submittedAt: curV?.submittedAt || incV.submittedAt,
          submittedBy: curV?.submittedBy || incV.submittedBy,
          repName: curV?.repName || incV.repName,
          licensePlate: curV?.licensePlate || incV.licensePlate,
          generalNotes: curV?.generalNotes || incV.generalNotes,
          draftState: {
            ...(typeof incV.draftState === 'object' && incV.draftState ? incV.draftState : {}),
            ...(typeof curV?.draftState === 'object' && curV?.draftState ? curV.draftState : {}),
            submitted: true,
          },
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
    const activeRiderStrSet = new Set(activeRiders.map(String));

    const incDraft = incV.draftState;
    const curDraft = currentActiveVehicle.draftState;

    const curPSet = new Set((curDraft?.presentIds || []).map(String));
    const incPSet = new Set((incDraft?.presentIds || []).map(String));
    const curASet = new Set((curDraft?.absentIds || []).map(String));
    const incASet = new Set((incDraft?.absentIds || []).map(String));

    const incIsNewer = Boolean(
      incDraft?.updatedAt && curDraft?.updatedAt && incDraft.updatedAt >= curDraft.updatedAt
    );

    const mergedPresent = Array.from(
      new Set([
        ...(curDraft?.presentIds || []).filter((id) => !incIsNewer || !incASet.has(String(id))),
        ...(incDraft?.presentIds || []).filter((id) => incIsNewer || !curASet.has(String(id))),
      ])
    ).filter((id) => activeRiderStrSet.has(String(id)));

    const mergedAbsent = Array.from(
      new Set([
        ...(curDraft?.absentIds || []).filter((id) => !incIsNewer || !incPSet.has(String(id))),
        ...(incDraft?.absentIds || []).filter((id) => incIsNewer || !curPSet.has(String(id))),
      ])
    ).filter((id) => activeRiderStrSet.has(String(id)));

    const mergedSponsored = Array.from(
      new Set([...(curDraft?.sponsoredIds || []), ...(incDraft?.sponsoredIds || [])])
    ).filter((id) => activeRiderStrSet.has(String(id)));

    const mergedUnpaid = Array.from(
      new Set([...(curDraft?.unpaidIds || []), ...(incDraft?.unpaidIds || [])])
    ).filter((id) => activeRiderStrSet.has(String(id)));

    const mergedAbsentPaid = Array.from(
      new Set([...(curDraft?.absentPaidIds || []), ...(incDraft?.absentPaidIds || [])])
    ).filter((id) => activeRiderStrSet.has(String(id)));

    const mergedNotes = Object.fromEntries(
      Object.entries({ ...(curDraft?.notes || {}), ...(incDraft?.notes || {}) }).filter(([k]) =>
        activeRiderStrSet.has(String(k))
      )
    );

    const finalRepName =
      (incIsNewer ? incDraft?.repName : curDraft?.repName) ||
      curDraft?.repName ||
      incDraft?.repName ||
      currentActiveVehicle.repName ||
      incV.repName;

    const finalPlate =
      (incIsNewer ? incDraft?.licensePlate : curDraft?.licensePlate) ||
      curDraft?.licensePlate ||
      incDraft?.licensePlate ||
      currentActiveVehicle.licensePlate ||
      incV.licensePlate;

    const finalGeneralNotes =
      (incIsNewer ? incDraft?.generalNotes : curDraft?.generalNotes) ||
      curDraft?.generalNotes ||
      incDraft?.generalNotes ||
      currentActiveVehicle.generalNotes ||
      incV.generalNotes;

    const isSubmitted = Boolean(
      incV.submitted ||
        currentActiveVehicle.submitted ||
        incDraft?.submitted ||
        curDraft?.submitted
    );

    const cleanDraftState: VehicleDraftState = {
      ...(curDraft || {}),
      ...(incDraft || {}),
      presentIds: mergedPresent,
      absentIds: mergedAbsent,
      sponsoredIds: mergedSponsored,
      unpaidIds: mergedUnpaid,
      absentPaidIds: mergedAbsentPaid,
      notes: mergedNotes,
      repName: finalRepName,
      licensePlate: finalPlate,
      generalNotes: finalGeneralNotes,
      submitted: isSubmitted,
      updatedAt: incDraft?.updatedAt || curDraft?.updatedAt || new Date().toISOString(),
      updatedBy: incDraft?.updatedBy || curDraft?.updatedBy,
    };

    return {
      ...incV,
      ...currentActiveVehicle,
      repName: finalRepName,
      licensePlate: finalPlate,
      generalNotes: finalGeneralNotes,
      riders: activeRiders,
      orderedStops: incV.orderedStops || currentActiveVehicle.orderedStops || [],
      submitted: isSubmitted,
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
  syncStatus: ManifestSyncStatus;
  syncError: string | null;
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
  const [syncStatus, setSyncStatus] = useState<ManifestSyncStatus>('synced');
  const [syncError, setSyncError] = useState<string | null>(null);
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
  const pendingRemoteSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRemoteSaveManifestRef = useRef<Manifest | null>(null);

  useEffect(() => {
    manifestRef.current = manifest;
  }, [manifest]);

  useEffect(() => {
    activeVehicleIdRef.current = activeVehicleId;
    activeCoRepsMapRef.current.clear();
    setActiveCoReps([]);
  }, [activeVehicleId]);

  // Periodically prune stale co-reps (inactive for > 120 seconds, checked every 60s, paused when hidden)
  useEffect(() => {
    const prune = () => {
      if (typeof document !== 'undefined' && (document.hidden || document.visibilityState === 'hidden')) return;
      const now = Date.now();
      let changed = false;
      activeCoRepsMapRef.current.forEach((val, cId) => {
        if (now - val.lastSeen > 120000) {
          activeCoRepsMapRef.current.delete(cId);
          changed = true;
        }
      });
      if (changed) {
        setActiveCoReps(Array.from(activeCoRepsMapRef.current.values()));
      }
    };

    const interval = setInterval(prune, 60000);
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
    if (isServerOnline()) {
      broadcastLiveActionToServer(action).catch(() => {});
    }
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
    setSyncStatus('syncing');
    try {
      const fresh = await loadManifest(key);
      if (keyRef.current === key && fresh) {
        setManifest(fresh);
        if (fresh.updated_at) {
          lastKnownUpdatedAtRef.current = fresh.updated_at;
        }
        setLastSyncedAt(Date.now());
        setSyncStatus('synced');
        setSyncError(null);
      }
    } catch (err) {
      console.warn('[useManifest] Refresh error:', err);
      const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
      setSyncStatus(isOffline ? 'offline' : 'failed');
      setSyncError(isOffline ? 'Offline - displaying cached manifest' : (err instanceof Error ? err.message : String(err)));
    } finally {
      setIsSyncing(false);
    }
  };

  const executeRemotePersist = useCallback(async (targetManifest: Manifest, baselineSnapshot?: Manifest | null) => {
    setIsSyncing(true);
    setSyncStatus('syncing');
    try {
      // 1. Fetch freshest remote row from Supabase to prevent overwriting concurrent updates from other reps/taxis
      let authoritativeRemote: Manifest | null = null;
      try {
        const { data: remoteRow, error: fetchErr } = await supabase
          .from(MANIFESTS_TABLE)
          .select('date, signups, vehicles, updated_at')
          .eq('date', targetManifest.date)
          .maybeSingle();
        if (!fetchErr && remoteRow) {
          authoritativeRemote = normalizeManifestData(remoteRow);
        }
      } catch (err) {
        console.warn('[useManifest] Error fetching remote manifest for reconciliation:', err);
      }

      // Reconcile our intended save on top of authoritative remote
      const base = baselineSnapshot ?? manifestRef.current;
      const reconciled = authoritativeRemote
        ? reconcileManifestForSave(base, targetManifest, authoritativeRemote)
        : targetManifest;

      // 2. Also persist to backend server if online
      if (isServerOnline()) {
        await saveManifestToServer(reconciled).catch((err) => {
          console.warn('[useManifest] Error syncing reconciled manifest to backend server:', err);
        });
      }

      // 3. Upsert reconciled manifest to Supabase
      const { error: upsertError, data } = await supabase
        .from(MANIFESTS_TABLE)
        .upsert(
          {
            date: reconciled.date,
            signups: reconciled.signups,
            vehicles: reconciled.vehicles,
          },
          { onConflict: 'date' }
        )
        .select('updated_at')
        .maybeSingle();

      if (upsertError) {
        console.warn('[useManifest] Supabase upsert error, syncing to local storage:', upsertError);
        mockStorage.upsert(MANIFESTS_TABLE, {
          date: reconciled.date,
          signups: reconciled.signups,
          vehicles: reconciled.vehicles,
          updated_at: new Date().toISOString(),
        });
        const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
        setSyncStatus(isOffline ? 'offline' : 'failed');
        setSyncError(isOffline ? 'Saved locally (Offline)' : upsertError.message);
      } else if (data?.updated_at) {
        lastSavedUpdatedAtRef.current = data.updated_at;
        lastKnownUpdatedAtRef.current = data.updated_at;
        setSyncStatus('synced');
        setSyncError(null);
        if (authoritativeRemote) {
          setManifest((prev) => (prev && prev.date === reconciled.date ? mergeIncomingManifest(prev, reconciled, activeVehicleIdRef.current) : reconciled));
        }
      }
    } catch (err) {
      console.warn('[useManifest] Exception during supabase save, falling back locally:', err);
      mockStorage.upsert(MANIFESTS_TABLE, {
        date: targetManifest.date,
        signups: targetManifest.signups,
        vehicles: targetManifest.vehicles,
        updated_at: new Date().toISOString(),
      });
      const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
      setSyncStatus(isOffline ? 'offline' : 'failed');
      setSyncError(isOffline ? 'Saved locally (Offline)' : String(err));
    } finally {
      setIsSyncing(false);
    }
  }, []);

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

            // Suppress exact echo of our own last save
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
              setSyncStatus('synced');
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
          setSyncStatus('synced');
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
            setSyncStatus('synced');
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

    // 4. Low-cost periodic version/timestamp check (every 20s while tab is visible)
    // Runs even while Realtime is subscribed to catch any missed postgres_changes events
    const pollCheck = async () => {
      if (!key || keyRef.current !== key) return;
      if (typeof document !== 'undefined' && (document.hidden || document.visibilityState === 'hidden')) return;
      // Do not poll immediately after a local write
      if (Date.now() - lastLocalSaveTimeRef.current < 2500) return;
      try {
        const { data, error: pollError } = await supabase
          .from(MANIFESTS_TABLE)
          .select('updated_at')
          .eq('date', key)
          .maybeSingle();

        if (pollError) {
          if (typeof navigator !== 'undefined' && !navigator.onLine) {
            setSyncStatus('offline');
          } else if (isServerOnline()) {
            const serverManifest = await fetchManifestFromServer(key).catch(() => null);
            if (serverManifest?.updated_at && serverManifest.updated_at !== lastKnownUpdatedAtRef.current) {
              lastKnownUpdatedAtRef.current = serverManifest.updated_at;
              setManifest((prev) => mergeIncomingManifest(prev, serverManifest, activeVehicleIdRef.current));
              setLastSyncedAt(Date.now());
              setSyncStatus('synced');
            }
          }
          return;
        }
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
            setSyncStatus('synced');
            setSyncError(null);
          }
        }
      } catch {
        // non-blocking
      }
    };

    const pollInterval = setInterval(() => {
      pollCheck();
    }, 20000);

    // 5. Trigger on tab visible, window focus, network online, or pageshow:
    const handleResume = async () => {
      if (!key || keyRef.current !== key) return;
      if (Date.now() - lastLocalSaveTimeRef.current < 2500) return;

      // Reconnect websocket if dropped or disconnected
      if (!isChannelSubscribedRef.current) {
        setupChannel();
      }

      // Check remote updated_at before performing full refresh
      try {
        const { data: checkData, error: checkError } = await supabase
          .from(MANIFESTS_TABLE)
          .select('updated_at')
          .eq('date', key)
          .maybeSingle();

        const remoteUpdatedAt = !checkError ? (checkData as { updated_at?: string })?.updated_at : undefined;
        if (!remoteUpdatedAt || remoteUpdatedAt !== lastKnownUpdatedAtRef.current) {
          const fresh = await loadManifest(key);
          if (fresh && keyRef.current === key) {
            if (fresh.updated_at) {
              lastKnownUpdatedAtRef.current = fresh.updated_at;
            }
            manifestRef.current = fresh;
            setManifest((prev) => mergeIncomingManifest(prev, fresh, activeVehicleIdRef.current));
            setLastSyncedAt(Date.now());
            setSyncStatus('synced');
            setSyncError(null);
            if (broadcastChannelRef.current) {
              try {
                broadcastChannelRef.current.postMessage({ key: fresh.date, manifest: fresh });
              } catch {
                // broadcast failed
              }
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
    const handleFocus = () => {
      handleResume();
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
      window.addEventListener('focus', handleFocus);
      window.addEventListener('online', handleOnline);
      window.addEventListener('pageshow', handlePageShow);
    }

    // 6. Connect SSE listener for full-stack instant local/server synchronization
    const disconnectSse = connectSyncEvents(
      (data) => {
        if (keyRef.current !== key || !data || data.key !== key) return;
        if (data.manifest) {
          const incoming = normalizeManifestData(data.manifest);
          if (incoming) {
            if (data.manifest.updated_at) {
              lastKnownUpdatedAtRef.current = data.manifest.updated_at;
            }
            setManifest((prev) => mergeIncomingManifest(prev, incoming, activeVehicleIdRef.current));
            setLastSyncedAt(Date.now());
            setSyncStatus('synced');
          }
        } else {
          handleResume();
        }
      },
      undefined,
      (delta) => {
        if (keyRef.current !== key || !delta || delta.key !== key) return;
        const { vehicleId, draftState, repName, licensePlate } = delta;
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
        setSyncStatus('synced');
      },
      undefined,
      (action) => {
        if (keyRef.current !== key || !action) return;
        handleIncomingLiveAction(action);
      }
    );

    return () => {
      keyRef.current = null;
      clearInterval(pollInterval);
      disconnectSse();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', handleFocus);
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
      if (pendingRemoteSaveTimerRef.current) {
        clearTimeout(pendingRemoteSaveTimerRef.current);
        pendingRemoteSaveTimerRef.current = null;
        if (pendingRemoteSaveManifestRef.current) {
          executeRemotePersist(pendingRemoteSaveManifestRef.current).catch(() => {});
        }
      }
    };
  }, [key, handleIncomingLiveAction, executeRemotePersist]);


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

    // 2. Broadcast across local browser tabs immediately
    if (broadcastChannelRef.current) {
      try {
        broadcastChannelRef.current.postMessage({ key: normalized.date, manifest: normalized });
      } catch {
        // Broadcast failed
      }
    }

    // 3. Broadcast across connected devices via Supabase channel
    safeChannelSend({
      type: 'broadcast',
      event: 'manifest_updated',
      payload: { date: normalized.date, manifest: normalized },
    });

    // 4. Update local state and timestamp
    manifestRef.current = normalized;

    // 5. Persist the reconciled manifest to server and database with debounce (400ms)
    pendingRemoteSaveManifestRef.current = normalized;
    if (pendingRemoteSaveTimerRef.current) {
      clearTimeout(pendingRemoteSaveTimerRef.current);
    }
    pendingRemoteSaveTimerRef.current = setTimeout(() => {
      pendingRemoteSaveTimerRef.current = null;
      if (pendingRemoteSaveManifestRef.current) {
        executeRemotePersist(pendingRemoteSaveManifestRef.current, baseline);
      }
    }, 400);
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

    // 1. Use the continuously synchronized manifest state (receives Supabase Realtime updates)
    let remoteManifest = manifestRef.current ?? manifest;
    if (!remoteManifest) {
      try {
        remoteManifest = await loadManifest(key).catch(() => null);
      } catch {
        remoteManifest = null;
      }
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

      // Direct sponsorship and unpaid status from the user's latest draftState
      const mergedSponsored = new Set(draftState.sponsoredIds ?? []);
      const mergedUnpaid = new Set(draftState.unpaidIds ?? []);
      const mergedAbsentPaid = new Set(draftState.absentPaidIds ?? []);

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

    // 3. Update passenger present, sponsored, and unpaid statuses using the merged draft
    const finalPresentSet = new Set((mergedDraft?.presentIds ?? []).map(String));
    const finalAbsentSet = new Set((mergedDraft?.absentIds ?? []).map(String));
    const finalSponsoredSet = new Set((mergedDraft?.sponsoredIds ?? []).map(String));
    const finalUnpaidSet = new Set((mergedDraft?.unpaidIds ?? []).map(String));
    const vehicleRiderStrSet = new Set((targetVehicle?.riders ?? []).map(String));

    const updatedSignups: Passenger[] = remoteManifest.signups.map((p): Passenger => {
      const sId = String(p.id);
      if (vehicleRiderStrSet.has(sId) || vehicleRiderSet.has(p.id)) {
        const isPresent = finalPresentSet.has(sId);
        const isAbsent = finalAbsentSet.has(sId);
        const isSponsored = finalSponsoredSet.has(sId);
        const isUnpaid = finalUnpaidSet.has(sId);
        const sNote = (mergedDraft?.notes?.[sId] || mergedDraft?.notes?.[p.id] || p.sponsorNote || '').trim();
        const uNote = (mergedDraft?.notes?.[sId] || mergedDraft?.notes?.[p.id] || p.unpaidNote || '').trim();

        return {
          ...p,
          present: isPresent ? true : isAbsent ? false : (p.present ?? false),
          sponsored: isSponsored,
          sponsorNote: isSponsored ? (sNote || p.sponsorNote) : undefined,
          didNotPay: isUnpaid,
          unpaidNote: isUnpaid ? (uNote || p.unpaidNote) : undefined,
        };
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

    const targetVehRecord = updatedVehicles.find((v) => String(v.id) === String(vehicleId));

    // Also persist immediately to mockStorage for local fallback
    mockStorage.upsert(MANIFESTS_TABLE, {
      date: mergedManifest.date,
      signups: mergedManifest.signups,
      vehicles: mergedManifest.vehicles,
      updated_at: new Date().toISOString(),
    });

    setIsSyncing(true);
    setSyncStatus('syncing');
    try {
      // 1. Try atomic database RPC first for instant concurrency-safe execution
      let rpcSucceeded = false;
      try {
        const { data: rpcRes, error: rpcErr } = await supabase.rpc('rep_update_vehicle_draft', {
          p_manifest_key: key,
          p_vehicle_id: vehicleId,
          p_draft_state: mergedDraft,
          p_rep_name: repName?.trim() || mergedDraft?.repName?.trim() || '',
          p_license_plate: licensePlate?.trim() || mergedDraft?.licensePlate?.trim() || '',
        });
        if (!rpcErr && rpcRes && (rpcRes as { success?: boolean }).success) {
          rpcSucceeded = true;
          const updatedTime = (rpcRes as { updated_at?: string }).updated_at;
          if (updatedTime) {
            lastSavedUpdatedAtRef.current = updatedTime;
            lastKnownUpdatedAtRef.current = updatedTime;
          }
          setSyncStatus('synced');
          setSyncError(null);
        }
      } catch {
        rpcSucceeded = false;
      }

      // 2. If RPC not available or failed, perform conflict-safe fetch & per-vehicle merge on transport_manifests
      if (!rpcSucceeded) {
        const { data: latestRow, error: fetchError } = await supabase
          .from(MANIFESTS_TABLE)
          .select('date, signups, vehicles, updated_at')
          .eq('date', key)
          .maybeSingle();

        const remote = latestRow ? normalizeManifestData(latestRow) : null;
        let finalVehicles = updatedVehicles;
        let finalSignups = updatedSignups;

        if (remote && Array.isArray(remote.vehicles) && remote.vehicles.length > 0) {
          // Strictly preserve all other vehicles exactly as recorded on the authoritative server row
          finalVehicles = remote.vehicles.map((v) => {
            if (v.id === vehicleId) {
              const remoteSubmitted = Boolean(v.submitted || v.draftState?.submitted);
              return {
                ...v,
                repName: mergedDraft?.repName?.trim() || repName?.trim() || v.repName,
                licensePlate: mergedDraft?.licensePlate?.trim() || licensePlate?.trim() || v.licensePlate,
                submitted: remoteSubmitted || v.submitted,
                draftState: mergedDraft,
              };
            }
            return v;
          });

          // Update signups only for riders belonging to this vehicle
          const vehicleRiderSet = new Set((targetVehicle?.riders ?? []).map(String));
          finalSignups = remote.signups.map((p) => {
            const sId = String(p.id);
            if (vehicleRiderSet.has(sId)) {
              const incP = updatedSignups.find((sp) => String(sp.id) === sId);
              return incP || p;
            }
            return p;
          });
        }

        const { data: upsertData, error: upsertErr } = await supabase
          .from(MANIFESTS_TABLE)
          .upsert(
            {
              date: key,
              signups: finalSignups,
              vehicles: finalVehicles,
            },
            { onConflict: 'date' }
          )
          .select('updated_at')
          .maybeSingle();

        if (upsertErr) {
          const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
          setSyncStatus(isOffline ? 'offline' : 'failed');
          setSyncError(isOffline ? 'Saved locally (Offline)' : upsertErr.message);
        } else if (upsertData?.updated_at) {
          lastSavedUpdatedAtRef.current = upsertData.updated_at;
          lastKnownUpdatedAtRef.current = upsertData.updated_at;
          setSyncStatus('synced');
          setSyncError(null);
        }
      }

      // 3. Keep backend server JSON and SSE in sync
      if (isServerOnline()) {
        await updateVehicleDraftOnServer(key, vehicleId, mergedDraft || {}, repName, licensePlate, targetVehRecord, mergedManifest).catch((err) => {
          console.warn('[useManifest] Error updating vehicle draft on server:', err);
        });
      }
    } catch (err) {
      const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
      setSyncStatus(isOffline ? 'offline' : 'failed');
      setSyncError(isOffline ? 'Saved locally (Offline)' : String(err));
    } finally {
      setIsSyncing(false);
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

        // Persist target vehicle and any previous vehicle individually
        for (const v of updated.vehicles) {
          const remoteV = remote.vehicles.find((rv) => rv.id === v.id);
          const hadRider = (remoteV?.riders || []).some((rId) => String(rId) === String(newPassenger.id));
          const hasRider = (v.riders || []).some((rId) => String(rId) === String(newPassenger.id));
          if (v.id === vehicleId || hadRider !== hasRider) {
            saveVehicleToDb(updated.date, v).catch((err) => {
              console.warn('[useManifest] Error saving vehicle individually:', err);
            });
          }
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
    syncStatus,
    syncError,
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
