import * as XLSX from 'xlsx';
import { supabase, mockStorage, MANIFESTS_TABLE, SPONSORSHIPS_TABLE } from './supabase';
import {
  listLedgerFromServer,
  settleLedgerOnServer,
  addManualLedgerOnServer,
  deleteLedgerOnServer,
  updateLedgerOnServer,
  updateDebtorOnServer,
  listReportedSponsorshipsFromServer,
  verifyBatchSponsorshipsOnServer,
  recordReportedSponsorshipsOnServer,
  deleteSponsorshipOnServer,
  batchDeleteSponsorshipsOnServer,
  recordSponsorshipPaymentOnServer,
  updateSponsorshipOnServer,
} from './serverApi';
import type { ReportedSponsorship, SponsorshipStatus } from './serverApi';
import type { Passenger, Vehicle } from './types';
import {
  CANCELLATION_FEE,
  getFareForDate,
  isDreamWeekDate,
  DREAMWEEK_START,
  DREAMWEEK_END,
  DREAMWEEK_FARE,
  getPassengerFare,
} from './types';
import { naturalCompare } from './sort';
import { shortDate } from './dates';

export type { ReportedSponsorship, SponsorshipStatus };
export { isDreamWeekDate, DREAMWEEK_START, DREAMWEEK_END, DREAMWEEK_FARE, getPassengerFare };

/**
 * Safely parses a debt amount from numbers, numeric strings, or formatted currency strings ("R40", "R45", "40", "45", "40.00").
 * Returns 0 if explicitly 0. Defaults to the date's standard fee (R45 for DreamWeek weekdays, R40 for Sunday/default) if null, undefined, empty, or unparseable.
 */
export function parseDebtAmount(
  val: unknown,
  dateStr?: string | null,
  serviceStr?: string | null,
  legs?: string | null
): number {
  let fallback = dateStr ? getFareForDate(dateStr) : CANCELLATION_FEE;
  if (serviceStr && (serviceStr.toLowerCase().includes('rehe') || serviceStr.toLowerCase().includes('rehearsal'))) {
    fallback = isDreamWeekDate(dateStr) ? DREAMWEEK_FARE : (legs === 'going' || legs === 'return' ? 40 : 70);
  }
  if (val === undefined || val === null || val === '') return fallback;
  if (typeof val === 'number') {
    if (isNaN(val)) return fallback;
    return val;
  }
  const str = String(val).trim();
  if (!str) return fallback;
  if (str === '0' || str === 'R0' || str === 'R 0' || str === '0.00' || str === 'R0.00') return 0;
  const numStr = str.replace(/[^\d.]/g, '');
  if (!numStr) return fallback;
  const parsed = Number(numStr);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Normalizes structure strings to canonical structure codes.
 * - 'Unidentified', 'sunidentified', 'SUNIDENTIFIED', 'unidentified' -> 'Unidentified'
 * - 'No Structure', 'none', 'unassigned' -> 'No Structure'
 * - 'FTV', 'FTV 20', 'ftv20' -> 'FTV 20'
 * - 'S1', 's1', '1', 'Structure 1' -> 'S1'
 * - 'YZ1', 'yz1' -> 'YZ1'
 * - Custom names are preserved cleanly without erroneous 'S' prefixing.
 */
export function normalizeStructureCode(raw: string | null | undefined): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return 'No Structure';

  const lower = trimmed.toLowerCase();

  // 1. Unidentified variants (including accidental 'sunidentified' or 's-unidentified')
  if (
    lower === 'unidentified' ||
    lower === 'sunidentified' ||
    lower === 's-unidentified' ||
    lower === 's_unidentified' ||
    lower === 'unassigned'
  ) {
    return 'Unidentified';
  }

  // 2. No Structure variants
  if (
    lower === 'no structure' ||
    lower === 'none' ||
    lower === 'no struct' ||
    lower === 'nostructure' ||
    lower === 'unknown'
  ) {
    return 'No Structure';
  }

  // 3. FTV structures
  if (lower === 'ftv' || lower === 'ftv 20' || lower === 'ftv20' || lower === 'ftv-20') {
    return 'FTV 20';
  }

  // 4. Standard S structures (e.g. S1, S2, S15, S2B)
  const sMatch = trimmed.match(/^s\s*(\d+[a-z]?)$/i);
  if (sMatch) {
    return `S${sMatch[1].toUpperCase()}`;
  }

  // 5. YZ structures (e.g. YZ1, YZ12)
  const yzMatch = trimmed.match(/^yz\s*(\d+[a-z]?)$/i);
  if (yzMatch) {
    return `YZ${yzMatch[1].toUpperCase()}`;
  }

  // 6. Bare numbers entered by user (e.g. "1" -> "S1", "14" -> "S14")
  if (/^\d+[a-z]?$/i.test(trimmed)) {
    return `S${trimmed.toUpperCase()}`;
  }

  // 7. "Structure 1" or "Structure S1" -> "S1"
  const structWord = trimmed.match(/^Structure\s*(S?\d+[a-z]?)$/i);
  if (structWord) {
    const num = structWord[1].toUpperCase();
    return num.startsWith('S') ? num : `S${num}`;
  }

  // 8. Accidental 's' prefix on other non-numeric words e.g. "sunidentified"
  if (lower.startsWith('s') && lower.slice(1) === 'unidentified') {
    return 'Unidentified';
  }

  return trimmed;
}

/**
 * Sorts structures cleanly:
 * S1..S15 in natural order, YZ..., FTV..., then Unidentified and No Structure at the bottom.
 */
export function structureSortComparator(a: string, b: string): number {
  const aNorm = normalizeStructureCode(a);
  const bNorm = normalizeStructureCode(b);

  const aIsSpecial = aNorm === 'Unidentified' || aNorm === 'No Structure';
  const bIsSpecial = bNorm === 'Unidentified' || bNorm === 'No Structure';

  if (aIsSpecial && !bIsSpecial) return 1;
  if (!aIsSpecial && bIsSpecial) return -1;
  if (aIsSpecial && bIsSpecial) {
    if (aNorm === 'Unidentified' && bNorm === 'No Structure') return -1;
    if (aNorm === 'No Structure' && bNorm === 'Unidentified') return 1;
    return 0;
  }

  return naturalCompare(aNorm, bNorm);
}

/**
 * Cleans slug-like or corrupted names such as "Passenger bonolo-ngejane-dfc-bus-stop"
 * into a proper title-cased name like "Bonolo Ngejane".
 */
export function sanitizePassengerDisplayName(rawName: string | null | undefined): string {
  if (!rawName) return '';
  let name = String(rawName).replace(/[\u200B-\u200D\uFEFF]/g, '').trim();

  // Strip accidental "Passenger " prefix
  if (/^passenger\s+/i.test(name)) {
    name = name.replace(/^passenger\s+/i, '').trim();
  }

  // Strip parenthetical badges or tags like (Bus), (DFC), [SZ 1]
  name = name.replace(/\s*\([^)]*\)|\s*\[[^\]]*\]/g, ' ').trim();

  // If it's a hyphenated slug (e.g. "bonolo-ngejane-dfc-bus-stop")
  if (/^[a-z0-9]+(-[a-z0-9]+)+$/i.test(name)) {
    const stopSlugs = [
      '-dfc-bus-stop', '-dfc', '-sunnyside', '-amic-deck', '-david-webster',
      '-barnato', '-midrand', '-braamfontein', '-auckland-park', '-kingsway',
      '-bunting-road', '-soweto', '-park-station', '-parktown'
    ];
    let cleanedSlug = name;
    for (const slug of stopSlugs) {
      if (cleanedSlug.toLowerCase().endsWith(slug)) {
        cleanedSlug = cleanedSlug.slice(0, -slug.length);
        break;
      }
    }
    name = cleanedSlug
      .split('-')
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(' ');
  }

  // Strip trailing stop notes like " - DFC Bus Stop"
  name = name.replace(/\s*-\s*(?:dfc|amic|sunnyside|kingsway|bunting|midrand|soweto|barnato|park).*$/i, '').trim();
  name = name.replace(/^[-\s\d.:#*•]+/, '').replace(/[-\s.:#*•]+$/, '').trim();
  name = name.replace(/\s+/g, ' ').trim();

  return name;
}

/**
 * Strips auto-generated boilerplate and vehicle references from sponsorship notes,
 * preserving only genuine user-provided sponsor notes.
 */
export function cleanSponsorshipNote(note?: string | null): string {
  if (!note || typeof note !== 'string') return '';
  let trimmed = note.trim();
  if (!trimmed) return '';

  // Exact boilerplate matches (case-insensitive) - do NOT strip 'unaccounted' or 'unpaid'
  if (/^actually\s*sponsored$/i.test(trimmed)) return '';
  if (/^pending\s*verification$/i.test(trimmed)) return '';
  if (/^(?:(?:from|in)\s+)?(?:taxi|vehicle|bus)\s*\d+$/i.test(trimmed)) return '';
  if (/^vehicle:\s*.*$/i.test(trimmed)) return '';

  // Strip vehicle mentions like "(Taxi 1)", "(from Taxi 2)", "(in Vehicle 3)", "(Bus 4)"
  trimmed = trimmed.replace(/\s*\((?:(?:from|in)\s+)?(?:taxi|vehicle|bus)(?:\s*\d+)?(?:\s*-[^)]*)?\)/gi, '').trim();

  // Strip "in/from Taxi X" or "in/from Vehicle X"
  trimmed = trimmed.replace(/\s*(?:(?:from|in)\s+)(?:taxi|vehicle|bus)\s*\d+\b/gi, '').trim();

  // Strip " - Taxi X" or "Taxi X - "
  trimmed = trimmed.replace(/\s*[-–—]\s*(?:taxi|vehicle|bus)\s*\d+\b/gi, '').trim();
  trimmed = trimmed.replace(/^(?:taxi|vehicle|bus)\s*\d+\s*[-–—:]\s*/gi, '').trim();

  // Strip general notes boilerplate if accidental full notes got attached
  trimmed = trimmed.replace(/(?:co-reps|cash collected|external sponsees|past cancellations):?[^;.]*(?:[;.]|$)/gi, '').trim();

  if (/^(?:(?:from|in)\s+)?(?:taxi|vehicle|bus)\s*\d+$/i.test(trimmed)) return '';

  return trimmed;
}

/**
 * Strips vehicle-wide summaries (cash, co-reps, sponsorships) from personal absentee notes
 * so an absentee passenger's record is never tainted by other riders' sponsorships.
 */
export function cleanPersonalAbsenteeNote(note?: unknown): string {
  if (!note || typeof note !== 'string') return '';
  let trimmed = note.trim();
  if (!trimmed) return '';

  // Strip vehicle-wide summary prefixes and their trailing contents
  trimmed = trimmed.replace(/(?:co-reps|cash collected|external sponsees|past cancellations|sponsorships?)\s*:[^.]*(?:\.|$)/gi, '');
  trimmed = trimmed.replace(/(?:co-reps|cash collected|external sponsees|past cancellations|sponsorships?)\s*:.*?(?=(?:co-reps|cash collected|external sponsees|past cancellations|sponsorships?)\s*:|$)/gi, '');
  trimmed = trimmed.replace(/\b(?:co-reps|cash collected|external sponsees|past cancellations|sponsorships?)\b[^.]*(\.|$)/gi, '');
  trimmed = trimmed.replace(/\bpaid by\s*:[^;.]*(?:[;.]|$)/gi, '');
  trimmed = trimmed.replace(/\s{2,}/g, ' ').trim();

  // If after stripping only punctuation or whitespace remains, return empty string
  if (/^[-–—:;,.\s]*$/.test(trimmed)) return '';
  return trimmed;
}

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
  source?: string;
  legs?: 'both' | 'going' | 'return';
}

export interface AbsenteeInput extends Passenger {
  sponsored?: boolean;
  sponsorNote?: string;
}

/**
 * Extracts a normalized service code (e.g. AM, PM, LM, WMP, EF, AD, FW, Rehe, etc.)
 * from a service string or embedded event description.
 * Preserves special church event codes like LM (Leaders Meeting), WMP (Worship/Music/Prayer),
 * EF (Easter Friday), AD (Ascension Day), FW (Fast & Worship), Rehe (Thursday Rehearsal).
 */
export function extractServiceCode(serviceStr: string): string {
  if (!serviceStr) return '';
  let clean = serviceStr.trim().replace(/\r?\n/g, ' ');

  // If already in brackets e.g. "(PM)" or "(LM)", strip the parens
  const bracketMatch = clean.match(/^\(([^)]+)\)$/);
  if (bracketMatch) {
    return extractServiceCode(bracketMatch[1]);
  }

  // Strip FTV prefix/suffix
  clean = clean.replace(/FTV\s*\/?|\/?\s*FTV/gi, '').trim();
  if (!clean) return 'PM';

  // Exact known codes
  const upper = clean.toUpperCase();
  if (upper === 'REHE' || upper === 'REHEARSAL' || upper.startsWith('REHE_') || upper.startsWith('REHE ') || upper.startsWith('REHE-') || upper.startsWith('REHE/')) return 'Rehe';
  if (upper === 'AM' || upper.startsWith('AM_') || upper.startsWith('AM ') || upper.startsWith('AM-') || upper.startsWith('AM/')) return 'AM';
  if (upper === 'PM' || upper.startsWith('PM_') || upper.startsWith('PM ') || upper.startsWith('PM-') || upper.startsWith('PM/')) return 'PM';
  if (upper === 'LM' || upper.startsWith('LM_') || upper.startsWith('LM ') || upper.startsWith('LM-') || upper.startsWith('LM/')) return 'LM';
  if (upper === 'WMP' || upper.startsWith('WMP_') || upper.startsWith('WMP ') || upper.startsWith('WMP-') || upper.startsWith('WMP/')) return 'WMP';
  if (upper === 'EF' || upper.startsWith('EF_') || upper.startsWith('EF ') || upper.startsWith('EF-') || upper.startsWith('EF/')) return 'EF';
  if (upper === 'AD' || upper.startsWith('AD_') || upper.startsWith('AD ') || upper.startsWith('AD-') || upper.startsWith('AD/')) return 'AD';
  if (upper === 'FW' || upper.startsWith('FW_') || upper.startsWith('FW ') || upper.startsWith('FW-') || upper.startsWith('FW/')) return 'FW';

  // Keyword searches
  const lower = clean.toLowerCase();
  if (lower.includes('rehears') || lower === 'rehe') return 'Rehe';
  if (lower.includes('leader')) return 'LM';
  if ((lower.includes('worship') && lower.includes('prayer')) || lower.includes('wmp')) return 'WMP';
  if (lower.includes('easter') || lower.includes('good friday') || lower === 'ef') return 'EF';
  if (lower.includes('ascension') || lower === 'ad') return 'AD';
  if ((lower.includes('fast') && lower.includes('worship')) || lower === 'fw') return 'FW';
  if (lower.includes('pm') || lower.includes('evening') || lower.includes('afternoon')) return 'PM';
  if (lower.includes('am') || lower.includes('morning')) return 'AM';

  // Fallback: extract short alphanumeric acronym up to 6 characters (e.g. CAMP, YOUTH, CONF)
  const token = clean.split(/[\s—_/-]+/)[0].toUpperCase();
  return token.length <= 6 ? token : upper.slice(0, 4);
}

/**
 * Resolves the display service code for a ledger entry/instance, prefixing
 * plain 'AM'/'PM' codes with 'DW ' (-> 'DW AM' / 'DW PM') whenever the
 * entry's date falls on a DreamWeek conference day (29 Sep – 2 Oct 2026).
 * Named church-event codes (LM, WMP, EF, AD, FW, Rehe, etc.) are left
 * untouched since they are already self-describing regardless of weekday.
 */
export function serviceCodeForEntry(e: { service?: string | null; date?: string | null }): string {
  const code = extractServiceCode(e.service || '') || 'PM';
  if ((code === 'AM' || code === 'PM') && isDreamWeekDate(e.date)) {
    return `DW ${code}`;
  }
  return code;
}

/**
 * Parses raw structure cell text like "S1 - Nthabiseng, Nthabeleng" into a clean
 * structure code ("S1") and optional associated rep names ("Nthabiseng, Nthabeleng").
 */
export function parseStructureCell(raw: string): { structure: string; repName: string } {
  const str = (raw || '').trim().replace(/\r?\n/g, ' ');
  if (!str) return { structure: 'No Structure', repName: '' };

  // FTV or FTV 20 structures e.g. "FTV 20", "FTV-20", "FTV 20 - Rep", "FTV"
  const ftvMatch = str.match(/^(FTV\s*20|FTV20|FTV)\s*[-–—:]?\s*(.*)$/i);
  if (ftvMatch) {
    return {
      structure: 'FTV 20',
      repName: ftvMatch[2].trim(),
    };
  }

  // E.g. "S1 - Nthabiseng, Nthabeleng", "S1 – Thuto", "S14 – Kgolaganyo/Nicole", "S1: Name", "Unidentified - Rep"
  const m = str.match(/^(S\d+|YZ\d+|Unidentified|No Structure)\s*[-–—:]\s*(.*)$/i);
  if (m) {
    return {
      structure: normalizeStructureCode(m[1]),
      repName: m[2].trim(),
    };
  }

  // Exact code like "S1", "S15", "YZ1", "Unidentified"
  const justCode = str.match(/^(S\d+|YZ\d+|Unidentified|No Structure)$/i);
  if (justCode) {
    return {
      structure: normalizeStructureCode(justCode[1]),
      repName: '',
    };
  }

  // "Structure 1" or "Structure S1"
  const structWord = str.match(/^Structure\s*(S?\d+)\s*[-–—:]?\s*(.*)$/i);
  if (structWord) {
    return {
      structure: normalizeStructureCode(structWord[1]),
      repName: structWord[2].trim(),
    };
  }

  return {
    structure: normalizeStructureCode(str),
    repName: '',
  };
}

/**
 * Extracts clean passenger name and service type from raw name text that may have
 * service tags in brackets e.g. "Linathi Mpako(PM)", "Peaches Nguni(FTV)(PM)",
 * "Thembi Qobo(LM)", "Nonkululeko Dhlamini(WMP)", "Roxy Ramoretli(EF)".
 */
export function extractNameAndService(
  rawCell: string,
  explicitService?: string
): { cleanName: string; serviceCode: string; extraNotes: string } {
  let raw = (rawCell || '').trim().replace(/\r?\n/g, ' ');
  if (!raw) {
    return {
      cleanName: '',
      serviceCode: explicitService ? extractServiceCode(explicitService) : 'PM',
      extraNotes: '',
    };
  }

  let serviceCode = explicitService ? extractServiceCode(explicitService) : '';
  const extraNotes = '';

  // Look for service tags in parentheses like (PM), (AM), (LM), (WMP), (EF), (AD), (FW)
  const serviceParenRegex = /\(\s*(AM|PM|LM|WMP|EF|AD|FW|W&P|W\/P|SERVING|USHERS|NORMAL)\s*[,)]*/gi;
  const matches = Array.from(raw.matchAll(serviceParenRegex));
  if (matches.length > 0) {
    const matchedCode = matches[0][1].toUpperCase();
    if (!serviceCode || serviceCode === 'Unspecified' || serviceCode === 'PM') {
      serviceCode = extractServiceCode(matchedCode);
    }
    raw = raw.replace(serviceParenRegex, ' ').trim();
  }

  // Complex patterns like "(PM - R20)" or "(PM," or "(PM"
  const complexMatch = raw.match(/\(\s*(AM|PM|LM|WMP|EF|AD|FW)\s*[-–—,]?\s*([^)]*)\)?/i);
  if (complexMatch) {
    if (!serviceCode || serviceCode === 'Unspecified' || serviceCode === 'PM') {
      serviceCode = extractServiceCode(complexMatch[1]);
    }
    raw = raw.replace(complexMatch[0], ' ').trim();
  }

  // Clean any trailing FTV/R20 tags, attached rep markers, punctuation, or empty parens
  raw = raw.replace(/(?:[–—|-]\s*)?\(?\s*rep(?:resentative)?\s*[:—–-]?\s*[^),]+(?:\)|$)/gi, '').trim();
  raw = raw.replace(/\bFTV\s*20\b|\bFTV20\b|\bFTV\b|\bR20\b/gi, '').trim();
  raw = raw.replace(/\(\s*\)/g, '').trim();
  raw = raw.replace(/[(),]+$/, '').trim();

  // Normalize spacing
  raw = raw.replace(/\s{2,}/g, ' ').trim();

  if (!serviceCode) {
    serviceCode = 'PM';
  }

  return {
    cleanName: raw,
    serviceCode,
    extraNotes,
  };
}

/**
 * Robust search evaluator that provides accurate prefix, full-name, token,
 * structure, notes, and substring matching with intuitive priority scoring.
 * Intentionally EXCLUDES rep name so searching a rep's name does not mistakenly
 * return every absentee they submitted.
 */
export function evaluateLedgerSearch(
  item: {
    passenger_name?: string;
    name?: string;
    structure?: string;
    service?: string;
    serviceCodes?: string[];
    general_notes?: string;
    sponsor_note?: string;
    notes?: string;
    date?: string;
    formattedDateList?: string;
    rep_name?: string;
    repName?: string;
  },
  searchQuery: string
): { matched: boolean; score: number } {
  const q = searchQuery.trim().toLowerCase();
  if (!q) return { matched: true, score: 0 };

  const fullName = (item.name || item.passenger_name || '').toLowerCase().trim();
  const structure = (item.structure || '').toLowerCase().trim();
  const notes = `${item.general_notes || ''} ${item.sponsor_note || ''} ${item.notes || ''}`.toLowerCase().trim();
  const dateStr = `${item.date || ''} ${item.formattedDateList || ''}`.toLowerCase().trim();
  const service = `${item.service || ''} ${(item.serviceCodes || []).join(' ')}`.toLowerCase().trim();

  const nameWords = fullName.split(/\s+/).filter(Boolean);
  const qTokens = q.split(/\s+/).filter(Boolean);

  // 1. Exact full name match (highest possible match)
  if (fullName === q) {
    return { matched: true, score: 1000 };
  }

  // 2. Full name starts with exact query string (e.g. "amo" -> "Amo Nhlabathi", "Amogelang...")
  if (fullName.startsWith(q)) {
    return { matched: true, score: 900 };
  }

  // 3. First name or surname starts with exact query string (e.g. "amo" -> "Nonyane Amo", "Amo Sithole")
  const wordStartsWithQ = nameWords.some((w) => w.startsWith(q));
  if (wordStartsWithQ) {
    return { matched: true, score: 800 };
  }

  // 4. Multi-token match across name: User typed full/partial name e.g. "amo nhla" or "nhlabathi amo"
  if (qTokens.length > 1) {
    const allTokensMatchName = qTokens.every((token) =>
      nameWords.some((w) => w.startsWith(token) || w.includes(token))
    );
    if (allTokensMatchName) {
      return { matched: true, score: 750 };
    }
  }

  // 5. Name contains entire query as continuous substring
  if (fullName.includes(q)) {
    return { matched: true, score: 600 };
  }

  // 6. Any individual word in name contains query substring
  const wordContainsQ = nameWords.some((w) => w.includes(q));
  if (wordContainsQ) {
    return { matched: true, score: 500 };
  }

  // 7. Structure match (e.g. user typed "S1" or "FTV")
  if (structure === q || structure.startsWith(q) || structure.includes(q)) {
    return { matched: true, score: 400 };
  }

  // 8. Multi-token match across fields: passenger name, structure, notes, dates, service.
  // Note: rep name is intentionally omitted so searching a rep's name does not match submitted passengers.
  const combinedAll = `${fullName} ${structure} ${notes} ${dateStr} ${service}`;
  const allTokensInCombined = qTokens.every((token) => combinedAll.includes(token));
  if (allTokensInCombined) {
    let score = 300;
    if (structure.includes(q)) score += 80;
    if (notes.includes(q)) score += 40;
    return { matched: true, score };
  }

  return { matched: false, score: 0 };
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
  generalNotes: string,
  unpaidRiders?: Array<{ fullName: string; stop?: string; structure?: string; unpaidNote?: string }>
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

  const isReheService = (serviceLabel || '').toLowerCase().includes('rehe');
  const normalizedService = isReheService ? 'Rehe' : serviceLabel;
  const rows: Array<Record<string, unknown>> = absentees.map((p) => {
    const passengerDebt = getPassengerFare(p, date);
    return {
      manifest_key: manifestKey,
      date,
      service: normalizedService,
      passenger_name: p.fullName,
      stop: p.stop,
      structure: p.structure || '',
      vehicle_name: vehicleName,
      submitted_by: submittedBy,
      rep_name: repName,
      license_plate: licensePlate,
      sponsored: false, // Absentees are regular cancellations, never auto-sent to sponsorship section!
      sponsor_note: '',
      structure_debt: passengerDebt,
      general_notes: cleanPersonalAbsenteeNote((p as { notes?: string }).notes || ''),
      legs: p.legs || (isReheService ? 'both' : undefined),
    };
  });

  if (unpaidRiders && unpaidRiders.length > 0) {
    for (const u of unpaidRiders) {
      const uFare = getPassengerFare(u as unknown as Passenger, date);
      rows.push({
        manifest_key: manifestKey,
        date,
        service: normalizedService,
        passenger_name: sanitizePassengerDisplayName(u.fullName),
        stop: u.stop || '',
        structure: normalizeStructureCode(u.structure),
        vehicle_name: vehicleName,
        submitted_by: submittedBy,
        rep_name: repName,
        license_plate: licensePlate,
        sponsored: true,
        debt_type: 'unpaid_sponsorship',
        sponsor_note: u.unpaidNote ? `Did not pay: ${u.unpaidNote}` : 'Did not pay',
        structure_debt: uFare,
        general_notes: `Did not pay${u.unpaidNote ? `: ${u.unpaidNote}` : ''}`,
        source: 'reported_sponsorship_audit',
        legs: (u as { legs?: 'both' | 'going' | 'return' }).legs || (isReheService ? 'both' : undefined),
      });
    }
  }

  if (rows.length === 0) return;

  const { error } = await supabase.from(LEDGER_TABLE).insert(rows);
  if (error) throw error;
}

/**
 * Fetches all ledger entries from Supabase using pagination to bypass the default 1000-row limit.
 */
export async function fetchAllLedgerFromSupabase(): Promise<LedgerEntry[]> {
  const allRows: LedgerEntry[] = [];
  const pageSize = 1000;
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from(LEDGER_TABLE)
      .select('*')
      .order('submitted_at', { ascending: false })
      .range(from, from + pageSize - 1);

    if (error || !data || data.length === 0) {
      break;
    }
    allRows.push(...(data as LedgerEntry[]));
    if (data.length < pageSize) {
      break;
    }
    from += pageSize;
  }
  return allRows;
}

/**
 * Withdraws absentees for a given vehicle/session when a Rep reopens attendance
 * for editing. Scoped strictly to the session manifestKey so same-day debts
 * from other services are never mistakenly removed.
 */
export async function withdrawAbsentees(
  manifestKey: string,
  riderNames: string[]
): Promise<void> {
  if (riderNames.length === 0) return;
  const normalizedNames = new Set(riderNames.map((n) => sanitizePassengerDisplayName(n).toLowerCase()));

  try {
    const { data } = await supabase
      .from(LEDGER_TABLE)
      .select('id, passenger_name')
      .eq('manifest_key', manifestKey);

    if (Array.isArray(data) && data.length > 0) {
      const idsToDelete = data
        .filter((entry) => normalizedNames.has(sanitizePassengerDisplayName(entry.passenger_name).toLowerCase()))
        .map((e) => e.id);

      if (idsToDelete.length > 0) {
        await supabase.from(LEDGER_TABLE).delete().in('id', idsToDelete);
      }
    }
  } catch (err) {
    console.warn('[Ledger] Failed to withdraw absentees from local store:', err);
  }
}

export async function listLedgerEntries(): Promise<LedgerEntry[]> {
  const mergedMap = new Map<string, LedgerEntry>();

  // 1. Primary: Central Express Server API
  try {
    const serverEntries = await listLedgerFromServer();
    if (Array.isArray(serverEntries) && serverEntries.length > 0) {
      for (const e of serverEntries) {
        if (e && e.id) {
          mergedMap.set(String(e.id), e);
        }
      }
    }
  } catch (err) {
    console.debug('[Ledger] Server fetch note:', err);
  }

  // 2. Secondary: Supabase with full pagination (guarantees no 1000-row cutoff)
  try {
    const supabaseEntries = await fetchAllLedgerFromSupabase();
    if (Array.isArray(supabaseEntries) && supabaseEntries.length > 0) {
      for (const e of supabaseEntries) {
        if (e && e.id && !mergedMap.has(String(e.id))) {
          mergedMap.set(String(e.id), e);
        }
      }
    }
  } catch (err) {
    console.warn('[Ledger] Exception fetching ledger entries:', err);
  }

  // 3. Reconcile any confirmed unaccounted or unpaid sponsorships from local storage audits
  try {
    const localSponRaw = typeof localStorage !== 'undefined' ? localStorage.getItem(LOCAL_SPONSORSHIPS_KEY) : null;
    if (localSponRaw) {
      const audits = JSON.parse(localSponRaw) as ReportedSponsorship[];
      if (Array.isArray(audits)) {
        for (const spon of audits) {
          if (spon.status === 'unaccounted_sponsorship' || spon.status === 'unpaid_sponsorship') {
            const cleanName = sanitizePassengerDisplayName(spon.passenger_name).toLowerCase();
            const alreadyInMap = Array.from(mergedMap.values()).some((e) =>
              (spon.ledger_entry_id && e.id === spon.ledger_entry_id) ||
              (e.manifest_key === spon.manifest_key && sanitizePassengerDisplayName(e.passenger_name).toLowerCase() === cleanName && Boolean(e.sponsored))
            );
            if (!alreadyInMap) {
              const rawNote = spon.sponsor_note ? cleanSponsorshipNote(spon.sponsor_note) : '';
              const noteText = spon.status === 'unaccounted_sponsorship'
                ? (rawNote && !rawNote.toLowerCase().includes('unaccounted') ? `Unaccounted Sponsorship: ${rawNote}` : (rawNote || 'Unaccounted Sponsorship'))
                : (rawNote && !rawNote.toLowerCase().includes('did not pay') ? `Did not pay: ${rawNote}` : (rawNote || 'Did not pay'));
              const effectiveDebt = getFareForDate(spon.date);
              const entryId = spon.ledger_entry_id || `ledger_sp_${spon.id || Date.now()}`;
              mergedMap.set(entryId, {
                id: entryId,
                manifest_key: spon.manifest_key || `manual-${Date.now()}`,
                date: normalizeDateToYMD(spon.date) || spon.date,
                service: spon.service || 'Service',
                passenger_name: sanitizePassengerDisplayName(spon.passenger_name),
                stop: spon.stop || '',
                structure: normalizeStructureCode(spon.structure),
                vehicle_name: spon.vehicle_name || '—',
                submitted_by: 'Cancellation Admin',
                rep_name: spon.rep_name || '',
                license_plate: '',
                sponsored: true,
                sponsor_note: noteText,
                structure_debt: effectiveDebt,
                general_notes: noteText,
                source: 'reported_sponsorship_audit',
                submitted_at: spon.submitted_at || new Date().toISOString(),
              });
            }
          }
        }
      }
    }
  } catch {
    /* ignore local reconciliation errors */
  }

  const entries = Array.from(mergedMap.values());

  // Ensure all structures are normalized to canonical codes, passenger names are cleanly formatted,
  // ensure debts are parsed into numbers, and exclude any entries whose debt has been reduced to zero or settled
  return entries
    .filter((e) => {
      let rawVal: unknown = e.structure_debt;
      if (rawVal === undefined || rawVal === null || (typeof rawVal === 'string' && rawVal === '')) {
        rawVal = ((e as unknown) as Record<string, unknown>).fee;
      }
      const d = parseDebtAmount(rawVal, e.date || e.manifest_key);
      return d > 0;
    })
    .map((e) => {
      let rawVal: unknown = e.structure_debt;
      if (rawVal === undefined || rawVal === null || (typeof rawVal === 'string' && rawVal === '')) {
        rawVal = ((e as unknown) as Record<string, unknown>).fee;
      }
      const isSpon = isEntrySponsorshipOrUnpaid(e);
      const parsedDate = e.date || (e.manifest_key ? String(e.manifest_key).split('_')[0] : '');

      return {
        ...e,
        date: parsedDate,
        structure: normalizeStructureCode(e.structure),
        passenger_name: sanitizePassengerDisplayName(e.passenger_name) || (e.passenger_name || '').trim(),
        structure_debt: parseDebtAmount(rawVal, parsedDate),
        general_notes: isSpon
          ? (cleanSponsorshipNote(e.general_notes) || e.general_notes || '')
          : cleanPersonalAbsenteeNote(e.general_notes),
        sponsor_note: isSpon
          ? (cleanSponsorshipNote(e.sponsor_note) || e.sponsor_note || '')
          : '',
      };
    });
}

export async function listLedgerByDate(date: string): Promise<LedgerEntry[]> {
  const all = await listLedgerEntries();
  return all.filter((entry) => entry.date === date);
}

export async function deleteLedgerEntry(id: string): Promise<void> {
  try {
    await deleteLedgerOnServer(id);
  } catch (err) {
    console.debug('[Ledger] Server delete note:', err);
  }
  try {
    await supabase.from(LEDGER_TABLE).delete().eq('id', id);
  } catch {
    // local fallback
  }

  // Synchronize local sponsorship audit storage so it never resurrects
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LOCAL_SPONSORSHIPS_KEY) : null;
    if (raw) {
      let audits = JSON.parse(raw) as ReportedSponsorship[];
      let changed = false;
      audits = audits.map((a) => {
        if (a.ledger_entry_id === id) {
          changed = true;
          return {
            ...a,
            status: 'actually_sponsored' as const,
            status_updated_at: new Date().toISOString(),
            ledger_entry_id: null,
            sponsor_note: a.sponsor_note ? `${a.sponsor_note} (Settled / Removed from ledger)` : 'Settled / Removed from ledger',
          };
        }
        return a;
      });
      if (changed) {
        localStorage.setItem(LOCAL_SPONSORSHIPS_KEY, JSON.stringify(audits));
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('crc_sponsorships_updated', { detail: audits }));
        }
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * Settles (removes) a batch of past-cancellation ledger entries in one
 * call — used when a Rep collects R40 cash on behalf of someone with an
 * outstanding cancellation fee during a trip, so that entry no longer
 * appears as owing. No-op if `ids` is empty.
 */
export async function settleLedgerEntries(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await settleLedgerOnServer(ids);
  } catch (err) {
    console.debug('[Ledger] Server settle note:', err);
  }
  try {
    await supabase.from(LEDGER_TABLE).delete().in('id', ids);
  } catch {
    // local fallback
  }

  // Synchronize local sponsorship audit storage
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LOCAL_SPONSORSHIPS_KEY) : null;
    if (raw) {
      const idSet = new Set(ids);
      let audits = JSON.parse(raw) as ReportedSponsorship[];
      let changed = false;
      audits = audits.map((a) => {
        if (idSet.has(a.ledger_entry_id || '')) {
          changed = true;
          return {
            ...a,
            status: 'actually_sponsored' as const,
            status_updated_at: new Date().toISOString(),
            ledger_entry_id: null,
            sponsor_note: a.sponsor_note ? `${a.sponsor_note} (Settled from ledger)` : 'Settled from ledger',
          };
        }
        return a;
      });
      if (changed) {
        localStorage.setItem(LOCAL_SPONSORSHIPS_KEY, JSON.stringify(audits));
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('crc_sponsorships_updated', { detail: audits }));
        }
      }
    }
  } catch {
    /* ignore */
  }
}

export async function updateLedgerEntry(id: string, updates: Partial<LedgerEntry>): Promise<void> {
  // If the debt for this entry is reduced to zero or less, remove the debt entry
  if (updates.structure_debt !== undefined && Number(updates.structure_debt) <= 0) {
    await deleteLedgerEntry(id);
    return;
  }
  try {
    await updateLedgerOnServer(id, updates as Record<string, unknown>);
  } catch (err) {
    console.debug('[Ledger] Server update note:', err);
  }
  try {
    const { error } = await supabase.from(LEDGER_TABLE).update(updates).eq('id', id);
    if (error) console.warn('[Ledger] Supabase update note:', error);
  } catch {
    // local fallback
  }
}

export interface ManualLedgerEntryInput {
  firstName: string;
  surname: string;
  structure: string;
  service: string;
  amount: number;
  date: string;
  notes?: string;
  isSponsored?: boolean;
  debtType?: 'cancellation' | 'unaccounted_sponsorship' | 'unpaid_sponsorship';
}

/**
 * Converts various date formats (e.g. YYYY-MM-DD, DD/MM/YYYY, DD/MM/YY, text dates) into a normalized YYYY-MM-DD string.
 */
export function normalizeDateToYMD(dateStr?: string | null): string {
  if (!dateStr) return '';
  const trimmed = String(dateStr).replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  // Match YYYY-MM-DD even if followed by _ or T or space or end of string
  const ymdMatch = trimmed.match(/(?:^|[^\d])(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?=[^\d]|$)/);
  if (ymdMatch) {
    return `${ymdMatch[1]}-${ymdMatch[2].padStart(2, '0')}-${ymdMatch[3].padStart(2, '0')}`;
  }
  // Match DD-MM-YYYY or MM-DD-YYYY
  const dmyMatch = trimmed.match(/(?:^|[^\d])(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?=[^\d]|$)/);
  if (dmyMatch) {
    return `${dmyMatch[3]}-${dmyMatch[2].padStart(2, '0')}-${dmyMatch[1].padStart(2, '0')}`;
  }
  const part = trimmed.split('_')[0].split('T')[0];
  const partMatch = part.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (partMatch) {
    return `${partMatch[1]}-${partMatch[2].padStart(2, '0')}-${partMatch[3].padStart(2, '0')}`;
  }
  const parsed = parseFlexibleHistoricalDate(trimmed);
  if (parsed) return parsed;
  try {
    const d = new Date(trimmed);
    if (!isNaN(d.getTime())) {
      const year = d.getFullYear();
      if (year >= 2000 && year <= 2100) {
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${m}-${day}`;
      }
    }
  } catch {
    /* ignore */
  }
  return part;
}

/**
 * Inserts a manually created cancellation/debt entry into the cancellation ledger.
 */
export async function addManualLedgerEntry(input: ManualLedgerEntryInput): Promise<LedgerEntry> {
  const fullName = `${input.firstName.trim()} ${input.surname.trim()}`.trim();
  const manifestKey = `manual-${input.date}-${input.service.toLowerCase()}-${Date.now()}`;
  const structureCode = normalizeStructureCode(input.structure);

  const rawAmt = Number(input.amount);
  const defaultDebt = getFareForDate(input.date);
  const debtAmt = Number.isFinite(rawAmt) && rawAmt >= 0 ? rawAmt : defaultDebt;

  const debtType = input.debtType || (input.isSponsored ? 'unaccounted_sponsorship' : 'cancellation');
  const isSponsored = debtType !== 'cancellation';
  let noteText = (input.notes || '').trim();
  if (debtType === 'unaccounted_sponsorship') {
    noteText = noteText && !noteText.toLowerCase().includes('unaccounted')
      ? `Unaccounted Sponsorship: ${noteText}`
      : (noteText || 'Unaccounted Sponsorship');
  } else if (debtType === 'unpaid_sponsorship') {
    noteText = noteText && !noteText.toLowerCase().includes('did not pay')
      ? `Did not pay: ${noteText}`
      : (noteText || 'Did not pay');
  }

  const row = {
    manifest_key: manifestKey,
    date: normalizeDateToYMD(input.date) || input.date,
    service: input.service.trim().toUpperCase() || 'PM',
    passenger_name: fullName,
    stop: 'Manual Entry',
    structure: structureCode,
    vehicle_name: 'Manual Addition',
    submitted_by: 'Cancellation Admin',
    rep_name: '',
    license_plate: '',
    sponsored: isSponsored,
    sponsor_note: isSponsored ? noteText : '',
    structure_debt: debtAmt,
    general_notes: noteText,
  };

  try {
    const serverEntry = await addManualLedgerOnServer(row);
    if (serverEntry) {
      // Also update local store
      try {
        await supabase.from(LEDGER_TABLE).insert([serverEntry]);
      } catch {
        /* ignore local mirror errors */
      }
      return serverEntry;
    }
  } catch (err) {
    console.debug('[Ledger] Server addManual error:', err);
  }

  const { data, error } = await supabase
    .from(LEDGER_TABLE)
    .insert([row])
    .select('*')
    .single();

  if (error) throw error;
  return data as LedgerEntry;
}

export interface DebtorInstanceUpdateItem {
  id?: string;
  date: string;
  service: string;
  amount: number;
}

/**
 * Updates a debtor and synchronizes their individual cancellation instances (dates, services, amounts, and deletions).
 * Allows admin to edit dates, remove a specific date in-between, add new missed dates, or update per-instance debts.
 */
export async function updateDebtorWithInstances(
  existingEntryIds: string[],
  updates: {
    name: string;
    structure: string;
    isSponsored?: boolean;
    debtType?: 'cancellation' | 'unaccounted_sponsorship' | 'unpaid_sponsorship';
    notes?: string;
    instances: DebtorInstanceUpdateItem[];
  }
): Promise<void> {
  const structCode = normalizeStructureCode(updates.structure);
  const cleanName = updates.name.trim();
  const debtType = updates.debtType || (updates.isSponsored ? 'unaccounted_sponsorship' : 'cancellation');
  const isSponsored = debtType !== 'cancellation';

  let finalSponsorNote = '';
  let finalGeneralNotes = '';
  const rawNote = (updates.notes || '').trim();

  if (debtType === 'unaccounted_sponsorship') {
    finalSponsorNote = rawNote && !rawNote.toLowerCase().includes('unaccounted')
      ? `Unaccounted Sponsorship: ${rawNote}`
      : (rawNote || 'Unaccounted Sponsorship');
    finalGeneralNotes = finalSponsorNote;
  } else if (debtType === 'unpaid_sponsorship') {
    finalSponsorNote = rawNote && !rawNote.toLowerCase().includes('did not pay')
      ? `Did not pay: ${rawNote}`
      : (rawNote || 'Did not pay');
    finalGeneralNotes = finalSponsorNote;
  } else {
    finalSponsorNote = '';
    finalGeneralNotes = rawNote;
  }

  // If the person's debt for a particular date or service was reduced to zero, remove that debt
  const activeInstances = (updates.instances || []).filter((inst) => {
    const rawAmt = typeof inst.amount === 'number' ? inst.amount : Number(inst.amount);
    return Number.isFinite(rawAmt) && rawAmt > 0;
  });

  // Synchronize to server
  try {
    await updateDebtorOnServer({
      existingEntryIds,
      updates: {
        name: cleanName,
        structure: structCode,
        isSponsored,
        debtType,
        notes: finalSponsorNote,
        instances: activeInstances,
      },
    });
  } catch (err) {
    console.debug('[Ledger] Server updateDebtor error:', err);
  }

  // If no instances remain (or all debts were reduced to zero), remove all debtor entries completely
  if (activeInstances.length === 0) {
    if (existingEntryIds.length > 0) {
      await supabase.from(LEDGER_TABLE).delete().in('id', existingEntryIds);
    }
    return;
  }

  // Fetch current entries for template fields (manifest_key, vehicle_name, etc.)
  let templateEntry: LedgerEntry | null = null;
  if (existingEntryIds.length > 0) {
    const { data } = await supabase.from(LEDGER_TABLE).select('*').in('id', existingEntryIds);
    if (data && data.length > 0) {
      templateEntry = data[0] as LedgerEntry;
    }
  }

  const updatedIds = new Set<string>();

  // Process each instance in the update payload
  for (const inst of activeInstances) {
    const validAmount = typeof inst.amount === 'number' ? inst.amount : Number(inst.amount);
    const validDate = inst.date ? inst.date.trim() : '';
    const validService = inst.service ? inst.service.trim() : 'PM';

    if (inst.id && existingEntryIds.includes(inst.id)) {
      // Existing instance: update date, service, debt amount, passenger name, structure, etc.
      updatedIds.add(inst.id);
      await supabase
        .from(LEDGER_TABLE)
        .update({
          date: validDate,
          service: validService,
          passenger_name: cleanName,
          structure: structCode,
          structure_debt: validAmount,
          sponsored: isSponsored,
          sponsor_note: finalSponsorNote,
          general_notes: finalGeneralNotes,
          submitted_by: 'Cancellation Admin',
        })
        .eq('id', inst.id);
    } else {
      // New instance added during edit: insert fresh entry
      const insertPayload: Record<string, unknown> = {
        manifest_key: templateEntry?.manifest_key || `manual-${Date.now()}`,
        date: validDate,
        service: validService,
        passenger_name: cleanName,
        stop: templateEntry?.stop || 'Structure Stop',
        structure: structCode,
        vehicle_name: templateEntry?.vehicle_name || '—',
        submitted_by: 'Cancellation Admin',
        rep_name: templateEntry?.rep_name || '',
        license_plate: templateEntry?.license_plate || '',
        sponsored: isSponsored,
        sponsor_note: finalSponsorNote,
        structure_debt: validAmount,
        general_notes: finalGeneralNotes,
      };

      const { data: newEntry } = await supabase
        .from(LEDGER_TABLE)
        .insert([insertPayload])
        .select('id')
        .single();

      if (newEntry?.id) {
        updatedIds.add(newEntry.id);
      }
    }
  }

  // Delete any instances that were removed by the admin (e.g. date removed in between)
  const idsToDelete = existingEntryIds.filter((id) => !updatedIds.has(id));
  if (idsToDelete.length > 0) {
    await supabase.from(LEDGER_TABLE).delete().in('id', idsToDelete);
  }
}

/**
 * Updates a debtor person's details across their ledger entries (e.g. rename, change structure, adjust total debt, notes).
 */
export async function updateDebtorDetails(
  entryIds: string[],
  updates: {
    name?: string;
    structure?: string;
    newTotalDebt?: number;
    notes?: string;
    isSponsored?: boolean;
  }
): Promise<void> {
  if (entryIds.length === 0) return;

  const { data: currentEntries, error: fetchErr } = await supabase
    .from(LEDGER_TABLE)
    .select('*')
    .in('id', entryIds);

  if (fetchErr) throw fetchErr;
  if (!currentEntries || currentEntries.length === 0) return;

  const structCode = updates.structure !== undefined ? normalizeStructureCode(updates.structure) : undefined;

  // If debt amount is updated
  if (updates.newTotalDebt !== undefined) {
    const targetDebt = Math.max(0, updates.newTotalDebt);

    if (targetDebt === 0) {
      // Remove all records if debt is set to 0
      await supabase.from(LEDGER_TABLE).delete().in('id', entryIds);
      return;
    }

    if (currentEntries.length === 1) {
      // Single entry: update debt directly
      await supabase
        .from(LEDGER_TABLE)
        .update({
          passenger_name: updates.name ? updates.name.trim() : currentEntries[0].passenger_name,
          structure: structCode ?? currentEntries[0].structure,
          structure_debt: targetDebt,
          general_notes: updates.isSponsored ? cleanSponsorshipNote(updates.notes) : '',
          sponsored: !!updates.isSponsored,
          sponsor_note: updates.isSponsored ? cleanSponsorshipNote(updates.notes) : '',
        })
        .eq('id', entryIds[0]);
    } else {
      // Multiple entries: scale debt or apply to entries sequentially
      // Sort oldest first
      const sorted = [...currentEntries].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      let debtPool = targetDebt;

      for (let i = 0; i < sorted.length; i++) {
        const ent = sorted[i];
        const isLast = i === sorted.length - 1;
        let rowDebt = 0;

        if (isLast) {
          rowDebt = debtPool;
        } else {
          const defaultDebt = parseDebtAmount(ent.structure_debt);
          rowDebt = Math.min(debtPool, defaultDebt);
          debtPool -= rowDebt;
        }

        if (rowDebt <= 0) {
          // If debt for this date or service is reduced to zero, remove it completely
          await deleteLedgerEntry(ent.id);
        } else {
          await supabase
            .from(LEDGER_TABLE)
            .update({
              passenger_name: updates.name ? updates.name.trim() : ent.passenger_name,
              structure: structCode ?? ent.structure,
              structure_debt: rowDebt,
              general_notes: updates.isSponsored ? cleanSponsorshipNote(updates.notes) : '',
              sponsored: !!updates.isSponsored,
              sponsor_note: updates.isSponsored ? cleanSponsorshipNote(updates.notes) : '',
            })
            .eq('id', ent.id);
        }
      }
    }
  } else {
    // Just update metadata across all entries
    const patch: Record<string, unknown> = {};
    if (updates.name) patch.passenger_name = updates.name.trim();
    if (structCode) patch.structure = structCode;
    if (updates.isSponsored !== undefined) {
      patch.sponsored = updates.isSponsored;
      patch.general_notes = updates.isSponsored ? cleanSponsorshipNote(updates.notes) : '';
      patch.sponsor_note = updates.isSponsored ? cleanSponsorshipNote(updates.notes) : '';
    } else if (updates.notes !== undefined) {
      patch.general_notes = cleanSponsorshipNote(updates.notes);
    }

    if (Object.keys(patch).length > 0) {
      const { error } = await supabase.from(LEDGER_TABLE).update(patch).in('id', entryIds);
      if (error) throw error;
    }
  }
}

/**
 * Applies a partial or full payment against a debtor's aggregated entries.
 * Deducts amountPaid from the oldest entries first. If an entry reaches R0 debt,
 * it is removed/settled. If partially paid, its structure_debt is updated.
 */
export async function recordPartialPayment(entryIds: string[], amountPaid: number): Promise<void> {
  if (entryIds.length === 0 || amountPaid <= 0) return;

  let entries: Array<{ id: string; structure_debt: unknown; date?: string }> = [];
  try {
    const { data, error } = await supabase
      .from(LEDGER_TABLE)
      .select('id, structure_debt, date')
      .in('id', entryIds);
    if (!error && data && data.length > 0) {
      entries = data;
    }
  } catch {
    // fallback to listLedgerEntries
  }

  if (entries.length === 0) {
    const all = await listLedgerEntries();
    entries = all.filter((e) => entryIds.includes(e.id));
  }

  if (entries.length === 0) return;

  // Sort ascending by date (oldest debt settled first)
  const sorted = [...entries].sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  let remainingToDeduct = amountPaid;

  for (const entry of sorted) {
    if (remainingToDeduct <= 0) break;
    const currentDebt = parseDebtAmount(entry.structure_debt, entry.date);

    if (remainingToDeduct >= currentDebt) {
      // Entire entry is paid off
      remainingToDeduct -= currentDebt;
      await deleteLedgerEntry(entry.id);
    } else {
      // Partial deduction on this entry
      const newDebt = currentDebt - remainingToDeduct;
      remainingToDeduct = 0;
      if (newDebt <= 0) {
        await deleteLedgerEntry(entry.id);
      } else {
        await updateLedgerEntry(entry.id, { structure_debt: newDebt });
      }
    }
  }
}

/** A single row parsed from a "Cancellation History" import workbook, ready to insert into cancellation_ledger. */
export interface HistoricalCancellationRow {
  structure: string;
  rep_name?: string;
  date: string; // yyyy-mm-dd or ''
  service: string;
  passenger_name: string;
  structure_debt: number;
  general_notes?: string;
}

export interface HistoricalImportResult {
  rows: HistoricalCancellationRow[];
  totalRows: number;
  imported: number;
  skipped: number;
  warnings: string[];
}

const HISTORICAL_HEADER_ALIASES = {
  structure: ['structure and rep', 'structure and reps', 'structure/rep', 'structure & rep', 'structure', 'struct', 'area rep', 'structure & reps'],
  rep: ['rep', 'reps', 'representative', 'area rep', 'rep name', 'reps name'],
  date: ['cancellation date', 'date', 'dates', 'missed date', 'service date'],
  service: ['service type', 'service', 'service period', 'session', 'type', 'event'],
  passenger_name: ['passenger name', 'name', 'passenger', 'full name', 'debtor', 'debtor name', 'rider name'],
  structure_debt: ['amount owing', 'amount owed', 'amount', 'structure debt', 'debt', 'fee', 'amount due', 'owing', 'total debt'],
  category: ['category', 'classification', 'entry type', 'section', 'status'],
  notes: ['notes', 'note', 'general notes', 'general_notes', 'remarks', 'comment', 'comments', 'extra notes'],
};

function normalizeHeaderCell(h: unknown): string {
  return String(h ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
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
 * a normalized "yyyy-mm-dd" string. Also heals OCR/typing errors like "23008/2026",
 * multi-line text cells (e.g. S16 multiline dates), or date ranges.
 * Returns null if unparseable or blank.
 */
export function parseFlexibleHistoricalDate(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (value instanceof Date && !isNaN(value.getTime())) return formatYMD(value);
  if (typeof value === 'number') {
    const parsed = XLSX.SSF?.parse_date_code?.(value);
    if (parsed) return formatYMD(new Date(parsed.y, parsed.m - 1, parsed.d));
    return null;
  }
  
  // If multiline string, extract the first valid date line/segment
  const lines = String(value).split(/\r?\n|[,;]/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const s = line.replace(/\s+/g, '');
    // Heal typo like "23008/2026" or "2308/2026"
    const cleaned不易 = s.replace(/^(\d{1,2})0+(\d{1,2})\/(\d{4})$/, '$1/$2/$3');

    let m = cleaned不易.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    
    m = cleaned不易.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    
    m = cleaned不易.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})/);
    if (m) return `20${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }

  return null;
}

/**
 * Parses a bulk "Cancellation History" Excel/CSV export into rows ready for
 * importHistoricalCancellations.
 *
 * Supports:
 * - Table merged structure cells (forward fills structure and rep names across consecutive rows)
 * - Automatic extraction of service types (AM, PM, LM, WMP, EF, AD, FW, etc.)
 * - Automatic extraction of FTV / section notes (debt amounts are indicated by the file or admin)
 * - Automatic handling of section/category rows (e.g. "Unaccounted Sponsorship", "Unpaid Sponsorship", "Did not pay")
 * - Does not discard undated entries; imports them cleanly.
 */
export function parseHistoricalCancellationWorkbook(buffer: ArrayBuffer): HistoricalImportResult {
  const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: '' }) as unknown[][];

  if (aoa.length === 0) {
    return { rows: [], totalRows: 0, imported: 0, skipped: 0, warnings: ['File appears to be empty.'] };
  }

  // Find header row (might be row 0 or within the first 6 rows)
  let headerRowIndex = -1;
  let structureCol = -1;
  let repCol = -1;
  let dateCol = -1;
  let nameCol = -1;
  let serviceCol = -1;
  let debtCol = -1;
  let categoryCol = -1;
  let notesCol = -1;

  for (let i = 0; i < Math.min(aoa.length, 6); i++) {
    const row = aoa[i];
    const sCol = findHistoricalColumn(row, HISTORICAL_HEADER_ALIASES.structure);
    const dCol = findHistoricalColumn(row, HISTORICAL_HEADER_ALIASES.date);
    const nCol = findHistoricalColumn(row, HISTORICAL_HEADER_ALIASES.passenger_name);

    if (dCol !== -1 && nCol !== -1) {
      headerRowIndex = i;
      structureCol = sCol;
      repCol = findHistoricalColumn(row, HISTORICAL_HEADER_ALIASES.rep);
      dateCol = dCol;
      nameCol = nCol;
      serviceCol = findHistoricalColumn(row, HISTORICAL_HEADER_ALIASES.service);
      debtCol = findHistoricalColumn(row, HISTORICAL_HEADER_ALIASES.structure_debt);
      categoryCol = findHistoricalColumn(row, HISTORICAL_HEADER_ALIASES.category);
      notesCol = findHistoricalColumn(row, HISTORICAL_HEADER_ALIASES.notes);
      break;
    }
  }

  // If standard headers not found, fallback to positional columns
  if (headerRowIndex === -1) {
    headerRowIndex = 0;
    structureCol = 0;
    dateCol = 1;
    nameCol = 2;
    debtCol = 3;
    serviceCol = -1;
  }

  const dataRows = aoa.slice(headerRowIndex + 1);
  const warnings: string[] = [];
  const rows: HistoricalCancellationRow[] = [];
  let skipped = 0;

  let currentStructure = '';
  let currentRep = '';
  let currentSectionNote = '';

  dataRows.forEach((raw, i) => {
    const rowNum = headerRowIndex + i + 2;

    const cell0 = String(raw[0] ?? '').trim();
    const cell1 = String(raw[1] ?? '').trim();
    const allCellsStr = raw.map((c) => String(c ?? '').trim()).join(' ').toLowerCase();

    // Check if entire row is empty
    if (raw.every((c) => c == null || String(c).trim() === '')) {
      return;
    }

    // Skip summary / grand total rows
    if (allCellsStr.includes('grand total') || allCellsStr.includes('total amount')) {
      return;
    }

    // Check for section headers inside the structure (e.g. "Unaccounted Sponsorships", "Unpaid Sponsorships")
    if (
      allCellsStr.includes('unaccounted sponsorship') ||
      allCellsStr.includes('unpaid sponsorship') ||
      allCellsStr.includes('unaccounted')
    ) {
      currentSectionNote = 'Unaccounted Sponsorship';
      return;
    }

    // Check structure column
    const rawStructureVal = structureCol !== -1 ? String(raw[structureCol] ?? '').trim() : '';
    if (rawStructureVal) {
      const parsedStruct = parseStructureCell(rawStructureVal);
      if (parsedStruct.structure) {
        currentStructure = parsedStruct.structure;
        currentRep = parsedStruct.repName;
        currentSectionNote = '';
      }
    }

    // Check explicit rep column
    const rawRepVal = repCol !== -1 ? String(raw[repCol] ?? '').trim() : '';
    if (rawRepVal && !currentRep) {
      currentRep = rawRepVal;
    }

    const rawDateVal = dateCol !== -1 ? raw[dateCol] : undefined;
    const dateVal = parseFlexibleHistoricalDate(rawDateVal);

    const rawNameVal = nameCol !== -1 ? String(raw[nameCol] ?? '').trim() : '';
    const rawServiceVal = serviceCol !== -1 ? String(raw[serviceCol] ?? '').trim() : '';
    const rawCategoryVal = categoryCol !== -1 ? String(raw[categoryCol] ?? '').trim() : '';
    const rawNotesVal = notesCol !== -1 ? String(raw[notesCol] ?? '').trim() : '';

    // If dateVal and rawNameVal are both missing, check if this is a structure header row
    if (!dateVal && !rawNameVal) {
      if (rawStructureVal) {
        return;
      }
      return;
    }

    if (!rawNameVal) {
      warnings.push(`Row ${rowNum}: skipped — missing passenger name.`);
      skipped++;
      return;
    }

    const finalDate = dateVal || parseFlexibleHistoricalDate(cell0) || parseFlexibleHistoricalDate(cell1) || '';

    // Extract clean name and service code
    const { cleanName, serviceCode } = extractNameAndService(rawNameVal, rawServiceVal);

    // Debt parsing: Read the explicit debt column or fallback to standard fee for this date.
    // For DreamWeek weekdays, the price is R45; for Sunday it is R40.
    const debtRaw = debtCol !== -1 ? raw[debtCol] : undefined;
    let structureDebt = getFareForDate(finalDate);
    if (debtRaw != null && String(debtRaw).trim() !== '') {
      const debtStr = String(debtRaw).replace(/[^\d.]/g, '');
      const parsedDebt = Number(debtStr);
      if (Number.isFinite(parsedDebt) && parsedDebt >= 0) {
        structureDebt = parsedDebt;
      }
    }

    // Category and Notes parsing
    let category = rawCategoryVal;
    if (!category && currentSectionNote) {
      category = currentSectionNote;
    } else if (!category) {
      category = 'Cancellation';
    }

    const noteParts: string[] = [];
    if (category && category.toLowerCase() !== 'cancellation') {
      noteParts.push(category);
    }
    if (rawNotesVal) {
      noteParts.push(rawNotesVal);
    }

    const generalNotes = noteParts.join(' — ');
    const structureToUse = currentStructure || 'Unidentified';

    rows.push({
      structure: structureToUse,
      rep_name: currentRep,
      date: finalDate,
      service: serviceCode || 'PM',
      passenger_name: cleanName || rawNameVal,
      structure_debt: structureDebt,
      general_notes: generalNotes,
    });
  });

  return { rows, totalRows: dataRows.length, imported: rows.length, skipped, warnings };
}

/**
 * Inserts pre-parsed historical cancellation rows directly into the
 * cancellation_ledger table. Unlike insertAbsentees (used for live
 * session submissions), this never deletes existing rows first —
 * historical backfills are purely additive.
 */
export async function importHistoricalCancellations(rows: HistoricalCancellationRow[]): Promise<void> {
  if (rows.length === 0) return;
  const payload = rows.map((r) => {
    const isSponsorship =
      (r.general_notes || '').toLowerCase().includes('sponsorship') ||
      (r.general_notes || '').toLowerCase().includes('unaccounted') ||
      (r.general_notes || '').toLowerCase().includes('unpaid');

    return {
      manifest_key: `historical_${r.date || 'undated'}_${r.service}`.replace(/\s+/g, '_'),
      date: r.date,
      service: r.service,
      passenger_name: r.passenger_name,
      stop: '',
      structure: r.structure,
      vehicle_name: 'Historical Import',
      submitted_by: 'Historical Import',
      rep_name: r.rep_name || '',
      license_plate: '',
      sponsored: isSponsorship,
      sponsor_note: isSponsorship ? cleanSponsorshipNote(r.general_notes) : '',
      structure_debt: r.structure_debt,
      general_notes: cleanSponsorshipNote(r.general_notes),
    };
  });
  const { error } = await supabase.from(LEDGER_TABLE).insert(payload);
  if (error) throw error;
}

export interface AggregatedLedgerInstance {
  id: string;
  date: string;
  service: string;
  serviceCode: string;
  amount: number;
  formatted: string; // e.g. "23/08/26(PM)"
  notes: string;
}

export interface AggregatedLedgerRow {
  key: string;
  structure: string;
  repName: string;
  vehicleName: string;
  name: string;
  service: string;
  serviceCodes: string[];
  formattedServices: string; // e.g. "(PM)" or "(LM, AM, PM)"
  latestDate: string; // yyyy-mm-dd, most recent
  formattedDateList: string; // e.g. "23/08/26(PM), 16/08/26(AM)"
  amount: number;
  entryIds: string[];
  instances: AggregatedLedgerInstance[];
  isSponsorshipOrUnpaid: boolean;
  notes: string;
}

export interface AggregatedLedgerGroup {
  structure: string;
  /** Distinct rep names who submitted debts for this structure, in first-seen order. */
  reps: string[];
  rows: AggregatedLedgerRow[];
  cancellationRows: AggregatedLedgerRow[];
  sponsorshipRows: AggregatedLedgerRow[];
  cancellationDebt: number;
  sponsorshipDebt: number;
  totalDebt: number;
}

/**
 * Determines whether a ledger entry represents an unaccounted sponsorship / unpaid debt
 * or a standard cancellation debt.
 * Per specification:
 * - Only "Did not pay" (unpaid riders) and audited unaccounted sponsorships added
 *   by the cancellation admin via the reported sponsorships section belong in the
 *   sponsorship section of the ledger.
 * - Absentees must NEVER be automatically sent to the sponsorship section.
 */
export function isEntrySponsorshipOrUnpaid(e: {
  id?: string;
  source?: string | null;
  sponsored?: boolean | null;
  general_notes?: string | null;
  sponsor_note?: string | null;
  debtType?: string | null;
  debt_type?: string | null;
  status?: string | null;
}): boolean {
  const idStr = String(e.id || '').toLowerCase();
  const sn = String(e.sponsor_note || '').toLowerCase().trim();
  const gn = String(e.general_notes || '').toLowerCase().trim();
  const src = String(e.source || '').toLowerCase().trim();
  const dt = String((e as Record<string, unknown>).debtType || (e as Record<string, unknown>).debt_type || (e as Record<string, unknown>).status || '').toLowerCase().trim();

  // 1. Unpaid ride debt ("Did not pay")
  if (
    dt === 'unpaid_sponsorship' ||
    sn.includes('did not pay') ||
    sn.includes('unpaid ride') ||
    sn.includes('unpaid sponsorship') ||
    gn.includes('did not pay') ||
    gn.includes('unpaid ride') ||
    gn.includes('unpaid sponsorship')
  ) {
    return true;
  }

  // 2. Unaccounted sponsorships explicitly audited or set by Cancellation Admin:
  if (
    Boolean(e.sponsored) ||
    dt === 'unaccounted_sponsorship' ||
    idStr.startsWith('ledger_sp_') ||
    src === 'reported_sponsorship_audit' ||
    src === 'cancellation_admin' ||
    sn.includes('unaccounted') ||
    gn.includes('unaccounted') ||
    sn.includes('sponsorship') ||
    gn.includes('sponsorship')
  ) {
    return true;
  }

  // Regular absentees (even if marked sponsored on vehicle check-in without admin auditing)
  // are NOT sent into the sponsorship section of the ledger!
  return false;
}

/**
 * Shared aggregation used by both the web Ledger page and the download:
 * groups raw ledger entries by structure (strict alphanumeric order —
 * S1, S2, S9, S13), then by passenger name and category (normal cancellation vs unpaid sponsorship)
 * within each structure. If a person has both normal cancellations and unaccounted sponsorships,
 * they appear separately in both sections so debt types are never erroneously conflated.
 *
 * Accurately tracks each instance's service type (e.g. AM, PM, LM, WMP, EF, AD, FW)
 * so special church event cancellations are clearly displayed in brackets.
 *
 * Segregates entries into regular Cancellations vs Unaccounted Sponsorships & Unpaid.
 */
export function aggregateLedgerEntries(entries: LedgerEntry[]): AggregatedLedgerGroup[] {
  const byStructure = new Map<string, LedgerEntry[]>();
  for (const e of entries) {
    // If debt for this entry is 0 or less, exclude it completely
    const debtVal = parseDebtAmount(e.structure_debt, e.date);
    if (debtVal <= 0) continue;

    const key = normalizeStructureCode(e.structure);
    if (!byStructure.has(key)) byStructure.set(key, []);
    byStructure.get(key)!.push({
      ...e,
      structure: key,
      structure_debt: debtVal,
    });
  }

  const groups: AggregatedLedgerGroup[] = [];
  for (const [structure, structEntries] of byStructure.entries()) {
    // Segregate entries by passenger name AND category (cancellation vs sponsorship/unpaid)
    // so a person with debts in both categories is listed separately in each section.
    const byCategoryAndName = new Map<string, LedgerEntry[]>();
    for (const e of structEntries) {
      const isSponsorship = isEntrySponsorshipOrUnpaid(e);
      const catKey = isSponsorship ? 'sponsorship' : 'cancellation';
      const cleanName = sanitizePassengerDisplayName(e.passenger_name) || (e.passenger_name || '').trim();
      const nameKey = `${cleanName.toLowerCase().replace(/\s+/g, ' ')}:::${catKey}`;
      if (!byCategoryAndName.has(nameKey)) byCategoryAndName.set(nameKey, []);
      byCategoryAndName.get(nameKey)!.push({
        ...e,
        passenger_name: cleanName,
      });
    }

    const rows: AggregatedLedgerRow[] = Array.from(byCategoryAndName.values()).map((group) => {
      // Sort individual instances in chronological order ascending (Jan 1 first, Dec 31 last)
      const sorted = [...group].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      const earliest = sorted[0];
      const latest = sorted[sorted.length - 1];

      // Collect distinct service codes
      const serviceCodesSet = new Set<string>();
      const instances: AggregatedLedgerInstance[] = sorted
        .filter((e) => parseDebtAmount(e.structure_debt, e.date, e.service, (e as { legs?: string }).legs) > 0)
        .map((e) => {
          const code = serviceCodeForEntry(e);
          serviceCodesSet.add(code);

          // Format date into dd/mm/yy or 'Undated'
          let dStr = e.date ? e.date : 'Undated';
          if (e.date && e.date.includes('-')) {
            const parts = e.date.split('-');
            if (parts.length === 3) {
              dStr = `${parts[2].slice(-2)}/${parts[1]}/${parts[0].slice(2)}`;
            }
          }
          const instDebt = parseDebtAmount(e.structure_debt, e.date, e.service, (e as { legs?: string }).legs);

          return {
            id: e.id,
            date: e.date,
            service: e.service,
            serviceCode: code,
            amount: instDebt,
            formatted: `${dStr}(${code})`,
            notes: e.general_notes || e.sponsor_note || '',
          };
        });

      // Total debtor amount is the exact sum of all valid active instance debts
      const amount = instances.reduce((sum, inst) => sum + inst.amount, 0);

      const serviceCodes = Array.from(serviceCodesSet);
      const formattedServices = serviceCodes.length > 0 ? `(${serviceCodes.join(', ')})` : '';
      const formattedDateList = instances.map((ins) => ins.formatted).join(', ');

      const isSponsorshipOrUnpaid = group.some((e) => isEntrySponsorshipOrUnpaid(e));

      const combinedNotes = Array.from(
        new Set(group.map((e) => cleanSponsorshipNote(e.general_notes || e.sponsor_note)).filter(Boolean))
      ).join('; ');

      const finalRowNotes = combinedNotes || (isSponsorshipOrUnpaid ? 'Unaccounted Sponsorship' : '');

      const displayName = latest.passenger_name || earliest.passenger_name;

      return {
        key: `${structure}-${displayName}-${isSponsorshipOrUnpaid ? 'sponsorship' : 'cancellation'}`,
        structure,
        repName: latest.rep_name || latest.submitted_by || '—',
        vehicleName: latest.vehicle_name || '—',
        name: displayName,
        service: latest.service,
        serviceCodes,
        formattedServices,
        latestDate: earliest.date || latest.date,
        formattedDateList,
        amount,
        entryIds: instances.map((ins) => ins.id),
        instances,
        isSponsorshipOrUnpaid,
        notes: finalRowNotes,
      };
    })
    .filter((r) => r.amount > 0 && r.instances.length > 0)
    .sort((a, b) => {
      // Order people with highest debt at the top (descending debt amount)
      if (b.amount !== a.amount) {
        return b.amount - a.amount;
      }
      // For tie-breaking debts: earliest date ascending (1st Jan first, 31st Dec last)
      const dateDiff = (a.latestDate || '').localeCompare(b.latestDate || '');
      if (dateDiff !== 0) return dateDiff;
      return a.name.localeCompare(b.name);
    });

    const reps: string[] = [];
    for (const row of rows) {
      if (row.repName && row.repName !== '—' && !reps.includes(row.repName)) {
        reps.push(row.repName);
      }
    }

    const cancellationRows = rows.filter((r) => !r.isSponsorshipOrUnpaid);
    const sponsorshipRows = rows.filter((r) => r.isSponsorshipOrUnpaid);
    const cancellationDebt = cancellationRows.reduce((sum, r) => sum + r.amount, 0);
    const sponsorshipDebt = sponsorshipRows.reduce((sum, r) => sum + r.amount, 0);

    groups.push({
      structure,
      reps,
      rows,
      cancellationRows,
      sponsorshipRows,
      cancellationDebt,
      sponsorshipDebt,
      totalDebt: cancellationDebt + sponsorshipDebt,
    });
  }

  return groups.sort((a, b) => structureSortComparator(a.structure, b.structure));
}

/**
 * Downloads the Cancellation Ledger as an Excel workbook laid out to match
 * the official "2026 SZ Cancellation List": a cover section with the
 * policy rules and ABSA banking details, followed by the strict 4-column
 * table (Structure and rep / Cancellation date / Name / Amount owing).
 *
 * Accurately formats the Name column with the service type in brackets e.g. "Linathi Mpako (PM)"
 * or "Thembi Qobo (LM)" or "Nonkululeko Dhlamini (WMP)".
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
    ['Structure and rep', 'Cancellation date', 'Name', 'Amount owing', 'Category / Notes'],
  ];

  for (const group of groups) {
    const repSuffix = group.reps.length > 0 ? ` - ${group.reps.join(', ')}` : '';
    const structureHeader = `${group.structure}${repSuffix}`;

    // 1. Regular cancellations
    for (const row of group.cancellationRows) {
      const serviceDisplay = row.serviceCodes.length > 0 ? `(${row.serviceCodes.join(', ')})` : '';
      const nameWithService = serviceDisplay ? `${row.name} ${serviceDisplay}` : row.name;

      aoa.push([
        structureHeader,
        row.formattedDateList || shortDate(row.latestDate),
        nameWithService,
        `R${row.amount}`,
        row.notes || 'Cancellation',
      ]);
    }

    // 2. Unaccounted Sponsorships & Unpaid
    if (group.sponsorshipRows.length > 0) {
      aoa.push([
        `${structureHeader} — Unaccounted Sponsorships / Unpaid`,
        '',
        '',
        '',
        '',
      ]);
      for (const row of group.sponsorshipRows) {
        const serviceDisplay = row.serviceCodes.length > 0 ? `(${row.serviceCodes.join(', ')})` : '';
        const nameWithService = serviceDisplay ? `${row.name} ${serviceDisplay}` : row.name;

        aoa.push([
          structureHeader,
          row.formattedDateList || shortDate(row.latestDate),
          nameWithService,
          `R${row.amount}`,
          cleanSponsorshipNote(row.notes),
        ]);
      }
    }
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 32 }, { wch: 28 }, { wch: 35 }, { wch: 14 }, { wch: 30 }];
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

const LOCAL_SPONSORSHIPS_KEY = 'crc_sponsorship_audits';

export interface RecordSponsorshipInput {
  id: string;
  fullName: string;
  structure?: string;
  stop?: string;
  sponsorNote?: string;
}

export interface StructureSponsorshipGroup {
  structure: string;
  items: ReportedSponsorship[];
  pendingCount: number;
  actuallySponsoredCount: number;
  debtCount: number;
}

/**
 * Groups sponsorships by structure for clear administrative review.
 * Automatically deduplicates sponsees so identical passenger records are unified.
 */
export function groupSponsorshipsByStructure(
  items: ReportedSponsorship[]
): StructureSponsorshipGroup[] {
  const cleanedItems = cleanAndDeduplicateSponsorships(items);
  const map = new Map<string, ReportedSponsorship[]>();

  for (const item of cleanedItems) {
    const struct = normalizeStructureCode(item.structure);
    if (!map.has(struct)) {
      map.set(struct, []);
    }
    map.get(struct)!.push(item);
  }

  const groups: StructureSponsorshipGroup[] = [];
  for (const [structure, groupItems] of map.entries()) {
    // Sort items within group: pending first, then alphabetically by name
    groupItems.sort((a, b) => {
      if (a.status === 'pending' && b.status !== 'pending') return -1;
      if (a.status !== 'pending' && b.status === 'pending') return 1;
      return a.passenger_name.localeCompare(b.passenger_name);
    });

    const pendingCount = groupItems.filter((i) => i.status === 'pending').length;
    const actuallySponsoredCount = groupItems.filter((i) => i.status === 'actually_sponsored').length;
    const debtCount = groupItems.filter((i) => i.status === 'unpaid_sponsorship' || i.status === 'unaccounted_sponsorship').length;
    groups.push({
      structure,
      items: groupItems,
      pendingCount,
      actuallySponsoredCount,
      debtCount,
    });
  }

  return groups.sort((a, b) => structureSortComparator(a.structure, b.structure));
}

/**
 * Normalizes passenger names, fills in structure/stop details, and merges duplicates
 * so corrupted slug names or duplicate session entries are cleanly unified.
 */
export function cleanAndDeduplicateSponsorships(
  items: ReportedSponsorship[],
  knownSignups?: Array<{ id: string; fullName: string; stop?: string; structure?: string }>
): ReportedSponsorship[] {
  const result: ReportedSponsorship[] = [];

  for (const item of items) {
    let cleanName = sanitizePassengerDisplayName(item.passenger_name);
    let structure = normalizeStructureCode(item.structure);
    let stop = (item.stop || '').trim();

    // Match with known signups to recover structure and proper capitalization
    if (knownSignups && knownSignups.length > 0) {
      const match = knownSignups.find((s) => {
        if (item.passenger_id && s.id.toLowerCase() === item.passenger_id.toLowerCase()) return true;
        const normSignupName = s.fullName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
        const normItemName = cleanName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
        return normSignupName === normItemName || s.fullName.trim().toLowerCase() === cleanName.toLowerCase();
      });
      if (match) {
        cleanName = match.fullName.trim();
        if ((!structure || structure === 'No Structure' || structure === 'Unidentified') && match.structure) {
          structure = normalizeStructureCode(match.structure);
        }
        if (!stop && match.stop) {
          stop = match.stop.trim();
        }
      }
    }

    const rawDate = item.date || item.manifest_key || '';
    const cleanDate = normalizeDateToYMD(rawDate) || rawDate.split('_')[0].split('T')[0];
    const normName = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const canonicalId = `sp_${cleanDate}_${normName}`;

    // Comprehensive deduplication search - strictly scoped to session date
    const existingIdx = result.findIndex((existing) => {
      if (item.id && existing.id && item.id === existing.id) return true;
      if (item.ledger_entry_id && existing.ledger_entry_id && String(item.ledger_entry_id) === String(existing.ledger_entry_id)) {
        return true;
      }

      const existDate = normalizeDateToYMD(existing.date || existing.manifest_key) || (existing.date || existing.manifest_key || '').split('_')[0].split('T')[0];
      const existNormName = sanitizePassengerDisplayName(existing.passenger_name).toLowerCase().replace(/[^a-z0-9]/g, '');
      const existCanonicalId = `sp_${existDate}_${existNormName}`;
      if (canonicalId && existCanonicalId && canonicalId === existCanonicalId) return true;

      const isSameDate =
        (!cleanDate && !existDate) ||
        (cleanDate && existDate && cleanDate === existDate) ||
        (item.manifest_key && existing.manifest_key && (item.manifest_key === existing.manifest_key || item.manifest_key.startsWith(existDate) || existing.manifest_key.startsWith(cleanDate))) ||
        (cleanDate && existing.manifest_key && existing.manifest_key.startsWith(cleanDate)) ||
        (existDate && item.manifest_key && item.manifest_key.startsWith(existDate));
      if (!isSameDate) return false;

      if (item.passenger_id && existing.passenger_id && String(item.passenger_id) === String(existing.passenger_id)) {
        return true;
      }
      return existNormName === normName;
    });

    if (existingIdx >= 0) {
      const existing = result[existingIdx];
      // Keep verified status if existing or incoming item was already verified/indicated
      const resolvedStatus = (existing.status && existing.status !== 'pending')
        ? existing.status
        : (item.status && item.status !== 'pending' ? item.status : 'pending');
      const resolvedStatusTime = (existing.status && existing.status !== 'pending'
        ? existing.status_updated_at
        : item.status_updated_at) || existing.status_updated_at || item.status_updated_at;
      result[existingIdx] = {
        ...existing,
        passenger_name: cleanName,
        structure: (existing.structure && existing.structure !== 'No Structure') ? existing.structure : structure,
        stop: existing.stop || stop,
        vehicle_name: existing.vehicle_name || item.vehicle_name,
        rep_name: existing.rep_name || item.rep_name,
        sponsor_note: cleanSponsorshipNote(existing.sponsor_note) || cleanSponsorshipNote(item.sponsor_note) || '',
        status: resolvedStatus,
        status_updated_at: resolvedStatusTime,
        ledger_entry_id: existing.ledger_entry_id || item.ledger_entry_id,
        date: cleanDate || existing.date || item.date,
      };
    } else {
      result.push({
        ...item,
        passenger_name: cleanName,
        structure,
        stop,
        date: cleanDate || item.date,
      });
    }
  }

  return result;
}

/**
 * Records reported sponsorships from attendance check-in into the central Supabase store
 * with localStorage as an offline fallback cache.
 * Re-submitting or updating attendance replaces any previous pending records cleanly.
 */
export async function recordReportedSponsorships(
  manifestKey: string,
  date: string,
  serviceLabel: string,
  sponsoredRiders: RecordSponsorshipInput[],
  allRiderNames: string[],
  vehicleName: string,
  repName: string
): Promise<void> {
  const now = new Date().toISOString();
  const normalizedRoster = new Set(allRiderNames.map((n) => sanitizePassengerDisplayName(n).toLowerCase()));

  // 1. Primary: Clean up prior pending records in Supabase for this vehicle session
  try {
    const { data: existingRows } = await supabase
      .from(SPONSORSHIPS_TABLE)
      .select('id, manifest_key, date, passenger_name, status')
      .eq('status', 'pending')
      .eq('manifest_key', manifestKey);

    if (Array.isArray(existingRows) && existingRows.length > 0) {
      const idsToDelete = existingRows
        .filter((s) => normalizedRoster.has(sanitizePassengerDisplayName(s.passenger_name).toLowerCase()))
        .map((s) => s.id);

      if (idsToDelete.length > 0) {
        await supabase.from(SPONSORSHIPS_TABLE).delete().in('id', idsToDelete);
      }
    }
  } catch (err) {
    console.warn('[Ledger] Note: could not delete prior pending sponsorships from Supabase:', err);
  }

  // 2. Build rows for newly reported sponsorships
  const upsertRows: ReportedSponsorship[] = [];
  for (const r of sponsoredRiders) {
    const cleanName = sanitizePassengerDisplayName(r.fullName);
    if (!cleanName) continue;
    const normName = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const cleanDate = normalizeDateToYMD(date || manifestKey) || (date || manifestKey).split('_')[0];
    const sessionTag = manifestKey.replace(/[^a-zA-Z0-9]/g, '_');
    const id = `sp_${sessionTag}_${normName}`;

    upsertRows.push({
      id,
      manifest_key: manifestKey,
      date: cleanDate,
      service: serviceLabel,
      passenger_id: r.id || '',
      passenger_name: cleanName,
      structure: normalizeStructureCode(r.structure),
      stop: (r.stop || '').trim(),
      vehicle_name: vehicleName,
      rep_name: repName,
      sponsor_note: (r.sponsorNote || '').trim(),
      status: 'pending',
      submitted_at: now,
    });
  }

  // 3. Upsert to Supabase & Central Server
  if (upsertRows.length > 0) {
    try {
      await recordReportedSponsorshipsOnServer(upsertRows);
    } catch {
      /* ignore server error */
    }

    try {
      const { error: upsertErr } = await supabase
        .from(SPONSORSHIPS_TABLE)
        .upsert(upsertRows, { onConflict: 'id' });
      if (upsertErr) {
        console.warn('[Ledger] Supabase sponsorship upsert note:', upsertErr);
      }
    } catch (err) {
      console.warn('[Ledger] Failed to upsert sponsorships into Supabase:', err);
    }
  }

  // 4. Update local storage cache as offline fallback
  try {
    let localList: ReportedSponsorship[] = [];
    const raw = localStorage.getItem(LOCAL_SPONSORSHIPS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) localList = parsed;
    }

    if (allRiderNames.length > 0) {
      localList = localList.filter((s) => {
        const isSameSession = s.manifest_key === manifestKey;
        const isRider = normalizedRoster.has(sanitizePassengerDisplayName(s.passenger_name).toLowerCase());
        return !(isSameSession && isRider && s.status === 'pending');
      });
    }

    for (const row of upsertRows) {
      const idx = localList.findIndex((s) => s.id === row.id);
      if (idx >= 0) {
        const existingStatus = localList[idx].status;
        const keepStatus = existingStatus && existingStatus !== 'pending' ? existingStatus : (row.status || 'pending');
        localList[idx] = {
          ...localList[idx],
          ...row,
          status: keepStatus,
          status_updated_at: existingStatus !== 'pending' ? localList[idx].status_updated_at : row.status_updated_at,
          ledger_entry_id: localList[idx].ledger_entry_id || row.ledger_entry_id,
        };
      } else {
        localList.push(row);
      }
    }

    localList = cleanAndDeduplicateSponsorships(localList);
    localStorage.setItem(LOCAL_SPONSORSHIPS_KEY, JSON.stringify(localList));

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('crc_sponsorships_updated', { detail: localList }));
    }
  } catch (err) {
    console.warn('[Ledger] Failed to update local sponsorships cache:', err);
  }
}

/**
 * Withdraws pending reported sponsorships when a rep reopens attendance for editing.
 */
export async function withdrawReportedSponsorships(
  manifestKey: string,
  riderNames: string[]
): Promise<void> {
  if (riderNames.length === 0) return;
  const normalizedRoster = new Set(riderNames.map((n) => sanitizePassengerDisplayName(n).toLowerCase()));

  // 1. Delete pending rows from Supabase scoped strictly to this manifest session
  try {
    const { data: existingRows } = await supabase
      .from(SPONSORSHIPS_TABLE)
      .select('id, manifest_key, date, passenger_name, status')
      .eq('status', 'pending')
      .eq('manifest_key', manifestKey);

    if (Array.isArray(existingRows) && existingRows.length > 0) {
      const idsToDelete = existingRows
        .filter((s) => normalizedRoster.has(sanitizePassengerDisplayName(s.passenger_name).toLowerCase()))
        .map((s) => s.id);

      if (idsToDelete.length > 0) {
        await supabase.from(SPONSORSHIPS_TABLE).delete().in('id', idsToDelete);
      }
    }
  } catch (err) {
    console.warn('[Ledger] Failed to delete pending sponsorships from Supabase:', err);
  }

  // 2. Update local storage cache
  try {
    const raw = localStorage.getItem(LOCAL_SPONSORSHIPS_KEY);
    if (raw) {
      const list = JSON.parse(raw) as ReportedSponsorship[];
      const filtered = list.filter((s) => {
        const isSameSession = s.manifest_key === manifestKey;
        const isRider = normalizedRoster.has(sanitizePassengerDisplayName(s.passenger_name).toLowerCase());
        return !(isSameSession && isRider && s.status === 'pending');
      });

      const cleaned = cleanAndDeduplicateSponsorships(filtered);
      localStorage.setItem(LOCAL_SPONSORSHIPS_KEY, JSON.stringify(cleaned));
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('crc_sponsorships_updated', { detail: cleaned }));
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * Records a single individual sponsorship claim (e.g. when rep toggles Sponsored or adds cross-sponsorship).
 * Instantly synchronizes with Supabase sponsorship_audits, server, and local storage.
 */
export async function recordSingleSponsorshipClaim(claim: {
  passenger_id?: string;
  passenger_name: string;
  structure?: string;
  stop?: string;
  vehicle_name: string;
  date: string;
  service: string;
  manifest_key?: string;
  sponsor_note?: string;
  rep_name?: string;
  status?: SponsorshipStatus;
}): Promise<void> {
  const cleanName = sanitizePassengerDisplayName(claim.passenger_name);
  if (!cleanName) return;
  const cleanDate = normalizeDateToYMD(claim.date) || claim.date.split('_')[0];
  const normName = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const id = `sp_${cleanDate}_${normName}`;
  const now = new Date().toISOString();

  const record: ReportedSponsorship = {
    id,
    manifest_key: claim.manifest_key || `${cleanDate}_${claim.service.replace(/\s+/g, '_')}`,
    date: cleanDate,
    service: claim.service,
    passenger_id: claim.passenger_id || '',
    passenger_name: cleanName,
    structure: normalizeStructureCode(claim.structure),
    stop: (claim.stop || '').trim(),
    vehicle_name: claim.vehicle_name || 'Vehicle',
    rep_name: claim.rep_name || 'Transport Rep',
    sponsor_note: cleanSponsorshipNote(claim.sponsor_note),
    status: claim.status || 'pending',
    submitted_at: now,
  };

  // 1. Save to Supabase (try SPONSORSHIPS_TABLE and fallback to reported_sponsorships)
  try {
    const { error } = await supabase.from(SPONSORSHIPS_TABLE).upsert([record], { onConflict: 'id' });
    if (error) {
      try {
        await supabase.from('reported_sponsorships').upsert([record], { onConflict: 'id' });
      } catch {
        /* ignore fallback error */
      }
    }
  } catch (err) {
    console.debug('[Ledger] Supabase single sponsorship claim note:', err);
  }

  // 2. Save to central server API
  try {
    await recordReportedSponsorshipsOnServer([record]);
  } catch {
    /* ignore server error */
  }

  // 3. Update localStorage
  try {
    const raw = localStorage.getItem(LOCAL_SPONSORSHIPS_KEY);
    let list: ReportedSponsorship[] = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) list = [];
    const idx = list.findIndex((s) => s.id === record.id);
    if (idx >= 0) {
      const existingStatus = list[idx].status;
      const keepStatus = existingStatus && existingStatus !== 'pending' ? existingStatus : (record.status || 'pending');
      list[idx] = {
        ...list[idx],
        ...record,
        status: keepStatus,
        status_updated_at: existingStatus !== 'pending' ? list[idx].status_updated_at : record.status_updated_at,
        ledger_entry_id: list[idx].ledger_entry_id || record.ledger_entry_id,
      };
    } else {
      list.push(record);
    }
    list = cleanAndDeduplicateSponsorships(list);
    localStorage.setItem(LOCAL_SPONSORSHIPS_KEY, JSON.stringify(list));
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('crc_sponsorships_updated', { detail: list }));
    }
  } catch {
    /* ignore */
  }
}

/**
 * Withdraws a single pending sponsorship claim when a rep un-toggles sponsored.
 */
export async function withdrawSingleSponsorshipClaim(
  date: string,
  passengerName: string
): Promise<void> {
  const cleanName = sanitizePassengerDisplayName(passengerName);
  if (!cleanName) return;
  const cleanDate = normalizeDateToYMD(date) || date.split('_')[0];
  const normName = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const id = `sp_${cleanDate}_${normName}`;

  try {
    await supabase.from(SPONSORSHIPS_TABLE).delete().eq('id', id).eq('status', 'pending');
  } catch {
    /* ignore */
  }

  try {
    const raw = localStorage.getItem(LOCAL_SPONSORSHIPS_KEY);
    if (raw) {
      const list = JSON.parse(raw) as ReportedSponsorship[];
      const filtered = list.filter((s) => !(s.id === id && s.status === 'pending'));
      localStorage.setItem(LOCAL_SPONSORSHIPS_KEY, JSON.stringify(filtered));
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('crc_sponsorships_updated', { detail: filtered }));
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * Fetches all reported sponsorships from Supabase using pagination.
 */
export async function fetchAllSponsorshipsFromSupabase(): Promise<ReportedSponsorship[]> {
  const allRows: ReportedSponsorship[] = [];
  const pageSize = 1000;
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from(SPONSORSHIPS_TABLE)
      .select('*')
      .order('submitted_at', { ascending: false })
      .range(from, from + pageSize - 1);

    if (error || !data || data.length === 0) {
      break;
    }
    allRows.push(...(data as ReportedSponsorship[]));
    if (data.length < pageSize) {
      break;
    }
    from += pageSize;
  }
  return allRows;
}

/**
 * Retrieves all reported sponsorships for administrative verification.
 * Primary source of truth is the Supabase sponsorship_audits table.
 * Automatically harvests sponsorships from existing submitted manifests/drafts
 * so any sponsorships already submitted immediately appear and get persisted!
 */
export async function listReportedSponsorships(): Promise<ReportedSponsorship[]> {
  let list: ReportedSponsorship[] = [];

  // 1. Primary: Central Express Server API (contains cross-device reported sponsorships)
  try {
    const serverSponsees = await listReportedSponsorshipsFromServer();
    if (serverSponsees && serverSponsees.length > 0) {
      list = serverSponsees;
    }
  } catch (err) {
    console.debug('[Ledger] Server fetch sponsorships note:', err);
  }

  // 2. Secondary: Supabase table sponsorship_audits with full pagination
  try {
    const supaRows = await fetchAllSponsorshipsFromSupabase();
    if (supaRows.length > 0) {
      list = cleanAndDeduplicateSponsorships([...list, ...supaRows]);
    }
  } catch (err) {
    console.debug('[Ledger] Supabase listReportedSponsorships note:', err);
  }

  // 3. LocalStorage fallback
  if (list.length === 0) {
    try {
      const raw = localStorage.getItem(LOCAL_SPONSORSHIPS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) list = parsed;
      }
    } catch {
      /* ignore */
    }
  }

  // Collect all known signups across stored manifests for rich name/structure recovery
  interface StoredManifest {
    date: string;
    signups?: Array<{ id: string; fullName: string; structure?: string; stop?: string; sponsored?: boolean; sponsorNote?: string }>;
    vehicles?: Array<{
      id: string;
      name: string;
      submitted?: boolean;
      submittedAt?: string;
      submittedBy?: string;
      repName?: string;
      riders?: string[];
      draftState?: { sponsoredIds?: string[]; notes?: Record<string, string>; submitted?: boolean; externalSponsees?: unknown[] };
    }>;
  }
  const manifestsTable = (mockStorage.getTable(MANIFESTS_TABLE) as unknown as StoredManifest[]) || [];

  // Also harvest manifests directly from remote Supabase transport_manifests table so all historical signups are loaded
  try {
    const { data: remoteManifests } = await supabase
      .from(MANIFESTS_TABLE)
      .select('date, signups, vehicles');
    if (Array.isArray(remoteManifests)) {
      for (const rm of remoteManifests) {
        if (!manifestsTable.some((m) => m.date === rm.date)) {
          manifestsTable.push(rm as unknown as StoredManifest);
        }
      }
    }
  } catch {
    /* ignore */
  }
  const allKnownSignups: Array<{ id: string; fullName: string; stop?: string; structure?: string }> = [];
  for (const m of manifestsTable) {
    if (Array.isArray(m.signups)) {
      for (const s of m.signups) {
        allKnownSignups.push({
          id: s.id,
          fullName: s.fullName,
          stop: s.stop,
          structure: s.structure,
        });
      }
    }
  }

  // 3b. Reconcile with local ledger table to guarantee confirmed debts/indications are never lost
  try {
    const localLedgerRows = (mockStorage.getTable(LEDGER_TABLE) as unknown as LedgerEntry[]) || [];
    for (const entry of localLedgerRows) {
      const origGn = typeof entry.general_notes === 'string' ? entry.general_notes : '';
      const origSn = typeof entry.sponsor_note === 'string' ? entry.sponsor_note : '';
      const isUnpaid = /did not pay|unpaid/i.test(origGn) || /did not pay|unpaid/i.test(origSn);
      const isUnaccounted = /unaccounted/i.test(origGn) || /unaccounted/i.test(origSn);
      const isActually = /actually\s*sponsored/i.test(origGn) || /actually\s*sponsored/i.test(origSn);
      const isSponsored = Boolean(entry.sponsored) || isUnpaid || isUnaccounted || isActually || /sponsor/i.test(origGn) || /sponsor/i.test(origSn);
      if (!isSponsored) continue;

      const cleanName = sanitizePassengerDisplayName(entry.passenger_name);
      if (!cleanName) continue;
      const cleanDate = normalizeDateToYMD(entry.date || entry.manifest_key);
      const normName = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '');
      const id = `sp_${cleanDate}_${normName}`;
      const targetStatus: SponsorshipStatus = isActually ? 'actually_sponsored' : (isUnpaid ? 'unpaid_sponsorship' : 'unaccounted_sponsorship');

      const existingIdx = list.findIndex((a) => {
        if (a.id && (a.id === id || a.id === String(entry.id))) return true;
        if (a.ledger_entry_id && String(a.ledger_entry_id) === String(entry.id)) return true;
        const aDate = normalizeDateToYMD(a.date || a.manifest_key);
        const aNorm = sanitizePassengerDisplayName(a.passenger_name).toLowerCase().replace(/[^a-z0-9]/g, '');
        return aNorm === normName && (!cleanDate || !aDate || aDate === cleanDate);
      });

      if (existingIdx >= 0) {
        if (list[existingIdx].status === 'pending') {
          list[existingIdx].status = targetStatus;
          list[existingIdx].ledger_entry_id = String(entry.id);
        }
      } else {
        list.push({
          id,
          manifest_key: entry.manifest_key || '',
          date: cleanDate || entry.date,
          service: entry.service || 'Service',
          passenger_name: cleanName,
          structure: normalizeStructureCode(entry.structure),
          stop: entry.stop || '',
          vehicle_name: entry.vehicle_name || '—',
          rep_name: entry.rep_name || entry.submitted_by || 'Rep',
          sponsor_note: cleanSponsorshipNote(origSn || origGn) || origSn || origGn,
          status: targetStatus,
          status_updated_at: entry.submitted_at || new Date().toISOString(),
          ledger_entry_id: String(entry.id),
          submitted_at: entry.submitted_at || new Date().toISOString(),
        });
      }
    }
  } catch (err) {
    console.debug('[Ledger] Local ledger sponsorship sync note:', err);
  }

  // 4. Self-healing harvest: recover any sponsorships from submitted manifests in local storage
  try {
    let harvestedNew = false;
    const harvestedRows: ReportedSponsorship[] = [];
    const existingKeys = new Set<string>();
    list.forEach((s) => {
      const baseDate = normalizeDateToYMD(s.date || s.manifest_key) || s.date?.split('_')[0] || s.manifest_key?.split('_')[0] || '';
      const normName = sanitizePassengerDisplayName(s.passenger_name).toLowerCase().replace(/[^a-z0-9]/g, '');
      if (baseDate && normName) existingKeys.add(`${baseDate}::${normName}`);
      if (s.id) existingKeys.add(s.id);
      if (baseDate && normName) existingKeys.add(`sp_${baseDate}_${normName}`);
      if (s.passenger_id) existingKeys.add(`pid_${s.passenger_id}`);
      if (s.ledger_entry_id) existingKeys.add(`lid_${s.ledger_entry_id}`);
    });

    // A. Check mockStorage manifests (both submitted vehicles and in-progress drafts, plus cross-taxi external sponsees)
    for (const m of manifestsTable) {
      if (!m.date) continue;
      const parsedDate = m.date.split('_')[0] || m.date;
      const parsedService = m.date.split('_')[1]?.replace(/_/g, ' ') || 'Service';
      const allSignups = Array.isArray(m.signups) ? m.signups : [];

      for (const v of m.vehicles || []) {
        const vehicleRiderIds = new Set((v.riders || []).map(String));
        const vehicleSignups = allSignups.filter((p) => vehicleRiderIds.has(String(p.id)));
        const rep = v.repName || v.submittedBy || 'Transport Rep';
        const sponsoredIds = new Set((v.draftState?.sponsoredIds || []).map(String));
        const notes = v.draftState?.notes || {};

        for (const p of vehicleSignups) {
          const sId = String(p.id);
          const isSponsored = Boolean(p.sponsored || sponsoredIds.has(sId) || sponsoredIds.has(p.id));
          if (!isSponsored) continue;

          const cleanName = sanitizePassengerDisplayName(p.fullName);
          if (!cleanName) continue;
          const baseDate = normalizeDateToYMD(parsedDate) || parsedDate.split('_')[0];
          const normName = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '');
          const lookupKey = `${baseDate}::${normName}`;
          const id = `sp_${baseDate}_${normName}`;
          if (existingKeys.has(lookupKey) || existingKeys.has(id) || (p.id && existingKeys.has(`pid_${p.id}`))) continue;

          const alreadyExists = list.some((existing) => {
            if (existing.id && (existing.id === id || (p.id && existing.passenger_id && String(p.id) === String(existing.passenger_id)))) return true;
            const existDate = normalizeDateToYMD(existing.date || existing.manifest_key);
            const isSameDate = (!baseDate && !existDate) || (baseDate && existDate && baseDate === existDate) || (m.date && existing.manifest_key && (m.date === existing.manifest_key || m.date.startsWith(existDate) || existing.manifest_key.startsWith(baseDate)));
            if (!isSameDate) return false;
            const existNorm = sanitizePassengerDisplayName(existing.passenger_name).toLowerCase().replace(/[^a-z0-9]/g, '');
            return existNorm === normName;
          });
          if (alreadyExists) continue;

          const sponsorNote = (notes[sId] || notes[p.id] || p.sponsorNote || '').trim();
          const newSpon: ReportedSponsorship = {
            id,
            manifest_key: m.date,
            date: parsedDate,
            service: parsedService,
            passenger_id: p.id,
            passenger_name: cleanName,
            structure: normalizeStructureCode(p.structure),
            stop: (p.stop || '').trim(),
            vehicle_name: v.name || 'Vehicle',
            rep_name: rep,
            sponsor_note: cleanSponsorshipNote(sponsorNote),
            status: 'pending',
            submitted_at: v.submittedAt || new Date().toISOString(),
          };
          list.push(newSpon);
          harvestedRows.push(newSpon);
          existingKeys.add(lookupKey);
          existingKeys.add(id);
          harvestedNew = true;
        }

        // Also harvest cross-taxi external sponsees recorded in this vehicle's draft
        const extSponsees = Array.isArray(v.draftState?.externalSponsees)
          ? (v.draftState.externalSponsees as Array<{ sponseeId?: string; sponseeName?: string; taxiName?: string; payerName?: string; note?: string }>)
          : [];
        for (const ext of extSponsees) {
          if (!ext.sponseeName || !ext.sponseeName.trim()) continue;
          const cleanName = sanitizePassengerDisplayName(ext.sponseeName);
          if (!cleanName) continue;
          const baseDate = normalizeDateToYMD(parsedDate) || parsedDate.split('_')[0];
          const normName = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '');
          const lookupKey = `${baseDate}::${normName}`;
          const id = `sp_${baseDate}_${normName}`;
          if (existingKeys.has(lookupKey) || existingKeys.has(id)) continue;

          const alreadyExists = list.some((existing) => {
            if (existing.id && existing.id === id) return true;
            const existDate = normalizeDateToYMD(existing.date || existing.manifest_key);
            const isSameDate = (!baseDate && !existDate) || (baseDate && existDate && baseDate === existDate) || (m.date && existing.manifest_key && (m.date === existing.manifest_key || m.date.startsWith(existDate) || existing.manifest_key.startsWith(baseDate)));
            if (!isSameDate) return false;
            const existNorm = sanitizePassengerDisplayName(existing.passenger_name).toLowerCase().replace(/[^a-z0-9]/g, '');
            return existNorm === normName;
          });
          if (alreadyExists) continue;

          const matchedSignup = allSignups.find((s) => s.fullName.toLowerCase() === ext.sponseeName?.toLowerCase());
          const newSpon: ReportedSponsorship = {
            id,
            manifest_key: m.date,
            date: parsedDate,
            service: parsedService,
            passenger_id: ext.sponseeId || matchedSignup?.id,
            passenger_name: cleanName,
            structure: normalizeStructureCode(matchedSignup?.structure),
            stop: matchedSignup?.stop || '',
            vehicle_name: ext.taxiName || v.name || 'Vehicle',
            rep_name: rep,
            sponsor_note: cleanSponsorshipNote(ext.note || `Paid by ${ext.payerName || 'Rider'} in ${v.name}`),
            status: 'pending',
            submitted_at: v.submittedAt || new Date().toISOString(),
          };
          list.push(newSpon);
          harvestedRows.push(newSpon);
          existingKeys.add(lookupKey);
          existingKeys.add(id);
          harvestedNew = true;
        }
      }

      // Also scan all signups directly in case of unassigned sponsored passengers
      for (const p of allSignups) {
        if (!p.sponsored) continue;
        const cleanName = sanitizePassengerDisplayName(p.fullName);
        if (!cleanName) continue;
        const baseDate = normalizeDateToYMD(parsedDate) || parsedDate.split('_')[0];
        const normName = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '');
        const lookupKey = `${baseDate}::${normName}`;
        const id = `sp_${baseDate}_${normName}`;
        if (existingKeys.has(lookupKey) || existingKeys.has(id) || (p.id && existingKeys.has(`pid_${p.id}`))) continue;

        const alreadyExists = list.some((existing) => {
          if (existing.id && (existing.id === id || (p.id && existing.passenger_id && String(p.id) === String(existing.passenger_id)))) return true;
          const existDate = normalizeDateToYMD(existing.date || existing.manifest_key);
          const isSameDate = (!baseDate && !existDate) || (baseDate && existDate && baseDate === existDate) || (m.date && existing.manifest_key && (m.date === existing.manifest_key || m.date.startsWith(existDate) || existing.manifest_key.startsWith(baseDate)));
          if (!isSameDate) return false;
          const existNorm = sanitizePassengerDisplayName(existing.passenger_name).toLowerCase().replace(/[^a-z0-9]/g, '');
          return existNorm === normName;
        });
        if (alreadyExists) continue;

        const newSpon: ReportedSponsorship = {
          id,
          manifest_key: m.date,
          date: parsedDate,
          service: parsedService,
          passenger_id: p.id,
          passenger_name: cleanName,
          structure: normalizeStructureCode(p.structure),
          stop: (p.stop || '').trim(),
          vehicle_name: 'Vehicle',
          rep_name: 'Transport Rep',
          sponsor_note: cleanSponsorshipNote(p.sponsorNote),
          status: 'pending',
          submitted_at: new Date().toISOString(),
        };
        list.push(newSpon);
        harvestedRows.push(newSpon);
        existingKeys.add(lookupKey);
        existingKeys.add(id);
        harvestedNew = true;
      }
    }

    // B. Check raw localStorage for any crc_rep_draft_* entries (including in-progress drafts and external sponsees)
    if (typeof localStorage !== 'undefined') {
      for (let i = 0; i < localStorage.length; i++) {
        const storageKey = localStorage.key(i);
        if (!storageKey || !storageKey.startsWith('crc_rep_draft_')) continue;

        try {
          const rawDraft = localStorage.getItem(storageKey);
          if (!rawDraft) continue;
          const draft = JSON.parse(rawDraft);
          const hasSponIds = Array.isArray(draft.sponsoredIds) && draft.sponsoredIds.length > 0;
          const hasExtSponsees = Array.isArray(draft.externalSponsees) && draft.externalSponsees.length > 0;
          if (!hasSponIds && !hasExtSponsees) continue;

          const parts = storageKey.replace('crc_rep_draft_', '').split('_');
          const manifestKey = parts.slice(0, -1).join('_') || storageKey;
          const parsedDate = manifestKey.split('_')[0] || manifestKey;
          const parsedService = manifestKey.split('_')[1]?.replace(/_/g, ' ') || 'Service';

          const mMatch = manifestsTable.find((m) => m.date === manifestKey);
          const allSignups = mMatch?.signups || [];
          const rep = draft.repName || 'Transport Rep';

          if (hasSponIds) {
            for (const sponId of draft.sponsoredIds) {
              let p = allSignups.find((s) => String(s.id) === String(sponId));
              if (!p) {
                for (const otherM of manifestsTable) {
                  p = (otherM.signups || []).find((s) => String(s.id) === String(sponId));
                  if (p) break;
                }
              }
              const cleanName = p ? p.fullName.trim() : sanitizePassengerDisplayName(String(sponId));
              if (!cleanName) continue;
              const baseDate = normalizeDateToYMD(parsedDate) || parsedDate.split('_')[0];
              const normName = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '');
              const lookupKey = `${baseDate}::${normName}`;
              if (existingKeys.has(lookupKey)) continue;

              const note = (draft.notes?.[sponId] || p?.sponsorNote || '').trim();
              const id = `sp_${baseDate}_${normName}`;
              const newSpon: ReportedSponsorship = {
                id,
                manifest_key: manifestKey,
                date: parsedDate,
                service: parsedService,
                passenger_id: String(sponId),
                passenger_name: cleanName,
                structure: normalizeStructureCode(p?.structure),
                stop: p?.stop || '',
                vehicle_name: 'Vehicle',
                rep_name: rep,
                sponsor_note: cleanSponsorshipNote(note),
                status: 'pending',
                submitted_at: draft.submittedAt || new Date().toISOString(),
              };
              list.push(newSpon);
              harvestedRows.push(newSpon);
              existingKeys.add(lookupKey);
              harvestedNew = true;
            }
          }

          if (hasExtSponsees) {
            for (const ext of draft.externalSponsees) {
              if (!ext.sponseeName || !ext.sponseeName.trim()) continue;
              const cleanName = sanitizePassengerDisplayName(ext.sponseeName);
              if (!cleanName) continue;
              const baseDate = normalizeDateToYMD(parsedDate) || parsedDate.split('_')[0];
              const normName = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '');
              const lookupKey = `${baseDate}::${normName}`;
              if (existingKeys.has(lookupKey)) continue;

              const matchedP = allSignups.find((s) => s.fullName.toLowerCase() === ext.sponseeName?.toLowerCase());
              const id = `sp_${baseDate}_${normName}`;
              const newSpon: ReportedSponsorship = {
                id,
                manifest_key: manifestKey,
                date: parsedDate,
                service: parsedService,
                passenger_id: ext.sponseeId || matchedP?.id,
                passenger_name: cleanName,
                structure: normalizeStructureCode(matchedP?.structure),
                stop: matchedP?.stop || '',
                vehicle_name: ext.taxiName || 'Vehicle',
                rep_name: rep,
                sponsor_note: cleanSponsorshipNote(ext.note || `Paid by ${ext.payerName || 'Rider'}`),
                status: 'pending',
                submitted_at: draft.submittedAt || new Date().toISOString(),
              };
              list.push(newSpon);
              harvestedRows.push(newSpon);
              existingKeys.add(lookupKey);
              harvestedNew = true;
            }
          }
        } catch {
          // ignore
        }
      }
    }

    if (harvestedNew && harvestedRows.length > 0) {
      // Upsert harvested items into Supabase
      Promise.resolve(supabase.from(SPONSORSHIPS_TABLE).upsert(harvestedRows, { onConflict: 'id' })).catch((err: unknown) => {
        console.warn('[Ledger] Failed to persist harvested sponsorships to Supabase:', err);
      });
    }
  } catch (err) {
    console.warn('[Ledger] Auto-harvest sponsorships error:', err);
  }

  // Final deduplication & name cleanup pass
  list = cleanAndDeduplicateSponsorships(list, allKnownSignups);

  // Sync back cleaned list to localStorage cache
  try {
    localStorage.setItem(LOCAL_SPONSORSHIPS_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }

  return list;
}

/**
 * Verifies or updates a single reported sponsorship's audit status.
 * Updates Supabase sponsorship_audits and synchronizes cancellation_ledger debt accordingly.
 */
export async function verifySponsorshipStatus(
  sponsorshipId: string,
  status: SponsorshipStatus,
  sponsorship?: ReportedSponsorship
): Promise<{ success: boolean; sponsorship?: ReportedSponsorship; ledgerUpdated?: boolean }> {
  const batchRes = await verifyBatchSponsorships([{ sponsorshipId, status, sponsorship }]);
  const freshList = await listReportedSponsorships();
  const updatedItem = freshList.find((s) => s.id === sponsorshipId);
  return {
    success: batchRes.success,
    sponsorship: updatedItem,
    ledgerUpdated: batchRes.ledgerUpdated,
  };
}

/**
 * Batch verifies reported sponsorships.
 * Primary path: Updates central server API and Supabase sponsorship_audits table,
 * and inserts/removes cancellation_ledger rows accordingly so confirmed unaccounted sponsorships
 * are immediately and persistently added to the actual cancellation list.
 */
export async function verifyBatchSponsorships(
  items: Array<{ sponsorshipId: string; status: SponsorshipStatus; sponsorship?: ReportedSponsorship }>
): Promise<{ success: boolean; updatedCount: number; ledgerUpdated?: boolean }> {
  if (!items || items.length === 0) return { success: true, updatedCount: 0 };

  const now = new Date().toISOString();
  let updatedCount = 0;
  let ledgerChanged = false;

  // 1. Primary: Mirror to Express server immediately
  try {
    const serverRes = await verifyBatchSponsorshipsOnServer(items);
    if (serverRes && serverRes.ledgerUpdated) {
      ledgerChanged = true;
    }
  } catch (err) {
    console.warn('[Ledger] verifyBatchSponsorshipsOnServer note:', err);
  }

  // 2. Fetch current sponsorships from all available sources
  const currentAudits = await listReportedSponsorships();

  // 3. Fetch current ledger entries to synchronize debts
  let currentLedger = await listLedgerEntries();

  // 4. Process each sponsorship item
  for (const item of items) {
    const { sponsorshipId, status, sponsorship: incomingSpon } = item || {};
    if (!sponsorshipId || !status) continue;

    let sponIndex = currentAudits.findIndex((a) => a.id === sponsorshipId);
    if (sponIndex < 0) {
      const cleanReqId = String(sponsorshipId).toLowerCase();
      sponIndex = currentAudits.findIndex((a) => {
        if (cleanReqId.includes(a.id.toLowerCase()) || a.id.toLowerCase().includes(cleanReqId)) return true;
        const aBase = (a.date || a.manifest_key || '').split('_')[0];
        const aNorm = sanitizePassengerDisplayName(a.passenger_name).toLowerCase().replace(/[^a-z0-9]/g, '');
        return aNorm && cleanReqId.includes(aNorm) && (cleanReqId.includes(aBase) || cleanReqId.includes(a.manifest_key.toLowerCase()));
      });
    }

    if (sponIndex < 0 && incomingSpon) {
      currentAudits.push({
        ...incomingSpon,
        id: incomingSpon.id || sponsorshipId,
        status,
        status_updated_at: now,
      });
      sponIndex = currentAudits.length - 1;
    }

    if (sponIndex < 0) continue;
    const spon = currentAudits[sponIndex];
    spon.status = status;
    spon.status_updated_at = now;
    updatedCount++;

    if (status === 'unpaid_sponsorship' || status === 'unaccounted_sponsorship') {
      const rawNote = spon.sponsor_note ? cleanSponsorshipNote(spon.sponsor_note) : '';
      const noteText = status === 'unaccounted_sponsorship'
        ? (rawNote && !rawNote.toLowerCase().includes('unaccounted') ? `Unaccounted Sponsorship: ${rawNote}` : (rawNote || 'Unaccounted Sponsorship'))
        : (rawNote && !rawNote.toLowerCase().includes('did not pay') ? `Did not pay: ${rawNote}` : (rawNote || 'Did not pay'));

      const cleanSponName = sanitizePassengerDisplayName(spon.passenger_name).toLowerCase();
      // Check if debt entry already exists for this sponsorship
      const existingLedgerIdx = currentLedger.findIndex((e) =>
        (spon.ledger_entry_id && e.id === spon.ledger_entry_id) ||
        (e.manifest_key === spon.manifest_key && sanitizePassengerDisplayName(e.passenger_name).toLowerCase() === cleanSponName && Boolean(e.sponsored))
      );

      const effectiveFee = getFareForDate(spon.date);
      if (existingLedgerIdx >= 0) {
        const existingId = currentLedger[existingLedgerIdx].id;
        spon.ledger_entry_id = existingId;
        currentLedger[existingLedgerIdx].general_notes = noteText;
        currentLedger[existingLedgerIdx].sponsor_note = noteText;
        currentLedger[existingLedgerIdx].sponsored = true;
        currentLedger[existingLedgerIdx].structure_debt = effectiveFee;
        currentLedger[existingLedgerIdx].structure = normalizeStructureCode(spon.structure);
        currentLedger[existingLedgerIdx].submitted_by = 'Cancellation Admin';
        currentLedger[existingLedgerIdx].source = 'reported_sponsorship_audit';
        ledgerChanged = true;

        await supabase
          .from(LEDGER_TABLE)
          .update({
            general_notes: noteText,
            sponsor_note: noteText,
            sponsored: true,
            structure_debt: effectiveFee,
            structure: normalizeStructureCode(spon.structure),
            submitted_by: 'Cancellation Admin',
            source: 'reported_sponsorship_audit',
          })
          .eq('id', existingId);
      } else {
        const newEntryId = spon.ledger_entry_id || `ledger_sp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        spon.ledger_entry_id = newEntryId;
        const newEntry: LedgerEntry = {
          id: newEntryId,
          manifest_key: spon.manifest_key || `manual-${Date.now()}`,
          date: normalizeDateToYMD(spon.date) || spon.date,
          service: spon.service || 'Service',
          passenger_name: sanitizePassengerDisplayName(spon.passenger_name),
          stop: spon.stop || '',
          structure: normalizeStructureCode(spon.structure),
          vehicle_name: spon.vehicle_name || '—',
          submitted_by: 'Cancellation Admin',
          rep_name: spon.rep_name || '',
          license_plate: '',
          sponsored: true,
          sponsor_note: noteText,
          structure_debt: effectiveFee,
          general_notes: noteText,
          source: 'reported_sponsorship_audit',
          submitted_at: now,
        };
        currentLedger.unshift(newEntry);
        ledgerChanged = true;

        await supabase.from(LEDGER_TABLE).insert([newEntry]);
      }
    } else if (status === 'actually_sponsored' || status === 'pending') {
      // If actually sponsored or reverted to pending, clear any debt entry
      if (spon.ledger_entry_id) {
        const delId = spon.ledger_entry_id;
        currentLedger = currentLedger.filter((e) => e.id !== delId);
        spon.ledger_entry_id = null;
        ledgerChanged = true;
        await supabase.from(LEDGER_TABLE).delete().eq('id', delId);
      } else {
        const beforeLen = currentLedger.length;
        const cleanSponName = sanitizePassengerDisplayName(spon.passenger_name).toLowerCase();
        currentLedger = currentLedger.filter(
          (e) => !(e.manifest_key === spon.manifest_key && sanitizePassengerDisplayName(e.passenger_name).toLowerCase() === cleanSponName && Boolean(e.sponsored))
        );
        if (currentLedger.length !== beforeLen) {
          ledgerChanged = true;
          await supabase
            .from(LEDGER_TABLE)
            .delete()
            .eq('manifest_key', spon.manifest_key)
            .ilike('passenger_name', spon.passenger_name)
            .eq('sponsored', true);
        }
      }
    }

    // Update Supabase sponsorship_audits row
    try {
      await supabase
        .from(SPONSORSHIPS_TABLE)
        .upsert({
          id: spon.id,
          manifest_key: spon.manifest_key,
          date: spon.date,
          service: spon.service,
          passenger_id: spon.passenger_id || '',
          passenger_name: spon.passenger_name,
          structure: spon.structure,
          stop: spon.stop || '',
          vehicle_name: spon.vehicle_name,
          rep_name: spon.rep_name,
          sponsor_note: spon.sponsor_note,
          status: spon.status,
          status_updated_at: spon.status_updated_at,
          ledger_entry_id: spon.ledger_entry_id || '',
          submitted_at: spon.submitted_at || now,
        }, { onConflict: 'id' });
    } catch (err) {
      console.warn('[Ledger] Failed to update sponsorship audit in Supabase:', err);
    }
  }

  // 5. Update localStorage caches
  try {
    localStorage.setItem(LOCAL_SPONSORSHIPS_KEY, JSON.stringify(cleanAndDeduplicateSponsorships(currentAudits)));
  } catch {
    /* ignore */
  }

  // 6. Fire window events for instant UI reactivity
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('crc_sponsorships_updated', { detail: currentAudits }));
    if (ledgerChanged) {
      window.dispatchEvent(new CustomEvent('crc_ledger_updated'));
    }
  }

  return { success: true, updatedCount, ledgerUpdated: ledgerChanged };
}

function updateLocalSponsorshipCache(updated: ReportedSponsorship) {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LOCAL_SPONSORSHIPS_KEY) : null;
    if (raw) {
      const list = JSON.parse(raw) as ReportedSponsorship[];
      const idx = list.findIndex((a) => a.id === updated.id);
      if (idx >= 0) {
        list[idx] = updated;
      } else {
        list.unshift(updated);
      }
      localStorage.setItem(LOCAL_SPONSORSHIPS_KEY, JSON.stringify(list));
    }
  } catch {
    /* ignore */
  }
}

/**
 * Deletes a reported sponsorship and cleans up any linked debt entry in the ledger.
 */
export async function deleteReportedSponsorship(sponsorshipId: string): Promise<void> {
  // 1. Central Server
  try {
    await deleteSponsorshipOnServer(sponsorshipId);
  } catch (err) {
    console.debug('[Ledger] Server delete sponsorship note:', err);
  }

  // 2. Supabase
  try {
    await supabase.from(SPONSORSHIPS_TABLE).delete().eq('id', sponsorshipId);
  } catch {
    /* ignore */
  }

  // 3. LocalStorage & cache sync
  const allAudits = await listReportedSponsorships();
  const spon = allAudits.find((a) => a.id === sponsorshipId);
  const remaining = allAudits.filter((a) => a.id !== sponsorshipId);
  try {
    localStorage.setItem(LOCAL_SPONSORSHIPS_KEY, JSON.stringify(remaining));
  } catch {
    /* ignore */
  }

  // 4. Remove linked ledger debt if any
  if (spon?.ledger_entry_id) {
    await deleteLedgerEntry(spon.ledger_entry_id);
  } else if (spon) {
    const cleanName = sanitizePassengerDisplayName(spon.passenger_name).toLowerCase();
    const all = await listLedgerEntries();
    const match = all.find(
      (e) => (e.manifest_key === spon.manifest_key || e.date === spon.date) &&
        sanitizePassengerDisplayName(e.passenger_name).toLowerCase() === cleanName &&
        Boolean(e.sponsored)
    );
    if (match) {
      await deleteLedgerEntry(match.id);
    }
  }

  // 5. Broadcast updates
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('crc_sponsorships_updated', { detail: remaining }));
    window.dispatchEvent(new CustomEvent('crc_ledger_updated'));
  }
}

/**
 * Batch deletes reported sponsorships and removes any linked ledger debts.
 */
export async function batchDeleteReportedSponsorships(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const idSet = new Set(ids);

  try {
    await batchDeleteSponsorshipsOnServer(ids);
  } catch (err) {
    console.debug('[Ledger] Server batch delete sponsorships note:', err);
  }

  try {
    await supabase.from(SPONSORSHIPS_TABLE).delete().in('id', ids);
  } catch {
    /* ignore */
  }

  const allAudits = await listReportedSponsorships();
  const toDelete = allAudits.filter((a) => idSet.has(a.id));
  const remaining = allAudits.filter((a) => !idSet.has(a.id));
  try {
    localStorage.setItem(LOCAL_SPONSORSHIPS_KEY, JSON.stringify(remaining));
  } catch {
    /* ignore */
  }

  const allLedger = await listLedgerEntries();
  for (const spon of toDelete) {
    if (spon.ledger_entry_id) {
      await deleteLedgerEntry(spon.ledger_entry_id);
    } else {
      const cleanName = sanitizePassengerDisplayName(spon.passenger_name).toLowerCase();
      const match = allLedger.find(
        (e) => (e.manifest_key === spon.manifest_key || e.date === spon.date) &&
          sanitizePassengerDisplayName(e.passenger_name).toLowerCase() === cleanName &&
          Boolean(e.sponsored)
      );
      if (match) {
        await deleteLedgerEntry(match.id);
      }
    }
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('crc_sponsorships_updated', { detail: remaining }));
    window.dispatchEvent(new CustomEvent('crc_ledger_updated'));
  }
}

/**
 * Records payment for a reported sponsorship. Updates sponsorship status and settles/deducts ledger debt.
 */
export async function recordReportedSponsorshipPayment(
  sponsorshipId: string,
  amount: number,
  notes?: string
): Promise<{ success: boolean; sponsorship?: ReportedSponsorship }> {
  // 1. Central Server
  try {
    const res = await recordSponsorshipPaymentOnServer(sponsorshipId, amount, notes);
    if (res.success && res.sponsorship) {
      updateLocalSponsorshipCache(res.sponsorship);
      return res;
    }
  } catch (err) {
    console.debug('[Ledger] Server record sponsorship payment note:', err);
  }

  // 2. Local fallback
  const currentAudits = await listReportedSponsorships();
  const sponIndex = currentAudits.findIndex((a) => a.id === sponsorshipId);
  if (sponIndex === -1) return { success: false };

  const spon = currentAudits[sponIndex];
  const totalDebt = getFareForDate(spon.date);
  const now = new Date().toISOString();
  const payNote = notes ? notes.trim() : `Paid R${amount} on ${now.slice(0, 10)}`;

  if (amount >= totalDebt) {
    spon.status = 'actually_sponsored';
    spon.status_updated_at = now;
    spon.sponsor_note = spon.sponsor_note ? `${spon.sponsor_note} (Settled: ${payNote})` : `Settled: ${payNote}`;
    if (spon.ledger_entry_id) {
      await deleteLedgerEntry(spon.ledger_entry_id);
      spon.ledger_entry_id = null;
    }
  } else {
    const remaining = totalDebt - amount;
    spon.sponsor_note = spon.sponsor_note ? `${spon.sponsor_note} (Partially paid R${amount}, owing R${remaining})` : `Partially paid R${amount}, owing R${remaining}`;
    spon.status_updated_at = now;
    if (spon.ledger_entry_id) {
      await updateLedgerEntry(spon.ledger_entry_id, { structure_debt: remaining });
    }
  }

  currentAudits[sponIndex] = spon;
  updateLocalSponsorshipCache(spon);

  try {
    await supabase.from(SPONSORSHIPS_TABLE).upsert([spon]);
  } catch {
    /* ignore */
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('crc_sponsorships_updated', { detail: currentAudits }));
    window.dispatchEvent(new CustomEvent('crc_ledger_updated'));
  }

  return { success: true, sponsorship: spon };
}

/**
 * Updates / Edits a reported sponsorship and synchronizes any linked debt entry in the ledger.
 */
export async function updateReportedSponsorship(
  sponsorshipId: string,
  updates: Partial<ReportedSponsorship> & { debtAmount?: number }
): Promise<{ success: boolean; sponsorship?: ReportedSponsorship }> {
  // 1. Central Server
  try {
    const res = await updateSponsorshipOnServer(sponsorshipId, updates);
    if (res.success && res.sponsorship) {
      updateLocalSponsorshipCache(res.sponsorship);
      return res;
    }
  } catch (err) {
    console.debug('[Ledger] Server update sponsorship note:', err);
  }

  // 2. Local fallback
  const currentAudits = await listReportedSponsorships();
  const idx = currentAudits.findIndex((a) => a.id === sponsorshipId);
  if (idx === -1) return { success: false };

  const spon = { ...currentAudits[idx], ...updates };
  currentAudits[idx] = spon;
  updateLocalSponsorshipCache(spon);

  const isDebt = spon.status === 'unaccounted_sponsorship' || spon.status === 'unpaid_sponsorship';
  const customDebt = updates.debtAmount !== undefined && Number(updates.debtAmount) > 0 ? Number(updates.debtAmount) : getFareForDate(spon.date);

  if (isDebt) {
    const rawNote = spon.sponsor_note ? cleanSponsorshipNote(spon.sponsor_note) : '';
    const noteText = spon.status === 'unaccounted_sponsorship'
      ? (rawNote && !rawNote.toLowerCase().includes('unaccounted') ? `Unaccounted Sponsorship: ${rawNote}` : (rawNote || 'Unaccounted Sponsorship'))
      : (rawNote && !rawNote.toLowerCase().includes('did not pay') ? `Did not pay: ${rawNote}` : (rawNote || 'Did not pay'));

    if (spon.ledger_entry_id) {
      await updateLedgerEntry(spon.ledger_entry_id, {
        passenger_name: spon.passenger_name,
        structure: spon.structure,
        date: spon.date,
        service: spon.service,
        stop: spon.stop || '',
        structure_debt: customDebt,
        sponsor_note: noteText,
        general_notes: noteText,
        sponsored: true,
      });
    } else {
      const newEntryId = `ledger_sp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      spon.ledger_entry_id = newEntryId;
      await supabase.from(LEDGER_TABLE).insert([{
        id: newEntryId,
        manifest_key: spon.manifest_key || `manual-${Date.now()}`,
        date: spon.date,
        service: spon.service,
        passenger_name: spon.passenger_name,
        stop: spon.stop || '',
        structure: spon.structure,
        vehicle_name: spon.vehicle_name || '—',
        submitted_by: 'Cancellation Admin',
        rep_name: spon.rep_name || '',
        license_plate: '',
        sponsored: true,
        sponsor_note: noteText,
        structure_debt: customDebt,
        general_notes: noteText,
        source: 'reported_sponsorship_audit',
        submitted_at: new Date().toISOString(),
      }]);
    }
  } else {
    // Actually sponsored or pending -> remove any debt entry
    if (spon.ledger_entry_id) {
      await deleteLedgerEntry(spon.ledger_entry_id);
      spon.ledger_entry_id = null;
    }
  }

  try {
    await supabase.from(SPONSORSHIPS_TABLE).upsert([spon]);
  } catch {
    /* ignore */
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('crc_sponsorships_updated', { detail: currentAudits }));
    window.dispatchEvent(new CustomEvent('crc_ledger_updated'));
  }

  return { success: true, sponsorship: spon };
}
