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
  allRiderNames: string[],
  vehicleName: string,
  submittedBy: string,
  licensePlate: string,
  repName: string,
  generalNotes: string
): Promise<void> {
  // Delete any existing cancellation_ledger rows for this session
  // (manifest_key) belonging to any passenger currently on this vehicle's
  // roster — present or absent. Scoping the delete to passenger_name
  // rather than vehicle_name guarantees a passenger can never end up with
  // two open debt rows for the same service session, even if a rep
  // resubmits after the admin reassigns them to a different vehicle.
  if (allRiderNames.length > 0) {
    const { error: delError } = await supabase
      .from(LEDGER_TABLE)
      .delete()
      .eq('manifest_key', manifestKey)
      .in('passenger_name', allRiderNames);
    if (delError) throw delError;
  }

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

/**
 * Withdraws absentees for a given vehicle/session when a Rep reopens attendance
 * for editing. This ensures the cancellation ledger only reflects confirmed,
 * currently submitted attendance lists.
 */
export async function withdrawAbsentees(
  manifestKey: string,
  riderNames: string[]
): Promise<void> {
  if (riderNames.length === 0) return;
  const { error } = await supabase
    .from(LEDGER_TABLE)
    .delete()
    .eq('manifest_key', manifestKey)
    .in('passenger_name', riderNames);
  if (error) throw error;
}

export async function listLedgerEntries(): Promise<LedgerEntry[]> {
  try {
    const { data, error } = await supabase
      .from(LEDGER_TABLE)
      .select('*')
      .order('submitted_at', { ascending: false });
    if (error) {
      console.warn('[Ledger] Failed to fetch remote ledger, reading local store:', error);
    }
    if (data && Array.isArray(data)) {
      return data as LedgerEntry[];
    }
  } catch (err) {
    console.warn('[Ledger] Exception fetching ledger entries:', err);
  }
  return [];
}

export async function listLedgerByDate(date: string): Promise<LedgerEntry[]> {
  try {
    const { data, error } = await supabase
      .from(LEDGER_TABLE)
      .select('*')
      .eq('date', date)
      .order('submitted_at', { ascending: false });
    if (error) {
      console.warn('[Ledger] Failed to fetch remote ledger by date:', error);
    }
    if (data && Array.isArray(data)) {
      return data as LedgerEntry[];
    }
  } catch (err) {
    console.warn('[Ledger] Exception fetching ledger by date:', err);
  }
  return [];
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

/** A single row parsed from a "Cancellation History" import workbook, ready to insert into cancellation_ledger. */
export interface HistoricalCancellationRow {
  structure: string;
  date: string; // yyyy-mm-dd
  service: string;
  passenger_name: string;
  structure_debt: number;
}

export interface HistoricalImportResult {
  rows: HistoricalCancellationRow[];
  totalRows: number;
  imported: number;
  skipped: number;
  warnings: string[];
}

const HISTORICAL_HEADER_ALIASES: Record<'structure' | 'date' | 'service' | 'passenger_name' | 'structure_debt', string[]> = {
  structure: ['structure', 'struct', 'structure and rep', 'structure/rep'],
  date: ['date', 'cancellation date'],
  service: ['service', 'service type', 'service period', 'session'],
  passenger_name: ['passenger name', 'name', 'passenger', 'full name'],
  structure_debt: ['amount', 'amount owing', 'structure debt', 'debt', 'fee', 'amount owed'],
};

function normalizeHeaderCell(h: unknown): string {
  return String(h ?? '').trim().toLowerCase();
}

function findHistoricalColumn(headerRow: unknown[], aliases: string[]): number {
  const normalized = headerRow.map(normalizeHeaderCell);
  for (const alias of aliases) {
    const idx = normalized.indexOf(alias);
    if (idx !== -1) return idx;
  }
  return -1;
}

function formatYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Parses a date cell that may be an Excel serial number, a JS Date (when
 * the sheet was read with cellDates), "yyyy-mm-dd", or "dd/mm/yyyy" into
 * a normalized "yyyy-mm-dd" string. Returns null if unparseable.
 */
function parseFlexibleHistoricalDate(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (value instanceof Date && !isNaN(value.getTime())) return formatYMD(value);
  if (typeof value === 'number') {
    const parsed = XLSX.SSF?.parse_date_code?.(value);
    if (parsed) return formatYMD(new Date(parsed.y, parsed.m - 1, parsed.d));
    return null;
  }
  const s = String(value).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

/**
 * Parses a bulk "Cancellation History" Excel/CSV export (columns:
 * Structure, Date, Service, Passenger Name, Amount — header names are
 * matched case-insensitively against common aliases) into rows ready for
 * importHistoricalCancellations. Rows missing a structure, a parseable
 * date, or a passenger name are skipped and reported in `warnings`.
 * Amount defaults to CANCELLATION_FEE (R40) when blank or non-numeric.
 */
export function parseHistoricalCancellationWorkbook(buffer: ArrayBuffer): HistoricalImportResult {
  const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: '' }) as unknown[][];

  if (aoa.length === 0) {
    return { rows: [], totalRows: 0, imported: 0, skipped: 0, warnings: ['File appears to be empty.'] };
  }

  const headerRow = aoa[0];
  const structureCol = findHistoricalColumn(headerRow, HISTORICAL_HEADER_ALIASES.structure);
  const dateCol = findHistoricalColumn(headerRow, HISTORICAL_HEADER_ALIASES.date);
  const serviceCol = findHistoricalColumn(headerRow, HISTORICAL_HEADER_ALIASES.service);
  const nameCol = findHistoricalColumn(headerRow, HISTORICAL_HEADER_ALIASES.passenger_name);
  const debtCol = findHistoricalColumn(headerRow, HISTORICAL_HEADER_ALIASES.structure_debt);

  const dataRows = aoa.slice(1);

  if (structureCol === -1 || dateCol === -1 || nameCol === -1) {
    return {
      rows: [],
      totalRows: dataRows.length,
      imported: 0,
      skipped: dataRows.length,
      warnings: ['Could not find required columns (Structure, Date, Passenger Name). Check the header row and try again.'],
    };
  }

  const warnings: string[] = [];
  const rows: HistoricalCancellationRow[] = [];
  let skipped = 0;

  dataRows.forEach((raw, i) => {
    const rowNum = i + 2; // account for 1-indexing + header row
    const structure = String(raw[structureCol] ?? '').trim();
    const dateVal = parseFlexibleHistoricalDate(raw[dateCol]);
    const passengerName = String(raw[nameCol] ?? '').trim();
    const service = serviceCol !== -1 ? String(raw[serviceCol] ?? '').trim() : '';
    const debtRaw = debtCol !== -1 ? raw[debtCol] : undefined;
    const debtNum = Number(debtRaw);
    const structureDebt = Number.isFinite(debtNum) && debtNum > 0 ? debtNum : CANCELLATION_FEE;

    if (!structure && !dateVal && !passengerName) return; // fully blank row — silently skip

    if (!structure || !dateVal || !passengerName) {
      const missing = [
        !structure && 'structure',
        !dateVal && 'a valid date',
        !passengerName && 'passenger name',
      ].filter(Boolean).join(', ');
      warnings.push(`Row ${rowNum}: skipped — missing ${missing}.`);
      skipped++;
      return;
    }

    rows.push({
      structure,
      date: dateVal,
      service: service || 'Unspecified',
      passenger_name: passengerName,
      structure_debt: structureDebt,
    });
  });

  return { rows, totalRows: dataRows.length, imported: rows.length, skipped, warnings };
}

/**
 * Inserts pre-parsed historical cancellation rows directly into the
 * cancellation_ledger table. Unlike insertAbsentees (used for live
 * session submissions), this never deletes existing rows first —
 * historical backfills are purely additive. No rep is attached to these
 * entries since they predate the digital ledger.
 */
export async function importHistoricalCancellations(rows: HistoricalCancellationRow[]): Promise<void> {
  if (rows.length === 0) return;
  const payload = rows.map((r) => ({
    manifest_key: `historical_${r.date}_${r.service}`.replace(/\s+/g, '_'),
    date: r.date,
    service: r.service,
    passenger_name: r.passenger_name,
    stop: '',
    structure: r.structure,
    vehicle_name: 'Historical Import',
    submitted_by: 'Historical Import',
    rep_name: '',
    license_plate: '',
    sponsored: false,
    sponsor_note: '',
    structure_debt: r.structure_debt,
    general_notes: '',
  }));
  const { error } = await supabase.from(LEDGER_TABLE).insert(payload);
  if (error) throw error;
}

export interface AggregatedLedgerRow {
  key: string;
  structure: string;
  repName: string;
  vehicleName: string;
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
        vehicleName: latest.vehicle_name || '—',
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
    ['Structure', 'Cancellation date', 'Name', 'Amount owing'],
  ];

  for (const group of groups) {
    for (const row of group.rows) {
      aoa.push([
        row.structure,
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

  // Helper for FTV check
  const isFTV = (p: Passenger) => {
    const s = (p.structure || '').toUpperCase();
    const m = (p.ministry || '').toUpperCase();
    const cat = (p.category || '').toUpperCase();
    return s.includes('FTV') || s.includes('VISITOR') || s.includes('FIRST TIME') ||
      m.includes('FTV') || m.includes('VISITOR') || cat.includes('FTV') || cat.includes('VISITOR');
  };

  const formatRider = (p: Passenger) => {
    const name = p.fullName.trim();
    const struct = (p.structure || '').trim();
    return struct ? `${name} ${struct}` : name;
  };

  // Sheet 1: Vehicle Summary with Formatted Lists
  const vehicleRows = vehicles.map((v) => {
    const riders = v.riders.map(passengerLookup).filter((p): p is Passenger => Boolean(p));
    const isSubmitted = Boolean(v.submitted);
    const pSet = new Set(v.draftState?.presentIds || []);
    const aSet = new Set(v.draftState?.absentIds || []);
    const sSet = new Set(v.draftState?.sponsoredIds || []);

    const presentRiders = isSubmitted
      ? riders.filter((p) => p.present)
      : (pSet.size > 0 ? riders.filter((p) => pSet.has(p.id)) : []);

    const absentRiders = isSubmitted
      ? riders.filter((p) => !p.present)
      : (aSet.size > 0 ? riders.filter((p) => aSet.has(p.id)) : []);

    const sponsoredRiders = isSubmitted
      ? riders.filter((p) => p.sponsored)
      : (sSet.size > 0 ? riders.filter((p) => sSet.has(p.id) || p.sponsored) : riders.filter((p) => p.sponsored));

    const ftvRiders = presentRiders.filter(isFTV);

    return {
      'Vehicle': v.name,
      'Type': v.type,
      'Rep': v.repName || v.submittedBy || '—',
      'License Plate': v.licensePlate || '—',
      'Total Passengers': riders.length,
      'Present': presentRiders.length,
      'Absent': absentRiders.length,
      'FTVs': ftvRiders.length,
      'Sponsored': sponsoredRiders.length,
      'Fare Collected (R)': presentRiders.length * 40,
      'Present Members & Visitors': presentRiders.length > 0 ? presentRiders.map(formatRider).join(', ') : 'None',
      'First Time Visitors (FTVs)': ftvRiders.length > 0 ? ftvRiders.map(formatRider).join(', ') : 'None',
      'Sponsorships': sponsoredRiders.length > 0 ? sponsoredRiders.map(formatRider).join(', ') : 'None',
      'Cancellations (Absentees)': absentRiders.length > 0 ? absentRiders.map(formatRider).join(', ') : 'None',
      'Submitted': v.submitted ? 'Yes' : 'No',
      'General Notes': v.generalNotes || v.draftState?.generalNotes || '',
    };
  });
  const wsVehicles = XLSX.utils.json_to_sheet(vehicleRows);
  wsVehicles['!cols'] = [
    { wch: 16 }, { wch: 6 }, { wch: 20 }, { wch: 14 }, { wch: 14 },
    { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 10 }, { wch: 14 },
    { wch: 50 }, { wch: 35 }, { wch: 30 }, { wch: 40 }, { wch: 9 }, { wch: 30 },
  ];
  XLSX.utils.book_append_sheet(wb, wsVehicles, 'Vehicle Stats Summary');

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
        'Phone': p.phone || '—',
        'Present': p.present ? 'Yes' : 'No',
        'FTV': isFTV(p) ? 'Yes' : 'No',
        'Sponsored': p.sponsored ? 'Yes' : 'No',
        'Sponsor Note': p.sponsorNote || '',
      });
    });
  });
  if (passengerRows.length > 0) {
    const wsPassengers = XLSX.utils.json_to_sheet(passengerRows);
    wsPassengers['!cols'] = [
      { wch: 16 }, { wch: 28 }, { wch: 10 }, { wch: 22 }, { wch: 16 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 35 },
    ];
    XLSX.utils.book_append_sheet(wb, wsPassengers, 'Detailed Passengers');
  }

  XLSX.writeFile(wb, fileName);
}
