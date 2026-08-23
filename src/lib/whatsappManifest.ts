import { shortDate, parseManifestKey } from './dates';
import { SERVICE_TYPES, hubDisplayName, type Manifest, type Vehicle, type Passenger, type ServiceType } from './types';
import { sortVehiclesNatural } from './sort';

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
    const label = hubDisplayName(vehicle.type, r.stop);
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
 * 🛑 Braam - *06:30*
 * 
 *  *Taxi 3* 
 * 🛑 Braam - *06:30*
 * 🛑 Gate 7 - *06:35*
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
      lines.push(time ? `🛑 ${group.label} - *${time}*` : `🛑 ${group.label}`);
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
    for (const group of groups) {
      lines.push(`🛑 ${group.label} (${group.riders.length})`);
      for (const rider of group.riders) {
        lines.push(`${riderNumber}. ${rider.fullName.trim()}`);
        riderNumber++;
      }
    }

    const note = (vehicle.generalNotes ?? '').trim();
    if (note) lines.push(`(${note})`);
  }

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
