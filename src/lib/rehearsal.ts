import type { Passenger, Vehicle } from './types';
import { normalizePassengerText } from './importer';
import { naturalCompare } from './sort';
import { isDreamWeekDate, DREAMWEEK_FARE } from './types';
import { supabase } from './supabase';

export type RehearsalLegs = 'both' | 'going' | 'return';

export type RehearsalStatus =
  | 'included'
  | 'intercession_excluded'
  | 'private_excluded';

export interface RehearsalAnswerRule {
  id: string;
  label: string;
  /** Primary keyword substring (case-insensitive) to match */
  contains: string[];
  /** Optional secondary condition or exclusion keyword */
  excludes?: string[];
  status: RehearsalStatus;
  legs?: RehearsalLegs;
  fare?: number;
  note?: string;
}

/**
 * Single, easy-to-edit lookup table for mapping "Do you need Thursday Transport"
 * answers using case-insensitive contains logic.
 */
export const REHEARSAL_ANSWER_RULES: RehearsalAnswerRule[] = [
  // 1. Private transport exclusions
  {
    id: 'private_transport',
    label: 'Private transport',
    contains: ['private'],
    status: 'private_excluded',
  },
  {
    id: 'no_answer',
    label: 'No (General)',
    contains: ['no (', 'no transport'],
    status: 'private_excluded',
  },

  // 2. Combo: Going with Intercession, Returning with Rehearsal
  {
    id: 'intercession_going_rehearsal_return',
    label: 'Intercession going, Rehearsal return',
    contains: ['intercession', 'return'],
    excludes: ['return with intercession', 'returning with intercession', 'return only with intercession'],
    status: 'included',
    legs: 'return',
    fare: 40,
    note: 'Intercession going',
  },

  // 3. Intercession-only taxis (Excluded from Rehearsal manifest by default)
  {
    id: 'intercession_both',
    label: 'Going & Return with Intercession taxi',
    contains: ['intercession'],
    status: 'intercession_excluded',
  },

  // 4. Rehearsal Going & Return (Both) -> R70
  {
    id: 'rehearsal_both',
    label: 'Going and Return (Both)',
    contains: ['going and return', 'both'],
    status: 'included',
    legs: 'both',
    fare: 70,
  },

  // 5. Rehearsal Going only -> R40
  {
    id: 'rehearsal_going',
    label: 'Going only',
    contains: ['going'],
    status: 'included',
    legs: 'going',
    fare: 40,
  },

  // 6. Rehearsal Return only -> R40
  {
    id: 'rehearsal_return',
    label: 'Return only',
    contains: ['return'],
    status: 'included',
    legs: 'return',
    fare: 40,
  },
];

export interface EvaluatedTransportAnswer {
  status: RehearsalStatus;
  legs?: RehearsalLegs;
  fare: number;
  note?: string;
  matchedRuleId: string;
}

/**
 * Evaluates a "Do you need Thursday Transport" answer and stop text
 * to determine legs, fare, and whether the respondent is included or excluded.
 */
export function evaluateRehearsalTransportAnswer(
  rawAnswer?: string | null,
  rawStop?: string | null,
  dateStr?: string | null
): EvaluatedTransportAnswer {
  const ans = (rawAnswer || '').trim().toLowerCase();
  const stop = (rawStop || '').trim().toLowerCase();

  // If Stop says "using private transport" or answer says private
  if (stop.includes('private transport') || stop === 'private') {
    return {
      status: 'private_excluded',
      fare: 0,
      matchedRuleId: 'private_stop',
    };
  }

  // Exact or general "no"
  if (ans === 'no' || ans.startsWith('no ') || ans.includes('private')) {
    return {
      status: 'private_excluded',
      fare: 0,
      matchedRuleId: 'private_transport',
    };
  }

  // Special check: Going with Intercession taxi, Returning with Rehearsal taxi
  if (
    ans.includes('intercession') &&
    (ans.includes('returning with rehearsal') || ans.includes('return with rehearsal') || (ans.includes('going with intercession') && ans.includes('rehearsal')))
  ) {
    const isDW = isDreamWeekDate(dateStr);
    return {
      status: 'included',
      legs: 'return',
      fare: isDW ? DREAMWEEK_FARE : 40,
      note: 'Intercession going',
      matchedRuleId: 'intercession_going_rehearsal_return',
    };
  }

  // Check pure intercession responses
  if (ans.includes('intercession')) {
    return {
      status: 'intercession_excluded',
      fare: 0,
      matchedRuleId: 'intercession_both',
    };
  }

  // Check going and return (both)
  if (ans.includes('going and return') || ans.includes('both')) {
    const isDW = isDreamWeekDate(dateStr);
    return {
      status: 'included',
      legs: 'both',
      fare: isDW ? DREAMWEEK_FARE : 70,
      matchedRuleId: 'rehearsal_both',
    };
  }

  // Check going only
  if (ans.includes('going')) {
    const isDW = isDreamWeekDate(dateStr);
    return {
      status: 'included',
      legs: 'going',
      fare: isDW ? DREAMWEEK_FARE : 40,
      matchedRuleId: 'rehearsal_going',
    };
  }

  // Check return only
  if (ans.includes('return') || ans.includes('returning')) {
    const isDW = isDreamWeekDate(dateStr);
    return {
      status: 'included',
      legs: 'return',
      fare: isDW ? DREAMWEEK_FARE : 40,
      matchedRuleId: 'rehearsal_return',
    };
  }

  // Default fallback: assume both legs if they said "yes" or filled transport
  if (ans.includes('yes') || ans.length > 0) {
    const isDW = isDreamWeekDate(dateStr);
    return {
      status: 'included',
      legs: 'both',
      fare: isDW ? DREAMWEEK_FARE : 70,
      matchedRuleId: 'fallback_yes_both',
    };
  }

  return {
    status: 'private_excluded',
    fare: 0,
    matchedRuleId: 'unknown_empty',
  };
}

/** Canonical list of known Thursday rehearsal stops */
export const CANONICAL_REHEARSAL_STOPS: string[] = [
  'Braam',
  'Richmond',
  'EOH',
  'Yale',
  'Wits Gate 7',
  'Junction',
  'Arteria',
  'Stanley Ave',
  'Westdene Engine',
  'Saratoga',
  'Argyle',
  'Urban Circle',
  'Apk McDonalds',
  'DFC Bus Stop',
  'UJ Gate 2',
  'Ghandi Square',
  'Maboneng',
  'Laborie',
  'Focus 1',
  'Education Campus',
  'Knockando',
  'UJ Bunting',
  'Charlotte Maxeke',
];

/** Stop aliases mapped to canonical names */
const STOP_ALIAS_MAP: Record<string, string> = {
  // Gate 2
  'gate 2': 'UJ Gate 2',
  'uj gate 2': 'UJ Gate 2',
  'uj gate2': 'UJ Gate 2',
  'gate2': 'UJ Gate 2',
  // Gate 7
  'gate 7': 'Wits Gate 7',
  'wits gate 7': 'Wits Gate 7',
  'wits gate7': 'Wits Gate 7',
  'amic deck': 'Wits Gate 7',
  'barnato': 'Wits Gate 7',
  // Westdene
  'westdene': 'Westdene Engine',
  'westdene engine': 'Westdene Engine',
  'westdene engen': 'Westdene Engine',
  'westdene engin': 'Westdene Engine',
  // Stanley
  'stanley': 'Stanley Ave',
  'stanley ave': 'Stanley Ave',
  'stanley avenue': 'Stanley Ave',
  // Apk McDonalds
  'mcdonalds': 'Apk McDonalds',
  'apk mcdonalds': 'Apk McDonalds',
  'apk mcdonald': 'Apk McDonalds',
  "apk mcdonald's": 'Apk McDonalds',
  // DFC
  'dfc': 'DFC Bus Stop',
  'dfc bus stop': 'DFC Bus Stop',
  'dfc bus': 'DFC Bus Stop',
  // UJ Bunting
  'bunting': 'UJ Bunting',
  'uj bunting': 'UJ Bunting',
  // EOH
  'eoh': 'EOH',
  'campus central - eoh': 'EOH',
  'campus central': 'EOH',
  'eoh campus central': 'EOH',
  // Ghandi Square
  'ghandi square': 'Ghandi Square',
  'gandhi square': 'Ghandi Square',
  'gandhi': 'Ghandi Square',
  'ghandi': 'Ghandi Square',
  // Education Campus
  'education campus': 'Education Campus',
  'ed campus': 'Education Campus',
  'wits education campus': 'Education Campus',
  // Braam
  'braam': 'Braam',
  '56 jorissen': 'Braam',
  'student digzz': 'Braam',
  'amani': 'Braam',
  'apex': 'Braam',
  'ymca': 'Braam',
  // Focus 1
  'focus 1': 'Focus 1',
  'focus1': 'Focus 1',
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalizes a stop name against known canonical stops and aliases using whole-word/exact matching.
 * Unknown stops are trimmed and preserved with isUnknown: true.
 */
export function normalizeRehearsalStop(rawStop?: string | null): { stop: string; isUnknown: boolean } {
  const trimmed = (rawStop || '').trim();
  if (!trimmed) {
    return { stop: 'Unspecified', isUnknown: true };
  }

  const lower = trimmed.toLowerCase();

  // 1. Direct alias match
  if (STOP_ALIAS_MAP[lower]) {
    return { stop: STOP_ALIAS_MAP[lower], isUnknown: false };
  }

  // 2. Canonical list exact match (case-insensitive)
  const canonicalMatch = CANONICAL_REHEARSAL_STOPS.find(
    (c) => c.toLowerCase() === lower
  );
  if (canonicalMatch) {
    return { stop: canonicalMatch, isUnknown: false };
  }

  // 3. Whole-word / exact boundary match for known variants (sorted descending by length)
  const sortedAliases = Object.entries(STOP_ALIAS_MAP).sort((a, b) => b[0].length - a[0].length);
  for (const [alias, canonical] of sortedAliases) {
    const pattern = new RegExp(`(^|\\b|\\W)${escapeRegex(alias)}(\\b|\\W|$)`, 'i');
    if (pattern.test(lower)) {
      return { stop: canonical, isUnknown: false };
    }
  }

  // 4. Unknown stop - preserve exact name
  return { stop: trimmed, isUnknown: true };
}

export interface RehearsalFormRow {
  timestamp: string;
  timestampMs: number;
  email: string;
  name: string;
  whatsapp: string;
  dateStr: string;
  normalizedDate: string | null;
  structure: string;
  transportAnswer: string;
  rawStop: string;
  waiver?: string;
  rowIndex: number;
}

export interface ParsedRehearsalRecord {
  id: string;
  passenger: Passenger;
  status: RehearsalStatus;
  legs: RehearsalLegs;
  fare: number;
  note?: string;
  isUnknownStop: boolean;
  timestampMs: number;
  rawDate: string;
}

export interface RehearsalImportSummary {
  date: string;
  totalResponsesForDate: number;
  duplicatesRemoved: number;
  includedCount: number;
  legsBothCount: number;
  legsGoingCount: number;
  legsReturnCount: number;
  excludedPrivateCount: number;
  excludedIntercessionCount: number;
  unknownStopsCount: number;
  unknownStops: string[];
  expectedTotalFare: number;
}

export interface RehearsalParseResult {
  records: ParsedRehearsalRecord[];
  included: ParsedRehearsalRecord[];
  intercessionExcluded: ParsedRehearsalRecord[];
  privateExcluded: ParsedRehearsalRecord[];
  summary: RehearsalImportSummary;
  availableDates: string[];
}

/**
 * Normalizes varied human date inputs into 'YYYY-MM-DD'.
 * Handles: "17 September 2026", "4 June 2026", "06 Aug 26", "2026-09-17", "17/09/2026", "17-Sep-2026", etc.
 */
export function parseRehearsalDateInput(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return null;
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // Numeric Excel date serial
  if (typeof val === 'number' && val > 20000 && val < 80000) {
    const date = new Date(Math.round((val - 25569) * 86400 * 1000));
    if (!isNaN(date.getTime())) {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
  }

  const str = String(val).trim();
  if (!str) return null;

  // ISO "YYYY-MM-DD"
  const isoMatch = str.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (isoMatch) {
    const y = isoMatch[1];
    const m = String(Number(isoMatch[2])).padStart(2, '0');
    const d = String(Number(isoMatch[3])).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  const MONTHS: Record<string, number> = {
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

  // "17 September 2026" or "06 Aug 26" or "4 June 2026"
  const dMonYrMatch = str.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-zA-Z]{3,12})\s+(\d{2,4})\b/i);
  if (dMonYrMatch) {
    const day = Number(dMonYrMatch[1]);
    const monStr = dMonYrMatch[2].toLowerCase();
    const monKey = monStr.slice(0, 3);
    const month = MONTHS[monStr] || MONTHS[monKey];
    let yr = Number(dMonYrMatch[3]);
    if (yr < 100) yr += 2000;
    if (month && day >= 1 && day <= 31) {
      return `${yr}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // "Month D, YYYY" or "Month D YYYY"
  const monDYrMatch = str.match(/\b([a-zA-Z]{3,12})\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?\s+(\d{2,4})\b/i);
  if (monDYrMatch) {
    const monStr = monDYrMatch[1].toLowerCase();
    const monKey = monStr.slice(0, 3);
    const month = MONTHS[monStr] || MONTHS[monKey];
    const day = Number(monDYrMatch[2]);
    let yr = Number(monDYrMatch[3]);
    if (yr < 100) yr += 2000;
    if (month && day >= 1 && day <= 31) {
      return `${yr}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // "DD/MM/YYYY" or "DD-MM-YY"
  const dmyMatch = str.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/);
  if (dmyMatch) {
    const day = Number(dmyMatch[1]);
    const month = Number(dmyMatch[2]);
    let yr = Number(dmyMatch[3]);
    if (yr < 100) yr += 2000;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${yr}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  return null;
}

/** Parses timestamp into milliseconds for sorting */
export function parseTimestampMs(val: unknown, fallbackIndex: number): number {
  if (!val) return fallbackIndex;
  if (val instanceof Date) {
    return isNaN(val.getTime()) ? fallbackIndex : val.getTime();
  }
  if (typeof val === 'number') {
    // Excel serial date timestamp
    if (val > 20000 && val < 80000) {
      return Math.round((val - 25569) * 86400 * 1000);
    }
    return val;
  }
  const str = String(val).trim();
  const parsed = Date.parse(str);
  if (!isNaN(parsed)) return parsed;
  return fallbackIndex;
}

/**
 * Parses raw rows from the Google Form spreadsheet (sheet "Form Responses 2" or any sheet)
 * for a chosen rehearsal date, deduplicating with latest timestamp, evaluating transport answers,
 * and normalizing stops.
 */
/**
 * Generates a deterministic passenger ID based on date and normalized name (no Math.random()).
 */
export function createDeterministicRehearsalPassengerId(dateStr: string, fullName: string): string {
  const normDate = (dateStr || '').replace(/[^0-9]/g, '') || 'date';
  const normName = normalizePassengerText(fullName).toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 24);
  let hash = 0;
  const input = `${normDate}_${normName}`;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash) + input.charCodeAt(i);
    hash |= 0;
  }
  const hex = Math.abs(hash).toString(36);
  return `rehe_${normDate}_${normName || 'rider'}_${hex}`;
}

export function parseRehearsalSheet(
  rawRows: Array<Record<string, unknown>>,
  targetDate: string
): RehearsalParseResult {
  const normTarget = (targetDate || '').trim();

  // Find all available dates across all rows
  const allDatesSet = new Set<string>();
  const allMappedRows: RehearsalFormRow[] = [];

  rawRows.forEach((row, idx) => {
    // Identify columns tolerance
    let timestampVal: unknown = undefined;
    let emailVal = '';
    let nameVal = '';
    let phoneVal = '';
    let dateVal: unknown = undefined;
    let structVal = '';
    let answerVal = '';
    let stopVal = '';
    let waiverVal = '';

    for (const [key, val] of Object.entries(row)) {
      const k = key.trim().toLowerCase();
      if (k.includes('timestamp')) {
        timestampVal = val;
      } else if (k.includes('email')) {
        emailVal = String(val || '').trim();
      } else if (k.includes('name') || k.includes('surname')) {
        nameVal = String(val || '').trim();
      } else if (k.includes('whatsapp') || k.includes('phone') || k.includes('cell')) {
        phoneVal = String(val || '').trim();
      } else if (k === 'date' || k.includes('rehearsal date') || (k.includes('date') && !k.includes('birth'))) {
        dateVal = val;
      } else if (k.includes('structure')) {
        structVal = String(val || '').trim();
      } else if (k.includes('thursday transport') || k.includes('need') || k.includes('transport')) {
        if (!answerVal || k.includes('thursday')) answerVal = String(val || '').trim();
      } else if (k.includes('stop')) {
        stopVal = String(val || '').trim();
      } else if (k.includes('waiver')) {
        waiverVal = String(val || '').trim();
      }
    }

    const normalizedDate = parseRehearsalDateInput(dateVal);
    if (normalizedDate) {
      allDatesSet.add(normalizedDate);
    }

    allMappedRows.push({
      timestamp: String(timestampVal || ''),
      timestampMs: parseTimestampMs(timestampVal, idx),
      email: emailVal,
      name: nameVal,
      whatsapp: phoneVal,
      dateStr: String(dateVal || ''),
      normalizedDate,
      structure: structVal,
      transportAnswer: answerVal,
      rawStop: stopVal,
      waiver: waiverVal,
      rowIndex: idx,
    });
  });

  // Filter rows matching target date
  const dateRows = allMappedRows.filter(
    (r) => r.normalizedDate === normTarget || (r.dateStr && r.dateStr.includes(normTarget))
  );

  // Group by normalized passenger name for deduplication (latest submission by timestamp wins)
  const passengerGroups = new Map<string, RehearsalFormRow[]>();
  dateRows.forEach((row) => {
    const normName = normalizePassengerText(row.name);
    if (!normName) return;
    const existing = passengerGroups.get(normName) || [];
    existing.push(row);
    passengerGroups.set(normName, existing);
  });

  let duplicatesRemoved = 0;
  const deduplicatedRows: RehearsalFormRow[] = [];

  passengerGroups.forEach((rows) => {
    if (rows.length > 1) {
      duplicatesRemoved += rows.length - 1;
      // Sort descending by timestampMs, latest first
      rows.sort((a, b) => b.timestampMs - a.timestampMs || b.rowIndex - a.rowIndex);
    }
    deduplicatedRows.push(rows[0]);
  });

  // Sort rows deterministically
  deduplicatedRows.sort((a, b) => a.rowIndex - b.rowIndex);

  const records: ParsedRehearsalRecord[] = [];
  const included: ParsedRehearsalRecord[] = [];
  const intercessionExcluded: ParsedRehearsalRecord[] = [];
  const privateExcluded: ParsedRehearsalRecord[] = [];
  const unknownStopsSet = new Set<string>();

  let legsBothCount = 0;
  let legsGoingCount = 0;
  let legsReturnCount = 0;
  let expectedTotalFare = 0;

  deduplicatedRows.forEach((row, i) => {
    const { stop: normalizedStop, isUnknown: isUnknownStop } = normalizeRehearsalStop(row.rawStop);
    if (isUnknownStop && normalizedStop !== 'Unspecified') {
      unknownStopsSet.add(normalizedStop);
    }

    const evaluation = evaluateRehearsalTransportAnswer(row.transportAnswer, row.rawStop, normTarget);

    const legs: RehearsalLegs = evaluation.legs || 'both';
    const fare = evaluation.fare;

    const passenger: Passenger = {
      id: createDeterministicRehearsalPassengerId(normTarget, row.name),
      fullName: row.name,
      stop: normalizedStop,
      structure: row.structure || 'No Structure',
      phone: row.whatsapp,
      userEmail: row.email,
      timestamp: row.timestamp,
      service: 'Rehearsal',
      category: 'Normal',
      assignedTo: null,
      present: false,
      cancellationFeeOwed: false,
      legs,
      notes: evaluation.note,
    };

    const record: ParsedRehearsalRecord = {
      id: passenger.id,
      passenger,
      status: evaluation.status,
      legs,
      fare,
      note: evaluation.note,
      isUnknownStop,
      timestampMs: row.timestampMs,
      rawDate: row.dateStr,
    };

    records.push(record);

    if (evaluation.status === 'included') {
      included.push(record);
      expectedTotalFare += fare;
      if (legs === 'both') legsBothCount++;
      else if (legs === 'going') legsGoingCount++;
      else if (legs === 'return') legsReturnCount++;
    } else if (evaluation.status === 'intercession_excluded') {
      intercessionExcluded.push(record);
    } else {
      privateExcluded.push(record);
    }
  });

  const summary: RehearsalImportSummary = {
    date: normTarget,
    totalResponsesForDate: dateRows.length,
    duplicatesRemoved,
    includedCount: included.length,
    legsBothCount,
    legsGoingCount,
    legsReturnCount,
    excludedPrivateCount: privateExcluded.length,
    excludedIntercessionCount: intercessionExcluded.length,
    unknownStopsCount: unknownStopsSet.size,
    unknownStops: Array.from(unknownStopsSet),
    expectedTotalFare,
  };

  return {
    records,
    included,
    intercessionExcluded,
    privateExcluded,
    summary,
    availableDates: Array.from(allDatesSet).sort(),
  };
}

/**
 * Formats rehearsal taxi manifest for WhatsApp in the exact mandated style:
 *
 * Rehearsal taxi
 * 🚖 TAXI 1
 *
 * *🛑Braam 17:00*
 * 1.Linelle Mulumba
 * 2.Keitumetse Masilo (Return)
 * 3.Thato Ndwebi
 *
 * *🛑Wits Gate 7 17:10*
 * 1.Murothodzi Ndwammbi (Return)
 * 2.Liyema Lando
 *
 * 🚖 TAXI 2
 *
 * *🛑Maboneng 16:55*
 * 1.E JaV
 */
export function formatRehearsalWhatsAppManifest(
  vehicles: Vehicle[],
  passengers: Passenger[]
): string {
  const pMap = new Map(passengers.map((p) => [p.id, p]));
  const lines: string[] = ['Rehearsal taxi'];

  vehicles.forEach((vehicle, vIdx) => {
    // Header for Taxi
    lines.push(`🚖 ${vehicle.name.toUpperCase()}`);
    lines.push(''); // Blank line after taxi header

    // Resolve stops and riders
    const riders = (vehicle.riders || []).map((id) => pMap.get(id)).filter(Boolean) as Passenger[];

    // Group riders by stop
    const stopGroups = new Map<string, Passenger[]>();
    riders.forEach((r) => {
      const s = r.stop || 'Unassigned';
      const arr = stopGroups.get(s) || [];
      arr.push(r);
      stopGroups.set(s, arr);
    });

    // Use vehicle.orderedStops if defined, then any remaining stops
    const stopsInOrder: string[] = [];
    if (vehicle.orderedStops && vehicle.orderedStops.length > 0) {
      vehicle.orderedStops.forEach((st) => {
        if (!stopsInOrder.includes(st)) stopsInOrder.push(st);
      });
    }
    stopGroups.forEach((_, st) => {
      if (!stopsInOrder.includes(st)) stopsInOrder.push(st);
    });

    const stopBlocks: string[] = [];

    stopsInOrder.forEach((stopName) => {
      const stopRiders = stopGroups.get(stopName) || [];
      if (stopRiders.length === 0) return;

      // Sort riders by name
      stopRiders.sort((a, b) => naturalCompare(a.fullName, b.fullName));

      const time = vehicle.stopTimes?.[stopName] ? ` ${vehicle.stopTimes[stopName]}` : '';
      const stopLines: string[] = [`*🛑${stopName}${time}*`];

      stopRiders.forEach((rider, idx) => {
        let legTag = '';
        if (rider.legs === 'going') {
          legTag = ' (Going)';
        } else if (rider.legs === 'return') {
          legTag = ' (Return)';
        }
        stopLines.push(`${idx + 1}.${rider.fullName}${legTag}`);
      });

      stopBlocks.push(stopLines.join('\n'));
    });

    lines.push(stopBlocks.join('\n\n'));

    // Two blank lines between taxis if not last
    if (vIdx < vehicles.length - 1) {
      lines.push('\n');
    }
  });

  return lines.join('\n');
}

export interface StopTimeTemplateItem {
  stopName: string;
  time: string;
}

export interface TaxiStopTemplate {
  taxiName: string;
  capacity: number;
  stops: StopTimeTemplateItem[];
}

const TEMPLATE_KEY = 'crc_thursday_rehearsal_template';
export const REHEARSAL_TEMPLATES_TABLE = 'rehearsal_templates';

export async function saveRehearsalTemplate(templates: TaxiStopTemplate[]): Promise<void> {
  // 1. Local storage instant cache
  try {
    localStorage.setItem(TEMPLATE_KEY, JSON.stringify(templates));
  } catch (err) {
    console.warn('Failed to cache rehearsal template in localStorage:', err);
  }

  // 2. Central Server API (persists in data/rehearsal_template.json)
  try {
    await fetch('/api/rehearsal-template', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: templates }),
    });
  } catch (err) {
    console.debug('Failed to save rehearsal template to server:', err);
  }

  // 3. Supabase table
  try {
    await supabase.from(REHEARSAL_TEMPLATES_TABLE).upsert({
      id: 'current',
      templates,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.debug('Failed to save rehearsal template to Supabase:', err);
  }
}

/**
 * Loads rehearsal template across devices from Server / Supabase, falling back to local storage.
 */
export async function fetchRehearsalTemplate(): Promise<TaxiStopTemplate[] | null> {
  // 1. Try server API
  try {
    const res = await fetch('/api/rehearsal-template');
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.template) && data.template.length > 0) {
        try {
          localStorage.setItem(TEMPLATE_KEY, JSON.stringify(data.template));
        } catch {
          /* ignore */
        }
        return data.template as TaxiStopTemplate[];
      }
    }
  } catch {
    /* fallback */
  }

  // 2. Try Supabase
  try {
    const { data, error } = await supabase
      .from(REHEARSAL_TEMPLATES_TABLE)
      .select('templates')
      .eq('id', 'current')
      .maybeSingle();
    if (!error && data && Array.isArray(data.templates) && data.templates.length > 0) {
      try {
        localStorage.setItem(TEMPLATE_KEY, JSON.stringify(data.templates));
      } catch {
        /* ignore */
      }
      return data.templates as TaxiStopTemplate[];
    }
  } catch {
    /* fallback */
  }

  // 3. Local storage fallback
  return loadRehearsalTemplate();
}

export function loadRehearsalTemplate(): TaxiStopTemplate[] | null {
  try {
    const raw = localStorage.getItem(TEMPLATE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as TaxiStopTemplate[];
  } catch {
    return null;
  }
}

/**
 * Auto-suggest allocation that splits passengers across taxis
 * preserving route order and respecting vehicle capacities (default 15).
 */
export function autoSuggestRehearsalAllocation(
  passengers: Passenger[],
  taxiCount: number = 2,
  taxiCapacity: number = 15,
  stopTimesMap?: Record<string, string>
): Vehicle[] {
  if (taxiCount <= 0) taxiCount = 1;

  // Group passengers by stop
  const stopMap = new Map<string, Passenger[]>();
  passengers.forEach((p) => {
    const s = p.stop || 'Unassigned';
    const arr = stopMap.get(s) || [];
    arr.push(p);
    stopMap.set(s, arr);
  });

  const vehicles: Vehicle[] = Array.from({ length: taxiCount }, (_, i) => ({
    id: `rehe_taxi_${i + 1}`,
    name: `Taxi ${i + 1}`,
    type: 'Taxi' as const,
    capacity: taxiCapacity,
    riders: [],
    orderedStops: [],
    stopTimes: {},
  }));

  let currentVehIdx = 0;

  stopMap.forEach((ridersForStop, stopName) => {
    // If current vehicle is already near or over capacity, move to next vehicle if available
    if (
      vehicles[currentVehIdx].riders.length + ridersForStop.length > taxiCapacity &&
      currentVehIdx < taxiCount - 1 &&
      vehicles[currentVehIdx].riders.length > 0
    ) {
      currentVehIdx++;
    }

    const targetVeh = vehicles[currentVehIdx];
    targetVeh.riders.push(...ridersForStop.map((r) => r.id));
    if (!targetVeh.orderedStops!.includes(stopName)) {
      targetVeh.orderedStops!.push(stopName);
      if (stopTimesMap?.[stopName]) {
        targetVeh.stopTimes![stopName] = stopTimesMap[stopName];
      }
    }
  });

  return vehicles;
}

/**
 * Formats a single rehearsal taxi for WhatsApp (used in Rep Portal).
 */
export function formatSingleTaxiRehearsalWhatsApp(
  vehicle: Vehicle,
  allPassengers: Passenger[]
): string {
  const pMap = new Map(allPassengers.map((p) => [p.id, p]));
  const riders = (vehicle.riders || []).map((id) => pMap.get(id)).filter(Boolean) as Passenger[];
  const lines: string[] = ['Rehearsal taxi', `🚖 ${vehicle.name.toUpperCase()}`, ''];

  const stopGroups = new Map<string, Passenger[]>();
  riders.forEach((r) => {
    const s = r.stop || 'Unassigned';
    const arr = stopGroups.get(s) || [];
    arr.push(r);
    stopGroups.set(s, arr);
  });

  const stopsInOrder: string[] = [];
  if (vehicle.orderedStops) {
    vehicle.orderedStops.forEach((st) => {
      if (!stopsInOrder.includes(st)) stopsInOrder.push(st);
    });
  }
  stopGroups.forEach((_, st) => {
    if (!stopsInOrder.includes(st)) stopsInOrder.push(st);
  });

  const stopBlocks: string[] = [];
  stopsInOrder.forEach((stopName) => {
    const stopRiders = stopGroups.get(stopName) || [];
    if (stopRiders.length === 0) return;
    stopRiders.sort((a, b) => naturalCompare(a.fullName, b.fullName));

    const time = vehicle.stopTimes?.[stopName] ? ` ${vehicle.stopTimes[stopName]}` : '';
    const stopLines: string[] = [`*🛑${stopName}${time}*`];
    stopRiders.forEach((rider, idx) => {
      let legTag = '';
      if (rider.legs === 'going') legTag = ' (Going)';
      else if (rider.legs === 'return') legTag = ' (Return)';
      stopLines.push(`${idx + 1}.${rider.fullName}${legTag}`);
    });
    stopBlocks.push(stopLines.join('\n'));
  });

  lines.push(stopBlocks.join('\n\n'));
  return lines.join('\n');
}
