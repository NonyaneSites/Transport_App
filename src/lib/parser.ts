import * as XLSX from 'xlsx';
import type { Passenger, ServiceType } from './types';
import { MIN_TAXI_THRESHOLD, hubDisplayName } from './types';
import { sanitizeTransportValue } from './transportSanitization';
import {
  toTitleCase,
  sanitizePhone,
  parseTimestampToISO,
  normalizeService,
  parseGoogleSheetSignups,
  isSamePassenger,
  normalizePassengerText,
  getSubmissionTimestampEpoch,
  type RawSheetRow,
} from './importer';

export {
  parseGoogleSheetSignups,
  type RawSheetRow,
  toTitleCase,
  sanitizePhone,
  parseTimestampToISO,
  normalizeService,
  isSamePassenger,
  normalizePassengerText,
  getSubmissionTimestampEpoch,
};

export interface ParseOptions {
  selectedDate: string;
  selectedService: ServiceType;
}

export interface ParseProgress {
  sheetName: string;
  sheetIndex: number;
  totalSheets: number;
  phase: 'reading' | 'scanning_sheet' | 'processing' | 'done';
}

export type ParseProgressCallback = (progress: ParseProgress) => void;

const SERVING_KEYWORDS = [
  'serving',
  'usher',
  'choir',
  'band',
  'altar',
  'media',
  'intercession',
  'creatives',
  'info desk',
  'cares',
  'kids church',
  'volunteer',
  'deaconess',
  'music',
];

const TRANSPORT_QUESTION_PATTERNS = ['do you need transport', 'need transport', 'transport required', 'require transport'];

export function extractMemberType(row: RawRow, headers: string[], structure?: string): 'M' | 'V' | 'FTV' | undefined {
  // 1. Structure hint check
  const structUpper = (structure || '').toUpperCase();
  if (structUpper.includes('FTV') || structUpper.includes('FIRST TIME')) return 'FTV';
  if (structUpper.includes('VISITOR')) return 'V';

  // 2. Scan columns for member / visitor question
  const col = findColumn(headers, [
    'are you a member or visitor',
    'are you a member or a visitor',
    'member or visitor',
    'member / visitor',
    'member/visitor',
    'membership status',
    'are you a member',
    'member, visitor or first time visitor',
    'visitor or member',
    'visitor / member',
    'visitor status',
    'member status',
    'membership',
    'category of attendee',
    'attendee type',
    'visitor',
    'first time visitor',
  ]);

  if (col && row[col]) {
    const val = lower(clean(row[col]));
    if (val.includes('first') || val.includes('ftv') || val.includes('1st') || val.includes('new')) {
      return 'FTV';
    }
    if (val.includes('visitor') || val.includes('visiting') || val.includes('guest') || val === 'v') {
      return 'V';
    }
    if (val.includes('member') || val === 'm') {
      return 'M';
    }
  }

  // 3. Fallback: scan any header with "member" or "visitor"
  for (const h of headers) {
    const lh = lower(clean(h));
    if ((lh.includes('member') || lh.includes('visitor')) && !lh.includes('phone') && !lh.includes('email') && clean(row[h])) {
      const val = lower(clean(row[h]));
      if (val.includes('first') || val.includes('ftv') || val.includes('1st')) return 'FTV';
      if (val.includes('visitor') || val.includes('guest') || val === 'v') return 'V';
      if (val.includes('member') || val === 'm') return 'M';
    }
  }

  return undefined;
}

export function extractCategoryAndMinistry(
  row: RawRow,
  headers: string[],
  sheetName?: string
): { category: 'Ushers' | 'Serving' | 'Normal'; ministry: string } {
  const serviceTypeCol = findColumn(headers, [
    'am service type',
    'pm service type',
    'service type',
    'servicetype',
    'which service are you attending',
  ]);
  const servingCol = findColumn(headers, ['serving ministry', 'serving', 'ministry']);

  const rawService = serviceTypeCol ? clean(row[serviceTypeCol]) : '';
  const rawMinistry = servingCol ? clean(row[servingCol]) : '';
  const serviceLower = lower(rawService);
  const ministryLower = lower(rawMinistry);
  const sheetLower = lower(clean(sheetName || ''));

  // 1. Explicit Ushers (Early)
  if (
    serviceLower.includes('usher (early)') ||
    serviceLower.includes('ushers (early)') ||
    serviceLower.includes('usher(early)') ||
    serviceLower.includes('ushers(early)') ||
    (serviceLower.includes('usher') && serviceLower.includes('early')) ||
    (serviceLower.includes('early') && ministryLower.includes('usher')) ||
    sheetLower.includes('usher')
  ) {
    return { category: 'Ushers', ministry: rawMinistry || 'Usher (Early)' };
  }

  // 2. Explicit Normal / Non-serving
  if (
    serviceLower === 'normal' ||
    serviceLower.startsWith('normal') ||
    (sheetLower.includes('normal') && !sheetLower.includes('serving'))
  ) {
    return { category: 'Normal', ministry: '' };
  }

  // 3. Serving
  if (
    serviceLower.includes('serving') ||
    SERVING_KEYWORDS.some((k) => ministryLower.includes(k) || serviceLower.includes(k)) ||
    Boolean(rawMinistry) ||
    sheetLower.includes('serving')
  ) {
    return { category: 'Serving', ministry: rawMinistry || 'Serving' };
  }

  return { category: 'Normal', ministry: '' };
}

// Mapping from area-name values (what appears in the Area Stops column)
// to the column header pattern that holds the specific sub-stop for that area.
const AREA_TO_COLUMN: { areaValue: string[]; columnPattern: string[] }[] = [
  {
    areaValue: ['braam stops', 'braam', 'braamfontein'],
    columnPattern: ['braam stops', 'braam stop', 'braamfontein stops', 'braamfontein stop', 'braamfontein', 'braam'],
  },
  {
    areaValue: ['auckland park stops', 'auckland park', 'auckland', 'apk'],
    columnPattern: ['auckland park stops', 'auckland park stop', 'auckland park', 'auckland', 'apk'],
  },
  {
    areaValue: ['cbd stops', 'cbd', 'central business district'],
    columnPattern: ['cbd stops', 'cbd stop', 'cbd'],
  },
  {
    areaValue: ['parktown stops', 'parktown', 'park town'],
    columnPattern: ['parktown stops', 'parktown stop', 'parktown', 'park town stops', 'park town'],
  },
  {
    areaValue: ['midrand stops', 'midrand'],
    columnPattern: ['midrand stops', 'midrand stop', 'midrand'],
  },
  {
    areaValue: ['soweto stops', 'soweto'],
    columnPattern: ['soweto stops', 'soweto stop', 'soweto'],
  },
  {
    areaValue: ['jhb north & west', 'jhb north and west', 'jhb west & north', 'jhb west and north', 'jhb north', 'jhb west', 'jhb', 'randburg'],
    columnPattern: ['jhb north & west', 'jhb west & north', 'jhb north and west', 'jhb west and north', 'jhb north', 'jhb west', 'jhb', 'randburg'],
  },
];

// Comprehensive known stop signatures for direct cell content matching
const KNOWN_STOP_SIGNATURES: { pattern: RegExp; canonical: string }[] = [
  // Standalone Empire
  { pattern: /campus central.*(empire|on empire)/i, canonical: 'Campus Central (Empire)' },
  { pattern: /campus central.*empire/i, canonical: 'Campus Central (Empire)' },
  { pattern: /\bempire\b/i, canonical: 'Campus Central (Empire)' },

  // EOH / Charlotte
  { pattern: /campus central.*eoh/i, canonical: 'Campus Central - EOH' },
  { pattern: /eoh.*campus central/i, canonical: 'Campus Central - EOH' },
  { pattern: /\beoh\b/i, canonical: 'Campus Central - EOH' },
  { pattern: /charlotte maxeke|charlotte/i, canonical: 'Charlotte Maxeke' },

  // Braam
  { pattern: /56 jorissen/i, canonical: '56 Jorissen' },
  { pattern: /\bamani\b/i, canonical: 'Amani' },
  { pattern: /amic deck.*(david webster|barnato)/i, canonical: 'Amic Deck - David Webster, Barnato' },
  { pattern: /amic deck.*jubilee/i, canonical: 'Amic Deck - Jubilee' },
  { pattern: /amic deck.*sunnyside/i, canonical: 'Amic Deck - Sunnyside' },
  { pattern: /amic deck/i, canonical: 'Amic Deck' },
  { pattern: /\bapex\b/i, canonical: 'Apex' },
  { pattern: /\bymca\b/i, canonical: 'YMCA' },
  { pattern: /david webster/i, canonical: 'David Webster' },
  { pattern: /barnato/i, canonical: 'Barnato' },
  { pattern: /sunnyside/i, canonical: 'Sunnyside' },
  { pattern: /jubilee/i, canonical: 'Jubilee' },
  { pattern: /men'?s res/i, canonical: "Men's Res" },
  { pattern: /student digz/i, canonical: 'Student Digzz' },

  // Auckland Park
  { pattern: /apk mcdonald/i, canonical: "APK McDonald's" },
  { pattern: /\bgate 7\b/i, canonical: 'Gate 7' },
  { pattern: /\bgate 2\b/i, canonical: 'Gate 2' },
  { pattern: /\bgate 4\b/i, canonical: 'Gate 4' },
  { pattern: /laborie/i, canonical: 'Laborie' },
  { pattern: /richmond/i, canonical: 'Richmond' },
  { pattern: /uj bunting|bunting/i, canonical: 'UJ Bunting' },
  { pattern: /westdene engen/i, canonical: 'Westdene Engen' },
  { pattern: /westdene/i, canonical: 'Westdene' },

  // CBD
  { pattern: /dfc bus stop|\bdfc\b/i, canonical: 'DFC bus stop' },
  { pattern: /focus 1|focus 2|\bfocus\b/i, canonical: 'Focus 1' },
  { pattern: /ghandi|gandhi/i, canonical: 'Ghandi square' },
  { pattern: /saratoga/i, canonical: 'Saratoga' },
  { pattern: /the fields|\bfields\b/i, canonical: 'The Fields' },
  { pattern: /urban circle/i, canonical: 'Urban Circle' },
  { pattern: /maboneng/i, canonical: 'Maboneng' },
  { pattern: /gateway/i, canonical: 'Gateway' },

  // Parktown
  { pattern: /\bargyle\b/i, canonical: 'Argyle' },
  { pattern: /\barteria\b/i, canonical: 'Arteria' },
  { pattern: /education campus/i, canonical: 'Education Campus' },
  { pattern: /\bjunction\b/i, canonical: 'Junction' },
  { pattern: /\bknockando\b/i, canonical: 'Knockando' },
  { pattern: /stanley ave|\bstanley\b/i, canonical: 'Stanley Ave' },
  { pattern: /\byale\b/i, canonical: 'Yale' },

  // JHB West & North / Midrand / Soweto
  { pattern: /randburg|surrey square/i, canonical: 'Randburg Surrey Square' },
  { pattern: /midrand/i, canonical: 'Midrand' },
  { pattern: /soweto/i, canonical: 'Soweto' },
];

function inferStopFromStructure(structure?: string): string {
  if (!structure) return 'Unassigned Stop';
  const s = structure.toUpperCase().trim();
  if (['S1', 'S19', 'S26'].includes(s)) return 'Saratoga';
  if (['S5', 'S6', 'S15', 'S20', 'YZ', 'YA', 'YOUTH'].includes(s)) return '56 Jorissen';
  if (['S14', 'S18'].includes(s)) return 'Gate 2';
  if (['S2', 'S3', 'S7', 'S8', 'S9', 'S10', 'S11', 'S12', 'S13', 'S16', 'S17', 'S21', 'S25'].includes(s)) return 'Junction';
  if (['S4'].includes(s)) return 'Randburg Surrey Square';
  return 'Unassigned Stop';
}

export interface RawRow {
  [key: string]: string;
}

// Scrub non-ASCII / invisible characters ("É", "Â", U+FFFD, NBSP, etc.) that
// Microsoft Forms exports contain. This is the single source of truth for
// text sanitization at the parsing boundary — kept in lockstep with
// ./transportSanitization so nothing dirty ever reaches persisted state.
function clean(s: unknown): string {
  return sanitizeTransportValue(s);
}

function lower(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function findColumn(headers: string[], patterns: string[]): string | null {
  // Clean + lowercased headers for matching (strips non-ASCII noise from Forms exports)
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
  const surnameCol = findColumn(headers, ['surname', 'last name', 'lastname', 'family name']);
  const surname = surnameCol ? clean(row[surnameCol]) : '';

  // Look for first name / name columns (distinct from surname)
  const nameCol = findColumn(headers, ['name', 'first name', 'firstname', 'name1', 'name 1', 'name2', 'name 2', 'passenger name', 'full name']);
  const name = nameCol ? clean(row[nameCol]) : '';

  if (name && surname) {
    const normName = lower(name);
    const normSurname = lower(surname);
    // If the name field already contains or ends with the surname (e.g. "Lebugang Masango" and "Masango")
    if (normName === normSurname || normName.endsWith(normSurname) || normName.includes(normSurname)) {
      return toTitleCase(name);
    }
    return toTitleCase(`${name} ${surname}`);
  }

  if (name) return toTitleCase(name);
  if (surname) return toTitleCase(surname);

  // Fallback: any column with "name" in it that isn't surname
  for (const h of headers) {
    const lh = lower(h);
    if (lh.includes('name') && !lh.includes('surname') && clean(row[h])) {
      return toTitleCase(clean(row[h]));
    }
  }
  return '';
}

function extractStop(row: RawRow, headers: string[], structure?: string): string {
  // Step 1: Check the area column (e.g., 'Area Stops' or 'Area Stops2') to know which area the person chose
  const areaCol = findColumn(headers, [
    'area stops2',
    'area stops 2',
    'area stops',
    'area stop',
    'area',
    'select area',
    'choose area',
  ]);
  const areaValue = areaCol ? lower(clean(row[areaCol])) : '';

  if (areaValue) {
    for (const mapping of AREA_TO_COLUMN) {
      if (mapping.areaValue.some((av) => areaValue.includes(av) || av.includes(areaValue))) {
        const stopCol = findColumn(headers, mapping.columnPattern);
        if (stopCol && stopCol !== areaCol) {
          const stop = clean(row[stopCol]);
          if (stop && !lower(stop).includes('area stops') && lower(stop) !== areaValue) {
            return stop;
          }
        }
      }
    }
  }

  // Step 2: Scan all specific sub-stop area columns for any non-empty sub-stop value
  for (const mapping of AREA_TO_COLUMN) {
    const stopCol = findColumn(headers, mapping.columnPattern);
    if (stopCol && stopCol !== areaCol) {
      const stop = clean(row[stopCol]);
      if (stop && !lower(stop).includes('area stops') && lower(stop) !== areaValue) {
        return stop;
      }
    }
  }

  // Step 3: Direct Pickup Stop columns (exact specific stop questions)
  const directStopCol = findColumn(headers, [
    'pickup stop',
    'pickup location',
    'boarding location',
    'sub-stop',
    'sub stop',
    'where will you join',
    'specific stop',
    'station',
    'where do you stay',
    'stop',
    'pick up point',
    'pick up stop',
    'select stop',
    'bus stop',
  ]);
  if (directStopCol && directStopCol !== areaCol && clean(row[directStopCol])) {
    const directStop = clean(row[directStopCol]);
    if (directStop && !lower(directStop).includes('area stops') && lower(directStop) !== areaValue) {
      return directStop;
    }
  }

  // Step 4: Scan EVERY cell value in the row against known stop signatures
  for (const h of headers) {
    const val = clean(row[h]);
    if (!val) continue;
    const lval = lower(val);
    if (lval.includes('area stops') || lval === areaValue || lval === 'yes' || lval === 'no') continue;

    for (const sig of KNOWN_STOP_SIGNATURES) {
      if (sig.pattern.test(val)) {
        return sig.canonical;
      }
    }
  }

  // Step 5: Fallback to areaValue if it contains meaningful location info
  if (areaCol && clean(row[areaCol])) {
    const av = clean(row[areaCol]);
    if (!lower(av).includes('area stops') && lower(av) !== 'none') {
      return av;
    }
  }

  // Step 6: Infer from passenger structure
  if (structure) {
    const inferred = inferStopFromStructure(structure);
    if (inferred && inferred !== 'Unassigned Stop') {
      return inferred;
    }
  }

  return 'Unassigned Stop';
}

// The forms have three separate structure columns: SZ1 Structures, SZ2 Structures, YZ Structures.
// Only one is populated per row depending on which zone the person belongs to.
const STRUCTURE_COLUMN_PATTERNS = [
  'sz1 structures', 'sz1 structure', 'sz1',
  'sz2 structures', 'sz2 structure', 'sz2',
  'yz structures', 'yz structure', 'yz',
  'structure', 'assembly structure', 'home structure', 'home assembly',
  'fellowship structure', 'pcf structure', 'assembly',
];

function extractStructure(row: RawRow, headers: string[]): string {
  // Try each specific structure column in priority order
  for (const pattern of STRUCTURE_COLUMN_PATTERNS) {
    const col = findColumn(headers, [pattern]);
    if (col) {
      const val = clean(row[col]);
      if (val && !lower(val).startsWith('zone ')) {
        return val.toUpperCase();
      }
    }
  }
  // Fallback: scan columns for any non-zone structure column
  for (const h of headers) {
    const lh = lower(clean(h));
    if (lh.includes('structure') && !lh.includes('area') && !lh.includes('zone')) {
      const val = clean(row[h]);
      if (val && !lower(val).startsWith('zone ')) {
        return val.toUpperCase();
      }
    }
  }
  // Last resort: zone / structure column
  const zoneCol = findColumn(headers, ['zone / structure', 'zone']);
  if (zoneCol) {
    const val = clean(row[zoneCol]);
    if (val) return val.toUpperCase();
  }
  return '';
}

function extractPhone(row: RawRow, headers: string[]): string | undefined {
  const col = findColumn(headers, ['phone number', 'whatsapp number', 'contact number', 'phone', 'whatsapp', 'contact', 'cell', 'mobile', 'cellphone']);
  if (!col) return undefined;
  return sanitizePhone(row[col]);
}

function extractEmail(row: RawRow, headers: string[]): string | undefined {
  const col = findColumn(headers, ['email address', 'email', 'user email', 'mail']);
  if (!col) return undefined;
  const raw = clean(row[col]);
  return raw ? raw.toLowerCase() : undefined;
}

function extractTimestamp(row: RawRow, headers: string[]): string | undefined {
  const col = findColumn(headers, ['completion time', 'submission time', 'timestamp', 'created at', 'date submitted']);
  if (!col) return undefined;
  return parseTimestampToISO(row[col]);
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

const MONTH_MAP: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

/**
 * Extracts and parses a calendar date pattern anywhere in a string, cell, or row,
 * returning a normalized 'YYYY-MM-DD' string or null if no valid date pattern was found.
 *
 * Handles:
 * - Unanchored formats with trailing or leading text, e.g. "11 September 2026 - Night Vigil"
 * - "D Month YYYY", "Month D, YYYY", "Month D YYYY", "YYYY-MM-DD", "DD/MM/YYYY", "M/D/YYYY"
 * - Native Date instances and Excel date numbers
 */
export function extractRowDate(input: unknown, headers?: string[]): string | null {
  if (input === null || input === undefined) return null;

  let raw: unknown = input;
  if (headers && typeof input === 'object' && !(input instanceof Date)) {
    const row = input as RawRow;
    const col = findColumn(headers, [
      'service date',
      'date of service',
      'event date',
      'attendance date',
      'service_date',
      'date',
    ]);
    if (!col || row[col] === undefined || row[col] === null) return null;
    raw = row[col];
  }

  // 1. Handle native Date instances (e.g. from SheetJS cellDates: true)
  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return null;
    const y = raw.getFullYear();
    const m = String(raw.getMonth() + 1).padStart(2, '0');
    const d = String(raw.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // 2. Handle Excel serial numbers if cellDates was disabled
  if (typeof raw === 'number' && raw > 20000 && raw < 80000) {
    const msPerDay = 86400 * 1000;
    const date = new Date(Math.round((raw - 25569) * msPerDay));
    if (!isNaN(date.getTime())) {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
  }

  const rawStr = clean(raw).trim();
  if (!rawStr) return null;

  // 3. Match "D Month YYYY" anywhere in the string (e.g. "11 September 2026 - Night Vigil", "7 Sep 2025")
  const dMonYrMatch = rawStr.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-zA-Z]{3,10})\s+(\d{4})\b/i);
  if (dMonYrMatch) {
    const day = parseInt(dMonYrMatch[1], 10);
    const monStr = lower(dMonYrMatch[2]);
    const monKey = monStr.slice(0, 3);
    const year = parseInt(dMonYrMatch[3], 10);
    const month = MONTH_MAP[monStr] || MONTH_MAP[monKey];
    if (month && day >= 1 && day <= 31 && year >= 1970 && year <= 2100) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // 4. Match "Month D, YYYY" or "Month D YYYY" anywhere in the string (e.g. "September 11, 2026 - Night Vigil")
  const monDYrMatch = rawStr.match(/\b([a-zA-Z]{3,10})\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?\s+(\d{4})\b/i);
  if (monDYrMatch) {
    const monStr = lower(monDYrMatch[1]);
    const monKey = monStr.slice(0, 3);
    const day = parseInt(monDYrMatch[2], 10);
    const year = parseInt(monDYrMatch[3], 10);
    const month = MONTH_MAP[monStr] || MONTH_MAP[monKey];
    if (month && day >= 1 && day <= 31 && year >= 1970 && year <= 2100) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // 5. Match "D-Mon-YYYY" or "D/Mon/YYYY" anywhere in the string (e.g. "11-Sep-2026", "11/September/2026 - Event")
  const dMonYrDashMatch = rawStr.match(/\b(\d{1,2})(?:st|nd|rd|th)?[-/]([a-zA-Z]{3,10})[-/](\d{4})\b/i);
  if (dMonYrDashMatch) {
    const day = parseInt(dMonYrDashMatch[1], 10);
    const monStr = lower(dMonYrDashMatch[2]);
    const monKey = monStr.slice(0, 3);
    const year = parseInt(dMonYrDashMatch[3], 10);
    const month = MONTH_MAP[monStr] || MONTH_MAP[monKey];
    if (month && day >= 1 && day <= 31 && year >= 1970 && year <= 2100) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // 6. Match ISO format "YYYY-MM-DD" anywhere in the string (e.g. "2026-09-11", "2026-09-11 - Night Vigil")
  const isoMatch = rawStr.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10);
    const month = parseInt(isoMatch[2], 10);
    const day = parseInt(isoMatch[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 1970 && year <= 2100) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // 7. Match numeric "DD/MM/YYYY" or "D-M-YYYY" anywhere in the string
  const numMatch = rawStr.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/);
  if (numMatch) {
    const partA = parseInt(numMatch[1], 10);
    const partB = parseInt(numMatch[2], 10);
    const year = parseInt(numMatch[3], 10);
    let day = partA;
    let month = partB;
    if (partA > 12 && partB <= 12) {
      day = partA;
      month = partB;
    } else if (partB > 12 && partA <= 12) {
      month = partA;
      day = partB;
    }
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 1970 && year <= 2100) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // 8. Fallback: Try native Date parser for clean standard strings without trailing annotations
  const cell = new Date(rawStr);
  if (!isNaN(cell.getTime()) && cell.getFullYear() >= 1970 && cell.getFullYear() <= 2100) {
    const y = cell.getFullYear();
    const m = String(cell.getMonth() + 1).padStart(2, '0');
    const d = String(cell.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  return null;
}

function matchesDate(row: RawRow, headers: string[], selectedDate: string): boolean {
  const col = findColumn(headers, [
    'service date',
    'date of service',
    'event date',
    'attendance date',
    'service_date',
    'date',
  ]);
  if (!col) return true; // no date column — don't filter by date
  const raw = clean(row[col]);
  if (!raw) return true; // empty date value — don't filter

  const parsedDate = extractRowDate(raw);
  if (parsedDate) {
    // We parsed a real date — only include if it matches the selected service date
    return parsedDate === selectedDate;
  }

  // Truly unparseable date — don't exclude (benefit of the doubt)
  return true;
}

export function matchesService(
  row: RawRow,
  headers: string[],
  selectedService: ServiceType,
  sheetName: string = ''
): boolean {
  const selectedPeriod: 'AM' | 'PM' = selectedService.startsWith('AM') ? 'AM' : 'PM';
  const normSheet = lower(clean(sheetName));

  // If sheet explicitly declares PM, do not include in AM service
  if (selectedPeriod === 'AM' && (normSheet.includes('pm') || normSheet.includes('evening')) && !normSheet.includes('am')) {
    return false;
  }
  // If sheet explicitly declares AM, do not include in PM service
  if (selectedPeriod === 'PM' && (normSheet.includes('am') || normSheet.includes('morning')) && !normSheet.includes('pm')) {
    return false;
  }

  // Check row service column for AM / PM indicators
  const serviceCol = findColumn(headers, [
    'which service are you attending',
    'service attending',
    'service',
    'am service type',
    'pm service type',
    'service type',
    'servicetype',
  ]);

  if (serviceCol) {
    const val = lower(clean(row[serviceCol]));
    if (val) {
      if (
        selectedPeriod === 'AM' &&
        (val.includes('pm') || val.includes('evening') || val.includes('afternoon') || val.includes('17:00') || val.includes('18:00')) &&
        !val.includes('am') &&
        !val.includes('morning')
      ) {
        return false;
      }
      if (
        selectedPeriod === 'PM' &&
        (val.includes('am') || val.includes('morning') || val.includes('08:30') || val.includes('10:00')) &&
        !val.includes('pm') &&
        !val.includes('evening')
      ) {
        return false;
      }
    }
  }

  // Check if both AM and PM columns exist in the row
  const amCol = findColumn(headers, ['am service type', 'am service', 'am serving']);
  const pmCol = findColumn(headers, ['pm service type', 'pm service', 'pm serving']);
  if (amCol && pmCol) {
    const amVal = clean(row[amCol]);
    const pmVal = clean(row[pmCol]);
    if (selectedPeriod === 'AM' && !amVal && pmVal) return false;
    if (selectedPeriod === 'PM' && !pmVal && amVal) return false;
  }

  return true;
}

export interface ParseResult {
  passengers: Passenger[];
  skipped: number;
  totalRows: number;
  matchedDate: number;
  matchedService: number;
  matchedTransport: number;
  skippedSheets: string[];
  warnings: string[];
}

/** Regex for sheet names that represent computed dashboards, goals, tables, or summary metrics */
export const NON_SIGNUP_SHEET_PATTERN = /table|tracker|goal|summary|dashboard|stats|metrics/i;

/** Expected column names representing passenger identity */
export const IDENTITY_COLUMN_PATTERNS = [
  'name',
  'full name',
  'fullname',
  'passenger name',
  'name1',
  'name 1',
  'name2',
  'name 2',
  'first name',
  'firstname',
  'surname',
  'last name',
  'lastname',
  'family name',
];

/**
 * Checks if a column header represents a passenger identity field,
 * while excluding non-passenger name headers like "Stop Name" or "Bus Name".
 */
export function isIdentityHeader(header: string): boolean {
  const h = lower(clean(header));
  if (!h) return false;

  // Exclude non-person name columns
  if (
    h.includes('stop name') ||
    h.includes('station name') ||
    h.includes('bus name') ||
    h.includes('driver name') ||
    h.includes('church name') ||
    h.includes('area name') ||
    h.includes('group name') ||
    h.includes('team name') ||
    h.includes('ministry name') ||
    h.includes('file name') ||
    h.includes('sheet name')
  ) {
    return false;
  }

  // Exact matches
  const exactPatterns = [
    'name',
    'full name',
    'fullname',
    'first name',
    'firstname',
    'surname',
    'last name',
    'lastname',
    'family name',
    'passenger name',
    'name1',
    'name 1',
    'name2',
    'name 2',
    'attendee name',
    'member name',
  ];
  if (exactPatterns.includes(h)) return true;

  // Pattern matches (e.g. "What is your Name", "Passenger's Full Name")
  if (
    h.includes('full name') ||
    h.includes('passenger name') ||
    h.includes('first name') ||
    h.includes('last name') ||
    h.includes('surname') ||
    h.includes('your name') ||
    h.startsWith('name ') ||
    h.endsWith(' name')
  ) {
    return true;
  }

  return false;
}

/**
 * Checks whether a sheet represents real signup data by:
 * 1. Filtering out sheets whose names indicate summary tables, goal trackers, or dashboards.
 * 2. Requiring the header row to contain at least one expected passenger identity column (Name, Surname, Full Name).
 */
export function isSignupSheet(sheetName: string, headers: string[]): boolean {
  if (!sheetName) return false;

  // 1. Skip sheets matching known computed/summary patterns (e.g. "PM Table", "AM Table", "SZ1 Goal tracker")
  if (NON_SIGNUP_SHEET_PATTERN.test(sheetName.trim())) {
    return false;
  }

  // 2. Must contain at least one expected passenger identity column
  if (!headers || headers.length === 0) {
    return false;
  }

  return headers.some(isIdentityHeader);
}

/**
 * Checks if a parsed row has only empty, null, or whitespace values.
 */
export function isRowEmpty(row: RawRow): boolean {
  if (!row || typeof row !== 'object') return true;
  for (const key of Object.keys(row)) {
    const val = row[key];
    if (val !== undefined && val !== null && String(val).trim() !== '') {
      return false;
    }
  }
  return true;
}

/**
 * Trims trailing fully-blank rows from a sheet before processing,
 * preventing wasted CPU cycles on Excel sheets with ghost formatting extending to row 1000+.
 */
export function trimTrailingEmptyRows(rows: RawRow[]): RawRow[] {
  if (!rows || rows.length === 0) return [];
  let lastIndex = rows.length - 1;
  while (lastIndex >= 0 && isRowEmpty(rows[lastIndex])) {
    lastIndex--;
  }
  return lastIndex >= 0 ? rows.slice(0, lastIndex + 1) : [];
}

interface RawCandidate {
  row: RawRow;
  headers: string[];
  name: string;
  normalizedName: string;
  stop: string;
  structure: string;
  phone?: string;
  userEmail?: string;
  timestamp?: string;
  timestampEpoch: number;
  wantsTransport: boolean;
  matchesDate: boolean;
  hub: string;
  category: 'Ushers' | 'Serving' | 'Normal';
  ministry: string;
  memberType?: 'M' | 'V' | 'FTV';
  id: string;
  sheetName: string;
  rowIndex: number;
}

/**
 * Shared candidate processing and passenger allocation logic.
 */
function processExtractedCandidates(
  rawSubmissions: RawCandidate[],
  opts: ParseOptions,
  totalRows: number,
  initialSkipped: number,
  skippedSheets: string[],
  warnings: string[]
): ParseResult {
  let skipped = initialSkipped;
  let matchedDate = 0;
  let matchedTransport = 0;

  // Pass 2: Group submissions by person and keep strictly the MOST RECENT submission for each person
  const personGroups = new Map<string, RawCandidate[]>();
  for (const sub of rawSubmissions) {
    const group = personGroups.get(sub.normalizedName);
    if (!group) {
      personGroups.set(sub.normalizedName, [sub]);
    } else {
      group.push(sub);
    }
  }

  const dateMatchedCandidates: RawCandidate[] = [];

  for (const [, submissions] of personGroups) {
    // Sort submissions for this person by timestamp descending (or row index descending if equal)
    submissions.sort((a, b) => {
      if (b.timestampEpoch !== a.timestampEpoch) {
        return b.timestampEpoch - a.timestampEpoch;
      }
      return b.rowIndex - a.rowIndex;
    });

    // The most recent submission takes 100% precedence
    const mostRecent = submissions[0];

    // Older duplicate submissions for this person are superseded
    if (submissions.length > 1) {
      skipped += (submissions.length - 1);
    }

    // Now evaluate the most recent submission
    if (!mostRecent.wantsTransport) {
      skipped++;
      continue;
    }
    matchedTransport++;

    if (!mostRecent.matchesDate) {
      skipped++;
      continue;
    }
    matchedDate++;

    dateMatchedCandidates.push(mostRecent);
  }

  // Count categories among valid date-matched submissions
  const ushersCount = dateMatchedCandidates.filter((c) => c.category === 'Ushers').length;
  const normalCount = dateMatchedCandidates.filter((c) => c.category === 'Normal').length;

  const selectedService = opts.selectedService;
  const passengers: Passenger[] = [];

  // Pass 3: Filter and apply auto-merging logic based on selectedService and 15-passenger minimum
  for (const c of dateMatchedCandidates) {
    if (!matchesService(c.row, c.headers, opts.selectedService, c.sheetName)) {
      continue;
    }

    let include = false;

    if (selectedService === 'AM_Ushers') {
      // Dedicated Ushers (Early) service
      include = c.category === 'Ushers';
    } else if (selectedService === 'AM_Normal' || selectedService === 'PM_Normal') {
      // Dedicated Normal transport service
      include = c.category === 'Normal';
    } else if (selectedService === 'AM_Serving') {
      // AM Serving main service
      if (c.category === 'Serving') {
        include = true;
      } else if (c.category === 'Ushers') {
        // Auto-merge into AM Serving if not enough for a dedicated Ushers taxi (< 15)
        include = ushersCount < MIN_TAXI_THRESHOLD;
      } else if (c.category === 'Normal') {
        // Auto-merge into AM Serving if not enough for a normal taxi (< 15)
        include = normalCount < MIN_TAXI_THRESHOLD;
      }
    } else if (selectedService === 'PM_Serving') {
      // PM Serving
      include = c.category === 'Serving' || c.category === 'Ushers';
    }

    if (include) {
      passengers.push({
        id: c.id,
        fullName: c.name,
        stop: c.stop,
        structure: c.structure,
        phone: c.phone,
        userEmail: c.userEmail,
        timestamp: c.timestamp,
        hub: c.hub,
        service: opts.selectedService,
        category: c.category,
        ministry: c.ministry,
        memberType: c.memberType,
        assignedTo: null,
        present: false,
        cancellationFeeOwed: false,
      });
    }
  }

  const matchedService = passengers.length;
  const totalExcluded = dateMatchedCandidates.length - passengers.length;
  skipped += totalExcluded;

  // Informative notices & warnings based on threshold
  if (selectedService === 'AM_Serving') {
    if (ushersCount > 0 && ushersCount < MIN_TAXI_THRESHOLD) {
      warnings.push(`Auto-Included: ${ushersCount} Ushers (Early) signups merged into AM Serving (${ushersCount} < ${MIN_TAXI_THRESHOLD} minimum for a dedicated taxi).`);
    } else if (ushersCount >= MIN_TAXI_THRESHOLD) {
      warnings.push(`Notice: ${ushersCount} Ushers (Early) signups detected (≥ ${MIN_TAXI_THRESHOLD}). They have enough for a dedicated taxi under "AM Service — Ushers (Early)".`);
    }

    if (normalCount > 0 && normalCount < MIN_TAXI_THRESHOLD) {
      warnings.push(`Auto-Included: ${normalCount} AM Normal signups merged into AM Serving (${normalCount} < ${MIN_TAXI_THRESHOLD} minimum for a taxi).`);
    } else if (normalCount >= MIN_TAXI_THRESHOLD) {
      warnings.push(`Notice: ${normalCount} AM Normal signups detected. Available under "AM Service — Normal Only".`);
    }
  } else if (selectedService === 'AM_Ushers') {
    if (ushersCount > 0 && ushersCount < MIN_TAXI_THRESHOLD) {
      warnings.push(`Note: ${ushersCount} Ushers (Early) signups (< ${MIN_TAXI_THRESHOLD} taxi minimum). In "AM Service — Serving Only", these will automatically merge with AM Serving.`);
    } else if (ushersCount >= MIN_TAXI_THRESHOLD) {
      warnings.push(`✓ ${ushersCount} Ushers (Early) signups available — enough for a dedicated taxi (${Math.floor(ushersCount / 15)} taxi(s)).`);
    }
  } else if (selectedService === 'AM_Normal') {
    if (normalCount > 0 && normalCount < MIN_TAXI_THRESHOLD) {
      warnings.push(`Note: ${normalCount} AM Normal signups (< ${MIN_TAXI_THRESHOLD} taxi minimum). In "AM Service — Serving Only", these will automatically merge with AM Serving.`);
    } else if (normalCount >= MIN_TAXI_THRESHOLD) {
      warnings.push(`✓ ${normalCount} AM Normal signups available.`);
    }
  }

  return {
    passengers,
    skipped,
    totalRows,
    matchedDate,
    matchedService,
    matchedTransport,
    skippedSheets,
    warnings,
  };
}

/**
 * Synchronous workbook parser.
 * Filters out computed/dashboard sheets, trims trailing blank rows,
 * parses unanchored date values, and returns ParseResult with skippedSheets.
 */
export function parseWorkbook(file: ArrayBuffer, opts: ParseOptions): ParseResult {
  const wb = XLSX.read(file, { type: 'array', cellDates: true });
  if (!wb.SheetNames || wb.SheetNames.length === 0) {
    return {
      passengers: [],
      skipped: 0,
      totalRows: 0,
      matchedDate: 0,
      matchedService: 0,
      matchedTransport: 0,
      skippedSheets: [],
      warnings: ['No sheets found in workbook.'],
    };
  }

  const rawSubmissions: RawCandidate[] = [];
  const skippedSheets: string[] = [];
  let totalRows = 0;
  let skipped = 0;
  const warnings: string[] = [];

  // Pass 1: Extract all raw row candidates across valid signup sheets in the workbook
  for (const sheetName of wb.SheetNames) {
    // 1. Skip sheets matching dashboard / goal / table patterns by name
    if (NON_SIGNUP_SHEET_PATTERN.test(sheetName.trim())) {
      skippedSheets.push(sheetName);
      continue;
    }

    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;

    const rawRows = XLSX.utils.sheet_to_json<RawRow>(sheet, { defval: '' });
    if (rawRows.length === 0) {
      skippedSheets.push(sheetName);
      continue;
    }

    const headers = Object.keys(rawRows[0]);
    // 2. Validate sheet header has at least one expected identity column
    if (!isSignupSheet(sheetName, headers)) {
      skippedSheets.push(sheetName);
      continue;
    }

    // Pre-pass: trim trailing fully-blank rows (e.g. range extends to row 1000 with only 10 rows of data)
    const rows = trimTrailingEmptyRows(rawRows);
    if (rows.length === 0) continue;

    for (const row of rows) {
      // Skip inline empty rows without doing expensive extraction
      if (isRowEmpty(row)) {
        continue;
      }

      totalRows++;
      const name = extractFullName(row, headers);
      if (!name) {
        skipped++;
        continue;
      }
      const normalizedName = normalizePassengerText(name);
      if (!normalizedName) {
        skipped++;
        continue;
      }

      const timestampCol = findColumn(headers, ['completion time', 'submission time', 'timestamp', 'created at', 'date submitted']);
      const rawTimestamp = timestampCol ? row[timestampCol] : undefined;
      const timestamp = extractTimestamp(row, headers);
      const timestampEpoch = getSubmissionTimestampEpoch(rawTimestamp || timestamp, totalRows);

      const structure = extractStructure(row, headers);
      const stop = extractStop(row, headers, structure);
      const phone = extractPhone(row, headers);
      const userEmail = extractEmail(row, headers);
      const hub = hubDisplayName('Taxi', stop);
      const { category, ministry } = extractCategoryAndMinistry(row, headers, sheetName);
      const memberType = extractMemberType(row, headers, structure);
      const id = `${name}-${stop}`.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

      const wantsTrans = wantsTransport(row, headers);
      const dateMatch = matchesDate(row, headers, opts.selectedDate);

      rawSubmissions.push({
        row,
        headers,
        name,
        normalizedName,
        stop,
        structure,
        phone,
        userEmail,
        timestamp,
        timestampEpoch,
        wantsTransport: wantsTrans,
        matchesDate: dateMatch,
        hub,
        category,
        ministry,
        memberType,
        id,
        sheetName,
        rowIndex: totalRows,
      });
    }
  }

  return processExtractedCandidates(rawSubmissions, opts, totalRows, skipped, skippedSheets, warnings);
}

/**
 * Asynchronous workbook parser that yields periodically to the event loop.
 * This prevents freezing the UI thread on large multi-sheet workbooks and
 * allows progress indicators to update smoothly.
 */
export async function parseWorkbookAsync(
  file: ArrayBuffer,
  opts: ParseOptions,
  onProgress?: ParseProgressCallback
): Promise<ParseResult> {
  const wb = XLSX.read(file, { type: 'array', cellDates: true });
  if (!wb.SheetNames || wb.SheetNames.length === 0) {
    return {
      passengers: [],
      skipped: 0,
      totalRows: 0,
      matchedDate: 0,
      matchedService: 0,
      matchedTransport: 0,
      skippedSheets: [],
      warnings: ['No sheets found in workbook.'],
    };
  }

  const rawSubmissions: RawCandidate[] = [];
  const skippedSheets: string[] = [];
  let totalRows = 0;
  let skipped = 0;
  const warnings: string[] = [];

  const totalSheets = wb.SheetNames.length;

  // Process sheet-by-sheet with asynchronous yielding
  for (let sIdx = 0; sIdx < totalSheets; sIdx++) {
    const sheetName = wb.SheetNames[sIdx];

    if (onProgress) {
      onProgress({
        sheetName,
        sheetIndex: sIdx + 1,
        totalSheets,
        phase: 'scanning_sheet',
      });
    }

    // Yield control so UI can paint progress updates
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 1. Skip sheets matching dashboard / goal / table patterns by name
    if (NON_SIGNUP_SHEET_PATTERN.test(sheetName.trim())) {
      skippedSheets.push(sheetName);
      continue;
    }

    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;

    const rawRows = XLSX.utils.sheet_to_json<RawRow>(sheet, { defval: '' });
    if (rawRows.length === 0) {
      skippedSheets.push(sheetName);
      continue;
    }

    const headers = Object.keys(rawRows[0]);
    // 2. Validate sheet header has at least one expected identity column
    if (!isSignupSheet(sheetName, headers)) {
      skippedSheets.push(sheetName);
      continue;
    }

    // Pre-pass: trim trailing fully-blank rows
    const rows = trimTrailingEmptyRows(rawRows);
    if (rows.length === 0) continue;

    for (const row of rows) {
      // Skip empty rows without doing expensive extraction
      if (isRowEmpty(row)) {
        continue;
      }

      totalRows++;
      const name = extractFullName(row, headers);
      if (!name) {
        skipped++;
        continue;
      }
      const normalizedName = normalizePassengerText(name);
      if (!normalizedName) {
        skipped++;
        continue;
      }

      const timestampCol = findColumn(headers, ['completion time', 'submission time', 'timestamp', 'created at', 'date submitted']);
      const rawTimestamp = timestampCol ? row[timestampCol] : undefined;
      const timestamp = extractTimestamp(row, headers);
      const timestampEpoch = getSubmissionTimestampEpoch(rawTimestamp || timestamp, totalRows);

      const structure = extractStructure(row, headers);
      const stop = extractStop(row, headers, structure);
      const phone = extractPhone(row, headers);
      const userEmail = extractEmail(row, headers);
      const hub = hubDisplayName('Taxi', stop);
      const { category, ministry } = extractCategoryAndMinistry(row, headers, sheetName);
      const memberType = extractMemberType(row, headers, structure);
      const id = `${name}-${stop}`.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

      const wantsTrans = wantsTransport(row, headers);
      const dateMatch = matchesDate(row, headers, opts.selectedDate);

      rawSubmissions.push({
        row,
        headers,
        name,
        normalizedName,
        stop,
        structure,
        phone,
        userEmail,
        timestamp,
        timestampEpoch,
        wantsTransport: wantsTrans,
        matchesDate: dateMatch,
        hub,
        category,
        ministry,
        memberType,
        id,
        sheetName,
        rowIndex: totalRows,
      });
    }
  }

  if (onProgress) {
    onProgress({
      sheetName: 'All sheets',
      sheetIndex: totalSheets,
      totalSheets,
      phase: 'processing',
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 0));

  const result = processExtractedCandidates(rawSubmissions, opts, totalRows, skipped, skippedSheets, warnings);

  if (onProgress) {
    onProgress({
      sheetName: 'Complete',
      sheetIndex: totalSheets,
      totalSheets,
      phase: 'done',
    });
  }

  return result;
}
