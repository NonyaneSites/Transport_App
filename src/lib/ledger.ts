import * as XLSX from 'xlsx';
import { supabase, mockStorage, MANIFESTS_TABLE } from './supabase';
import {
  listLedgerFromServer,
  settleLedgerOnServer,
  addManualLedgerOnServer,
  deleteLedgerOnServer,
  updateDebtorOnServer,
  listReportedSponsorshipsFromServer,
  verifySponsorshipOnServer,
} from './serverApi';
import type { ReportedSponsorship, SponsorshipStatus } from './serverApi';
import type { Passenger, Vehicle } from './types';
import { CANCELLATION_FEE } from './types';
import { naturalCompare } from './sort';
import { shortDate } from './dates';

export type { ReportedSponsorship, SponsorshipStatus };

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
  let name = rawName.trim();

  // Strip accidental "Passenger " prefix
  if (/^passenger\s+/i.test(name)) {
    name = name.replace(/^passenger\s+/i, '').trim();
  }

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

  return name;
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
}

export interface AbsenteeInput extends Passenger {
  sponsored?: boolean;
  sponsorNote?: string;
}

/**
 * Extracts a normalized service code (e.g. AM, PM, LM, WMP, EF, AD, FW, etc.)
 * from a service string or embedded event description.
 * Preserves special church event codes like LM (Leaders Meeting), WMP (Worship/Music/Prayer),
 * EF (Easter Friday), AD (Ascension Day), FW (Fast & Worship).
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
  if (upper === 'AM' || upper.startsWith('AM_') || upper.startsWith('AM ') || upper.startsWith('AM-') || upper.startsWith('AM/')) return 'AM';
  if (upper === 'PM' || upper.startsWith('PM_') || upper.startsWith('PM ') || upper.startsWith('PM-') || upper.startsWith('PM/')) return 'PM';
  if (upper === 'LM' || upper.startsWith('LM_') || upper.startsWith('LM ') || upper.startsWith('LM-') || upper.startsWith('LM/')) return 'LM';
  if (upper === 'WMP' || upper.startsWith('WMP_') || upper.startsWith('WMP ') || upper.startsWith('WMP-') || upper.startsWith('WMP/')) return 'WMP';
  if (upper === 'EF' || upper.startsWith('EF_') || upper.startsWith('EF ') || upper.startsWith('EF-') || upper.startsWith('EF/')) return 'EF';
  if (upper === 'AD' || upper.startsWith('AD_') || upper.startsWith('AD ') || upper.startsWith('AD-') || upper.startsWith('AD/')) return 'AD';
  if (upper === 'FW' || upper.startsWith('FW_') || upper.startsWith('FW ') || upper.startsWith('FW-') || upper.startsWith('FW/')) return 'FW';

  // Keyword searches
  const lower = clean.toLowerCase();
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

  const rows = absentees.map((p) => {
    return {
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
    };
  });

  if (unpaidRiders && unpaidRiders.length > 0) {
    for (const u of unpaidRiders) {
      rows.push({
        manifest_key: manifestKey,
        date,
        service: serviceLabel,
        passenger_name: u.fullName,
        stop: u.stop || '',
        structure: u.structure || '',
        vehicle_name: vehicleName,
        submitted_by: submittedBy,
        rep_name: repName,
        license_plate: licensePlate,
        sponsored: false,
        sponsor_note: u.unpaidNote ? `Did not pay: ${u.unpaidNote}` : 'Did not pay',
        structure_debt: CANCELLATION_FEE,
        general_notes: `Unpaid ride (Did not pay)${u.unpaidNote ? ` - ${u.unpaidNote}` : ''}`,
      });
    }
  }

  if (rows.length === 0) return;

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
  const normalizedNames = new Set(riderNames.map((n) => sanitizePassengerDisplayName(n).toLowerCase()));
  const baseDate = normalizeDateToYMD(manifestKey) || manifestKey.split('_')[0];

  try {
    const { data } = await supabase.from(LEDGER_TABLE).select('*');
    if (Array.isArray(data)) {
      const idsToDelete = data
        .filter((entry) => {
          const eDate = normalizeDateToYMD(entry.date) || entry.date?.split('_')[0] || entry.manifest_key?.split('_')[0];
          const isSameSession = entry.manifest_key === manifestKey || (baseDate && eDate === baseDate);
          const isRider = normalizedNames.has(sanitizePassengerDisplayName(entry.passenger_name).toLowerCase());
          return isSameSession && isRider;
        })
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
  let entries: LedgerEntry[] = [];
  // 1. Primary: Central Express Server API
  try {
    const serverEntries = await listLedgerFromServer();
    if (serverEntries && serverEntries.length > 0) {
      entries = serverEntries;
    }
  } catch (err) {
    console.debug('[Ledger] Server fetch note:', err);
  }

  // 2. Secondary: Supabase / Mock store
  if (entries.length === 0) {
    try {
      const { data } = await supabase
        .from(LEDGER_TABLE)
        .select('*')
        .order('submitted_at', { ascending: false });
      if (data && Array.isArray(data)) {
        entries = data as LedgerEntry[];
      }
    } catch (err) {
      console.warn('[Ledger] Exception fetching ledger entries:', err);
    }
  }

  // Ensure all structures are normalized to canonical codes, passenger names are cleanly formatted,
  // and exclude any entries whose debt has been reduced to zero
  return entries
    .filter((e) => {
      if (e.structure_debt !== undefined && e.structure_debt !== null) {
        const d = Number(e.structure_debt);
        if (Number.isFinite(d) && d <= 0) return false;
      }
      return true;
    })
    .map((e) => ({
      ...e,
      structure: normalizeStructureCode(e.structure),
      passenger_name: sanitizePassengerDisplayName(e.passenger_name),
    }));
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
}

export async function updateLedgerEntry(id: string, updates: Partial<LedgerEntry>): Promise<void> {
  // If the debt for this entry is reduced to zero or less, remove the debt entry
  if (updates.structure_debt !== undefined && Number(updates.structure_debt) <= 0) {
    await deleteLedgerEntry(id);
    return;
  }
  const { error } = await supabase.from(LEDGER_TABLE).update(updates).eq('id', id);
  if (error) throw error;
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
}

/**
 * Converts various date formats (e.g. YYYY-MM-DD, DD/MM/YYYY, DD/MM/YY) into a normalized YYYY-MM-DD string for date pickers.
 */
export function normalizeDateToYMD(dateStr?: string | null): string {
  if (!dateStr) return '';
  const trimmed = String(dateStr).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = parseFlexibleHistoricalDate(trimmed);
  return parsed || trimmed;
}

/**
 * Inserts a manually created cancellation/debt entry into the cancellation ledger.
 */
export async function addManualLedgerEntry(input: ManualLedgerEntryInput): Promise<LedgerEntry> {
  const fullName = `${input.firstName.trim()} ${input.surname.trim()}`.trim();
  const manifestKey = `manual-${input.date}-${input.service.toLowerCase()}-${Date.now()}`;
  const structureCode = normalizeStructureCode(input.structure);

  const rawAmt = Number(input.amount);
  const debtAmt = Number.isFinite(rawAmt) && rawAmt >= 0 ? rawAmt : CANCELLATION_FEE;

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
    sponsored: !!input.isSponsored,
    sponsor_note: input.isSponsored ? (input.notes || 'Sponsorship') : '',
    structure_debt: debtAmt,
    general_notes: input.notes || '',
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
    notes?: string;
    instances: DebtorInstanceUpdateItem[];
  }
): Promise<void> {
  const structCode = normalizeStructureCode(updates.structure);
  const cleanName = updates.name.trim();
  const isSponsored = !!updates.isSponsored;
  const noteText = isSponsored ? (updates.notes?.trim() || 'Unaccounted Sponsorship') : '';

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
        notes: noteText,
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
          sponsor_note: noteText,
          general_notes: noteText,
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
        submitted_by: templateEntry?.submitted_by || 'Admin Manual Edit',
        rep_name: templateEntry?.rep_name || '',
        license_plate: templateEntry?.license_plate || '',
        sponsored: isSponsored,
        sponsor_note: noteText,
        structure_debt: validAmount,
        general_notes: noteText,
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
          general_notes: updates.isSponsored ? (updates.notes?.trim() || 'Unaccounted Sponsorship') : '',
          sponsored: !!updates.isSponsored,
          sponsor_note: updates.isSponsored ? (updates.notes?.trim() || 'Unaccounted Sponsorship') : '',
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
          const defaultDebt = Number(ent.structure_debt) || 40;
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
              general_notes: updates.isSponsored ? (updates.notes?.trim() || 'Unaccounted Sponsorship') : '',
              sponsored: !!updates.isSponsored,
              sponsor_note: updates.isSponsored ? (updates.notes?.trim() || 'Unaccounted Sponsorship') : '',
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
      patch.general_notes = updates.isSponsored ? (updates.notes?.trim() || 'Unaccounted Sponsorship') : '';
      patch.sponsor_note = updates.isSponsored ? (updates.notes?.trim() || 'Unaccounted Sponsorship') : '';
    } else if (updates.notes !== undefined) {
      patch.general_notes = updates.notes;
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

  const { data: entries, error } = await supabase
    .from(LEDGER_TABLE)
    .select('id, structure_debt, date')
    .in('id', entryIds);

  if (error) throw error;
  if (!entries || entries.length === 0) return;

  // Sort ascending by date (oldest debt settled first)
  const sorted = [...entries].sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  let remainingToDeduct = amountPaid;

  for (const entry of sorted) {
    if (remainingToDeduct <= 0) break;
    const currentDebt = Number(entry.structure_debt) || CANCELLATION_FEE;

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

    // Debt parsing: Read the explicit debt column or fallback to standard cancellation fee.
    // The cancellation admin determines and adjusts debt amounts directly.
    const debtRaw = debtCol !== -1 ? raw[debtCol] : undefined;
    let structureDebt = CANCELLATION_FEE;
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
      sponsor_note: isSponsorship ? r.general_notes || 'Unaccounted Sponsorship' : '',
      structure_debt: r.structure_debt,
      general_notes: r.general_notes || '',
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
 */
export function isEntrySponsorshipOrUnpaid(e: {
  sponsored?: boolean | null;
  general_notes?: string | null;
  sponsor_note?: string | null;
}): boolean {
  const gn = (e.general_notes || '').toLowerCase();
  const sn = (e.sponsor_note || '').toLowerCase();
  return (
    Boolean(e.sponsored) ||
    gn.includes('unaccounted') ||
    gn.includes('unpaid') ||
    gn.includes('did not pay') ||
    gn.includes('sponsorship') ||
    sn.includes('unaccounted') ||
    sn.includes('unpaid') ||
    sn.includes('sponsorship')
  );
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
    if (e.structure_debt !== undefined && e.structure_debt !== null) {
      const d = Number(e.structure_debt);
      if (Number.isFinite(d) && d <= 0) continue;
    }
    const key = normalizeStructureCode(e.structure);
    if (!byStructure.has(key)) byStructure.set(key, []);
    byStructure.get(key)!.push({
      ...e,
      structure: key,
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
      const nameKey = `${e.passenger_name.trim().toLowerCase()}:::${catKey}`;
      if (!byCategoryAndName.has(nameKey)) byCategoryAndName.set(nameKey, []);
      byCategoryAndName.get(nameKey)!.push(e);
    }

    const rows: AggregatedLedgerRow[] = Array.from(byCategoryAndName.values()).map((group) => {
      // Sort individual instances in chronological order ascending (Jan 1 first, Dec 31 last)
      const sorted = [...group].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      const earliest = sorted[0];
      const latest = sorted[sorted.length - 1];
      const amount = group.reduce((sum, e) => {
        const d = Number(e.structure_debt);
        return sum + (Number.isFinite(d) ? d : CANCELLATION_FEE);
      }, 0);

      // Collect distinct service codes
      const serviceCodesSet = new Set<string>();
      const instances: AggregatedLedgerInstance[] = sorted
        .filter((e) => {
          const rawD = Number(e.structure_debt);
          return !Number.isFinite(rawD) || rawD > 0;
        })
        .map((e) => {
        const code = extractServiceCode(e.service) || 'PM';
        serviceCodesSet.add(code);

        // Format date into dd/mm/yy or 'Undated'
        let dStr = e.date ? e.date : 'Undated';
        if (e.date && e.date.includes('-')) {
          const parts = e.date.split('-');
          if (parts.length === 3) {
            dStr = `${parts[2].slice(-2)}/${parts[1]}/${parts[0].slice(2)}`;
          }
        }
        const rawD = Number(e.structure_debt);
        const instDebt = Number.isFinite(rawD) ? rawD : CANCELLATION_FEE;

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

      const serviceCodes = Array.from(serviceCodesSet);
      const formattedServices = serviceCodes.length > 0 ? `(${serviceCodes.join(', ')})` : '';
      const formattedDateList = instances.map((ins) => ins.formatted).join(', ');

      const isSponsorshipOrUnpaid = group.some((e) => isEntrySponsorshipOrUnpaid(e));

      const combinedNotes = Array.from(
        new Set(group.map((e) => e.general_notes || e.sponsor_note).filter(Boolean))
      ).join('; ');

      return {
        key: `${structure}-${latest.passenger_name}-${isSponsorshipOrUnpaid ? 'sponsorship' : 'cancellation'}`,
        structure,
        repName: latest.rep_name || latest.submitted_by || '—',
        vehicleName: latest.vehicle_name || '—',
        name: latest.passenger_name,
        service: latest.service,
        serviceCodes,
        formattedServices,
        latestDate: earliest.date || latest.date,
        formattedDateList,
        amount,
        entryIds: group.map((e) => e.id),
        instances,
        isSponsorshipOrUnpaid,
        notes: combinedNotes,
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
          row.notes || 'Unaccounted Sponsorship',
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
 */
export function groupSponsorshipsByStructure(
  items: ReportedSponsorship[]
): StructureSponsorshipGroup[] {
  const map = new Map<string, ReportedSponsorship[]>();

  for (const item of items) {
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
 * so corrupted slug names like "Passenger bonolo-ngejane-dfc-bus-stop" are purged.
 */
export function cleanAndDeduplicateSponsorships(
  items: ReportedSponsorship[],
  knownSignups?: Array<{ id: string; fullName: string; stop?: string; structure?: string }>
): ReportedSponsorship[] {
  const result: ReportedSponsorship[] = [];
  const indexMap = new Map<string, number>();

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
    const cleanDate = normalizeDateToYMD(rawDate) || rawDate.split('_')[0] || '';
    const normName = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const dedupKey = `${cleanDate}::${normName}`;
    if (indexMap.has(dedupKey)) {
      const existingIdx = indexMap.get(dedupKey)!;
      const existing = result[existingIdx];
      result[existingIdx] = {
        ...existing,
        passenger_name: cleanName,
        structure: (existing.structure && existing.structure !== 'No Structure') ? existing.structure : structure,
        stop: existing.stop || stop,
        sponsor_note: existing.sponsor_note || item.sponsor_note || '',
        status: existing.status !== 'pending' ? existing.status : item.status,
        status_updated_at: existing.status_updated_at || item.status_updated_at,
        ledger_entry_id: existing.ledger_entry_id || item.ledger_entry_id,
        vehicle_name: existing.vehicle_name || item.vehicle_name,
        rep_name: existing.rep_name || item.rep_name,
      };
    } else {
      indexMap.set(dedupKey, result.length);
      result.push({
        ...item,
        passenger_name: cleanName,
        structure,
        stop,
      });
    }
  }

  return result;
}

/**
 * Records reported sponsorships from attendance check-in into the local/central audit store.
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
  let list: ReportedSponsorship[] = [];
  try {
    const raw = localStorage.getItem(LOCAL_SPONSORSHIPS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed;
    }
  } catch {
    list = [];
  }

  // Remove any previously recorded pending sponsorships for this vehicle session
  // belonging to riders on this roster (preserving already-verified ones)
  const baseDate = normalizeDateToYMD(manifestKey) || manifestKey.split('_')[0];
  if (allRiderNames.length > 0) {
    const normalizedRoster = new Set(allRiderNames.map((n) => sanitizePassengerDisplayName(n).toLowerCase()));
    list = list.filter((s) => {
      const sDate = normalizeDateToYMD(s.date) || s.date?.split('_')[0] || s.manifest_key?.split('_')[0];
      const isSameSession = s.manifest_key === manifestKey || (baseDate && sDate === baseDate);
      const isRider = normalizedRoster.has(sanitizePassengerDisplayName(s.passenger_name).toLowerCase());
      return !(isSameSession && isRider && s.status === 'pending');
    });
  }

  const now = new Date().toISOString();
  for (const r of sponsoredRiders) {
    const cleanName = sanitizePassengerDisplayName(r.fullName);
    if (!cleanName) continue;
    const normName = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const existingIndex = list.findIndex((s) => {
      const sDate = normalizeDateToYMD(s.date) || s.date?.split('_')[0] || s.manifest_key?.split('_')[0];
      const isSameSession = s.manifest_key === manifestKey || (baseDate && sDate === baseDate);
      const sName = sanitizePassengerDisplayName(s.passenger_name).toLowerCase().replace(/[^a-z0-9]/g, '');
      return isSameSession && sName === normName;
    });

    if (existingIndex >= 0) {
      list[existingIndex] = {
        ...list[existingIndex],
        passenger_name: cleanName,
        structure: normalizeStructureCode(r.structure) || list[existingIndex].structure,
        stop: r.stop || list[existingIndex].stop,
        vehicle_name: vehicleName || list[existingIndex].vehicle_name,
        rep_name: repName || list[existingIndex].rep_name,
        sponsor_note: (r.sponsorNote || list[existingIndex].sponsor_note || '').trim(),
      };
    } else {
      const cleanKey = manifestKey.replace(/[^a-zA-Z0-9_-]/g, '_');
      const safeSlug = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '_');
      const id = `spon_${cleanKey}_${safeSlug}_${Date.now()}`;
      list.push({
        id,
        manifest_key: manifestKey,
        date,
        service: serviceLabel,
        passenger_id: r.id,
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
  }

  list = cleanAndDeduplicateSponsorships(list);

  try {
    localStorage.setItem(LOCAL_SPONSORSHIPS_KEY, JSON.stringify(list));
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('crc_sponsorships_updated', { detail: list }));
    }
  } catch (err) {
    console.warn('[Ledger] Failed to save reported sponsorships to localStorage:', err);
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
  try {
    const raw = localStorage.getItem(LOCAL_SPONSORSHIPS_KEY);
    if (!raw) return;
    const list = JSON.parse(raw) as ReportedSponsorship[];
    const normalizedRoster = new Set(riderNames.map((n) => sanitizePassengerDisplayName(n).toLowerCase()));
    const baseDate = normalizeDateToYMD(manifestKey) || manifestKey.split('_')[0];

    const filtered = list.filter((s) => {
      const sDate = normalizeDateToYMD(s.date) || s.date?.split('_')[0] || s.manifest_key?.split('_')[0];
      const isSameSession = s.manifest_key === manifestKey || (baseDate && sDate === baseDate);
      const isRider = normalizedRoster.has(sanitizePassengerDisplayName(s.passenger_name).toLowerCase());
      return !(isSameSession && isRider && s.status === 'pending');
    });

    localStorage.setItem(LOCAL_SPONSORSHIPS_KEY, JSON.stringify(cleanAndDeduplicateSponsorships(filtered)));
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('crc_sponsorships_updated', { detail: filtered }));
    }
  } catch {
    /* ignore */
  }
}

/**
 * Retrieves all reported sponsorships for administrative verification.
 * Automatically harvests sponsorships from existing submitted manifests/drafts
 * so any sponsorships already submitted immediately appear!
 */
export async function listReportedSponsorships(): Promise<ReportedSponsorship[]> {
  let list: ReportedSponsorship[] = [];

  // 1. Try server fetch if available
  try {
    const serverSponsees = await listReportedSponsorshipsFromServer();
    if (serverSponsees && serverSponsees.length > 0) {
      list = serverSponsees;
    }
  } catch (err) {
    console.debug('[Ledger] Server fetch sponsorships note:', err);
  }

  // 2. Read from local storage cache
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
      draftState?: { sponsoredIds?: string[]; notes?: Record<string, string>; submitted?: boolean };
    }>;
  }
  const manifestsTable = (mockStorage.getTable(MANIFESTS_TABLE) as unknown as StoredManifest[]) || [];
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

  // 3. Self-healing harvest: recover any sponsorships from submitted manifests in local storage
  try {
    let harvestedNew = false;
    const existingKeys = new Set(
      list.map((s) => {
        const baseDate = normalizeDateToYMD(s.date) || s.date?.split('_')[0] || s.manifest_key?.split('_')[0] || '';
        const normName = sanitizePassengerDisplayName(s.passenger_name).toLowerCase().replace(/[^a-z0-9]/g, '');
        return `${baseDate}::${normName}`;
      })
    );

    // A. Check mockStorage manifests (STRICT: only submitted vehicles)
    for (const m of manifestsTable) {
      if (!m.date) continue;
      const parsedDate = m.date.split('_')[0] || m.date;
      const parsedService = m.date.split('_')[1]?.replace(/_/g, ' ') || 'Service';
      const allSignups = Array.isArray(m.signups) ? m.signups : [];

      for (const v of m.vehicles || []) {
        const isSubmitted = Boolean(v.submitted);
        if (!isSubmitted) continue;

        const vehicleRiderIds = new Set(v.riders || []);
        if (vehicleRiderIds.size === 0) continue;
        const vehicleSignups = allSignups.filter((p) => vehicleRiderIds.has(p.id));
        if (vehicleSignups.length === 0) continue;
        const rep = v.repName || v.submittedBy || 'Transport Rep';
        const sponsoredIds = new Set(v.draftState?.sponsoredIds || []);
        const notes = v.draftState?.notes || {};

        for (const p of vehicleSignups) {
          const isSponsored = p.sponsored || sponsoredIds.has(p.id);
          if (!isSponsored) continue;

          const cleanName = sanitizePassengerDisplayName(p.fullName);
          if (!cleanName) continue;
          const baseDate = normalizeDateToYMD(parsedDate) || parsedDate.split('_')[0];
          const normName = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '');
          const lookupKey = `${baseDate}::${normName}`;
          if (existingKeys.has(lookupKey)) continue;

          const sponsorNote = (notes[p.id] || p.sponsorNote || '').trim();
          const cleanKey = m.date.replace(/[^a-zA-Z0-9_-]/g, '_');
          const safeSlug = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '_');
          const id = `spon_${cleanKey}_${safeSlug}_${Date.now()}`;
          list.push({
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
            sponsor_note: sponsorNote,
            status: 'pending',
            submitted_at: v.submittedAt || new Date().toISOString(),
          });
          existingKeys.add(lookupKey);
          harvestedNew = true;
        }
      }
    }

    // B. Check raw localStorage for any crc_rep_draft_* entries (STRICT: only submitted drafts)
    if (typeof localStorage !== 'undefined') {
      for (let i = 0; i < localStorage.length; i++) {
        const storageKey = localStorage.key(i);
        if (!storageKey || !storageKey.startsWith('crc_rep_draft_')) continue;

        try {
          const rawDraft = localStorage.getItem(storageKey);
          if (!rawDraft) continue;
          const draft = JSON.parse(rawDraft);
          // STRICT RULE: Only drafts explicitly submitted are harvested!
          if (!draft.submitted) continue;
          if (!Array.isArray(draft.sponsoredIds) || draft.sponsoredIds.length === 0) continue;

          const parts = storageKey.replace('crc_rep_draft_', '').split('_');
          const manifestKey = parts.slice(0, -1).join('_') || storageKey;
          const parsedDate = manifestKey.split('_')[0] || manifestKey;
          const parsedService = manifestKey.split('_')[1]?.replace(/_/g, ' ') || 'Service';

          const mMatch = manifestsTable.find((m) => m.date === manifestKey);
          const allSignups = mMatch?.signups || [];
          const rep = draft.repName || 'Transport Rep';

          for (const sponId of draft.sponsoredIds) {
            let p = allSignups.find((s) => s.id === sponId);
            if (!p) {
              for (const otherM of manifestsTable) {
                p = (otherM.signups || []).find((s) => s.id === sponId);
                if (p) break;
              }
            }
            const cleanName = p ? p.fullName.trim() : sanitizePassengerDisplayName(sponId);
            if (!cleanName) continue;
            const baseDate = normalizeDateToYMD(parsedDate) || parsedDate.split('_')[0];
            const normName = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '');
            const lookupKey = `${baseDate}::${normName}`;
            if (existingKeys.has(lookupKey)) continue;

            const note = (draft.notes?.[sponId] || p?.sponsorNote || '').trim();
            const cleanKey = manifestKey.replace(/[^a-zA-Z0-9_-]/g, '_');
            const safeSlug = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '_');
            const id = `spon_${cleanKey}_${safeSlug}_${Date.now()}`;
            list.push({
              id,
              manifest_key: manifestKey,
              date: parsedDate,
              service: parsedService,
              passenger_id: sponId,
              passenger_name: cleanName,
              structure: normalizeStructureCode(p?.structure),
              stop: p?.stop || '',
              vehicle_name: 'Vehicle',
              rep_name: rep,
              sponsor_note: note,
              status: 'pending',
              submitted_at: new Date().toISOString(),
            });
            existingKeys.add(lookupKey);
            harvestedNew = true;
          }
        } catch {
          /* ignore parse errors */
        }
      }
    }

    if (harvestedNew) {
      list = cleanAndDeduplicateSponsorships(list, allKnownSignups);
      try {
        localStorage.setItem(LOCAL_SPONSORSHIPS_KEY, JSON.stringify(list));
      } catch {
        /* ignore storage full */
      }
    }
  } catch (err) {
    console.warn('[Ledger] Auto-harvest sponsorships error:', err);
  }

  // Final deduplication & name cleanup pass
  list = cleanAndDeduplicateSponsorships(list, allKnownSignups);

  // Sync back cleaned list to localStorage
  try {
    localStorage.setItem(LOCAL_SPONSORSHIPS_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }

  return list;
}

export async function verifySponsorshipStatus(
  sponsorshipId: string,
  status: SponsorshipStatus
): Promise<{ success: boolean; sponsorship?: ReportedSponsorship; ledgerUpdated?: boolean }> {
  try {
    const res = await verifySponsorshipOnServer(sponsorshipId, status);
    if (res.success) {
      // Sync local cache
      try {
        const raw = localStorage.getItem(LOCAL_SPONSORSHIPS_KEY);
        if (raw) {
          const list = JSON.parse(raw) as ReportedSponsorship[];
          const idx = list.findIndex((s) => s.id === sponsorshipId);
          if (idx >= 0) {
            list[idx].status = status;
            list[idx].status_updated_at = new Date().toISOString();
            localStorage.setItem(LOCAL_SPONSORSHIPS_KEY, JSON.stringify(list));
          }
        }
      } catch {
        /* ignore */
      }
      return res;
    }
  } catch (err) {
    console.warn('[Ledger] verifySponsorshipStatus server note:', err);
  }

  // Offline / local fallback
  try {
    const raw = localStorage.getItem(LOCAL_SPONSORSHIPS_KEY);
    if (raw) {
      const list = JSON.parse(raw) as ReportedSponsorship[];
      const idx = list.findIndex((s) => s.id === sponsorshipId);
      if (idx >= 0) {
        list[idx].status = status;
        list[idx].status_updated_at = new Date().toISOString();
        const item = list[idx];

        // If unpaid or unaccounted, add/ensure entry in LEDGER_TABLE
        if (status === 'unpaid_sponsorship' || status === 'unaccounted_sponsorship') {
          const cat = status === 'unpaid_sponsorship' ? 'Unpaid Sponsorship' : 'Unaccounted Sponsorship';
          const entryNote = item.sponsor_note ? `${cat}: ${item.sponsor_note}` : cat;
          const ledgerEntryId = item.ledger_entry_id || `spon_debt_${item.id}`;
          item.ledger_entry_id = ledgerEntryId;

          const row = {
            id: ledgerEntryId,
            manifest_key: item.manifest_key,
            date: item.date,
            service: item.service,
            passenger_name: item.passenger_name,
            stop: item.stop || '',
            structure: item.structure || '',
            vehicle_name: item.vehicle_name,
            submitted_by: item.rep_name,
            rep_name: item.rep_name,
            license_plate: '',
            sponsored: true,
            sponsor_note: entryNote,
            structure_debt: CANCELLATION_FEE,
            general_notes: entryNote,
            submitted_at: new Date().toISOString(),
          };

          await supabase.from(LEDGER_TABLE).upsert(row, { onConflict: 'id' });
        } else if (status === 'actually_sponsored' || status === 'pending') {
          // If marked actually sponsored or reverted to pending, remove debt row if any
          if (item.ledger_entry_id) {
            await supabase.from(LEDGER_TABLE).delete().eq('id', item.ledger_entry_id);
            item.ledger_entry_id = undefined;
          }
          await supabase.from(LEDGER_TABLE).delete().eq('id', `spon_debt_${item.id}`);
        }

        localStorage.setItem(LOCAL_SPONSORSHIPS_KEY, JSON.stringify(list));

        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('crc_sponsorships_updated', { detail: list }));
          window.dispatchEvent(new CustomEvent('crc_ledger_updated'));
        }

        return { success: true, sponsorship: list[idx], ledgerUpdated: true };
      }
    }
  } catch (err) {
    console.error('[Ledger] verifySponsorshipStatus error:', err);
  }

  return { success: false };
}
