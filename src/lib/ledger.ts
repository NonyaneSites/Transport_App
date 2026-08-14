import * as XLSX from 'xlsx';
import { supabase } from './supabase';
import type { Passenger, Vehicle } from './types';
import { CANCELLATION_FEE } from './types';

export const LEDGER_TABLE = 'cancellation_ledger';

export interface LedgerEntry {
  id: string;
  manifest_key: string;
  date: string;
  service: string;
  passenger_name: string;
  stop: string;
  structure: string;
  vehicle_name: string;
  submitted_by: string;
  submitted_at: string;
  sponsored: boolean;
  sponsor_note: string;
  license_plate: string;
  rep_name: string;
  structure_debt: number;
  general_notes: string;
}

interface AbsenteeInput extends Passenger {
  sponsored?: boolean;
  sponsorNote?: string;
}

export async function insertAbsentees(
  manifestKey: string,
  date: string,
  serviceLabel: string,
  absentees: AbsenteeInput[],
  vehicleName: string,
  submittedBy: string,
  licensePlate: string,
  repName: string,
  generalNotes: string
): Promise<void> {
  const { error: delError } = await supabase
    .from(LEDGER_TABLE)
    .delete()
    .eq('manifest_key', manifestKey)
    .eq('vehicle_name', vehicleName);
  if (delError) throw delError;

  if (absentees.length === 0) return;

  const rows = absentees.map((p) => ({
    manifest_key: manifestKey,
    date,
    service: serviceLabel,
    passenger_name: p.fullName,
    stop: p.stop,
    structure: p.structure || '',
    vehicle_name: vehicleName,
    submitted_by: submittedBy,
    rep_name: repName,
    license_plate: licensePlate,
    sponsored: p.sponsored ?? false,
    sponsor_note: p.sponsorNote ?? '',
    structure_debt: CANCELLATION_FEE,
    general_notes: generalNotes,
  }));

  const { error } = await supabase.from(LEDGER_TABLE).insert(rows);
  if (error) throw error;
}

export async function listLedgerEntries(): Promise<LedgerEntry[]> {
  const { data, error } = await supabase
    .from(LEDGER_TABLE)
    .select('*')
    .order('submitted_at', { ascending: false });
  if (error) throw error;
  return (data as LedgerEntry[]) ?? [];
}

export async function listLedgerByDate(date: string): Promise<LedgerEntry[]> {
  const { data, error } = await supabase
    .from(LEDGER_TABLE)
    .select('*')
    .eq('date', date)
    .order('submitted_at', { ascending: false });
  if (error) throw error;
  return (data as LedgerEntry[]) ?? [];
}

export async function deleteLedgerEntry(id: string): Promise<void> {
  const { error } = await supabase.from(LEDGER_TABLE).delete().eq('id', id);
  if (error) throw error;
}

export async function updateLedgerEntry(id: string, updates: Partial<LedgerEntry>): Promise<void> {
  const { error } = await supabase.from(LEDGER_TABLE).update(updates).eq('id', id);
  if (error) throw error;
}

export function downloadLedgerExcel(entries: LedgerEntry[], fileName: string): void {
  const rows = entries.map((e, i) => ({
    '#': i + 1,
    'Passenger Name': e.passenger_name,
    'Structure': e.structure || '—',
    'Stop': e.stop,
    'Service': e.service,
    'Date': e.date,
    'Sponsored': e.sponsored ? 'Yes' : 'No',
    'Sponsor Note': e.sponsor_note || '',
    'Rep Name': e.rep_name || e.submitted_by || '',
    'License Plate': e.license_plate || '',
    'General Notes': e.general_notes || '',
    'Structure Debt (R)': e.structure_debt,
    'Submitted At': new Date(e.submitted_at).toLocaleString('en-ZA'),
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [
    { wch: 4 }, { wch: 28 }, { wch: 10 }, { wch: 20 }, { wch: 25 },
    { wch: 12 }, { wch: 9 }, { wch: 35 }, { wch: 18 }, { wch: 14 },
    { wch: 35 }, { wch: 16 }, { wch: 22 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Cancellation Ledger');
  XLSX.writeFile(wb, fileName);
}

/** Download session stats: vehicle summary + attendance + absentees + notes */
export function downloadSessionStatsExcel(
  vehicles: Vehicle[],
  passengerLookup: (id: string) => Passenger | undefined,
  fileName: string
): void {
  const wb = XLSX.utils.book_new();

  // Sheet 1: Vehicle Summary
  const vehicleRows = vehicles.map((v) => {
    const riders = v.riders.map(passengerLookup).filter((p): p is Passenger => Boolean(p));
    const present = riders.filter((p) => p.present).length;
    const absent = riders.length - present;
    return {
      'Vehicle': v.name,
      'Type': v.type,
      'Rep': v.repName || v.submittedBy || '—',
      'License Plate': v.licensePlate || '—',
      'Total Passengers': riders.length,
      'Present': present,
      'Absent': absent,
      'Submitted': v.submitted ? 'Yes' : 'No',
      'General Notes': v.generalNotes || '',
    };
  });
  const wsVehicles = XLSX.utils.json_to_sheet(vehicleRows);
  wsVehicles['!cols'] = [
    { wch: 16 }, { wch: 6 }, { wch: 20 }, { wch: 14 }, { wch: 14 },
    { wch: 8 }, { wch: 8 }, { wch: 9 }, { wch: 40 },
  ];
  XLSX.utils.book_append_sheet(wb, wsVehicles, 'Vehicle Summary');

  // Sheet 2: Full Passenger List
  const passengerRows: Record<string, string | number>[] = [];
  vehicles.forEach((v) => {
    v.riders.forEach((id) => {
      const p = passengerLookup(id);
      if (!p) return;
      passengerRows.push({
        'Vehicle': v.name,
        'Name': p.fullName,
        'Structure': p.structure || '—',
        'Stop': p.stop,
        'Present': p.present ? 'Yes' : 'No',
        'Sponsored': p.sponsored ? 'Yes' : 'No',
        'Sponsor Note': p.sponsorNote || '',
      });
    });
  });
  if (passengerRows.length > 0) {
    const wsPassengers = XLSX.utils.json_to_sheet(passengerRows);
    wsPassengers['!cols'] = [
      { wch: 16 }, { wch: 28 }, { wch: 10 }, { wch: 22 }, { wch: 8 }, { wch: 8 }, { wch: 35 },
    ];
    XLSX.utils.book_append_sheet(wb, wsPassengers, 'Passengers');
  }

  XLSX.writeFile(wb, fileName);
}
