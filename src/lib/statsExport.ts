import * as XLSX from 'xlsx';
import type { Manifest, Vehicle, Passenger } from './types';
import { sortVehiclesNatural } from './sort';
import { shortDate, parseManifestKey } from './dates';

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
}

/**
 * Checks if a passenger's structure or notes suggest they are a First Time Visitor
 */
export function isAutoFirstTimeVisitor(passenger: Passenger, riderNote?: string): boolean {
  const s = (passenger.structure || '').toUpperCase();
  const m = (passenger.ministry || '').toUpperCase();
  const cat = (passenger.category || '').toUpperCase();
  const n = (riderNote || '').toUpperCase();

  if (s.includes('FTV') || s.includes('VISITOR') || s.includes('FIRST TIME') || s.includes('GUEST') || s.includes('NEW')) {
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
  const rawRiders = vehicle.riders
    .map(passengerLookup)
    .filter((p): p is Passenger => Boolean(p));

  const isSubmitted = Boolean(vehicle.submitted);
  const hasDraft = Boolean(vehicle.draftState && (vehicle.draftState.presentIds?.length || vehicle.draftState.absentIds?.length));

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

  const notesMap = vehicle.draftState?.notes || {};

  if (isSubmitted) {
    // When submitted, presence and sponsored flags are persisted directly on signups
    presentRiders = rawRiders.filter((p) => p.present);
    absentRiders = rawRiders.filter((p) => !p.present);
    sponsoredRiders = rawRiders.filter((p) => p.sponsored);
    ftvRiders = presentRiders.filter((p) => isAutoFirstTimeVisitor(p, notesMap[p.id]));
  } else if (hasDraft && vehicle.draftState) {
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

  // R40 per present passenger
  const fareCollected = presentRiders.length * 40;

  return {
    vehicleId: vehicle.id,
    name: vehicle.name,
    type: vehicle.type,
    repName: vehicle.repName || vehicle.submittedBy || '—',
    licensePlate: vehicle.licensePlate || '—',
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
    generalNotes: vehicle.generalNotes || vehicle.draftState?.generalNotes || '',
    rawRiders,
  };
}

/**
 * Extracts stats for all vehicles in a manifest sorted in natural order
 */
export function extractAllVehicleStats(manifest: Manifest): ExtractedVehicleStats[] {
  const passengerLookup = (id: string) => manifest.signups.find((p) => p.id === id);
  const sorted = sortVehiclesNatural(manifest.vehicles);
  return sorted.map((v) => extractVehicleStats(v, passengerLookup));
}

/**
 * Generates an Excel (.xlsx) workbook containing:
 * 1. Sheet "Taxi Stats Summary" (Each taxi with counts + full lists formatted as "Person A S3, Person B S2")
 * 2. Sheet "Detailed Passenger Roster" (Individual passenger rows with taxi, status, stop, structure, debt)
 * 3. Sheet "Stats Link Copy Roster" (Pre-formatted text blocks ready for copy/pasting)
 */
export function downloadTaxiStatsExcel(manifest: Manifest, customFileName?: string): void {
  const statsList = extractAllVehicleStats(manifest);
  const { date: sessionDate, service: sessionService } = parseManifestKey(manifest.date);
  const wb = XLSX.utils.book_new();

  // 1. Sheet 1: Taxi Stats Summary
  const summaryRows = statsList.map((s) => ({
    'Vehicle': s.name,
    'Type': s.type,
    'Rep Name': s.repName,
    'License Plate': s.licensePlate,
    'Status': s.status,
    'Total Allocated': s.totalRiders,
    'Present Count': s.presentCount,
    'Absent Count': s.absentCount,
    'FTV Count': s.ftvCount,
    'Sponsored Count': s.sponsoredCount,
    'Fare Total (R)': s.fareCollected,
    'List of Present Members & Visitors': s.presentListStr,
    'List of First Time Visitors (FTVs)': s.ftvListStr,
    'List of Sponsorships': s.sponsoredListStr,
    'List of Cancellations (Absentees)': s.cancellationListStr,
    'General Notes': s.generalNotes,
  }));

  // Append Grand Total row
  const totalAllocated = statsList.reduce((sum, s) => sum + s.totalRiders, 0);
  const totalPresent = statsList.reduce((sum, s) => sum + s.presentCount, 0);
  const totalAbsent = statsList.reduce((sum, s) => sum + s.absentCount, 0);
  const totalFTVs = statsList.reduce((sum, s) => sum + s.ftvCount, 0);
  const totalSponsored = statsList.reduce((sum, s) => sum + s.sponsoredCount, 0);
  const totalFares = statsList.reduce((sum, s) => sum + s.fareCollected, 0);

  summaryRows.push({
    'Vehicle': 'GRAND TOTAL',
    'Type': '—',
    'Rep Name': '—',
    'License Plate': '—',
    'Status': '—',
    'Total Allocated': totalAllocated,
    'Present Count': totalPresent,
    'Absent Count': totalAbsent,
    'FTV Count': totalFTVs,
    'Sponsored Count': totalSponsored,
    'Fare Total (R)': totalFares,
    'List of Present Members & Visitors': '—',
    'List of First Time Visitors (FTVs)': '—',
    'List of Sponsorships': '—',
    'List of Cancellations (Absentees)': '—',
    'General Notes': '',
  });

  const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
  wsSummary['!cols'] = [
    { wch: 14 }, // Vehicle
    { wch: 8 },  // Type
    { wch: 20 }, // Rep Name
    { wch: 14 }, // License Plate
    { wch: 18 }, // Status
    { wch: 15 }, // Total Allocated
    { wch: 13 }, // Present Count
    { wch: 13 }, // Absent Count
    { wch: 11 }, // FTV Count
    { wch: 16 }, // Sponsored Count
    { wch: 13 }, // Fare Total
    { wch: 55 }, // Present List
    { wch: 40 }, // FTV List
    { wch: 35 }, // Sponsorships
    { wch: 45 }, // Cancellations
    { wch: 30 }, // Notes
  ];
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Taxi Stats Summary');

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
      { wch: 14 }, // Vehicle
      { wch: 10 }, // Type
      { wch: 28 }, // Full Name
      { wch: 12 }, // Structure
      { wch: 24 }, // Stop
      { wch: 16 }, // Phone
      { wch: 12 }, // Status
      { wch: 8 },  // FTV
      { wch: 10 }, // Sponsored
      { wch: 25 }, // Sponsor Note
      { wch: 20 }, // Cancellation Debt
    ];
    XLSX.utils.book_append_sheet(wb, wsPassengers, 'Detailed Roster');
  }

  // 3. Sheet 3: Google Sheets & WhatsApp Formatted Stats Blocks
  const textBlocks: (string | number)[][] = [
    ['CRC Johannesburg — Vehicle Stats Link Summary'],
    [`Session Date: ${shortDate(sessionDate)} · ${sessionService}`],
    [],
    ['Vehicle', 'Rep', 'Present List', 'FTV List', 'Sponsorship List', 'Cancellation List'],
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

  const fileName = customFileName || `taxi_stats_${sessionDate}_${sessionService || 'session'}.xlsx`;
  XLSX.writeFile(wb, fileName);
}

/**
 * Downloads a CSV formatted specifically for Google Sheets or Excel
 */
export function downloadTaxiStatsCSV(manifest: Manifest, customFileName?: string): void {
  const statsList = extractAllVehicleStats(manifest);
  const { date: sessionDate, service: sessionService } = parseManifestKey(manifest.date);

  const headers = [
    'Vehicle',
    'Type',
    'Rep Name',
    'License Plate',
    'Status',
    'Total Allocated',
    'Present Count',
    'Absent Count',
    'FTV Count',
    'Sponsored Count',
    'Fare Total (R)',
    'List of Present Members & Visitors',
    'List of First Time Visitors (FTVs)',
    'List of Sponsorships',
    'List of Cancellations (Absentees)',
    'General Notes',
  ];

  const rows = statsList.map((s) => [
    s.name,
    s.type,
    s.repName,
    s.licensePlate,
    s.status,
    s.totalRiders,
    s.presentCount,
    s.absentCount,
    s.ftvCount,
    s.sponsoredCount,
    s.fareCollected,
    s.presentListStr,
    s.ftvListStr,
    s.sponsoredListStr,
    s.cancellationListStr,
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

  const fileName = customFileName || `taxi_stats_${sessionDate}_${sessionService || 'session'}.csv`;
  downloadTextBlob(csvContent, fileName, 'text/csv;charset=utf-8;');
}

/**
 * Generates TSV (Tab-Separated Values) that can be pasted directly into Google Sheets cells
 */
export function generateTaxiStatsTSV(manifest: Manifest): string {
  const statsList = extractAllVehicleStats(manifest);

  const headers = [
    'Vehicle',
    'Type',
    'Rep Name',
    'Status',
    'Total',
    'Present',
    'Absent',
    'FTVs',
    'Sponsored',
    'Fare (R)',
    'Present Members & Visitors',
    'First Time Visitors',
    'Sponsorships',
    'Cancellations (Absentees)',
    'Notes',
  ];

  const rows = statsList.map((s) => [
    s.name,
    s.type,
    s.repName,
    s.status,
    s.totalRiders,
    s.presentCount,
    s.absentCount,
    s.ftvCount,
    s.sponsoredCount,
    s.fareCollected,
    s.presentListStr,
    s.ftvListStr,
    s.sponsoredListStr,
    s.cancellationListStr,
    s.generalNotes,
  ]);

  return [
    headers.join('\t'),
    ...rows.map((row) => row.join('\t')),
  ].join('\n');
}

/**
 * Generates a consolidated WhatsApp message summarizing all taxi stats
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
