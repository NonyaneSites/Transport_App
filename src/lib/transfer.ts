import { supabase, MANIFESTS_TABLE, mockStorage } from './supabase';
import type { Manifest, Passenger, Vehicle, ServiceType } from './types';
import { manifestKey, parseManifestKey } from './dates';
import { hubDisplayName } from './types';
import { loadManifest, upsertManifest } from './manifest';

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

/**
 * Standard Levenshtein distance for fuzzy string comparison.
 */
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[m][n];
}

/**
 * Normalizes structure codes (e.g. "S9", "s9", "Structure 9", "9", "S9A") into a canonical value (e.g. "9", "9A").
 */
export function normalizeStructure(s?: string | null): string {
  if (!s) return '';
  const trimmed = s.trim().toUpperCase();
  const numMatch = trimmed.match(/^(?:STRUCTURE|STRUCT|S)?\s*([0-9]+[A-Z]?)$/i);
  if (numMatch) {
    return numMatch[1].toUpperCase();
  }
  return trimmed.replace(/[^A-Z0-9]/g, '');
}

/**
 * Extracts embedded structure tags from text (e.g. "Amo Nhlabathi (S9)" -> name: "Amo Nhlabathi", structure: "S9").
 */
export function extractStructureFromText(text: string): { cleanText: string; structure?: string } {
  if (!text) return { cleanText: '' };
  
  const bracketMatch = text.match(/([([{])\s*(?:structure|struct|s)?\s*([0-9]+[a-z]?|[a-z0-9]+)\s*([)\]}])/i);
  if (bracketMatch) {
    const rawVal = bracketMatch[1].toUpperCase();
    const structVal = rawVal.startsWith('S') ? rawVal : `S${rawVal}`;
    const clean = text.replace(bracketMatch[0], '').trim().replace(/\s+/g, ' ');
    return { cleanText: clean, structure: structVal };
  }

  const trailingMatch = text.match(/\b(?:structure|struct|s)\s*([0-9]+[a-z]?)\b$/i);
  if (trailingMatch) {
    const rawVal = trailingMatch[1].toUpperCase();
    const clean = text.substring(0, trailingMatch.index).trim();
    return { cleanText: clean, structure: `S${rawVal}` };
  }

  return { cleanText: text.trim().replace(/\s+/g, ' ') };
}

/**
 * Compares surnames: must be identical or at most 1 char typo for length >= 5.
 */
function isSurnameMatch(s1: string, s2: string): boolean {
  if (s1 === s2) return true;
  if (Math.min(s1.length, s2.length) >= 5 && levenshteinDistance(s1, s2) <= 1) {
    return true;
  }
  return false;
}

/**
 * Compares first names: matches exact, nickname / prefix (e.g. Amo -> Amogelang, Chris -> Christopher),
 * or minor typo (distance <= 1).
 */
function isFirstNameMatch(f1: string, f2: string): boolean {
  if (f1 === f2) return true;
  // Prefix / nickname abbreviation (e.g. "amo" for "amogelang", "dan" for "daniel")
  if (f1.length >= 3 && f2.startsWith(f1)) return true;
  if (f2.length >= 3 && f1.startsWith(f2)) return true;
  // Minor typo for longer names
  if (Math.min(f1.length, f2.length) >= 4 && levenshteinDistance(f1, f2) <= 1) {
    return true;
  }
  return false;
}

/**
 * Checks if a walk-in entry matches an existing passenger for a transfer:
 * 1. Requires structure to match when both are present (e.g. S9 === S9). Conflicting structures never transfer.
 * 2. Requires both first name and surname to be almost identical (e.g. Amogelang Nhlabathi vs Amo Nhlabathi).
 * 3. Prevents ambiguous single-token substring matches from hijacking transfers.
 */
export function isPassengerTransferMatch(
  walkIn: { fullName: string; structure?: string | null },
  candidate: { fullName: string; structure?: string | null }
): { isMatch: boolean; score: number } {
  const walkInExtracted = extractStructureFromText(walkIn.fullName);
  const candExtracted = extractStructureFromText(candidate.fullName);

  const cleanWalkIn = walkInExtracted.cleanText.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim();
  const cleanCand = candExtracted.cleanText.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim();

  const walkInStruct = normalizeStructure(walkIn.structure || walkInExtracted.structure);
  const candStruct = normalizeStructure(candidate.structure || candExtracted.structure);

  // Structural constraint: if both specify a structure, they MUST match.
  if (walkInStruct && candStruct && walkInStruct !== candStruct) {
    return { isMatch: false, score: 0 };
  }

  const tokens1 = cleanWalkIn.split(/\s+/).filter(Boolean);
  const tokens2 = cleanCand.split(/\s+/).filter(Boolean);

  if (tokens1.length === 0 || tokens2.length === 0) {
    return { isMatch: false, score: 0 };
  }

  // Single-word input constraint: must be exact match and have structure match
  if (tokens1.length === 1 || tokens2.length === 1) {
    if (tokens1.join(' ') === tokens2.join(' ')) {
      if (walkInStruct && candStruct && walkInStruct === candStruct) {
        return { isMatch: true, score: 0.9 };
      }
    }
    return { isMatch: false, score: 0 };
  }

  // Surnames (last word)
  const surname1 = tokens1[tokens1.length - 1];
  const surname2 = tokens2[tokens2.length - 1];
  if (!isSurnameMatch(surname1, surname2)) {
    return { isMatch: false, score: 0 };
  }

  // First names (preceding words)
  const first1 = tokens1.slice(0, -1).join(' ');
  const first2 = tokens2.slice(0, -1).join(' ');
  if (!isFirstNameMatch(first1, first2)) {
    return { isMatch: false, score: 0 };
  }

  let score = 0.9;
  if (walkInStruct && candStruct && walkInStruct === candStruct) {
    score = 1.0;
  }

  return { isMatch: true, score };
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
 * Searches across compatible services for a specific date to find a passenger by name and structure.
 * EXCLUDES all cross-period services (e.g. AM <-> PM) so incompatible time slots never show a transfer popup.
 */
export async function crossCheckPassengerAcrossDate(
  date: string,
  currentService: ServiceType,
  queryName: string,
  queryStructure?: string
): Promise<CrossCheckCandidate[]> {
  const cleanQ = queryName.trim();
  if (!cleanQ || cleanQ.length < 2) return [];

  const currentPeriod = getServicePeriod(currentService);
  const walkInInfo = { fullName: cleanQ, structure: queryStructure?.trim() || null };
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

      // EXCLUSION: If it's AM to PM (or PM to AM), that is NOT a valid transfer.
      // Exclude completely so no popups or modals appear.
      if (mPeriod !== currentPeriod) {
        continue;
      }

      // Skip current service (same-manifest checks are handled directly in RepPage)
      if (sType === currentService) {
        continue;
      }

      for (const p of m.signups || []) {
        const match = isPassengerTransferMatch(walkInInfo, {
          fullName: p.fullName,
          structure: p.structure,
        });

        if (match.isMatch) {
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
            isCompatible: true,
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
