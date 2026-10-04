import * as XLSX from 'xlsx';
import type { Passenger, ServiceType } from './types';
import { MIN_TAXI_THRESHOLD, MIN_AM_NORMAL_THRESHOLD, hubDisplayName } from './types';
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

/**
 * Values indicating negative or non-serving responses in ministry or serving columns.
 */
export function isNonServingValue(val: unknown): boolean {
  if (val === undefined || val === null) return true;
  const v = lower(clean(val));
  if (!v) return true;
  return (
    v === 'no' ||
    v === 'n' ||
    v === 'none' ||
    v === 'n/a' ||
    v === 'na' ||
    v === '-' ||
    v === '--' ||
    v === 'nil' ||
    v === 'null' ||
    v === 'normal' ||
    v === 'not serving' ||
    v === 'not attending' ||
    v === 'just attending' ||
    v.startsWith('no ') ||
    v.startsWith('no,') ||
    v.includes('not serving') ||
    v.includes('just attending') ||
    v.includes('first time visiting') ||
    v.includes('no, i am not') ||
    v.includes('i am not serving')
  );
}

export function extractCategoryAndMinistry(
  row: RawRow,
  headers: string[],
  sheetName?: string,
  selectedService?: ServiceType
): { category: 'Ushers' | 'Serving' | 'Normal'; ministry: string } {
  const isPM = selectedService?.startsWith('PM');
  const isAM = selectedService?.startsWith('AM');

  // Candidate service type columns in order of relevance to the active session
  const serviceTypePatterns = isPM
    ? [
        'pm service type',
        'pm service',
        'pm serving',
        'service type',
        'servicetype',
        'which service are you attending',
        'service attending',
      ]
    : isAM
    ? [
        'am service type',
        'am service',
        'am serving',
        'service type',
        'servicetype',
        'which service are you attending',
        'service attending',
      ]
    : [
        'service type',
        'servicetype',
        'which service are you attending',
        'am service type',
        'pm service type',
        'service attending',
      ];

  const serviceTypeCol = findColumn(headers, serviceTypePatterns);
  const servingCol = findColumn(headers, ['serving ministry', 'serving', 'ministry', 'are you serving']);

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
    sheetLower.includes('usher') ||
    ministryLower.includes('usher (early)') ||
    ministryLower.includes('ushers (early)')
  ) {
    return { category: 'Ushers', ministry: !isNonServingValue(rawMinistry) ? rawMinistry : 'Usher (Early)' };
  }

  // 2. Explicit Non-serving / Normal indicators
  const isServingQuestion = servingCol && (lower(clean(servingCol)).includes('are you serving') || lower(clean(servingCol)) === 'serving');
  const answeredNoToServing = isServingQuestion && isNonServingValue(rawMinistry);
  const explicitNonServingMinistry = Boolean(rawMinistry) && isNonServingValue(rawMinistry);

  if (
    answeredNoToServing ||
    serviceLower === 'normal' ||
    serviceLower.startsWith('normal') ||
    serviceLower.includes('normal') ||
    (sheetLower.includes('normal') && !sheetLower.includes('serving'))
  ) {
    return { category: 'Normal', ministry: '' };
  }

  // 3. Explicit Serving indicators
  const hasValidMinistry = Boolean(rawMinistry) && !explicitNonServingMinistry && !isNonServingValue(rawMinistry);
  const answeredYesToServing = isServingQuestion && (ministryLower === 'yes' || ministryLower.startsWith('yes') || ministryLower.includes('yes, i am'));

  if (
    serviceLower.includes('serving') ||
    SERVING_KEYWORDS.some((k) => ministryLower.includes(k) || serviceLower.includes(k)) ||
    hasValidMinistry ||
    answeredYesToServing ||
    (sheetLower.includes('serving') && !explicitNonServingMinistry && !isNonServingValue(rawMinistry))
  ) {
    const finalMinistry = hasValidMinistry ? rawMinistry : (answeredYesToServing ? 'Serving' : (rawMinistry || 'Serving'));
    return { category: 'Serving', ministry: finalMinistry };
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
  // Avoid picking leader/homecell columns for passenger name
  const candidateHeaders = headers.filter((h) => {
    const lh = lower(clean(h));
    return !lh.includes('leader') && !lh.includes('homecell');
  });

  const surnameCol = findColumn(candidateHeaders, ['surname', 'last name', 'lastname', 'family name']);
  const surname = surnameCol ? clean(row[surnameCol]) : '';

  // Look for first name / name columns (distinct from surname)
  const nameCol = findColumn(candidateHeaders, ['name', 'first name', 'firstname', 'name1', 'name 1', 'name2', 'name 2', 'passenger name', 'full name']);
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

  // Fallback: any column with "name" in it that isn't surname or leader
  for (const h of candidateHeaders) {
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
  // First pass: look for any email header containing a valid '@' address
  const emailCols = headers.filter((h) => {
    const lh = lower(clean(h));
    return lh.includes('email') || lh.includes('mail');
  });
  for (const col of emailCols) {
    const val = clean(row[col]);
    if (val && val.includes('@')) {
      return val.toLowerCase();
    }
  }

  // Fallback: standard column pattern match
  const col = findColumn(headers, ['email address', 'email', 'user email', 'mail']);
  if (!col) return undefined;
  const raw = clean(row[col]);
  return raw && raw.includes('@') ? raw.toLowerCase() : undefined;
}

function extractHomecellLeader(row: RawRow, headers: string[]): string | undefined {
  // Find all candidate headers that represent a leader name (excluding contact/phone columns)
  const leaderCols = headers.filter((h) => {
    const lh = lower(clean(h));
    const isLeader =
      lh.includes('homecell leader') ||
      lh.includes('leader name') ||
      lh.includes("leader's name") ||
      lh === 'homecell leader' ||
      lh.startsWith('homecell leader');
    const isContact =
      lh.includes('contact') ||
      lh.includes('phone') ||
      lh.includes('number') ||
      lh.includes('cellphone') ||
      (lh.includes('cell') && !lh.includes('homecell'));
    return isLeader && !isContact;
  });

  for (const col of leaderCols) {
    const val = clean(row[col]);
    if (
      val &&
      !['n/a', 'na', 'none', '-', 'option 1', 'null', 'nil'].includes(lower(val)) &&
      !/^\+?\d[\d\s-]{6,}$/.test(val)
    ) {
      return toTitleCase(val);
    }
  }

  // Fallback: standard findColumn pattern match
  const col = findColumn(headers, [
    "homecell leader's name",
    "homecell leader name",
    "homecell leader",
    "leader's name",
    "leader name",
  ]);
  if (col) {
    const val = clean(row[col]);
    if (
      val &&
      !['n/a', 'na', 'none', '-', 'option 1', 'null', 'nil'].includes(lower(val)) &&
      !/^\+?\d[\d\s-]{6,}$/.test(val)
    ) {
      return toTitleCase(val);
    }
  }
  return undefined;
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

export const DATE_COLUMN_PATTERNS = [
  'service date',
  'date of service',
  'event date',
  'attendance date',
  'service_date',
  'dreamweek date',
  'dreamweek',
  'which day will you be attending',
  'which day are you attending',
  'which date are you attending',
  'which service date are you attending',
  'which service date',
  'which night are you attending',
  'which night',
  'which day',
  'which date',
  'select date',
  'select day',
  'choose date',
  'choose day',
  'date attending',
  'day attending',
  'attendance day',
  'conference date',
  'evening date',
  'evening service date',
  'date',
  'day',
  'night',
];

export function findDateColumn(headers: string[]): string | null {
  const direct = findColumn(headers, DATE_COLUMN_PATTERNS);
  if (direct) return direct;

  return headers.find((h) => {
    const lh = lower(clean(h));
    // Must NOT be cell day, birthday, timestamp, contact, service type, leader, or stop
    if (
      lh.includes('cell') ||
      lh.includes('homecell') ||
      lh.includes('birth') ||
      lh.includes('completion') ||
      lh.includes('submission') ||
      lh.includes('created') ||
      lh.includes('timestamp') ||
      lh.includes('phone') ||
      lh.includes('email') ||
      lh.includes('contact') ||
      lh.includes('leader') ||
      lh.includes('structure') ||
      lh.includes('stop') ||
      lh.includes('area') ||
      lh.includes('name') ||
      (lh.includes('service') && !lh.includes('date') && !lh.includes('day'))
    ) {
      return false;
    }
    return (
      lh.includes('date') ||
      (lh.includes('day') && !lh.includes('today')) ||
      lh.includes('night') ||
      lh.includes('evening date')
    );
  }) || null;
}

/**
 * Extracts and parses a calendar date pattern anywhere in a string, cell, or row,
 * returning a normalized 'YYYY-MM-DD' string or null if no valid date pattern was found.
 *
 * Handles:
 * - Unanchored formats with trailing or leading text, e.g. "11 September 2026 - Night Vigil"
 * - "D Month YYYY", "Month D, YYYY", "Month D YYYY", "YYYY-MM-DD", "DD/MM/YYYY", "M/D/YYYY"
 * - Date patterns without year, defaulting to referenceDate's year or 2026 (e.g. "Tuesday, 22 September", "22 Sep")
 * - Native Date instances and Excel date numbers
 */
export function extractRowDate(input: unknown, headers?: string[], referenceDate?: string): string | null {
  if (input === null || input === undefined) return null;

  let raw: unknown = input;
  if (headers && typeof input === 'object' && !(input instanceof Date)) {
    const row = input as RawRow;
    const col = findDateColumn(headers);
    if (!col || row[col] === undefined || row[col] === null) return null;
    raw = row[col];
  }

  // 1. Handle native Date instances (e.g. from SheetJS cellDates: true)
  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return null;
    const isUtcMidnight = raw.getUTCHours() === 0 && raw.getUTCMinutes() === 0 && raw.getUTCSeconds() === 0;
    const y = isUtcMidnight ? raw.getUTCFullYear() : raw.getFullYear();
    const m = String((isUtcMidnight ? raw.getUTCMonth() : raw.getMonth()) + 1).padStart(2, '0');
    const d = String(isUtcMidnight ? raw.getUTCDate() : raw.getDate()).padStart(2, '0');
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

  const refYear = (referenceDate && /^\d{4}/.test(referenceDate))
    ? parseInt(referenceDate.slice(0, 4), 10)
    : 2026;

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

  // 8. Match "D Month" WITHOUT year (e.g. "Tuesday, 22 September", "22 September", "22 Sep", "22nd September")
  const dMonNoYrMatch = rawStr.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-zA-Z]{3,10})\b/i);
  if (dMonNoYrMatch) {
    const day = parseInt(dMonNoYrMatch[1], 10);
    const monStr = lower(dMonNoYrMatch[2]);
    const monKey = monStr.slice(0, 3);
    const month = MONTH_MAP[monStr] || MONTH_MAP[monKey];
    if (month && day >= 1 && day <= 31) {
      return `${refYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // 9. Match "Month D" WITHOUT year (e.g. "September 22", "Sep 22")
  const monDNoYrMatch = rawStr.match(/\b([a-zA-Z]{3,10})\s+(\d{1,2})(?:st|nd|rd|th)?\b/i);
  if (monDNoYrMatch) {
    const monStr = lower(monDNoYrMatch[1]);
    const monKey = monStr.slice(0, 3);
    const day = parseInt(monDNoYrMatch[2], 10);
    const month = MONTH_MAP[monStr] || MONTH_MAP[monKey];
    if (month && day >= 1 && day <= 31) {
      return `${refYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // 10. Match numeric "DD/MM" or "DD-MM" without year (e.g. "22/09", "22-09")
  const numNoYrMatch = rawStr.match(/\b(\d{1,2})[-/.](\d{1,2})\b/);
  if (numNoYrMatch) {
    const partA = parseInt(numNoYrMatch[1], 10);
    const partB = parseInt(numNoYrMatch[2], 10);
    let day = partA;
    let month = partB;
    if (partA > 12 && partB <= 12) {
      day = partA;
      month = partB;
    } else if (partB > 12 && partA <= 12) {
      month = partA;
      day = partB;
    }
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${refYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // 11. Fallback: Try native Date parser for clean standard strings without trailing annotations
  const cell = new Date(rawStr);
  if (!isNaN(cell.getTime()) && cell.getFullYear() >= 1970 && cell.getFullYear() <= 2100) {
    const y = cell.getFullYear();
    const m = String(cell.getMonth() + 1).padStart(2, '0');
    const d = String(cell.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  return null;
}

export function matchesDate(row: RawRow, headers: string[], selectedDate: string): boolean {
  const col = findDateColumn(headers);
  if (!col) return true; // no date column — don't filter by date

  const rawVal = row[col];
  if (rawVal === undefined || rawVal === null) return true; // empty date value — don't filter
  if (typeof rawVal === 'string' && !rawVal.trim()) return true;

  // 1. Direct parse check via extractRowDate
  const parsedDate = extractRowDate(rawVal, undefined, selectedDate);
  if (parsedDate === selectedDate) {
    return true;
  }

  // 2. Comprehensive check for multi-select, day-of-week, or formatted cells
  const valStr = lower(clean(rawVal));
  if (!valStr) return true;

  const [sYStr, sMStr, sDStr] = selectedDate.split('-');
  const sY = parseInt(sYStr, 10);
  const sM = parseInt(sMStr, 10);
  const sD = parseInt(sDStr, 10);
  if (!sY || !sM || !sD) {
    return parsedDate ? parsedDate === selectedDate : true;
  }

  // Check if string contains direct selectedDate (e.g. "2026-09-22" or "2026/09/22")
  if (valStr.includes(selectedDate) || valStr.includes(selectedDate.replace(/-/g, '/'))) {
    return true;
  }

  const selDateObj = new Date(sY, sM - 1, sD);
  const dayOfWeekIdx = selDateObj.getDay();
  const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const WEEKDAY_NAMES_SHORT = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const selWeekday = WEEKDAY_NAMES[dayOfWeekIdx];
  const selWeekdayShort = WEEKDAY_NAMES_SHORT[dayOfWeekIdx];
  const MONTH_NAMES = ['', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const MONTH_NAMES_SHORT = ['', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const selMon = MONTH_NAMES[sM] || '';
  const selMonShort = MONTH_NAMES_SHORT[sM] || '';

  // Check Day Number + Month Name (e.g. "22 September", "22nd Sep", "September 22", "Tue 22 Sep")
  const dayRegex = new RegExp(`\\b0?${sD}(?:st|nd|rd|th)?\\b`, 'i');
  const monRegex = new RegExp(`\\b(?:${selMon}|${selMonShort})\\b`, 'i');
  if (dayRegex.test(valStr) && monRegex.test(valStr)) {
    // If a year is explicitly given in the string, make sure it matches sY
    const yrMatch = valStr.match(/\b(19\d\d|20\d\d)\b/);
    if (!yrMatch || parseInt(yrMatch[1], 10) === sY) {
      return true;
    }
  }

  // Check numeric day-month pattern (e.g. "22/09", "22-09", "22/9")
  const numRegex = new RegExp(`\\b0?${sD}[/-]0?${sM}(?:[/-]${sY})?\\b`);
  if (numRegex.test(valStr)) {
    return true;
  }

  // Check weekday name when weekday is explicitly stated (e.g. "Tuesday", "Tuesday Evening")
  const weekdayRegex = new RegExp(`\\b(?:${selWeekday}|${selWeekdayShort})\\b`, 'i');
  if (weekdayRegex.test(valStr)) {
    // If the cell contains other explicit day numbers (e.g. "Wednesday 23 Sep"),
    // verify it doesn't solely belong to another day
    const otherDays = valStr.match(/\b([0-3]?\d)(?:st|nd|rd|th)?\b/g);
    if (otherDays) {
      const numbers = otherDays.map((n) => parseInt(n, 10)).filter((n) => n >= 1 && n <= 31);
      if (numbers.length > 0 && !numbers.includes(sD)) {
        return false;
      }
    }
    return true;
  }

  // If a date was parsed from the string and it differed from selectedDate:
  if (parsedDate && parsedDate !== selectedDate) {
    return false;
  }

  // Check if string contains another recognizable calendar day of the same month
  for (let d = 1; d <= 31; d++) {
    if (d !== sD) {
      const otherDayRegex = new RegExp(`\\b0?${d}(?:st|nd|rd|th)?\\b`, 'i');
      if (otherDayRegex.test(valStr) && monRegex.test(valStr)) {
        return false;
      }
    }
  }

  // Check if string contains another weekday (e.g. "Wednesday" when selected is Tuesday)
  for (let w = 0; w < WEEKDAY_NAMES.length; w++) {
    if (w !== dayOfWeekIdx) {
      const otherWkRegex = new RegExp(`\\b(?:${WEEKDAY_NAMES[w]}|${WEEKDAY_NAMES_SHORT[w]})\\b`, 'i');
      if (otherWkRegex.test(valStr) && !weekdayRegex.test(valStr)) {
        return false;
      }
    }
  }

  // If parsedDate was null and couldn't match or exclude, give benefit of doubt
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

  // Check if both AM and PM columns exist in the row FIRST
  const amCol = findColumn(headers, ['am service type', 'am service', 'am serving']);
  const pmCol = findColumn(headers, ['pm service type', 'pm service', 'pm serving']);
  if (amCol && pmCol) {
    const isNegative = (s: unknown) => {
      const l = lower(clean(s));
      return !l || l === 'no' || l === 'n' || l.startsWith('no ') || l === 'none' || l === 'n/a' || l === 'na' || l === '-' || l.includes('not attending');
    };
    const hasAm = !isNegative(row[amCol]);
    const hasPm = !isNegative(row[pmCol]);
    if (selectedPeriod === 'AM' && !hasAm && hasPm) return false;
    if (selectedPeriod === 'PM' && !hasPm && hasAm) return false;
  }

  // Check row service column for AM / PM indicators
  const candidatePatterns = selectedPeriod === 'PM'
    ? [
        'pm service type',
        'pm service',
        'pm serving',
        'which service are you attending',
        'service attending',
        'service type',
        'servicetype',
      ]
    : [
        'am service type',
        'am service',
        'am serving',
        'which service are you attending',
        'service attending',
        'service type',
        'servicetype',
      ];

  const serviceCol =
    findColumn(headers, candidatePatterns) ||
    headers.find((h) => {
      const lh = lower(clean(h));
      return (lh === 'service' || lh.startsWith('service ')) && !lh.includes('date');
    });

  if (serviceCol) {
    const colNameLower = lower(clean(serviceCol));
    if (colNameLower.includes('pm') && !colNameLower.includes('am') && selectedPeriod === 'AM') {
      return false;
    }
    if (colNameLower.includes('am') && !colNameLower.includes('pm') && selectedPeriod === 'PM') {
      return false;
    }

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

  // 2. Must contain at least one expected passenger identity column (Name, Surname, Full Name, etc.)
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
  homecellLeader?: string;
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

  // Pass 1: Filter candidates down to those matching the admin-chosen date (opts.selectedDate).
  // In events like DreamWeek, rows for different dates are NOT duplicates of each other;
  // each date is distinct.
  const submissionsForSelectedDate: RawCandidate[] = [];
  let otherDatesCount = 0;

  for (const sub of rawSubmissions) {
    if (!sub.matchesDate) {
      otherDatesCount++;
      skipped++;
      continue;
    }
    // Scope to the selected AM/PM period BEFORE de-duplicating. Otherwise a person
    // who RSVP'd for both AM and PM on the same date has their older PM signup
    // superseded by a newer AM row, which is then dropped by the service filter,
    // silently losing the PM passenger (e.g. Gate 4 Normal on 23 Aug 2026).
    if (!matchesService(sub.row, sub.headers, opts.selectedService, sub.sheetName)) {
      skipped++;
      continue;
    }
    submissionsForSelectedDate.push(sub);
  }

  // Pass 2: For submissions matching the selected date, group by person.
  // If a person submitted more than once FOR THIS SAME DATE (e.g. updated stop/phone),
  // their most recent submission for this date takes precedence.
  // If two people share the same name but have different phone numbers, both are preserved!
  const personGroups = new Map<string, RawCandidate[]>();
  for (const sub of submissionsForSelectedDate) {
    const phoneKey = sanitizePhone(sub.phone);
    const dedupeKey = phoneKey
      ? `${sub.normalizedName}__${phoneKey}`
      : (sub.userEmail ? `${sub.normalizedName}__${sub.userEmail.toLowerCase().trim()}` : sub.normalizedName);
    const group = personGroups.get(dedupeKey);
    if (!group) {
      personGroups.set(dedupeKey, [sub]);
    } else {
      group.push(sub);
    }
  }

  const dateMatchedCandidates: RawCandidate[] = [];

  for (const [, submissions] of personGroups) {
    // Sort submissions for this person on this date by timestamp descending (or row index descending if equal)
    submissions.sort((a, b) => {
      if (b.timestampEpoch !== a.timestampEpoch) {
        return b.timestampEpoch - a.timestampEpoch;
      }
      return b.rowIndex - a.rowIndex;
    });

    // The most recent submission for this date takes 100% precedence
    const mostRecent = submissions[0];

    // Older duplicate submissions for this person on this same date are superseded
    if (submissions.length > 1) {
      skipped += (submissions.length - 1);
    }

    // Now evaluate transport requirement
    if (!mostRecent.wantsTransport) {
      skipped++;
      continue;
    }
    matchedTransport++;
    matchedDate++;

    dateMatchedCandidates.push(mostRecent);
  }

  if (otherDatesCount > 0) {
    warnings.push(`Notice: ${otherDatesCount} row(s) in sheet belong to other dates and were filtered out for ${opts.selectedDate}.`);
  }

  // Count categories among valid date-matched submissions
  const ushersCount = dateMatchedCandidates.filter((c) => c.category === 'Ushers').length;
  const normalCount = dateMatchedCandidates.filter((c) => c.category === 'Normal').length;

  const selectedService = opts.selectedService;
  const passengers: Passenger[] = [];

  // Pass 3: Filter and apply auto-merging logic based on selectedService
  for (const c of dateMatchedCandidates) {
    if (!matchesService(c.row, c.headers, opts.selectedService, c.sheetName)) {
      continue;
    }

    let include = false;

    if (selectedService === 'PM_Serving') {
      // Dedicated PM Serving service (Serving & Ushers)
      include = c.category === 'Serving' || c.category === 'Ushers';
    } else if (selectedService === 'PM_Normal') {
      // Dedicated PM Normal transport service
      include = c.category === 'Normal';
    } else if (selectedService === 'AM_Ushers') {
      // Dedicated Ushers (Early) service
      include = c.category === 'Ushers';
    } else if (selectedService === 'AM_Normal') {
      // Dedicated AM Normal transport service
      include = c.category === 'Normal';
    } else if (selectedService === 'AM_Serving') {
      // AM Serving main service
      if (c.category === 'Serving') {
        include = true;
      } else if (c.category === 'Ushers') {
        // Auto-merge into AM Serving if not enough for a dedicated Ushers taxi (< 15)
        include = ushersCount < MIN_TAXI_THRESHOLD;
      } else if (c.category === 'Normal') {
        // Auto-merge into AM Serving if not enough for a normal taxi (< 14)
        include = normalCount < MIN_AM_NORMAL_THRESHOLD;
      }
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
        homecellLeader: c.homecellLeader,
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

    if (normalCount > 0 && normalCount < MIN_AM_NORMAL_THRESHOLD) {
      warnings.push(`Auto-Included: ${normalCount} AM Normal signups merged into AM Serving (${normalCount} < ${MIN_AM_NORMAL_THRESHOLD} minimum for a taxi).`);
    } else if (normalCount >= MIN_AM_NORMAL_THRESHOLD) {
      warnings.push(`Notice: ${normalCount} AM Normal signups detected. Available under "AM Service — Normal Only".`);
    }
  } else if (selectedService === 'AM_Ushers') {
    if (ushersCount > 0 && ushersCount < MIN_TAXI_THRESHOLD) {
      warnings.push(`Note: ${ushersCount} Ushers (Early) signups (< ${MIN_TAXI_THRESHOLD} taxi minimum). In "AM Service — Serving Only", these will automatically merge with AM Serving.`);
    } else if (ushersCount >= MIN_TAXI_THRESHOLD) {
      warnings.push(`✓ ${ushersCount} Ushers (Early) signups available — enough for a dedicated taxi (${Math.floor(ushersCount / 15)} taxi(s)).`);
    }
  } else if (selectedService === 'AM_Normal') {
    if (normalCount > 0 && normalCount < MIN_AM_NORMAL_THRESHOLD) {
      warnings.push(`Note: ${normalCount} AM Normal signups (< ${MIN_AM_NORMAL_THRESHOLD} taxi minimum). In "AM Service — Serving Only", these will automatically merge with AM Serving.`);
    } else if (normalCount >= MIN_AM_NORMAL_THRESHOLD) {
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
export function parseWorkbook(file: ArrayBuffer | Uint8Array | string, opts: ParseOptions): ParseResult {
  const readType = typeof file === 'string' ? 'string' : 'array';
  const wb = XLSX.read(file, { type: readType, cellDates: true });
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
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;

    const rawRows = XLSX.utils.sheet_to_json<RawRow>(sheet, { defval: '' });
    if (rawRows.length === 0) {
      skippedSheets.push(sheetName);
      continue;
    }

    const headers = Object.keys(rawRows[0]);
    // Validate sheet has at least one expected passenger identity column
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
      const { category, ministry } = extractCategoryAndMinistry(row, headers, sheetName, opts.selectedService);
      const memberType = extractMemberType(row, headers, structure);
      const homecellLeader = extractHomecellLeader(row, headers);
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
        homecellLeader,
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
  file: ArrayBuffer | Uint8Array | string,
  opts: ParseOptions,
  onProgress?: ParseProgressCallback
): Promise<ParseResult> {
  const readType = typeof file === 'string' ? 'string' : 'array';
  const wb = XLSX.read(file, { type: readType, cellDates: true });
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

    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;

    const rawRows = XLSX.utils.sheet_to_json<RawRow>(sheet, { defval: '' });
    if (rawRows.length === 0) {
      skippedSheets.push(sheetName);
      continue;
    }

    const headers = Object.keys(rawRows[0]);
    // Validate sheet has at least one expected passenger identity column
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
      const { category, ministry } = extractCategoryAndMinistry(row, headers, sheetName, opts.selectedService);
      const memberType = extractMemberType(row, headers, structure);
      const homecellLeader = extractHomecellLeader(row, headers);
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
        homecellLeader,
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
