import { shortDate, parseManifestKey } from './dates';
import { SERVICE_TYPES, hubDisplayName, getEffectiveStop, type Manifest, type Vehicle, type Passenger, type ServiceType } from './types';
import { sortVehiclesNatural } from './sort';
import { isPassengerRepOfVehicle, matchRiderToOfficialRep, detectVehicleRep } from './officialReps';

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

  const vehiclesToExport = sortVehiclesNatural((manifest?.vehicles || []).filter((v) => !v.submitted));

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

  const vehiclesToExport = sortVehiclesNatural((manifest?.vehicles || []).filter((v) => !v.submitted));

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
    `Hi ${repName} 👋`,
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
      ? `🛑 *${group.label}* — ${pickupTime}`
      : `🛑 *${group.label}*`);

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
