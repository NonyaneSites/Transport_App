import type { Passenger } from './types';
import { hubDisplayName } from './types';
import { sanitizeTransportValue } from './transportSanitization';

export interface RawSheetRow {
  [key: string]: string | number | boolean | null | undefined;
}

/**
 * Normalizes text for passenger duplicate matching:
 * - Converts to lowercase
 * - Trims leading and trailing whitespace
 * - Collapses repeated whitespace into a single space
 * - Strips punctuation and symbols (retaining letters, numbers, and spaces)
 */
export function normalizePassengerText(str?: string | null): string {
  if (!str) return '';
  return str
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // remove accent diacritics
    .replace(/[^\p{L}\p{N}\s]/gu, '') // strip punctuation / symbols
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Robust duplicate check for passengers:
 * Returns true if EITHER:
 * 1. Their `id` strings match exactly (non-empty), OR
 * 2. Their normalized `fullName` matches.
 */
export function isSamePassenger(
  a: Pick<Passenger, 'id' | 'fullName' | 'stop'>,
  b: Pick<Passenger, 'id' | 'fullName' | 'stop'>
): boolean {
  if (!a || !b) return false;

  // 1. Exact ID match
  if (a.id && b.id && a.id.trim() === b.id.trim()) {
    return true;
  }

  // 2. Normalized fullName match
  const aName = normalizePassengerText(a.fullName);
  const bName = normalizePassengerText(b.fullName);

  return Boolean(aName && bName && aName === bName);
}

/**
 * Computes an epoch timestamp in milliseconds for reliable chronological comparison of signups.
 * Handles Date instances, ISO strings, Microsoft Forms timestamps (e.g. "8/28/2026 14:38:37"),
 * Excel serial numbers, and falls back to row index.
 */
export function getSubmissionTimestampEpoch(raw?: unknown, fallbackIndex: number = 0): number {
  if (!raw && raw !== 0) return fallbackIndex;
  if (raw instanceof Date && !isNaN(raw.getTime())) {
    return raw.getTime();
  }
  const str = String(raw).trim();
  if (!str) return fallbackIndex;

  // Standard Date parse
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    return parsed.getTime();
  }

  // Custom regex parsing for M/D/YYYY or D/M/YYYY with time
  const match = str.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?(?:\s*(am|pm))?/i);
  if (match) {
    const partA = parseInt(match[1], 10);
    const partB = parseInt(match[2], 10);
    let y = parseInt(match[3], 10);
    if (y < 100) y += 2000;
    let hh = match[4] ? parseInt(match[4], 10) : 0;
    const mm = match[5] ? parseInt(match[5], 10) : 0;
    const ss = match[6] ? parseInt(match[6], 10) : 0;
    const ampm = match[7] ? match[7].toLowerCase() : '';
    if (ampm === 'pm' && hh < 12) hh += 12;
    if (ampm === 'am' && hh === 12) hh = 0;

    let m = partA;
    let d = partB;
    // If first number > 12, it's definitely Day/Month
    if (partA > 12) {
      d = partA;
      m = partB;
    }
    const dt = new Date(y, m - 1, d, hh, mm, ss);
    if (!isNaN(dt.getTime())) {
      return dt.getTime();
    }
  }

  return fallbackIndex;
}

/**
 * Converts strings to Title Case (e.g. "john doe" -> "John Doe", "SIPHO DLAMINI" -> "Sipho Dlamini")
 */
export function toTitleCase(str: string): string {
  const cleaned = sanitizeTransportValue(str).trim();
  if (!cleaned) return '';
  
  // If it's already mixed case with intentional formatting, or standard title-case, handle each word
  return cleaned
    .toLowerCase()
    .split(/(\s+|-)/)
    .map((word) => {
      if (!word || /^\s+$/.test(word) || word === '-') return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join('');
}

/**
 * Sanitizes phone numbers while strictly preserving leading '+' or '0'
 */
export function sanitizePhone(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const str = String(raw).trim();
  if (!str) return undefined;

  const hasPlus = str.startsWith('+');
  const hasLeadingZero = !hasPlus && str.startsWith('0');

  // Strip all non-digit characters except leading plus
  const digitsOnly = str.replace(/\D/g, '');
  if (!digitsOnly) return undefined;

  if (hasPlus) {
    return `+${digitsOnly}`;
  }
  if (hasLeadingZero && !digitsOnly.startsWith('0')) {
    return `0${digitsOnly}`;
  }
  return digitsOnly;
}

/**
 * Standardizes timestamp strings into ISO 8601 strings
 */
export function parseTimestampToISO(raw: unknown): string | undefined {
  if (!raw) return undefined;
  try {
    const d = new Date(String(raw).trim());
    if (!isNaN(d.getTime())) {
      return d.toISOString();
    }
  } catch {
    // Fallback: return trimmed string
  }
  return String(raw).trim() || undefined;
}

/**
 * Normalizes service responses from Google Sheets / MS Forms into standard ServiceType codes
 * (e.g. AM_Normal, PM_Normal, AM_Serving, PM_Serving, AM_Mega, PM_Mega)
 */
export function normalizeService(raw: string, defaultService?: string): string {
  const s = raw.toLowerCase().trim();
  if (!s && defaultService) return defaultService;

  const isAM = s.includes('am') || s.includes('morning') || s.includes('08:') || s.includes('09:') || s.includes('10:');
  const isPM = s.includes('pm') || s.includes('evening') || s.includes('afternoon') || s.includes('17:') || s.includes('18:');

  const isUshers = s.includes('usher (early)') || s.includes('ushers (early)') || (s.includes('usher') && s.includes('early'));
  if (isAM && isUshers) return 'AM_Ushers';

  const isServing = s.includes('serving') || s.includes('usher') || s.includes('choir') || s.includes('band') || s.includes('volunteer');
  const isMega = s.includes('mega');

  const period = isAM ? 'AM' : isPM ? 'PM' : (defaultService?.startsWith('AM') ? 'AM' : 'PM');
  const mode = isMega ? 'Mega' : isServing ? 'Serving' : 'Normal';

  return `${period}_${mode}`;
}

/**
 * Ingests and parses sign-up responses from the 2026 Google Sheet / Microsoft Form format.
 * Matches incoming sheet columns dynamically using flexible string matching and regex.
 */
export function parseGoogleSheetSignups(
  rows: RawSheetRow[],
  defaultService: string = 'PM_Normal'
): Passenger[] {
  const AREA_COLUMNS = [
    { areaKeywords: ['braam stops', 'braam'], colPatterns: ['braam stops', 'braam stop', 'braam'] },
    { areaKeywords: ['auckland park stops', 'auckland park', 'auckland'], colPatterns: ['auckland park', 'auckland'] },
    { areaKeywords: ['cbd stops', 'cbd'], colPatterns: ['cbd stops', 'cbd'] },
    { areaKeywords: ['parktown stops', 'parktown'], colPatterns: ['parktown stops', 'parktown'] },
    { areaKeywords: ['midrand stops', 'midrand'], colPatterns: ['midrand stops', 'midrand'] },
    { areaKeywords: ['soweto stops', 'soweto'], colPatterns: ['soweto stops', 'soweto'] },
    { areaKeywords: ['jhb north & west', 'jhb north and west', 'jhb west & north', 'jhb west and north', 'jhb'], colPatterns: ['jhb north & west', 'jhb west & north', 'jhb north and west', 'jhb west and north', 'jhb'] },
  ];

  const rawParsedList = rows
    .map((row, index) => {
      // Find column values using flexible case-insensitive header matching
      const findValue = (keywords: string[]): string => {
        const rowKeys = Object.keys(row);
        for (const kw of keywords) {
          const lowerKw = kw.toLowerCase().trim();
          // 1. Exact match
          const exactKey = rowKeys.find((k) => k.toLowerCase().trim() === lowerKw);
          if (exactKey && row[exactKey] !== undefined && row[exactKey] !== null) {
            return String(row[exactKey]).trim();
          }
          // 2. Contains match
          const matchedKey = rowKeys.find((k) => k.toLowerCase().includes(lowerKw));
          if (matchedKey && row[matchedKey] !== undefined && row[matchedKey] !== null) {
            return String(row[matchedKey]).trim();
          }
        }
        return '';
      };

      // Full Name extraction with name + surname merging
      const surname = findValue(['Surname', 'Last Name', 'Lastname', 'Family Name']);
      const name = findValue(['Name', 'First Name', 'Firstname', 'Name1', 'Name 1', 'Name2', 'Name 2', 'Passenger Name', 'Full Name']);
      
      let rawFullName = '';
      if (name && surname) {
        const normName = name.toLowerCase().trim();
        const normSurname = surname.toLowerCase().trim();
        if (normName === normSurname || normName.endsWith(normSurname) || normName.includes(normSurname)) {
          rawFullName = name;
        } else {
          rawFullName = `${name} ${surname}`;
        }
      } else {
        rawFullName = name || surname;
      }

      const fullName = toTitleCase(rawFullName);

      // Stop extraction: check area stops and specific area stop columns
      const areaValue = findValue(['Area Stops2', 'Area Stops 2', 'Area Stops', 'Area']).toLowerCase();
      let rawStop = '';

      if (areaValue) {
        for (const mapping of AREA_COLUMNS) {
          if (mapping.areaKeywords.some((ak) => areaValue.includes(ak) || ak.includes(areaValue))) {
            const stopVal = findValue(mapping.colPatterns);
            if (stopVal && !stopVal.toLowerCase().includes('area stops') && stopVal.toLowerCase() !== areaValue) {
              rawStop = stopVal;
              break;
            }
          }
        }
      }

      if (!rawStop) {
        for (const mapping of AREA_COLUMNS) {
          const stopVal = findValue(mapping.colPatterns);
          if (stopVal && !stopVal.toLowerCase().includes('area stops') && stopVal.toLowerCase() !== areaValue) {
            rawStop = stopVal;
            break;
          }
        }
      }

      if (!rawStop) {
        const directStop = findValue([
          'Pickup Stop',
          'Boarding Location',
          'Sub-Stop',
          'Sub Stop',
          'Where will you join',
          'Pickup Location',
          'Specific Stop',
          'Station',
        ]);
        if (directStop && !directStop.toLowerCase().includes('area stops')) {
          rawStop = directStop;
        }
      }

      // Structure extraction (S20, S3, S7, S9, S2, etc.)
      let rawStructure = findValue([
        'SZ1 Structures',
        'SZ1 Structure',
        'SZ1',
        'SZ2 Structures',
        'SZ2 Structure',
        'SZ2',
        'YZ Structures',
        'YZ Structure',
        'YZ',
        'Structure',
        'Assembly Structure',
        'Home Structure',
        'PCF Structure',
      ]);

      if (rawStructure && rawStructure.toLowerCase().startsWith('zone ')) {
        rawStructure = '';
      }

      if (!rawStructure) {
        const zoneVal = findValue(['Zone / Structure', 'Zone']);
        rawStructure = zoneVal;
      }

      const structure = sanitizeTransportValue(rawStructure).toUpperCase();

      // Scan all cells against known stop signatures if rawStop is still empty
      if (!rawStop) {
        const KNOWN_STOP_SIGNATURES: { pattern: RegExp; canonical: string }[] = [
          { pattern: /campus central.*(empire|on empire)/i, canonical: 'Campus Central (Empire)' },
          { pattern: /campus central.*empire/i, canonical: 'Campus Central (Empire)' },
          { pattern: /\bempire\b/i, canonical: 'Campus Central (Empire)' },
          { pattern: /campus central.*eoh/i, canonical: 'Campus Central - EOH' },
          { pattern: /eoh.*campus central/i, canonical: 'Campus Central - EOH' },
          { pattern: /\beoh\b/i, canonical: 'Campus Central - EOH' },
          { pattern: /charlotte maxeke|charlotte/i, canonical: 'Charlotte Maxeke' },
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
          { pattern: /apk mcdonald/i, canonical: "APK McDonald's" },
          { pattern: /\bgate 7\b/i, canonical: 'Gate 7' },
          { pattern: /\bgate 2\b/i, canonical: 'Gate 2' },
          { pattern: /\bgate 4\b/i, canonical: 'Gate 4' },
          { pattern: /laborie/i, canonical: 'Laborie' },
          { pattern: /richmond/i, canonical: 'Richmond' },
          { pattern: /uj bunting|bunting/i, canonical: 'UJ Bunting' },
          { pattern: /westdene engen/i, canonical: 'Westdene Engen' },
          { pattern: /westdene/i, canonical: 'Westdene' },
          { pattern: /dfc bus stop|\bdfc\b/i, canonical: 'DFC bus stop' },
          { pattern: /focus 1|focus 2|\bfocus\b/i, canonical: 'Focus 1' },
          { pattern: /ghandi|gandhi/i, canonical: 'Ghandi square' },
          { pattern: /saratoga/i, canonical: 'Saratoga' },
          { pattern: /the fields|\bfields\b/i, canonical: 'The Fields' },
          { pattern: /urban circle/i, canonical: 'Urban Circle' },
          { pattern: /maboneng/i, canonical: 'Maboneng' },
          { pattern: /gateway/i, canonical: 'Gateway' },
          { pattern: /\bargyle\b/i, canonical: 'Argyle' },
          { pattern: /\barteria\b/i, canonical: 'Arteria' },
          { pattern: /education campus/i, canonical: 'Education Campus' },
          { pattern: /\bjunction\b/i, canonical: 'Junction' },
          { pattern: /\bknockando\b/i, canonical: 'Knockando' },
          { pattern: /stanley ave|\bstanley\b/i, canonical: 'Stanley Ave' },
          { pattern: /\byale\b/i, canonical: 'Yale' },
          { pattern: /randburg|surrey square/i, canonical: 'Randburg Surrey Square' },
          { pattern: /midrand/i, canonical: 'Midrand' },
          { pattern: /soweto/i, canonical: 'Soweto' },
        ];

        for (const val of Object.values(row)) {
          if (!val) continue;
          const sVal = String(val).trim();
          for (const sig of KNOWN_STOP_SIGNATURES) {
            if (sig.pattern.test(sVal)) {
              rawStop = sig.canonical;
              break;
            }
          }
          if (rawStop) break;
        }
      }

      // Structure inference fallback if stop still empty
      if (!rawStop && structure) {
        if (['S1', 'S19', 'S26'].includes(structure)) rawStop = 'Saratoga';
        else if (['S5', 'S6', 'S15', 'S20', 'YZ', 'YA', 'YOUTH'].includes(structure)) rawStop = '56 Jorissen';
        else if (['S14', 'S18'].includes(structure)) rawStop = 'Gate 2';
        else if (['S2', 'S3', 'S7', 'S8', 'S9', 'S10', 'S11', 'S12', 'S13', 'S16', 'S17', 'S21', 'S25'].includes(structure)) rawStop = 'Junction';
        else if (['S4'].includes(structure)) rawStop = 'Randburg Surrey Square';
      }

      const effectiveStop = sanitizeTransportValue(rawStop) || 'Unassigned Stop';

      // Contact info
      const rawPhone = findValue(['Phone Number', 'WhatsApp Number', 'Contact Number', 'Phone', 'WhatsApp', 'Contact', 'Cell', 'Mobile', 'Cellphone']);
      const phone = sanitizePhone(rawPhone);

      const rawEmail = findValue(['Email Address', 'Email', 'User Email', 'Mail']);
      const userEmail = rawEmail ? sanitizeTransportValue(rawEmail).toLowerCase() : undefined;

      // Timestamp
      const rawTimestamp = findValue(['Completion time', 'Submission Time', 'Timestamp', 'Created At', 'Date Submitted']);
      const timestamp = parseTimestampToISO(rawTimestamp);

      // Service
      const rawService = findValue([
        'Which service are you attending?',
        'Service',
        'Attending',
        'AM Service Type',
        'PM Service Type',
        'Service Type',
      ]);
      const service = normalizeService(rawService, defaultService);

      // Ministry & Category
      const rawMinistry = findValue(['Serving Ministry', 'Serving', 'Ministry']);
      let category: 'Ushers' | 'Serving' | 'Normal' = 'Normal';
      const sLower = rawService.toLowerCase();
      const mLower = rawMinistry.toLowerCase();
      if (
        sLower.includes('usher (early)') ||
        sLower.includes('ushers (early)') ||
        (sLower.includes('usher') && sLower.includes('early'))
      ) {
        category = 'Ushers';
      } else if (
        sLower.includes('serving') ||
        mLower.includes('usher') ||
        mLower.includes('serving') ||
        Boolean(rawMinistry)
      ) {
        category = 'Serving';
      }

      // Hub derivation
      const explicitHub = findValue(['Hub', 'Master Hub', 'Taxi Hub']);
      const hub = explicitHub
        ? sanitizeTransportValue(explicitHub)
        : hubDisplayName('Taxi', effectiveStop);

      // Member / Visitor / FTV detection
      const rawMemberCol = findValue([
        'Are you a member or visitor',
        'Are you a member or a visitor',
        'Member or Visitor',
        'Member / Visitor',
        'Member/Visitor',
        'Membership Status',
        'Are you a member',
        'Member, visitor or first time visitor',
        'Visitor or Member',
        'Visitor / Member',
        'Visitor Status',
        'Member Status',
        'Membership',
        'Category of attendee',
        'Attendee Type',
        'Visitor',
        'First Time Visitor',
      ]);
      let memberType: 'M' | 'V' | 'FTV' | undefined = undefined;
      const structUpper = (structure || '').toUpperCase();
      if (structUpper.includes('FTV') || structUpper.includes('FIRST TIME')) {
        memberType = 'FTV';
      } else if (structUpper.includes('VISITOR')) {
        memberType = 'V';
      } else if (rawMemberCol) {
        const val = rawMemberCol.toLowerCase().trim();
        if (val.includes('first') || val.includes('ftv') || val.includes('1st') || val.includes('new')) {
          memberType = 'FTV';
        } else if (val.includes('visitor') || val.includes('visiting') || val.includes('guest') || val === 'v') {
          memberType = 'V';
        } else if (val.includes('member') || val === 'm') {
          memberType = 'M';
        }
      }

      const id = `p-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 6)}`;

      return {
        id,
        fullName: fullName || 'Unnamed Passenger',
        stop: effectiveStop,
        structure: structure || '',
        phone,
        userEmail,
        timestamp,
        hub,
        service,
        category,
        ministry: rawMinistry || (category === 'Ushers' ? 'Usher (Early)' : undefined),
        memberType,
        assignedTo: null,
        present: false,
        cancellationFeeOwed: false,
      };
    })
    .filter((p) => p.fullName !== 'Unnamed Passenger' || p.stop !== 'Unspecified');

  // Deduplicate signups by person: if someone signed up twice, take account of their most recent signup
  const personMap = new Map<string, { passenger: Passenger; epoch: number; index: number }>();

  rawParsedList.forEach((p, idx) => {
    const key = normalizePassengerText(p.fullName);
    if (!key) return;

    const epoch = getSubmissionTimestampEpoch(p.timestamp, idx);
    const existing = personMap.get(key);

    if (!existing) {
      personMap.set(key, { passenger: p, epoch, index: idx });
    } else {
      // Compare chronological precedence: higher epoch (or higher row index) wins
      if (epoch > existing.epoch || (epoch === existing.epoch && idx > existing.index)) {
        personMap.set(key, { passenger: p, epoch, index: idx });
      }
    }
  });

  return Array.from(personMap.values()).map((item) => item.passenger);
}
