import * as XLSX from 'xlsx';
import type { Passenger, ServiceType } from './types';
import { SERVICE_TYPES } from './types';

interface ParseOptions {
  selectedDate: string;
  selectedService: ServiceType;
}

const SERVING_KEYWORDS = ['serving', 'usher', 'choir', 'band', 'altar', 'media', 'intercession', 'creatives', 'info desk', 'cares', 'kids church'];

const TRANSPORT_QUESTION_PATTERNS = ['do you need transport', 'need transport', 'transport required'];

// Mapping from area-name values (what appears in the Area Stops2 column)
// to the column header that holds the specific stop for that area.
const AREA_TO_COLUMN: { areaValue: string[]; columnPattern: string }[] = [
  { areaValue: ['braam stops', 'braam'], columnPattern: 'braam stops' },
  { areaValue: ['auckland park'], columnPattern: 'auckland park' },
  { areaValue: ['cbd'], columnPattern: 'cbd' },
  { areaValue: ['parktown'], columnPattern: 'parktown' },
  { areaValue: ['midrand'], columnPattern: 'midrand' },
  { areaValue: ['soweto'], columnPattern: 'soweto' },
  { areaValue: ['jhb north & west', 'jhb north and west', 'jhb west & north', 'jhb west and north'], columnPattern: 'jhb' },
];

interface RawRow {
  [key: string]: string;
}

// Strip unicode replacement chars (U+FFFD) and other non-printable noise
// that Microsoft Forms exports contain.
function clean(s: unknown): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/\uFFFD/g, '')
    .replace(/\u00A0/g, ' ')
    .trim();
}

function lower(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function findColumn(headers: string[], patterns: string[]): string | null {
  // Clean + lowercased headers for matching (strips U+FFFD noise from Forms exports)
  const normalizedHeaders = headers.map((h) => lower(clean(h)));
  for (const pattern of patterns) {
    const p = lower(clean(pattern));
    // Exact match first
    const exactIdx = normalizedHeaders.findIndex((h) => h === p);
    if (exactIdx !== -1) return headers[exactIdx];
    // Then contains
    const containsIdx = normalizedHeaders.findIndex((h) => h.includes(p));
    if (containsIdx !== -1) return headers[containsIdx];
  }
  return null;
}

function extractFullName(row: RawRow, headers: string[]): string {
  const name2Col = findColumn(headers, ['name2', 'name 2']);
  const surnameCol = findColumn(headers, ['surname']);
  const name2 = name2Col ? clean(row[name2Col]) : '';
  const surname = surnameCol ? clean(row[surnameCol]) : '';

  // Primary path: Name2 (first name) + Surname
  if (name2 && surname) return `${name2} ${surname}`;
  if (name2) return name2;
  if (surname) return surname;

  // Fallback: First Name + Surname
  const firstNameCol = findColumn(headers, ['first name', 'firstname', 'name1', 'name 1']);
  const first = firstNameCol ? clean(row[firstNameCol]) : '';
  if (first && surname) return `${first} ${surname}`;
  if (first) return first;

  // Last resort: any column with "name" in it
  for (const h of headers) {
    const lh = lower(h);
    if (lh.includes('name') && !lh.includes('surname') && clean(row[h])) {
      return clean(row[h]);
    }
  }
  return '';
}

function extractStop(row: RawRow, headers: string[]): string {
  // Step 1: find the area column (Area Stops2) to know which area the person selected
  const areaCol = findColumn(headers, ['area stops2', 'area stops 2', 'area stops']);
  const areaValue = areaCol ? lower(clean(row[areaCol])) : '';

  // Step 2: based on the area, find the specific stop column and read the stop value
  if (areaValue) {
    for (const mapping of AREA_TO_COLUMN) {
      if (mapping.areaValue.some((av) => areaValue.includes(av))) {
        const stopCol = findColumn(headers, [mapping.columnPattern]);
        if (stopCol) {
          const stop = clean(row[stopCol]);
          if (stop) return stop;
        }
      }
    }
    // If we found an area value but no specific stop, use the area value itself
    if (areaValue) return clean(row[areaCol]);
  }

  // Step 3: fallback — scan all area columns for any non-empty value
  for (const mapping of AREA_TO_COLUMN) {
    const stopCol = findColumn(headers, [mapping.columnPattern]);
    if (stopCol) {
      const stop = clean(row[stopCol]);
      if (stop) return stop;
    }
  }

  return 'Unknown';
}

// The forms have three separate structure columns: SZ1 Structures, SZ2 Structures, YZ Structures.
// Only one is populated per row depending on which zone the person belongs to.
const STRUCTURE_COLUMN_PATTERNS = [
  'sz1 structures', 'sz1', 'sz2 structures', 'sz2', 'yz structures', 'yz',
  'structure', 'assembly', 'assembly structure', 'home structure', 'home assembly',
  'fellowship structure', 'pcf structure',
];

function extractStructure(row: RawRow, headers: string[]): string {
  // Try each known structure column in order — return the first non-empty value
  for (const pattern of STRUCTURE_COLUMN_PATTERNS) {
    const col = findColumn(headers, [pattern]);
    if (col) {
      const val = clean(row[col]);
      if (val) return val;
    }
  }
  // Fallback: scan all columns for one whose header contains "structure" or "assembly"
  for (const h of headers) {
    const lh = lower(clean(h));
    if ((lh.includes('structure') || lh.includes('assembly')) && !lh.includes('area')) {
      const val = clean(row[h]);
      if (val) return val;
    }
  }
  return '';
}

function wantsTransport(row: RawRow, headers: string[]): boolean {
  const col = findColumn(headers, TRANSPORT_QUESTION_PATTERNS);
  if (!col) return true;
  const val = lower(clean(row[col]));
  if (!val) return true;
  if (val === 'no' || val === 'n') return false;
  // "No, ..." variants
  if (val.startsWith('no')) return false;
  return true;
}

function matchesService(row: RawRow, headers: string[], selected: ServiceType): boolean {
  const def = SERVICE_TYPES.find((s) => s.value === selected);
  if (!def) return true;

  // AM files have "AM Service Type", PM files have "PM Service Type"
  const serviceTypeCol = findColumn(headers, ['am service type', 'pm service type', 'service type', 'servicetype']);
  const servingCol = findColumn(headers, ['serving ministry', 'serving', 'ministry']);

  const serviceVal = serviceTypeCol ? lower(clean(row[serviceTypeCol])) : '';
  const ministryVal = servingCol ? lower(clean(row[servingCol])) : '';
  const rawService = `${serviceVal} ${ministryVal}`;

  // "Serving" in the service type column, or any serving ministry keyword
  const isServingRow = SERVING_KEYWORDS.some((k) => rawService.includes(k));

  // Also check: if service type is explicitly "Normal", it's not serving
  if (def.mode === 'Serving') return isServingRow;
  // For Normal mode: include rows that are NOT serving
  return !isServingRow;
}

const MONTH_MAP: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function matchesDate(row: RawRow, headers: string[], selectedDate: string): boolean {
  const col = findColumn(headers, ['service date']);
  if (!col) return true; // no date column — don't filter by date
  const raw = clean(row[col]);
  if (!raw) return true; // empty date value — don't filter

  // Try to parse the date into YYYY-MM-DD. If we successfully parse it,
  // the row must match the selected date — otherwise it's from a different Sunday.
  let parsedDate: string | null = null;

  // Format: "7 Sep 2025" (D Mon YYYY)
  const monMatch = raw.match(/^(\d{1,2})\s+([a-z]{3,4})\s+(\d{4})$/i);
  if (monMatch) {
    const day = parseInt(monMatch[1], 10);
    const monName = lower(monMatch[2]).slice(0, 3);
    const year = parseInt(monMatch[3], 10);
    const month = MONTH_MAP[monName];
    if (month) {
      parsedDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // Try Date constructor (handles Date objects from cellDates:true and many string formats)
  if (!parsedDate) {
    const cell = new Date(raw);
    if (!isNaN(cell.getTime())) {
      const y = cell.getFullYear();
      const m = String(cell.getMonth() + 1).padStart(2, '0');
      const d = String(cell.getDate()).padStart(2, '0');
      parsedDate = `${y}-${m}-${d}`;
    }
  }

  // Try numeric formats: "7/9/2025", "7-9-2025", "2025-09-07"
  if (!parsedDate) {
    const normalized = raw.replace(/\//g, '-');
    const parts = normalized.split(/[-.]/).filter(Boolean);
    if (parts.length === 3) {
      const [a, b, c] = parts.map((p) => p.trim());
      let year: number, month: number, day: number;
      if (a.length === 4) {
        year = parseInt(a, 10); month = parseInt(b, 10); day = parseInt(c, 10);
      } else if (c.length === 4) {
        day = parseInt(a, 10); month = parseInt(b, 10); year = parseInt(c, 10);
      } else {
        day = parseInt(a, 10); month = parseInt(b, 10); year = parseInt(c, 10);
      }
      if (year && month && day) {
        parsedDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      }
    }
  }

  if (parsedDate) {
    // We parsed a real date — only include if it matches the selected Sunday
    return parsedDate === selectedDate;
  }

  // Truly unparseable date — don't exclude (benefit of the doubt)
  return true;
}

export interface ParseResult {
  passengers: Passenger[];
  skipped: number;
  totalRows: number;
  matchedDate: number;
  matchedService: number;
  matchedTransport: number;
  warnings: string[];
}

export function parseWorkbook(file: ArrayBuffer, opts: ParseOptions): ParseResult {
  const wb = XLSX.read(file, { type: 'array', cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) {
    return { passengers: [], skipped: 0, totalRows: 0, matchedDate: 0, matchedService: 0, matchedTransport: 0, warnings: ['No sheets found in workbook.'] };
  }
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<RawRow>(sheet, { defval: '' });
  const warnings: string[] = [];
  if (rows.length === 0) {
    return { passengers: [], skipped: 0, totalRows: 0, matchedDate: 0, matchedService: 0, matchedTransport: 0, warnings: ['Sheet has no data rows.'] };
  }
  const headers = Object.keys(rows[0]);

  let skipped = 0;
  let matchedDate = 0;
  let matchedService = 0;
  let matchedTransport = 0;
  const passengers: Passenger[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const name = extractFullName(row, headers);
    if (!name) {
      skipped++;
      continue;
    }

    if (!wantsTransport(row, headers)) {
      skipped++;
      continue;
    }
    matchedTransport++;

    if (!matchesDate(row, headers, opts.selectedDate)) {
      skipped++;
      continue;
    }
    matchedDate++;

    if (!matchesService(row, headers, opts.selectedService)) {
      skipped++;
      continue;
    }
    matchedService++;

    const stop = extractStop(row, headers);
    const id = `${name}-${stop}`.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (seen.has(id)) {
      skipped++;
      continue;
    }
    seen.add(id);

    const structure = extractStructure(row, headers);
    passengers.push({
      id,
      fullName: name,
      stop,
      structure,
      assignedTo: null,
      present: false,
      cancellationFeeOwed: false,
    });
  }

  return { passengers, skipped, totalRows: rows.length, matchedDate, matchedService, matchedTransport, warnings };
}
