import * as XLSX from 'xlsx';
import type { Manifest, Vehicle, Passenger } from './types';
import { sortVehiclesNatural } from './sort';
import { shortDate, parseManifestKey, prettyDate } from './dates';

export interface ExtractedVehicleStats {
  vehicleId: string;
  name: string;
  type: 'Bus' | 'Taxi';
  repName: string;
  licensePlate: string;
  status: 'Submitted' | 'Draft in Progress' | 'Unmarked';
  totalRiders: number;
  presentCount: number;
  absentCount: number;
  ftvCount: number;
  sponsoredCount: number;
  fareCollected: number;
  presentRiders: Passenger[];
  absentRiders: Passenger[];
  ftvRiders: Passenger[];
  sponsoredRiders: Passenger[];
  presentListStr: string;
  ftvListStr: string;
  sponsoredListStr: string;
  cancellationListStr: string;
  generalNotes: string;
  rawRiders: Passenger[];
  submittedAt?: string;
}

/**
 * Checks if a passenger's structure, memberType, category, or notes suggest they are a First Time Visitor
 */
export function isAutoFirstTimeVisitor(passenger: Passenger, riderNote?: string): boolean {
  if (passenger.memberType === 'FTV') {
    return true;
  }
  const s = (passenger.structure || '').toUpperCase();
  const m = (passenger.ministry || '').toUpperCase();
  const cat = (passenger.category || '').toUpperCase();
  const n = (riderNote || '').toUpperCase();
  const name = (passenger.fullName || '').toUpperCase();

  if (s.includes('FTV') || s.includes('VISITOR') || s.includes('FIRST TIME') || s.includes('GUEST') || s.includes('NEW')) {
    return true;
  }
  if (name.includes('FTV') || name.includes('FIRST TIME')) {
    return true;
  }
  if (m.includes('FTV') || m.includes('VISITOR') || m.includes('FIRST TIME')) {
    return true;
  }
  if (cat.includes('FTV') || cat.includes('VISITOR')) {
    return true;
  }
  if (n.includes('FTV') || n.includes('VISITOR') || n.includes('FIRST TIME')) {
    return true;
  }
  return false;
}

/**
 * Formats a passenger as "Full Name Structure" (e.g. "Thabo Mokoena S3")
 */
export function formatPassengerStat(p: Passenger): string {
  const name = p.fullName.trim();
  const struct = (p.structure || '').trim();
  return struct ? `${name} ${struct}` : name;
}

/**
 * Joins a list of passengers into a comma-separated formatted string
 */
export function joinPassengerStats(passengers: Passenger[]): string {
  if (passengers.length === 0) return 'None';
  return passengers.map(formatPassengerStat).join(', ');
}

/**
 * Extracts comprehensive stats from a single vehicle in a manifest
 */
export function extractVehicleStats(
  vehicle: Vehicle,
  passengerLookup: (id: string) => Passenger | undefined
): ExtractedVehicleStats {
  const rawRiders = (vehicle?.riders || [])
    .map(passengerLookup)
    .filter((p): p is Passenger => Boolean(p));

  const isSubmitted = Boolean(vehicle?.submitted);
  const hasDraft = Boolean(vehicle?.draftState && (vehicle?.draftState?.presentIds?.length || vehicle?.draftState?.absentIds?.length));

  let status: 'Submitted' | 'Draft in Progress' | 'Unmarked' = 'Unmarked';
  if (isSubmitted) {
    status = 'Submitted';
  } else if (hasDraft) {
    status = 'Draft in Progress';
  }

  let presentRiders: Passenger[] = [];
  let absentRiders: Passenger[] = [];
  let sponsoredRiders: Passenger[] = [];
  let ftvRiders: Passenger[] = [];

  const notesMap = vehicle?.draftState?.notes || {};

  if (isSubmitted) {
    // When submitted, presence and sponsored flags are persisted directly on signups
    presentRiders = rawRiders.filter((p) => p.present);
    absentRiders = rawRiders.filter((p) => !p.present);
    sponsoredRiders = rawRiders.filter((p) => p.sponsored);
    ftvRiders = presentRiders.filter((p) => isAutoFirstTimeVisitor(p, notesMap[p.id]));
  } else if (hasDraft && vehicle?.draftState) {
    // When in draft, read from draftState ID sets
    const pSet = new Set(vehicle.draftState.presentIds || []);
    const aSet = new Set(vehicle.draftState.absentIds || []);
    const sSet = new Set(vehicle.draftState.sponsoredIds || []);

    presentRiders = rawRiders.filter((p) => pSet.has(p.id));
    absentRiders = rawRiders.filter((p) => aSet.has(p.id));
    sponsoredRiders = rawRiders.filter((p) => sSet.has(p.id) || p.sponsored);
    ftvRiders = presentRiders.filter((p) => isAutoFirstTimeVisitor(p, notesMap[p.id]));
  } else {
    // Unmarked: treat all as allocated, auto-detect sponsored or FTV markers
    presentRiders = [];
    absentRiders = [];
    sponsoredRiders = rawRiders.filter((p) => p.sponsored);
    ftvRiders = rawRiders.filter((p) => isAutoFirstTimeVisitor(p, notesMap[p.id]));
  }

  const presentListStr = joinPassengerStats(presentRiders);
  const ftvListStr = joinPassengerStats(ftvRiders);
  const sponsoredListStr = joinPassengerStats(sponsoredRiders);
  const cancellationListStr = joinPassengerStats(absentRiders);

  // R40 per present passenger (Buses free or 0 fare)
  const fareCollected = (vehicle?.type || 'Taxi') === 'Bus' ? 0 : presentRiders.length * 40;

  return {
    vehicleId: vehicle?.id || '',
    name: vehicle?.name || 'Vehicle',
    type: vehicle?.type || 'Taxi',
    repName: vehicle?.repName || vehicle?.submittedBy || '—',
    licensePlate: vehicle?.licensePlate || '—',
    status,
    totalRiders: rawRiders.length,
    presentCount: presentRiders.length,
    absentCount: absentRiders.length,
    ftvCount: ftvRiders.length,
    sponsoredCount: sponsoredRiders.length,
    fareCollected,
    presentRiders,
    absentRiders,
    ftvRiders,
    sponsoredRiders,
    presentListStr,
    ftvListStr,
    sponsoredListStr,
    cancellationListStr,
    generalNotes: vehicle?.generalNotes || vehicle?.draftState?.generalNotes || '',
    rawRiders,
    submittedAt: vehicle?.submittedAt,
  };
}

/**
 * Extracts stats for all vehicles in a manifest sorted in natural order
 */
export function extractAllVehicleStats(manifest: Manifest): ExtractedVehicleStats[] {
  const signups = manifest?.signups || [];
  const passengerLookup = (id: string) => signups.find((p) => p.id === id);
  const sorted = sortVehiclesNatural(manifest?.vehicles || []);
  return sorted.map((v) => extractVehicleStats(v, passengerLookup));
}

/**
 * Generates an Excel (.xlsx) workbook containing:
 * 1. Sheet "Transport Stats Summary" with the exact columns
 * 2. Sheet "Detailed Passenger Roster"
 * 3. Sheet "Stats Link Format"
 */
export function downloadTaxiStatsExcel(manifest: Manifest, customFileName?: string): void {
  const statsList = extractAllVehicleStats(manifest);
  const { date: sessionDate, service: sessionService } = parseManifestKey(manifest.date);
  const wb = XLSX.utils.book_new();

  // 1. Sheet 1: Transport Stats Summary (Matches exact transport stats columns)
  const summaryRows = statsList.map((s) => ({
    'Timestamp': s.submittedAt || new Date().toISOString(),
    'Money Collector Name & Surname': s.repName !== '—' ? s.repName : '',
    'Date': sessionDate,
    'Service': sessionService || 'Service',
    'Vehicle type': s.type,
    'Vehicle Number Plate': s.licensePlate !== '—' ? s.licensePlate : '',
    'Taxi No./Bus No.': s.name,
    'Members & Visitors list (Name & Surname - As written when booking)': s.presentListStr,
    "FTV's List (Name & Surname - As written when booking)": s.ftvListStr,
    'Headcount': s.presentCount,
    'Total Money Collected ': s.fareCollected,
    'Money Outstanding/extra ': s.absentCount > 0 ? -(s.absentCount * 40) : 0,
    'Cancellations (Full name incl. Structure)': s.cancellationListStr,
    'Sponsorships (Name, Surname and Structure)': s.sponsoredListStr,
    'Additional notes (People paying for others, Cancellations being paid etc.)': s.generalNotes,
  }));

  const totalHeadcount = statsList.reduce((sum, s) => sum + s.presentCount, 0);
  const totalCollected = statsList.reduce((sum, s) => sum + s.fareCollected, 0);
  const totalOutstanding = statsList.reduce((sum, s) => sum + (s.absentCount > 0 ? -(s.absentCount * 40) : 0), 0);

  summaryRows.push({
    'Timestamp': 'GRAND TOTAL',
    'Money Collector Name & Surname': '',
    'Date': sessionDate,
    'Service': sessionService || '',
    'Vehicle type': '—',
    'Vehicle Number Plate': '',
    'Taxi No./Bus No.': `${statsList.length} Vehicles`,
    'Members & Visitors list (Name & Surname - As written when booking)': '—',
    "FTV's List (Name & Surname - As written when booking)": '—',
    'Headcount': totalHeadcount,
    'Total Money Collected ': totalCollected,
    'Money Outstanding/extra ': totalOutstanding,
    'Cancellations (Full name incl. Structure)': '—',
    'Sponsorships (Name, Surname and Structure)': '—',
    'Additional notes (People paying for others, Cancellations being paid etc.)': '',
  });

  const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
  wsSummary['!cols'] = [
    { wch: 22 }, // Timestamp
    { wch: 24 }, // Money Collector
    { wch: 12 }, // Date
    { wch: 16 }, // Service
    { wch: 12 }, // Vehicle type
    { wch: 18 }, // Number Plate
    { wch: 16 }, // Taxi No./Bus No.
    { wch: 55 }, // Members & Visitors list
    { wch: 45 }, // FTV list
    { wch: 12 }, // Headcount
    { wch: 20 }, // Total Money Collected
    { wch: 22 }, // Money Outstanding/extra
    { wch: 45 }, // Cancellations
    { wch: 40 }, // Sponsorships
    { wch: 40 }, // Additional notes
  ];
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Transport Stats Summary');

  // 2. Sheet 2: Detailed Passenger Roster
  const passengerRows: Record<string, string | number>[] = [];
  statsList.forEach((s) => {
    s.rawRiders.forEach((p) => {
      const isPresent = s.status === 'Submitted' ? p.present : s.presentRiders.some((pr) => pr.id === p.id);
      const isAbsent = s.status === 'Submitted' ? !p.present : s.absentRiders.some((ar) => ar.id === p.id);
      const isFTV = isAutoFirstTimeVisitor(p);
      const isSponsored = s.status === 'Submitted' ? Boolean(p.sponsored) : s.sponsoredRiders.some((sr) => sr.id === p.id);

      passengerRows.push({
        'Vehicle': s.name,
        'Vehicle Type': s.type,
        'Full Name': p.fullName,
        'Structure': p.structure || '—',
        'Pickup Stop': p.stop,
        'Phone Number': p.phone || '—',
        'Status': isPresent ? 'Present' : isAbsent ? 'Absent' : 'Unmarked',
        'FTV': isFTV ? 'Yes' : 'No',
        'Sponsored': isSponsored ? 'Yes' : 'No',
        'Sponsor Note': p.sponsorNote || '',
        'Cancellation Debt (R)': isAbsent ? 40 : 0,
      });
    });
  });

  if (passengerRows.length > 0) {
    const wsPassengers = XLSX.utils.json_to_sheet(passengerRows);
    wsPassengers['!cols'] = [
      { wch: 14 },
      { wch: 10 },
      { wch: 28 },
      { wch: 12 },
      { wch: 24 },
      { wch: 16 },
      { wch: 12 },
      { wch: 8 },
      { wch: 10 },
      { wch: 25 },
      { wch: 20 },
    ];
    XLSX.utils.book_append_sheet(wb, wsPassengers, 'Detailed Roster');
  }

  // 3. Sheet 3: Stats Link Format
  const textBlocks: (string | number)[][] = [
    ['CRC Johannesburg — Transport Stats Link Summary'],
    [`Session Date: ${prettyDate(sessionDate)} · ${sessionService}`],
    [],
    ['Vehicle', 'Rep', 'Present Members & Visitors', 'First Time Visitors', 'Sponsorships', 'Cancellations'],
  ];

  statsList.forEach((s) => {
    textBlocks.push([
      s.name,
      s.repName,
      s.presentListStr,
      s.ftvListStr,
      s.sponsoredListStr,
      s.cancellationListStr,
    ]);
  });

  const wsBlocks = XLSX.utils.aoa_to_sheet(textBlocks);
  wsBlocks['!cols'] = [
    { wch: 16 }, { wch: 20 }, { wch: 50 }, { wch: 35 }, { wch: 30 }, { wch: 40 },
  ];
  XLSX.utils.book_append_sheet(wb, wsBlocks, 'Stats Link Format');

  const fileName = customFileName || `transport_stats_${sessionDate}_${sessionService || 'session'}.xlsx`;
  XLSX.writeFile(wb, fileName);
}

/**
 * Downloads a CSV formatted specifically matching the official Transport Stats format
 */
export function downloadTaxiStatsCSV(manifest: Manifest, customFileName?: string): void {
  const statsList = extractAllVehicleStats(manifest);
  const { date: sessionDate, service: sessionService } = parseManifestKey(manifest.date);

  const headers = [
    'Timestamp',
    'Money Collector Name & Surname',
    'Date',
    'Service',
    'Vehicle type',
    'Vehicle Number Plate',
    'Taxi No./Bus No.',
    'Members & Visitors list (Name & Surname - As written when booking)',
    "FTV's List (Name & Surname - As written when booking)",
    'Headcount',
    'Total Money Collected ',
    'Money Outstanding/extra ',
    'Cancellations (Full name incl. Structure)',
    'Sponsorships (Name, Surname and Structure)',
    'Additional notes (People paying for others, Cancellations being paid etc.)',
  ];

  const rows = statsList.map((s) => [
    s.submittedAt || new Date().toISOString(),
    s.repName !== '—' ? s.repName : '',
    sessionDate,
    sessionService || 'Service',
    s.type,
    s.licensePlate !== '—' ? s.licensePlate : '',
    s.name,
    s.presentListStr,
    s.ftvListStr,
    s.presentCount,
    s.fareCollected,
    s.absentCount > 0 ? -(s.absentCount * 40) : 0,
    s.cancellationListStr,
    s.sponsoredListStr,
    s.generalNotes,
  ]);

  const escapeCSV = (val: string | number) => {
    const str = String(val ?? '');
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const csvContent = [
    headers.map(escapeCSV).join(','),
    ...rows.map((row) => row.map(escapeCSV).join(',')),
  ].join('\n');

  const fileName = customFileName || `transport_stats_${sessionDate}_${sessionService || 'session'}.csv`;
  downloadTextBlob(csvContent, fileName, 'text/csv;charset=utf-8;');
}

/**
 * Generates TSV (Tab-Separated Values) matching Transport Stats headers
 */
export function generateTaxiStatsTSV(manifest: Manifest): string {
  const statsList = extractAllVehicleStats(manifest);
  const { date: sessionDate, service: sessionService } = parseManifestKey(manifest.date);

  const headers = [
    'Timestamp',
    'Money Collector Name & Surname',
    'Date',
    'Service',
    'Vehicle type',
    'Vehicle Number Plate',
    'Taxi No./Bus No.',
    'Members & Visitors list (Name & Surname - As written when booking)',
    "FTV's List (Name & Surname - As written when booking)",
    'Headcount',
    'Total Money Collected ',
    'Money Outstanding/extra ',
    'Cancellations (Full name incl. Structure)',
    'Sponsorships (Name, Surname and Structure)',
    'Additional notes (People paying for others, Cancellations being paid etc.)',
  ];

  const rows = statsList.map((s) => [
    s.submittedAt || new Date().toISOString(),
    s.repName !== '—' ? s.repName : '',
    sessionDate,
    sessionService || 'Service',
    s.type,
    s.licensePlate !== '—' ? s.licensePlate : '',
    s.name,
    s.presentListStr,
    s.ftvListStr,
    s.presentCount,
    s.fareCollected,
    s.absentCount > 0 ? -(s.absentCount * 40) : 0,
    s.cancellationListStr,
    s.sponsoredListStr,
    s.generalNotes,
  ]);

  return [
    headers.join('\t'),
    ...rows.map((row) => row.join('\t')),
  ].join('\n');
}

/**
 * Generates a consolidated WhatsApp message summarizing all transport stats
 */
export function generateConsolidatedWhatsAppStatsText(manifest: Manifest, serviceLabel?: string): string {
  const statsList = extractAllVehicleStats(manifest);
  const { date: sessionDate, service: sessionService } = parseManifestKey(manifest.date);

  const lines: string[] = [];
  lines.push(`*CRC JOHANNESBURG — TRANSPORT STATS*`);
  lines.push(`📅 *Date:* ${shortDate(sessionDate)}`);
  lines.push(`🏷️ *Service:* ${serviceLabel || sessionService}`);
  lines.push('');

  const totalAllocated = statsList.reduce((sum, s) => sum + s.totalRiders, 0);
  const totalPresent = statsList.reduce((sum, s) => sum + s.presentCount, 0);
  const totalAbsent = statsList.reduce((sum, s) => sum + s.absentCount, 0);
  const totalFTVs = statsList.reduce((sum, s) => sum + s.ftvCount, 0);
  const totalSponsored = statsList.reduce((sum, s) => sum + s.sponsoredCount, 0);
  const totalFares = statsList.reduce((sum, s) => sum + s.fareCollected, 0);

  lines.push(`📊 *Overview:* ${statsList.length} Vehicles | ${totalAllocated} Allocated | ${totalPresent} Present | ${totalAbsent} Absent | ${totalFTVs} FTVs | ${totalSponsored} Sponsored | R${totalFares} Total`);
  lines.push('───────────────────────────');

  statsList.forEach((s) => {
    lines.push(`\n${s.type === 'Bus' ? '🚌' : '🚕'} *${s.name.toUpperCase()}* (${s.repName !== '—' ? 'Rep: ' + s.repName : 'No Rep Assigned'})`);
    lines.push(`• *Status:* ${s.status} | *Count:* ${s.presentCount}/${s.totalRiders} Present`);
    lines.push(`• *Present Members & Visitors:* ${s.presentListStr}`);
    if (s.ftvCount > 0) {
      lines.push(`• *First Time Visitors:* ${s.ftvListStr}`);
    }
    if (s.sponsoredCount > 0) {
      lines.push(`• *Sponsorships:* ${s.sponsoredListStr}`);
    }
    if (s.absentCount > 0) {
      lines.push(`• *Cancellations (Absentees):* ${s.cancellationListStr}`);
    }
    if (s.generalNotes) {
      lines.push(`• *Notes:* ${s.generalNotes}`);
    }
  });

  return lines.join('\n');
}

/**
 * Downloads detailed passenger-level CSV
 */
export function downloadDetailedPassengersCSV(manifest: Manifest, customFileName?: string): void {
  const statsList = extractAllVehicleStats(manifest);
  const { date: sessionDate, service: sessionService } = parseManifestKey(manifest.date);

  const headers = [
    'Vehicle',
    'Type',
    'Full Name',
    'Structure',
    'Pickup Stop',
    'Phone Number',
    'Attendance Status',
    'First Time Visitor',
    'Sponsored',
    'Sponsor Note',
    'Cancellation Debt (R)',
  ];

  const rows: (string | number)[][] = [];

  statsList.forEach((s) => {
    s.rawRiders.forEach((p) => {
      const isPresent = s.status === 'Submitted' ? p.present : s.presentRiders.some((pr) => pr.id === p.id);
      const isAbsent = s.status === 'Submitted' ? !p.present : s.absentRiders.some((ar) => ar.id === p.id);
      const isFTV = isAutoFirstTimeVisitor(p);
      const isSponsored = s.status === 'Submitted' ? Boolean(p.sponsored) : s.sponsoredRiders.some((sr) => sr.id === p.id);

      rows.push([
        s.name,
        s.type,
        p.fullName,
        p.structure || '—',
        p.stop,
        p.phone || '—',
        isPresent ? 'Present' : isAbsent ? 'Absent' : 'Unmarked',
        isFTV ? 'Yes' : 'No',
        isSponsored ? 'Yes' : 'No',
        p.sponsorNote || '',
        isAbsent ? 40 : 0,
      ]);
    });
  });

  const escapeCSV = (val: string | number) => {
    const str = String(val ?? '');
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const csvContent = [
    headers.map(escapeCSV).join(','),
    ...rows.map((row) => row.map(escapeCSV).join(',')),
  ].join('\n');

  const fileName = customFileName || `detailed_passengers_${sessionDate}_${sessionService || 'session'}.csv`;
  downloadTextBlob(csvContent, fileName, 'text/csv;charset=utf-8;');
}

function downloadTextBlob(content: string, fileName: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

