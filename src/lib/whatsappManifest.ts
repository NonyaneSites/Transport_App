import { shortDate, parseManifestKey, manifestKey } from './dates';
import { loadManifest } from './manifest';
import { SERVICE_TYPES, hubDisplayName, getEffectiveStop, type Manifest, type Vehicle, type Passenger, type ServiceType } from './types';
import { sortVehiclesNatural } from './sort';
import { isPassengerRepOfVehicle, matchRiderToOfficialRep, detectVehicleRep, detectAllVehicleReps, getRepStructure } from './officialReps';

function periodLabel(period: 'AM' | 'PM'): string {
  return period === 'AM' ? 'Morning' : 'Evening';
}

function serviceTitle(service: ServiceType, style: 'standard' | 'rep'): string {
  const def = SERVICE_TYPES.find((s) => s.value === service);
  if (style === 'rep') {
    if (service === 'AM_Serving') return 'Am Serving Taxis';
    if (service === 'PM_Serving') return 'Pm Serving Taxis';
    if (service === 'AM_Normal') return 'Am Normal Taxis';
    if (service === 'PM_Normal') return 'Pm Normal Taxis';
    return def ? `${def.period === 'AM' ? 'Am' : 'Pm'} ${def.mode} Taxis` : `${service} Taxis`;
  }
  return def ? `${periodLabel(def.period)} ${def.mode} Taxis` : `${service} Taxis`;
}

function getRiderPassengers(manifest: Manifest, vehicle: Vehicle): Passenger[] {
  const signups = manifest?.signups || [];
  const riders = vehicle?.riders || [];
  return riders
    .map((id) => signups.find((p) => p.id === id))
    .filter((p): p is Passenger => Boolean(p));
}

export function getRidersGroupedByHub(manifest: Manifest, vehicle: Vehicle): { label: string; riders: Passenger[] }[] {
  const riders = getRiderPassengers(manifest, vehicle);
  const groups: Record<string, Passenger[]> = {};
  for (const r of riders) {
    const label = getEffectiveStop(vehicle, r.stop);
    if (!groups[label]) groups[label] = [];
    groups[label].push(r);
  }
  const order = vehicle.orderedStops ?? [];
  const orderedLabels = order.filter((l) => groups[l]);
  const extraLabels = Object.keys(groups)
    .filter((l) => !orderedLabels.includes(l))
    .sort((a, b) => groups[b].length - groups[a].length);
  return [...orderedLabels, ...extraLabels].map((label) => ({ label, riders: groups[label] }));
}

/**
 * Builds the standard WhatsApp Route/Stop Schedule Manifest
 * with distinct blank line spacing between vehicle blocks and bold markdown formatting:
 * e.g.
 * *Morning Serving Taxis*
 * *23/08/2026*
 * 
 *  *Taxi 1* 
 * 🛑 Braam - *06:30*
 * 
 *  *Taxi 2* 
 * 🛑 DFC bus stop (incl. Saratoga) - *06:30*
 */
export function generateWhatsAppRouteManifest(manifest: Manifest, service: ServiceType): string {
  const lines: string[] = [];
  const { date: sessionDate } = parseManifestKey(manifest?.date || '');
  const header = serviceTitle(service, 'standard');

  lines.push(`*${header}*`);
  lines.push(`*${shortDate(sessionDate)}*`);

  const vehiclesToExport = sortVehiclesNatural(manifest?.vehicles || []);

  for (const vehicle of vehiclesToExport) {
    const riders = getRiderPassengers(manifest, vehicle);
    if (riders.length === 0) continue;

    // Distinct blank line separation before each vehicle block
    lines.push('');
    lines.push(` *${vehicle.name}* `);

    const groups = getRidersGroupedByHub(manifest, vehicle);
    for (const group of groups) {
      const time = vehicle.stopTimes?.[group.label];
      const redirectedFrom = Array.from(
        new Set(
          group.riders
            .filter((r) => hubDisplayName(vehicle.type, r.stop) !== group.label)
            .map((r) => hubDisplayName(vehicle.type, r.stop))
        )
      );

      const inclSuffix = redirectedFrom.length > 0 ? ` (incl. ${redirectedFrom.join(', ')})` : '';
      lines.push(time ? `🛑 ${group.label}${inclSuffix} - *${time}*` : `🛑 ${group.label}${inclSuffix}`);
    }

    const note = (vehicle.generalNotes ?? '').trim();
    if (note) lines.push(`(${note})`);
  }

  return lines.join('\n');
}

/**
 * Builds the detailed WhatsApp Rep Manifest with passenger names numbered per stop
 * with clean blank lines between vehicles and bold headings
 */
export function generateWhatsAppRepManifest(manifest: Manifest, service: ServiceType): string {
  const lines: string[] = [];
  const { date: sessionDate } = parseManifestKey(manifest?.date || '');
  const header = serviceTitle(service, 'rep');

  lines.push(`*${header}*`);
  lines.push(`*${shortDate(sessionDate)}*`);

  // Rep manifest is strictly for taxis only; buses are excluded even if present in the manifest
  const vehiclesToExport = sortVehiclesNatural(
    (manifest?.vehicles || []).filter(
      (v) => v.type === 'Taxi' || (v.type !== 'Bus' && !v.name.toLowerCase().includes('bus'))
    )
  );

  for (const vehicle of vehiclesToExport) {
    const riders = getRiderPassengers(manifest, vehicle);
    if (riders.length === 0) continue;

    // Distinct blank line separation before each vehicle block
    lines.push('');

    const groups = getRidersGroupedByHub(manifest, vehicle);
    
    // If vehicle has multiple stops, show " *Taxi X - <total riders>* ", otherwise " *Taxi X* "
    if (groups.length > 1) {
      lines.push(` *${vehicle.name} - ${riders.length}* `);
    } else {
      lines.push(` *${vehicle.name}* `);
    }

    let riderNumber = 1;
    const assignedRepRaw = (vehicle.repName || vehicle.submittedBy || '').trim();
    const detectedRepName = detectVehicleRep(riders);

    for (const group of groups) {
      const redirectedRiders = group.riders.filter((r) => hubDisplayName(vehicle.type, r.stop) !== group.label);
      const redirectedFrom = Array.from(new Set(redirectedRiders.map((r) => hubDisplayName(vehicle.type, r.stop))));
      
      const inclText = redirectedFrom.length > 0 ? ` - (incl. ${redirectedRiders.length} from ${redirectedFrom.join(', ')})` : '';
      lines.push(`🛑 ${group.label} (${group.riders.length})${inclText}`);

      for (const rider of group.riders) {
        let isRep = false;
        if (assignedRepRaw) {
          isRep = isPassengerRepOfVehicle(rider, assignedRepRaw);
        } else if (detectedRepName) {
          isRep = isPassengerRepOfVehicle(rider, detectedRepName) || Boolean(matchRiderToOfficialRep(rider));
        } else {
          isRep = Boolean(matchRiderToOfficialRep(rider));
        }

        const cleanName = rider.fullName.trim().replace(/^\*+|\*+$/g, '');
        const displayName = isRep ? `*${cleanName}*` : cleanName;
        const origStop = hubDisplayName(vehicle.type, rider.stop);
        const fromSuffix = origStop !== group.label ? ` (from ${origStop})` : '';

        lines.push(`${riderNumber}. ${displayName}${fromSuffix}`);
        riderNumber++;
      }
    }

    const note = (vehicle.generalNotes ?? '').trim();
    if (note) lines.push(`(${note})`);
  }

  return lines.join('\n');
}

/**
 * Returns the passenger record for the primary rep assigned to a vehicle.
 * The passenger record is the source of the WhatsApp number imported from
 * the weekly booking sheet.
 */
export function findVehicleRepPassenger(manifest: Manifest, vehicle: Vehicle): Passenger | undefined {
  if (!vehicle.repName) return undefined;

  return getRiderPassengers(manifest, vehicle).find((passenger) =>
    isPassengerRepOfVehicle(passenger, vehicle.repName)
    || passenger.fullName.trim().toLowerCase() === vehicle.repName?.trim().toLowerCase()
  );
}

/** Converts common South African phone formats to the digits-only wa.me format. */
export function normalizeWhatsAppPhone(phone?: string | null): string | null {
  if (!phone) return null;

  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = `27${digits.slice(1)}`;
  if (digits.length === 9) digits = `27${digits}`;

  return /^\d{10,15}$/.test(digits) ? digits : null;
}

/** Builds a private, vehicle-specific message for one transport rep. */
export function generateWhatsAppVehicleRepMessage(
  manifest: Manifest,
  vehicle: Vehicle,
  service: ServiceType,
  repPortalUrl?: string
): string {
  const { date: sessionDate } = parseManifestKey(manifest?.date || '');
  const riders = getRiderPassengers(manifest, vehicle);
  const groups = getRidersGroupedByHub(manifest, vehicle);
  const repName = vehicle.repName?.trim() || 'Transport Rep';
  const lines: string[] = [
    `Hi ${repName} `,
    '',
    `You have been assigned as the transport rep for *${vehicle.name}* on *${shortDate(sessionDate)}*.`,
    `Service: *${serviceTitle(service, 'standard')}*`,
    `Passengers: *${riders.length}*`,
  ];

  let riderNumber = 1;
  for (const group of groups) {
    const pickupTime = vehicle.stopTimes?.[group.label];
    lines.push('');
    lines.push(pickupTime
      ? `*${group.label}* — ${pickupTime}`
      : `*${group.label}*`);

    for (const rider of group.riders) {
      const isRep = isPassengerRepOfVehicle(rider, vehicle.repName);
      const cleanName = rider.fullName.trim().replace(/^\*+|\*+$/g, '');
      lines.push(`${riderNumber}. ${isRep ? `*${cleanName}*` : cleanName}`);
      riderNumber++;
    }
  }

  const note = vehicle.generalNotes?.trim();
  if (note) {
    lines.push('');
    lines.push(`*Note:* ${note}`);
  }

  lines.push('');
  lines.push('Please record attendance, cash collected and the vehicle registration number in the Rep Portal.');
  if (repPortalUrl) lines.push(repPortalUrl);

  return lines.join('\n');
}

/**
 * Downloads a text string as a UTF-8 text file.
 */
export function downloadTextFile(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Builds a dedicated list of the allocated rep for each Taxi (taxis only, buses strictly excluded).
 * Returns a clean, WhatsApp-friendly formatted summary.
 *
 * Example:
 * 🚕 *TAXI REPS — MORNING SERVING TAXIS*
 * 📅 *Date:* 23/08/2026
 * 👥 *Total Taxis:* 4
 *
 * • *Taxi 1*: Thato Ndwebi (S9) - 071 234 5678
 * • *Taxi 2*: Keabetswe Mokoena (S2) - 082 345 6789
 * • *Taxi 3*: Sipho Dlamini (S1)
 * • *Taxi 4*: [No rep allocated]
 */
export function generateTaxiRepsManifest(manifest: Manifest, service: ServiceType): string {
  const lines: string[] = [];
  const { date: sessionDate } = parseManifestKey(manifest?.date || '');
  const header = serviceTitle(service, 'rep');

  lines.push(`🚕 *TAXI REPS — ${header.toUpperCase()}*`);
  if (sessionDate) {
    lines.push(`📅 *Date:* ${shortDate(sessionDate)}`);
  }

  // Taxis only — buses are strictly excluded
  const taxiVehicles = sortVehiclesNatural(
    (manifest?.vehicles || []).filter(
      (v) => v.type === 'Taxi' || (v.type !== 'Bus' && !v.name.toLowerCase().includes('bus'))
    )
  );

  if (taxiVehicles.length === 0) {
    lines.push('');
    lines.push('No taxis found in this session manifest.');
    return lines.join('\n');
  }

  lines.push(`👥 *Total Taxis:* ${taxiVehicles.length}`);
  lines.push('');

  for (const vehicle of taxiVehicles) {
    const riders = getRiderPassengers(manifest, vehicle);
    const allDetectedReps = detectAllVehicleReps(riders);
    const detectedOfficialRep = allDetectedReps.length > 0 ? allDetectedReps[0].rep.fullName : null;
    const selectedRepObj = allDetectedReps.find((d) => isPassengerRepOfVehicle(d.rider, vehicle.repName));

    // Resolved rep name
    const effectiveRepName = (vehicle.repName || detectedOfficialRep || '').trim();

    // Rep structure
    const repStruct = vehicle.repName
      ? getRepStructure(vehicle.repName)
      : (selectedRepObj ? selectedRepObj.rep.structure : (detectedOfficialRep ? getRepStructure(detectedOfficialRep) : null));

    // Rep phone (lookup in riders)
    const repPassenger = riders.find((r) =>
      effectiveRepName && (
        isPassengerRepOfVehicle(r, effectiveRepName) ||
        r.fullName.trim().toLowerCase() === effectiveRepName.toLowerCase()
      )
    );
    const phone = repPassenger?.phone?.trim() || null;

    // Co-reps if any
    const coReps = (vehicle.coReps || vehicle.draftState?.coReps || []).filter(Boolean);

    let repText = '';
    if (effectiveRepName) {
      const structText = repStruct ? ` (${repStruct})` : (repPassenger?.structure ? ` (${repPassenger.structure})` : '');
      const coRepsText = coReps.length > 0 ? ` & ${coReps.join(', ')} (Co-rep)` : '';
      const phoneText = phone ? ` - ${phone}` : '';
      repText = `${effectiveRepName}${structText}${coRepsText}${phoneText}`;
    } else if (riders.length === 0) {
      repText = '[Empty taxi - 0 riders]';
    } else {
      repText = '[No rep allocated]';
    }

    lines.push(`• *${vehicle.name}*: ${repText}`);
  }

  return lines.join('\n');
}

/**
 * Builds a plain text list of taxi reps (one taxi per line).
 */
export function generateSimpleTaxiRepsList(manifest: Manifest): string {
  const taxiVehicles = sortVehiclesNatural(
    (manifest?.vehicles || []).filter(
      (v) => v.type === 'Taxi' || (v.type !== 'Bus' && !v.name.toLowerCase().includes('bus'))
    )
  );
  if (taxiVehicles.length === 0) return 'No taxis found';

  return taxiVehicles.map((vehicle) => {
    const riders = getRiderPassengers(manifest, vehicle);
    const allDetectedReps = detectAllVehicleReps(riders);
    const detectedOfficialRep = allDetectedReps.length > 0 ? allDetectedReps[0].rep.fullName : null;
    const selectedRepObj = allDetectedReps.find((d) => isPassengerRepOfVehicle(d.rider, vehicle.repName));
    const effectiveRepName = (vehicle.repName || detectedOfficialRep || '').trim();
    const repStruct = vehicle.repName
      ? getRepStructure(vehicle.repName)
      : (selectedRepObj ? selectedRepObj.rep.structure : (detectedOfficialRep ? getRepStructure(detectedOfficialRep) : null));
    const repPassenger = riders.find((r) =>
      effectiveRepName && (
        isPassengerRepOfVehicle(r, effectiveRepName) ||
        r.fullName.trim().toLowerCase() === effectiveRepName.toLowerCase()
      )
    );
    const phone = repPassenger?.phone?.trim() || null;
    const structText = repStruct ? ` (${repStruct})` : (repPassenger?.structure ? ` (${repPassenger.structure})` : '');
    const coReps = (vehicle.coReps || vehicle.draftState?.coReps || []).filter(Boolean);
    const coRepsText = coReps.length > 0 ? ` & ${coReps.join(', ')} (Co-rep)` : '';
    const phoneText = phone ? ` - ${phone}` : '';
    let repText = '';
    if (effectiveRepName) {
      repText = `${effectiveRepName}${structText}${coRepsText}${phoneText}`;
    } else if (riders.length === 0) {
      repText = '[Empty taxi - 0 riders]';
    } else {
      repText = '[No rep allocated]';
    }
    return `${vehicle.name}: ${repText}`;
  }).join('\n');
}

export const SUNDAY_SERVICES_ORDER: { service: ServiceType; label: string; header: string }[] = [
  { service: 'AM_Serving', label: 'AM Serving', header: 'AM SERVING TAXIS' },
  { service: 'AM_Normal', label: 'AM Normal', header: 'AM NORMAL TAXIS' },
  { service: 'PM_Serving', label: 'PM Serving', header: 'PM SERVING TAXIS' },
  { service: 'PM_Normal', label: 'PM Normal', header: 'PM NORMAL TAXIS' },
];

/**
 * Builds a plain text list of taxi reps across all 4 Sunday services:
 * AM Serving, AM Normal, PM Serving, PM Normal.
 * Taxis only (buses strictly excluded).
 */
export function generateAllSundayTaxiRepsSimpleList(
  entries: Array<{ service: ServiceType | string; label?: string; manifest?: Manifest | null }>
): string {
  const sections: string[] = [];

  for (const item of SUNDAY_SERVICES_ORDER) {
    const entry = entries.find((e) => e.service === item.service);
    const manifest = entry?.manifest;
    let body = 'No taxis allocated';
    if (manifest) {
      const list = generateSimpleTaxiRepsList(manifest);
      if (list && list !== 'No taxis found') {
        body = list;
      }
    }
    sections.push(`${item.header}\n${body}`);
  }

  return sections.join('\n\n');
}

/**
 * Loads all 4 Sunday manifests asynchronously for a given session date,
 * allowing an in-memory/latest currentManifest to override the active service slot.
 */
export async function loadSundayManifests(
  sessionDate: string,
  currentManifest?: Manifest | null
): Promise<Array<{ service: ServiceType; label: string; manifest: Manifest | null }>> {
  return Promise.all(
    SUNDAY_SERVICES_ORDER.map(async (item) => {
      if (currentManifest && currentManifest.date) {
        const { date: cDate, service: cService } = parseManifestKey(currentManifest.date);
        if (cDate === sessionDate && cService === item.service) {
          return { service: item.service, label: item.label, manifest: currentManifest };
        }
      }
      try {
        const key = manifestKey(sessionDate, item.service);
        const m = await loadManifest(key);
        return { service: item.service, label: item.label, manifest: m };
      } catch (err) {
        console.warn(`[loadSundayManifests] Could not load ${item.service} manifest:`, err);
        return { service: item.service, label: item.label, manifest: null };
      }
    })
  );
}

export { formatRehearsalWhatsAppManifest, formatSingleTaxiRehearsalWhatsApp } from './rehearsal';


