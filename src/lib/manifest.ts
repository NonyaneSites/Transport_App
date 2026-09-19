import { supabase, MANIFESTS_TABLE, VEHICLES_TABLE, mockStorage } from './supabase';
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
  // If incoming is intentionally empty (e.g. manifest reset), NEVER resurrect remote!
  if (incoming.signups.length === 0 && incoming.vehicles.length === 0) {
    return incoming;
  }

  // No remote row yet, or it's for a different session key: nothing to reconcile against.
  if (!remote || remote.date !== incoming.date) {
    return incoming;
  }
  // No known baseline (e.g. very first save of a session): fall back to incoming.
  if (!baseline || baseline.date !== incoming.date) {
    return incoming;
  }

  const baseVehiclesMap = new Map(baseline.vehicles.map((v) => [v.id, v]));
  const incVehiclesMap = new Map(incoming.vehicles.map((v) => [v.id, v]));

  // 1. Identify vehicles intentionally deleted by this user (in baseline, missing from incoming).
  const missingFromInc = baseline.vehicles.filter((v) => !incVehiclesMap.has(v.id));
  const removedVehicleIds = new Set<string>();
  missingFromInc.forEach((v) => removedVehicleIds.add(v.id));

  // 2. Identify brand-new vehicles added by this user (in incoming, not in baseline)
  const addedVehicles = incoming.vehicles.filter((v) => !baseVehiclesMap.has(v.id));

  // Track riders explicitly added to or unassigned from any vehicle by this user
  const ridersExplicitlyAssignedToVehicle = new Map<string, string>(); // riderId -> targetVehicleId
  const ridersExplicitlyUnassigned = new Set<string>(); // riderId explicitly removed to unassigned pool

  // Check signups for explicit unassignments:
  const baseSignupsMap = new Map(baseline.signups.map((p) => [String(p.id), p]));
  const incSignupsMap = new Map(incoming.signups.map((p) => [String(p.id), p]));

  // Signups intentionally deleted or transferred by this user (in baseline, missing from incoming)
  const deletedSignupIds = new Set<string>();
  for (const baseP of baseline.signups) {
    const sId = String(baseP.id);
    if (!incSignupsMap.has(sId)) {
      deletedSignupIds.add(sId);
    }
  }

  for (const incP of incoming.signups) {
    const sId = String(incP.id);
    if (!incP.assignedTo) {
      ridersExplicitlyUnassigned.add(sId);
    } else {
      ridersExplicitlyAssignedToVehicle.set(sId, incP.assignedTo);
    }
  }

  // Also track riders removed from incoming vehicles
  for (const incV of incoming.vehicles) {
    const incRiders = new Set((incV.riders || []).map(String));
    const baseV = baseVehiclesMap.get(incV.id);
    const remoteV = remote.vehicles.find((v) => v.id === incV.id);
    if (baseV) {
      (baseV.riders || []).forEach((rId) => {
        const sRId = String(rId);
        if (!incRiders.has(sRId) && !ridersExplicitlyAssignedToVehicle.has(sRId)) {
          ridersExplicitlyUnassigned.add(sRId);
        }
      });
    }
    if (remoteV) {
      (remoteV.riders || []).forEach((rId) => {
        const sRId = String(rId);
        if (!incRiders.has(sRId) && !ridersExplicitlyAssignedToVehicle.has(sRId)) {
          ridersExplicitlyUnassigned.add(sRId);
        }
      });
    }
  }

  // 3. Reconcile existing vehicles starting from remote
  const reconciledVehicles: Vehicle[] = [];

  for (const remoteV of remote.vehicles) {
    // If the user intentionally deleted this vehicle, drop it
    if (removedVehicleIds.has(remoteV.id)) {
      continue;
    }

    const incV = incVehiclesMap.get(remoteV.id);
    const baseV = baseVehiclesMap.get(remoteV.id);

    // If incoming doesn't have it, check if it was truly added concurrently by someone else (not in baseline)
    if (!incV) {
      if (!baseVehiclesMap.has(remoteV.id)) {
        reconciledVehicles.push(remoteV);
      }
      continue;
    }

    // When the user has this vehicle in incoming, the incoming riders are the authoritative allocation!
    (incV.riders || []).forEach((rId) => ridersExplicitlyAssignedToVehicle.set(String(rId), incV.id));

    // Ordered stops diffs
    const baseStopsSet = new Set(baseV?.orderedStops || []);
    const incStopsSet = new Set(incV.orderedStops || []);
    const addedStops = (incV.orderedStops || []).filter((s) => !baseStopsSet.has(s));
    const removedStopsSet = new Set((baseV?.orderedStops || []).filter((s) => !incStopsSet.has(s)));

    const nextStops = (remoteV.orderedStops || []).filter((s) => !removedStopsSet.has(s));
    for (const s of addedStops) {
      if (!nextStops.includes(s)) {
        nextStops.push(s);
      }
    }

    // Draft state (attendance, notes, rep details): preserve concurrent mobile attendance checks
    const baseDraftStr = JSON.stringify(baseV?.draftState || {});
    const incDraftStr = JSON.stringify(incV.draftState || {});
    let nextDraftState: VehicleDraftState | undefined = remoteV.draftState;

    if (baseDraftStr !== incDraftStr) {
      const baseD = baseV?.draftState || {};
      const incD = incV.draftState || {};
      const remD = remoteV.draftState || {};

      const basePresent = new Set((baseD.presentIds || []).map(String));
      const incPresent = new Set((incD.presentIds || []).map(String));
      const addedPresent = (incD.presentIds || []).filter((id) => !basePresent.has(String(id)));
      const removedPresent = new Set((baseD.presentIds || []).filter((id) => !incPresent.has(String(id))).map(String));
      const nextPresent = (remD.presentIds || []).filter((id) => !removedPresent.has(String(id)));
      addedPresent.forEach((id) => {
        if (!nextPresent.some((pId) => String(pId) === String(id))) nextPresent.push(id);
      });

      const baseAbsent = new Set((baseD.absentIds || []).map(String));
      const incAbsent = new Set((incD.absentIds || []).map(String));
      const addedAbsent = (incD.absentIds || []).filter((id) => !baseAbsent.has(String(id)));
      const removedAbsent = new Set((baseD.absentIds || []).filter((id) => !incAbsent.has(String(id))).map(String));
      const nextAbsent = (remD.absentIds || []).filter((id) => !removedAbsent.has(String(id)));
      addedAbsent.forEach((id) => {
        if (!nextAbsent.some((aId) => String(aId) === String(id))) nextAbsent.push(id);
      });

      const baseSpon = new Set((baseD.sponsoredIds || []).map(String));
      const incSpon = new Set((incD.sponsoredIds || []).map(String));
      const addedSpon = (incD.sponsoredIds || []).filter((id) => !baseSpon.has(String(id)));
      const removedSpon = new Set((baseD.sponsoredIds || []).filter((id) => !incSpon.has(String(id))).map(String));
      const nextSpon = (remD.sponsoredIds || []).filter((id) => !removedSpon.has(String(id)));
      addedSpon.forEach((id) => {
        if (!nextSpon.some((sId) => String(sId) === String(id))) nextSpon.push(id);
      });

      const baseUnpaid = new Set((baseD.unpaidIds || []).map(String));
      const incUnpaid = new Set((incD.unpaidIds || []).map(String));
      const addedUnpaid = (incD.unpaidIds || []).filter((id) => !baseUnpaid.has(String(id)));
      const removedUnpaid = new Set((baseD.unpaidIds || []).filter((id) => !incUnpaid.has(String(id))).map(String));
      const nextUnpaid = (remD.unpaidIds || []).filter((id) => !removedUnpaid.has(String(id)));
      addedUnpaid.forEach((id) => {
        if (!nextUnpaid.some((uId) => String(uId) === String(id))) nextUnpaid.push(id);
      });

      nextDraftState = {
        ...remD,
        ...incD,
        presentIds: nextPresent,
        absentIds: nextAbsent,
        sponsoredIds: nextSpon,
        unpaidIds: nextUnpaid,
        notes: { ...(remD.notes || {}), ...(incD.notes || {}) },
        repName: incD.repName !== baseD.repName ? (incD.repName || remD.repName) : remD.repName,
        licensePlate: incD.licensePlate !== baseD.licensePlate ? (incD.licensePlate || remD.licensePlate) : remD.licensePlate,
        generalNotes: incD.generalNotes !== baseD.generalNotes ? incD.generalNotes : (remD.generalNotes ?? incD.generalNotes),
        updatedAt: incD.updatedAt || new Date().toISOString(),
        updatedBy: incD.updatedBy || remD.updatedBy,
      };
    }

    const explicitlyReopened = Boolean(baseV?.submitted && !incV.submitted);
    const isSubmitted = explicitlyReopened ? false : Boolean(remoteV.submitted || incV.submitted);

    // CRITICAL: Spread incV OVER remoteV so user's changes to capacity, drivers, notes, plates are never lost!
    reconciledVehicles.push({
      ...remoteV,
      ...incV,
      riders: incV.riders || [],
      orderedStops: nextStops.length > 0 ? nextStops : (incV.orderedStops || []),
      submitted: isSubmitted,
      submittedAt: isSubmitted ? (remoteV.submittedAt || incV.submittedAt) : undefined,
      submittedBy: isSubmitted ? (remoteV.submittedBy || incV.submittedBy) : undefined,
      draftState: nextDraftState,
    });
  }

  // 4. Append brand-new vehicles added by this user
  for (const newV of addedVehicles) {
    if (!reconciledVehicles.some((v) => v.id === newV.id)) {
      reconciledVehicles.push(newV);
      (newV.riders || []).forEach((rId) => ridersExplicitlyAssignedToVehicle.set(String(rId), newV.id));
    }
  }

  // 5. Clean up draft states and riders for any explicitly unassigned riders
  const finalVehicles = reconciledVehicles.map((v) => {
    const cleanedRiders = (v.riders || []).filter((rId) => {
      const sRId = String(rId);
      if (ridersExplicitlyUnassigned.has(sRId)) {
        return false;
      }
      const explicitTarget = ridersExplicitlyAssignedToVehicle.get(sRId);
      if (explicitTarget && explicitTarget !== v.id) {
        return false;
      }
      return true;
    });

    const activeRidersSet = new Set(cleanedRiders.map(String));

    const cleanedDraft = v.draftState
      ? {
          ...v.draftState,
          presentIds: v.draftState.presentIds?.filter((id) => activeRidersSet.has(String(id))),
          absentIds: v.draftState.absentIds?.filter((id) => activeRidersSet.has(String(id))),
          sponsoredIds: v.draftState.sponsoredIds?.filter((id) => activeRidersSet.has(String(id))),
          unpaidIds: v.draftState.unpaidIds?.filter((id) => activeRidersSet.has(String(id))),
          notes: Object.fromEntries(
            Object.entries(v.draftState.notes || {}).filter(([k]) => activeRidersSet.has(String(k)))
          ),
        }
      : undefined;

    return { ...v, riders: cleanedRiders, draftState: cleanedDraft };
  });

  // 6. Granular Reconcile for Signups
  const addedSignups = incoming.signups.filter((p) => !baseSignupsMap.has(String(p.id)));
  const reconciledSignups: Passenger[] = [];
  const handledSignupIds = new Set<string>();

  for (const remP of remote.signups) {
    const sId = String(remP.id);
    handledSignupIds.add(sId);

    // If intentionally deleted or transferred out by user, DO NOT resurrect!
    if (deletedSignupIds.has(sId)) {
      continue;
    }

    const incP = incSignupsMap.get(sId);

    if (!incP) {
      // Exists in remote, missing in incoming (incoming was stale): KEEP remote signup
      reconciledSignups.push(remP);
      continue;
    }

    const targetAssignedTo = ridersExplicitlyUnassigned.has(sId)
      ? null
      : (ridersExplicitlyAssignedToVehicle.get(sId) ?? incP.assignedTo);

    reconciledSignups.push({
      ...remP,
      ...incP,
      assignedTo: targetAssignedTo,
    });
  }

  // Append brand-new signups added by this user (e.g. walk-ins or imported passengers)
  for (const newP of addedSignups) {
    const sId = String(newP.id);
    if (!handledSignupIds.has(sId)) {
      reconciledSignups.push(newP);
      handledSignupIds.add(sId);
    }
  }

  // Also include any incoming signups not yet in handledSignupIds (e.g. from Excel imports)
  for (const incP of incoming.signups) {
    const sId = String(incP.id);
    if (!handledSignupIds.has(sId)) {
      reconciledSignups.push(incP);
      handledSignupIds.add(sId);
    }
  }

  return {
    ...incoming,
    vehicles: finalVehicles,
    signups: reconciledSignups,
    updated_at: new Date().toISOString(),
  };
}

export function vehicleToDbRow(manifestKey: string, v: Vehicle): Record<string, unknown> {
  return {
    id: v.id,
    manifest_key: manifestKey,
    name: v.name,
    type: v.type,
    riders: Array.isArray(v.riders) ? v.riders : [],
    ordered_stops: Array.isArray(v.orderedStops) ? v.orderedStops : [],
    submitted: Boolean(v.submitted),
    submitted_at: v.submittedAt || null,
    submitted_by: v.submittedBy || null,
    license_plate: v.licensePlate || null,
    rep_name: v.repName || null,
    co_reps: Array.isArray(v.coReps) ? v.coReps : null,
    general_notes: v.generalNotes || null,
    rep_count: typeof v.repCount === 'number' ? v.repCount : null,
    stop_times: v.stopTimes || null,
    stop_redirects: v.stopRedirects || null,
    draft_state: v.draftState || null,
    updated_at: new Date().toISOString(),
  };
}

export function dbRowToVehicle(row: Record<string, unknown>): Vehicle {
  return {
    id: String(row.id),
    name: String(row.name || ''),
    type: row.type === 'Bus' ? 'Bus' : 'Taxi',
    riders: Array.isArray(row.riders) ? (row.riders as string[]) : [],
    orderedStops: Array.isArray(row.ordered_stops)
      ? (row.ordered_stops as string[])
      : Array.isArray(row.orderedStops)
      ? (row.orderedStops as string[])
      : [],
    submitted: Boolean(row.submitted),
    submittedAt: (row.submitted_at || row.submittedAt) ? String(row.submitted_at || row.submittedAt) : undefined,
    submittedBy: (row.submitted_by || row.submittedBy) ? String(row.submitted_by || row.submittedBy) : undefined,
    licensePlate: (row.license_plate || row.licensePlate) ? String(row.license_plate || row.licensePlate) : undefined,
    repName: (row.rep_name || row.repName) ? String(row.rep_name || row.repName) : undefined,
    coReps: Array.isArray(row.co_reps)
      ? (row.co_reps as string[])
      : Array.isArray(row.coReps)
      ? (row.coReps as string[])
      : undefined,
    generalNotes: (row.general_notes || row.generalNotes) ? String(row.general_notes || row.generalNotes) : undefined,
    repCount: typeof row.rep_count === 'number'
      ? row.rep_count
      : typeof row.repCount === 'number'
      ? row.repCount
      : undefined,
    stopTimes: (row.stop_times || row.stopTimes) as Record<string, string> | undefined,
    stopRedirects: (row.stop_redirects || row.stopRedirects) as Record<string, string> | undefined,
    draftState: (row.draft_state || row.draftState) as VehicleDraftState | undefined,
  };
}

/**
 * Saves a single vehicle individually to the database (transport_vehicles table),
 * allowing granular, safe control per vehicle without overwriting the entire manifest.
 */
export async function saveVehicleToDb(manifestKey: string, vehicle: Vehicle): Promise<void> {
  if (!manifestKey || !vehicle || !vehicle.id) return;
  const row = vehicleToDbRow(manifestKey, vehicle);

  // Always update local/mock storage immediately
  mockStorage.upsert(VEHICLES_TABLE, row, 'id');

  try {
    const { error } = await supabase
      .from(VEHICLES_TABLE)
      .upsert(row, { onConflict: 'id' });
    if (error) {
      console.warn('[Manifest] Remote vehicle upsert warning:', error);
    }
  } catch (err) {
    console.warn('[Manifest] Exception saving individual vehicle to remote DB:', err);
  }
}

/**
 * Deletes a single vehicle individually from the database.
 */
export async function deleteVehicleFromDb(manifestKey: string, vehicleId: string): Promise<void> {
  if (!vehicleId) return;
  const current = mockStorage.getTable(VEHICLES_TABLE);
  mockStorage.setTable(
    VEHICLES_TABLE,
    current.filter((r) => !(String(r.id) === vehicleId && (!manifestKey || String(r.manifest_key) === manifestKey)))
  );

  try {
    const { error } = await supabase
      .from(VEHICLES_TABLE)
      .delete()
      .eq('id', vehicleId)
      .eq('manifest_key', manifestKey);
    if (error) {
      console.warn('[Manifest] Remote vehicle delete warning:', error);
    }
  } catch (err) {
    console.warn('[Manifest] Exception deleting individual vehicle from remote DB:', err);
  }
}

/**
 * Loads all individual vehicles persisted for a given manifest key.
 */
export async function loadVehiclesForManifest(
  manifestKey: string,
  skipLocalStorageFallback = false
): Promise<Vehicle[]> {
  if (!manifestKey) return [];
  try {
    const { data, error } = await supabase
      .from(VEHICLES_TABLE)
      .select('*')
      .eq('manifest_key', manifestKey);
    if (!error && Array.isArray(data) && data.length > 0) {
      return data.map((r) => dbRowToVehicle(r as Record<string, unknown>));
    }
  } catch (err) {
    console.warn('[Manifest] Failed to query remote vehicles table:', err);
  }

  // Local storage fallback: ONLY use when completely offline and remote was not loaded
  if (!skipLocalStorageFallback) {
    const localRows = mockStorage
      .getTable(VEHICLES_TABLE)
      .filter((r) => String(r.manifest_key) === manifestKey);
    if (localRows.length > 0) {
      return localRows.map((r) => dbRowToVehicle(r));
    }
  }
  return [];
}

/**
 * Synchronizes a full list of vehicles to the database individually.
 * Upserts each vehicle as an individual row and removes any vehicles that no longer exist.
 */
export async function syncVehiclesToDb(manifestKey: string, vehicles: Vehicle[]): Promise<void> {
  if (!manifestKey) return;
  const currentVehicleIds = new Set(vehicles.map((v) => v.id));

  // Prune any deleted vehicles from local storage
  try {
    const localExisting = mockStorage.getTable(VEHICLES_TABLE).filter((r) => String(r.manifest_key) === manifestKey);
    const toDeleteIds = localExisting.filter((r) => !currentVehicleIds.has(String(r.id))).map((r) => String(r.id));
    for (const delId of toDeleteIds) {
      await deleteVehicleFromDb(manifestKey, delId);
    }
  } catch (e) {
    console.warn('[Manifest] Error pruning deleted vehicles locally:', e);
  }

  // Prune any deleted vehicles from remote Supabase transport_vehicles
  try {
    const { data: remoteExisting } = await supabase
      .from(VEHICLES_TABLE)
      .select('id')
      .eq('manifest_key', manifestKey);
    if (Array.isArray(remoteExisting)) {
      for (const row of remoteExisting) {
        if (!currentVehicleIds.has(String(row.id))) {
          await deleteVehicleFromDb(manifestKey, String(row.id));
        }
      }
    }
  } catch (err) {
    console.warn('[Manifest] Error pruning remote deleted vehicles:', err);
  }

  // Save each vehicle individually
  for (const v of vehicles) {
    await saveVehicleToDb(manifestKey, v);
  }
}

export async function loadManifest(key: string): Promise<Manifest | null> {
  let manifest: Manifest | null = null;
  let loadedFromRemote = false;
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
      manifest = {
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
      loadedFromRemote = true;
    }
  } catch (err) {
    console.warn('[Manifest] Exception loading manifest, checking local store:', err);
  }

  // Fallback to local storage if not yet loaded from remote
  if (!manifest) {
    const localRow = mockStorage.getTable(MANIFESTS_TABLE).find((r) => r.date === key);
    if (localRow) {
      manifest = {
        date: String(localRow.date),
        signups: Array.isArray(localRow.signups) ? (localRow.signups as Passenger[]) : [],
        vehicles: Array.isArray(localRow.vehicles) ? (localRow.vehicles as Vehicle[]) : [],
        created_at: typeof localRow.created_at === 'string' ? localRow.created_at : undefined,
        updated_at: typeof localRow.updated_at === 'string' ? localRow.updated_at : undefined,
      };
    }
  }

  if (!manifest) return null;

  // Integrate individual vehicle persistence (source of truth per vehicle)
  try {
    // If loaded from remote Supabase, skip local storage fallback to avoid overwriting with stale cache
    const individualVehicles = await loadVehiclesForManifest(key, loadedFromRemote);
    if (individualVehicles.length > 0) {
      // Build a map of individually saved vehicles
      const indMap = new Map(individualVehicles.map((v) => [v.id, v]));
      // Merge with manifest list to maintain order, updating with latest individual records
      const mergedVehicles: Vehicle[] = [];
      const seenIds = new Set<string>();

      for (const v of manifest.vehicles) {
        if (indMap.has(v.id)) {
          const ind = indMap.get(v.id)!;
          // CRITICAL: NEVER lose submitted status! Remote or local submission must be preserved.
          const isSubmitted = Boolean(v.submitted || ind.submitted);
          const submittedAt = v.submittedAt || ind.submittedAt;
          const submittedBy = v.submittedBy || ind.submittedBy;
          const activeRiderIds = new Set(v.riders || []);
          mergedVehicles.push({
            ...ind,
            ...v,
            submitted: isSubmitted,
            submittedAt,
            submittedBy,
            draftState: {
              ...(ind.draftState || {}),
              ...(v.draftState || {}),
              presentIds: (v.draftState?.presentIds ?? ind.draftState?.presentIds ?? []).filter((id) => activeRiderIds.has(id)),
              absentIds: (v.draftState?.absentIds ?? ind.draftState?.absentIds ?? []).filter((id) => activeRiderIds.has(id)),
              sponsoredIds: (v.draftState?.sponsoredIds ?? ind.draftState?.sponsoredIds ?? []).filter((id) => activeRiderIds.has(id)),
              unpaidIds: (v.draftState?.unpaidIds ?? ind.draftState?.unpaidIds ?? []).filter((id) => activeRiderIds.has(id)),
              notes: Object.fromEntries(
                Object.entries({ ...(ind.draftState?.notes || {}), ...(v.draftState?.notes || {}) }).filter(([k]) => activeRiderIds.has(k))
              ),
            },
          });
          seenIds.add(v.id);
        } else {
          mergedVehicles.push(v);
          seenIds.add(v.id);
        }
      }

      // ONLY populate from individual vehicles if the manifest row had no vehicles at all
      if (manifest.vehicles.length === 0 && !loadedFromRemote) {
        for (const v of individualVehicles) {
          if (!seenIds.has(v.id)) {
            mergedVehicles.push(v);
            seenIds.add(v.id);
          }
        }
      }
      manifest.vehicles = mergedVehicles;
    } else if (manifest.vehicles.length > 0 && !loadedFromRemote) {
      // Backfill individual vehicle records if in local mode
      syncVehiclesToDb(key, manifest.vehicles).catch(() => {});
    }

    // Keep local cache fresh so local storage mirrors authoritative vehicles (including submitted status)
    for (const v of manifest.vehicles) {
      mockStorage.upsert(VEHICLES_TABLE, vehicleToDbRow(key, v), 'id');
    }
  } catch (err) {
    console.warn('[Manifest] Error loading individual vehicles for manifest:', err);
  }

  return manifest;
}

export async function resetManifest(key: string): Promise<void> {
  if (!key) return;

  const emptyManifest: Manifest = {
    date: key,
    signups: [],
    vehicles: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // 1. Clear local mockStorage
  mockStorage.setTable(
    MANIFESTS_TABLE,
    mockStorage.getTable(MANIFESTS_TABLE).filter((r) => r.date !== key)
  );
  mockStorage.setTable(
    VEHICLES_TABLE,
    mockStorage.getTable(VEHICLES_TABLE).filter((r) => String(r.manifest_key) !== key)
  );

  // 2. Clear remote Supabase
  try {
    await supabase.from(MANIFESTS_TABLE).upsert(
      {
        date: key,
        signups: [],
        vehicles: [],
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'date' }
    );
  } catch (err) {
    console.warn('[Manifest] Remote reset upsert warning:', err);
  }

  try {
    await supabase.from(VEHICLES_TABLE).delete().eq('manifest_key', key);
  } catch (err) {
    console.warn('[Manifest] Remote delete vehicles warning:', err);
  }

  // 3. Save to server endpoint
  try {
    await saveManifestToServer(emptyManifest, false);
  } catch {
    // ignore
  }
}

export async function upsertManifest(manifest: Manifest): Promise<void> {
  // 1. Save each vehicle individually to transport_vehicles for granular control
  try {
    await syncVehiclesToDb(manifest.date, manifest.vehicles);
  } catch (err) {
    console.warn('[Manifest] Error saving individual vehicles:', err);
  }

  // 2. Save manifest to Supabase (source of truth) with a local-storage fallback if offline.
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
  const activeVehicleIds = new Set((manifest.vehicles || []).map((v) => v.id));

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

  // Filter raw unassigned signups:
  // A signup is unassigned if it's not in allocatedIds AND either has no assignedTo OR points to a vehicle that no longer exists
  const rawUnassigned = manifest.signups.filter((p) => {
    if (allocatedIds.has(p.id)) return false;
    if (!p.assignedTo) return true;
    return !activeVehicleIds.has(p.assignedTo);
  });

  // Deduplicate among unassigned by person: keep only the most recent signup and exclude anyone already allocated
  const personMap = new Map<string, { passenger: Passenger; epoch: number; index: number }>();

  rawUnassigned.forEach((p, idx) => {
    const norm = normalizePassengerText(p.fullName);
    if (!norm) {
      personMap.set(`unnamed-${p.id || idx}`, { passenger: p, epoch: 0, index: idx });
      return;
    }

    // If person currently has an active seat in a vehicle's riders list, exclude their duplicate
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
