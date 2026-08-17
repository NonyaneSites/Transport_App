import * as XLSX from 'xlsx';
import { supabase } from './supabase';
import type { Passenger, Vehicle } from './types';
import { CANCELLATION_FEE } from './types';
import { naturalCompare } from './sort';
import { shortDate } from './dates';

export const BANK_DETAILS = {
  accountName: 'CRCY&SJHB',
  bank: 'ABSA',
  accountNumber: '4100565706',
  branchCode: '632005',
};

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

/**
 * Settles (removes) a batch of past-cancellation ledger entries in one
 * call — used when a Rep collects R40 cash on behalf of someone with an
 * outstanding cancellation fee during a trip, so that entry no longer
 * appears as owing. No-op if `ids` is empty.
 */
export async function settleLedgerEntries(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await supabase.from(LEDGER_TABLE).delete().in('id', ids);
  if (error) throw error;
}

export async function updateLedgerEntry(id: string, updates: Partial<LedgerEntry>): Promise<void> {
  const { error } = await supabase.from(LEDGER_TABLE).update(updates).eq('id', id);
  if (error) throw error;
}

export interface AggregatedLedgerRow {
  key: string;
  structure: string;
  repName: string;
  name: string;
  service: string;
  latestDate: string; // yyyy-mm-dd, most recent
  amount: number;
  entryIds: string[];
}

export interface AggregatedLedgerGroup {
  structure: string;
  /** Distinct rep names who submitted debts for this structure, in first-seen order. */
  reps: string[];
  rows: AggregatedLedgerRow[];
  totalDebt: number;
}

/**
 * Shared aggregation used by both the web Ledger page and the download:
 * groups raw ledger entries by structure (strict alphanumeric order —
 * S1, S2, S9, S13), then by passenger name within each structure so repeat
 * cancellations collapse into one row with cumulative debt (e.g. R80).
 */
export function aggregateLedgerEntries(entries: LedgerEntry[]): AggregatedLedgerGroup[] {
  const byStructure = new Map<string, LedgerEntry[]>();
  for (const e of entries) {
    const key = e.structure || 'No Structure';
    if (!byStructure.has(key)) byStructure.set(key, []);
    byStructure.get(key)!.push(e);
  }

  const groups: AggregatedLedgerGroup[] = [];
  for (const [structure, structEntries] of byStructure.entries()) {
    const byName = new Map<string, LedgerEntry[]>();
    for (const e of structEntries) {
      const nameKey = e.passenger_name.trim().toLowerCase();
      if (!byName.has(nameKey)) byName.set(nameKey, []);
      byName.get(nameKey)!.push(e);
    }

    const rows: AggregatedLedgerRow[] = Array.from(byName.values()).map((group) => {
      const sorted = [...group].sort((a, b) => (b.submitted_at || '').localeCompare(a.submitted_at || ''));
      const latest = sorted[0];
      const amount = group.reduce((sum, e) => sum + Number(e.structure_debt), 0);
      return {
        key: `${structure}-${latest.passenger_name}`,
        structure,
        repName: latest.rep_name || latest.submitted_by || '—',
        name: latest.passenger_name,
        service: latest.service,
        latestDate: latest.date,
        amount,
        entryIds: group.map((e) => e.id),
      };
    }).sort((a, b) => a.name.localeCompare(b.name));

    const reps: string[] = [];
    for (const row of rows) {
      if (row.repName && row.repName !== '—' && !reps.includes(row.repName)) reps.push(row.repName);
    }

    groups.push({
      structure,
      reps,
      rows,
      totalDebt: rows.reduce((sum, r) => sum + r.amount, 0),
    });
  }

  return groups.sort((a, b) => naturalCompare(a.structure, b.structure));
}

/**
 * Downloads the Cancellation Ledger as an Excel workbook laid out to match
 * the official "2026 SZ Cancellation List": a cover section with the
 * policy rules and ABSA banking details, followed by the strict 4-column
 * table (Structure and rep / Cancellation date / Name / Amount owing).
 */
export function downloadLedgerExcel(entries: LedgerEntry[], fileName: string): void {
  const groups = aggregateLedgerEntries(entries);
  const grandTotal = groups.reduce((sum, g) => sum + g.totalDebt, 0);

  const aoa: (string | number)[][] = [
    ['CRC Johannesburg — 2026 SZ Cancellation List'],
    [],
    ['Policy'],
    ['Outstanding cancellation fees must be settled within 3 weeks of the missed service.'],
    ['Upload proof of payment (POP): https://forms.gle/HDvmuZywzNitWFpU6'],
    ['Each structure is collectively liable for the unpaid cancellation fees of its members.'],
    ['Cash may be handed directly to a transport rep on your next trip; EFT payments must reference your name and structure, with POP uploaded via the link above.'],
    [],
    ['Banking Details'],
    ['Account Name', BANK_DETAILS.accountName],
    ['Bank', BANK_DETAILS.bank],
    ['Account Number', BANK_DETAILS.accountNumber],
    ['Branch Code', BANK_DETAILS.branchCode],
    [],
    [`Total Outstanding: R${grandTotal}`],
    [],
    ['Structure and rep', 'Cancellation date', 'Name', 'Amount owing'],
  ];

  for (const group of groups) {
    for (const row of group.rows) {
      aoa.push([
        `${row.structure} - ${row.repName}`,
        shortDate(row.latestDate),
        `${row.name} (${row.service.split(' ')[0]})`,
        `R${row.amount}`,
      ]);
    }
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 30 }, { wch: 18 }, { wch: 30 }, { wch: 14 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'SZ Cancellation List');
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
