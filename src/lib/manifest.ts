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
  // No remote row yet, or it's for a different session key: nothing to reconcile against.
  if (!remote || remote.date !== incoming.date) {
    return incoming;
  }
  // No known baseline (e.g. very first save of a session): we can't tell intent apart from
  // "stale copy", so fall back to trusting the incoming manifest as-is.
  if (!baseline || baseline.date !== incoming.date) {
    return incoming;
  }

  const baseVehiclesMap = new Map(baseline.vehicles.map((v) => [v.id, v]));
  const incVehiclesMap = new Map(incoming.vehicles.map((v) => [v.id, v]));

  // 1. Identify vehicles intentionally deleted by this user (in baseline, missing from incoming)
  const removedVehicleIds = new Set(
    baseline.vehicles.filter((v) => !incVehiclesMap.has(v.id)).map((v) => v.id)
  );

  // 2. Identify brand-new vehicles added by this user (in incoming, not in baseline)
  const addedVehicles = incoming.vehicles.filter((v) => !baseVehiclesMap.has(v.id));

  // Track riders explicitly added to any vehicle by this user so we can guarantee exclusivity
  const ridersExplicitlyAssignedToVehicle = new Map<string, string>(); // riderId -> targetVehicleId

  // 3. Reconcile existing vehicles starting from remote (the freshest ground truth)
  const reconciledVehicles: Vehicle[] = [];

  for (const remoteV of remote.vehicles) {
    // If the user intentionally deleted this vehicle, drop it
    if (removedVehicleIds.has(remoteV.id)) {
      continue;
    }

    const incV = incVehiclesMap.get(remoteV.id);
    const baseV = baseVehiclesMap.get(remoteV.id);

    // If incoming doesn't have it and it wasn't in baseline, it was added by someone else while user was away: KEEP IT!
    if (!incV) {
      reconciledVehicles.push(remoteV);
      continue;
    }

    // If vehicle was not in baseline, treat incoming as brand-new addition
    if (!baseV) {
      reconciledVehicles.push(incV);
      (incV.riders || []).forEach((rId) => ridersExplicitlyAssignedToVehicle.set(rId, incV.id));
      continue;
    }

    // BOTH baseline and incoming have this vehicle: calculate EXACT user diffs!
    const baseRidersSet = new Set(baseV.riders || []);
    const incRidersSet = new Set(incV.riders || []);

    const addedRiders = (incV.riders || []).filter((id) => !baseRidersSet.has(id));
    const removedRidersSet = new Set((baseV.riders || []).filter((id) => !incRidersSet.has(id)));

    addedRiders.forEach((id) => ridersExplicitlyAssignedToVehicle.set(id, incV.id));

    // Apply rider diffs on top of remoteV (preserving any riders added by other reps/admins in remote!)
    const nextRiders = (remoteV.riders || []).filter((id) => !removedRidersSet.has(id));
    for (const rId of addedRiders) {
      if (!nextRiders.includes(rId)) {
        nextRiders.push(rId);
      }
    }

    // Ordered stops diffs
    const baseStopsSet = new Set(baseV.orderedStops || []);
    const incStopsSet = new Set(incV.orderedStops || []);
    const addedStops = (incV.orderedStops || []).filter((s) => !baseStopsSet.has(s));
    const removedStopsSet = new Set((baseV.orderedStops || []).filter((s) => !incStopsSet.has(s)));

    const nextStops = (remoteV.orderedStops || []).filter((s) => !removedStopsSet.has(s));
    for (const s of addedStops) {
      if (!nextStops.includes(s)) {
        nextStops.push(s);
      }
    }

    // Draft state (attendance, notes, rep details)
    const baseDraftStr = JSON.stringify(baseV.draftState || {});
    const incDraftStr = JSON.stringify(incV.draftState || {});
    let nextDraftState: VehicleDraftState | undefined = remoteV.draftState;

    if (baseDraftStr !== incDraftStr) {
      // User specifically modified draftState on this vehicle!
      const baseD = baseV.draftState || {};
      const incD = incV.draftState || {};
      const remD = remoteV.draftState || {};

      // Present IDs deltas
      const basePresent = new Set(baseD.presentIds || []);
      const incPresent = new Set(incD.presentIds || []);
      const addedPresent = (incD.presentIds || []).filter((id) => !basePresent.has(id));
      const removedPresent = new Set((baseD.presentIds || []).filter((id) => !incPresent.has(id)));
      const nextPresent = (remD.presentIds || []).filter((id) => !removedPresent.has(id));
      addedPresent.forEach((id) => {
        if (!nextPresent.includes(id)) nextPresent.push(id);
      });

      // Absent IDs deltas
      const baseAbsent = new Set(baseD.absentIds || []);
      const incAbsent = new Set(incD.absentIds || []);
      const addedAbsent = (incD.absentIds || []).filter((id) => !baseAbsent.has(id));
      const removedAbsent = new Set((baseD.absentIds || []).filter((id) => !incAbsent.has(id)));
      const nextAbsent = (remD.absentIds || []).filter((id) => !removedAbsent.has(id));
      addedAbsent.forEach((id) => {
        if (!nextAbsent.includes(id)) nextAbsent.push(id);
      });

      // Sponsored IDs deltas
      const baseSpon = new Set(baseD.sponsoredIds || []);
      const incSpon = new Set(incD.sponsoredIds || []);
      const addedSpon = (incD.sponsoredIds || []).filter((id) => !baseSpon.has(id));
      const removedSpon = new Set((baseD.sponsoredIds || []).filter((id) => !incSpon.has(id)));
      const nextSpon = (remD.sponsoredIds || []).filter((id) => !removedSpon.has(id));
      addedSpon.forEach((id) => {
        if (!nextSpon.includes(id)) nextSpon.push(id);
      });

      // Unpaid IDs deltas
      const baseUnpaid = new Set(baseD.unpaidIds || []);
      const incUnpaid = new Set(incD.unpaidIds || []);
      const addedUnpaid = (incD.unpaidIds || []).filter((id) => !baseUnpaid.has(id));
      const removedUnpaid = new Set((baseD.unpaidIds || []).filter((id) => !incUnpaid.has(id)));
      const nextUnpaid = (remD.unpaidIds || []).filter((id) => !removedUnpaid.has(id));
      addedUnpaid.forEach((id) => {
        if (!nextUnpaid.includes(id)) nextUnpaid.push(id);
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

    // Submission status: if user explicitly reopened (base was submitted, inc is not submitted), reopen.
    // Otherwise, if remote was submitted, ALWAYS PRESERVE submission!
    const explicitlyReopened = Boolean(baseV.submitted && !incV.submitted);
    const isSubmitted = explicitlyReopened ? false : Boolean(remoteV.submitted || incV.submitted);

    // Metadata fields: use incoming value if user explicitly edited it, otherwise keep remote
    const name = incV.name !== baseV.name ? incV.name : remoteV.name;
    const type = incV.type !== baseV.type ? incV.type : remoteV.type;
    const repName = incV.repName !== baseV.repName ? incV.repName : (remoteV.repName || incV.repName);
    const licensePlate = incV.licensePlate !== baseV.licensePlate ? incV.licensePlate : (remoteV.licensePlate || incV.licensePlate);
    const generalNotes = incV.generalNotes !== baseV.generalNotes ? incV.generalNotes : (remoteV.generalNotes ?? incV.generalNotes);

    reconciledVehicles.push({
      ...remoteV,
      name,
      type,
      repName,
      licensePlate,
      generalNotes,
      riders: nextRiders,
      orderedStops: nextStops,
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
      (newV.riders || []).forEach((rId) => ridersExplicitlyAssignedToVehicle.set(rId, newV.id));
    }
  }

  // 5. Ensure rider exclusivity across vehicles:
  // If a rider was explicitly assigned to vehicle X by this user, remove them from any other vehicle
  const finalVehicles = reconciledVehicles.map((v) => {
    const cleanedRiders = (v.riders || []).filter((rId) => {
      const explicitTarget = ridersExplicitlyAssignedToVehicle.get(rId);
      if (explicitTarget && explicitTarget !== v.id) {
        return false; // Re-assigned to another vehicle by this user
      }
      return true;
    });
    return { ...v, riders: cleanedRiders };
  });

  // 6. Granular 3-Way Reconcile for Signups
  const baseSignupsMap = new Map(baseline.signups.map((p) => [p.id, p]));
  const incSignupsMap = new Map(incoming.signups.map((p) => [p.id, p]));

  // Signups intentionally removed by this user (present in baseline, missing from incoming)
  const removedSignupIds = new Set(
    baseline.signups.filter((p) => !incSignupsMap.has(p.id)).map((p) => p.id)
  );

  // Signups brand-new in incoming (e.g. walk-ins added locally)
  const addedSignups = incoming.signups.filter((p) => !baseSignupsMap.has(p.id));

  const reconciledSignups: Passenger[] = [];
  const handledSignupIds = new Set<string>();

  for (const remP of remote.signups) {
    // If intentionally deleted by this user, omit
    if (removedSignupIds.has(remP.id)) {
      continue;
    }

    handledSignupIds.add(remP.id);
    const incP = incSignupsMap.get(remP.id);
    const baseP = baseSignupsMap.get(remP.id);

    if (!incP) {
      // Exists in remote, not in incoming, and wasn't in baseline -> added by someone else while user was away! KEEP IT!
      reconciledSignups.push(remP);
      continue;
    }

    if (baseP && JSON.stringify(baseP) !== JSON.stringify(incP)) {
      // User explicitly modified fields on this signup: apply changes on top of remote
      reconciledSignups.push({
        ...remP,
        ...incP,
      });
    } else {
      // User did not touch this signup: keep remote version (including any external sponsorship/attendance status)
      reconciledSignups.push(remP);
    }
  }

  // Append any brand-new signups added by this user that aren't already in remote
  for (const newP of addedSignups) {
    if (!handledSignupIds.has(newP.id) && !removedSignupIds.has(newP.id)) {
      reconciledSignups.push(newP);
      handledSignupIds.add(newP.id);
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

  // Prune any deleted vehicles
  try {
    const localExisting = mockStorage.getTable(VEHICLES_TABLE).filter((r) => String(r.manifest_key) === manifestKey);
    const toDeleteIds = localExisting.filter((r) => !currentVehicleIds.has(String(r.id))).map((r) => String(r.id));
    for (const delId of toDeleteIds) {
      await deleteVehicleFromDb(manifestKey, delId);
    }
  } catch (e) {
    console.warn('[Manifest] Error pruning deleted vehicles:', e);
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
          mergedVehicles.push({
            ...ind,
            ...v,
            submitted: isSubmitted,
            submittedAt,
            submittedBy,
            draftState: {
              ...(ind.draftState || {}),
              ...(v.draftState || {}),
              presentIds: v.draftState?.presentIds ?? ind.draftState?.presentIds ?? [],
              absentIds: v.draftState?.absentIds ?? ind.draftState?.absentIds ?? [],
            },
          });
          seenIds.add(v.id);
        } else {
          mergedVehicles.push(v);
          seenIds.add(v.id);
        }
      }
      // Add any newly created individual vehicles that were not in the manifest row
      for (const v of individualVehicles) {
        if (!seenIds.has(v.id)) {
          mergedVehicles.push(v);
          seenIds.add(v.id);
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
