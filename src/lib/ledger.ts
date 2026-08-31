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
  if (!str) return { structure: '', repName: '' };

  // FTV or FTV 20 structures e.g. "FTV 20", "FTV-20", "FTV 20 - Rep", "FTV"
  const ftvMatch = str.match(/^(FTV\s*20|FTV20|FTV)\s*[-–—:]?\s*(.*)$/i);
  if (ftvMatch) {
    return {
      structure: 'FTV 20',
      repName: ftvMatch[2].trim(),
    };
  }

  // E.g. "S1 - Nthabiseng, Nthabeleng", "S1 – Thuto", "S14 – Kgolaganyo/Nicole", "S1: Name"
  const m = str.match(/^(S\d+|YZ\d+|Unidentified|No Structure)\s*[-–—:]\s*(.*)$/i);
  if (m) {
    return {
      structure: m[1].trim().toUpperCase(),
      repName: m[2].trim(),
    };
  }

  // Exact code like "S1", "S15", "YZ1", "Unidentified"
  const justCode = str.match(/^(S\d+|YZ\d+|Unidentified|No Structure)$/i);
  if (justCode) {
    return {
      structure: justCode[1].trim().toUpperCase(),
      repName: '',
    };
  }

  // "Structure 1" or "Structure S1"
  const structWord = str.match(/^Structure\s*(S?\d+)\s*[-–—:]?\s*(.*)$/i);
  if (structWord) {
    const code = structWord[1].toUpperCase().startsWith('S') ? structWord[1].toUpperCase() : `S${structWord[1]}`;
    return {
      structure: code,
      repName: structWord[2].trim(),
    };
  }

  return {
    structure: str,
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
): { cleanName: string; serviceCode: string; isFTV: boolean; extraNotes: string } {
  let raw = (rawCell || '').trim().replace(/\r?\n/g, ' ');
  if (!raw) {
    const isFTV = !!explicitService && /\bFTV\b/i.test(explicitService);
    return {
      cleanName: '',
      serviceCode: explicitService ? extractServiceCode(explicitService) : 'PM',
      isFTV,
      extraNotes: '',
    };
  }

  const isFTV =
    /\bFTV\b/i.test(raw) ||
    /\bFTV\s*20\b/i.test(raw) ||
    /\bFTV20\b/i.test(raw) ||
    /\bR20\b/i.test(raw) ||
    (!!explicitService && /\bFTV\b/i.test(explicitService));

  let serviceCode = explicitService ? extractServiceCode(explicitService) : '';
  const extraNotes = '';

  // Look for service tags in parentheses like (PM), (AM), (LM), (WMP), (EF), (AD), (FW), (FTV), (PM/FTV)
  const serviceParenRegex = /\(\s*(AM|PM|LM|WMP|EF|AD|FW|W&P|W\/P|FTV|FTV\/PM|PM\/FTV|SERVING|USHERS|NORMAL)\s*[,)]*/gi;
  const matches = Array.from(raw.matchAll(serviceParenRegex));
  if (matches.length > 0) {
    const matchedCode = matches[0][1].toUpperCase();
    if (!serviceCode || serviceCode === 'Unspecified' || serviceCode === 'PM') {
      serviceCode = extractServiceCode(matchedCode);
    }
    raw = raw.replace(serviceParenRegex, ' ').trim();
  }

  // Complex patterns like "(PM- FTV R20)" or "(PM - R20)" or "(PM," or "(PM"
  const complexMatch = raw.match(/\(\s*(AM|PM|LM|WMP|EF|AD|FW)\s*[-–—,]?\s*([^)]*)\)?/i);
  if (complexMatch) {
    if (!serviceCode || serviceCode === 'Unspecified' || serviceCode === 'PM') {
      serviceCode = extractServiceCode(complexMatch[1]);
    }
    raw = raw.replace(complexMatch[0], ' ').trim();
  }

  // Clean trailing punctuation or empty parens
  raw = raw.replace(/\bFTV\s*20\b|\bFTV20\b|\bFTV\b/gi, '').trim();
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
    isFTV,
    extraNotes,
  };
}

/**
 * Robust search evaluator that provides accurate prefix, full-name, token,
 * structure, notes, and substring matching with intuitive priority scoring.
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
  const rep = (item.repName || item.rep_name || '').toLowerCase().trim();
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

  // 7. Multi-token match across all fields (name + structure + notes + dates + service)
  const combinedAll = `${fullName} ${structure} ${notes} ${dateStr} ${rep} ${service}`;
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

  const rows = absentees.map((p) => {
    const structUpper = (p.structure || '').toUpperCase();
    const noteUpper = (p.sponsorNote || '').toUpperCase();
    const genUpper = (generalNotes || '').toUpperCase();
    const isFTV =
      structUpper.includes('FTV') ||
      noteUpper.includes('FTV') ||
      genUpper.includes('FTV') ||
      p.memberType === 'FTV' ||
      /\bFTV\b/i.test(p.fullName);

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
      structure_debt: isFTV ? 20 : CANCELLATION_FEE,
      general_notes: generalNotes,
    };
  });

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
      // Normalize FTV entries so that if an entry is FTV / FTV 20, debt is strictly R20
      return (data as LedgerEntry[]).map((e) => {
        const isFTV =
          (e.structure || '').toUpperCase().includes('FTV') ||
          (e.general_notes || '').toUpperCase().includes('FTV') ||
          (e.sponsor_note || '').toUpperCase().includes('FTV') ||
          (e.service || '').toUpperCase().includes('FTV') ||
          (e.passenger_name || '').toUpperCase().includes('FTV') ||
          Number(e.structure_debt) === 20;

        if (isFTV) {
          const currentDebt = Number(e.structure_debt);
          // If debt was default 40 or unset, ensure it's R20
          const debt = (!currentDebt || currentDebt === 40) ? 20 : currentDebt;
          return {
            ...e,
            structure_debt: debt,
          };
        }
        return e;
      });
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
 * Inserts a manually created cancellation/debt entry into the cancellation ledger.
 */
export async function addManualLedgerEntry(input: ManualLedgerEntryInput): Promise<LedgerEntry> {
  const fullName = `${input.firstName.trim()} ${input.surname.trim()}`.trim();
  const manifestKey = `manual-${input.date}-${input.service.toLowerCase()}-${Date.now()}`;
  const structureCode = input.structure.trim().toUpperCase().startsWith('S') || input.structure.trim().toUpperCase().startsWith('YZ')
    ? input.structure.trim().toUpperCase()
    : input.structure.trim() ? `S${input.structure.trim()}` : 'No Structure';

  const isFTV = (input.notes || '').toUpperCase().includes('FTV') || input.service.toUpperCase().includes('FTV') || input.amount === 20;

  const row = {
    manifest_key: manifestKey,
    date: input.date,
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
    structure_debt: Number(input.amount) || (isFTV ? 20 : CANCELLATION_FEE),
    general_notes: input.notes || (isFTV ? 'FTV' : ''),
  };

  const { data, error } = await supabase
    .from(LEDGER_TABLE)
    .insert([row])
    .select('*')
    .single();

  if (error) throw error;
  return data as LedgerEntry;
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
      await updateLedgerEntry(entry.id, { structure_debt: newDebt });
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
 * a normalized "yyyy-mm-dd" string. Also heals OCR/typing errors like "23008/2026".
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
  const s = String(value).trim().replace(/\s+/g, '');
  // Heal typo like "23008/2026" or "2308/2026"
  const cleaned = s.replace(/^(\d{1,2})0+(\d{1,2})\/(\d{4})$/, '$1/$2/$3');

  let m = cleaned.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = cleaned.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = cleaned.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})$/);
  if (m) return `20${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

/**
 * Parses a bulk "Cancellation History" Excel/CSV export into rows ready for
 * importHistoricalCancellations.
 *
 * Supports:
 * - Table merged structure cells (forward fills structure and rep names across consecutive rows)
 * - Automatic extraction of service types (AM, PM, LM, WMP, EF, AD, FW, etc.)
 * - Automatic FTV rule: any entry with FTV owes R20 (First-Time Visitor half rate)
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
    const { cleanName, serviceCode, isFTV: nameIsFTV } = extractNameAndService(rawNameVal, rawServiceVal);

    // Rule: If it has FTV next to it, the person owes R20
    const isFTV =
      nameIsFTV ||
      /\bFTV\b/i.test(rawServiceVal) ||
      /\bFTV\b/i.test(rawNameVal) ||
      /\bFTV\b/i.test(rawCategoryVal) ||
      /\bFTV\b/i.test(rawNotesVal) ||
      rawNameVal.includes('R20') ||
      cleanName.includes('R20');

    // Debt parsing
    const debtRaw = debtCol !== -1 ? raw[debtCol] : undefined;
    let structureDebt = isFTV ? 20 : CANCELLATION_FEE;
    if (debtRaw != null && String(debtRaw).trim() !== '') {
      const debtStr = String(debtRaw).replace(/[^\d.]/g, '');
      const parsedDebt = Number(debtStr);
      if (Number.isFinite(parsedDebt) && parsedDebt > 0) {
        structureDebt = isFTV ? 20 : parsedDebt;
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
    if (isFTV && !noteParts.some((p) => p.includes('FTV'))) {
      noteParts.push('FTV (R20)');
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
  isFTV: boolean;
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
 * Shared aggregation used by both the web Ledger page and the download:
 * groups raw ledger entries by structure (strict alphanumeric order —
 * S1, S2, S9, S13), then by passenger name within each structure so repeat
 * cancellations collapse into one row with cumulative debt (e.g. R80 for Amo Nhlabathi).
 *
 * Accurately tracks each instance's service type (e.g. AM, PM, LM, WMP, EF, AD, FW)
 * so special church event cancellations are clearly displayed in brackets.
 *
 * Segregates entries into regular Cancellations vs Unaccounted Sponsorships & Unpaid.
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
      // Sort individual instances in chronological order ascending (Jan 1 first, Dec 31 last)
      const sorted = [...group].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      const earliest = sorted[0];
      const latest = sorted[sorted.length - 1];
      const amount = group.reduce((sum, e) => sum + Number(e.structure_debt), 0);

      // Collect distinct service codes
      const serviceCodesSet = new Set<string>();
      const instances: AggregatedLedgerInstance[] = sorted.map((e) => {
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
        const isFTV = (e.general_notes || '').includes('FTV') || Number(e.structure_debt) === 20;

        return {
          id: e.id,
          date: e.date,
          service: e.service,
          serviceCode: code,
          amount: Number(e.structure_debt) || CANCELLATION_FEE,
          formatted: `${dStr}(${code})`,
          isFTV,
          notes: e.general_notes || e.sponsor_note || '',
        };
      });

      const serviceCodes = Array.from(serviceCodesSet);
      const formattedServices = serviceCodes.length > 0 ? `(${serviceCodes.join(', ')})` : '';
      const formattedDateList = instances.map((ins) => ins.formatted).join(', ');

      const isSponsorshipOrUnpaid = group.some((e) => {
        const gn = (e.general_notes || '').toLowerCase();
        const sn = (e.sponsor_note || '').toLowerCase();
        return (
          e.sponsored ||
          gn.includes('unaccounted') ||
          gn.includes('unpaid') ||
          gn.includes('did not pay') ||
          gn.includes('sponsorship') ||
          sn.includes('unaccounted') ||
          sn.includes('unpaid') ||
          sn.includes('sponsorship')
        );
      });

      const combinedNotes = Array.from(
        new Set(group.map((e) => e.general_notes || e.sponsor_note).filter(Boolean))
      ).join('; ');

      return {
        key: `${structure}-${latest.passenger_name}`,
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
    }).sort((a, b) => {
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

  return groups.sort((a, b) => naturalCompare(a.structure, b.structure));
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
