import { supabase, MANIFESTS_TABLE, mockStorage } from './supabase';
import type { Manifest, Passenger, Vehicle, ServiceType } from './types';
import { manifestKey, parseManifestKey } from './dates';
import { hubDisplayName } from './types';
import { loadManifest, upsertManifest } from './manifest';
import { normalizePassengerText } from './importer';

export type ServicePeriod = 'AM' | 'PM';

/**
 * Categorizes service types into AM vs PM time sessions.
 * AM Service: AM_Serving (Serving Only), AM_Ushers (Ushers - early), AM_Normal (Normal only)
 * PM Service: PM_Serving (Serving Only), PM_Normal (Normal only)
 */
export function getServicePeriod(service: ServiceType | string): ServicePeriod {
  if (service.startsWith('PM')) return 'PM';
  return 'AM';
}

/**
 * Returns all compatible service types for a given service period.
 */
export function getCompatibleServices(service: ServiceType | string): ServiceType[] {
  const period = getServicePeriod(service);
  if (period === 'PM') {
    return ['PM_Serving', 'PM_Normal'];
  }
  return ['AM_Serving', 'AM_Ushers', 'AM_Normal'];
}

/**
 * Checks if two services are in the same time session window.
 */
export function areServicesTransferCompatible(serviceA: ServiceType | string, serviceB: ServiceType | string): boolean {
  return getServicePeriod(serviceA) === getServicePeriod(serviceB);
}

export interface CrossCheckCandidate {
  passenger: Passenger;
  service: ServiceType;
  serviceLabel: string;
  period: ServicePeriod;
  isCompatible: boolean;
  vehicle: Vehicle | null; // null if unassigned
  statusLabel: string; // e.g. "Allocated to AM Normal Taxi 3" or "Unassigned in AM Normal"
}

/**
 * Searches across all services for a specific date to find a passenger by name.
 * Uses a single lightweight query to minimize egress.
 */
export async function crossCheckPassengerAcrossDate(
  date: string,
  currentService: ServiceType,
  queryName: string
): Promise<CrossCheckCandidate[]> {
  const cleanQ = normalizePassengerText(queryName);
  if (!cleanQ || cleanQ.length < 2) return [];

  const currentPeriod = getServicePeriod(currentService);
  const results: CrossCheckCandidate[] = [];

  try {
    // 1. Fetch manifests for this date
    let rawManifests: Manifest[] = [];

    const { data, error } = await supabase
      .from(MANIFESTS_TABLE)
      .select('date, signups, vehicles')
      .ilike('date', `${date}%`);

    if (!error && Array.isArray(data) && data.length > 0) {
      rawManifests = data.map((d) => ({
        date: d.date,
        signups: Array.isArray(d.signups) ? d.signups : [],
        vehicles: Array.isArray(d.vehicles) ? d.vehicles : [],
      }));
    } else {
      // Check local storage fallback
      const localRows = mockStorage.getTable(MANIFESTS_TABLE).filter((r) => String(r.date).startsWith(date));
      rawManifests = localRows.map((d) => ({
        date: String(d.date),
        signups: Array.isArray(d.signups) ? (d.signups as Passenger[]) : [],
        vehicles: Array.isArray(d.vehicles) ? (d.vehicles as Vehicle[]) : [],
      }));
    }

    for (const m of rawManifests) {
      const { service: mService } = parseManifestKey(m.date);
      const sType = mService as ServiceType;
      const mPeriod = getServicePeriod(sType);
      const isCompatible = mPeriod === currentPeriod;

      for (const p of m.signups || []) {
        const normP = normalizePassengerText(p.fullName);
        if (normP.includes(cleanQ) || cleanQ.includes(normP)) {
          // Find if assigned to a vehicle in this manifest
          const assignedVeh = (m.vehicles || []).find(
            (v) => (v.riders || []).includes(p.id) || v.id === p.assignedTo
          ) || null;

          let serviceName: string = sType;
          if (sType === 'AM_Serving') serviceName = 'AM Serving Only';
          else if (sType === 'AM_Ushers') serviceName = 'AM Ushers (Early)';
          else if (sType === 'AM_Normal') serviceName = 'AM Normal Only';
          else if (sType === 'PM_Serving') serviceName = 'PM Serving Only';
          else if (sType === 'PM_Normal') serviceName = 'PM Normal Only';

          const statusLabel = assignedVeh
            ? `Allocated to ${assignedVeh.name} (${serviceName})`
            : `Unassigned pool (${serviceName})`;

          results.push({
            passenger: p,
            service: sType,
            serviceLabel: serviceName,
            period: mPeriod,
            isCompatible,
            vehicle: assignedVeh,
            statusLabel,
          });
        }
      }
    }
  } catch (err) {
    console.warn('[CrossCheck] Error searching across services:', err);
  }

  return results;
}

/**
 * Transfers a passenger across services within the same service time (AM or PM).
 * Ensures:
 * 1. The passenger is safely removed from their previous vehicle/manifest.
 * 2. The passenger is added to the destination manifest and vehicle, marked present.
 * 3. Draft states and ordered stops are cleanly updated.
 * 4. Cross-service time constraints (AM only to AM, PM only to PM) are strictly enforced.
 */
export async function transferPassengerAcrossServices(params: {
  date: string;
  fromService: ServiceType;
  toService: ServiceType;
  passengerId: string;
  toVehicleId: string;
  repName?: string;
  licensePlate?: string;
}): Promise<{ success: boolean; error?: string; passenger?: Passenger }> {
  const { date, fromService, toService, passengerId, toVehicleId, repName, licensePlate } = params;

  // Validation: Must be in the same period
  if (!areServicesTransferCompatible(fromService, toService)) {
    return {
      success: false,
      error: `Transfers are only allowed within the same time window (AM Service: Serving, Ushers, Normal; PM Service: Serving, Normal). Cannot transfer from ${fromService} to ${toService}.`,
    };
  }

  const fromKey = manifestKey(date, fromService);
  const toKey = manifestKey(date, toService);

  try {
    // Case 1: Same manifest transfer (same service)
    if (fromKey === toKey) {
      const currentManifest = await loadManifest(toKey);
      if (!currentManifest) return { success: false, error: 'Destination manifest not found.' };

      const passenger = currentManifest.signups.find((p) => p.id === passengerId);
      if (!passenger) return { success: false, error: 'Passenger not found in manifest.' };

      const targetVehicle = currentManifest.vehicles.find((v) => v.id === toVehicleId);
      if (!targetVehicle) return { success: false, error: 'Target vehicle not found.' };

      const stopLabel = hubDisplayName(targetVehicle.type, passenger.stop || 'Walk-In');

      const updatedVehicles = currentManifest.vehicles.map((v) => {
        if (v.id === toVehicleId) {
          const nextRiders = v.riders.includes(passenger.id) ? v.riders : [...v.riders, passenger.id];
          const nextStops = (v.orderedStops || []).includes(stopLabel)
            ? v.orderedStops || []
            : [...(v.orderedStops || []), stopLabel];
          const curDraft = v.draftState || {};
          const pIds = curDraft.presentIds || [];
          const nextPIds = pIds.includes(passenger.id) ? pIds : [...pIds, passenger.id];
          const nextAIds = (curDraft.absentIds || []).filter((id) => id !== passenger.id);

          return {
            ...v,
            riders: nextRiders,
            orderedStops: nextStops,
            draftState: {
              ...curDraft,
              presentIds: nextPIds,
              absentIds: nextAIds,
              repName: repName || v.repName || curDraft.repName || '',
              licensePlate: licensePlate || v.licensePlate || curDraft.licensePlate || '',
              updatedAt: new Date().toISOString(),
            },
          };
        }

        // Remove from other vehicles in the same manifest
        if (v.riders.includes(passenger.id)) {
          const nextRiders = v.riders.filter((id) => id !== passenger.id);
          const curDraft = v.draftState;
          const cleanedDraft = curDraft ? {
            ...curDraft,
            presentIds: curDraft.presentIds?.filter((id) => id !== passenger.id),
            absentIds: curDraft.absentIds?.filter((id) => id !== passenger.id),
            sponsoredIds: curDraft.sponsoredIds?.filter((id) => id !== passenger.id),
          } : undefined;
          return { ...v, riders: nextRiders, draftState: cleanedDraft };
        }

        return v;
      });

      const updatedSignups = currentManifest.signups.map((p) =>
        p.id === passenger.id ? { ...p, assignedTo: toVehicleId, present: true } : p
      );

      const updatedManifest: Manifest = {
        ...currentManifest,
        signups: updatedSignups,
        vehicles: updatedVehicles,
      };

      await upsertManifest(updatedManifest);
      return { success: true, passenger };
    }

    // Case 2: Cross-service transfer (e.g. AM_Normal -> AM_Serving)
    const [fromManifest, toManifest] = await Promise.all([
      loadManifest(fromKey),
      loadManifest(toKey),
    ]);

    if (!fromManifest) return { success: false, error: `Source manifest (${fromService}) not found.` };
    if (!toManifest) return { success: false, error: `Destination manifest (${toService}) not found.` };

    const passengerToMove = fromManifest.signups.find((p) => p.id === passengerId);
    if (!passengerToMove) {
      return { success: false, error: `Passenger not found in ${fromService}.` };
    }

    const targetVehicle = toManifest.vehicles.find((v) => v.id === toVehicleId);
    if (!targetVehicle) {
      return { success: false, error: `Target vehicle not found in ${toService}.` };
    }

    // 1. Remove from source manifest
    const cleanedSourceVehicles = fromManifest.vehicles.map((v) => {
      if (v.riders.includes(passengerId)) {
        const nextRiders = v.riders.filter((id) => id !== passengerId);
        const curDraft = v.draftState;
        const cleanedDraft = curDraft ? {
          ...curDraft,
          presentIds: curDraft.presentIds?.filter((id) => id !== passengerId),
          absentIds: curDraft.absentIds?.filter((id) => id !== passengerId),
          sponsoredIds: curDraft.sponsoredIds?.filter((id) => id !== passengerId),
        } : undefined;
        return { ...v, riders: nextRiders, draftState: cleanedDraft };
      }
      return v;
    });

    const cleanedSourceSignups = fromManifest.signups.filter((p) => p.id !== passengerId);

    const updatedSourceManifest: Manifest = {
      ...fromManifest,
      signups: cleanedSourceSignups,
      vehicles: cleanedSourceVehicles,
    };

    // 2. Add to destination manifest
    const destinationPassenger: Passenger = {
      ...passengerToMove,
      assignedTo: toVehicleId,
      present: true,
      service: toService,
    };

    const stopLabel = hubDisplayName(targetVehicle.type, destinationPassenger.stop || 'Walk-In');

    const updatedDestVehicles = toManifest.vehicles.map((v) => {
      if (v.id === toVehicleId) {
        const nextRiders = v.riders.includes(destinationPassenger.id)
          ? v.riders
          : [...v.riders, destinationPassenger.id];
        const nextStops = (v.orderedStops || []).includes(stopLabel)
          ? v.orderedStops || []
          : [...(v.orderedStops || []), stopLabel];
        const curDraft = v.draftState || {};
        const pIds = curDraft.presentIds || [];
        const nextPIds = pIds.includes(destinationPassenger.id) ? pIds : [...pIds, destinationPassenger.id];
        const nextAIds = (curDraft.absentIds || []).filter((id) => id !== destinationPassenger.id);

        return {
          ...v,
          riders: nextRiders,
          orderedStops: nextStops,
          draftState: {
            ...curDraft,
            presentIds: nextPIds,
            absentIds: nextAIds,
            repName: repName || v.repName || curDraft.repName || '',
            licensePlate: licensePlate || v.licensePlate || curDraft.licensePlate || '',
            updatedAt: new Date().toISOString(),
          },
        };
      }
      return v;
    });

    const existingSignupIdx = toManifest.signups.findIndex((p) => p.id === destinationPassenger.id);
    const updatedDestSignups = [...toManifest.signups];
    if (existingSignupIdx >= 0) {
      updatedDestSignups[existingSignupIdx] = destinationPassenger;
    } else {
      updatedDestSignups.push(destinationPassenger);
    }

    const updatedDestManifest: Manifest = {
      ...toManifest,
      signups: updatedDestSignups,
      vehicles: updatedDestVehicles,
    };

    // 3. Save both manifests concurrently
    await Promise.all([
      upsertManifest(updatedSourceManifest),
      upsertManifest(updatedDestManifest),
    ]);

    return { success: true, passenger: destinationPassenger };
  } catch (err) {
    console.error('[CrossCheck] Transfer execution failed:', err);
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown transfer error occurred.',
    };
  }
}
